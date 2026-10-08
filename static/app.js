/* local music · 前端播放器逻辑 */
const $ = (s) => document.querySelector(s);
const audio = $("#audio");

const MODES = [
  { key: "list-loop", label: "列表循环", icon: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" },
  { key: "single", label: "单曲循环", icon: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2.5V13h1.5l-2.7-2.7L8.6 13h1.5v1.5z" },
  { key: "sequential", label: "顺序播放", icon: "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" },
  { key: "shuffle", label: "随机播放", icon: "M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" },
];

const state = {
  tracks: [],
  playlists: [],
  view: { type: "all" },          // "all" | "downloaded" | "pl"（播放队列改由底部面板承载）
  viewTracks: [],
  queue: [],                       // 当前播放列表（内存中的实际队列）
  current: null,
  mode: localStorage.getItem("lm-mode") || "list-loop",
  search: "",
  retryCount: 0,
  selected: new Set(),
  collapsed: new Set(JSON.parse(localStorage.getItem("lm-collapsed") || "[]")),
  allFlat: localStorage.getItem("lm-all-flat") === "1",   // 「全部音乐」用扁平列表而非按合集分组
  suppressClick: false,            // 拖拽刚结束，屏蔽紧随其后的 click
  plOrder: null,                   // { pid, ids } 歌单拖拽后的本地顺序覆盖（避免乐观更新被回拉）
};

/* ---------------- 工具 ---------------- */
function fmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("#toast-wrap").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
async function api(path, opts = {}) {
  if (opts.body) {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = `请求失败 (${r.status})`;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}
function modeIdx() { return MODES.findIndex((m) => m.key === state.mode); }
function persistCollapsed() {
  localStorage.setItem("lm-collapsed", JSON.stringify([...state.collapsed]));
}

/* ==================== 播放状态持久化 ==================== */
function savePlaybackState() {
  const s = {
    trackId: state.current ? state.current.id : null,
    position: audio.currentTime,
    queue: [...state.queue],
    mode: state.mode,
    paused: audio.paused,
    ts: Date.now(),
  };
  localStorage.setItem("lm-playback", JSON.stringify(s));
}
function loadPlaybackState() {
  try {
    const raw = localStorage.getItem("lm-playback");
    if (!raw) return null;
    const s = JSON.parse(raw);
    // 超过 24 小时的状态不恢复
    if (Date.now() - s.ts > 24 * 3600000) return null;
    return s;
  } catch (e) { return null; }
}
// 定期保存进度
let saveTimer = setInterval(savePlaybackState, 5000);

function commonPrefix(strs) {
  if (!strs.length) return "";
  let p = strs[0];
  for (const s of strs) { while (!s.startsWith(p)) p = p.slice(0, -1); }
  return p.trim();
}

/* ---------------- 数据 ---------------- */
async function loadTracks() { state.tracks = await api("/api/tracks"); }
async function loadPlaylists() { state.playlists = await api("/api/playlists"); }

async function refresh() {
  await Promise.all([loadTracks(), loadPlaylists()]);
  renderSidebar();
  renderList();
  ensurePolling();
}

/* 浏览器插件在服务离线期间攒下的收藏：后端启动时已自动导入，
   这里再兜一次（幂等），顺便把结果告诉用户 */
async function syncExtensionInbox() {
  try {
    const r = await api("/api/inbox/sync", { method: "POST" });
    if (r && r.added > 0) {
      toast(`已从浏览器插件同步 ${r.added} 首收藏`, "ok");
      return true;
    }
  } catch (e) { /* 老版本后端没有这个接口，忽略 */ }
  return false;
}

/* ---------------- 下载状态轮询 ---------------- */
let pollTimer = null;
function ensurePolling() {
  const busy = state.tracks.some((t) => t.download_status === "downloading");
  if (busy && !pollTimer) {
    pollTimer = setInterval(async () => {
      try {
        await loadTracks();
        await renderList();
        if (!state.tracks.some((t) => t.download_status === "downloading")) stopPolling();
      } catch (e) { stopPolling(); }
    }, 2000);
  } else if (!busy && pollTimer) {
    stopPolling();
  }
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  loadTracks().then(() => renderList());
}

/* ---------------- 合集分组 ---------------- */
function buildGroups(tracks) {
  const byBvid = new Map();
  const order = [];
  for (const t of tracks) {
    if (!byBvid.has(t.bvid)) { byBvid.set(t.bvid, []); order.push(t.bvid); }
    byBvid.get(t.bvid).push(t);
  }
  return order.map((bvid) => {
    const list = byBvid.get(bvid);
    const sorted = [...list].sort((a, b) => (a.page || 1) - (b.page || 1));
    const total = Math.max(sorted[0].coll_total || 0, 0);
    // 判定为合集：同一个 bvid 收了不止一 P，或者它所属视频本来就有多 P。
    // 后者对应「只收藏了其中某一集」，也要能看出它属于一个系列。
    if (sorted.length <= 1 && total <= 1) return { collection: false, tracks: sorted };
    let title = sorted[0].album || "";
    if (!title) {
      const p = commonPrefix(sorted.map((t) => t.title || ""));
      title = p.length >= 6 ? p : sorted[0].title;
    }
    return { collection: true, bvid, title, total, tracks: sorted };
  });
}

/* ---------------- 渲染侧边栏 ---------------- */
function renderSidebar() {
  const nav = $("#sidebar-nav");
  // 保留前两个固定项（全部音乐、播放列表），只更新歌单区域
  const fixed = nav.querySelectorAll("[data-view]");
  let html = "";
  fixed.forEach((el) => html += el.outerHTML);
  html += `<div class="nav-sep">
             <span>歌单</span>
             <button id="btn-new-playlist" class="nav-add" title="新建歌单" aria-label="新建歌单">
               <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
             </button>
           </div>`;
  html += state.playlists.map((p) => `
    <div class="nav-item ${state.view.type === "pl" && state.view.id === p.id ? "active" : ""}"
         data-pl="${p.id}" title="${escapeHtml(p.name)}">
      <svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h-2zM3 16h8v-2H3v2zm14-8v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V10h3V8h-5z"/></svg>
      <span class="pl-name">${escapeHtml(p.name)}</span>
      <span class="pl-count">${p.count}</span>
    </div>`).join("");
  nav.innerHTML = html;
  // 「已下载音乐」后面的曲目数
  const dlCount = nav.querySelector('[data-view="downloaded"] .pl-count');
  if (dlCount) dlCount.textContent = downloadedTracks().length;

  // 绑定事件
  nav.querySelectorAll("[data-view]").forEach((el) => {
    el.addEventListener("click", () => {
      state.view = { type: el.dataset.view };
      state.plOrder = null;
      renderSidebar(); renderList();
    });
  });
  // 「歌单」标题右侧的 + 按钮（每次渲染都是新节点，需重新绑定）
  nav.querySelector("#btn-new-playlist")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal({ type: "create" });
  });
  nav.querySelectorAll("[data-pl]").forEach((el) => {
    el.addEventListener("click", async () => {
      state.view = { type: "pl", id: Number(el.dataset.pl) };
      state.plOrder = null;
      renderSidebar(); renderList();
    });
    // 右键菜单：播放 / 加入播放列表 / 重命名 / 删除
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPlCtxMenu(e.clientX, e.clientY, Number(el.dataset.pl));
    });
  });
}

/** 已下载到本地、可直接离线播放的曲目 */
function isDownloaded(t) {
  return t.download_status === "done" && !!t.local_path;
}
function downloadedTracks() {
  return state.tracks.filter(isDownloaded);
}

