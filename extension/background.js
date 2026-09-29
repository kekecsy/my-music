/* local music · B站收藏 —— 后台服务（MV3 service worker）
 *
 * 职责：
 *  1. 统一代理所有对本地服务的请求（扩展 origin + host_permissions，不受页面 CORS 限制）
 *  2. 本地服务没启动时的「离线收藏」，两级落点：
 *       ① 绑定了项目目录 → 直接写 data/extension-inbox.jsonl
 *       ② 没绑定 / 目录授权过期 → 排进插件自己的队列（chrome.storage.local），
 *          服务一恢复在线就自动回放成正常收藏
 *  3. 右键菜单「收藏到 local music」
 *  4. 收藏结果反馈（工具栏角标 + 转发给 B 站页面弹 toast）
 *
 * 关于目录授权：File System Access 的授权不跨会话保留 —— 同一来源的所有页面
 * 都关掉后，浏览器会收回访问权（句柄仍在，但 queryPermission() 变回 'prompt'）。
 * 所以离线通道必须有两级兜底，不能只在"写项目目录"这一条路上押注。
 */

importScripts('fsaccess.js');

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8790',
  defaultMode: 'auto', // auto / single / collection，右键菜单使用
};

const FLUSH_ALARM = 'lm-flush-outbox';

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
    const err = new Error(humanError(e));
    err.network = true;      // 用来区分"服务连不上"和"服务答了但业务失败"
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

/* ---------- 本地服务是否在跑 ----------
 * 只给弹窗的"连接状态"用。收藏 / 查询 / 回放都不靠它做前提判断，
 * 而是直接发请求、按失败原因分流 —— 少一次往返，也没有"误判离线"的窗口期。 */

async function pingOnce(timeout) {
  const { baseUrl } = await getSettings();
  try {
    const res = await fetch(baseUrl + '/api/ping', {
      signal: AbortSignal.timeout(timeout),
      cache: 'no-store',
    });
    return { ok: !!res.ok, why: 'http' };
  } catch (e) {
    const name = e && e.name;
    // AbortSignal.timeout() 抛 TimeoutError；手动 abort 抛 AbortError
    return { ok: false, why: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'refused' };
  }
}

async function pingService(timeout = 1500) {
  const first = await pingOnce(timeout);
  if (first.ok) return true;
  if (first.why !== 'timeout') return false;
  return (await pingOnce(Math.max(timeout * 3, 3000))).ok;
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

/* ---------- 离线队列（插件内兜底） ----------
 * 连不上服务、又写不进项目目录（没绑定 / 授权过期）时，把「链接 + 模式」排在
 * 插件自己的存储里。只要服务恢复在线，就回放成一次普通收藏 ——
 * 后端按 url 去重，重复提交安全，所以回放不需要额外对账。
 */

const OUTBOX_MAX = 300;
const OUTBOX_MAX_TRIES = 5;

async function outboxAll() {
  const { outbox = [] } = await chrome.storage.local.get({ outbox: [] });
  return Array.isArray(outbox) ? outbox : [];
}

async function outboxPush(item) {
  const list = await outboxAll();
  list.push(item);
  await chrome.storage.local.set({ outbox: list.slice(-OUTBOX_MAX) });
}

async function flushOutbox() {
  const list = await outboxAll();
  if (!list.length) return { flushed: 0, left: 0 };
  const left = [];
  let flushed = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    try {
      await api('/api/tracks', { method: 'POST', body: { url: it.url, mode: it.mode } });
      flushed++;
    } catch (e) {
      if (e.network) {
        // 服务还是不在，剩下的这次不用试了，原样留着等下一轮
        left.push(it, ...list.slice(i + 1));
        break;
      }
      const tries = (it.tries || 0) + 1;
      if (tries < OUTBOX_MAX_TRIES) left.push({ ...it, tries });
      else console.warn('[local music] 放弃回放：', it.url, e.message);
    }
  }
  await chrome.storage.local.set({ outbox: left });
  if (flushed) console.log(`[local music] 已把 ${flushed} 条排队收藏补进曲库`);
  return { flushed, left: left.length };
}

