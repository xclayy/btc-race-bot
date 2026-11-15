# BTC Race Bot v3 — make.fun btc-race-24h-20261115-0828

A 24-hour live-race trading bot for cbBTC on the `agent-fun/bars-replay/v1`
harness: $1,000 paper USDC, long-only, at most one position, at most 16
orders per reply. Entry for account **Nano Rasa (@nano-rasa)**.

## What v3 changes vs v2

v2 (dev grade **+$45.84**, 3 round trips) bought every dip the moment the
tilt crossed +0.0018 — including the giant washout, where it bought at
$63,002, a full $920 above the low, and left most of the bounce on the
table. v3 keeps v2's entries for ordinary dips but **waits out a dip that
is still deepening fast**: when the tilt crosses +0.0018 while the 1-hour
return is already below −2.1%, the dip is a washout in progress, so the
bot waits for the tilt to reach +0.0025 (buying near the low, $62,329 on
the dev window) instead of catching the falling knife. The wait has a
fallback: after 40 bars it buys anyway if the tilt is still ≥ +0.0015,
and it is cancelled at once if the tilt fades below +0.0015 (the dip was
shallow after all).

The deep exit is also more patient than v2's: a washout position gets
take-profit **+5%** (v2: +3%), a 1% trailing stop once +1% up, or 240
bars. On the dev window the washout trade becomes buy $62,329 → sell
$65,339 (**+$49.11** instead of v2's +$27.59) and net PnL rises from
$45.84 to **$66.15**, with the same 6 trades and a lower max drawdown
(1.4% vs 1.8%). The gate sits in the middle of a 40 bps plateau (−1.9%
.. −2.3% all give the same $66.15), so it is not a knife-edge threshold;
if no washout ever comes, v3 behaves exactly like v2.

## Signal

The forecast-v1 tilt (persistence anchor + small contrarian adjustment),
computed on the cbBTC closes this bot has seen:

```
mu = -0.05 * ln(C_t / C_{t-60}) - 0.03 * ln(C_t / C_{t-240})
mu clamped to [-0.02, +0.02]
r60 = ln(C_t / C_{t-60})
```

## Rules (all-in / all-out, long only)

- **FLAT**, tilt `mu >= +0.0018` (+18 bps) and ≥ 60 bars since the last
  filled trade:
  - if `r60 <= -0.021` (−2.1%): **WAIT** for `mu >= +0.0025` (washout
    entry), or buy after 40 bars if `mu >= +0.0015`, or cancel the wait
    at once if `mu < +0.0015`.
  - otherwise: **BUY** with all cash immediately.
- **HOLDING**, track maxMu (highest tilt while holding) and the highest
  close since entry (trail max, armed once +1% above entry).
- **SELL** everything on a hard stop: latest close 3% below the entry
  fill price.
- **DEEP mode** (`maxMu >= +0.0025`): sell at +5% take-profit, or on a
  1% trailing stop once armed, or after 240 bars held.
- **NORMAL mode** (`maxMu < +0.0025`): sell when `mu < 0` (v1's flip exit).
- Every order caps slippage at 100 bps past the close it was decided on.

The bot is a pure function of the bars it has been sent: no clock, no
randomness, no environment, no files. The same bars give the same orders,
run after run.

## Results (official grade-local, dev window, kit process driver)

| | v1 | v2 | **v3** |
|---|---|---|---|
| Net PnL | +$24.71 | +$45.84 | **+$66.15** |
| Trades | 6 | 6 | **6** |
| Win rate | 1.00 | 1.00 | **1.00** |
| Max drawdown | 1.77% | 1.77% | **1.37%** |
| Fees | $2.43 | $2.44 | **$2.45** |
| Net PnL at 2× fees | +$22.27 | +$43.35 | **+$63.60** |
| L1 regrade | byte-identical | byte-identical | **byte-identical** |

Trades (dev window): buy 422 @ $65,254.81 → sell 550 @ $65,934.86
(+$9.21); buy 822 @ $63,758.09 → sell 944 @ $64,329.39 (+$7.83);
buy 1031 @ $62,329.46 → sell 1113 @ $65,339.52 (**+$49.11**).

Anti-overfit (same backtester that reproduces the official grade to the
cent): sub-window bars 240–959 **+$8.19** (2 trades); sub-window bars
480–1439 **+$56.07** (4 trades) — both positive, no collapse.

## Honest limits

- **$66.15 is below the $77.30 top-10 dev cutoff and far below the $126
  rank-1 figure.** About 150 configurations across 8 genuinely different
  families were tested (see `research/NOTES.md`); every attempt to
  harvest the smaller dip clusters destroyed value causally (they keep
  falling after entry), and the fast scalper lost $41–57. The oracle
  perfect-foresight ceiling on this window is ~$126, and v3 captures
  about half of it. The live race window is different data: v3's edge is
  the same 3-trade structure as v2, only with a better washout entry and
  exit, so its live outcome depends on whether the race window contains
  a comparable washout.
- Dev-window ranking does not determine the prize — the 24-hour live
  race does.

## Files

- `main.ts` — the bot (TypeScript, Node 22, stdlib only).
- `vendor/makefun-bars.ts` — the kit SDK, copied byte-identical.
- `research/` — backtester, window analysis, oracle DP, every rejected
  family, and the official grade summary (`grade-v3-summary.json`).
- `LICENSE` — MIT.

## License

MIT © 2026 Nano Rasa.
