# -*- coding: utf-8 -*-
"""local music · 半本地音乐播放器后端
收藏 B 站音乐视频、在线流播放、下载离线、歌单管理。

数据目录按平台规范存放：
  - macOS:  ~/Library/Application Support/localmusic
  - Windows: %APPDATA%/localmusic
  - Linux:   ~/.local/share/localmusic
  - 可用环境变量 LOCALMUSIC_DATA_DIR 覆盖
  - 开发模式（源码运行）优先使用项目根目录下的 data/、music/
"""
import os
import re
import sys
import glob as globmod
import sqlite3
import threading
import time
import webbrowser
from pathlib import Path

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask


def _resolve_dirs():
    """决定数据目录与音乐目录。
    开发模式（直接运行源码）→ 项目根目录下的 data/、music/
    打包模式（PyInstaller 冻结）→ 用户家目录下的规范位置
    """
    # 环境变量优先
    env = os.environ.get("LOCALMUSIC_DATA_DIR")
    if env:
        data_dir = Path(env).expanduser().resolve()
        return data_dir, data_dir / "music", True  # is_dev=False

    # PyInstaller 冻结模式
    if getattr(sys, "frozen", False):
        home = Path.home()
        if sys.platform == "darwin":
            base = home / "Library" / "Application Support" / "localmusic"
        elif sys.platform == "win32":
            base = Path(os.environ.get("APPDATA", str(home))) / "localmusic"
        else:  # linux 等
            base = home / ".local" / "share" / "localmusic"
        return base, base / "music", False

    # 开发模式：源码同目录
    here = Path(__file__).resolve().parent
    return here / "data", here / "music", True


DATA, MUSIC, IS_DEV = _resolve_dirs()
COVERS = DATA / "covers"      # 封面缓存目录（与音频分开，避免污染音频查找的 glob）
for _d in (MUSIC, DATA, COVERS):
    if not _d.is_dir():
        _d.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA / "music.db"

# 静态资源目录：打包后从 _MEIPASS 读取，开发时从源码目录读取
if getattr(sys, "frozen", False):
    STATIC = Path(sys._MEIPASS) / "static"
else:
    STATIC = Path(__file__).resolve().parent / "static"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
BASE_HEADERS = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}

app = FastAPI(title="local music")


# ---------------- 数据库 ----------------
def db():
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    return conn


