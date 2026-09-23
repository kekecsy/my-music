@echo off
REM local music 一键打包脚本（Windows）
REM 产物：dist\local-music.exe
setlocal
cd /d "%~dp0"

echo 🧹 清理旧产物...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo 📦 安装依赖...
pip install -q -r requirements.txt

echo 🔨 开始打包（PyInstaller）...
pyinstaller build.spec --noconfirm

echo.
echo ✅ 打包完成！
echo    产物: %CD%\dist\local-music.exe
echo.
echo    测试运行: dist\local-music.exe
echo    浏览器会自动打开 http://127.0.0.1:8790
pause
