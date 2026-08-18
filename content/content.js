// Her sitede çalışan content script.
//
// Güvenlik notları:
//  - Panel artık KAPALI Shadow DOM içinde. Sayfanın kendi JavaScript'i (ya da başka
//    bir eklenti) document.body.innerText tarayarak panelin içeriğini göremez.
//  - Bu script'te hiç anahtar materyali tutulmuyor. Kişiler ve şifreleme/çözme
//    işlemleri arka plan servis çalışanından mesajla isteniyor.
//  - Kasa kilitliyken panel parola sorar; parola arka plana gider, burada saklanmaz.

(function () {
  if (window.__pgpContentLoaded) return;
  window.__pgpContentLoaded = true;

  const PGP_BEGIN = '-----BEGIN PGP MESSAGE-----';
  const PGP_END = '-----END PGP MESSAGE-----';
  const LOG = '[PGP]';

  const AUTO_SEND_HOSTS = ['web.whatsapp.com', 'discord.com', 'app.slack.com', 'web.telegram.org'];
  const autoSend = AUTO_SEND_HOSTS.some(h => location.host.endsWith(h));
  const isWhatsApp = location.host.endsWith('web.whatsapp.com');

  let host = null;        // sayfaya eklenen kapsayıcı
  let shadow = null;      // kapalı shadow root
  let pinned = false;
  let hideTimer = null;
  let lastEditable = null;
  let contactsCache = {};
  let vaultLocked = false;
  let enabled = true;
  let draggedThisSession = false;
  let handled = new WeakSet();
  let suspendScan = false;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (sel) => (shadow ? shadow.querySelector(sel) : null);

  // ============================================================
  //  Eklenti bağlamı korumalı yardımcılar
  // ============================================================

  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!extAlive()) return resolve({});
      try {
        chrome.storage.local.get(keys, (d) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(d || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  function bg(msg) {
    return new Promise((resolve) => {
      if (!extAlive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ============================================================
  //  Yazma alanı tespiti
  // ============================================================

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('#pgp-host')) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const inputType = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url'].includes(inputType);
    }
    return el.isContentEditable === true;
  }

  document.addEventListener('focusin', (e) => {
    if (!enabled) return;
    if (isEditable(e.target)) {
      lastEditable = e.target;
      draggedThisSession = false;
      buildRoot();
      anchorToEditable();
      refreshPanel();
    }
  }, true);

  const PANEL_W = 320;
  const PANEL_H = 380;

  function anchorToEditable() {
    if (!host || !lastEditable || draggedThisSession) return;
    if (!document.contains(lastEditable)) return;
    const r = lastEditable.getBoundingClientRect();
    if (!r.width && !r.height) return;

    let left = r.right - PANEL_W;
    left = Math.max(8, Math.min(left, window.innerWidth - PANEL_W - 8));
    let bottom = window.innerHeight - r.top + 8;
    bottom = Math.max(8, Math.min(bottom, Math.max(8, window.innerHeight - PANEL_H)));

    host.style.left = left + 'px';
    host.style.bottom = bottom + 'px';
    host.style.right = 'auto';
    host.style.top = 'auto';
  }

  // ============================================================
  //  Konuşma kimliği
  // ============================================================

  function waHeaderName() {
    const main = document.querySelector('#main');
    const header = main && main.querySelector('header');
    if (!header) return null;
    return (header.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || null;
  }

  function conversationKey() {
    if (isWhatsApp) return 'web.whatsapp.com|' + (waHeaderName() || 'unknown');
    return location.host + '|' + location.pathname;
  }

  function conversationLabel() {
    if (isWhatsApp) { const n = waHeaderName(); if (n) return n; }
    if (location.host.endsWith('discord.com')) {
      const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/^Discord\s*\|\s*/, '');
      if (title) return title;
    }
    return location.host;
  }

  // ============================================================
  //  Metin yerleştirme
  // ============================================================

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function insertIntoTarget(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, text);
      await sleep(80);
      return;
    }
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(40);

    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    await sleep(220);

    if (!(el.innerText || '').trim()) {
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      await sleep(180);
    }
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13
      }));
    }
  }

  // ============================================================
  //  Sayfadaki PGP bloklarını bulma / çözme
  // ============================================================

  function isInsideEditable(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.id === 'pgp-host') return true;
      if (n.isContentEditable === true) return true;
      if (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT') return true;
      n = n.parentElement;
    }
    return false;
  }

  function containsEditable(el) {
    if (!el || !el.querySelectorAll) return false;
    const eds = el.querySelectorAll('[contenteditable], textarea, input');
    for (const e of eds) {
      if (e.isContentEditable === true || e.tagName === 'TEXTAREA' || e.tagName === 'INPUT') return true;
    }
    return false;
  }

  function touchesEditable(el) { return isInsideEditable(el) || containsEditable(el); }

  const PREVIEW_SELECTORS = [
    '#pane-side', '[data-testid="chat-list"]', '[role="navigation"]', '.zA'
  ];

  function isPreviewArea(el) {
    let n = el, hops = 0;
    while (n && n.nodeType === 1 && hops < 12) {
      for (const sel of PREVIEW_SELECTORS) {
        try { if (n.matches && n.matches(sel)) return true; } catch (e) {}
      }
      const cs = getComputedStyle(n);
      if (cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none') return true;
      n = n.parentElement;
      hops++;
    }
    return false;
  }

  function extractAllPgpBlocks(text) {
    const blocks = [];
    let from = 0;
    while (true) {
      const s = text.indexOf(PGP_BEGIN, from);
      if (s === -1) break;
      const e = text.indexOf(PGP_END, s);
      if (e === -1) break;
      blocks.push(text.slice(s, e + PGP_END.length));
      from = e + PGP_END.length;
    }
    return blocks;
  }

  function extractPgpBlock(text) {
    const b = extractAllPgpBlocks(text);
    return b.length ? b[0] : null;
  }

  function findPgpContainers() {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      if (!v || v.indexOf('BEGIN PGP MESSAGE') === -1) continue;
      if (isInsideEditable(node.parentElement)) continue;

      let el = node.parentElement, hops = 0;
      while (el && hops < 15) {
        if (touchesEditable(el)) { el = null; break; }
        const t2 = el.innerText || '';
        if (t2.includes(PGP_BEGIN) && t2.includes(PGP_END)) break;
        el = el.parentElement;
        hops++;
      }
      if (el && el !== document.body && !touchesEditable(el) && !isPreviewArea(el) && !found.includes(el)) {
        found.push(el);
      }
    }
    return found;
  }

  function nearEditable(node) {
    let n = node, hops = 0;
    while (n && n.nodeType === 1 && hops < 8) {
      if (touchesEditable(n)) return true;
      n = n.parentElement;
      hops++;
    }
    return false;
  }

  function shouldNotBeThere(node) { return nearEditable(node) || isPreviewArea(node); }

  function cleanupLeaks() {
    document.querySelectorAll('.pgp-plaintext, .pgp-badge').forEach((n) => {
      if (shouldNotBeThere(n.parentElement)) n.remove();
    });
    document.querySelectorAll('.pgp-ciphertext-hidden').forEach((n) => {
      if (shouldNotBeThere(n)) n.classList.remove('pgp-ciphertext-hidden');
    });
    document.querySelectorAll('.pgp-status-dot').forEach((n) => {
      if (shouldNotBeThere(n.parentElement)) n.remove();
    });
  }

  function setBadge(el, state, text) {
    let badge = el.querySelector(':scope > .pgp-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'pgp-badge';
      el.insertBefore(badge, el.firstChild);
    }
    badge.classList.remove('pgp-badge-red', 'pgp-badge-yellow');
    badge.classList.add('pgp-badge-' + state);
    badge.textContent = text;
  }

  function clearBadge(el) {
    const b = el.querySelector(':scope > .pgp-badge');
    if (b) b.remove();
  }

  function setDot(el, state, title) {
    let dot = el.querySelector(':scope > .pgp-status-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'pgp-status-dot';
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.appendChild(dot);
    }
    dot.classList.remove('pgp-dot-red', 'pgp-dot-green', 'pgp-dot-yellow');
    dot.classList.add('pgp-dot-' + state);
    dot.title = title || '';
  }

  async function processContainer(el) {
    if (!enabled || handled.has(el)) return;
    if (touchesEditable(el) || isPreviewArea(el)) return;
    const blocks = extractAllPgpBlocks(el.innerText || '');
    if (!blocks.length) return;

    const texts = [];
    let sawNoKey = false, sawLocked = false;
    for (const b of blocks) {
      const r = await bg({ type: 'BG_DECRYPT', armored: b });
      if (!enabled) return;
      if (!r) continue;
      if (r.locked) { sawLocked = true; continue; }
      if (r.noKey) { sawNoKey = true; continue; }
      if (r.ok) texts.push(r.text);
    }

    if (sawLocked && !texts.length) {
      setDot(el, 'yellow', t('dot_locked'));
      setBadge(el, 'yellow', t('badge_locked'));
      return;   // kilit açılınca yeniden denenecek (handled'a eklemiyoruz)
    }
    if (sawNoKey && !texts.length) {
      setDot(el, 'red', t('dot_no_key'));
      setBadge(el, 'red', t('badge_no_key'));
      return;
    }
    if (!texts.length) {
      handled.add(el);
      setDot(el, 'yellow', t('dot_failed'));
      setBadge(el, 'yellow', t('badge_not_for_you'));
      return;
    }

    handled.add(el);
    clearBadge(el);
    setDot(el, 'green', t('dot_ok'));

    const inner = Array.from(el.querySelectorAll('*')).filter(c => {
      const tx = c.innerText || '';
      return tx.includes(PGP_BEGIN) && tx.includes(PGP_END);
    });
    const cipherHost = inner.length ? inner[inner.length - 1] : null;
    if (cipherHost) cipherHost.classList.add('pgp-ciphertext-hidden');

    const plain = document.createElement('div');
    plain.className = 'pgp-plaintext';
    plain.textContent = texts.join('\n\n');
    (cipherHost && cipherHost.parentElement ? cipherHost.parentElement : el).appendChild(plain);
  }

  function scanForPgp() {
    if (!enabled || !document.body || suspendScan) return;
    cleanupLeaks();
    if (document.body.textContent.indexOf('BEGIN PGP MESSAGE') === -1) return;
    buildRoot();
    findPgpContainers().forEach(el => processContainer(el).catch(() => {}));
  }

  // ============================================================
  //  Panel — kapalı Shadow DOM içinde
  // ============================================================

  const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.wrap { display:flex; flex-direction:column; align-items:flex-end; gap:8px; width:320px; }