def q(sql, args=(), fetch=False):
    conn = db()
    try:
        cur = conn.execute(sql, args)
        if fetch:
            rows = [dict(r) for r in cur.fetchall()]
            conn.commit()
            return rows
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def init_db():
    conn = db()
    try:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS tracks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bvid TEXT, page INTEGER DEFAULT 1, url TEXT UNIQUE,
            title TEXT, artist TEXT, album TEXT DEFAULT '',
            cover TEXT, duration INTEGER DEFAULT 0,
            local_path TEXT, download_status TEXT DEFAULT 'none',
            download_started REAL DEFAULT 0,
            error_msg TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS playlists(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS playlist_tracks(
            playlist_id INTEGER, track_id INTEGER, position INTEGER,
            PRIMARY KEY(playlist_id, track_id)
        );
        """)
        # 旧库迁移
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(tracks)").fetchall()]
        if "download_started" not in cols:
            conn.execute("ALTER TABLE tracks ADD COLUMN download_started REAL DEFAULT 0")
        if "album" not in cols:
            conn.execute("ALTER TABLE tracks ADD COLUMN album TEXT DEFAULT ''")
        conn.commit()
        conn.execute("INSERT OR IGNORE INTO playlists(id, name) VALUES(1, '我的收藏')")
        # 进程重启后不可能还有下载线程在跑，把遗留的「下载中」标记为可重试，
        # 否则界面会永远卡在「下载中」
        conn.execute("""UPDATE tracks SET download_status='error', download_started=0,
                        error_msg='下载被中断（服务重启），请点击重试'
                        WHERE download_status='downloading'""")
        conn.commit()
    finally:
        conn.close()


init_db()


def get_track(track_id):
    rows = q("SELECT * FROM tracks WHERE id=?", (track_id,), fetch=True)
    return rows[0] if rows else None


# ---------------- yt-dlp ----------------
def base_ydl(extra=None):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "socket_timeout": 20,
        "http_headers": dict(BASE_HEADERS),
    }
    if extra:
        opts.update(extra)
    return opts


BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
P_RE = re.compile(r"[?&]p=(\d+)")


def normalize_url(raw):
    """把用户输入解析成 (视频页URL, 分P号或None)；失败返回 None"""
    raw = (raw or "").strip()
    m = BV_RE.search(raw)
    if m:
        page = None
        pm = P_RE.search(raw)
        if pm:
            page = int(pm.group(1))
        return f"https://www.bilibili.com/video/{m.group(1)}", page
    if "b23.tv" in raw:
        try:
            r = httpx.get(raw, follow_redirects=True, headers=BASE_HEADERS, timeout=15)
            m = BV_RE.search(str(r.url))
            if m:
                page = None
                pm = P_RE.search(str(r.url))
                if pm:
                    page = int(pm.group(1))
                return f"https://www.bilibili.com/video/{m.group(1)}", page
        except Exception:
            return None
    return None


def entry_to_track(e, fallback_bvid):
    url = e.get("webpage_url") or ""
    bvid = fallback_bvid
    m = BV_RE.search(url)
    if m:
        bvid = m.group(1)
    pm = P_RE.search(url)
    page = int(pm.group(1)) if pm else 1
    return {
        "bvid": bvid,
        "page": page,
        "url": url or f"https://www.bilibili.com/video/{bvid}",
        "title": e.get("title") or "未知标题",
        "artist": e.get("uploader") or e.get("channel") or "",
        "cover": e.get("thumbnail") or "",
        "duration": int(e.get("duration") or 0),
    }


class TrackIn(BaseModel):
    url: str


class NameIn(BaseModel):
    name: str


class TrackIdIn(BaseModel):
    track_id: int


class TrackIdsIn(BaseModel):
    track_ids: list


# ---------------- 收藏 ----------------
@app.post("/api/tracks")
def add_tracks(payload: TrackIn):
    parsed = normalize_url(payload.url)
    if not parsed:
        raise HTTPException(400, "无法识别链接，请粘贴 B 站视频链接、BV 号或 b23.tv 短链")
    base_url, page = parsed
    bvid = BV_RE.search(base_url).group(1)
    extra = {"playlist_items": str(page)} if page else None
    try:
        with yt_dlp.YoutubeDL(base_ydl(extra)) as ydl:
            info = ydl.extract_info(base_url, download=False)
    except Exception as e:
        raise HTTPException(400, f"解析失败：{str(e)[:200]}")
    entries = list(info.get("entries") or [info])
    entries = [e for e in entries if e and e.get("webpage_url")]
    if not entries:
        raise HTTPException(400, "未解析到可用的视频")

    # 多P视频：整辑标题存入 album，前端按合集分组展示
    album_title = ""
    if len(entries) > 1:
        album_title = (info.get("title") or "").strip() or (entries[0].get("title") or "")

    added, skipped = [], 0
    for e in entries:
        t = entry_to_track(e, bvid)
        try:
            tid = q(
                """INSERT INTO tracks(bvid, page, url, title, artist, album, cover, duration)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (t["bvid"], t["page"], t["url"], t["title"], t["artist"],
                 album_title, t["cover"], t["duration"]),
            )
            q("""INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position)
                 VALUES(1, ?, (SELECT COALESCE(MAX(position),0)+1 FROM playlist_tracks WHERE playlist_id=1))""",
              (tid,))
            added.append(tid)
        except sqlite3.IntegrityError:
            skipped += 1
    return {"added": added, "skipped": skipped}


@app.get("/api/tracks")
def list_tracks():
    now = time.time()
    rows = q("SELECT * FROM tracks ORDER BY id DESC", fetch=True)
    for r in rows:
        if r.get("local_path") and not os.path.exists(r["local_path"]):
            r["local_path"] = None
            if r["download_status"] == "done":
                r["download_status"] = "none"
        # 看门狗：下载超过 10 分钟视为卡死
        if (r["download_status"] == "downloading"
                and r.get("download_started") and now - r["download_started"] > 600):
            q("UPDATE tracks SET download_status='error', error_msg='下载超时，请重试' WHERE id=?",
              (r["id"],))
            r["download_status"] = "error"
            r["error_msg"] = "下载超时，请重试"
    return rows


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id):
    t = get_track(track_id)
    if not t:
        raise HTTPException(404, "曲目不存在")
    if t["local_path"] and os.path.exists(t["local_path"]):
        try:
            os.remove(t["local_path"])
        except OSError:
            pass
    # 曲目彻底删除时连同本地封面缓存一起清掉，避免留下孤儿文件
    for f in globmod.glob(str(COVERS / f"{cover_stem(t)}.*")):
        try:
            os.remove(f)
        except OSError:
            pass
    with _cover_lock:
        _cover_cache.pop(track_id, None)
    q("DELETE FROM playlist_tracks WHERE track_id=?", (track_id,))
    q("DELETE FROM tracks WHERE id=?", (track_id,))
    return {"ok": True}


