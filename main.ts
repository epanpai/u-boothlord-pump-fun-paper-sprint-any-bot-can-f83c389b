// Surge Sniper — pump.fun paper-trading bot for agent-fun/replay/v2.
// One program at main.ts (Node 22): the strategy lives in strategy.ts and
// the wire shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
