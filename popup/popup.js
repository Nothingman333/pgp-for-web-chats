// Popup — saf arayüz. Hiç kriptografi yapmaz, anahtar materyali görmez;
// her şeyi arka plan servis çalışanından mesajla ister.

const $ = (s) => document.querySelector(s);
const bg = (msg) => new Promise(r => chrome.runtime.sendMessage(msg, r));
const local = (k) => new Promise(r => chrome.storage.local.get(k, r));
const localSet = (o) => new Promise(r => chrome.storage.local.set(o, r));

let STATE = null;

function setStatus(el, msg, kind) {
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function download(filename, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsText(file);
  });
}

function errText(code) {
  const map = {
    short_password: 'err_short_password',
    wrong_password: 'err_wrong_password',
    no_contact: 'err_no_contact',
    needs_password: 'backup_protected'
  };
  return map[code] ? t(map[code]) : code;
}

// ============================================================
//  Çeviri
// ============================================================

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  $('#reset-type-hint').innerHTML = t('reset_type_hint', { word: t('reset_word') });
  $('#reset-word').placeholder = t('reset_word');
  const on = $('#toggle-enabled').checked;
  $('#toggle-label').textContent = on ? t('toggle_on') : t('toggle_off');
}

$('#lang-select').addEventListener('change', async (e) => {
  const lang = e.target.value;
  await localSet({ pgp_lang: lang });
  pgpSetLang(lang);
  // ÖNEMLİ: render() dili STATE'ten okur. Önce durumu tazelemezsek
  // eski dil geri yüklenir ve seçim hiç olmamış gibi görünür.
  await refreshState();
  render();
});

// ============================================================
//  Sekmeler
// ============================================================

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ============================================================
//  Ana render
// ============================================================

async function refreshState() {
  STATE = await bg({ type: 'BG_STATE' });
  return STATE;
}

function showView(id) {
  ['view-setup', 'view-locked', 'view-main'].forEach(v => { $('#' + v).hidden = (v !== id); });
}

async function render() {
  const st = STATE;
  if (!st) return;

  pgpSetLang(st.lang || 'en');
  $('#lang-select').value = st.lang || 'en';
  $('#toggle-enabled').checked = st.extEnabled;
  applyTranslations();

  // İlk kurulum ekranı: koruma hiç sorulmadıysa
  if (!st.setupSeen && !st.vault.enabled) { showView('view-setup'); return; }
  if (st.vault.enabled && st.vault.locked) { showView('view-locked'); return; }
  showView('view-main');

  // Anahtarım
  $('#keys-empty').hidden = st.hasOwnKey;
  $('#keys-present').hidden = !st.hasOwnKey;
  if (st.hasOwnKey) {
    $('#pubkey-out').value = st.publicKey || '';
    $('#key-fpr').textContent = st.fingerprint || '';
  }

  // Kişiler
  renderContacts(st.contacts || {});

  // Koruma
  const enabled = st.vault.enabled;
  $('#protection-state').innerHTML = '<span>' + t('protection_title') + '</span><b>' +
    (enabled ? t('protection_on') : t('protection_off')) + '</b>';
  $('#prot-off-box').hidden = enabled;
  $('#prot-on-box').hidden = !enabled;
  $('#lock-minutes').value = String(st.vault.lockMinutes);
}

function renderContacts(contacts) {
  const list = $('#contact-list');
  list.innerHTML = '';
  const entries = Object.entries(contacts);
  if (!entries.length) {
    const li = document.createElement('li');
    li.textContent = t('no_contacts');
    list.appendChild(li);
    return;
  }
  entries.forEach(([id, c]) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = c.name || id;
    li.appendChild(span);
    const del = document.createElement('button');
    del.textContent = t('btn_delete');
    del.addEventListener('click', async () => {
      await bg({ type: 'BG_DELETE_CONTACT', id });
      await refreshState(); render();
    });
    li.appendChild(del);
    list.appendChild(li);
  });
}

// ============================================================
//  İlk kurulum
// ============================================================

$('#btn-setup-enable').addEventListener('click', async () => {
  const p1 = $('#setup-pass').value, p2 = $('#setup-pass2').value;
  const st = $('#setup-status');
  if (!p1 || p1.length < 6) return setStatus(st, t('err_short_password'), 'err');
  if (p1 !== p2) return setStatus(st, t('pass_mismatch'), 'err');
  const r = await bg({ type: 'BG_VAULT_ENABLE', password: p1 });
  if (r && r.ok) { $('#setup-pass').value = ''; $('#setup-pass2').value = ''; await refreshState(); render(); }
  else setStatus(st, errText(r && r.error), 'err');
});

