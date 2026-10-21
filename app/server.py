"""Local web server: serves the chart page and the AlphaTrend signal API.

Binds to 127.0.0.1 only. Data comes from akshare's Tencent daily source
(qfq), indicator math is the faithful port in alphatrend.py with the
Pine defaults (Length=14, Multiplier=1.0).
"""

import math
import time
from pathlib import Path

import akshare as ak
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from alphatrend import alphatrend as compute_alphatrend

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
START_DATE = "20220101"
END_DATE = "20500101"
ADJUST = "qfq"
CACHE_TTL = 600.0

app = FastAPI(title="AlphaTrend local")
_cache: dict[str, tuple[float, dict]] = {}


def _classify(code: str) -> str:
    """Market prefix for a 6-digit A-share code (Tencent sh/sz convention)."""
    if code.startswith(("60", "68", "90", "11", "51")):
        return "sh"
    if code.startswith(("00", "30", "20", "12", "15")):
        return "sz"
    raise HTTPException(
        status_code=400,
        detail="无法识别的市场：仅支持沪深 A 股（60/68 开头为沪市，00/30 开头为深市）",
    )


def _num(v, nd: int):
    """Round to nd decimals; NaN/None -> None (JSON-safe)."""
    if v is None:
        return None
    f = float(v)
    if math.isnan(f):
        return None
    return round(f, nd)


def _build_payload(code: str) -> dict:
    prefix = _classify(code)
    raw = ak.stock_zh_a_hist_tx(
        symbol=f"{prefix}{code}",
        start_date=START_DATE,
        end_date=END_DATE,
        adjust=ADJUST,
    )
    df = raw[["date", "open", "close", "high", "low", "volume"]]
    if df.empty:
        raise HTTPException(status_code=404, detail=f"{code} 没有拉到行情数据，请确认代码是否正确")
    res = compute_alphatrend(df)

    dates = [str(d)[:10] for d in res["date"]]
    at = res["alphatrend"]
    at2 = res["trigger"]

    candles = [
        [
            _num(r["open"], 2),
            _num(r["high"], 2),
            _num(r["low"], 2),
            _num(r["close"], 2),
        ]
        for _, r in res.iterrows()
    ]
    at_col = [_num(v, 3) for v in at]
    at2_col = [_num(v, 3) for v in at2]

    # Fill direction, mirroring Pine color1:
    #   at > at2 ? up : at < at2 ? down : at[1] > at[3] ? up : down
    dir_col: list[int | None] = []
    n = len(res)
    for i in range(n):
        a, b = at.iloc[i], at2.iloc[i]
        if math.isnan(a) or math.isnan(b):
            dir_col.append(None)
            continue
        if a > b:
            dir_col.append(1)
        elif a < b:
            dir_col.append(-1)
        else:
            a1 = at.iloc[i - 1] if i >= 1 else float("nan")
            a3 = at.iloc[i - 3] if i >= 3 else float("nan")
            dir_col.append(1 if a1 > a3 else -1)

    sig_mask = res["buy"] | res["sell"]
    signals = [
        {
            "time": str(r["date"])[:10],
            "type": "buy" if r["buy"] else "sell",
            "close": _num(r["close"], 2),
        }
        for _, r in res[sig_mask].iterrows()
    ]

    last = res.iloc[-1]
    latest = {
        "time": str(last["date"])[:10],
        "close": _num(last["close"], 2),
        "alphatrend": _num(last["alphatrend"], 3),
        "trigger": _num(last["trigger"], 3),
        "mfi": _num(last["mfi"], 1),
    }

    return {
        "symbol": code,
        "adjust": ADJUST,
        "dates": dates,
        "candles": candles,
        "at": at_col,
        "at2": at2_col,
        "dir": dir_col,
        "signals": signals,
        "latest": latest,
    }


@app.get("/api/alpha")
def alpha(symbol: str, refresh: bool = False):
    code = symbol.strip()
    if not (code.isdigit() and len(code) == 6):
        raise HTTPException(status_code=400, detail="请输入 6 位 A 股代码，例如 600030")
    if not refresh:
        hit = _cache.get(code)
        now = time.monotonic()
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]
    try:
        payload = _build_payload(code)
    except HTTPException:
        raise
    except Exception as e:  # akshare network / parse errors, non-existent codes
        raise HTTPException(
            status_code=502,
            detail=f"没有拉到 {code} 的行情数据，请确认代码是否正确（{e}）",
        )
    _cache[code] = (time.monotonic(), payload)
    return payload


# Static page must be mounted after API routes so /api wins.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
