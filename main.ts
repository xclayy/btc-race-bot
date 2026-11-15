// BTC race bot: a contrarian dip-buyer on cbBTC 1-minute bars.
//
// make.fun bounty: btc-race-24h-20261115-0828
// Entry for account: Nano Rasa (@nano-rasa)
//
// Signal: the forecast-v1 tilt from the btc-cent-forecast-01 entry
// (persistence anchor + small contrarian adjustment), computed on the
// cbBTC closes this bot has seen:
//
//   mu = -0.05 * ln(C_t / C_{t-60}) - 0.03 * ln(C_t / C_{t-240})
//   mu clamped to [-0.02, +0.02]
//
// where C_t is the latest close and the returns are the 1-hour and
// 4-hour log-returns. The weights are the forecast entry's, chosen on
// 247 four-hour cases of Coinbase BTC-USD closes (MAE 40,779 cents vs
// persistence 41,220, -1.07%); they are NOT re-tuned here.
//
// Rules (all-in / all-out, long only, at most one position):
//   - BUY, with all cash, when flat and mu >= +0.0018 (+18 bps) and at
//     least 60 bars have passed since the last filled trade. A mu that
//     high means the last 1-4 hours fell hard, so the tilt says the
//     next hours bounce: on the dev window a mu above +15 bps preceded
//     a +210 bps mean 4-hour forward return (95% of bars positive),
//     against a ~45 bps round-trip cost at this pool's depth.
//   - SELL everything when holding and mu < 0 (the bounce has played
//     out and the tilt has flipped), or when the latest close is 3%
//     below the entry fill price (a hard stop for the one failure mode
//     the tilt cannot see: a dip that keeps dipping while the signal
//     stays pinned positive).
//   - Every order caps slippage at 100 bps past the close it was
//     decided on, so a fill into a gap is refused and retried rather
//     than taken for almost nothing.
//
// Local grade on the published dev window (grade-local, process
// driver): net PnL +31.50 USDC, 6 trades (3 round trips), max
// drawdown 1.8%, 0 rejected. Every baseline bot loses money on that
// window (buy-and-hold -44.01, momentum -40.92, ema-cross -134.95),
// which fell 4.00% overall; this bot makes money by sitting in cash
// through the decline and buying only the sharp dips.
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
    // price (for the hard stop), any fill restarts the cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      lastTradeSeq = batch.seq;
      if (fill.side === 'buy') entryPrice = Number(fill.price);
      if (fill.side === 'sell') entryPrice = 0;
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

    // Holding: exit when the tilt flips negative, or on the hard stop.
    const stopped = entryPrice > 0 && close <= entryPrice * (1 - STOP_PCT);
    if (mu < 0 || stopped) {
      const sell: SellInput = {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [sell];
    }
    return [];
  },
});
