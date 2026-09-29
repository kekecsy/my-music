/* local music · B站收藏 —— 后台服务（MV3 service worker）
 *
 * 职责：
 *  1. 统一代理所有对本地服务的请求（扩展 origin + host_permissions，不受页面 CORS 限制）
 *  2. 本地服务没启动时的「离线收藏」：插件自己抓 B 站元数据，
 *     写进用户绑定的项目目录（data/extension-inbox.jsonl），服务下次启动自动导入
 *  3. 右键菜单「收藏到 local music」
 *  4. 收藏结果反馈（工具栏角标 + 转发给 B 站页面弹 toast）
 */

importScripts('fsaccess.js');

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8790',
  defaultMode: 'auto', // auto / single / collection，右键菜单使用
};

function getSettings() {
  return chrome.storage.sync.get(DEFAULTS).then((s) => ({
    ...s,
    baseUrl: String(s.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
  }));
}

function humanError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed|The operation was aborted/i.test(msg)) {
    return '连不上 local music';
  }
  return msg;
}

async function api(path, opts = {}) {
  const { baseUrl } = await getSettings();
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new Error(humanError(e));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

/* ---------- 本地服务是否在跑（短超时，不拖慢收藏） ---------- */

async function pingService(timeout = 1500) {
  const { baseUrl } = await getSettings();
  try {
    const res = await fetch(baseUrl + '/api/ping', { signal: AbortSignal.timeout(timeout) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/* ---------- 插件自己抓 B 站元数据（离线收藏用） ---------- */

async function fetchBiliMeta(url) {
  let finalUrl = url;
  if (/b23\.tv/i.test(url) && !/BV[0-9A-Za-z]{10}/.test(url)) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      finalUrl = r.url || url;
    } catch (e) { /* 交给下面的报错 */ }
  }
  const mb = finalUrl.match(/BV[0-9A-Za-z]{10}/);
  if (!mb) throw new Error('识别不出 BV 号，请确认是 B 站视频链接');
  const bvid = mb[0];
  const mp = finalUrl.match(/[?&]p=(\d+)/);
  const explicitPage = !!mp;
  const page = mp ? parseInt(mp[1], 10) : 1;

  const r = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { credentials: 'omit' },
  );
  const j = await r.json().catch(() => ({}));
  if (!j || j.code !== 0 || !j.data) {
    throw new Error((j && j.message) || 'B 站接口没响应，稍后再试');
  }
  return { bvid, page, explicitPage, data: j.data };
}

// 标题格式与项目端 collection_tracks / yt-dlp 完全一致，保证两条通道产出一样
function partTitle(vtitle, page, part, multi) {
  const t = (vtitle || '').trim();
  if (!multi) return t || '未知标题';
  const p = String(page).padStart(2, '0');
  const seg = (part || '').trim();
  return seg ? `${t} p${p} ${seg}` : `${t} p${p}`;
}

function buildRecord(meta, mode) {
  const { bvid, page, explicitPage, data } = meta;
  const vtitle = (data.title || '').trim();
  const artist = ((data.owner || {}).name || '').trim();
  const cover = data.pic || '';
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const total = parseInt(data.videos || pages.length || 1, 10);
  const multi = total > 1;

  // 与后端 add_tracks 的判定一致：整辑 = mode=collection，或 auto 且链接没带 ?p= 的多P视频
  const whole = mode === 'collection' || (mode === 'auto' && multi && !explicitPage);

  const base = `https://www.bilibili.com/video/${bvid}`;
  const tracks = [];
  if (whole) {
    for (const p of pages) {
      const no = parseInt(p.page || 1, 10);
      tracks.push({
        bvid,
        page: no,
        url: `${base}?p=${no}`,
        title: partTitle(vtitle, no, p.part, true),
        artist,
        cover,
        duration: parseInt(p.duration || 0, 10),
      });
    }
    if (!tracks.length) throw new Error('这个视频没有可收藏的分 P');
  } else {
    const usePage = explicitPage ? page : 1;
    const p = pages.find((x) => parseInt(x.page || 1, 10) === usePage) || pages[usePage - 1];
    tracks.push({
      bvid,
      page: usePage,
      // 多P视频带 ?p=，单P视频用裸链接 —— 与库里既有格式一致
      url: multi ? `${base}?p=${usePage}` : base,
      title: partTitle(vtitle, usePage, p && p.part, multi),
      artist,
      cover,
      duration: parseInt((p && p.duration) || 0, 10),
    });
  }

  return {
    v: 1,
    source: 'extension',
    mode: whole ? 'collection' : 'single',
    album: multi ? vtitle : '',
    coll_total: multi ? total : 0,
    bvid,
    added_at: new Date().toISOString(),
    tracks,
  };
}

/* ---------- 待同步标记（离线收藏过哪些，用于按钮绿点） ---------- */

const keyOf = (bvid, page) => `${bvid}:${page}`;

async function rememberPending(record) {
  const { pendingKeys = [] } = await chrome.storage.local.get({ pendingKeys: [] });
  const set = new Set(pendingKeys);
  for (const t of record.tracks) set.add(keyOf(t.bvid, t.page));
  await chrome.storage.local.set({ pendingKeys: [...set].slice(-500) });
}

/* ---------- 收藏 ---------- */

async function pushHistory(rec) {
  const { favHistory = [] } = await chrome.storage.local.get({ favHistory: [] });
  favHistory.unshift({ ...rec, time: Date.now() });
  await chrome.storage.local.set({ favHistory: favHistory.slice(0, 8) });
}

async function collectViaService(url, mode) {
  const data = await api('/api/tracks', { method: 'POST', body: { url, mode } });
  await pushHistory({
    title: data.album || url,
    mode: data.mode,
    added: (data.added || []).length,
    skipped: data.skipped || 0,
    total: data.total || 0,
    via: 'service',
  });
  return { ...data, via: 'service' };
}

async function collectViaInbox(url, mode) {
  const meta = await fetchBiliMeta(url);
  const record = buildRecord(meta, mode);

  const handle = await LM_FS.loadHandle();
  if (!handle) {
    const e = new Error('local music 没启动，也还没绑定项目目录 —— 打开插件弹窗，用「绑定本地项目目录」连一次，之后就能离线收藏了');
    e.code = 'NO_DIR';
    throw e;
  }
  const perm = await LM_FS.permission(handle, false);   // service worker 里不能弹授权
  if (perm !== 'granted') {
    const e = new Error('项目目录的访问授权已失效，请打开插件弹窗点一下「重新连接项目文件夹」');
    e.code = 'NEED_AUTH';
    throw e;
  }
  await LM_FS.append(handle, record);
  await rememberPending(record);
  await pushHistory({
    title: record.album || record.tracks[0].title,
    mode: record.mode,
    added: record.tracks.length,
    skipped: 0,
    total: record.coll_total,
    via: 'inbox',
  });
  return {
    added: record.tracks.map(() => 0),   // 与在线通道保持相同的返回形状
    skipped: 0,
    mode: record.mode,
    album: record.album,
    total: record.coll_total,
    via: 'inbox',
    queued: record.tracks.length,
  };
}

async function collect(url, mode) {
  if (await pingService()) {
    try {
      return await collectViaService(url, mode);
    } catch (e) {
      if (e.code) throw e;
      // 服务在跑但这次失败（比如 B 站接口抖了），退到离线通道再试一次
      console.warn('[local music] 在线收藏失败，改用离线通道：', e.message);
    }
  }
  return collectViaInbox(url, mode);
}

/* ---------- 探测 / 状态 ---------- */

async function inspect(url) {
  if (await pingService()) {
    try {
      const d = await api(`/api/bili/inspect?url=${encodeURIComponent(url)}`);
      return { ...d, via: 'service' };
    } catch (e) {
      if (/无法识别链接/.test(e.message)) throw e;
    }
  }
  const meta = await fetchBiliMeta(url);
  const total = parseInt(meta.data.videos || 1, 10);
  return {
    bvid: meta.bvid,
    title: (meta.data.title || '').trim(),
    page: meta.page,
    total,
    multi: total > 1,
    via: 'local',
  };
}

async function status(bvid, page) {
  if (await pingService()) {
    try {
      const d = await api(`/api/bili/status?bvid=${bvid}&page=${page}`);
      return { ...d, via: 'service' };
    } catch (e) { /* 掉线了，退回本地标记 */ }
  }
  const { pendingKeys = [] } = await chrome.storage.local.get({ pendingKeys: [] });
  return {
    bvid,
    page,
    favorited: pendingKeys.includes(keyOf(bvid, page)),
    collected: pendingKeys.filter((k) => k.startsWith(bvid + ':')).length,
    coll_total: 0,
    album: '',
    via: 'pending',
  };
}

async function probe() {
  const service = await pingService(800);
  let dir = null;
  let perm = 'none';
  let pending = 0;
  try {
    const handle = await LM_FS.loadHandle();
    if (handle) {
      dir = await LM_FS.describe(handle);
      perm = await LM_FS.permission(handle, false);
      if (perm === 'granted') pending = await LM_FS.pendingCount(handle);
    }
  } catch (e) {
    dir = { ok: false, error: e.message };
  }
  return { service, dir, perm, pending };
}

/* ---------- 反馈 ---------- */

async function flashBadge(ok) {
  try {
    await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
    await chrome.action.setBadgeBackgroundColor({ color: ok ? '#2fbf71' : '#e5484d' });
    setTimeout(() => { chrome.action.setBadgeText({ text: '' }); }, 4000);
  } catch (e) { /* 忽略 */ }
}

async function toastTab(tabId, ok, text) {
  if (!tabId) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'toast', ok, text }); } catch (e) { /* 页面没有注入脚本 */ }
}

