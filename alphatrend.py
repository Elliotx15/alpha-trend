"""Faithful Python port of the AlphaTrend Pine Script (v5) indicator.

Replicates alpha_trend.pin exactly:
  ATR   = SMA(true range, AP)
  upT   = low  - ATR * coeff
  downT = high + ATR * coeff
  AlphaTrend ratchets up along upT when MFI(hlc3, AP) >= 50,
  ratchets down along downT otherwise (nz(prev) = 0 warmup, same as Pine).
  BUY  = crossover(AlphaTrend, AlphaTrend[2])  deduped via barssince
  SELL = crossunder(AlphaTrend, AlphaTrend[2]) deduped via barssince
"""

import sys

import akshare as ak
import numpy as np
import pandas as pd

AP = 14
COEFF = 1.0

SYMBOL = "600030"  # CITIC Securities
START = "20220101"


def barssince(cond: np.ndarray) -> np.ndarray:
    """Pine ta.barssince: bars since cond was last true; NaN if never."""
    out = np.full(len(cond), np.nan)
    last = -1
    for i, c in enumerate(cond):
        if c:
            last = i
        if last >= 0:
            out[i] = i - last
    return out


def alphatrend(df: pd.DataFrame) -> pd.DataFrame:
    high, low, close, volume = df["high"], df["low"], df["close"], df["volume"]
    hlc3 = (high + low + close) / 3

    # True range: first bar falls back to high - low, same as Pine ta.tr
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    atr = tr.rolling(AP).mean()

    # MFI as in Pine ta.mfi: money flow = volume * hlc3, split by sign of change
    change = hlc3.diff()
    mf = volume * hlc3
    pos = mf.where(change > 0, 0.0)
    neg = mf.where(change < 0, 0.0)
    # First bar has na change in Pine, which poisons the first sum window
    pos.iloc[0] = np.nan
    neg.iloc[0] = np.nan
    upper = pos.rolling(AP).sum()
    lower = neg.rolling(AP).sum()
    mfi = 100 * upper / (upper + lower)

    up_t = low - atr * COEFF
    down_t = high + atr * COEFF

    # Recursive ratchet, nz(AlphaTrend[1]) -> 0 during warmup, same as Pine
    at = np.full(len(df), np.nan)
    for i in range(len(df)):
        if np.isnan(atr.iloc[i]) or np.isnan(mfi.iloc[i]):
            continue
        prev = at[i - 1] if i > 0 and not np.isnan(at[i - 1]) else 0.0
        if mfi.iloc[i] >= 50:
            at[i] = max(up_t.iloc[i], prev)
        else:
            at[i] = min(down_t.iloc[i], prev)
    at = pd.Series(at, index=df.index)
    at2 = at.shift(2)

    # crossover: a > b now and a <= b on the previous bar (NaN compares false)
    with np.errstate(invalid="ignore"):
        buy_raw = (at > at2) & (at.shift(1) <= at2.shift(1))
        sell_raw = (at < at2) & (at.shift(1) >= at2.shift(1))

        k1 = barssince(buy_raw.to_numpy())
        k2 = barssince(sell_raw.to_numpy())
        o1 = barssince(buy_raw.shift(1, fill_value=False).to_numpy())
        o2 = barssince(sell_raw.shift(1, fill_value=False).to_numpy())

        buy = buy_raw.to_numpy() & (o1 > k2)
        sell = sell_raw.to_numpy() & (o2 > k1)

    out = df.copy()
    out["alphatrend"] = at
    out["trigger"] = at2
    out["mfi"] = mfi
    out["buy"] = buy
    out["sell"] = sell
    return out


def main() -> None:
    adjust = sys.argv[1] if len(sys.argv) > 1 else ""  # "" raw, "qfq", "hfq"
    # Tencent source; the eastmoney endpoint is unreachable from this network
    raw = ak.stock_zh_a_hist_tx(
        symbol=f"sh{SYMBOL}", start_date=START, end_date="20500101", adjust=adjust
    )
    df = raw[["date", "open", "close", "high", "low", "volume"]]

    res = alphatrend(df)
    signals = res[res["buy"] | res["sell"]]

    label = adjust if adjust else "raw (no adjust)"
    print(f"AlphaTrend signals for {SYMBOL} (CITIC Securities), price data: {label}")
    print(f"{'date':<12}{'signal':<8}{'close':>8}{'alphatrend':>12}{'trigger':>10}")
    for _, r in signals.iterrows():
        kind = "BUY" if r["buy"] else "SELL"
        print(
            f"{str(r['date']):<12}{kind:<8}{r['close']:>8.2f}"
            f"{r['alphatrend']:>12.3f}{r['trigger']:>10.3f}"
        )

    last = res.iloc[-1]
    print(
        f"\nlatest bar {last['date']}: close={last['close']:.2f} "
        f"alphatrend={last['alphatrend']:.3f} trigger={last['trigger']:.3f} "
        f"mfi={last['mfi']:.1f}"
    )


if __name__ == "__main__":
    main()
