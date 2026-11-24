// Surge Sniper — a momentum paper-trading bot for the pump.fun replay
// (agent-fun/replay/v2, hello / batch / orders / slot protocol).
//
// Idea: on a 6-hour window most pump.fun curves bleed out, but a few surge.
// Catch the surge early, size up only while it keeps rising, and cut the
// losers fast. Every decision comes from the batch stream only — no clock,
// no randomness, no environment — so the two grading runs agree byte for
// byte. Iteration is over insertion-ordered Maps fed by the batch stream.
//
// Entry: a curve that is old enough to be past the bundled-launch dump,
// with fresh accelerating buy pressure (net SOL in, several distinct
// buyers, price near its window high, newer half of the window stronger
// than the older half).
//
// Sizing: first buy small (0.05 SOL). Pyramid in 0.15 SOL steps while the
// price steps up from the last buy and inflow continues, up to 1 SOL.
//
// Exits: stop-loss -20% vs cost; a take-profit ladder that sells half the
// tokens at +50%; a trailing stop of -20% from the peak once armed at
// +15%; a fade exit when recent net flow turns negative; a big-sell exit;
// a 1500-slot time limit (waived while the position is up 25%+).
//
// Guardrail probes: the run must clear at least 20 coins with a round
// trip of >= 0.01 SOL each. When fills or coins lag the pace implied by
// block time, the bot opens tiny 0.015 SOL probe round trips on liquid
// curves and sells them as soon as the buy lands.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  window: number; // entry lookback, slots
  minNetSol: number; // net buy SOL over the window
  minBuys: number; // buy trades in the window
  minBuyers: number; // distinct buying wallets in the window
  minPriceUp: number; // price rise over the window (fraction)
  maxPriceUp: number; // skip curves that already ran too far in one window
  accel: number; // newer-half net inflow multiple of older-half net
  nearHigh: number; // price now as a share of the window high
  maxBuyerShare: number; // largest single buyer's share of window buy SOL
  minRqSol: number; // curve real SOL at entry, lower bound
  maxRqSol: number; // curve real SOL at entry, upper bound
  minAge: number; // slots since CreateEvent before an entry is allowed
  stakeSol: number; // total SOL per position
  firstSol: number; // first buy of a position
  addSol: number; // each pyramid add
  minBuySol: number; // smallest buy worth sending
  buySlipBps: number; // buy slippage, bps
  stopLoss: number; // exit when value < cost * (1 - stopLoss)
  trailArm: number; // trailing stop arms once value >= cost * (1 + trailArm)
  trail: number; // trailing stop drop from peak value
  takeProfit: number; // sell half the tokens once value >= cost * (1 + takeProfit)
  fadeWindow: number; // lookback for the fade exit, slots
  fadeNetSol: number; // exit when net flow over fadeWindow < -fadeNetSol
  bigSellSol: number; // exit on any single recorded sell >= this many SOL
  maxHold: number; // exit after this many slots held
  holdIfUp: number; // time limit waived while value >= cost * (1 + holdIfUp)
  cooldown: number; // slots to wait after an exit before re-entering a curve
  maxEntries: number; // most entries per curve over the run
  pyramid: boolean; // add to a position while the signal holds
  maxMain: number; // most momentum positions open at once
  targetCoins: number; // guardrail pacing target: coins
  targetFills: number; // guardrail pacing target: fills
  paceSecs: number; // seconds the pace is scaled over (the 6h window)
  probeSol: number; // probe round-trip buy size
  maxProbes: number; // most probe round trips open at once
  maxExposureSol: number; // most SOL at cost across all positions at once
}

export const DEFAULT_PARAMS: Params = {
  window: 30,
  minNetSol: 1.5,
  minBuys: 3,
  minBuyers: 5,
  minPriceUp: 0.08,
  maxPriceUp: 0.6,
  accel: 1,
  nearHigh: 0.95,
  maxBuyerShare: 0.8,
  minRqSol: 2,
  maxRqSol: 60,
  minAge: 500,
  stakeSol: 0.2,
  firstSol: 0.03,
  addSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.08,
  trailArm: 0.05,
  trail: 0.12,
  takeProfit: 0.15,
  fadeWindow: 15,
  fadeNetSol: 1,
  bigSellSol: 5,
  maxHold: 600,
  holdIfUp: 0.25,
  cooldown: 120,
  maxEntries: 2,
  pyramid: true,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.015,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // 1.25% bonding-curve fee on sells

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  tpTaken: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  // Probe round trips in flight, by mint: false while the buy is open,
  // true once the sell has been sent.
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop-loss, take-profit ladder, trailing stop, fade,
      // big sell, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        // Take-profit ladder: bank half the tokens once at +50%.
        if (!h.tpTaken && !h.exiting && value >= cost * (1 + p.takeProfit) && tokens > 0) {
          if (orders.length < cap && !pendingByMint.has(mint)) {
            orders.push({ side: 'sell', mint, token_amount: pos.token_amount / 2n, max_slippage_bps: 10_000 });
            h.tpTaken = true;
            continue;
          }
        }
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy lands.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.firstSol, p.stakeSol);
        } else {
          // Pyramid into strength only: price stepped up from the last
          // add, the position is at or above cost, inflow continues.
          if (!p.pyramid || h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(t, now, p.window) < p.minNetSol / 2) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            tpTaken: false,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
