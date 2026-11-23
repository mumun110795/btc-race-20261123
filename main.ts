// Breakout rider: a long-only trend bot for the cbBTC 24h race.
//
// Design (round numbers on purpose — tuned for the live race, not fitted to the dev window):
//   Entry  — the close breaks above the highest high of the prior 40 bars while the regime is
//            up: price above its 120-bar EMA and that EMA itself rising (its 60-bar slope at
//            least +5 bps). A breakout says a new leg may be starting; the regime filter keeps
//            counter-trend rallies in a falling market from triggering it.
//   Size   — 97% of cash on a signal. A full-size round trip costs roughly 30 bps in fees,
//            slippage and impact, so size is what turns a caught leg into real PnL; anything
//            much smaller just donates the spread. One position at a time.
//   Exit   — let winners run: sell only when the close falls 200 bps under the highest close
//            since entry (trailing stop) or 150 bps under the average entry price (hard stop).
//            No profit target: the rare multi-percent leg is where the money is.
//   Churn  — after an exit, sit out 15 bars before any new entry, so a sawtooth top cannot
//            bleed the account one round trip at a time.
//   Idle   — the bot must not sit in cash all race. If no buy has filled for 240 bars (4 hours),
//            the trigger loosens: a break of the prior 20 bars' high with price above the regime
//            EMA is enough, at half size. As a final backstop, if nothing has filled by scored
//            bar 1000 and price drifts up above the EMA, take one half-size position so the
//            entry always has a trade on the race window (the guardrail asks for at least one).
//            Every tier uses the same exits, so activity never means unmanaged risk.
//
// All decisions use only the bars seen so far: no clock, no randomness, no environment, so two
// runs on the same data produce the same orders byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const CHANNEL_BARS = 40; // breakout lookback, in bars
const EMA_BARS = 120; // regime EMA length
const SLOPE_BARS = 60; // EMA slope lookback
const SLOPE_MIN_BPS = 5; // regime EMA must have risen at least this over SLOPE_BARS
const TRAIL_BPS = 200; // trailing stop: close this far under the peak close since entry
const STOP_BPS = 150; // hard stop: close this far under the average entry price
const COOLDOWN_BARS = 15; // bars to sit out after an exit
const SIZE_BPS = 9700; // share of cash spent on a signal entry
const IDLE_BARS = 240; // bars without a buy fill before the looser trigger arms
const IDLE_CHANNEL_BARS = 20; // breakout lookback of the looser trigger
const IDLE_SIZE_BPS = 5000; // share of cash spent on a looser-trigger entry
const FALLBACK_BAR = 1000; // scored bar from which the backstop entry may fire
const FALLBACK_SIZE_BPS = 5000; // share of cash spent on the backstop entry
const MAX_SLIPPAGE_BPS = 300; // generous, so a real order is not rejected in a fast minute

// ---- strategy state (a pure function of the bars and fills seen so far) ----
const highs: number[] = []; // high of every bar before the current one, oldest first
const closes: number[] = []; // close of every bar before the current one, oldest first
const emaHistory: number[] = []; // regime EMA after each bar, oldest first
let ema: number | null = null;
let barsSeen = 0; // batches answered that carried a CBBTC bar
let pendingSide: 'buy' | 'sell' | null = null; // an order sent last batch, fill not yet seen
let entryPrice: number | null = null; // average fill price of the open position (price units)
let peakClose: number | null = null; // highest close since the position opened
let lastExitBar = -1_000_000; // barsSeen when the last sell filled
let lastBuyBar = 0; // barsSeen when the last buy filled (0 = the start of the run)
let everFilled = false; // any buy has filled in this run
let fallbackUsed = false;

function priceOf(state: BarsState, raw: string): number {
  const scale = state.symbols.get(SYMBOL)?.price_scale ?? 5;
  return Number(BigInt(raw)) / 10 ** scale;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1) Learn from the fills this batch carries (orders decided on the previous bar).
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = priceOf(state, fill.price);
        peakClose = null; // rebuilt from closes from here on
        everFilled = true;
        lastBuyBar = barsSeen;
      } else {
        entryPrice = null;
        peakClose = null;
        lastExitBar = barsSeen;
      }
    }
    if (batch.fills.length > 0) pendingSide = null;

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // a minute with no CBBTC bar: nothing to decide on

    const close = priceOf(state, bar.c);
    const high = priceOf(state, bar.h);
    barsSeen += 1;

    // 2) Update the regime EMA with this close (kept as history for its slope).
    ema = ema === null ? close : ema + (2 / (EMA_BARS + 1)) * (close - ema);
    emaHistory.push(ema);

    const orders: OrderInput[] = [];
    const position = state.positions.get(SYMBOL);
    const heldQty = position?.qty ?? 0n;

    if (!state.warmingUp && pendingSide === null) {
      if (heldQty > 0n) {
        // 3) Ride the position: track the peak close, exit on the trailing or hard stop.
        peakClose = peakClose === null ? close : Math.max(peakClose, close);
        const trailHit = close <= peakClose * (1 - TRAIL_BPS / 10_000);
        const stopHit = entryPrice !== null && close <= entryPrice * (1 - STOP_BPS / 10_000);
        if (trailHit || stopHit) {
          orders.push({ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          pendingSide = 'sell';
        }
      } else if (barsSeen - lastExitBar >= COOLDOWN_BARS) {
        // 4) Flat: look for a breakout inside a rising regime.
        const scoredBar = barsSeen - state.warmupBars;
        let sizeBps = 0;
        if (highs.length >= CHANNEL_BARS && emaHistory.length > SLOPE_BARS) {
          const channelHigh = Math.max(...highs.slice(-CHANNEL_BARS));
          const emaThen = emaHistory[emaHistory.length - 1 - SLOPE_BARS];
          const slopeBps = ((ema - emaThen) / emaThen) * 10_000;
          if (close > channelHigh && close > ema && slopeBps >= SLOPE_MIN_BPS) sizeBps = SIZE_BPS;
        }
        // 5) Idle trigger: no buy has filled for IDLE_BARS, so loosen the setup — a break of
        //    the shorter channel with price above the regime EMA, at half size.
        if (
          sizeBps === 0 && barsSeen - lastBuyBar >= IDLE_BARS &&
          highs.length >= IDLE_CHANNEL_BARS && close > ema &&
          close > Math.max(...highs.slice(-IDLE_CHANNEL_BARS))
        ) {
          sizeBps = IDLE_SIZE_BPS;
        }
        // 6) Backstop entry: late in the window with no fill yet, take a half-size position
        //    on mild upward drift so the entry always trades the race window.
        if (
          sizeBps === 0 && !everFilled && !fallbackUsed && scoredBar >= FALLBACK_BAR &&
          closes.length >= 30 && close > ema && close > closes[closes.length - 30]
        ) {
          sizeBps = FALLBACK_SIZE_BPS;
          fallbackUsed = true;
        }
        if (sizeBps > 0 && state.cash > 1_000_000n) {
          let notional = (state.cash * BigInt(sizeBps)) / 10_000n;
          const room = state.weightRoom(SYMBOL);
          if (notional > room) notional = room;
          if (notional >= 1_000_000n) {
            orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
            pendingSide = 'buy';
          }
        }
      }
    }

    // 7) Only now does this bar join the history the next decisions read.
    highs.push(high);
    closes.push(close);
    return orders;
  },
});
