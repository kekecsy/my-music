# 🎧 local music

> 半本地音乐播放器 · 收藏 B 站音乐视频，在线流播放或下载离线，跨平台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)]()
[![Python](https://img.shields.io/badge/python-3.9+-blue)]()

## ✨ 特性

- **收藏 B 站音乐**：粘贴视频链接即可收藏，支持完整链接 / BV 号 / b23.tv 短链
- **多P合集支持**：多P视频自动按合集分组展示，可单独操作每首歌
- **在线流播放**：直接流式播放 B 站音频，无需下载
- **离线下载**：一键下载到本地，断网也能听；已下载的歌曲优先本地播放
- **歌单管理**：自由新建歌单、跨歌单添加歌曲、批量操作
- **播放列表**：独立于歌单的实时播放队列，可单独管理
- **四种播放模式**：列表循环 / 单曲循环 / 顺序播放 / 随机播放
- **状态持久化**：刷新或重启后自动恢复到上次播放的位置和队列
- **跨平台**：macOS / Windows / Linux 全平台支持，双击即用

## 📦 下载使用

前往 [Releases](../../releases/latest) 下载对应平台的可执行文件：

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS (Apple Silicon) | `local-music-macos-arm64` | M1/M2/M3 芯片 |
| macOS (Intel) | `local-music-macos-x64` | Intel 芯片 |
| Windows | `local-music-windows-x64.exe` | 64 位 Windows |

**macOS 用户**：首次打开可能提示"无法验证开发者"。右键 → 打开，或在「系统设置 → 隐私与安全性」点击「仍要打开」即可。

双击运行后会自动启动服务并打开浏览器，无需任何配置。

## 🔧 从源码运行

适合开发者或想自定制的用户。

### 环境要求

- Python 3.9+
- 网络可访问 bilibili.com

### 步骤

```bash
git clone https://github.com/kekecsy/my-music.git
cd my-music
pip install -r requirements.txt
python app.py
```

浏览器会自动打开 `http://127.0.0.1:8790`。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LOCALMUSIC_PORT` | `8790` | 服务端口 |
| `LOCALMUSIC_DATA_DIR` | 平台规范目录 | 数据目录（数据库 + 音频文件） |

**默认数据目录：**
- macOS: `~/Library/Application Support/localmusic`
- Windows: `%APPDATA%\localmusic`
- Linux: `~/.local/share/localmusic`

开发模式下（源码运行），数据存在项目根目录的 `data/` 和 `music/`。

## 🏗️ 自行打包

```bash
pip install -r requirements.txt

# macOS / Linux
./build.sh

# Windows
build.bat
```

产物在 `dist/` 目录下。macOS 会生成单文件可执行程序，Windows 生成 `.exe`。

## 🗂️ 项目结构

```
my-music/
├── app.py              # FastAPI 后端（收藏/下载/流播放/歌单）
├── static/             # 前端（原生 JS + CSS，无框架）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── build.spec          # PyInstaller 打包配置
├── build.sh            # mac/linux 一键打包
├── build.bat           # Windows 一键打包
├── requirements.txt
├── .github/workflows/
│   └── release.yml     # GitHub Actions 自动构建
└── README.md
```

## ⚠️ 说明

- 本工具仅用于个人离线收听已合法获取的音频内容
- 需要大会员的视频无法解析
- 下载的内容版权归原作者所有，请勿用于商业用途或二次分发
- 使用本工具产生的任何法律后果由使用者自行承担

## 🤝 贡献

欢迎提 Issue 反馈 bug 或建议功能，PR 请先开 Issue 讨论。

## 📄 License

[MIT](LICENSE)