async function currentViewTracks() {
  if (state.view.type === "all") return state.tracks;
  if (state.view.type === "downloaded") return downloadedTracks();
  const pl = state.playlists.find((p) => p.id === state.view.id);
  if (!pl) return [];
  const list = await api(`/api/playlists/${state.view.id}/tracks`);
  // 刚拖拽过：用本地顺序渲染，避免请求回来又把界面拉回旧顺序
  const ov = state.plOrder;
  if (ov && ov.pid === state.view.id) {
    const ids = list.map((t) => t.id);
    if (ids.length === ov.ids.length && ov.ids.every((i) => ids.includes(i))) {
      const map = new Map(list.map((t) => [t.id, t]));
      return ov.ids.map((i) => map.get(i)).filter(Boolean);
    }
  }
  state.plOrder = null;
  return list;
}

/** 将 queue 里的 id 映射回完整 track 对象 */
function getQueueTracks() {
  return state.queue
    .map((id) => state.tracks.find((t) => t.id === id))
    .filter(Boolean);
}

let renderSeq = 0;
async function renderList() {
  const seq = ++renderSeq;
  let tracks = await currentViewTracks();
  if (seq !== renderSeq) return;
  if (state.search) {
    const kw = state.search.toLowerCase();
    tracks = tracks.filter((t) =>
      (t.title || "").toLowerCase().includes(kw) || (t.artist || "").toLowerCase().includes(kw));
  }
  state.viewTracks = tracks;

  const pl = state.view.type === "pl" ? state.playlists.find((p) => p.id === state.view.id) : null;
  const TITLES = { all: "全部音乐", downloaded: "已下载音乐" };
  $("#view-title").textContent = state.view.type === "pl" ? (pl ? pl.name : "") : (TITLES[state.view.type] || "");
  $("#btn-play-all").textContent = "▶ 播放全部";
  // 歌单视图、或「全部音乐」的列表视图，且未在搜索、且不止一首时，才允许拖动排序
  const reorderable = canReorder() && tracks.length > 1;
  $("#view-count").textContent = reorderable
    ? `共 ${tracks.length} 首 · 按住拖动可调整顺序`
    : `共 ${tracks.length} 首`;

  // 分组 / 列表 切换按钮只在「全部音乐」视图出现；图标与文字都反映「当前」模式
  const vt = $("#btn-all-view");
  vt.hidden = state.view.type !== "all";
  $("#all-view-label").textContent = state.allFlat ? "列表" : "分组";
  $("#all-view-icon").innerHTML = state.allFlat
    ? '<path d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h18v2H3v-2z"/>'                              // ☰ 列表
    : '<path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>';           // ⊞ 分组
  vt.title = state.allFlat
    ? "当前：扁平列表，可按住拖动排序 · 点击切回按合集分组"
    : "当前：按合集分组 · 点击切到扁平列表（可拖动排序）";

  // 空列表提示：按视图给不同文案
  $("#empty-tip").hidden = tracks.length > 0;
  if (tracks.length === 0) {
    if (state.view.type === "downloaded") {
      $("#empty-tip .empty-icon").textContent = "⬇️";
      $("#empty-tip p:first-of-type").textContent = "还没有已下载的音乐";
      $("#empty-tip .sub").textContent = "在「全部音乐」里点歌曲右侧的下载按钮，把音乐存到本地";
    } else if (state.view.type === "pl") {
      $("#empty-tip .empty-icon").textContent = "📃";
      $("#empty-tip p:first-of-type").textContent = "这个歌单还是空的";
      $("#empty-tip .sub").textContent = "从「全部音乐」里把歌曲加进来";
    } else {
      $("#empty-tip .empty-icon").textContent = "🎵";
      $("#empty-tip p:first-of-type").textContent = "还没有收藏音乐";
      $("#empty-tip .sub").textContent = "把 B 站视频链接粘贴到上方，点「收藏」试试";
    }
  }

  let html = "";
  if (state.view.type === "pl") {
    // 歌单视图：扁平列表，支持拖动排序
    html = tracks.map((t, i) => rowHtml(t, false, reorderable ? i : null)).join("");
  } else if (state.view.type === "all") {
    if (state.allFlat) {
      // 扁平列表：一行一首，可拖动排序（顺序写回曲库 lib_order）
      html = tracks.map((t, i) => rowHtml(t, false, reorderable ? i : null)).join("");
    } else {
      html = buildGroups(tracks).map((g) => {
        if (!g.collection) return rowHtml(g.tracks[0]);
        const open = !state.collapsed.has(g.bvid);
        return collectionHtml(g) + (open
          ? `<div class="coll-body">${g.tracks.map((t) => rowHtml(t, true)).join("")}</div>`
          : "");
      }).join("");
    }
  } else {
    // 已下载音乐等：扁平列表
    html = tracks.map((t) => rowHtml(t)).join("");
  }

  const list = $("#track-list");
  list.dataset.ctx = state.view.type;
  list.innerHTML = html;
  list.querySelectorAll(".track-row").forEach((row) => bindRow(row, Number(row.dataset.id)));
  list.querySelectorAll(".coll-header").forEach((h) => bindCollHeader(h));
  if (reorderable) bindRowDrag(list);
  updateSelBar();
  renderQueuePanel();   // 面板开着时同步高亮 / 计数
}

/* ---------------- 播放列表面板（网易云风格：从底部播放条上方弹出） ---------------- */
function queuePanelOpen() { return !$("#queue-panel").hidden; }

/** 渲染面板内容。面板关着时只同步计数，不做无用功 */
function renderQueuePanel() {
  updateQueueNavCount();
  if (!queuePanelOpen()) return;
  const items = getQueueTracks();
  const list = $("#queue-panel-list");
  const reorderable = items.length > 1;
  list.dataset.ctx = "queue";
  list.innerHTML = items.map((t, i) => rowHtml(t, false, reorderable ? i : null, "queue")).join("");
  list.querySelectorAll(".track-row").forEach((row) => bindRow(row, Number(row.dataset.id)));
  if (reorderable) bindRowDrag(list);
  list.hidden = items.length === 0;
  $("#qp-empty").hidden = items.length > 0;
}

function openQueuePanel() {
  $("#queue-panel").hidden = false;
  $("#btn-queue").classList.add("open");
  renderQueuePanel();
}
function closeQueuePanel() {
  $("#queue-panel").hidden = true;
  $("#btn-queue").classList.remove("open");
}
function toggleQueuePanel() {
  if (queuePanelOpen()) closeQueuePanel(); else openQueuePanel();
}

/* ---------------- 拖动排序（播放列表面板 + 歌单） ---------------- */
let dragId = null;
let dragList = null;   // 本次拖拽所属的列表容器（主列表 或 播放列表面板）

/** 主列表是否允许拖动排序：搜索状态下顺序是筛选结果，不允许拖。
 *  歌单始终可拖；「全部音乐」切到扁平列表时也可拖（顺序写回曲库）。
 *  底部的播放列表面板走自己的容器，不经过这里。 */
function canReorder() {
  if (state.search) return false;
  if (state.view.type === "pl") return true;
  return state.view.type === "all" && state.allFlat;
}

/** 按下标算出把 moveId 插到 targetId 前/后的新顺序 */
function movedOrder(ids, moveId, targetId, after) {
  if (moveId === targetId) return null;
  const from = ids.indexOf(moveId);
  if (from < 0 || ids.indexOf(targetId) < 0) return null;
  const out = [...ids];
  out.splice(from, 1);
  const to = out.indexOf(targetId);
  out.splice(after ? to + 1 : to, 0, moveId);
  return out;
}

let dropRow = null, dropAfter = null;

