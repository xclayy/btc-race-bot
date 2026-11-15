// BTC race bot v3: gated-wait entry + patient deep exit.
//
// make.fun bounty: btc-race-24h-20261115-0828
// Entry for account: Nano Rasa (@nano-rasa)
//
// v2 (dev grade +$45.84, 3 round trips) bought every dip the moment the
// tilt crossed +0.0018 — including the giant washout, where it bought at
// $63,002, a full $920 above the low, and left most of the bounce on the
// table. v3 keeps v2's entries for ordinary dips but waits out a dip
// that is still deepening fast: when the tilt crosses +0.0018 while the
// 1-hour return is already below -2.1%, the dip is a washout in progress,
// so the bot waits for the tilt to reach +0.0025 (buying near the low,
// $62,329 on the dev window) instead of catching the falling knife.
// The wait has a fallback: after 40 bars it buys anyway if the tilt is
// still >= +0.0015, and it is cancelled at once if the tilt fades below
// +0.0015 (the dip was shallow after all).
//
// The deep exit is also more patient than v2's: a washout position gets
// take-profit +5% (v2: +3%), a 1% trailing stop once +1% up, or 240 bars.
// On the dev window the washout trade becomes buy $62,329 -> sell
// $65,339 (+$49.11 instead of v2's +$27.59) and net PnL rises from
// $45.84 to $66.15, with the same 6 trades and a lower max drawdown
// (1.4% vs 1.8%). The gate sits in the middle of a 40 bps plateau
// (-1.9% .. -2.3% all give the same $66.15), so it is not a knife-edge
// threshold; if no washout ever comes, v3 behaves exactly like v2.
//
// Signal: the forecast-v1 tilt (persistence anchor + small contrarian
// adjustment), computed on the cbBTC closes this bot has seen:
//
//   mu = -0.05 * ln(C_t / C_{t-60}) - 0.03 * ln(C_t / C_{t-240})
//   mu clamped to [-0.02, +0.02]
//   r60 = ln(C_t / C_{t-60})
//
// Rules (all-in / all-out, long only, at most one position):
//   - FLAT, tilt mu >= +0.0018 (+18 bps) and >= 60 bars since the last
//     filled trade:
//       - if r60 <= -0.021 (-2.1%): WAIT for mu >= +0.0025 (washout
//         entry), or buy after 40 bars if mu >= +0.0015, or cancel the
//         wait at once if mu < +0.0015.
//       - otherwise: BUY with all cash immediately.
//   - HOLDING, track maxMu (highest tilt while holding) and the highest
//     close since entry (trail max, armed once +1% above entry).
//   - SELL everything on a hard stop: latest close 3% below the entry
//     fill price.
//   - DEEP mode (maxMu >= +0.0025): sell at +5% take-profit, or on a
//     1% trailing stop once armed, or after 240 bars held.
//   - NORMAL mode (maxMu < +0.0025): sell when mu < 0 (v1's flip exit).
//   - Every order caps slippage at 100 bps past the close it was
//     decided on, so a fill into a gap is refused and retried rather
//     than taken for almost nothing.
//
// The bot is a pure function of the bars it has been sent: no clock,
// no randomness, no environment, no files. The same bars give the
// same orders, run after run.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Buy when the tilt reaches +0.0018 (+18 bps). */
const BUY_MU = 0.0018;
/** Bars to wait after a filled trade before the next entry. */
const COOLDOWN_BARS = 60;
/** Hard stop: 3% below the entry fill price. */
const STOP_PCT = 0.03;
/** Deep mode: the max tilt while holding that marks a washout. */
const DEEP_MU = 0.0025;
/** Gate: wait out the dip when the 1h return is at or below this. */
const WAIT_R60 = -0.021;
/** Washout entry: the tilt that ends the wait. */
const WAIT_MU = 0.0025;
/** Washout entry: fallback buy after this many bars of waiting. */
const WAIT_MAX_BARS = 40;
/** Washout entry: cancel the wait at once below this tilt. */
const WAIT_CANCEL_MU = 0.0015;
/** Washout entry: fallback buy needs at least this tilt. */
const WAIT_FALLBACK_MU = 0.0015;
/** Deep mode: take-profit above the entry fill price. */
const DEEP_TP_PCT = 0.05;
/** Deep mode: trailing stop below the highest close since entry. */
const DEEP_TRAIL_PCT = 0.01;
/** Deep mode: arm the trail once this far above the entry price. */
const TRAIL_ARM_PCT = 0.01;
/** Deep mode: maximum bars to hold. */
const DEEP_HOLD_BARS = 240;
/** Slippage cap on every order, in bps past the deciding close. */
const MAX_SLIPPAGE_BPS = 100;

/** The v1 tilt weights (forecast entry's, unretouched). */
const W_1H = -0.05;
const W_4H = -0.03;
const MU_CLAMP = 0.02;