$('#btn-setup-skip').addEventListener('click', async () => {
  await bg({ type: 'BG_VAULT_SKIP_SETUP' });
  await refreshState(); render();
});

// ============================================================
//  Kilit açma
// ============================================================

async function doUnlock() {
  const r = await bg({ type: 'BG_VAULT_UNLOCK', password: $('#unlock-pass').value });
  if (r && r.ok) { $('#unlock-pass').value = ''; await refreshState(); render(); }
  else setStatus($('#unlock-status'), t('err_wrong_password'), 'err');
}
$('#btn-unlock').addEventListener('click', doUnlock);
$('#unlock-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });

// ============================================================
//  Anahtarım
// ============================================================

$('#btn-generate').addEventListener('click', async () => {
  const st = $('#keys-status');
  setStatus(st, t('generating'));
  $('#btn-generate').disabled = true;
  const r = await bg({ type: 'BG_GENERATE_KEY' });
  $('#btn-generate').disabled = false;
  if (r && r.ok) { setStatus(st, t('key_created'), 'ok'); await refreshState(); render(); }
  else setStatus(st, errText(r && r.error), 'err');
});

$('#btn-copy-pub').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#pubkey-out').value);
  setStatus($('#keys-status'), t('copied'), 'ok');
});

$('#btn-download-pub').addEventListener('click', () => {
  download('my-public-key.asc', $('#pubkey-out').value);
});

$('#btn-delete-keys').addEventListener('click', async () => {
  if (!confirm(t('confirm_delete_keys'))) return;
  await bg({ type: 'BG_DELETE_KEYS' });
  setStatus($('#keys-status'), t('keys_deleted'));
  await refreshState(); render();
});

// ============================================================
//  Kişiler
// ============================================================

$('#contact-pubkey-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    $('#contact-pubkey').value = (await readFile(f)).trim();
    setStatus($('#contact-status'), t('file_read'));
  } catch (err) { setStatus($('#contact-status'), t('file_read_error') + err.message, 'err'); }
});

$('#btn-save-contact').addEventListener('click', async () => {
  const st = $('#contact-status');
  const name = $('#contact-name').value.trim();
  const pub = $('#contact-pubkey').value.trim();
  if (!name) return setStatus(st, t('enter_contact_name'), 'err');
  if (!pub.includes('BEGIN PGP PUBLIC KEY')) return setStatus(st, t('enter_valid_key'), 'err');
  const r = await bg({ type: 'BG_SAVE_CONTACT', id: 'c_' + Date.now().toString(36), name, publicKey: pub });
  if (r && r.ok) {
    setStatus(st, t('contact_saved'), 'ok');
    $('#contact-name').value = ''; $('#contact-pubkey').value = ''; $('#contact-pubkey-file').value = '';
    await refreshState(); render();
  } else setStatus(st, t('invalid_key') + errText(r && r.error), 'err');
});

$('#btn-self-test').addEventListener('click', async () => {
  const st = $('#contact-status');
  if (!STATE.publicKey) return setStatus(st, t('need_own_key_first'), 'err');
  const r = await bg({ type: 'BG_SAVE_CONTACT', id: 'c_self', name: t('self_name'), publicKey: STATE.publicKey });
  if (r && r.ok) { setStatus(st, t('self_added'), 'ok'); await refreshState(); render(); }
  else setStatus(st, errText(r && r.error), 'err');
});

// ============================================================
//  Yedek
// ============================================================

const exportToggle = $('#export-encrypt-toggle');
function syncExportRow() { $('#export-pass-row').style.display = exportToggle.checked ? 'block' : 'none'; }
exportToggle.addEventListener('change', syncExportRow);
syncExportRow();

$('#btn-export-backup').addEventListener('click', async () => {
  const st = $('#backup-status');
  let password = null;
  if (exportToggle.checked) {
    const p1 = $('#export-pass').value, p2 = $('#export-pass2').value;
    if (!p1 || p1.length < 6) return setStatus(st, t('pass_too_short'), 'err');
    if (p1 !== p2) return setStatus(st, t('pass_mismatch'), 'err');
    password = p1;
  }
  const r = await bg({ type: 'BG_EXPORT_BACKUP', password });
  if (!r || !r.ok) return setStatus(st, errText(r && r.error), 'err');
  if (r.encrypted) {
    download('pgp-backup.asc', r.text);
    $('#export-pass').value = ''; $('#export-pass2').value = '';
    setStatus(st, t('backup_downloaded'), 'ok');
  } else {
    download('pgp-backup.json', r.text);
    setStatus(st, t('backup_downloaded_plain'), 'ok');
  }
});

