# 🪟 Windows 使用指南

> 适用于 **Windows 10 / 11（64 位）**。从零到能在 B 站一键收藏，全程照做即可。

---

## 0. 先选一种用法

| | **方式 A · 打包版** | **方式 B · 源码运行** |
|---|---|---|
| 适合谁 | 只想安安静静听歌 | 想改代码 / 自定义 / 自己打包 |
| 需要装 Python | ❌ 不用 | ✅ 需要 |
| 怎么启动 | 双击 `local-music-windows-x64.exe` | 双击 `start.bat` |
| 数据放在哪 | `%APPDATA%\localmusic` | 项目目录下的 `data\`、`music\` |
| 升级 | 换一个新 exe | `git pull` 后重跑 `start.bat`（依赖变了才需重装） |
| 本章节 | [跳到 §1](#1-方式-a打包版最简单) | [跳到 §2](#2-方式-b源码运行) |

**两种方式可以共存**，但会各自维护一份曲库。建议只用其中一种。

---

## 1. 方式 A：打包版（最简单）

### 1.1 下载

到本项目的 [Releases](../../releases/latest) 页面，下载：

```
local-music-windows-x64.exe
```

**放哪里**：建议单独建一个目录，例如 `D:\local-music\`，把 exe 丢进去。
**不要**放到 `C:\Program Files\` 下面（写文件会被 UAC 拦）。

### 1.2 第一次运行

双击 `local-music-windows-x64.exe`。

- **SmartScreen 拦截**（“Windows 已保护你的电脑”）→ 点「**更多信息**」→「**仍要运行**」。
  这是因为 exe 没有代码签名，不是病毒。
- **防火墙弹窗** → 勾上「专用网络」→「**允许访问**」。
  服务只监听 `127.0.0.1`，拒绝也不影响本机使用，但允许更省事。
- 随后浏览器自动打开 `http://127.0.0.1:8790`，看到播放器界面就成了。

### 1.3 平时怎么用

| 想做的事 | 怎么做 |
|---|---|
| 打开播放器 | 再次双击 exe（已在运行就只把浏览器切到前台，不会重复启动） |
| 手动访问 | 浏览器地址栏输入 `http://127.0.0.1:8790` |
| **退出服务** | 关掉那个黑色命令行窗口 |
| 让它在开机时自己起来 | `Win+R` → 输入 `shell:startup` → 把 exe 的**快捷方式**丢进去 |

### 1.4 你的数据在哪

```
C:\Users\<你的用户名>\AppData\Roaming\localmusic\
├── music.db      ← 曲库 / 歌单 / 播放列表
├── music\        ← 下载下来的音频文件
├── covers\       ← 封面缓存（断网也有封面）
└── inbox\        ← 浏览器插件离线收藏的归档
```

快速打开：`Win+R` → 粘贴 `%APPDATA%\localmusic` → 回车。

> 备份 = 把整个 `localmusic` 文件夹复制走。换电脑时复制回来即可，曲库和音频都在。

---

## 2. 方式 B：源码运行

### 2.1 装 Python

1. 打开 <https://www.python.org/downloads/>，下载 **Windows installer (64-bit)**，
   版本 **3.9 或更高**（推荐 3.11 / 3.12）。
2. 运行安装包，**第一屏底部一定要勾选**：

   ```
   ☑ Add python.exe to PATH
   ```

   漏了这个，后面会一直报「python 不是内部或外部命令」。
3. 验证：`Win+R` → 输入 `cmd` → 回车，然后执行：

   ```bat
   python --version
   ```

   能打印出 `Python 3.x.x` 就 OK。

**踩坑警告 · Microsoft Store 的“python 占位程序”**

如果你在 `cmd` 里敲 `python` 会**弹出应用商店**，说明系统里只有 Store 的占位程序。
请到「**设置 → 应用 → 高级应用设置 → 应用执行别名**」，把里面的
`python.exe` 和 `python3.exe` 两个开关**都关掉**，然后回到 §2.1 第 1 步，从 python.org 正经装一次。

### 2.2 拿到项目

任选一种：

```bat
REM 有 Git 的话
git clone https://github.com/kekecsy/my-music.git
cd my-music
```

或者直接在 GitHub 页面上点 **Code → Download ZIP**，解压到一个好记的位置，例如 `D:\my-music`。

> 路径里带中文或空格一般也能用，但**纯英文路径最省事**（某些工具链对中文路径支持不好）。

### 2.3 双击 `start.bat`

就这么简单。脚本会自动：