/** Closes seen so far, oldest first, as raw price integers (scale 5). */
const closes: number[] = [];
/** Fill price of the open position (raw price integer), 0 when flat. */
let entryPrice = 0;
/** Seq of the batch that reported the last filled trade. */
let lastTradeSeq = -1_000_000_000;
/** Seq of the batch that reported the entry fill of the open position. */
let entrySeq = -1_000_000_000;
/** Highest tilt seen while holding the open position. */
let maxMuHeld = 0;
/** Highest close seen since the entry fill. */
let trailMax = 0;
/** Whether the trailing stop is armed (+1% above entry). */
let trailArmed = false;
/** Seq of the batch where the current washout wait started, -1 = none. */
let waitStartSeq = -1;

/** The v1 contrarian tilt from the closes up to index k. */
function tilt(k: number): number {
  let mu = 0;
  if (k >= 60) mu += W_1H * (Math.log(closes[k]) - Math.log(closes[k - 60]));
  if (k >= 240) mu += W_4H * (Math.log(closes[k]) - Math.log(closes[k - 240]));
  if (mu > MU_CLAMP) return MU_CLAMP;
  if (mu < -MU_CLAMP) return -MU_CLAMP;
  return mu;
}

/** The 1-hour log return from the closes up to index k. */
function r60(k: number): number {
  if (k < 60) return 0;
  return Math.log(closes[k]) - Math.log(closes[k - 60]);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Fold this batch's fills in first: a buy fill sets the entry
    // price (for the hard stop and the trail), any fill restarts the
    // cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      lastTradeSeq = batch.seq;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entrySeq = batch.seq;
        maxMuHeld = 0;
        trailMax = 0;
        trailArmed = false;
        waitStartSeq = -1;
      }
      if (fill.side === 'sell') {
        entryPrice = 0;
        entrySeq = -1_000_000_000;
        maxMuHeld = 0;
        trailMax = 0;
        trailArmed = false;
        waitStartSeq = -1;
      }
    }
    // One bar per batch for this symbol; a gap minute carries none.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    if (state.warmingUp) return [];

    const k = closes.length - 1;
    const mu = tilt(k);
    const held = state.positions.get(SYMBOL);
    const close = closes[k];

    if (held === undefined) {
      if (batch.seq - lastTradeSeq < COOLDOWN_BARS) return [];
      // A washout wait is pending: end it on the deep tilt, on the
      // fallback after WAIT_MAX_BARS, or cancel it at once if the
      // tilt faded (the dip was shallow after all).
      if (waitStartSeq >= 0) {
        if (mu >= WAIT_MU) {
          waitStartSeq = -1;
          const cash = state.cash;
          if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
          const buy: BuyInput = {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          };
          return [buy];
        }
        if (mu < WAIT_CANCEL_MU) {
          waitStartSeq = -1;
          return [];
        }
        if (batch.seq - waitStartSeq >= WAIT_MAX_BARS) {
          waitStartSeq = -1;
          if (mu >= WAIT_FALLBACK_MU) {
            const cash = state.cash;
            if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
            const buy: BuyInput = {
              side: 'buy',
              symbol: SYMBOL,
              notional_quote_units: cash,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            };
            return [buy];
          }
          return [];
        }
        return [];
      }
      if (mu >= BUY_MU) {
        // Dip still deepening fast: wait it out instead of catching
        // the falling knife.
        if (r60(k) <= WAIT_R60) {
          waitStartSeq = batch.seq;
          return [];
        }
        const cash = state.cash;
        if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        const buy: BuyInput = {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [buy];
      }
      return [];
    }

    // Holding: track the highest tilt and the highest close since entry.
    if (mu > maxMuHeld) maxMuHeld = mu;
    if (close > trailMax) trailMax = close;
    if (entryPrice > 0 && close >= entryPrice * (1 + TRAIL_ARM_PCT)) trailArmed = true;

    // Hard stop, always on.
    if (entryPrice > 0 && close <= entryPrice * (1 - STOP_PCT)) {
      const sell: SellInput = {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [sell];
    }

    if (maxMuHeld >= DEEP_MU) {
      // Deep mode: the washout gets a patient exit.
      const tp = entryPrice > 0 && close >= entryPrice * (1 + DEEP_TP_PCT);
      const trailed = trailArmed && trailMax > 0 && close <= trailMax * (1 - DEEP_TRAIL_PCT);
      const heldTooLong = batch.seq - entrySeq >= DEEP_HOLD_BARS;
      if (tp || trailed || heldTooLong) {
        const sell: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [sell];
      }
    } else {
      // Normal mode: v1's flip exit — sell when the tilt turns negative.
      if (mu < 0) {
        const sell: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [sell];
      }
    }
    return [];
  },
});
