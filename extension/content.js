/* local music · B站收藏 —— 页面脚本
 *
 * 在视频页（/video/BV…）右下角放一个悬浮收藏按钮：
 *   单P视频 → 点击直接收藏
 *   多P视频 → 弹出小面板，选「仅这一集」或「整个合集」
 * 按钮可拖动，位置会记住；已在曲库中的视频会亮绿点。
 * 全部 UI 走 Shadow DOM，不影响 B 站自己的样式。
 */
(() => {
  if (window.__localMusicExt) return;
  window.__localMusicExt = true;

  const BV_PATH = /\/video\/(BV[0-9A-Za-z]{10})/;
  const FAB_SIZE = 46;

  const state = {
    bvid: null,
    page: 1,
    title: '',
    total: 0,
    multi: false,
    fav: false,
    busy: false,
    showFab: true,
  };

  let wrap = null;   // 按钮容器（fixed 定位，可拖动）
  let ui = null;     // shadow 内的元素引用
  let host = null;

  /* ---------------- 与后台通信 ---------------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: '扩展通信失败，请刷新页面重试' });
          } else {
            resolve(r || { ok: false, error: '无响应' });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: '插件已更新，请刷新页面' });
      }
    });
  }

  /* ---------------- 当前页面解析 ---------------- */

  function currentPage() {
    const m = location.pathname.match(BV_PATH);
    if (!m) return null;
    let page = 1;
    const pm = new URLSearchParams(location.search).get('p');
    if (pm && /^\d+$/.test(pm)) page = parseInt(pm, 10) || 1;
    return { bvid: m[1], page };
  }

  function videoUrl(page = state.page) {
    return `https://www.bilibili.com/video/${state.bvid}` + (page > 1 ? `?p=${page}` : '');
  }

  /* ---------------- 收藏状态 ---------------- */

  async function refreshStatus() {
    const cur = currentPage();
    updateVisibility(cur);
    if (!cur) return;
    state.bvid = cur.bvid;
    state.page = cur.page;
    const r = await send({ type: 'status', bvid: cur.bvid, page: cur.page });
    if (r.ok) {
      state.fav = !!r.data.favorited;
      renderFavState();
    }
  }

  function updateVisibility(cur) {
    if (!host) return;
    const show = !!cur && state.showFab;
    host.style.display = show ? 'block' : 'none';
    if (!show) closePanel();
  }

  function renderFavState() {
    if (!ui) return;
    ui.fab.classList.toggle('faved', state.fav);
    ui.fab.title = state.fav
      ? `已在 local music 曲库中\n（第 ${state.page} 集）点击可继续收藏`
      : '收藏到 local music';
  }

  /* ---------------- 收藏流程 ---------------- */

  async function onFabActivate() {
    const cur = currentPage();
    if (!cur || state.busy) return;
    state.bvid = cur.bvid;
    state.page = cur.page;

    const ins = await send({ type: 'inspect', url: videoUrl() });
    if (!ins.ok) { showToast(ins.error, false); return; }

    state.title = ins.data.title || '';
    state.total = ins.data.total || 1;
    state.multi = !!ins.data.multi;

    if (state.multi) openPanel();
    else doCollect('single');
  }

  async function doCollect(mode) {
    if (state.busy || !state.bvid) return;
    state.busy = true;
    renderBusy();
    const body = { url: videoUrl(mode === 'single' ? state.page : 1), mode };
    const r = await send({ type: 'collect', ...body });
    state.busy = false;
    renderBusy();
    closePanel();
    if (!r.ok) { showToast(r.error, false); return; }

    const d = r.data;
    const n = (d.added || []).length;
    const sk = d.skipped || 0;
    const queued = d.via === 'inbox';   // 服务没启动，先写进项目目录排队
    const tail = queued ? '（local music 未启动，已排队，启动后自动入库）' : '';
    let text;
    if (n === 0 && !queued) {
      text = '曲库里已经有了，没有重复收藏';
    } else if (d.mode === 'collection') {
      text = `已收藏《${d.album || state.title}》共 ${n} 首${tail}`;
    } else {
      text = d.total > 1
        ? `已收藏这一集（合集 ${n + sk}/${d.total}）${tail}`
        : `已收藏《${state.title || d.album || ''}》${tail}`;
    }
    showToast(text, true);
    refreshStatus();
  }

  function renderBusy() {
    if (ui) ui.fab.classList.toggle('busy', state.busy);
  }

  /* ---------------- 面板 ---------------- */

  function openPanel() {
    if (!ui) return;
    ui.pTitle.textContent = state.title || '未知标题';
    ui.pSub.textContent = `共 ${state.total} P · 当前在第 ${state.page} P`;
    ui.pAll.textContent = `收藏整个合集（${state.total} P）`;
    ui.panel.classList.add('open');
  }

  function closePanel() {
    if (ui) ui.panel.classList.remove('open');
  }

  /* ---------------- toast ---------------- */

  let toastTimer = null;
  function showToast(text, ok) {
    if (!ui) return;
    ui.toastText.textContent = text;
    ui.toast.classList.toggle('bad', ok === false);
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3400);
  }

  /* ---------------- 悬浮按钮定位与拖动 ---------------- */

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function defaultPos() {
    return { x: window.innerWidth - FAB_SIZE - 28, y: window.innerHeight - FAB_SIZE - 150 };
  }

  function applyPos(p) {
    p.x = clamp(p.x, 8, window.innerWidth - FAB_SIZE - 8);
    p.y = clamp(p.y, 8, window.innerHeight - FAB_SIZE - 8);
    wrap.style.left = `${Math.round(p.x)}px`;
    wrap.style.top = `${Math.round(p.y)}px`;
  }

  async function initFabPos() {
    const { fabPos = null } = await chrome.storage.local.get({ fabPos: null });
    applyPos(fabPos || defaultPos());
  }

  let drag = null;

  function bindDrag() {
    ui.fab.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = {
        sx: e.clientX, sy: e.clientY,
        ox: wrap.offsetLeft, oy: wrap.offsetTop,
        moved: false,
      };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
      if (drag.moved) applyPos({ x: drag.ox + dx, y: drag.oy + dy });
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const wasMoved = drag.moved;
      drag = null;
      if (wasMoved) {
        chrome.storage.local.set({ fabPos: { x: wrap.offsetLeft, y: wrap.offsetTop } });
      } else {
        onFabActivate();
      }
    });
    window.addEventListener('resize', () => {
      applyPos({ x: wrap.offsetLeft, y: wrap.offsetTop });
    });
  }

  /* ---------------- UI 构建 ---------------- */

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .wrap { position: fixed; z-index: 2147483000; width: 46px; }
    .fab {
      width: 46px; height: 46px; border-radius: 50%;
      background: linear-gradient(135deg, #fb7299, #e0427c);
      box-shadow: 0 4px 16px rgba(224, 66, 124, .45);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none; position: relative;
      transition: transform .15s ease;
    }
    .fab:hover { transform: scale(1.08); }
    .fab svg { width: 22px; height: 22px; fill: #fff; }
    .fab .dot {
      position: absolute; top: -2px; right: -2px;
      width: 13px; height: 13px; border-radius: 50%;
      background: #2fbf71; border: 2px solid #fff; display: none;
    }
    .fab.faved .dot { display: block; }
    .fab.busy svg { animation: lm-pulse 0.9s ease-in-out infinite; }
    @keyframes lm-pulse { 50% { opacity: .35; } }

    .panel {
      position: absolute; bottom: 56px; right: 0;
      width: 300px; background: #fff; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, .2);
      padding: 14px 14px 12px; display: none;
    }
    .panel.open { display: block; }
    .panel h3 {
      font-size: 14px; color: #18191c; line-height: 1.45; font-weight: 600;
      margin-bottom: 3px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .panel .sub { font-size: 12px; color: #9499a0; margin-bottom: 12px; }
    .panel .btns { display: flex; flex-direction: column; gap: 8px; }
    .panel button {
      border: none; border-radius: 8px; padding: 9px 12px;
      font-size: 13px; cursor: pointer; font-family: inherit;
    }
    .panel .primary { background: #fb7299; color: #fff; }
    .panel .primary:hover { background: #f55f8d; }
    .panel .ghost { background: #f1f2f3; color: #61666d; }
    .panel .ghost:hover { background: #e3e5e7; }

    .toast {
      position: fixed; top: 22px; left: 50%; transform: translateX(-50%) translateY(-8px);
      max-width: 70vw; background: rgba(24, 25, 28, .92); color: #fff;
      font-size: 13px; line-height: 1.5; padding: 10px 16px; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .25);
      display: flex; align-items: center; gap: 8px;
      opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s;
      z-index: 2147483600;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast .tdot { width: 8px; height: 8px; border-radius: 50%; background: #2fbf71; flex: none; }
    .toast.bad .tdot { background: #ff5f66; }
  `;

  const FAB_SVG = `<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

  function mountUI() {
    host = document.createElement('div');
    host.id = 'lmx-host';
    host.style.display = 'none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <div class="fab" part="fab">
          ${FAB_SVG}
          <span class="dot"></span>
        </div>
        <div class="panel">
          <h3 class="p-title"></h3>
          <div class="sub p-sub"></div>
          <div class="btns">
            <button class="primary p-one">仅收藏这一集</button>
            <button class="primary p-all">收藏整个合集</button>
            <button class="ghost p-cancel">取消</button>
          </div>
        </div>
      </div>
      <div class="toast"><span class="tdot"></span><span class="t-text"></span></div>
    `;
    document.documentElement.appendChild(host);

    wrap = root.querySelector('.wrap');
    ui = {
      fab: root.querySelector('.fab'),
      panel: root.querySelector('.panel'),
      pTitle: root.querySelector('.p-title'),
      pSub: root.querySelector('.p-sub'),
      pOne: root.querySelector('.p-one'),
      pAll: root.querySelector('.p-all'),
      pCancel: root.querySelector('.p-cancel'),
      toast: root.querySelector('.toast'),
      toastText: root.querySelector('.t-text'),
    };

    ui.fab.addEventListener('mousedown', (e) => e.stopPropagation());
    ui.pOne.addEventListener('click', () => doCollect('single'));
    ui.pAll.addEventListener('click', () => doCollect('collection'));
    ui.pCancel.addEventListener('click', closePanel);
    bindDrag();
  }

  /* ---------------- 后台推送的 toast ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'toast') {
      showToast(msg.text, msg.ok !== false);
      sendResponse({ ok: true });
    }
    return false;
  });

  /* ---------------- 启动 ---------------- */

  async function init() {
    mountUI();
    await initFabPos();

    const { showFab = true } = await chrome.storage.sync.get({ showFab: true });
    state.showFab = showFab;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.showFab) {
        state.showFab = changes.showFab.newValue;
        updateVisibility(currentPage());
      }
    });

    refreshStatus();

    // B 站是 SPA：切分P / 切视频不刷新页面，轮询 URL 变化
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        closePanel();
        refreshStatus();
      }
    }, 800);
  }

  init();
})();