# ---------------- 下载 ----------------
def _download_task(track_id):
    t = get_track(track_id)
    if not t:
        return
    try:
        outtmpl = str(MUSIC / f"{t['bvid']}_p{t['page']}.%(ext)s")
        opts = base_ydl({
            "format": "bestaudio/best",
            "outtmpl": outtmpl,
            "noplaylist": True,
            "retries": 3,
        })
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(t["url"], download=True)
        fp = None
        rd = (info or {}).get("requested_downloads") or []
        if rd:
            fp = rd[0].get("filepath")
        if not fp or not os.path.exists(fp):
            cands = globmod.glob(str(MUSIC / f"{t['bvid']}_p{t['page']}.*"))
            fp = max(cands, key=os.path.getmtime) if cands else None
        if not fp:
            raise RuntimeError("下载完成但未找到文件")
        # 先落库，让界面马上显示为可播放
        q("UPDATE tracks SET local_path=?, download_status='done', error_msg='' WHERE id=?",
          (fp, track_id))
        # 再补封面：存到本地缓存目录，并尽量内嵌进音频文件（失败不影响下载结果）
        try:
            cov_path, _, _ = ensure_cover(t)
            if cov_path:
                embed_cover(fp, cov_path)
        except Exception:
            pass
    except Exception as e:
        q("UPDATE tracks SET download_status='error', error_msg=? WHERE id=?",
          (str(e)[:300], track_id))


@app.post("/api/tracks/{track_id}/download")
def download_track(track_id):
    t = get_track(track_id)
    if not t:
        raise HTTPException(404, "曲目不存在")
    if t["local_path"] and os.path.exists(t["local_path"]):
        return {"ok": True, "status": "done"}
    if t["download_status"] == "downloading" and t.get("download_started") \
            and time.time() - t["download_started"] < 600:
        return {"ok": True, "status": "downloading"}
    q("UPDATE tracks SET download_status='downloading', download_started=?, error_msg='' WHERE id=?",
      (time.time(), track_id))
    threading.Thread(target=_download_task, args=(track_id,), daemon=True).start()
    return {"ok": True, "status": "downloading"}


@app.delete("/api/tracks/{track_id}/local")
def remove_local(track_id):
    t = get_track(track_id)
    if not t:
        raise HTTPException(404, "曲目不存在")
    if t["local_path"] and os.path.exists(t["local_path"]):
        try:
            os.remove(t["local_path"])
        except OSError:
            pass
    q("UPDATE tracks SET local_path=NULL, download_status='none' WHERE id=?", (track_id,))
    return {"ok": True}


# ---------------- 流播放 ----------------
_url_cache = {}
_url_lock = threading.Lock()


def resolve_remote(t):
    """解析在线音频直链（带缓存）"""
    key = t["id"]
    with _url_lock:
        cached = _url_cache.get(key)
        if cached and cached["expires"] > time.time():
            return cached["url"], cached["headers"]
    opts = base_ydl({"format": "bestaudio/best"})
    info = yt_dlp.YoutubeDL(opts).extract_info(t["url"], download=False)
    if info is None:
        raise HTTPException(502, "解析音频地址失败")
    url = info.get("url")
    headers = dict(BASE_HEADERS)
    fmt_h = info.get("http_headers") or {}
    headers.update({k: v for k, v in fmt_h.items() if k.lower() in ("user-agent", "referer")})
    if not url:
        fmts = info.get("formats") or []
        auds = [f for f in fmts
                if f.get("acodec") not in (None, "none") and f.get("vcodec") == "none"]
        pick = None
        if auds:
            pick = max(auds, key=lambda f: f.get("abr") or f.get("tbr") or 0)
        if pick:
            url = pick["url"]
            fh = pick.get("http_headers") or {}
            headers.update({k: v for k, v in fh.items() if k.lower() in ("user-agent", "referer")})
    if not url:
        raise HTTPException(502, "未找到可播放的音频流")
    with _url_lock:
        _url_cache[key] = {"url": url, "headers": headers,
                           "expires": time.time() + 25 * 60}
    return url, headers


