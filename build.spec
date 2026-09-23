# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置 · local music
构建单文件可执行程序，内嵌 Python 运行时和 static 资源。
"""
import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# 收集 yt-dlp 的所有子模块（它有大量动态导入的 extractor）
hiddenimports = collect_submodules('yt_dlp')
# 补充可能被遗漏的
hiddenimports += [
    'yt_dlp',
    'httpx',
    'httpx._transports',
    'httpx._transports.default',
    'h11',
    'anyio',
    'anyio._backends',
    'anyio._backends._asyncio',
    'sniffio',
    'certifi',
    'fastapi',
    'fastapi.staticfiles',
    'starlette',
    'starlette.responses',
    'starlette.staticfiles',
    'uvicorn',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
]

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('static', 'static'),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 排除不必要的大模块减小体积
        'tkinter',
        'unittest',
        'pydoc',
        'doctest',
        'argparse',
        'pip',
        'setuptools',
        'wheel',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='local-music',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # 无控制台窗口（mac 用 .app 模式，win 隐藏 cmd）
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon='static/icon.icns',  # 如有图标可启用
)
