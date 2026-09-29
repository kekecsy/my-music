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

  /* ---------------- 服务 / 目录状态 ---------------- */

  async function refreshConn() {
    const conn = $('conn');
    const r = await send({ type: 'probe' });
    const d = r.ok ? r.data : { service: false, dir: null, perm: 'none', pending: 0 };
    const bound = !!(d.dir && d.dir.ok && d.perm === 'granted');
    const hint = $('downHint');
    hint.className = 'down-hint';
    hint.innerHTML = '';

    if (d.service) {
      conn.className = 'conn ok';
      conn.querySelector('em').textContent = '已连接';
      hint.classList.add('hidden');
    } else if (bound) {
      conn.className = 'conn ok';
      conn.querySelector('em').textContent = '离线模式';
      hint.classList.add('hidden');
    } else if (d.dir && d.dir.ok) {
      conn.className = 'conn bad';
      conn.querySelector('em').textContent = '需重新授权';
      hint.innerHTML = '项目目录授权失效了，打开设置页重新连接一次即可。';
      hint.classList.remove('hidden');
    } else {
      conn.className = 'conn bad';
      conn.querySelector('em').textContent = '未启动';
      hint.innerHTML = 'local music 没在运行。先启动它：<code>./start.sh</code><br>'
        + '或者绑定项目目录，就能离线收藏、等启动后自动入库。';
      hint.classList.remove('hidden');
    }

    // 目录卡片
    const st = $('dirState');
    const btn = $('btnDir');
    if (d.dir && d.dir.ok && d.perm === 'granted') {
      st.innerHTML = `已绑定 <b>${d.dir.name}</b>（${d.dir.desc}）`
        + (d.pending
          ? `<br><span class="pending">待同步 ${d.pending} 条 —— 启动 local music 后自动导入</span>`
          : '<br><span class="pending ok">没有待同步的收藏</span>');
      btn.textContent = '更换 / 重新连接目录';
    } else if (d.dir && d.dir.ok) {
      st.innerHTML = `已绑定 <b>${d.dir.name}</b>，但需要重新授权`;
      btn.textContent = '重新连接目录';
    } else {
      st.textContent = d.service
        ? '未绑定 —— 服务在线时可正常收藏；绑定后不启动服务也能收藏'
        : '未绑定 —— 绑定后，即使不启动 local music 也能收藏';
      btn.textContent = '绑定本地项目目录';
    }

    return { ...d, canCollect: d.service || bound };
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

    const ins = await send({ type: 'inspect', url: tab.url });
    if (!ins.ok) {
      $('pcTitle').textContent = '获取视频信息失败';
      $('pcSub').textContent = ins.error;
      $('btnOne').disabled = true;
      return;
    }
    curInfo = ins.data;

    const st = await send({ type: 'status', bvid, page });
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
    const queued = d.via === 'inbox';
    hint.className = 'pc-hint';
    if (n === 0 && !queued) {
      hint.textContent = '曲库里已经有了，没有重复收藏';
    } else if (d.mode === 'collection') {
      hint.textContent = `已收藏《${d.album || ''}》共 ${n} 首`
        + (queued ? '，已排队，启动 local music 后自动入库' : '，去 local music 看看吧');
    } else if (d.total > 1) {
      hint.textContent = `已收藏这一集（合集 ${n + sk}/${d.total}）`
        + (queued ? '，已排队，启动 local music 后自动入库' : '');
    } else {
      hint.textContent = queued ? '已收藏，已排队，启动 local music 后自动入库' : '已收藏，去 local music 看看吧';
    }
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
    const info = await refreshConn();
    if (info.canCollect) await loadCurrentPage();
    else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if ((tab.url || '').match(BV_PATH)) {
        $('pageCard').classList.remove('hidden');
        $('pcTitle').textContent = '现在还不能收藏';
        $('pcSub').textContent = '启动 local music，或在下面的「本地项目目录」绑定一次';
        $('btnOne').disabled = true;
      } else {
        $('noPage').classList.remove('hidden');
      }
    }
    renderHistory();

    $('btnOne').addEventListener('click', () => doCollect('single'));
    $('btnAll').addEventListener('click', () => doCollect('collection'));
    $('openApp').addEventListener('click', () => chrome.tabs.create({ url: baseUrl }));
    $('btnDir').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
      window.close();
    });
  }

  init();
})();