$('#btn-import-do').addEventListener('click', async () => {
  const st = $('#backup-status');
  const file = $('#import-file').files[0];
  if (!file) return setStatus(st, t('pick_backup_file'), 'err');
  const raw = await readFile(file);
  const r = await bg({
    type: 'BG_IMPORT_BACKUP', raw,
    password: $('#import-pass').value || null,
    merge: $('#import-merge').checked
  });
  if (r && r.ok) {
    $('#import-file').value = ''; $('#import-pass').value = '';
    setStatus(st, t('restored', { n: r.contactCount }), 'ok');
    await refreshState(); render();
  } else setStatus(st, t('restore_failed') + errText(r && r.error), 'err');
});

// ============================================================
//  Koruma ayarları
// ============================================================

$('#btn-enable-prot').addEventListener('click', async () => {
  const st = $('#prot-status');
  const p1 = $('#prot-pass').value, p2 = $('#prot-pass2').value;
  if (!p1 || p1.length < 6) return setStatus(st, t('err_short_password'), 'err');
  if (p1 !== p2) return setStatus(st, t('pass_mismatch'), 'err');
  const r = await bg({ type: 'BG_VAULT_ENABLE', password: p1 });
  if (r && r.ok) {
    $('#prot-pass').value = ''; $('#prot-pass2').value = '';
    setStatus(st, t('protection_enabled'), 'ok');
    await refreshState(); render();
  } else setStatus(st, errText(r && r.error), 'err');
});

$('#btn-disable-prot').addEventListener('click', () => { $('#disable-warn').hidden = false; });
$('#btn-disable-cancel').addEventListener('click', () => {
  $('#disable-warn').hidden = true;
  $('#disable-pass').value = '';
});

$('#btn-disable-confirm').addEventListener('click', async () => {
  const st = $('#prot-status');
  const r = await bg({ type: 'BG_VAULT_DISABLE', password: $('#disable-pass').value });
  if (r && r.ok) {
    $('#disable-warn').hidden = true;
    $('#disable-pass').value = '';
    setStatus(st, t('protection_disabled'));
    await refreshState(); render();
  } else setStatus(st, errText(r && r.error), 'err');
});

$('#btn-change-pass').addEventListener('click', async () => {
  const st = $('#prot-status');
  const r = await bg({
    type: 'BG_VAULT_CHANGE_PASSWORD',
    oldPassword: $('#chg-old').value,
    newPassword: $('#chg-new').value
  });
  if (r && r.ok) {
    $('#chg-old').value = ''; $('#chg-new').value = '';
    setStatus(st, t('password_changed'), 'ok');
  } else setStatus(st, errText(r && r.error), 'err');
});

$('#lock-minutes').addEventListener('change', async (e) => {
  await bg({ type: 'BG_VAULT_SET_TIMEOUT', minutes: parseInt(e.target.value, 10) });
});

$('#btn-lock-now').addEventListener('click', async () => {
  await bg({ type: 'BG_VAULT_LOCK' });
  await refreshState(); render();
});

// ============================================================
//  Aç/kapa, sıfırlama, yardım
// ============================================================

$('#toggle-enabled').addEventListener('change', async (e) => {
  await localSet({ pgp_enabled: e.target.checked });
  $('#toggle-label').textContent = e.target.checked ? t('toggle_on') : t('toggle_off');
});

$('#btn-reset-start').addEventListener('click', () => {
  $('#reset-confirm').hidden = false;
  $('#reset-word').value = '';
  $('#btn-reset-do').disabled = true;
  $('#reset-word').focus();
});
$('#btn-reset-cancel').addEventListener('click', () => { $('#reset-confirm').hidden = true; });
$('#reset-word').addEventListener('input', (e) => {
  $('#btn-reset-do').disabled = e.target.value.trim().toUpperCase() !== t('reset_word');
});
$('#btn-reset-do').addEventListener('click', async () => {
  if ($('#reset-word').value.trim().toUpperCase() !== t('reset_word')) return;
  if (!confirm(t('reset_final_warn'))) return;
  await bg({ type: 'BG_RESET_ALL' });
  $('#reset-confirm').hidden = true;
  setStatus($('#reset-status'), t('reset_done'), 'ok');
  await refreshState(); render();
});

$('#btn-help').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('help/help.html') });
});

// ============================================================
//  Başlat
// ============================================================

(async function init() {
  const d = await local(['pgp_lang']);
  pgpSetLang(d.pgp_lang || 'en');
  await refreshState();
  render();
})();
