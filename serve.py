"""Run the local AlphaTrend web server: http://127.0.0.1:8320"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.server:app", host="127.0.0.1", port=8320, log_level="info")