1. 检查有没有 `.venv`，没有就**建虚拟环境**
2. 从 `requirements.txt` **装依赖**（首次约 1–2 分钟，需要联网）
3. 启动服务并打开浏览器

**首次运行**的窗口大致是这样：

```
  首次运行：正在初始化 Python 环境（需要联网，大约 1-2 分钟）...

  使用解释器：py -3
  正在安装依赖（fastapi / uvicorn / httpx / yt-dlp）...
  环境初始化完成。

  local music 启动中 ...
  访问地址：http://127.0.0.1:8790
  浏览器会自动打开；关闭本窗口即可退出服务。
```

**之后再启动**就直接进第 3 步了，几秒钟的事。

> 想建桌面快捷方式：右键 `start.bat` → 发送到 → 桌面快捷方式，
> 再右键快捷方式 → 属性 → 把「运行方式」改成「最小化」，眼不见心不烦。

### 2.4 手动运行（等价做法，想懂原理时看）

```bat
cd /d D:\my-music

REM 1) 创建虚拟环境（只需一次）
py -3 -m venv .venv

REM 2) 安装依赖（只需一次，或 requirements.txt 变了之后）
.venv\Scripts\python.exe -m pip install -r requirements.txt

REM 3) 启动
.venv\Scripts\python.exe app.py
```

依赖装得慢就换国内源：

```bat
.venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 2.5 你的数据在哪

源码模式下数据就放在项目里，方便一起备份、也方便看：

```
D:\my-music\
├── data\
│   ├── music.db     ← 曲库 / 歌单 / 播放列表
│   ├── covers\      ← 封面缓存
│   └── inbox\       ← 插件离线收藏归档
└── music\           ← 下载的音频文件
```

---

## 3. 装浏览器插件（想要「B 站页面一键收藏」就装）

插件是本地加载的（没上架商店），装一次就长期有效。

1. 地址栏输入 `chrome://extensions`（Edge 用 `edge://extensions`）
2. 打开右上角的「**开发者模式**」开关
3. 点左上角「**加载已解压的扩展程序**」
4. 选中项目里的 **`extension`** 文件夹
   - 方式 B（源码）：`D:\my-music\extension`
   - 方式 A（打包版）：exe 里没带插件目录，请把仓库单独 clone 或下载 ZIP，
     只用它的 `extension\` 文件夹即可
5. 工具栏出现蓝紫色方块图标（戴耳机的猫）→ 建议点 📌 固定，方便随时点

> Firefox 和 Safari 不支持（清单格式不同）。

### 3.1 绑定本地项目目录（可选，但强烈推荐）

绑了之后**不启动 local music 也能随手收藏**：收藏先写进项目目录 / 插件队列，
下次启动服务时自动入库，一条都不会丢。

弹窗 →「本地项目目录」→「**绑定本地项目目录**」，会打开设置页：

| 你的用法 | 该选哪个文件夹 |
|---|---|
| 源码运行（方式 B） | 项目根目录，例如 `D:\my-music`（里面有 `app.py`、`static\`） |
| 打包版（方式 A） | 数据目录：在资源管理器地址栏粘贴 `%APPDATA%\localmusic` 回车，选中它 |

选择时浏览器会弹权限提示，选「**每次访问时都允许**」。

**看到「需要重新授权」不是坏了** —— 浏览器的文件系统授权本来就不跨会话保留：
把设置页关掉之后权限就没了。点一下「**恢复读写权限**」再选「每次访问时都允许」即可，
不用重新挑文件夹。就算一直不恢复，收藏也只会排在插件自己的队列里，不会丢。

---

## 4. 装 ffmpeg（可选）

**不装也能正常用**，只是下载歌曲时**不会把封面内嵌进音频文件**（列表里照样有封面）。

想要内嵌：

1. 到 <https://www.gyan.dev/ffmpeg/builds/> 下载 `ffmpeg-release-essentials.zip`
2. 解压，把里面的 `bin` 文件夹整个挪到 `C:\ffmpeg\bin`（即 `C:\ffmpeg\bin\ffmpeg.exe` 存在）
3. **重启 local music**，之后下载的歌就自带封面了

程序会自动在这些位置找 ffmpeg：
`PATH` → `C:\ffmpeg\bin\ffmpeg.exe` → `C:\Program Files\ffmpeg\bin\ffmpeg.exe`。

---

## 5. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `python 不是内部或外部命令` | 装 Python 时没勾 Add to PATH | 重装 Python 并勾上；或直接用 `start.bat`（它会自动找 `py -3`） |
| 敲 `python` 弹出应用商店 | Store 的占位程序 | 关掉「应用执行别名」里的 python.exe / python3.exe，从 python.org 重装 |
| 双击 `start.bat` 窗口一闪就没了 | 初始化失败后退出 | 右键 → 以管理员身份运行；或先开 `cmd`，把 `start.bat` 拖进去回车，就能看到报错 |
| 提示端口 `8790` 被占用 | 已经在跑了 / 别的程序占了 | 先看任务栏有没有另一个黑窗口；或设环境变量换端口（见 §6） |
| 页面还是旧界面 | 浏览器缓存 / 老标签页没重新加载 | 浏览器里按 `Ctrl+Shift+R` 强制刷新；不行就重启服务再开 |
| 下载按钮点了没反应 | 网络访问不了 B 站 / 视频需大会员 | 检查网络与代理；需大会员的视频本来就解析不了 |
| 收藏时报「无法解析」 | 视频是付费 / 已删除 / 地区限制 | 换一个视频试试，或改用浏览器插件收藏 |
| 杀毒软件报毒 | PyInstaller 单文件打包的常见误报 | 加白名单；或改用方式 B 源码运行 |
| 控制台里中文显示成乱码 | 老版本 Windows 的控制台编码 | 只是显示问题，不影响功能；可在窗口标题栏右键 → 属性 → 改成 UTF-8 |
| 插件显示「未启动」但服务明明开着 | 端口不是 8790 | 点插件图标 →「服务地址」改成 `http://127.0.0.1:实际端口` |