function clearDropMarks() {
  dropRow = null; dropAfter = null;
  document.querySelectorAll(".track-list .drop-before, .track-list .drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  document.querySelectorAll(".track-list.drop-active")
    .forEach((el) => el.classList.remove("drop-active"));
}

/** 只在落点变化时才动 class。
 *  拖拽过程中频繁增删 class 会让浏览器重算光标下的命中目标，触发 dragenter/dragleave
 *  抖动；而 dragover 是节流的，抖动后可能来不及补发新的 dragover，导致 drop 被丢弃。 */
function markDrop(row, after, list) {
  if (dropRow === row && dropAfter === after) return;
  clearDropMarks();
  dropRow = row; dropAfter = after; dragList = list;
  row.classList.add(after ? "drop-after" : "drop-before");
  list.classList.add("drop-active");
}

/** 按指针 Y 坐标判断应插到哪一行的之前/之后 */
function pickDropTarget(rows, y) {
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { row, after: false };
  }
  return rows.length ? { row: rows[rows.length - 1], after: true } : null;
}

/** 播放列表：把 moveId 移到 targetId 之前/之后。按 id 定位，不依赖渲染下标 */
function reorderQueue(moveId, targetId, after) {
  const out = movedOrder(state.queue, moveId, targetId, after);
  if (!out) return false;
  state.queue = out;
  savePlaybackState();
  updateQueueNavCount();
  renderQueuePanel();
  return true;
}

/** 歌单：同上，但顺序要写回后端 */
async function reorderPlaylist(moveId, targetId, after) {
  const cur = state.viewTracks.map((t) => t.id);
  const ids = movedOrder(cur, moveId, targetId, after);
  if (!ids) return false;
  const pid = state.view.id;
  // 乐观更新：先按新顺序渲染，界面立刻响应
  const map = new Map(state.viewTracks.map((t) => [t.id, t]));
  state.viewTracks = ids.map((i) => map.get(i));
  state.plOrder = { pid, ids };
  await renderList();
  try {
    await api(`/api/playlists/${pid}/reorder`, { method: "POST", body: { track_ids: ids } });
  } catch (err) {
    state.plOrder = null;           // 失败则放弃本地顺序，回落到服务端
    toast(err.message, "err");
    await renderList();
    return false;
  }
  return true;
}

/** 「全部音乐」列表视图：调整曲库顺序，写回后端 lib_order */
async function reorderLibrary(moveId, targetId, after) {
  const ids = movedOrder(state.tracks.map((t) => t.id), moveId, targetId, after);
  if (!ids) return false;
  const map = new Map(state.tracks.map((t) => [t.id, t]));
  // 乐观更新：先按新顺序渲染，界面立刻响应
  state.tracks = ids.map((i) => map.get(i)).filter(Boolean);
  await renderList();
  try {
    await api("/api/tracks/reorder", { method: "POST", body: { track_ids: ids } });
  } catch (err) {
    toast(err.message, "err");
    await loadTracks();          // 失败则回落到服务端顺序
    await renderList();
    return false;
  }
  return true;
}

/** 按上下文分发：播放列表面板改内存队列，歌单 / 曲库写数据库 */
function applyReorder(moveId, targetId, after, ctx) {
  if (ctx === "pl") return reorderPlaylist(moveId, targetId, after);
  if (ctx === "all") return reorderLibrary(moveId, targetId, after);
  return Promise.resolve(reorderQueue(moveId, targetId, after));
}

/** 容器级监听只绑定一次：renderList 每次都会替换行节点，
 *  若把监听绑在容器上又每次渲染都绑，会重复累积。
 *  主列表与播放列表面板是两个容器，各自绑一套。 */
function attachDragContainer(el) {
  if (!el) return;
  el.addEventListener("dragover", (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const t = pickDropTarget([...el.querySelectorAll(".track-row")], e.clientY);
    if (t) markDrop(t.row, t.after, el);
    else clearDropMarks();
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) clearDropMarks();
  });
  el.addEventListener("drop", async (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const t = pickDropTarget([...el.querySelectorAll(".track-row")], e.clientY);
    const ctx = el.dataset.ctx || state.view.type;
    clearDropMarks();
    if (!t) return;
    const targetId = Number(t.row.dataset.id);
    try {
      if (await applyReorder(dragId, targetId, t.after, ctx)) {
        toast(ctx === "pl" ? "已调整歌单顺序"
              : ctx === "all" ? "已调整曲库顺序" : "已调整播放顺序", "ok");
      }
    } catch (err) { toast(err.message, "err"); }
  });
}
attachDragContainer($("#track-list"));
attachDragContainer($("#queue-panel-list"));

/** 每次渲染后给行节点绑定拖动事件（行节点是新建的，不会累积） */
function bindRowDrag(list) {
  list.querySelectorAll(".track-row").forEach((row) => {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      dragId = Number(row.dataset.id);
      dragList = list;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(dragId)); } catch (_) {}
      row.classList.add("dragging");
      document.body.classList.add("queue-dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      document.body.classList.remove("queue-dragging");
      clearDropMarks();
      dragId = null;
      dragList = null;
      // 拖拽结束后部分浏览器会补发一次 click，屏蔽掉以免误触发播放
      state.suppressClick = true;
      setTimeout(() => { state.suppressClick = false; }, 150);
    });
  });
}

function statusBadge(t) {
  if (t.download_status === "downloading") return `<span class="badge loading">下载中</span>`;
  if (t.download_status === "error")
    return `<span class="badge error" data-act="retry" title="${escapeHtml(t.error_msg || "下载失败")}，点击重试">失败·重试</span>`;
  if (t.download_status === "done" && t.local_path) return `<span class="badge local">已下载</span>`;
  return `<span class="badge online">在线</span>`;
}

/* ---------------- 封面加载（失败自动重试，避免网络抖动导致封面永久消失） ---------------- */
function coverTag(id, { lazy = false, cls = "" } = {}) {
  return `<img src="/api/cover/${id}"${cls ? ` class="${cls}"` : ""}`
    + `${lazy ? ' loading="lazy"' : ""} alt="" draggable="false"`
    + ` data-cover="${id}" onerror="window.__coverRetry(this)">`;
}

// 最多重试 3 次（递减退避），仍失败则优雅降级为占位图
window.__coverRetry = function (img) {
  const id = img.dataset.cover;
  const n = (Number(img.dataset.retry) || 0) + 1;
  img.dataset.retry = n;
  if (n > 3) {
    const ph = document.createElement("div");
    ph.className = "cover-fallback";
    ph.textContent = "🎵";
    img.replaceWith(ph);
    return;
  }
  setTimeout(() => {
    img.src = `/api/cover/${id}?r=${n}&t=${Date.now()}`;
  }, 350 * n);
};

/** @param {number?} queueIndex 播放列表视图中的序号
 *  @param {string} ctx 渲染上下文 "all" | "downloaded" | "pl" | "queue"
 *         主列表用自己的视图类型；底部弹出的播放列表面板统一传 "queue" */
function rowHtml(t, asChild = false, queueIndex = null, ctx = state.view.type) {
  const isPlaying = state.current && state.current.id === t.id;
  const inPlaylist = ctx === "pl";
  const inQueue = ctx === "queue";
  // 播放列表 / 歌单视图下这个按钮只是「从当前列表移除」，不是删歌：
  // 用 × 图标并把动作写清楚，避免被当成删除整首歌（队列视图原先误用了垃圾桶图标 + "删除"）
  const removeOnly = inPlaylist || inQueue;
  const removeTitle = inPlaylist ? "从此歌单移除" : inQueue ? "从播放列表移除" : "删除";
  const sel = state.selected.has(t.id);
  const cover = t.cover ? coverTag(t.id, { lazy: true }) : "";
  const draggable = queueIndex != null;   // 播放列表 / 歌单视图支持拖动排序
  const idxBadge = draggable
    ? `<div class="queue-idx" title="按住拖动调整顺序">
         <span class="qi-num">${queueIndex + 1}</span>
         <svg class="qi-grip" viewBox="0 0 24 24"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
       </div>`
    : "";
  return `
  <div class="track-row ${isPlaying ? "playing" : ""} ${asChild ? "coll-child" : ""}"
       data-id="${t.id}" data-ctx="${ctx}"${draggable ? ' draggable="true"' : ""}>
    <div class="row-check ${sel ? "on" : ""}" data-check="${t.id}"></div>
    <div class="c-cover">${cover}${isPlaying ? '<div class="eq"><i></i><i></i><i></i></div>' : ""}${idxBadge}</div>
    <div class="c-title-wrap">
      <div class="c-title">${escapeHtml(t.title)}</div>
      <div class="c-artist">${escapeHtml(t.artist)}</div>
    </div>
    <div class="c-dur">${fmt(t.duration)}</div>
    <div class="c-status">${statusBadge(t)}</div>
    <div class="c-act">
      ${t.download_status === "done" && t.local_path
        ? ""
        : `<button class="act-btn" data-act="download" ${t.download_status === "downloading" ? "disabled" : ""} title="下载到本地"><svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>`}
      <button class="act-btn" data-act="addpl" title="加入歌单"><svg viewBox="0 0 24 24"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm13-1v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z"/></svg></button>
      <button class="act-btn share" data-act="share" title="复制分享链接"><svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg></button>
      <button class="act-btn danger" data-act="delete" title="${removeTitle}">
        ${removeOnly
          ? `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`
          : `<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`}
      </button>
    </div>
  </div>`;
}

