/* local music · 绑定本地项目目录（设置页）
 *
 * 必须放在独立标签页里：扩展的 popup 一失去焦点就会被关掉，
 * 而系统文件夹选择框会让 popup 失焦，导致选完目录后 JS 已经没了。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: '无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function setLog(text, type) {
    const el = $('log');
    el.className = type || '';
    el.textContent = text || '';
  }

  async function render() {
    const r = await send({ type: 'probe' });
    const d = r.ok ? r.data : { service: false, dir: null, perm: 'none', pending: 0 };
    const dot = $('dot');
    const text = $('stateText');
    const info = $('dirInfo');

    dot.className = 'dot';
    if (d.dir && d.dir.ok && d.perm === 'granted') {
      dot.classList.add('ok');
      text.textContent = `已绑定：${d.dir.name}`;
      info.innerHTML = `${d.dir.desc} ｜ 待同步收藏 <b>${d.pending}</b> 条 ｜ `
        + (d.service
          ? '本地服务正在运行，收藏会直接进曲库'
          : '本地服务未运行，收藏会先写进项目目录排队');
      $('btnClear').classList.remove('hidden');
    } else if (d.dir && d.dir.ok) {
      dot.classList.add('warn');
      text.textContent = `需要重新授权：${d.dir.name}`;
      info.textContent = '目录还记着，但浏览器要求你确认一次读写权限 —— 点下面的按钮重新选择同一个文件夹即可。';
      $('btnClear').classList.remove('hidden');
    } else if (d.dir && d.dir.ok === false) {
      dot.classList.add('bad');
      text.textContent = '绑定的目录不可用';
      info.textContent = d.dir.error || '请重新选择项目文件夹';
      $('btnClear').classList.remove('hidden');
    } else {
      text.textContent = '还没有绑定项目目录';
      info.textContent = d.service
        ? '本地服务正在运行 —— 现在不绑定也能收藏；绑定后即使不启动服务也能收藏。'
        : '本地服务也没在运行 —— 绑定项目目录后，就能在 B 站随手收藏，等启动服务时自动入库。';
      $('btnClear').classList.add('hidden');
    }
    return d;
  }

  $('btnPick').addEventListener('click', async () => {
    setLog('');
    try {
      // 必须是点击后的第一个异步调用，否则会丢失用户手势，选择框弹不出来
      const info = await LM_FS.pick();
      const r = await send({ type: 'dir-changed' });
      const pending = r.ok ? r.data.pending : 0;
      setLog(`✓ 已绑定「${info.name}」（${info.desc}）`
        + (pending ? `，当前有 ${pending} 条收藏等待同步` : ''), 'ok');
      await render();
    } catch (e) {
      if (e && e.name === 'AbortError') { setLog('已取消选择'); return; }
      setLog('× ' + (e && e.message ? e.message : e), 'err');
    }
  });

  $('btnClear').addEventListener('click', async () => {
    await LM_FS.dropHandle();
    await send({ type: 'dir-changed' });
    setLog('已解除绑定', '');
    await render();
  });

  render();
})();
