@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title local music

REM ============================================================
REM  local music - Windows launcher
REM  Double-click this file to run.
REM  First run creates a .venv and installs dependencies.
REM ============================================================

set "PY=.venv\Scripts\python.exe"

if not exist "%PY%" goto bootstrap
goto run


:bootstrap
echo.
echo   首次运行：正在初始化 Python 环境（需要联网，大约 1-2 分钟）...
echo.

REM 目录里可能残留从别的系统拷来的 .venv（没有 Scripts\python.exe），先清掉重建
if exist ".venv" (
  echo   检测到不可用的 .venv（可能来自 macOS/Linux），正在重建...
  rmdir /s /q ".venv"
)

set "BASE="
where py >nul 2>nul && set "BASE=py -3"
if not defined BASE (
  where python >nul 2>nul && set "BASE=python"
)
if not defined BASE goto no_python

echo   使用解释器：!BASE!
%BASE% -m venv .venv
if not exist "%PY%" goto venv_failed

echo   正在安装依赖（fastapi / uvicorn / httpx / yt-dlp）...
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 goto pip_failed

echo.
echo   环境初始化完成。
goto run


:no_python
echo.
echo   [错误] 没有找到 Python。
echo.
echo   请先安装 Python 3.9 或更高版本：https://www.python.org/downloads/
echo   安装时务必勾选 「Add python.exe to PATH」，装完重新双击本文件。
echo.
pause
exit /b 1


:venv_failed
echo.
echo   [错误] 虚拟环境创建失败。
echo.
echo   常见原因：
echo     1) Python 版本低于 3.9
echo     2) 装的是 Microsoft Store 的“python 占位程序”——它不会真正运行，
echo        请在「设置 - 应用 - 高级应用设置 - 应用执行别名」里关掉
echo        python.exe / python3.exe，再去 python.org 重装一次
echo     3) 项目目录没有写入权限（别放在 C:\Program Files 下）
echo.
pause
exit /b 1


:pip_failed
echo.
echo   [错误] 依赖安装失败，请检查网络后重试。
echo.
echo   国内网络可以先换清华源手动装：
echo       .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.
pause
exit /b 1


:run
if not defined LOCALMUSIC_PORT set "LOCALMUSIC_PORT=8790"

echo.
echo   local music 启动中 ...
echo   访问地址：http://127.0.0.1:!LOCALMUSIC_PORT!
echo   浏览器会自动打开；关闭本窗口即可退出服务。
echo.
echo   （首次运行如果 Windows 防火墙弹窗，请点「允许访问」）
echo.

"%PY%" app.py
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo   服务异常退出（代码 %RC%），把上面的报错发出来看看。
if "%RC%"=="0" echo   服务已退出。

if not defined LOCALMUSIC_NOPAUSE pause
exit /b %RC%
