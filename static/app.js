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
  view: { type: "all" },          // "all" | "queue" | "pl"
  viewTracks: [],
  queue: [],                       // 当前播放列表（内存中的实际队列）
  current: null,
  mode: localStorage.getItem("lm-mode") || "list-loop",
  search: "",
  retryCount: 0,
  selected: new Set(),
  collapsed: new Set(JSON.parse(localStorage.getItem("lm-collapsed") || "[]")),
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

async function currentViewTracks() {
  if (state.view.type === "queue") return getQueueTracks();
  if (state.view.type === "all") return state.tracks;
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
  if (state.view.type === "queue") {
    $("#view-title").textContent = "播放列表";
    $("#btn-play-all").textContent = "▶ 播放全部";
  } else {
    $("#view-title").textContent = state.view.type === "all" ? "全部音乐" : pl ? pl.name : "";
    $("#btn-play-all").textContent = "▶ 播放全部";
  }
  // 播放列表 / 歌单，且未在搜索、且不止一首时，才允许拖动排序
  const reorderable = canReorder() && tracks.length > 1;
  $("#view-count").textContent = reorderable
    ? `共 ${tracks.length} 首 · 按住拖动可调整顺序`
    : `共 ${tracks.length} 首`;

  // 播放列表视图的空提示
  const isQueueEmpty = state.view.type === "queue" && tracks.length === 0;
  $("#empty-tip").hidden = !(isQueueEmpty || (state.view.type !== "queue" && tracks.length === 0));
  if (isQueueEmpty) {
    $("#empty-tip .empty-icon").textContent = "📋";
    $("#empty-tip p:first-of-type").textContent = "播放列表是空的";
    $("#empty-tip .sub").textContent = "从歌单或全部音乐中选择歌曲开始播放";
  } else {
    $("#empty-tip .empty-icon").textContent = "🎵";
    $("#empty-tip p:first-of-type").textContent = "还没有收藏音乐";
    $("#empty-tip .sub").textContent = "把 B 站视频链接粘贴到上方，点「收藏」试试";
  }

  let html = "";
  if (state.view.type === "queue" || state.view.type === "pl") {
    // 播放列表 / 歌单视图：扁平列表，支持拖动排序
    html = tracks.map((t, i) => rowHtml(t, false, reorderable ? i : null)).join("");
  } else if (state.view.type === "all") {
    html = buildGroups(tracks).map((g) => {
      if (!g.collection) return rowHtml(g.tracks[0]);
      const open = !state.collapsed.has(g.bvid);
      return collectionHtml(g) + (open
        ? `<div class="coll-body">${g.tracks.map((t) => rowHtml(t, true)).join("")}</div>`
        : "");
    }).join("");
  } else {
    html = tracks.map((t) => rowHtml(t)).join("");
  }

  const list = $("#track-list");
  list.innerHTML = html;
  list.querySelectorAll(".track-row").forEach((row) => bindRow(row, Number(row.dataset.id)));
  list.querySelectorAll(".coll-header").forEach((h) => bindCollHeader(h));
  if (reorderable) bindRowDrag(list);
  updateSelBar();
}

/* ---------------- 拖动排序（播放列表 + 歌单） ---------------- */
let dragId = null;
const dragList = $("#track-list");

