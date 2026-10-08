# 🎧 local music

> 半本地音乐播放器 · 收藏 B 站音乐视频，在线流播放或下载离线，跨平台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)]()
[![Python](https://img.shields.io/badge/python-3.9+-blue)]()

> 🪟 **Windows 用户**：有一份手把手的完整指南 —— [**docs/WINDOWS.md**](docs/WINDOWS.md)
> （装 Python、双击启动、装插件、数据在哪、常见报错，全都写了）。

## ✨ 特性

- **收藏 B 站音乐**：粘贴视频链接即可收藏，支持完整链接 / BV 号 / b23.tv 短链
- **浏览器插件**：逛 B 站时点一下页面右下角的悬浮按钮（或右键菜单）直接收藏，多P合集可选整辑收进来；
  还能在插件里**绑定本地项目目录**，这样不启动 local music 也能随手收藏，下次启动时自动收进曲库。
  详见 [extension/README.md](extension/README.md)
- **多P合集支持**：多P视频自动按合集分组展示，可单独操作每首歌
- **子视频链接也能认出合集**：粘贴带 `?p=3` 的单集链接时，会告诉你它属于哪个合集、共几 P，
  让你选「只要这一集」或「收藏整个合集」；单集收藏过的合集在列表里也会标成
  `合集 · 已收 1 / 共 60 P`，随时点一下补齐剩下的
- **在线流播放**：直接流式播放 B 站音频，无需下载
- **离线下载**：一键下载到本地，断网也能听；已下载的歌曲优先本地播放
- **已下载音乐**：侧栏单独一栏，只列出已存到本地的曲子（带数量），断网或想听离线曲库时直接切过去
- **封面本地化**：封面自动缓存到本地，断网也有封面；下载歌曲时会把封面内嵌进音频文件（需系统有 `ffmpeg`）
- **歌单管理**：新建 / 重命名 / 删除歌单（右键歌单即可操作），跨歌单添加歌曲、批量操作。
  曲库本身就是「我收藏的歌」，所以不再内置默认歌单 —— 想分类就自己建
- **全部音乐有两种看法**：默认「分组」（把同一个合集的多 P 折叠成一张合集卡片，可展开/收起），
  工具条上点一下切到「列表」（一行一首，可**按住拖动排序**，顺序会保存到曲库）。选择会被记住
- **播放列表**：独立于歌单的实时播放队列，入口在底部播放条右侧（网易云风格），点一下从下方弹出面板，
  可拖动排序、单曲移除、一键清空；队列数直接显示在按钮上
- **拖动排序**：播放列表面板、歌单、以及「全部音乐」的列表视图都可以按住拖动来调整顺序，顺序会自动保存
- **分享链接**：右键歌曲或合集即可复制它在 B 站的原始链接（多 P 视频会自动带上分 P 参数，
  对方点开直接落到那一集），也可以连歌名 / UP 主一起复制，方便直接粘到聊天窗口
- **四种播放模式**：列表循环 / 单曲循环 / 顺序播放 / 随机播放
- **状态持久化**：刷新或重启后自动恢复到上次播放的位置和队列
- **跨平台**：macOS / Windows / Linux 全平台支持，双击即用

## 🖱️ 操作速查

| 操作 | 说明 |
|------|------|
| B站视频页右下角悬浮按钮 | 装了浏览器插件后，点一下直接收藏（多P会问你要不要收整个合集），服务没启动也能用，详见 [extension/README.md](extension/README.md) |
| 粘贴链接 → 收藏 | 支持 BV 号 / 完整链接 / b23.tv 短链；粘贴 `?p=N` 的单集链接会问你要不要收整个合集 |
| 合集头右侧「收齐」图标 | 把这个合集还没收藏的分 P 一次收进来 |
| 单击歌曲 | 从当前列表开始播放 |
| 悬停歌曲 → 勾选框 | 多选，底部弹出批量操作条 |
| **右键歌曲** | 立即播放 / 下一首播放 / 下载 / 加入歌单 / **复制分享链接** / 收藏整个合集 / 补齐封面 / 删除本地文件 / 删除 |
| **右键歌单** | 播放整个歌单 / 加入播放列表 / 重命名 / 删除 |
| **右键合集头** | 播放整辑 / 下载整辑 / 收藏整个合集 / 加入歌单 / **复制合集链接** / 全选 / 删除整辑 |
| 播放栏歌名右侧分享图标 | 分享当前正在播放的这首（鼠标移到播放栏时才浮现） |
| 分享弹窗内 | 「复制链接」只复制 URL；「复制歌曲信息」复制「歌名 - UP 主 + 换行 + URL」 |
| **播放条右侧「播放列表」按钮** | 从底部弹出当前播放队列（面板里可拖动排序 / 单曲移除 / 清空，按钮上的数字是队列长度）；再点一次、按 Esc 或点面板外都收起 |
| **工具条「分组 / 列表」**（仅「全部音乐」时出现） | 在「按合集分组」和「扁平列表」之间切换；列表模式下可拖动排序 |
| **拖动歌曲行**（播放列表面板 / 歌单 / 全部音乐·列表） | 调整顺序，悬停时可看到拖动把手；顺序都会保存下来（曲库顺序存进数据库） |
| 侧栏「已下载音乐」 | 只看已下到本地的曲子（断网也能播的那批） |
| 「歌单」标题右侧 + | 新建歌单 |
| 双击合集头 | 展开 / 收起（展开后限高 7 首，内部滚动） |
| 空格 | 播放 / 暂停 |
| 左下角模式按钮 | 切换四种播放模式 |

## 📦 下载使用

前往 [Releases](../../releases/latest) 下载对应平台的压缩包：

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS (Apple Silicon) | `local-music-macos-arm64.tar.gz` | M1/M2/M3 芯片 |
| macOS (Intel) | `local-music-macos-x64.tar.gz` | Intel 芯片 |
| Windows | `local-music-windows-x64.exe` | 64 位 Windows |

**macOS 用户：**

```bash
tar -xzf local-music-macos-arm64.tar.gz
./local-music-macos-arm64
```

首次运行若提示「无法验证开发者」，打开「系统设置 → 隐私与安全性」，在底部点击「仍要打开」即可（只需一次）。
若提示权限不足，先执行 `chmod +x local-music-macos-arm64`。

**Windows 用户：** 直接双击 `local-music-windows-x64.exe`。

- 建议先建个目录（例如 `D:\local-music\`）再放进去，**不要**放 `C:\Program Files\` 下
- 若 SmartScreen 拦截，点「**更多信息 → 仍要运行**」
- 首次运行若弹防火墙提示，勾上「专用网络」点「允许访问」
- 数据存在 `%APPDATA%\localmusic`，在资源管理器地址栏粘贴这一串就能直达

更细的步骤（含开机自启、备份、卸载）见 [docs/WINDOWS.md](docs/WINDOWS.md)。

启动后会自动打开浏览器（`http://127.0.0.1:8790`）。再次双击同一程序不会重复启动，只会把浏览器窗口切到前台。

## 🔧 从源码运行

适合开发者或想自定制的用户。

### 环境要求

- Python 3.9+
- 网络可访问 bilibili.com

### 步骤

**Windows**（已经装好 Python 并勾了 Add to PATH）：

```bat
git clone https://github.com/kekecsy/my-music.git
cd my-music
start.bat
```

`start.bat` 会自动建虚拟环境、装依赖、启动服务并打开浏览器 —— 双击即可，首次约 1–2 分钟。
不想用脚本也行：

```bat
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe app.py
```

**macOS / Linux**：

```bash
git clone https://github.com/kekecsy/my-music.git
cd my-music
./start.sh
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

### 改完前端看不到效果？

前端资源由服务端**自动管理版本**：首页 `index.html` 里的 `?v=` 会实时替换成
`static/` 下 js/css 的指纹，同时这些资源都带 `Cache-Control: no-cache`
（ETag 命中时返回 304，不影响加载速度）。所以改完 `static/` 下的文件**直接刷新页面**即可，
不需要手动改版本号。

如果刷新后还是旧界面，按顺序排查：

1. **页面根本没重新加载**——`app.py` 是用 `webbrowser.open()` 打开浏览器的，
   页面已经开着时它只会把标签页切到前面、**不会重新导航**。手动按一次 `⌘R`（Windows 是 `Ctrl+R`）
   （还不行就 `⌘⇧R` 强制刷新，Windows 是 `Ctrl+Shift+R`）。
2. **改了 `app.py`（路由 / 中间件）后没重启服务**——前端资源每次请求读盘，
   但 `app.py` 里的代码是进程启动时加载的，必须重启。
3. 用命令行确认服务端到底下发了什么：
   ```bash
   curl -s http://127.0.0.1:8790/ | grep '?v='          # 页面引用的版本（10 位指纹）
   curl -s -D- -o /dev/null http://127.0.0.1:8790/app.js | grep -i cache-control
   ```
   （注意：`curl -I` 发的是 HEAD 请求，要用 `curl -s -D- -o /dev/null` 才看得到 GET 的响应头。）

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
├── start.sh            # macOS / Linux 一键启动（自动建 venv、装依赖）
├── start.bat           # Windows 一键启动（同上）
├── build.spec          # PyInstaller 打包配置
├── build.sh            # mac/linux 一键打包
├── build.bat           # Windows 一键打包
├── extension/          # 浏览器插件（B站页面一键收藏），详见 extension/README.md
├── docs/
│   └── WINDOWS.md      # 🪟 Windows 完整使用指南
├── requirements.txt
├── .github/workflows/
│   └── release.yml     # GitHub Actions 自动构建
└── README.md
```

运行时数据目录（开发模式在项目内，打包版在用户目录）：

```
data/
├── music.db            # 曲库 / 歌单数据库
├── music/              # 下载的音频文件
├── covers/             # 封面缓存（离线可用）
├── extension-inbox.jsonl  # 浏览器插件离线收藏的落点（启动时自动导入，导入后归档到 inbox/）
└── inbox/              # 已导入的插件收藏归档
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