// 排进队列（并尽力标记绿点）。拿不到 B 站元数据也照排，回放时再解析。
async function queueOffline(url, mode) {
  const item = { url, mode, ts: Date.now(), tries: 0, title: '', bvid: '', page: 1, total: 0 };
  let count = 1;
  try {
    const meta = await fetchBiliMeta(url);
    item.title = (meta.data.title || '').trim();
    item.bvid = meta.bvid;
    item.page = meta.page;
    const record = buildRecord(meta, mode);
    item.total = record.coll_total;
    count = record.tracks.length;
    await rememberPending(record);
  } catch (e) {
    // 链接本身看不懂就没什么好排的了，直接把错误抛回去
    if (/识别不出/.test(e.message)) throw e;
  }
  await outboxPush(item);
  await pushHistory({
    title: item.title || url, mode, added: count, skipped: 0, total: item.total || 0, via: 'outbox',
  });
  return {
    added: new Array(count).fill(0),
    skipped: 0,
    mode,
    album: item.title,
    total: item.total,
    via: 'outbox',
    queued: count,
  };
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
    const e = new Error('还没绑定项目目录');
    e.code = 'NO_DIR';
    throw e;
  }
  const perm = await LM_FS.permission(handle, false);   // service worker 里不能弹授权
  if (perm !== 'granted') {
    const e = new Error('项目目录的读写授权已失效');
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
  // 直接发请求，而不是"先 ping 再发"：少一次往返，也少一个"明明在线却被判成离线"
  // 的窗口期。只有确定是网络错误才走离线通道，服务答了但业务失败就照实报错。
  try {
    return await collectViaService(url, mode);
  } catch (e) {
    if (!e.network) throw e;
    console.warn('[local music] 连不上本地服务，改用离线通道：', e.message);
  }
  await flushOutbox().catch(() => {});   // 顺手把积压的补上
  try {
    return await collectViaInbox(url, mode);
  } catch (e) {
    if (e.code === 'NO_DIR' || e.code === 'NEED_AUTH') {
      // 两级兜底：写不进项目目录就排进插件队列，绝不丢
      return queueOffline(url, mode);
    }
    throw e;
  }
}

/* ---------- 探测 / 状态 ---------- */

async function inspect(url) {
  try {
    const d = await api(`/api/bili/inspect?url=${encodeURIComponent(url)}`);
    return { ...d, via: 'service' };
  } catch (e) {
    if (!e.network) throw e;        // 服务答了但认不出链接 → 照实报错
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
  const queued = await outboxAll();
  if (queued.length) flushOutbox().catch(() => {});   // 不 await，别拖慢状态查询
  try {
    const d = await api(`/api/bili/status?bvid=${bvid}&page=${page}`);
    return { ...d, via: 'service' };
  } catch (e) {
    // 问不到才退回本地待同步标记（此时只有插件知道自己排过什么）
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
  let dir = { status: 'none' };
  try {
    const handle = await LM_FS.loadHandle();
    dir = await LM_FS.inspect(handle);          // 先查权限，再（有权限时才）列目录
    if (dir.status === 'ready') {
      dir.pending = await LM_FS.pendingCount(handle);
    }
  } catch (e) {
    dir = { status: 'bad', error: e.message };
  }
  const outbox = await outboxAll();
  return { service, dir, outbox: outbox.length };
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
        case 'flush-outbox': {
          sendResponse({ ok: true, data: await flushOutbox() });
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

/* ---------- 定时回放排队的收藏 ---------- */

function ensureFlushAlarm() {
  chrome.alarms.get(FLUSH_ALARM).then((a) => {
    if (!a) chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  }).catch(() => {});
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === FLUSH_ALARM) flushOutbox().catch(() => {});
});

chrome.runtime.onStartup.addListener(ensureFlushAlarm);

/* ---------- 右键菜单 ---------- */

chrome.runtime.onInstalled.addListener(() => {
  ensureFlushAlarm();
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
    const tail = d.via === 'inbox' ? '（服务没启动，已写进项目目录，启动后自动入库）'
      : (d.via === 'outbox' ? '（已排队在插件里，启动 local music 后自动入库）' : '');
    const text = n > 0
      ? (d.mode === 'collection'
        ? `已收藏《${d.album || ''}》共 ${d.queued || n} 首${tail}`
        : (d.total > 1 ? `已收藏这一集（合集 ${n + (d.skipped || 0)}/${d.total}）${tail}` : `已收藏${tail}`))
      : (d.via === 'inbox' || d.via === 'outbox' ? '已排队等同步' : '曲库里已经有了，没有重复收藏');
    flashBadge(true);
    await toastTab(tab && tab.id, true, text);
  } catch (e) {
    flashBadge(false);
    await toastTab(tab && tab.id, false, e.message);
  }
});
