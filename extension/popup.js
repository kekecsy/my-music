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

  // 后台 service worker 可能正在冷启动，第一条消息偶发失败 → 失败就重试一两次。
  // 只用于"查询"类消息；收藏不重试，避免语义不变的情况下多排一次队。
  async function sendRetry(msg, tries = 3, gap = 500) {
    let r;
    for (let i = 0; i < tries; i++) {
      r = await send(msg);
      if (r.ok) return r;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, gap));
    }
    return r;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------------- 服务 / 目录状态 ---------------- */

  async function refreshConn() {
    const conn = $('conn');
    const r = await sendRetry({ type: 'probe' });
    const d = r.ok ? r.data : { service: false, dir: { status: 'none' }, outbox: 0 };
    const dir = d.dir || { status: 'none' };
    const outbox = d.outbox || 0;
    const ready = dir.status === 'ready';
    const broken = dir.status === 'need-auth' || dir.status === 'bad';
    const hint = $('downHint');
    hint.className = 'down-hint';
    hint.innerHTML = '';

    if (d.service) {
      conn.className = 'conn ok';
      conn.querySelector('em').textContent = '已连接';
      hint.classList.add('hidden');
    } else if (ready) {
      conn.className = 'conn ok';
      conn.querySelector('em').textContent = '离线模式';
      hint.classList.add('hidden');
    } else if (broken) {
      // 目录还记着，只是这次会话没拿到读写权限（服务也没在跑）
      conn.className = 'conn bad';
      conn.querySelector('em').textContent = dir.status === 'need-auth' ? '需重新授权' : '目录不可用';
      hint.innerHTML = dir.status === 'need-auth'
        ? 'local music 没在运行，项目目录也需要重新授权一次 —— 点下面的「恢复读写权限」。'
        : 'local music 没在运行，绑定的目录也用不了。';
      hint.classList.remove('hidden');
    } else {
      conn.className = 'conn bad';
      conn.querySelector('em').textContent = '未启动';
      hint.innerHTML = 'local music 没在运行。先启动它：<code>./start.sh</code><br>'
        + (outbox
          ? `已经帮你排了 <b>${outbox}</b> 条收藏在插件里，启动后自动入库。`
          : '也可以绑定项目目录，就能离线收藏、等启动后自动入库。');
      hint.classList.remove('hidden');
    }

    // 目录卡片
    const st = $('dirState');
    const btn = $('btnDir');
    const queue = outbox
      ? `<br><span class="pending">插件里排队 ${outbox} 条 —— local music 一起来就自动入库</span>`
      : '';
    if (ready) {
      st.innerHTML = `已绑定 <b>${dir.name}</b>（${dir.desc}）`
        + (dir.pending
          ? `<br><span class="pending">待同步 ${dir.pending} 条 —— 启动 local music 后自动导入</span>`
          : '<br><span class="pending ok">没有待同步的收藏</span>')
        + queue;
      btn.textContent = '更换 / 重新连接目录';
    } else if (dir.status === 'need-auth') {
      st.innerHTML = `已绑定 <b>${dir.name}</b>，但需要重新授权`
        + '<br><span class="pending">目录还记着，点下面重新授权即可（不必重选文件夹）</span>'
        + queue;
      btn.textContent = '恢复项目目录权限';
    } else if (dir.status === 'bad') {
      st.innerHTML = `绑定的目录不可用`
        + (dir.error ? `<br><span class="pending">${dir.error}</span>` : '')
        + queue;
      btn.textContent = '重新选择目录';
    } else {
      st.innerHTML = (d.service
        ? '未绑定 —— 服务在线时可正常收藏；绑定后不启动服务也能收藏'
        : '未绑定 —— 离线收藏会先排队在插件里，绑定目录后还能直接写进项目文件夹')
        + queue;
      btn.textContent = '绑定本地项目目录';
    }

    // 有了「插件内队列」兜底，任何情况下都能收下这次收藏（最坏是排队等入库）
    return { ...d, canCollect: true };
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

    const ins = await sendRetry({ type: 'inspect', url: tab.url });
    if (!ins.ok) {
      $('pcTitle').textContent = '获取视频信息失败';
      $('pcSub').textContent = ins.error;
      $('btnOne').disabled = true;
      return;
    }
    curInfo = ins.data;

    const st = await sendRetry({ type: 'status', bvid, page });
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
    const queued = d.via === 'inbox' || d.via === 'outbox';
    const cnt = d.queued || n;
    const tail = d.via === 'inbox'
      ? '，已写进项目目录，启动 local music 后自动入库'
      : '，已排队在插件里，启动 local music 后自动入库';
    hint.className = 'pc-hint';
    if (n === 0 && !queued) {
      hint.textContent = '曲库里已经有了，没有重复收藏';
    } else if (d.mode === 'collection') {
      hint.textContent = `已收藏《${d.album || ''}》共 ${cnt} 首`
        + (queued ? tail : '，去 local music 看看吧');
    } else if (d.total > 1) {
      hint.textContent = `已收藏这一集（合集 ${cnt + sk}/${d.total}）` + (queued ? tail : '');
    } else {
      hint.textContent = queued ? `已收藏${tail}` : '已收藏，去 local music 看看吧';
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
    await refreshConn();
    await loadCurrentPage();
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
