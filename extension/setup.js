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
    const d = r.ok ? r.data : { service: false, dir: { status: 'none' }, outbox: 0 };
    const dir = d.dir || { status: 'none' };
    const outbox = d.outbox || 0;
    const dot = $('dot');
    const text = $('stateText');
    const info = $('dirInfo');

    dot.className = 'dot';
    // 按钮显隐统一在这里重置，各分支只负责把需要露出来的打开
    $('btnRegrant').classList.add('hidden');
    $('btnPick').className = 'btn primary big';
    $('btnClear').classList.add('hidden');

    const svcLine = d.service
      ? '本地服务正在运行，收藏会直接进曲库'
      : '本地服务未运行，收藏会先写进项目目录排队';
    const queueLine = outbox
      ? `插件里还排着 <b>${outbox}</b> 条收藏，local music 一起来就自动入库`
      : '';

    if (dir.status === 'ready') {
      dot.classList.add('ok');
      text.textContent = `已绑定：${dir.name}`;
      info.innerHTML = `${dir.desc} ｜ 待同步收藏 <b>${dir.pending || 0}</b> 条 ｜ ${svcLine}`
        + (queueLine ? `<br>${queueLine}` : '');
      $('btnClear').classList.remove('hidden');
    } else if (dir.status === 'need-auth') {
      dot.classList.add('warn');
      text.textContent = `需要重新授权：${dir.name}`;
      info.innerHTML = '目录还记着，只是浏览器把读写权限收回去了（'
        + 'File System Access 的授权不跨会话保留：把绑定页面关掉后，本次会话就得重新确认一次）。'
        + '<br>点「恢复读写权限」→ 在弹出的提示里选「<b>每次访问时都允许</b>」，点一次就够，不用重选文件夹。'
        + (queueLine ? `<br>${queueLine}` : '');
      $('btnRegrant').classList.remove('hidden');
      $('btnPick').className = 'btn ghost big';
      $('btnClear').classList.remove('hidden');
    } else if (dir.status === 'bad') {
      dot.classList.add('bad');
      text.textContent = '绑定的目录不可用';
      info.innerHTML = (dir.error || '请重新选择项目文件夹')
        + (queueLine ? `<br>${queueLine}` : '');
      $('btnClear').classList.remove('hidden');
    } else {
      text.textContent = '还没有绑定项目目录';
      info.innerHTML = (d.service
        ? '本地服务正在运行 —— 现在不绑定也能收藏；绑定后即使不启动服务也能收藏。'
        : '绑定后可以不启动 local music 也能收藏。就算一直不绑定，收藏也会排队在插件里，'
          + '等 local music 一启动就自动入库，一条都不会丢。')
        + (queueLine ? `<br>${queueLine}` : '');
    }
    return d;
  }

  // 权限失效时用这个，不必重新选文件夹
  $('btnRegrant').addEventListener('click', async () => {
    setLog('');
    try {
      const state = await LM_FS.reauthorize();
      if (state === 'granted') {
        const r = await send({ type: 'dir-changed' });
        const pending = r.ok ? r.data.pending : 0;
        setLog(`✓ 读写权限已恢复${pending ? `，当前有 ${pending} 条收藏等待同步` : ''}`, 'ok');
      } else {
        setLog('权限仍没拿到。可以点「选择 local music 项目文件夹」重新选一次。', 'err');
      }
      await render();
    } catch (e) {
      setLog('× ' + (e && e.message ? e.message : e), 'err');
    }
  });

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
