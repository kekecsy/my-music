#!/usr/bin/env bash
# local music · 启动脚本（macOS / Linux）
# 双击或在终端执行：./start.sh
set -e
cd "$(dirname "$0")"

PY=".venv/bin/python"

# 首次运行：创建虚拟环境并安装依赖
if [ ! -x "$PY" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "未找到 python3，请先安装 Python 3.9 或更高版本：https://www.python.org/downloads/"
    exit 1
  fi
  echo "首次运行，正在初始化环境（需要联网，约 1-2 分钟）..."
  python3 -m venv .venv
  "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q -r requirements.txt
  echo "环境初始化完成。"
fi

# 服务启动后会自动打开浏览器
# 也可手动访问 http://127.0.0.1:${LOCALMUSIC_PORT:-8790}
exec "$PY" app.py
