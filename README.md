# Surge Sniper — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/epanpai/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/epanpai/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program at `main.ts` (Node 22), replayed by the house on 6 hours of pump.fun bonding-curve data; highest net PnL wins. Paper trading only — no real money, no entry fee.

## Strategy

- **Entry:** a curve past the bundled-launch dump (age ≥ 400 slots) with accelerating buy pressure over a 30-slot window: net SOL inflow, ≥ 3 buys from ≥ 4 distinct wallets, price up 4–120% and near its window high, newer-half inflow stronger than the older half.
- **Sizing:** first buy small (0.05 SOL), pyramid in 0.15 SOL steps while the price steps up and inflow continues, up to 1 SOL per position.
- **Exits:** stop-loss −20% vs cost; take-profit ladder selling half the tokens at +50%; trailing stop −20% from the peak once armed at +15%; fade exit on negative recent flow; big-sell exit; 1500-slot time limit (waived while up 25%+).
- **Guardrail probes:** tiny 0.015 SOL round trips keep the run above the minimum bar (a ≥ 0.01 SOL round trip on ≥ 20 coins) when fills or coins lag the pace.
- **Deterministic:** no clock, no randomness, no environment reads — the two grading runs agree byte for byte.

## Layout

- `main.ts` — entrypoint: hands the strategy to the wire shim.
- `strategy.ts` — the strategy (written from scratch for this bounty).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte.

## Local grade

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