.dot { width:11px; height:11px; border-radius:50%; flex:none; }
.dot.red{background:#ff4d4f} .dot.yellow{background:#ffb020} .dot.green{background:#00d48a}
#launcher {
  position:relative; width:38px; height:38px; border-radius:50%;
  border:1px solid #2f3b43; background:#202c33; color:#e9edef; font-size:17px;
  cursor:grab; box-shadow:0 4px 14px rgba(0,0,0,.45);
  display:flex; align-items:center; justify-content:center; padding:0; order:2;
  transition:transform .12s ease, background .12s ease;
}
#launcher:hover{background:#2a3942; transform:scale(1.06)}
#launcher .dot{position:absolute; top:-3px; right:-3px; border:2px solid #202c33; width:12px; height:12px}
#panel {
  display:none; width:320px; background:#202c33; border:1px solid #2f3b43;
  border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.55); color:#e9edef;
  overflow:hidden; order:1;
}
.wrap.open #panel, .wrap.pinned #panel { display:block; }
.head { display:flex; align-items:center; gap:8px; padding:8px 10px; background:#111b21;
  border-bottom:1px solid #2f3b43; font-size:12px; user-select:none; }
.title{font-weight:700}
.target{flex:1; min-width:0; color:#aebac1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.iconbtn{background:transparent; border:none; color:#8696a0; cursor:pointer; font-size:13px; padding:2px 4px; opacity:.6}
.wrap.pinned #pin{opacity:1; color:#00a884}
.tabs{display:flex; gap:4px; padding:6px 10px 0}
.tab{flex:1; background:#2a3942; border:none; color:#8696a0; padding:5px 0; border-radius:6px;
  font-size:11px; cursor:pointer}
.tab.active{background:#00a884; color:#fff; font-weight:600}
.body{padding:8px 10px 10px}
select, textarea, input {
  width:100%; background:#2a3942; border:1px solid #3a4a54; border-radius:8px;
  color:#e9edef; padding:7px 9px; font-size:13px; outline:none;
}
select{margin-bottom:8px; font-size:12px}
textarea{resize:vertical}
textarea:focus, select:focus, input:focus{border-color:#00a884}
button.act{width:100%; margin-top:6px; padding:7px; border:none; border-radius:8px;
  background:#2a3942; color:#e9edef; font-size:12px; cursor:pointer}
button.primary{background:#00a884; color:#fff; font-weight:600}
button.act:hover{filter:brightness(1.12)}
.status{margin-top:6px; font-size:11px; min-height:14px; color:#8696a0}
.status.ok{color:#00d48a} .status.err{color:#ff6b6b}
#readout{margin-top:8px; font-size:12.5px; white-space:pre-wrap; word-break:break-word;
  max-height:150px; overflow-y:auto; padding:6px 8px; border-radius:8px; background:rgba(0,0,0,.2)}
#readout:empty{display:none}
#readout.ok{border:1px solid #00a884} #readout.err{border:1px solid #ff6b6b; color:#ff9b9b}
#readimg:empty{display:none}
#readimg{margin-top:8px}
#readimg img{display:block; max-width:100%; max-height:220px; border-radius:8px; border:1px solid #00a884; margin-bottom:6px}
.lockbox{padding:12px 10px; text-align:center}
.lockbox .big{font-size:22px; margin-bottom:6px}
.lockbox p{font-size:11.5px; color:#8696a0; margin:0 0 8px}
.hidden{display:none !important}
`;

  function buildRoot() {
    if (!enabled || document.getElementById('pgp-host')) return;

    host = document.createElement('div');
    host.id = 'pgp-host';
    host.style.cssText = 'position:fixed;right:20px;bottom:100px;z-index:2147483000;width:320px;pointer-events:none;';
    document.body.appendChild(host);

    // KAPALI shadow root: sayfa JS'i host.shadowRoot ile içeri bakamaz
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.style.pointerEvents = 'none';
    wrap.innerHTML = `
      <button id="launcher" style="pointer-events:auto" title="${t('launcher_title')}">
        <span>🔒</span><span class="dot red" id="ldot"></span>
      </button>
      <div id="panel" style="pointer-events:auto">
        <div class="head" title="${t('panel_drag')}">
          <span class="title">🔒 PGP</span>
          <span class="target" id="convname">—</span>
          <button class="iconbtn" id="lock" title="${t('btn_lock_now')}">🔓</button>
          <button class="iconbtn" id="pin" title="${t('panel_pin')}">📌</button>
        </div>

        <div id="lockview" class="lockbox hidden">
          <div class="big">🔒</div>
          <p>${t('locked_hint')}</p>
          <input id="lockpass" type="password" placeholder="${t('unlock_ph')}" />
          <button class="act primary" id="unlock">${t('btn_unlock')}</button>
          <div class="status" id="lockstatus"></div>
        </div>

        <div id="mainview">
          <div class="tabs">
            <button class="tab active" data-mode="write">${t('tab_write')}</button>
            <button class="tab" data-mode="read">${t('tab_read')}</button>
          </div>
          <div class="body">
            <div id="mwrite">
              <select id="recipient"><option value="">${t('select_recipient')}</option></select>
              <textarea id="msg" rows="3" placeholder="${t('msg_ph')}"></textarea>
              <button class="act" id="attach">${t('attach_image')}</button>
              <input id="imgfile" type="file" accept="image/*" class="hidden" />
              <div class="status" id="wstatus"></div>
            </div>
            <div id="mread" class="hidden">
              <button class="act" id="selbtn">${t('decrypt_selection')}</button>
              <textarea id="readin" rows="3" placeholder="${t('read_ph')}"></textarea>
              <button class="act primary" id="readbtn">${t('btn_decrypt')}</button>
              <button class="act" id="filebtn">${t('read_file_btn')}</button>
              <input id="readfile" type="file" class="hidden" />
              <div id="readout"></div>
              <div id="readimg"></div>
            </div>
          </div>
        </div>
      </div>`;
    shadow.appendChild(wrap);

    const launcher = q('#launcher');
    const panel = q('#panel');

    const open = () => { clearTimeout(hideTimer); wrap.classList.add('open'); refreshPanel(); };
    const scheduleClose = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (pinned) return;
        if (shadow && shadow.activeElement) return;
        wrap.classList.remove('open');
      }, 400);
    };

    launcher.addEventListener('mouseenter', open);
    panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    wrap.addEventListener('mouseleave', scheduleClose);

    launcher.addEventListener('click', (e) => {
      e.preventDefault();
      pinned = !pinned;
      wrap.classList.toggle('pinned', pinned);
      if (pinned) open(); else scheduleClose();
    });

    q('#pin').addEventListener('click', () => {
      pinned = !pinned;
      wrap.classList.toggle('pinned', pinned);
      if (!pinned) scheduleClose();
    });

    q('#lock').addEventListener('click', async () => {
      await bg({ type: 'BG_VAULT_LOCK' });
      refreshPanel();
    });

    shadow.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        shadow.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const write = btn.dataset.mode === 'write';
        q('#mwrite').classList.toggle('hidden', !write);
        q('#mread').classList.toggle('hidden', write);
      });
    });

    q('#msg').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); panelSend(); }
    });

    q('#recipient').addEventListener('change', (e) => {
      bg({ type: 'BG_SET_CONV', key: conversationKey(), contactId: e.target.value });
      refreshPanel();
    });

    q('#selbtn').addEventListener('click', () => {
      const sel = (window.getSelection() || '').toString();
      if (!sel.trim()) return showReadOut(t('select_text_first'), true);
      q('#readin').value = sel;
      manualDecrypt();
    });
    q('#readbtn').addEventListener('click', manualDecrypt);

    q('#attach').addEventListener('click', () => q('#imgfile').click());
    q('#imgfile').addEventListener('change', (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (f) encryptAndAttachImage(f);
    });

    q('#filebtn').addEventListener('click', () => q('#readfile').click());
    q('#readfile').addEventListener('change', (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (f) decryptEncryptedFile(f);
    });

    q('#unlock').addEventListener('click', doUnlock);
    q('#lockpass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doUnlock(); }
    });

    makeDraggable(host, launcher);
  }

  function destroyRoot() {
    const el = document.getElementById('pgp-host');
    if (el) el.remove();
    host = null; shadow = null; pinned = false;
  }

  async function doUnlock() {
    const pass = q('#lockpass').value;
    const st = q('#lockstatus');
    st.textContent = '…'; st.className = 'status';
    const r = await bg({ type: 'BG_VAULT_UNLOCK', password: pass });
    if (r && r.ok) {
      q('#lockpass').value = '';
      st.textContent = '';
      handled = new WeakSet();
      document.querySelectorAll('.pgp-badge').forEach(n => n.remove());
      document.querySelectorAll('.pgp-status-dot').forEach(n => n.remove());
      await refreshPanel();
      scanForPgp();
    } else {
      st.textContent = t('wrong_password');
      st.className = 'status err';
    }
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, sl = 0, stp = 0, dragging = false, moved = false;
    handle.addEventListener('mousedown', (e) => {
      const r = el.getBoundingClientRect();
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
      sx = e.clientX; sy = e.clientY; sl = r.left; stp = r.top;
      dragging = true; moved = false;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - sx) > 3 || Math.abs(e.clientY - sy) > 3) moved = true;
      el.style.left = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - PANEL_W)) + 'px';
      el.style.top = Math.max(0, Math.min(stp + e.clientY - sy, window.innerHeight - 60)) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        draggedThisSession = true;
        const l = q('#launcher');
        if (l) { l.style.pointerEvents = 'none'; setTimeout(() => { l.style.pointerEvents = 'auto'; }, 120); }
      }
    });
  }

  function wstatus(msg, kind) {
    const el = q('#wstatus');
    if (el) { el.textContent = msg || ''; el.className = 'status' + (kind ? ' ' + kind : ''); }
  }

  function showReadOut(text, isError) {
    const out = q('#readout');
    if (!out) return;
    out.textContent = text;
    out.className = isError ? 'err' : 'ok';
  }

  async function refreshPanel() {
    if (!shadow) return;
    const st = await bg({ type: 'BG_STATE' });
    if (!st) return;

    vaultLocked = st.vault && st.vault.locked;
    contactsCache = st.contacts || {};

    q('#lockview').classList.toggle('hidden', !vaultLocked);
    q('#mainview').classList.toggle('hidden', !!vaultLocked);
    q('#lock').style.display = (st.vault && st.vault.enabled && !vaultLocked) ? '' : 'none';

    const nameEl = q('#convname');
    if (nameEl) nameEl.textContent = conversationLabel();

    const dot = q('#ldot');
    dot.classList.remove('red', 'yellow', 'green');

    if (vaultLocked) {
      dot.classList.add('yellow');
      dot.title = t('dot_locked');
      return;
    }

    const conv = await bg({ type: 'BG_GET_CONV' });
    const chosen = (conv && conv.convMap ? conv.convMap[conversationKey()] : '') || '';

    const sel = q('#recipient');
    const prev = sel.value;
    sel.innerHTML = '<option value="">' + t('select_recipient') + '</option>';
    Object.entries(contactsCache).forEach(([id, c]) => {
      const o = document.createElement('option');
      o.value = id; o.textContent = c.name || id;
      sel.appendChild(o);
    });
    sel.value = prev || chosen || '';

    if (!st.hasOwnKey) { dot.classList.add('red'); dot.title = t('dot_no_own_key'); }
    else if (!sel.value) { dot.classList.add('yellow'); dot.title = t('dot_no_recipient'); }
    else { dot.classList.add('green'); dot.title = t('dot_ready'); }
  }

  async function panelSend() {
    const input = q('#msg');
    const text = input.value;
    if (!text.trim()) return;

    const contactId = q('#recipient').value;
    if (!contactId) return wstatus(t('pick_recipient_first'), 'err');
    if (!lastEditable || !document.contains(lastEditable)) return wstatus(t('no_target_box'), 'err');

    wstatus(t('encrypting'));
    const res = await bg({ type: 'BG_ENCRYPT', text, contactId });
    if (res && res.locked) { await refreshPanel(); return wstatus(t('badge_locked'), 'err'); }
    if (!res || !res.ok) return wstatus(t('encrypt_failed') + ((res && res.error) || '-'), 'err');

    suspendScan = true;
    try {
      await insertIntoTarget(lastEditable, res.armored);
      if (autoSend) { await sleep(120); pressEnter(lastEditable); wstatus(t('sent'), 'ok'); }
      else wstatus(t('placed'), 'ok');
      input.value = '';
      setTimeout(() => wstatus(''), 3000);
    } catch (e) {
      wstatus(t('insert_failed') + e.message, 'err');
    } finally {
      await sleep(600);
      suspendScan = false;
    }
  }

  async function manualDecrypt() {
    const input = q('#readin');
    const raw = input.value.trim();
    if (!raw) return showReadOut(t('no_text_to_decrypt'), true);
    const block = extractPgpBlock(raw) || raw;
    showReadOut(t('decrypting'), false);
    const res = await bg({ type: 'BG_DECRYPT', armored: block });
    if (!res) return showReadOut(t('ext_unreachable'), true);
    if (res.locked) { await refreshPanel(); return showReadOut(t('badge_locked'), true); }
    if (res.noKey) return showReadOut(t('no_own_key'), true);
    if (res.error) return showReadOut(t('decrypt_failed') + res.error, true);
    showReadOut(res.text, false);
  }

  // ---------- Resim / dosya ----------

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = r.result; resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function base64ToBlob(b64s, mime) {
    const bin = atob(b64s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function attachFileToPage(file) {
    try {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter(i => !i.disabled && !i.closest('#pgp-host'));
      for (const inp of inputs) {
        const dt = new DataTransfer();
        dt.items.add(file);
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        if (inp.files && inp.files.length) return true;
      }
    } catch (e) {}
    try {
      const target = (lastEditable && document.contains(lastEditable)) ? lastEditable : document.body;
      const dt = new DataTransfer();
      dt.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      return true;
    } catch (e) { return false; }
  }

  async function encryptAndAttachImage(file) {
    const contactId = q('#recipient').value;
    if (!contactId) return wstatus(t('pick_recipient_first'), 'err');

    wstatus(t('img_encrypting'));
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await bg({ type: 'BG_ENCRYPT_FILE', dataBase64, filename: file.name, contactId });
      if (res && res.locked) { await refreshPanel(); return wstatus(t('badge_locked'), 'err'); }
      if (!res || !res.ok) return wstatus(t('encrypt_failed') + ((res && res.error) || '-'), 'err');

      const outName = file.name + '.pgp';
      const blob = base64ToBlob(res.dataBase64, 'application/octet-stream');
      const encFile = new File([blob], outName, { type: 'application/octet-stream' });

      suspendScan = true;
      const attached = isWhatsApp ? false : attachFileToPage(encFile);
      setTimeout(() => { suspendScan = false; }, 800);

      if (attached) wstatus(t('img_attached'), 'ok');
      else { downloadBlob(blob, outName); wstatus(isWhatsApp ? t('img_downloaded_wa') : t('img_downloaded'), 'ok'); }
    } catch (e) {
      wstatus(t('encrypt_failed') + e.message, 'err');
    }
  }

  async function decryptEncryptedFile(file) {
    showReadOut(t('file_decrypting'), false);
    const imgBox = q('#readimg');
    if (imgBox) imgBox.innerHTML = '';
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await bg({ type: 'BG_DECRYPT_FILE', dataBase64 });
      if (!res) return showReadOut(t('ext_unreachable'), true);
      if (res.locked) { await refreshPanel(); return showReadOut(t('badge_locked'), true); }
      if (res.noKey) return showReadOut(t('no_own_key'), true);
      if (res.error) return showReadOut(t('decrypt_failed') + res.error, true);

      const name = res.filename || 'decrypted-file';
      const ext = (name.split('.').pop() || '').toLowerCase();
      const mimes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
      const mime = mimes[ext] || 'application/octet-stream';
      const blob = base64ToBlob(res.dataBase64, mime);

      showReadOut(t('file_decrypted') + name, false);
      if (imgBox) {
        if (mime.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(blob);
          imgBox.appendChild(img);
        }
        const dl = document.createElement('button');
        dl.className = 'act primary';
        dl.textContent = t('btn_save');
        dl.addEventListener('click', () => downloadBlob(blob, name));
        imgBox.appendChild(dl);
      }
    } catch (e) {
      showReadOut(t('decrypt_failed') + e.message, true);
    }
  }

  // ============================================================
  //  Açık / kapalı, dil, döngü
  // ============================================================

  function undoAllPageChanges() {
    destroyRoot();
    document.querySelectorAll('.pgp-status-dot').forEach(n => n.remove());
    document.querySelectorAll('.pgp-plaintext, .pgp-badge').forEach(n => n.remove());
    document.querySelectorAll('.pgp-ciphertext-hidden').forEach(n => n.classList.remove('pgp-ciphertext-hidden'));
    handled = new WeakSet();
  }

  async function applyEnabled() {
    const d = await storageGet(['pgp_enabled']);
    const next = d.pgp_enabled !== false;
    if (next === enabled && !next) return;
    enabled = next;
    if (!enabled) undoAllPageChanges(); else scanForPgp();
  }

  async function loadLang() {
    const d = await storageGet(['pgp_lang']);
    pgpSetLang(d.pgp_lang || 'en');
  }

  if (extAlive()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.vaultKey) { refreshPanel(); return; }
        if (area !== 'local') return;
        if (changes.pgp_enabled) applyEnabled();
        if (changes.pgp_lang) {
          pgpSetLang(changes.pgp_lang.newValue || 'en');
          destroyRoot(); buildRoot(); refreshPanel();
        }
        if (!enabled) return;
        if (changes.vault_blob || changes.contacts || changes.vault_enabled) {
          handled = new WeakSet();
          document.querySelectorAll('.pgp-badge').forEach(n => n.remove());
          refreshPanel();
          scanForPgp();
        }
      });
    } catch (e) {}
  }

  const observer = new MutationObserver(() => {
    if (!enabled) return;
    clearTimeout(window.__pgpScanTimer);
    window.__pgpScanTimer = setTimeout(scanForPgp, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  loadLang().then(applyEnabled).then(() => {
    setTimeout(scanForPgp, 1500);
    setInterval(() => {
      if (!extAlive()) return;
      applyEnabled();
      if (!enabled) return;
      scanForPgp();
      if (document.getElementById('pgp-host')) { anchorToEditable(); refreshPanel(); }
    }, 5000);
  });

  window.addEventListener('resize', anchorToEditable);
  console.log(LOG, 'loaded:', location.host, '| autosend:', autoSend);
})();
