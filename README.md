# BTC Race Bot v2 — mean-reversion dip buyer with a regime-dependent exit

Entry for the make.fun bounty **"Race a BTC trading bot live for 24 hours"**
(`btc-race-24h-20261115-0828`), account **Nano Rasa (@nano-rasa)**.
TypeScript (Node 22), protocol `agent-fun/bars-replay/v1`, NDJSON on
stdin/stdout. One file, `main.ts`, plus the kit SDK copied byte-identical
in `vendor/makefun-bars.ts`.

## What changed vs v1

v1 (submitted, server dev grade **+$24.71**, 3 round trips, win rate 1.00)
bought the same dips this bot buys, but sold every one the moment the
tilt flipped negative — right at the start of the bounce. Its washout
trade (bought $63,002, sold $63,478, +0.75%) left most of the bounce on
the table: the price ran to ~$64,790 over the next four hours.

v2 keeps v1's entries and adds one idea: **track the maximum tilt
reached while holding**. A dip that keeps deepening after entry
(max tilt ≥ +0.0025) is a genuine washout, and washouts take hours to
play out — so those positions get a patient exit (take-profit +3%,
trailing stop 1% once +1% up, or 240 bars), while ordinary dips keep
v1's quick flip exit. On the dev window this changes exactly one trade
(the washout) and lifts net PnL from **$24.71 to $45.84**, with the
same 6 trades and the same 1.8% max drawdown.

## Strategy

Signal — the forecast-v1 tilt (persistence anchor + small contrarian
adjustment), computed on the cbBTC closes the bot has seen:

```
mu = -0.05 * ln(C_t / C_{t-60}) - 0.03 * ln(C_t / C_{t-240}), clamped ±0.02
```

Rules (all-in / all-out, long only, at most one position):

- **BUY** all cash when flat, `mu >= +0.0018`, and ≥ 60 bars since the
  last filled trade.
- **HOLDING:** track `maxMu` (highest tilt while holding) and the
  highest close since entry (trail max, armed once +1% above entry).
- **Hard stop, always on:** sell everything if the latest close is
  3% below the entry fill price.
- **DEEP mode** (`maxMu >= +0.0025`): sell at +3% take-profit, or on a
  1% trailing stop once armed, or after 240 bars held.
- **NORMAL mode** (`maxMu < +0.0025`): sell when `mu < 0` (v1's flip exit).
- Every order caps slippage at 100 bps past the close it was decided
  on, so a fill into a gap is refused and retried rather than taken
  for almost nothing.

Deterministic: a pure function of the bars it has been sent. No clock,
no randomness, no environment, no files.

## Verified results (official grade-local, dev window, 1,440 bars)

```
net PnL          +$45.84   (+4.58% on $1,000)     v1: +$24.71
trades           6 (3 round trips), win rate 1.00, 0 rejected
max drawdown     1.77%                            v1: 1.77%
fees             $2.44
exposure         24.65%
constraints      compliant (trades_ok, drawdown_ok)
2x fees          +$43.35  (still strongly positive)
L1 regrade       reproduced: true (deterministic)
```

Per-trade (backtester, matches grade-local to the cent):

| # | Buy | Sell | Hold | Net |
|---|-----|------|------|-----|
| 1 | bar 422 @ $65,254.81 | bar 550 @ $65,934.86 | 128 bars | +$9.21 |
| 2 | bar 822 @ $63,758.09 | bar 944 @ $64,329.39 | 122 bars | +$7.83 |
| 3 | bar 1006 @ $63,001.86 | bar 1111 @ $64,786.71 | 105 bars | +$27.59 (deep mode; v1 sold this at $63,477.56 for +$7.28) |

## Anti-overfit evidence

- **Sub-windows** (same bot, truncated replays, fresh start): bars
  240–959: **+$8.19** (2 trades); bars 480–1439: **+$35.96** (4 trades).
  Both positive; neither collapses.
- **Parameter plateau, not a point** (full window): deep threshold
  0.0022 and 0.0025 both give $45.84; TP 3% vs no TP differ by $1.26;
  trailing stop on/off identical; stop-loss 2% vs 3% identical.
- **Rejected designs** (all measured, see `research/NOTES.md`):
  plain tilt variants cap ~$23; dip-buy grids cap ~$27; ladder /
  pyramiding $13.46 (under-invested); stabilization arms **hurt**
  ($31.71 vs $45.84 — they steal entries at worse prices); lower
  entry threshold 0.0015 → $30.58.
- **Oracle ceiling** (perfect foresight on the same window, 8 clusters,
  entry at each local low, exit at the peak): ~$133. The $77 top-10
  cutoff was **not** reached — $45.84 is the best causal rule found
  in ~100 tested configurations. The live window is different data;
  nothing here guarantees a prize.

## Files

- `main.ts` — the bot (7,440 bytes).
- `vendor/makefun-bars.ts` — kit SDK, byte-identical copy.
- `kit/` — the competition kit (for local grading; not part of the entry).
- `research/` — backtester, grids, grade-local outputs, notes.
- `README.md`, `LICENSE` (MIT © 2026 Nano Rasa), `TRANSCRIPT.md`,
  `transcript.jsonl`.

## Local grading

```sh
node kit/btc-race-24h-20261115-0828-kit/cli/makefun.mjs grade-local \
  --kit kit/btc-race-24h-20261115-0828-kit --bot . \
  --driver process --worktree --save /tmp/grade-race-v2
```

(Docker is not available on this VM, so the process driver is used;
the server grades in its docker sandbox on Node v22.23.4, this VM
runs v24.22.1 — the only noted mismatch, same as v1.)