MIME = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg",
        ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav"}


@app.get("/api/stream/{track_id}")
def stream(track_id, request: Request):
    t = get_track(track_id)
    if not t:
        raise HTTPException(404, "曲目不存在")
    # 本地文件优先
    if t["local_path"] and os.path.exists(t["local_path"]):
        path = t["local_path"]
        size = os.path.getsize(path)
        mime = MIME.get(Path(path).suffix.lower(), "application/octet-stream")
        rng = request.headers.get("range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            start = int(m.group(1) or 0) if m else 0
            end = int(m.group(2) or size - 1) if m else size - 1
            start = max(0, min(start, size - 1))
            end = max(start, min(end, size - 1))

            def gen():
                with open(path, "rb") as f:
                    f.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = f.read(min(256 * 1024, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            return StreamingResponse(gen(), status_code=206, headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(end - start + 1),
                "Content-Type": mime,
            })
        return FileResponse(path, media_type=mime, headers={"Accept-Ranges": "bytes"})
    # 在线代理
    url, headers = resolve_remote(t)
    req_headers = dict(headers)
    rng = request.headers.get("range")
    if rng:
        req_headers["Range"] = rng
    client = httpx.Client(timeout=httpx.Timeout(30, read=60), follow_redirects=True)
    try:
        resp = client.send(client.build_request("GET", url, headers=req_headers), stream=True)
    except Exception:
        client.close()
        raise HTTPException(502, "连接B站音频源失败，请重试")
    passthrough = {k: v for k, v in resp.headers.items()
                   if k.lower() in ("content-length", "content-range", "accept-ranges")}
    ct = resp.headers.get("content-type", "")
    if not ct or "audio" not in ct or "octet-stream" in ct:
        ct = "audio/mp4"
    passthrough["Content-Type"] = ct

    def cleanup():
        try:
            resp.close()
        finally:
            client.close()

    return StreamingResponse(resp.iter_bytes(), status_code=resp.status_code,
                             headers=passthrough, background=BackgroundTask(cleanup))


_cover_cache = {}
_cover_lock = threading.Lock()
_COVER_EXT = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
              "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif"}


def cover_stem(t):
    """封面文件名主干：与曲目一一对应"""
    return f"{t['bvid']}_p{t['page']}"


def local_cover(t):
    """返回已落盘的本地封面路径（没有则 None）"""
    if not t:
        return None
    hits = sorted(globmod.glob(str(COVERS / f"{cover_stem(t)}.*")))
    return hits[0] if hits else None


def fetch_cover(t, max_bytes=12 * 1024 * 1024):
    """抓取封面字节，成功返回 (data, ctype)，失败返回 (None, None)"""
    if not t or not t.get("cover"):
        return None, None
    # B 站图床 http/https 均可，统一升级为 https 更稳
    url = t["cover"]
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    try:
        r = httpx.get(url, headers=BASE_HEADERS, follow_redirects=True, timeout=20)
        r.raise_for_status()
        if not r.content or len(r.content) > max_bytes:
            return None, None
        ctype = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip().lower()
        if not ctype.startswith("image/"):
            ctype = "image/jpeg"
        return r.content, ctype
    except Exception:
        # 退一步：用原始 URL 再试一次（个别情况 http 反而通）
        if url != t["cover"]:
            try:
                r = httpx.get(t["cover"], headers=BASE_HEADERS,
                              follow_redirects=True, timeout=20)
                r.raise_for_status()
                if r.content and len(r.content) <= max_bytes:
                    ctype = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip().lower()
                    if not ctype.startswith("image/"):
                        ctype = "image/jpeg"
                    return r.content, ctype
            except Exception:
                pass
        return None, None


def save_cover(t, data, ctype):
    """把封面写入本地缓存目录，返回文件路径"""
    ext = _COVER_EXT.get(ctype, ".jpg")
    path = COVERS / f"{cover_stem(t)}{ext}"
    tmp = COVERS / f".{cover_stem(t)}{ext}.tmp"
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except OSError:
        return None
    return str(path)


def ensure_cover(t):
    """确保封面已落盘：本地有直接用，没有就抓取并保存。返回 (路径, 字节, ctype)"""
    path = local_cover(t)
    if path and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            return path, f.read(), None
    data, ctype = fetch_cover(t)
    if not data:
        return None, None, None
    path = save_cover(t, data, ctype)
    return path, data, ctype


def _find_ffmpeg():
    """查找 ffmpeg。打包版从 Finder/资源管理器启动时 PATH 很精简，
    所以额外探测常见的安装位置。"""
    import shutil
    p = shutil.which("ffmpeg")
    if p:
        return p
    cands = [
        "/opt/homebrew/bin/ffmpeg",          # macOS Apple Silicon
        "/usr/local/bin/ffmpeg",             # macOS Intel
        "/usr/bin/ffmpeg",                   # Linux
        str(Path.home() / "bin" / "ffmpeg"),
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
    ]
    for c in cands:
        if os.path.exists(c) and os.access(c, os.X_OK):
            return c
    return None


def embed_cover(audio_path, cover_path):
    """把封面内嵌进 m4a/mp3 文件（有 ffmpeg 才做，失败不影响音频）。

    先写到临时文件、校验通过后再原子替换，避免损坏已下载的音频。
    """
    import subprocess
    ffmpeg = _find_ffmpeg()
    if not ffmpeg or not audio_path or not cover_path:
        return False
    if not (os.path.exists(audio_path) and os.path.exists(cover_path)):
        return False
    ext = os.path.splitext(audio_path)[1].lower()
    if ext not in (".m4a", ".mp4", ".mp3", ".flac", ".ogg", ".opus"):
        return False
    tmp = str(audio_path) + ".tmp" + ext
    try:
        proc = subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(audio_path), "-i", str(cover_path),
             "-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic",
             "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)", tmp],
            capture_output=True, timeout=120,
        )
        if proc.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) < 1024:
            return False
        # 校验：能读出音频流时长，且内嵌图存在
        chk = subprocess.run([ffmpeg, "-hide_banner", "-i", tmp], capture_output=True, timeout=60)
        info = (chk.stderr or b"").decode("utf-8", "ignore")
        if "Duration:" not in info or "Video:" not in info or "Audio:" not in info:
            return False
        os.replace(tmp, audio_path)
        return True
    except Exception:
        return False
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


