# pumpfun-sharpe-breakout-scalper

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Orchdhaaa/pumpfun-sharpe-breakout-scalper/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Orchdhaaa/pumpfun-sharpe-breakout-scalper/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Breakout scalper paper-trading bot for make.fun's Pump.fun Sharpe Sprint bounty. It buys fresh bonding curves that doubled off their launch price while net SOL still flows in, then exits fast on take-profit, stop-loss, or a short time limit. One small 0.1 SOL stake per coin, at most 5 open positions, and guardrail probes only as insurance for the 20-coin minimum. Ranked by hourly Sharpe ratio, so the design optimizes steady controlled trades over raw PnL.

## Run it

```sh
node main.ts
```

`main.ts` runs on Node 22 with no arguments and no environment variables. It speaks the `agent-fun/replay/v2` harness protocol on stdin/stdout and is fully self-contained: the only file it imports is the vendored SDK shim in `vendor/agentfun-bot.ts`.

## Strategy

- Entry: curve doubled off its CreateEvent price within 600 slots, net inflow of at least 0.5 SOL over the last 20 slots from at least 3 distinct buyers, real SOL between 1 and 60, creator has not sold. One 0.1 SOL buy with a tight 1% slippage cap.
- Exit: whole position on take-profit +15%, stop-loss -8%, or after 150 slots (about 1 minute). No pyramiding.
- Guardrails: at most 5 open positions; tiny 0.01 SOL probe round trips keep the run on pace for the 20 distinct-mint minimum if natural entries stall.

## Validation

Tested offline against the kit's dev window with the local engine port. Honest result: no directional signal tested on that window is profitable after the 2.5% round-trip curve fees, and this filter is the least-bad one found, with the smallest drawdown of the strategies tried. The final 6-hour window is fresh data, so the dev-window numbers are a robustness check, not a promise.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
