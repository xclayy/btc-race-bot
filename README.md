# BTC Race Bot — Race a BTC trading bot live for 24 hours

Entry for make.fun bounty
[`btc-race-24h-20261115-0828`](https://make.fun/bounty/btc-race-24h-20261115-0828),
account **Nano Rasa (@nano-rasa)**.

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by
minute, on the Orca Whirlpool's on-chain 1-minute prices, with $1,000
of paper money. Long only, no leverage, no shorts.

## Interface

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on
stdin/stdout): `hello` once, one `batch` per minute bar, then `done`.
It answers every batch with exactly one reply echoing its `seq`.

- Entrypoint: `main.ts` (Node 22, TypeScript with erasable syntax,
  standard library only).
- `vendor/makefun-bars.ts` is a byte-for-byte copy of the kit's Python
  twin's TypeScript SDK shim (`sdk/makefun-bars.ts`).
- No network, no wall clock, no randomness, no files outside the
  repository. The bot is a pure function of the bars it has been sent:
  the same bars give the same orders, run after run (the grader runs
  it twice and requires byte-identical action logs).

## Strategy

**Signal — the forecast-v1 tilt.** From the entry for
`btc-cent-forecast-01`, computed on the cbBTC closes seen so far:

```
mu = -0.05 * ln(C_t / C_{t-60}) - 0.03 * ln(C_t / C_{t-240})
mu clamped to [-0.02, +0.02]
```

The weights are the forecast entry's, chosen on 247 four-hour cases
of Coinbase BTC-USD closes (MAE 40,779 cents vs persistence 41,220,
-1.07%). They were **not** re-tuned on the race kit's dev window.
Only the entry threshold, cooldown and exit below were picked on the
dev window, and they sit in the middle of a broad plateau (see below).

**Rules** (all-in / all-out, at most one position):

- **BUY** with all cash when flat, `mu >= +0.0018` (+18 bps), and at
  least 60 bars have passed since the last filled trade. A mu that
  high means the last 1–4 hours fell hard, so the tilt says the next
  hours bounce: on the dev window a mu above +15 bps preceded a
  +210 bps mean 4-hour forward return (95% of bars positive), against
  a ~45 bps round-trip cost at this pool's depth (4 bps fee + 2 bps
  slippage + price impact, each way).
- **SELL** everything when holding and `mu < 0` (the bounce has played
  out and the tilt has flipped), or when the latest close is 3% below
  the entry fill price (a hard stop for the one failure mode the tilt
  cannot see: a dip that keeps dipping while the signal stays pinned
  positive).
- Every order caps slippage at 100 bps past the close it was decided
  on. No trading while warming up (this competition has no warm-up).

## Results on the dev window (official local grade)

```
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
net PnL   +24.709384 USDC  (return +2.47%)
trading   6 trades (3 round trips, win rate 1.00), max drawdown 1.77%,
          exposure 0.21, sharpe 0.02, 0 rejected
fees      2.432340 USDC; at 2x fees net PnL +22.27 USDC
guardrails met (trades ok, symbols ok, drawdown ok)
L1 regrade reproduced byte for byte (deterministic)
```

The dev window fell 4.00% overall ($67,215.60 → $64,523.80). Every
baseline bot loses money on it: buy-and-hold -44.01, momentum -40.92,
rsi-bollinger -57.37, adx-momentum -86.60, ema-cross -134.95 USDC.
This bot makes money by sitting in cash through the decline and
buying only the sharp dips (buys at bars 422, 822, 1006; sells at
550, 944, 1059).

**Robustness (exact backtester in `research/`, replicated against
the official grader to the micro-USDC):** the entry threshold sits in
the middle of a plateau — `mu` thresholds 0.0018 / 0.0020 / 0.0025
earn +24.71 / +23.02 / +17.66 USDC, and momentum rules, trailing
stops, time-based exits and weaker tilt weights all lose or earn
~$0. The signal's edge is real but concentrated: on the dev window
the whole profit comes from 3 round trips around the window's big
bounce hours, so the race window's outcome depends on whether it
holds comparable dips. No parameter was tuned to a single trade.

## Files

- `main.ts` — the bot (the entry).
- `vendor/makefun-bars.ts` — the kit's SDK shim, byte-identical.
- `README.md`, `LICENSE` (MIT).
- `research/` — local analysis only, **not part of the entry**:
  `backtest.py` (exact integer-math replay of the harness fill model),
  `robust.py`, `fine.py` (parameter and robustness checks).
- `kit/` — the downloaded competition kit, **not part of the entry**.
