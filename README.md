# Breakout Rider — a cbBTC trend bot for the 24h race

[![make.fun bounty](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/mumun110795/btc-race-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/mumun110795/btc-race-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

A long-only, one-position trend bot that trades Coinbase Wrapped BTC (cbBTC) minute by
minute against USDC with $1,000 of paper money, over the `agent-fun/bars-replay/v1`
protocol. `main.ts` holds the whole strategy; `vendor/makefun-bars.ts` is the kit's SDK
shim, copied byte for byte.

Bounty: https://make.fun/bounty/btc-race-24h-20261123-0511

## The strategy

Parameters are round numbers, chosen for the live 24 hours rather than fitted to the dev
window: the dev grade only has to clear its gate (net PnL above $0 after fees), and a bot
tuned to one recorded day is a bot fitted to a day that will not repeat.

- **Entry (main trigger).** The close breaks above the highest high of the prior 40 bars
  while the regime is up: price above its 120-bar EMA, and that EMA itself rising (its
  60-bar slope at least +5 bps). A breakout says a new leg may be starting; the regime
  filter keeps counter-trend rallies inside a falling market from triggering it.
- **Size.** 97% of cash on a main signal. A full-size round trip costs roughly 30 bps in
  fees, slippage and price impact, so position size is what turns a caught leg into real
  PnL; one position at a time.
- **Exit.** Let winners run: sell only when the close falls 200 bps under the highest
  close since entry (trailing stop) or 150 bps under the average entry price (hard stop).
  No profit target — the rare multi-percent leg is where the money is.
- **Anti-churn.** After an exit the bot sits out 15 bars before any new entry, so a
  sawtooth top cannot bleed the account one round trip at a time.
- **Anti-idle.** The bot must not sit in cash all race. If no buy has filled for 240 bars
  (4 hours), the trigger loosens: a break of the prior 20 bars' high with price above the
  regime EMA is enough, at half size. As a final backstop, if nothing has filled by scored
  bar 1000 and price drifts up above the EMA, it takes one half-size position, so the
  entry always has a trade on the race window. Every tier uses the same exits, so
  activity never means unmanaged risk.

Behaviour measured on the dev window and on synthetic regimes built from it: on the dev
window the main trigger fires once and rides the day's leg; in a mirrored (falling)
version of the window the bot takes only small half-size trades and loses about 1% with
drawdown near 1.4%; in a detrended (choppy) version it trades about 2–3 round trips with
drawdown near 3%. Maximum drawdown stays far under the race's 25% guardrail in every
scenario, and the trailing stop is what converts a strong live trend into a big day
instead of a series of small ones.

## Running it

The grader runs `node main.ts` and speaks the bars protocol on stdin/stdout. Locally,
the kit's own grader reproduces the official dev grade:

```
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```

The bot reads no clock, no files, no environment and no randomness: two runs on the same
bars produce the same orders byte for byte.

---
Built for [make.fun](https://make.fun/bounty/btc-race-24h-20261123-0511) · referral: https://make.fun/r/vdsf53gd