/** 当前视图是否允许拖动排序：搜索状态下顺序是筛选结果，不允许拖 */
function canReorder() {
  return !state.search && (state.view.type === "queue" || state.view.type === "pl");
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
  dragList.querySelectorAll(".drop-before, .drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  dragList.classList.remove("drop-active");
}

/** 只在落点变化时才动 class。
 *  拖拽过程中频繁增删 class 会让浏览器重算光标下的命中目标，触发 dragenter/dragleave
 *  抖动；而 dragover 是节流的，抖动后可能来不及补发新的 dragover，导致 drop 被丢弃。 */
function markDrop(row, after) {
  if (dropRow === row && dropAfter === after) return;
  clearDropMarks();
  dropRow = row; dropAfter = after;
  row.classList.add(after ? "drop-after" : "drop-before");
  dragList.classList.add("drop-active");
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
  renderList();
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

/** 按视图分发：播放列表改内存队列，歌单写数据库 */
function applyReorder(moveId, targetId, after) {
  if (state.view.type === "pl") return reorderPlaylist(moveId, targetId, after);
  return Promise.resolve(reorderQueue(moveId, targetId, after));
}

// 容器级监听只绑定一次：renderList 每次都会替换行节点，
// 若把监听绑在容器上又每次渲染都绑，会重复累积
dragList.addEventListener("dragover", (e) => {
  if (dragId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const t = pickDropTarget([...dragList.querySelectorAll(".track-row")], e.clientY);
  if (t) markDrop(t.row, t.after);
  else clearDropMarks();
});
dragList.addEventListener("dragleave", (e) => {
  if (!dragList.contains(e.relatedTarget)) clearDropMarks();
});
dragList.addEventListener("drop", async (e) => {
  if (dragId == null) return;
  e.preventDefault();
  const t = pickDropTarget([...dragList.querySelectorAll(".track-row")], e.clientY);
  clearDropMarks();
  if (!t) return;
  const targetId = Number(t.row.dataset.id);
  const inPlaylistView = state.view.type === "pl";
  try {
    if (await applyReorder(dragId, targetId, t.after)) {
      toast(inPlaylistView ? "已调整歌单顺序" : "已调整播放顺序", "ok");
    }
  } catch (err) { toast(err.message, "err"); }
});

/** 每次渲染后给行节点绑定拖动事件（行节点是新建的，不会累积） */
function bindRowDrag(list) {
  list.querySelectorAll(".track-row").forEach((row) => {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      dragId = Number(row.dataset.id);
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

/** @param {number?} queueIndex 播放列表视图中的序号 */
function rowHtml(t, asChild = false, queueIndex = null) {
  const isPlaying = state.current && state.current.id === t.id;
  const inPlaylist = state.view.type === "pl";
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
       data-id="${t.id}"${draggable ? ' draggable="true"' : ""}>
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
      <button class="act-btn danger" data-act="delete" title="${inPlaylist ? "从此歌单移除" : "删除"}">
        ${inPlaylist
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
      ${missing > 0
        ? `<button class="act-btn" data-coll="rest" title="收藏整个合集（还差 ${missing} P）"><svg viewBox="0 0 24 24"><path d="M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-1 9h-3v3h-2v-3h-3V9h3V6h2v3h3v2z"/></svg></button>`
        : ""}
    </div>
  </div>`;
}

/* ---------------- 行 / 合集事件 ---------------- */
function bindRow(row, id) {
  row.addEventListener("click", async (e) => {
    if (state.suppressClick) return;   // 刚拖拽完，忽略这次点击
    if (e.target.closest(".act-btn") || e.target.closest(".badge")) return;
    const check = e.target.closest(".row-check");
    if (check || document.body.classList.contains("selecting")) { toggleSel(id); return; }
    playTrack(id, state.viewTracks.map((x) => x.id));
  });
  row.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await rowAction(btn.dataset.act, id); } catch (err) { toast(err.message, "err"); }
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
        else if (act === "addpl") openPopoverAt(ids);
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
    else if (act === "addpl") openPopoverAt(ids);
    else if (act === "clear") clearSelection();
  } catch (err) { toast(err.message, "err"); }
});

/* ---------------- 动作 ---------------- */
async function doDownload(id) {
  await api(`/api/tracks/${id}/download`, { method: "POST" });
  toast("开始下载…", "ok");
  await loadTracks(); renderList(); ensurePolling();
}

async function rowAction(act, id) {
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
    openPopoverAt([id]);
  } else if (act === "delete") {
    if (state.view.type === "queue") {
      // 从播放列表中移除
      removeFromQueue(id);
    } else if (state.view.type === "pl") {
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
  renderList();
  updateQueueNavCount();
}

/** 更新侧边栏播放列表上的计数 */
function updateQueueNavCount() {
  const qItem = document.querySelector('[data-view="queue"] .pl-count');
  if (qItem) qItem.textContent = state.queue.length;
}

/* ---------------- 右键菜单 ---------------- */
const ctx = $("#ctx-menu");

function showMenu(x, y, items, onPick) {
  ctx.innerHTML = items.map((it, i) => it.sep
    ? `<div class="ctx-sep"></div>`
    : `<div class="ctx-item ${it.danger ? "danger" : ""}" data-i="${i}">
         <svg viewBox="0 0 24 24"><path d="${it.icon}"/></svg>${it.label}
       </div>`).join("");
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  ctx.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  ctx.querySelectorAll("[data-i]").forEach((el) => {
    el.addEventListener("click", () => {
      closeCtxMenu();
      onPick(items[Number(el.dataset.i)]);
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

function openCtxMenu(x, y, trackId) {
  const t = state.tracks.find((v) => v.id === trackId);
  if (!t) return;
  const inPlaylist = state.view.type === "pl";
  const inQueue = state.view.type === "queue";
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
    items.push({ sep: true });
    items.push({ act: "remove-from-queue", label: "从播放列表移除", icon: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z", danger: true });
  }
  items.push({ sep: true });
  items.push({ act: "delete", label: inQueue ? "从播放列表移除" : inPlaylist ? "从此歌单移除" : "删除这首歌",
               icon: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z", danger: true });

  showMenu(x, y, items, async (it) => {
    try {
      if (it.act === "play") playTrack(trackId, state.viewTracks.map((v) => v.id));
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
      else if (it.act === "collect-rest") {
        toast("正在收集合集…");
        const r = await api(`/api/tracks/${trackId}/collect-rest`, { method: "POST" });
        toast(r.added.length ? `已补齐合集，新增 ${r.added.length} 首` : "合集已经收齐了", "ok");
        refresh();
      }
      else await rowAction(it.act, trackId);
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
    { act: "select", label: "全选本合集", icon: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" },
    { sep: true },
    { act: "delete", label: "删除整个合集（含本地文件）", icon: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z", danger: true },
  );
  showMenu(x, y, items, async (it) => {
    try {
      if (it.act === "play") playTrack(ids[0], ids);
      else if (it.act === "download") { await downloadMany(ids); toast("合集开始下载…", "ok"); }
      else if (it.act === "addpl") openPopoverAt(ids);
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
        toast(`已加入 ${fresh.length} 首到播放列表`, "ok");
        if (state.view.type === "queue") renderList();
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
document.addEventListener("click", (e) => { if (!e.target.closest(".ctx-menu")) closeCtxMenu(); });
document.addEventListener("scroll", closeCtxMenu, true);
window.addEventListener("blur", closeCtxMenu);
document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".track-row");
  if (row) { e.preventDefault(); openCtxMenu(e.clientX, e.clientY, Number(row.dataset.id)); return; }
  const coll = e.target.closest(".coll-header");
  if (coll) { e.preventDefault(); openCollCtxMenu(e.clientX, e.clientY, coll.dataset.bvid); return; }
  closeCtxMenu();
});

/* ---------------- 加入歌单弹出层（支持批量） ---------------- */
function openPopoverAt(trackIds, x, y) {
  const ids = trackIds.filter((v, i, a) => a.indexOf(v) === i);
  const pop = $("#playlist-popover");
  pop.hidden = false;
  pop.innerHTML = `<div class="popover-title">加入 ${ids.length > 1 ? ids.length + " 首歌曲到" : ""}歌单</div>` +
    state.playlists.map((p) =>
      `<div class="popover-item" data-addto="${p.id}">${escapeHtml(p.name)}<span>${p.count} 首</span></div>`).join("");
  pop.style.visibility = "hidden";
  requestAnimationFrame(() => {
    const r = pop.getBoundingClientRect();
    const px = x != null ? Math.min(x, window.innerWidth - r.width - 8)
                         : (window.innerWidth - r.width) / 2;
    const py = y != null ? Math.min(y + 6, window.innerHeight - r.height - 8)
                         : window.innerHeight * 0.3;
    pop.style.left = `${Math.max(8, px)}px`;
    pop.style.top = `${Math.max(8, py)}px`;
    pop.style.visibility = "";
  });
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

/** 是否有弹层处于打开状态 */
function isOverlayOpen() {
  return !modal.hidden || !confirmOv.hidden;
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

document.querySelector('[data-view="all"]').addEventListener("click", () => {
  state.view = { type: "all" };
  state.plOrder = null;
  renderSidebar(); renderList();
});
document.querySelector('[data-view="queue"]').addEventListener("click", () => {
  state.view = { type: "queue" };
  state.plOrder = null;
  renderSidebar(); renderList();
});

$("#search-input").addEventListener("input", (e) => {
  state.search = e.target.value.trim();
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
  if (e.key === "Escape" && state.selected.size) clearSelection();
});

/* ==================== 启动 & 状态恢复 ==================== */
(async () => {
  updateModeUI();
  await refresh();

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