function collectionHtml(g) {
  const open = !state.collapsed.has(g.bvid);
  const allSel = g.tracks.every((t) => state.selected.has(t.id));
  const someSel = g.tracks.some((t) => state.selected.has(t.id));
  const cover = g.tracks[0].cover ? coverTag(g.tracks[0].id) : "🎼";
  const doneCnt = g.tracks.filter((t) => t.download_status === "done").length;
  const total = g.total || 0;
  const missing = total - g.tracks.length;
  const label = total > 1
    ? (missing > 0 ? `合集 · 已收 ${g.tracks.length} / 共 ${total} P` : `合集 · ${total} P`)
    : `合集 · ${g.tracks.length} 首`;
  return `
  <div class="coll-header" data-bvid="${g.bvid}">
    <div class="row-check ${allSel ? "on" : someSel ? "half" : ""}" data-checkgroup="${g.bvid}"></div>
    <svg class="coll-arrow ${open ? "open" : ""}" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6z"/></svg>
    <div class="coll-cover">${cover}</div>
    <div class="coll-title-wrap">
      <div class="coll-title">${escapeHtml(g.title)}</div>
      <div class="coll-sub">${label}${doneCnt ? ` · 已下载 <b>${doneCnt}</b>` : ""}</div>
    </div>
    <div class="coll-act">
      <button class="act-btn" data-coll="play" title="播放整个合集"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="act-btn" data-coll="download" title="下载整个合集"><svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
      <button class="act-btn" data-coll="addpl" title="合集加入歌单"><svg viewBox="0 0 24 24"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm13-1v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z"/></svg></button>
      <button class="act-btn share" data-coll="share" title="复制合集链接"><svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg></button>
      ${missing > 0
        ? `<button class="act-btn" data-coll="rest" title="收藏整个合集（还差 ${missing} P）"><svg viewBox="0 0 24 24"><path d="M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-1 9h-3v3h-2v-3h-3V9h3V6h2v3h3v2z"/></svg></button>`
        : ""}
    </div>
  </div>`;
}

/* ---------------- 行 / 合集事件 ---------------- */
/** 行的上下文：面板里的行标了 data-ctx="queue"，主列表用自己的视图类型。
 *  行内按钮的「删除」语义（真删 / 从歌单移除 / 从播放列表移除）全靠它区分 */
function rowCtx(row) {
  return row.dataset.ctx || state.view.type;
}

function bindRow(row, id) {
  const ctx = rowCtx(row);
  row.addEventListener("click", async (e) => {
    if (state.suppressClick) return;   // 刚拖拽完，忽略这次点击
    if (e.target.closest(".act-btn") || e.target.closest(".badge")) return;
    const check = e.target.closest(".row-check");
    if (check || document.body.classList.contains("selecting")) { toggleSel(id); return; }
    // 面板里点歌：不改动 state.viewTracks，直接以整个队列作为播放上下文
    const queueIds = ctx === "queue"
      ? [...state.queue]
      : state.viewTracks.map((x) => x.id);
    playTrack(id, queueIds);
  });
  row.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await rowAction(btn.dataset.act, id, btn, ctx); } catch (err) { toast(err.message, "err"); }
    });
  });
}

function bindCollHeader(h) {
  const bvid = h.dataset.bvid;
  const group = buildGroups(state.viewTracks).find((g) => g.bvid === bvid);
  if (!group) return;
  const ids = group.tracks.map((t) => t.id);

  h.addEventListener("click", async (e) => {
    if (e.target.closest(".act-btn")) return;
    if (e.target.closest("[data-checkgroup]")) { toggleSelGroup(ids); return; }
    const b = state.collapsed.has(bvid) ? state.collapsed.delete(bvid) : state.collapsed.add(bvid);
    persistCollapsed();
    renderList();
  });
  h.querySelectorAll("[data-coll]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const act = btn.dataset.coll;
      try {
        if (act === "play") playTrack(ids[0], ids);
        else if (act === "download") { await downloadMany(ids); toast("合集开始下载…", "ok"); }
        else if (act === "addpl") openPopoverAt(ids, btn);
        else if (act === "share") shareCollection(group);
        else if (act === "rest") {
          toast("正在收集合集…");
          const r = await api(`/api/tracks/${ids[0]}/collect-rest`, { method: "POST" });
          toast(r.added.length ? `已补齐合集，新增 ${r.added.length} 首` : "合集已经收齐了", "ok");
          refresh();
        }
      } catch (err) { toast(err.message, "err"); }
    });
  });
}

/* ---------------- 多选 ---------------- */
function toggleSel(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncSelecting();
  renderList();
}
function toggleSelGroup(ids) {
  const all = ids.every((i) => state.selected.has(i));
  ids.forEach((i) => all ? state.selected.delete(i) : state.selected.add(i));
  syncSelecting();
  renderList();
}
function syncSelecting() {
  document.body.classList.toggle("selecting", state.selected.size > 0);
}
function clearSelection() {
  state.selected.clear();
  syncSelecting();
  renderList();
}
function updateSelBar() {
  const bar = $("#sel-bar");
  bar.hidden = state.selected.size === 0;
  $("#sel-count").textContent = `已选 ${state.selected.size} 首`;
}
async function downloadMany(ids) {
  for (const id of ids) {
    try { await api(`/api/tracks/${id}/download`, { method: "POST" }); } catch (e) {}
  }
  await loadTracks();
  renderList();
  ensurePolling();
}

$("#sel-bar").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-selact]");
  if (!btn) return;
  const ids = [...state.selected];
  const act = btn.dataset.selact;
  try {
    if (act === "play") { playTrack(ids[0], ids); clearSelection(); }
    else if (act === "download") { await downloadMany(ids); toast("开始下载选中曲目…", "ok"); clearSelection(); }
    else if (act === "addpl") openPopoverAt(ids, btn);
    else if (act === "clear") clearSelection();
  } catch (err) { toast(err.message, "err"); }
});

/* ---------------- 动作 ---------------- */
async function doDownload(id) {
  await api(`/api/tracks/${id}/download`, { method: "POST" });
  toast("开始下载…", "ok");
  await loadTracks(); renderList(); ensurePolling();
}

