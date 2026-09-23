#!/bin/bash
# local music · 一键打包脚本（macOS / Linux）
# 产物：dist/local-music（单文件可执行程序）
set -e

cd "$(dirname "$0")"

echo "🧹 清理旧产物..."
rm -rf build dist

echo "📦 安装依赖..."
pip install -q -r requirements.txt

echo "🔨 开始打包（PyInstaller）..."
pyinstaller build.spec --noconfirm

echo ""
echo "✅ 打包完成！"
echo "   产物: $(pwd)/dist/local-music"
echo ""
echo "   测试运行: ./dist/local-music"
echo "   浏览器会自动打开 http://127.0.0.1:8790"
