// BTC race bot v2: a contrarian dip-buyer with a regime-dependent exit.
//
// make.fun bounty: btc-race-24h-20261115-0828
// Entry for account: Nano Rasa (@nano-rasa)
//
// v1 (submitted, dev grade +$24.71, 3 round trips) bought the same dips
// this bot buys, but sold every one of them the moment the tilt flipped
// negative — right at the start of the bounce. Its giant washout trade
// (bought $63,002, sold $63,478, +0.75%) left most of the bounce on the
// table: the price ran to ~$64,770 over the next four hours.
//
// v2 keeps v1's entries and adds one idea, verified on the dev window:
// track the MAXIMUM tilt reached while holding. A dip that keeps
// deepening after entry (max tilt >= +0.0025) is a genuine washout, and
// washouts take hours to play out — so those positions get a patient
// exit (take-profit +3%, trailing stop 1% once +1% up, or 240 bars),
// while ordinary dips keep v1's quick flip exit. On the dev window this
// changes exactly one trade (the washout) and lifts net PnL from $24.71
// to $45.84, with the same 6 trades and the same 1.8% max drawdown.
// The result is not sensitive to the exact deep threshold: 0.0022 and
// 0.0025 give the same $45.84, and TP 3% vs no-TP differ by $1.26.
//
// Signal: the forecast-v1 tilt (persistence anchor + small contrarian
// adjustment), computed on the cbBTC closes this bot has seen:
//
//   mu = -0.05 * ln(C_t / C_{t-60}) - 0.03 * ln(C_t / C_{t-240})
//   mu clamped to [-0.02, +0.02]
//
// Rules (all-in / all-out, long only, at most one position):
//   - BUY, with all cash, when flat and mu >= +0.0018 (+18 bps) and at
//     least 60 bars have passed since the last filled trade.
//   - HOLDING, track maxMu (the highest mu seen while holding) and the
//     highest close since entry (trail max, armed once +1% above entry).
//   - SELL everything on a hard stop: latest close 3% below the entry
//     fill price.
//   - DEEP mode (maxMu >= +0.0025): sell at +3% take-profit, or on a
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
/** Deep mode: take-profit above the entry fill price. */
const DEEP_TP_PCT = 0.03;
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

/** The v1 contrarian tilt from the closes up to index k. */
function tilt(k: number): number {
  let mu = 0;
  if (k >= 60) mu += W_1H * (Math.log(closes[k]) - Math.log(closes[k - 60]));
  if (k >= 240) mu += W_4H * (Math.log(closes[k]) - Math.log(closes[k - 240]));
  if (mu > MU_CLAMP) return MU_CLAMP;
  if (mu < -MU_CLAMP) return -MU_CLAMP;
  return mu;
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
      }
      if (fill.side === 'sell') {
        entryPrice = 0;
        entrySeq = -1_000_000_000;
        maxMuHeld = 0;
        trailMax = 0;
        trailArmed = false;
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
      if (mu >= BUY_MU && batch.seq - lastTradeSeq >= COOLDOWN_BARS) {
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
