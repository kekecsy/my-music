#!/bin/bash
# local music · 启动脚本（双击或 ./启动.sh 运行）
cd "$(dirname "$0")"
PY="/Users/kekecsy/.workbuddy/binaries/python/envs/default/bin/python3"
if [ ! -x "$PY" ]; then
  echo "未找到运行环境，正在初始化..."
  /Users/kekecsy/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -m venv \
    /Users/kekecsy/.workbuddy/binaries/python/envs/default
  "$PY" -m pip install -q fastapi "uvicorn[standard]" httpx yt-dlp
fi
PORT=8790
if lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已在运行: http://127.0.0.1:$PORT"
  open "http://127.0.0.1:$PORT"
  exit 0
fi
echo "启动 local music ... 浏览器将自动打开 http://127.0.0.1:$PORT"
(sleep 1.5 && open "http://127.0.0.1:$PORT") &
exec "$PY" -m uvicorn app:app --host 127.0.0.1 --port $PORT
