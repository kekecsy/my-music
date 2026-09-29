/* local music · B站收藏 —— 弹出面板 */
(() => {
  const $ = (id) => document.getElementById(id);
  const BV_PATH = /\/video\/(BV[0-9A-Za-z]{10})/;

  let baseUrl = 'http://127.0.0.1:8790';
  let curInfo = null;      // inspect 结果
  let curTab = null;
  let collecting = false;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(r || { ok: false, error: '无响应' });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------------- 服务状态 ---------------- */

  async function refreshConn() {
    const conn = $('conn');
    const r = await send({ type: 'api', path: '/api/ping' });
    if (r.ok) {
      conn.className = 'conn ok';
      conn.querySelector('em').textContent = '已连接';
      $('downHint').classList.add('hidden');
      return true;
    }
    conn.className = 'conn bad';
    conn.querySelector('em').textContent = '未启动';
    $('downHint').classList.remove('hidden');
    return false;
  }

  /* ---------------- 当前页 ---------------- */

  async function loadCurrentPage() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    curTab = tab;
    const m = (tab.url || '').match(BV_PATH);
    if (!m) {
      $('noPage').classList.remove('hidden');
      return;
    }
    $('pageCard').classList.remove('hidden');
    const bvid = m[1];
    const pm = new URLSearchParams(new URL(tab.url).search).get('p');
    const page = pm && /^\d+$/.test(pm) ? parseInt(pm, 10) : 1;

    const ins = await send({
      type: 'api',
      path: `/api/bili/inspect?url=${encodeURIComponent(`https://www.bilibili.com/video/${bvid}`)}`,
    });
    if (!ins.ok) {
      $('pcTitle').textContent = '获取视频信息失败';
      $('pcSub').textContent = ins.error;
      $('btnOne').disabled = true;
      return;
    }
    curInfo = ins.data;

    const st = await send({ type: 'api', path: `/api/bili/status?bvid=${bvid}&page=${page}` });
    $('pcTitle').textContent = curInfo.title || '未知标题';
    $('pcSub').textContent = curInfo.multi
      ? `共 ${curInfo.total} P · 当前在第 ${page} P`
        + (st.ok && st.data.favorited ? ' · 这一集已收藏' : '')
      : (st.ok && st.data.favorited ? '已在曲库中' : '单P视频');

    if (st.ok && st.data.favorited) {
      $('btnOne').textContent = '再收藏一次';
    }
    if (curInfo.multi) {
      $('btnAll').classList.remove('hidden');
      if (st.ok && st.data.collected > 0) {
        $('btnAll').textContent = `收齐整个合集（已收 ${st.data.collected}/${curInfo.total}）`;
      } else {
        $('btnAll').textContent = `收藏整个合集（${curInfo.total} P）`;
      }
    }
  }

  async function doCollect(mode) {
    if (collecting || !curTab) return;
    collecting = true;
    const btns = [$('btnOne'), $('btnAll')];
    btns.forEach((b) => { b.disabled = true; });
    const hint = $('pcHint');
    hint.className = 'pc-hint';
    hint.textContent = '收藏中…';

    const r = await send({ type: 'collect', url: curTab.url, mode });
    btns.forEach((b) => { b.disabled = false; });
    collecting = false;

    if (!r.ok) {
      hint.className = 'pc-hint bad';
      hint.textContent = r.error;
      return;
    }
    const d = r.data;
    const n = (d.added || []).length;
    const sk = d.skipped || 0;
    hint.className = 'pc-hint';
    hint.textContent = n === 0
      ? '曲库里已经有了，没有重复收藏'
      : d.mode === 'collection'
        ? `已收藏《${d.album || ''}》共 ${n} 首，去 local music 看看吧`
        : (d.total > 1
          ? `已收藏这一集（合集 ${n + sk}/${d.total}）`
          : '已收藏，去 local music 看看吧');
    // 状态文本跟着更新
    $('btnOne').textContent = '再收藏一次';
    renderHistory();
  }

  /* ---------------- 设置 ---------------- */

  async function loadSettings() {
    const s = await chrome.storage.sync.get({
      baseUrl: 'http://127.0.0.1:8790',
      defaultMode: 'auto',
      showFab: true,
    });
    baseUrl = String(s.baseUrl).replace(/\/+$/, '');
    $('baseUrl').value = baseUrl;
    $('mode').value = s.defaultMode;
    $('fabToggle').checked = s.showFab;
  }

  function bindSettings() {
    $('baseUrl').addEventListener('change', async () => {
      baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8790';
      $('baseUrl').value = baseUrl;
      await chrome.storage.sync.set({ baseUrl });
      refreshConn();
    });
    $('mode').addEventListener('change', () => chrome.storage.sync.set({ defaultMode: $('mode').value }));
    $('fabToggle').addEventListener('change', () => chrome.storage.sync.set({ showFab: $('fabToggle').checked }));
  }

  /* ---------------- 历史 ---------------- */

  async function renderHistory() {
    const { favHistory = [] } = await chrome.storage.local.get({ favHistory: [] });
    if (!favHistory.length) return;
    $('histCard').classList.remove('hidden');
    $('histList').innerHTML = favHistory.slice(0, 5).map((h) => {
      const n = h.added || 0;
      const txt = n > 0
        ? (h.mode === 'collection' ? `整辑 <span class="h-n">${n} 首</span>` : (h.total > 1 ? `单集（合集 ${n + (h.skipped || 0)}/${h.total}）` : '单首'))
        : '已在库中';
      return `<li title="${h.title.replace(/"/g, '&quot;')}">${h.title} — ${txt} · ${fmtTime(h.time)}</li>`;
    }).join('');
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    await loadSettings();
    bindSettings();
    const up = await refreshConn();
    if (up) await loadCurrentPage();
    else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if ((tab.url || '').match(BV_PATH)) {
        $('pageCard').classList.remove('hidden');
        $('pcTitle').textContent = 'local music 未启动';
        $('pcSub').textContent = '启动后重新打开本插件即可收藏';
        $('btnOne').disabled = true;
      } else {
        $('noPage').classList.remove('hidden');
      }
    }
    renderHistory();

    $('btnOne').addEventListener('click', () => doCollect('single'));
    $('btnAll').addEventListener('click', () => doCollect('collection'));
    $('openApp').addEventListener('click', () => chrome.tabs.create({ url: baseUrl }));
  }

  init();
})();