async function rowAction(act, id, anchor, ctx = state.view.type) {
  if (act === "download" || act === "retry") {
    await doDownload(id);
  } else if (act === "undownload") {
    const ok = await askConfirm({
      title: "删除本地文件",
      text: "将从磁盘删除这首歌的离线文件。\n收藏会保留，之后仍可在线播放或重新下载。",
      okText: "删 除",
    });
    if (ok) {
      await api(`/api/tracks/${id}/local`, { method: "DELETE" });
      refresh();
    }
  } else if (act === "addpl") {
    openPopoverAt([id], anchor);
  } else if (act === "share") {
    const t = state.viewTracks.find((x) => x.id === id) || (state.current && state.current.id === id ? state.current : null);
    if (t) shareTrack(t); else toast("这首歌信息已失效，刷新后再试", "err");
  } else if (act === "delete") {
    if (ctx === "queue") {
      // 从播放列表中移除
      removeFromQueue(id);
    } else if (ctx === "pl") {
      await api(`/api/playlists/${state.view.id}/tracks/${id}`, { method: "DELETE" });
      refresh();
    } else {
      const ok = await askConfirm({
        title: "删除这首歌",
        text: "将从音乐库中删除这首歌。\n如果已下载到本地，本地文件也会一并删除，且不可恢复。",
        okText: "删 除",
      });
      if (!ok) return;
      await api(`/api/tracks/${id}`, { method: "DELETE" });
      if (state.current && state.current.id === id) { audio.pause(); audio.src = ""; state.current = null; updateNowPlaying(); }
      refresh();
    }
  }
}

/** 从播放列表中移除某首 */
function removeFromQueue(trackId) {
  state.queue = state.queue.filter((id) => id !== trackId);
  savePlaybackState();
  if (state.current && state.current.id === trackId) {
    // 正在播的被删了，切到下一首
    playNext(false);
  }
  updateQueueNavCount();
  renderQueuePanel();
  renderList();
}

/** 更新底部播放列表按钮 / 面板标题上的曲目数 */
function updateQueueNavCount() {
  const n = state.queue.length;
  const btn = $("#btn-queue-count");
  if (btn) btn.textContent = n;
  const qc = $("#qp-count");
  if (qc) qc.textContent = `(${n})`;
}

/* ---------------- 分享链接 ---------------- */
const SHARE_ICON = "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z";

/** 这首歌在 B 站的原始链接；多 P 视频带上 ?p=，分享出去对方会直接落到这一集 */
function shareUrlOf(t) {
  if (!t || !t.bvid) return "";
  const p = Number(t.page) || 1;
  return `https://www.bilibili.com/video/${t.bvid}${p > 1 ? `?p=${p}` : ""}`;
}

/** 整辑链接（不带 ?p=，对方打开后可自行挑分P） */
function shareCollUrl(bvid) {
  return bvid ? `https://www.bilibili.com/video/${bvid}` : "";
}

/**
 * 复制文本到剪贴板。
 * navigator.clipboard 只在安全上下文可用 —— 用 localhost 访问时正常，
 * 但若通过局域网 IP（http://192.168.x.x:8790）打开就会失效，所以要留降级路径。
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* 落到降级 */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) { return false; }
}

const shareOv = $("#share-overlay");

/** 打开分享弹窗。item = { title, sub, url, info } */
function openShare(item) {
  $("#share-title").textContent = item.title;
  $("#share-sub").textContent = item.sub || "";
  const input = $("#share-url");
  input.value = item.url;
  input.dataset.info = item.info || item.url;
  shareOv.hidden = false;
  // 自动选中，即使复制 API 不可用也能直接 ⌘C
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

function closeShare() { shareOv.hidden = true; }

/** 分享一首歌 */
function shareTrack(t) {
  if (!t) return;
  const url = shareUrlOf(t);
  if (!url) { toast("这首歌缺少 B 站来源信息，无法分享", "err"); return; }
  openShare({
    title: "分享链接",
    sub: `${t.title}${t.artist ? ` · ${t.artist}` : ""}`,
    url,
    info: `${t.title}${t.artist ? ` - ${t.artist}` : ""}\n${url}`,
  });
}

/** 分享整个合集 */
function shareCollection(g) {
  if (!g) return;
  const url = shareCollUrl(g.bvid);
  if (!url) { toast("这个合集缺少 B 站来源信息，无法分享", "err"); return; }
  const total = g.total || g.tracks.length;
  openShare({
    title: "分享合集链接",
    sub: `${g.title} · 共 ${total} P，对方打开后可在分P列表里挑`,
    url,
    info: `${g.title}\n${url}`,
  });
}

/* ---------------- 右键菜单 ---------------- */
const ctx = $("#ctx-menu");
const EDGE = 8;                       // 弹层距视口边缘的最小留白
// 记住最近一次右键落点：从右键菜单里再开「加入歌单」时，弹层要贴着它出现，而不是跑到屏幕中间
let ctxPos = { x: null, y: null };

/* 统一算弹层落点，越界时自动收进视口（下方放不下就翻到上方）
   anchor 支持三种形式：元素 / {x,y} 鼠标点 / 空（居中兜底） */
function layoutPopover(size, anchor) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const maxL = Math.max(EDGE, vw - size.width - EDGE);
  const maxT = Math.max(EDGE, vh - size.height - EDGE);
  let ax, ay;
  if (anchor && anchor.nodeType === 1 && anchor.getBoundingClientRect().width) {
    const b = anchor.getBoundingClientRect();
    ax = b.left;
    ay = b.bottom + 6;
    if (ay + size.height > vh - EDGE) ay = b.top - size.height - 6;
  } else if (anchor && typeof anchor.x === "number" && anchor.x !== null) {
    ax = anchor.x;
    ay = anchor.y + 6;
    if (ay + size.height > vh - EDGE) ay = anchor.y - size.height - 6;
  } else {
    // 锚点已从 DOM 移除（尺寸为 0）或压根没给，退回视口居中
    ax = (vw - size.width) / 2;
    ay = vh * 0.3;
  }
  return {
    left: Math.min(Math.max(ax, EDGE), maxL),
    top: Math.min(Math.max(ay, EDGE), maxT),
  };
}

function placeAt(el, pos) {
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
}

function showMenu(x, y, items, onPick) {
  ctx.innerHTML = items.map((it, i) => it.sep
    ? `<div class="ctx-sep"></div>`
    : `<div class="ctx-item ${it.danger ? "danger" : ""}" data-i="${i}">
         <svg viewBox="0 0 24 24"><path d="${it.icon}"/></svg>${it.label}
       </div>`).join("");
  ctx.hidden = false;
  ctxPos = { x, y };
  const r = ctx.getBoundingClientRect();
  placeAt(ctx, layoutPopover(r, { x, y }));
  ctx.querySelectorAll("[data-i]").forEach((el) => {
    el.addEventListener("click", () => {
      const it = items[Number(el.dataset.i)];
      closeCtxMenu();
      onPick(it);
    });
  });
}

async function deleteTracks(ids) {
  for (const id of ids) {
    try { await api(`/api/tracks/${id}`, { method: "DELETE" }); } catch (e) {}
  }
  if (state.current && ids.includes(state.current.id)) {
    audio.pause(); audio.src = ""; state.current = null; updateNowPlaying();
  }
}

