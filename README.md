# alpha-trend

本地网页版 AlphaTrend 信号查看器：K 线 + AlphaTrend/Trigger 指标线 + 趋势填充 +
BUY/SELL 信号标记，复刻 TradingView 上 `alpha_trend.pin`（Pine v5）的显示效果。

- **指标计算**：`alphatrend.py`（Pine 的忠实 Python 移植），参数固定 Length=14 / Multiplier=1.0
- **数据**：akshare 腾讯日线源，前复权（qfq），2022-01-01 起，仅沪深 A 股
- **访问**：仅绑定 127.0.0.1，不对外

## 启动

```bash
uv run python serve.py
```

浏览器打开 <http://127.0.0.1:8320>，输入 6 位 A 股代码（如 `600030`）回车。
历史输入保存在浏览器 localStorage（最近 20 个），点代码片签可快速切换；「刷新」
按钮会绕过缓存重新拉取。

## 结构

| 路径 | 说明 |
|---|---|
| `alpha_trend.pin` | Pine Script v5 原版指标（参考源） |
| `alphatrend.py` | 指标计算 + CLI（`uv run python alphatrend.py [qfq]`） |
| `serve.py` | 启动入口（uvicorn, 127.0.0.1:8320） |
| `app/server.py` | FastAPI：`GET /api/alpha?symbol=xxxxxx` + 静态页面 |
| `web/` | 前端单页（TradingView lightweight-charts，已本地化到 `web/vendor/`） |