@app.get("/api/cover/{track_id}")
def cover(track_id):
    t = get_track(track_id)
    if not t or not t["cover"]:
        raise HTTPException(404, "no cover")
    # 1) 内存缓存
    with _cover_lock:
        if track_id in _cover_cache:
            data, ctype = _cover_cache[track_id]
            return Response(content=data, media_type=ctype,
                            headers={"Cache-Control": "max-age=86400"})
    # 2) 本地已落盘的封面（离线可用）
    path = local_cover(t)
    if path:
        ext = os.path.splitext(path)[1].lower()
        ctype = {".png": "image/png", ".webp": "image/webp",
                 ".gif": "image/gif", ".avif": "image/avif"}.get(ext, "image/jpeg")
        return FileResponse(path, media_type=ctype,
                            headers={"Cache-Control": "max-age=86400"})
    # 3) 抓取并落盘（下次离线也能用）
    data, ctype = fetch_cover(t)
    if not data:
        raise HTTPException(404, "cover fetch failed")
    save_cover(t, data, ctype)
    with _cover_lock:
        _cover_cache[track_id] = (data, ctype)
    return Response(content=data, media_type=ctype,
                    headers={"Cache-Control": "max-age=86400"})


@app.post("/api/tracks/{track_id}/cover")
def refresh_cover(track_id, embed: bool = True):
    """补齐封面：落盘缓存，并（可选）内嵌进已下载的音频文件"""
    t = get_track(track_id)
    if not t:
        raise HTTPException(404, "曲目不存在")
    if not t["cover"]:
        raise HTTPException(400, "该曲目没有封面信息")
    path, data, ctype = ensure_cover(t)
    if not path:
        raise HTTPException(502, "封面获取失败，请检查网络后重试")
    with _cover_lock:
        _cover_cache[track_id] = (data, ctype or "image/jpeg")
    embedded = False
    if embed and t["local_path"] and os.path.exists(t["local_path"]):
        embedded = embed_cover(t["local_path"], path)
    return {"ok": True, "cover": path, "embedded": embedded}


@app.get("/api/covers/summary")
def covers_summary():
    """封面补齐情况，用于界面提示"""
    rows = q("SELECT id, bvid, page, cover, local_path FROM tracks WHERE cover IS NOT NULL AND cover <> ''",
             fetch=True)
    on_disk = missing = 0
    for r in rows:
        if local_cover(r):
            on_disk += 1
        else:
            missing += 1
    return {"total": len(rows), "on_disk": on_disk, "missing": missing}