function openCtxMenu(x, y, trackId, ctx = state.view.type) {
  const t = state.tracks.find((v) => v.id === trackId);
  if (!t) return;
  const inPlaylist = ctx === "pl";
  const inQueue = ctx === "queue";
  const items = [
    { act: "play", label: "立即播放", icon: "M8 5v14l11-7z" },
    { act: "next", label: "下一首播放", icon: "M16 6h2v12h-2zM6 18l8.5-6L6 6z" },
  ];
  if (t.download_status === "done" && t.local_path) {
    items.push({ act: "undownload", label: "删除本地文件", icon: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" });
  } else {
    items.push({ act: t.download_status === "error" ? "retry" : "download",
                 label: t.download_status === "error" ? "重试下载" : "下载到本地",
                 icon: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" });
  }
  items.push({ act: "addpl", label: "加入歌单…", icon: "M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm13-1v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" });
  items.push({ act: "share", label: "复制分享链接", icon: SHARE_ICON });
  // 只收藏了多 P 视频里的某一集时，给一个把整个合集收齐的入口
  if ((t.coll_total || 0) > 1) {
    items.push({ act: "collect-rest",
                 label: `收藏整个合集（共 ${t.coll_total} P）`,
                 icon: "M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-1 9h-3v3h-2v-3h-3V9h3V6h2v3h3v2z" });
  }
  if (t.cover) {
    items.push({ act: "fixcover",
                 label: t.local_path ? "补齐封面（存本地并内嵌）" : "缓存封面到本地",
                 icon: "M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z" });
  }
  if (inQueue) {
    // 播放列表视图下「移除」只保留这一条：原先它和末项是同一个动作，
    // 菜单里会出现两条一模一样的「从播放列表移除」
    items.push({ sep: true });
    items.push({ act: "remove-from-queue", label: "从播放列表移除", icon: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z", danger: true });
  } else {
    items.push({ sep: true });
    items.push({ act: "delete", label: inPlaylist ? "从此歌单移除" : "删除这首歌",
                 icon: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z", danger: true });
  }

  showMenu(x, y, items, async (it) => {
    try {
      if (it.act === "play") playTrack(trackId, inQueue ? [...state.queue] : state.viewTracks.map((v) => v.id));
      else if (it.act === "next") {
        const i = state.queue.indexOf(state.current ? state.current.id : -1);
        state.queue = state.queue.filter((v) => v !== trackId);
        state.queue.splice(i + 1, 0, trackId);
        savePlaybackState();
        toast("将在下一首播放", "ok");
      }
      else if (it.act === "remove-from-queue") {
        removeFromQueue(trackId);
        toast("已从播放列表移除", "ok");
      }
      else if (it.act === "fixcover") {
        toast("正在补齐封面…");
        const r = await api(`/api/tracks/${trackId}/cover`, { method: "POST" });
        if (state.current && state.current.id === trackId) updateNowPlaying();
        renderList();
        toast(r.embedded ? "封面已保存并内嵌到音频文件" : "封面已缓存到本地", "ok");
      }
      else if (it.act === "share") shareTrack(t);
      else if (it.act === "collect-rest") {
        toast("正在收集合集…");
        const r = await api(`/api/tracks/${trackId}/collect-rest`, { method: "POST" });
        toast(r.added.length ? `已补齐合集，新增 ${r.added.length} 首` : "合集已经收齐了", "ok");
        refresh();
      }
      else await rowAction(it.act, trackId, ctxPos, ctx);
    } catch (err) { toast(err.message, "err"); }
  });
}

function openCollCtxMenu(x, y, bvid) {
  const g = buildGroups(state.viewTracks).find((v) => v.bvid === bvid);
  if (!g) return;
  const ids = g.tracks.map((t) => t.id);
  const items = [
    { act: "play", label: `播放整个合集（${ids.length} 首）`, icon: "M8 5v14l11-7z" },
    { act: "download", label: "下载整个合集", icon: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" },
  ];
  if ((g.total || 0) > ids.length) {
    items.push({ act: "rest", label: `收藏整个合集（还差 ${g.total - ids.length} P）`,
                 icon: "M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-1 9h-3v3h-2v-3h-3V9h3V6h2v3h3v2z" });
  }
  items.push(
    { act: "addpl", label: "合集加入歌单…", icon: "M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm13-1v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" },
    { act: "share", label: "复制合集链接", icon: SHARE_ICON },
    { act: "select", label: "全选本合集", icon: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" },
    { sep: true },
    { act: "delete", label: "删除整个合集（含本地文件）", icon: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z", danger: true },
  );
  showMenu(x, y, items, async (it) => {
    try {
      if (it.act === "play") playTrack(ids[0], ids);
      else if (it.act === "share") shareCollection(g);
      else if (it.act === "download") { await downloadMany(ids); toast("合集开始下载…", "ok"); }
      else if (it.act === "addpl") openPopoverAt(ids, ctxPos);
      else if (it.act === "rest") {
        toast("正在收集合集…");
        const r = await api(`/api/tracks/${ids[0]}/collect-rest`, { method: "POST" });
        toast(r.added.length ? `已补齐合集，新增 ${r.added.length} 首` : "合集已经收齐了", "ok");
        refresh();
      }
      else if (it.act === "select") { ids.forEach(i => state.selected.add(i)); syncSelecting(); renderList(); }
      else if (it.act === "delete") {
        const ok = await askConfirm({
          title: "删除整个合集",
          text: `将删除合集「${g.title}」共 ${ids.length} 首。\n已下载的本地文件也会一并删除，且不可恢复。`,
          okText: `删除 ${ids.length} 首`,
        });
        if (!ok) return;
        await deleteTracks(ids);
        toast("合集已删除", "ok");
        refresh();
      }
    } catch (err) { toast(err.message, "err"); }
  });
}

/* ---------------- 歌单右键菜单 ---------------- */
function openPlCtxMenu(x, y, pid) {
  const pl = state.playlists.find((p) => p.id === pid);
  if (!pl) return;
  const items = [
    { act: "play", label: `播放整个歌单（${pl.count} 首）`, icon: "M8 5v14l11-7z" },
    { act: "queue", label: "加入播放列表", icon: "M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm13-1v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" },
    { sep: true },
    { act: "rename", label: "重命名歌单", icon: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" },
  ];
  if (pid !== 1) {
    items.push({ act: "delete", label: "删除歌单", icon: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z", danger: true });
  }

  const fetchIds = async () => {
    const list = await api(`/api/playlists/${pid}/tracks`);
    return list.map((t) => t.id);
  };

  showMenu(x, y, items, async (it) => {
    try {
      if (it.act === "play") {
        const ids = await fetchIds();
        if (!ids.length) { toast("这个歌单还是空的", "err"); return; }
        state.view = { type: "pl", id: pid };
        state.plOrder = null;
        renderSidebar();
        playTrack(ids[0], ids);
      } else if (it.act === "queue") {
        const ids = await fetchIds();
        if (!ids.length) { toast("这个歌单还是空的", "err"); return; }
        const fresh = ids.filter((i) => !state.queue.includes(i));
        state.queue.push(...fresh);
        savePlaybackState();
        updateQueueNavCount();
        renderQueuePanel();
        toast(`已加入 ${fresh.length} 首到播放列表`, "ok");
      } else if (it.act === "rename") {
        openModal({ type: "rename", pid, value: pl.name });
      } else if (it.act === "delete") {
        const ok = await askConfirm({
          title: "删除歌单",
          text: `确定要删除歌单「${pl.name}」吗？\n歌单里的歌曲不会被删除，仍保留在「全部音乐」中。`,
          okText: "删 除",
        });
        if (!ok) return;
        await api(`/api/playlists/${pid}`, { method: "DELETE" });
        if (state.view.type === "pl" && state.view.id === pid) { state.view = { type: "all" }; state.plOrder = null; }
        toast(`已删除歌单「${pl.name}」`, "ok");
        refresh();
      }
    } catch (err) { toast(err.message, "err"); }
  });
}

function closeCtxMenu() { ctx.hidden = true; }
function closePlPopover() { $("#playlist-popover").hidden = true; }
function closeMenus() { closeCtxMenu(); closePlPopover(); }
/* 滚动 / 失焦时收起所有浮层；但滚动发生在浮层内部时不算（那是用户在翻长歌单列表） */
document.addEventListener("scroll", (e) => {
  const t = e.target;
  if (t instanceof Element && t.closest(".popover, .ctx-menu")) return;
  closeMenus();
}, true);
window.addEventListener("blur", closeMenus);
document.addEventListener("click", (e) => { if (!e.target.closest(".ctx-menu")) closeCtxMenu(); });
document.addEventListener("contextmenu", (e) => {
  closePlPopover();
  const row = e.target.closest(".track-row");
  if (row) { e.preventDefault(); openCtxMenu(e.clientX, e.clientY, Number(row.dataset.id), rowCtx(row)); return; }
  const coll = e.target.closest(".coll-header");
  if (coll) { e.preventDefault(); openCollCtxMenu(e.clientX, e.clientY, coll.dataset.bvid); return; }
  closeCtxMenu();
});

/* ---------------- 加入歌单弹出层（支持批量） ---------------- */
/* anchor：触发它的按钮元素，或 {x,y}（从右键菜单进来时用右键落点）。
   弹层贴着它出现；万一没传（或锚点已从 DOM 消失）才回退到视口居中。 */
function openPopoverAt(trackIds, anchor) {
  const ids = trackIds.filter((v, i, a) => a.indexOf(v) === i);
  const pop = $("#playlist-popover");
  pop.hidden = false;
  // 只换列表内容、保留外层结构，标题与滚动容器才能各司其职
  pop.querySelector(".popover-title").textContent =
    `加入 ${ids.length > 1 ? ids.length + " 首歌曲到" : ""}歌单`;
  pop.querySelector("#popover-list").innerHTML = state.playlists.map((p) =>
    `<div class="popover-item" data-addto="${p.id}">${escapeHtml(p.name)}<span>${p.count} 首</span></div>`).join("");
  pop.style.visibility = "hidden";
  pop.style.left = "0px";
  pop.style.top = "0px";
  // 先量尺寸再定位：贴着锚点，越界自动收进视口
  const r = pop.getBoundingClientRect();
  placeAt(pop, layoutPopover(r, anchor));
  pop.style.visibility = "";
  pop.querySelectorAll("[data-addto]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        await api(`/api/playlists/${el.dataset.addto}/tracks/batch`, {
          method: "POST", body: { track_ids: ids },
        });
        toast(`已加入 ${ids.length} 首`, "ok");
        pop.hidden = true;
        if (state.selected.size) clearSelection();
        refresh();
      } catch (err) { toast(err.message, "err"); }
    });
  });
}
document.addEventListener("click", (e) => {
  const pop = $("#playlist-popover");
  if (!pop.hidden && !e.target.closest(".popover") && !e.target.closest(".ctx-menu")
      && !e.target.closest('[data-act="addpl"]')
      && !e.target.closest('[data-coll="addpl"]') && !e.target.closest('[data-selact="addpl"]')) {
    pop.hidden = true;
  }
});

/* ---------------- 新建 / 重命名歌单弹窗 ---------------- */
const modal = $("#modal-overlay"), modalInput = $("#modal-input");
let modalMode = { type: "create", pid: null };

function openModal(opts = {}) {
  modalMode = { type: opts.type || "create", pid: opts.pid || null };
  const isRename = modalMode.type === "rename";
  $("#modal-title").textContent = isRename ? "重命名歌单" : "新建歌单";
  $("#modal-ok").textContent = isRename ? "保 存" : "创 建";
  modalInput.placeholder = isRename ? "输入新的歌单名称" : "给歌单起个名字";
  modalInput.value = opts.value || "";
  modal.hidden = false;
  setTimeout(() => { modalInput.focus(); modalInput.select(); }, 30);
}
function closeModal() { modal.hidden = true; }
$("#modal-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
modalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#modal-ok").click();
  if (e.key === "Escape") closeModal();
});
$("#modal-ok").addEventListener("click", async () => {
  const name = modalInput.value.trim();
  if (!name) { modalInput.focus(); return; }
  try {
    if (modalMode.type === "rename") {
      await api(`/api/playlists/${modalMode.pid}`, { method: "PATCH", body: { name } });
      toast(`已重命名为「${name}」`, "ok");
    } else {
      await api("/api/playlists", { method: "POST", body: { name } });
      toast(`已创建「${name}」`, "ok");
    }
    closeModal();
    refresh();
  } catch (err) { toast(err.message, "err"); }
});

/* ---------------- 通用确认弹窗（替代原生 confirm） ---------------- */
const confirmOv = $("#confirm-overlay");

function askConfirm({ title = "确认操作", text = "", okText = "确 定",
                      cancelText = "取 消", danger = true } = {}) {
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    const okBtn = $("#confirm-ok"), cancelBtn = $("#confirm-cancel");
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    okBtn.classList.toggle("danger", danger);
    okBtn.classList.toggle("primary", !danger);
    confirmOv.hidden = false;
    // 焦点给"取消"，避免误按空格直接确认
    setTimeout(() => cancelBtn.focus(), 30);

    const finish = (val) => {
      confirmOv.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      confirmOv.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); finish(false); }
      if (e.key === "Enter") { e.stopPropagation(); finish(true); }
    };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    confirmOv.onclick = (e) => { if (e.target === confirmOv) finish(false); };
    document.addEventListener("keydown", onKey, true);
  });
}

/* ---------------- 分享弹窗的交互 ---------------- */
$("#share-copy").addEventListener("click", async () => {
  const ok = await copyText($("#share-url").value);
  toast(ok ? "链接已复制" : "复制失败，请手动选中复制", ok ? "ok" : "err");
  if (ok) closeShare();
});
$("#share-info").addEventListener("click", async () => {
  const input = $("#share-url");
  const ok = await copyText(input.dataset.info || input.value);
  toast(ok ? "歌曲信息已复制" : "复制失败，请手动选中复制", ok ? "ok" : "err");
  if (ok) closeShare();
});
$("#share-url").addEventListener("focus", (e) => e.target.select());
shareOv.addEventListener("click", (e) => { if (e.target === shareOv) closeShare(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !shareOv.hidden) { e.stopPropagation(); closeShare(); }
}, true);

/** 是否有弹层处于打开状态 */
function isOverlayOpen() {
  return !modal.hidden || !confirmOv.hidden || !shareOv.hidden;
}

/* ==================== 播放核心 ==================== */
function playTrack(id, queueIds) {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return;
  if (queueIds) state.queue = queueIds;
  if (!state.queue.includes(id)) state.queue.push(id);
  state.current = t;
  state.retryCount = 0;
  audio.src = `/api/stream/${id}`;
  audio.play().catch(() => {});
  updateNowPlaying();
  savePlaybackState();
  renderList();
  renderQueuePanel();
  updateQueueNavCount();
}

function nextIndex(auto) {
  const n = state.queue.length;
  if (n === 0) return -1;
  const i = state.queue.indexOf(state.current ? state.current.id : -1);
  if (state.mode === "single" && auto) return i;
  if (state.mode === "shuffle") {
    if (n === 1) return 0;
    let j = i;
    while (j === i) j = Math.floor(Math.random() * n);
    return j;
  }
  const next = i + 1;
  if (next >= n) {
    if (state.mode === "sequential" && auto) return -1;
    return 0;
  }
  return next;
}
function playNext(auto = false) {
  const idx = nextIndex(auto);
  if (idx < 0) { audio.pause(); return; }
  playTrack(state.queue[idx]);
}
function playPrev() {
  const n = state.queue.length;
  if (!n) return;
  const i = state.queue.indexOf(state.current ? state.current.id : -1);
  playTrack(state.queue[(i - 1 + n) % n]);
}

function updateNowPlaying() {
  const t = state.current;
  // 没有 B 站来源信息就没什么可分享的
  $("#btn-share").hidden = !t || !t.bvid;
  if (!t) {
    $("#np-title").textContent = "未在播放";
    $("#np-artist").textContent = "";
    $("#np-cover").innerHTML = "🎵";
    return;
  }
  $("#np-title").textContent = t.title;
  $("#np-artist").textContent = t.artist;
  $("#np-cover").innerHTML = t.cover ? coverTag(t.id) : "🎵";
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist,
      artwork: t.cover ? [{ src: `/api/cover/${t.id}`, sizes: "512x512" }] : [],
    });
  }
}