/* ---------- 消息路由 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'api': {
          const data = await api(msg.path, msg.opts || {});
          sendResponse({ ok: true, data });
          break;
        }
        case 'inspect': {
          sendResponse({ ok: true, data: await inspect(msg.url) });
          break;
        }
        case 'collect': {
          const data = await collect(msg.url, msg.mode || 'auto');
          flashBadge(true);
          sendResponse({ ok: true, data });
          break;
        }
        case 'status': {
          sendResponse({ ok: true, data: await status(msg.bvid, msg.page || 1) });
          break;
        }
        case 'probe': {
          sendResponse({ ok: true, data: await probe() });
          break;
        }
        case 'dir-changed': {
          sendResponse({ ok: true, data: await probe() });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: humanError(e), code: e.code || null });
    }
  })();
  return true; // 异步响应
});

/* ---------- 右键菜单 ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'lm-collect',
      title: '收藏到 local music',
      contexts: ['page', 'link', 'video'],
      documentUrlPatterns: ['*://*.bilibili.com/*', '*://b23.tv/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl || '';
  if (!url) return;
  const { defaultMode } = await getSettings();
  try {
    const d = await collect(url, defaultMode);
    const n = (d.added || []).length;
    const tail = d.via === 'inbox' ? '（服务没启动，已排队等同步）' : '';
    const text = n > 0
      ? (d.mode === 'collection'
        ? `已收藏《${d.album || ''}》共 ${n} 首${tail}`
        : (d.total > 1 ? `已收藏这一集（合集 ${n + (d.skipped || 0)}/${d.total}）${tail}` : `已收藏${tail}`))
      : (d.via === 'inbox' ? '已排队等同步' : '曲库里已经有了，没有重复收藏');
    flashBadge(true);
    await toastTab(tab && tab.id, true, text);
  } catch (e) {
    flashBadge(false);
    await toastTab(tab && tab.id, false, e.message);
  }
});