---

## 6. 端口与环境变量

默认端口 **8790**。想换端口，在**启动前**设置环境变量：

**临时（只对当前窗口有效）**

```bat
set LOCALMUSIC_PORT=8899
.venv\Scripts\python.exe app.py
```

**永久（图形界面）**

`Win+R` → `sysdm.cpl` →「高级」→「环境变量」→ 新建用户变量
`LOCALMUSIC_PORT` = `8899`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOCALMUSIC_PORT` | `8790` | 服务端口 |
| `LOCALMUSIC_DATA_DIR` | 见 §1.4 / §2.5 | 自定义数据目录（数据库 + 音频） |

换了端口后，浏览器插件也要跟着改：「服务地址」填 `http://127.0.0.1:8899`。

---

## 7. 备份 / 迁移 / 卸载

**备份**（曲库 + 歌单 + 下载的歌 + 封面）
- 方式 A：复制 `%APPDATA%\localmusic` 整个文件夹
- 方式 B：复制项目里的 `data\` 和 `music\` 两个文件夹

**迁移到新电脑**
1. 新电脑上按本文档装好 local music
2. 把上面备份的文件夹放回**相同位置**（打包版）/ 覆盖进项目（源码版）
3. 启动即可，曲库、歌单、离线歌曲、封面全在

**卸载**
- 方式 A：删掉 exe，再删 `%APPDATA%\localmusic`（这一步会删掉曲库和下载的歌，想留就别删）
- 方式 B：直接删掉项目文件夹即可（虚拟环境就在项目里的 `.venv\`，随文件夹一起没了；
  曲库和音频在 `data\`、`music\` 里，要留就先拷走）
- 浏览器插件：`chrome://extensions` → 找到该插件 → 「移除」

---

## 8. macOS ↔ Windows 对照速查

| | macOS | Windows |
|---|---|---|
| 启动（源码） | `./start.sh` | 双击 `start.bat` |
| 手动跑 Python | `.venv/bin/python app.py` | `.venv\Scripts\python.exe app.py` |
| 建虚拟环境 | `python3 -m venv .venv` | `py -3 -m venv .venv` |
| 强制刷新页面 | `⌘⇧R` | `Ctrl+Shift+R` |
| 打开数据目录 | `⌘⇧G` 粘贴路径 | 资源管理器地址栏粘贴路径 |
| 打包版数据目录 | `~/Library/Application Support/localmusic` | `%APPDATA%\localmusic` |
| 插件扩展管理页 | `chrome://extensions` | `chrome://extensions`（一样） |
| 终端 | Terminal / iTerm | `Win+R` → `cmd` / PowerShell |
| 打包脚本 | `./build.sh` | `build.bat` |

---

## 9. 自己打包成 exe（可选）

```bat
cd /d D:\my-music
build.bat
```

产物在 `dist\local-music.exe`。也可以直接推一个 `v*` 标签，让 GitHub Actions
自动构建 macOS（arm64 + x64）和 Windows（x64）三份产物并发布到 Releases。