function updateModeUI() {
  const m = MODES[modeIdx()];
  $("#mode-label").textContent = m.label;
  $("#mode-icon").querySelector("path").setAttribute("d", m.icon);
}

/* ---------------- 事件绑定 ---------------- */
$("#btn-add").addEventListener("click", async () => {
  const url = $("#url-input").value.trim();
  if (!url) return;
  const btn = $("#btn-add");
  btn.disabled = true; btn.textContent = "解析中…";
  try {
    const res = await addByUrl(url);
    if (res.added.length) {
      const prefix = res.mode === "collection" ? "已收藏整个合集，" : "已收藏 ";
      toast(`${prefix}${res.added.length} 首${res.skipped ? `（跳过已存在 ${res.skipped} 首）` : ""}`, "ok");
    }
    else toast(res.skipped ? "都已收藏过了" : "没有可收藏的内容", "err");
    $("#url-input").value = "";
    refresh();
  } catch (err) { toast(err.message, "err"); }
  btn.disabled = false; btn.textContent = "收 藏";
});

/** 粘贴的若是多 P 视频里某一集的链接，先问一句：只要这一集，还是整个合集？ */
async function addByUrl(url) {
  let mode = "auto";
  // 探测失败不阻断收藏，退回原来的行为
  const meta = await api(`/api/bili/inspect?url=${encodeURIComponent(url)}`).catch(() => null);
  if (meta && meta.multi && meta.page) {
    const whole = await askConfirm({
      title: "这是个多 P 视频",
      text: `《${meta.title}》共 ${meta.total} P，你粘贴的是第 ${meta.page} P。\n\n要把整个合集都收藏进来吗？`,
      okText: `收藏整个合集（${meta.total} P）`,
      cancelText: `只要第 ${meta.page} P`,
      danger: false,
    });
    mode = whole ? "collection" : "single";
  }
  return api("/api/tracks", { method: "POST", body: { url, mode } });
}
$("#url-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-add").click(); });
$("#btn-share").addEventListener("click", () => shareTrack(state.current));

