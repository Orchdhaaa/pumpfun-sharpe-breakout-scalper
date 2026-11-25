// Breakout Scalper for the Pump.fun Sharpe Sprint (agent-fun/replay/v2).
//
// The ranking is hourly Sharpe ratio, not raw PnL, so this bot is built for steady,
// small, controlled trades: one small stake per coin, fast exits, tight risk caps,
// and guardrail probes only as insurance. It never holds more than 5 positions and
// never risks more than about 0.5 SOL of the 10 SOL capital at once.
//
// Entry: a fresh bonding curve that doubled off its launch price within 600 slots
// (10 minutes) while net SOL still flows in over the last 20 slots from at least
// 3 distinct buyers, with real SOL between 1 and 60, and whose creator has not
// sold. The entry is one 0.1 SOL buy with a tight 1% slippage cap, which also
// filters out the most violent fills (a buy is refused when the price moved more
// than 1% in the 2-slot latency).
//
// Exit: the whole position sells on the first of take-profit +15%, stop-loss -8%,
// or a 150-slot (about 1 minute) time limit. No pyramiding: every position is one
// buy, so a false start costs at most one small stake.
//
// Why this shape: on the kit's dev window every broad momentum, dip-buying,
// mean-reversion, sniper and spray-and-hold signal loses money after the 2.5%
// round-trip curve fees, and the per-trade timing edge of intra-slot momentum is
// not available to a bot that only sees completed batches. The fresh-breakout
// filter is the least-bad signal found (best dev-window hourly Sharpe among the
// strategies tested, smallest drawdown), so the bot trades it small, exits fast,
// and lets the guardrail probes guarantee the 20-coin minimum in a quiet window
// instead of chasing. The final 6-hour window is fresh data, so no dev-window
// number here is a promise: this is the most defensive shape the research
// supports, not a claim of profit.
//
// Deterministic by construction: no clock, no randomness, no network, no I/O
// beyond the harness protocol; iteration only over insertion-ordered maps fed by
// the batch stream, so the grader's two executions produce byte-identical logs.

import { runBot } from './vendor/agentfun-bot.ts';
import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Price now over the CreateEvent price, minus 1, at least this to enter. */
  minRunup: number;
  /** Price now vs last trade at/before (now - flowWindow) must be up at least this (0 = off). */
  minWindowUp: number;
  /** Slots since the CreateEvent after which an entry is no longer allowed. */
  maxAge: number;
  /** Entry window in slots for net-flow and window-rise checks. */
  flowWindow: number;
  /** Net buy SOL (buys minus sells) over the entry window, at least this. */
  minFlowSol: number;
  /** Distinct-buyer lookback in slots. */
  buyerWindow: number;
  /** Distinct buying wallets over the buyer window, at least this. */
  minBuyers: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL to put into one position (one buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Sell the whole position when its value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell the whole position when its value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm); 0 = off. */
  trailArm: number;
  /** Trailing stop: sell when value falls this far below its peak. */
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Skip a curve whose creator has sold. */
  skipDevSold: boolean;
  /** Runup measured vs 'create' (CreateEvent price) or 'firstTrade'. */
  runupBase: 'create' | 'firstTrade';
  /** Most main positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /**
   * Guardrail pacing: the run must end with at least 20 round trips of at least
   * 0.01 SOL on at least 20 distinct mints. When the bot's own fills or coins lag
   * targetFills / targetCoins scaled by the share of paceSecs elapsed (block time
   * since the first batch), it opens tiny probe round trips (buy probeSol, sell it
   * as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings chosen on the dev window with the local engine port, preferring the
// flattest region of the grid over its single best cell: take-profit 15%,
// stop-loss 8%, 1% buy slippage, 0.1 SOL stakes, 150-slot holds. The trailing
// stop is off: it never improved a sweep cell, because take-profit at +15%
// exits a position before any trailing arm above it could matter. The probe
// targets are the guardrail minimum plus a small margin (20 coins / 40 fills),
// not a fills target: each probe round trip loses about 4.6% of its 0.01 SOL,
// so probes exist only to guarantee the 20-coin minimum in a quiet window,
// never to pad the fill count.
export const DEFAULT_PARAMS: Params = {
  minRunup: 1.0,
  minWindowUp: 0,
  maxAge: 600,
  flowWindow: 20,
  minFlowSol: 0.5,
  buyerWindow: 120,
  minBuyers: 3,
  minRqSol: 1,
  maxRqSol: 60,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 100,
  takeProfit: 0.15,
  stopLoss: 0.08,
  trailArm: 0,
  trail: 0.15,
  maxHold: 150,
  cooldown: 300,
  maxEntries: 2,
  skipDevSold: true,
  runupBase: 'create',
  maxMain: 5,
  targetCoins: 22,
  targetFills: 48,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number;
  createPrice: number;
  firstPrice: number;
  creator: string;
  devSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.flowWindow, p.buyerWindow, p.maxAge) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: -1, createPrice: -1, firstPrice: -1, creator: '', devSold: false, trades: [], entries: 0, lastExit: -1e12 };
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

  /** Distinct buying wallets over the last `w` slots. */
  const buyers = (t: Tape, now: number, w: number): number => {
    const s = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      if (tr.buy) s.add(tr.user);
    }
    return s.size;
  };

  /** Last trade price at or before slot `now - w` (the window's start price). */
  const windowStartPrice = (t: Tape, now: number, w: number): number => {
    let p = -1;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) return tr.price;
      p = tr.price;
    }
    return p;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (t.firstPrice < 0) t.firstPrice = px;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: px });
          traded.add(e.mint);
          if (!e.is_buy && e.user === t.creator) t.devSold = true;
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
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
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
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.trailArm > 0 && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.skipDevSold && t.devSold) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          // A sell already in flight: wait for it. A buy in flight: sell what we hold now anyway.
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
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

      // Entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.created < 0 || t.createPrice <= 0) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const age = now - t.created;
        if (age > p.maxAge) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const base = p.runupBase === 'firstTrade' ? t.firstPrice : t.createPrice;
        if (base <= 0) continue;
        const runup = price / base - 1;
        if (runup < p.minRunup) continue;
        if (p.minWindowUp > 0) {
          const wsp = windowStartPrice(t, now, p.flowWindow);
          if (wsp <= 0 || price / wsp - 1 < p.minWindowUp) continue;
        }
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (flow(t, now, p.flowWindow) < p.minFlowSol) continue;
        if (buyers(t, now, p.buyerWindow) < p.minBuyers) continue;
        if (p.skipDevSold && t.devSold) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
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

await runBot(createStrategy(DEFAULT_PARAMS));
