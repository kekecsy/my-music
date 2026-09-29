/* local music · B站收藏 —— 后台服务（MV3 service worker）
 *
 * 职责：
 *  1. 统一代理所有对本地服务的请求（扩展 origin + host_permissions，不受页面 CORS 限制）
 *  2. 右键菜单「收藏到 local music」
 *  3. 收藏结果反馈（工具栏角标 + 转发给 B 站页面弹 toast）
 */

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
  if (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return '连不上 local music，请先启动服务（运行 start.sh）';
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

/* ---------- 收藏 + 历史 ---------- */

async function collectByUrl(url, mode) {
  const data = await api('/api/tracks', { method: 'POST', body: { url, mode } });
  const { favHistory = [] } = await chrome.storage.local.get({ favHistory: [] });
  favHistory.unshift({
    title: data.album || url,
    mode: data.mode,
    added: (data.added || []).length,
    skipped: data.skipped || 0,
    total: data.total || 0,
    time: Date.now(),
  });
  await chrome.storage.local.set({ favHistory: favHistory.slice(0, 8) });
  return data;
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
        case 'collect': {
          const data = await collectByUrl(msg.url, msg.mode || 'auto');
          flashBadge(true);
          sendResponse({ ok: true, data });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: humanError(e) });
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
    const d = await collectByUrl(url, defaultMode);
    const n = (d.added || []).length;
    const text = n > 0
      ? (d.mode === 'collection'
        ? `已收藏《${d.album || ''}》共 ${n} 首`
        : (d.total > 1 ? `已收藏这一集（合集 ${n + (d.skipped || 0)}/${d.total}）` : '已收藏'))
      : '曲库里已经有了，没有重复收藏';
    flashBadge(true);
    await toastTab(tab && tab.id, true, text);
  } catch (e) {
    flashBadge(false);
    await toastTab(tab && tab.id, false, e.message);
  }
});