/* ---------------- 播放列表面板 ---------------- */
$("#btn-queue").addEventListener("click", (e) => { e.stopPropagation(); toggleQueuePanel(); });
$("#qp-close").addEventListener("click", closeQueuePanel);
$("#qp-play-all").addEventListener("click", () => {
  const items = getQueueTracks();
  if (!items.length) { toast("播放列表是空的", "err"); return; }
  playTrack(items[0].id, [...state.queue]);
});
$("#qp-clear").addEventListener("click", async () => {
  const n = state.queue.length;
  if (!n) { toast("播放列表已经是空的"); return; }
  const ok = await askConfirm({
    title: "清空播放列表",
    text: `将从播放列表中移除全部 ${n} 首。\n收藏与已下载的本地文件都不受影响。`,
    okText: "清 空",
  });
  if (!ok) return;
  state.queue = [];
  savePlaybackState();
  updateQueueNavCount();
  renderQueuePanel();
  renderList();
  toast("播放列表已清空", "ok");
});
// 点面板外面收起。注意：弹窗 / 右键菜单 / 歌单浮层里的点击不算「点外面」，
// 否则「清空 → 取消」或右键菜单里选一项，都会顺手把面板关掉
document.addEventListener("click", (e) => {
  if (!queuePanelOpen()) return;
  if (e.target.closest("#queue-panel") || e.target.closest("#btn-queue")) return;
  if (e.target.closest(".modal-overlay, .ctx-menu, .popover")) return;
  closeQueuePanel();
});

/* 侧栏导航项的点击在 renderSidebar() 里统一绑定（每次渲染都是新节点），
   这里不再重复绑；原先针对静态节点的两份监听是死代码，且其中一条会因
   「播放列表」项已从侧栏移除而拿到 null，直接把脚本打断 */

$("#search-input").addEventListener("input", (e) => {
  state.search = e.target.value.trim();
  renderList();
});

$("#btn-all-view").addEventListener("click", () => {
  state.allFlat = !state.allFlat;
  localStorage.setItem("lm-all-flat", state.allFlat ? "1" : "0");
  renderList();
});

$("#btn-play-all").addEventListener("click", () => {
  const ids = state.viewTracks.map((t) => t.id);
  if (!ids.length) { toast("列表是空的", "err"); return; }
  playTrack(ids[0], ids);
});

$("#btn-play").addEventListener("click", () => {
  if (!state.current) {
    const ids = state.viewTracks.map((t) => t.id);
    if (ids.length) playTrack(ids[0], ids);
    return;
  }
  if (audio.paused) audio.play(); else audio.pause();
});
$("#btn-next").addEventListener("click", () => playNext(false));
$("#btn-prev").addEventListener("click", playPrev);

$("#btn-mode").addEventListener("click", () => {
  state.mode = MODES[(modeIdx() + 1) % MODES.length].key;
  localStorage.setItem("lm-mode", state.mode);
  updateModeUI();
  savePlaybackState();
  toast(`播放模式：${MODES[modeIdx()].label}`);
});

audio.addEventListener("play", () => {
  $("#icon-play").classList.add("hide");
  $("#icon-pause").classList.remove("hide");
  savePlaybackState();
});
audio.addEventListener("pause", () => {
  $("#icon-play").classList.remove("hide");
  $("#icon-pause").classList.add("hide");
  savePlaybackState();
});
audio.addEventListener("ended", () => playNext(true));
audio.addEventListener("timeupdate", () => {
  if (!audio.duration || !isFinite(audio.duration)) return;
  $("#time-cur").textContent = fmt(audio.currentTime);
  $("#time-total").textContent = fmt(audio.duration);
  if (!seeking) $("#progress").value = Math.round(audio.currentTime / audio.duration * 1000);
});
audio.addEventListener("error", () => {
  if (state.current && state.retryCount < 2) {
    state.retryCount++;
    audio.src = `/api/stream/${state.current.id}?r=${Date.now()}`;
    audio.play().catch(() => {});
  }
});
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => playNext(false));
  navigator.mediaSession.setActionHandler("previoustrack", playPrev);
}

let seeking = false;
$("#progress").addEventListener("input", () => { seeking = true; });
$("#progress").addEventListener("change", (e) => {
  if (audio.duration && isFinite(audio.duration)) audio.currentTime = (e.target.value / 1000) * audio.duration;
  seeking = false;
  savePlaybackState();
});

const vol = $("#volume");
audio.volume = Number(localStorage.getItem("lm-vol") ?? 0.8);
vol.value = audio.volume * 100;
vol.addEventListener("input", () => {
  audio.volume = vol.value / 100;
  localStorage.setItem("lm-vol", audio.volume);
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (isOverlayOpen()) return;   // 弹窗打开时不响应快捷键
  if (e.code === "Space") { e.preventDefault(); $("#btn-play").click(); }
  if (e.key === "Escape") {
    if (!ctx.hidden) { closeCtxMenu(); return; }   // 有右键菜单先收菜单
    if (state.selected.size) clearSelection();
    if (queuePanelOpen()) closeQueuePanel();
  }
});

/* ==================== 启动 & 状态恢复 ==================== */
(async () => {
  updateModeUI();
  await refresh();
  // 插件离线收藏的条目：导入成功就刷新一次列表
  if (await syncExtensionInbox()) await refresh();

  // 尝试恢复上次的播放状态
  const saved = loadPlaybackState();
  if (saved && saved.trackId && saved.queue && saved.queue.length) {
    const t = state.tracks.find((tr) => tr.id === saved.trackId);
    if (t) {
      state.queue = saved.queue;
      state.mode = saved.mode || "list-loop";
      state.current = t;
      audio.src = `/api/stream/${saved.trackId}`;
      updateNowPlaying();
      updateModeUI();

      // 恢复播放位置
      audio.addEventListener("canplay", function onCan() {
        audio.removeEventListener("canplay", onCan);
        audio.currentTime = Math.min(saved.position || 0, audio.duration || 0);
        if (!saved.paused) audio.play().catch(() => {});
        renderList();
        updateQueueNavCount();
      }, { once: true });
    }
  }
  updateQueueNavCount();
})();
