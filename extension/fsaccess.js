/* local music · 本地项目目录绑定（File System Access API）
 *
 * 让插件在没有启动本地服务时，也能把收藏直接写进项目目录里的
 * extension-inbox.jsonl，等项目启动后自动收进曲库。
 *
 * 共用方式：
 *   background（service worker）：importScripts('fsaccess.js')
 *   popup / setup 页面：<script src="fsaccess.js"></script>
 */

const LM_FS = (() => {
  const DB_NAME = 'localmusic-fs';
  const DB_VERSION = 1;
  const STORE = 'handles';
  const DIR_KEY = 'projectDir';
  const INBOX_NAME = 'extension-inbox.jsonl';

  /* ---------- IndexedDB：存目录句柄 ---------- */

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbRun(mode, fn) {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        if (req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          tx.oncomplete = () => resolve(undefined);
        }
      });
    } finally {
      db.close();
    }
  }

  const saveHandle = (h) => idbRun('readwrite', (s) => s.put(h, DIR_KEY));
  const loadHandle = () => idbRun('readonly', (s) => s.get(DIR_KEY));
  const dropHandle = () => idbRun('readwrite', (s) => s.delete(DIR_KEY));

  /* ---------- 目录识别 ---------- */

  async function describe(handle) {
    const names = new Set();
    try {
      for await (const [name] of handle.entries()) names.add(name);
    } catch (e) {
      return { ok: false, error: '读不了这个目录：' + (e.message || e) };
    }
    const isRoot = names.has('app.py') || (names.has('static') && names.has('requirements.txt'));
    if (isRoot) {
      return { ok: true, kind: 'root', name: handle.name, desc: '项目根目录' };
    }
    if (names.has('music.db') || names.has('covers')) {
      return { ok: true, kind: 'data', name: handle.name, desc: '数据目录' };
    }
    return {
      ok: false,
      error: '这看起来不是 local music 的文件夹。请选择项目根目录（含 app.py）或数据目录（含 music.db）',
    };
  }

  /* ---------- 权限 ---------- */

  // request=false 时只查询（service worker 里不能弹授权，必须传 false）
  async function permission(handle, request) {
    const opts = { mode: 'readwrite' };
    let state = await handle.queryPermission(opts);
    if (state === 'granted') return 'granted';
    if (request) {
      try { state = await handle.requestPermission(opts); } catch (e) { /* 无用户手势 */ }
    }
    return state;
  }

  /* ---------- 读写 ---------- */

  async function inboxDir(handle, create) {
    const info = await describe(handle);
    if (!info.ok) throw new Error(info.error);
    if (info.kind === 'data') return handle;
    return handle.getDirectoryHandle('data', { create: !!create });
  }

  async function append(handle, record) {
    const dir = await inboxDir(handle, true);
    const fh = await dir.getFileHandle(INBOX_NAME, { create: true });
    const size = (await fh.getFile()).size;
    const w = await fh.createWritable({ keepExistingData: true });   // 追加而非覆盖
    await w.seek(size);
    await w.write(JSON.stringify(record) + '\n');
    await w.close();
    return true;
  }

  async function pendingCount(handle) {
    try {
      const dir = await inboxDir(handle, false);
      const fh = await dir.getFileHandle(INBOX_NAME);
      const text = await (await fh.getFile()).text();
      return text.split('\n').filter((l) => l.trim()).length;
    } catch (e) {
      return 0;
    }
  }

  /* ---------- 状态判定（只"查"，绝不申请权限） ----------
   *
   * 重要：File System Access 的授权**不跨会话保留**。句柄能序列化进 IndexedDB，
   * 但同一来源的所有页面都关掉之后，浏览器就收回访问权：下次从 IndexedDB 取回
   * 句柄时 queryPermission() 返回 'prompt'。此时目录名还读得到（handle.name），
   * 但**列目录 / 读写都会抛错**。
   *
   * 所以必须"先查权限、再列目录"，否则权限只是过期也会被误判成"目录没了/没绑定"。
   *
   * 返回 status：
   *   none      还没有绑定过
   *   need-auth 句柄在，但这个会话还没拿到读写权限（点一次「恢复读写权限」即可）
   *   bad       目录真的用不了（被删/被移走/选错了文件夹）
   *   ready     正常可用
   */

  async function inspect(handle) {
    if (!handle) return { status: 'none' };
    let perm;
    try {
      perm = await permission(handle, false);
    } catch (e) {
      return { status: 'bad', name: handle.name || '', perm: 'unknown', error: '查询权限失败：' + (e.message || e) };
    }
    if (perm !== 'granted') {
      return { status: 'need-auth', name: handle.name || '（已记住的文件夹）', perm };
    }
    const info = await describe(handle);          // 里面已 try/catch，不会抛
    if (!info.ok) return { status: 'bad', name: handle.name || '', perm, error: info.error };
    return { status: 'ready', name: info.name, kind: info.kind, desc: info.desc, perm };
  }

  /* ---------- 重新授权（不用重选目录） ----------
   * 浏览器权限提示里如果选的是「仅本次允许」，重启浏览器后句柄还在但权限
   * 需要再确认一次。这时直接对已记住的句柄重新申请即可，不必重选文件夹。
   * 必须由用户点击触发，否则会被拒绝。 */

  async function reauthorize() {
    const h = await loadHandle();
    if (!h) throw new Error('还没有绑定目录，请先选择项目文件夹');
    return h.requestPermission({ mode: 'readwrite' });
  }

  /* ---------- 供页面调用：选择目录（必须由用户点击触发） ---------- */

  async function pick() {
    const handle = await window.showDirectoryPicker({
      id: 'localmusic-project',
      mode: 'readwrite',
      startIn: 'documents',
    });
    const info = await describe(handle);
    if (!info.ok) {
      const err = new Error(info.error);
      err.code = 'BAD_DIR';
      throw err;
    }
    await saveHandle(handle);
    return { ...info, handle };
  }

  return {
    INBOX_NAME,
    pick,
    inspect,
    reauthorize,
    describe,
    saveHandle,
    loadHandle,
    dropHandle,
    permission,
    append,
    pendingCount,
    inboxDir,
  };
})();