# ---------------- 播放列表 ----------------
@app.get("/api/playlists")
def list_playlists():
    rows = q("""SELECT p.id, p.name,
                       (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS count
                FROM playlists p ORDER BY p.id""", fetch=True)
    return rows


@app.post("/api/playlists")
def create_playlist(payload: NameIn):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "名称不能为空")
    try:
        pid = q("INSERT INTO playlists(name) VALUES(?)", (name,))
    except sqlite3.IntegrityError:
        raise HTTPException(400, "已存在同名歌单")
    return {"id": pid, "name": name, "count": 0}


@app.patch("/api/playlists/{pid}")
def rename_playlist(pid, payload: NameIn):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "名称不能为空")
    if not q("SELECT 1 FROM playlists WHERE id=?", (pid,), fetch=True):
        raise HTTPException(404, "歌单不存在")
    try:
        q("UPDATE playlists SET name=? WHERE id=?", (name, pid))
    except sqlite3.IntegrityError:
        raise HTTPException(400, "已存在同名歌单")
    return {"ok": True, "id": pid, "name": name}


@app.delete("/api/playlists/{pid}")
def delete_playlist(pid):
    if pid == 1:
        raise HTTPException(400, "默认歌单不能删除")
    if not q("SELECT 1 FROM playlists WHERE id=?", (pid,), fetch=True):
        raise HTTPException(404, "歌单不存在")
    q("DELETE FROM playlist_tracks WHERE playlist_id=?", (pid,))
    q("DELETE FROM playlists WHERE id=?", (pid,))
    return {"ok": True}


@app.get("/api/playlists/{pid}/tracks")
def playlist_tracks(pid):
    rows = q("""SELECT t.* FROM playlist_tracks pt
                JOIN tracks t ON t.id = pt.track_id
                WHERE pt.playlist_id=? ORDER BY pt.position""", (pid,), fetch=True)
    return rows


@app.post("/api/playlists/{pid}/tracks")
def add_to_playlist(pid, payload: TrackIdIn):
    if not q("SELECT 1 FROM playlists WHERE id=?", (pid,), fetch=True):
        raise HTTPException(404, "歌单不存在")
    if not get_track(payload.track_id):
        raise HTTPException(404, "曲目不存在")
    q("""INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position)
         VALUES(?,?, (SELECT COALESCE(MAX(position),0)+1 FROM playlist_tracks WHERE playlist_id=?))""",
      (pid, payload.track_id, pid))
    return {"ok": True}


@app.post("/api/playlists/{pid}/tracks/batch")
def add_batch_to_playlist(pid, payload: TrackIdsIn):
    if not q("SELECT 1 FROM playlists WHERE id=?", (pid,), fetch=True):
        raise HTTPException(404, "歌单不存在")
    ids = [i for i in payload.track_ids if isinstance(i, int)]
    if not ids:
        raise HTTPException(400, "没有选择任何曲目")
    for tid in ids:
        if not get_track(tid):
            raise HTTPException(404, f"曲目 {tid} 不存在")
    for tid in ids:
        q("""INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position)
             VALUES(?,?, (SELECT COALESCE(MAX(position),0)+1 FROM playlist_tracks WHERE playlist_id=?))""",
          (pid, tid, pid))
    return {"ok": True, "added": len(ids)}


@app.delete("/api/playlists/{pid}/tracks/{track_id}")
def remove_from_playlist(pid, track_id):
    q("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?", (pid, track_id))
    return {"ok": True}


app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")


def _port_in_use(host, port):
    """检测端口是否已被占用（即已有一个实例在运行）"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def main():
    """入口：启动服务并自动打开浏览器。
    支持环境变量 LOCALMUSIC_PORT 覆盖端口（默认 8790）。
    """
    import uvicorn
    port = int(os.environ.get("LOCALMUSIC_PORT", "8790"))
    host = "127.0.0.1"
    url = f"http://{host}:{port}"

    # 已有实例在运行 → 直接打开浏览器，不重复启动
    if _port_in_use(host, port):
        print(f"检测到 local music 已在运行，正在打开 {url}")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        return

    # 延迟打开浏览器，等服务起来
    def _open():
        time.sleep(1.5)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()
    print(f"local music 启动中: {url}")
    print(f"数据目录: {DATA}")
    try:
        uvicorn.run(app, host=host, port=port, log_level="warning")
    except KeyboardInterrupt:
        print("\n已退出 local music")


if __name__ == "__main__":
    main()
