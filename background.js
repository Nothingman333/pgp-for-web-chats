// Arka plan servis çalışanı — TÜM kriptografi burada.
//
// Neden burada: OpenPGP (~550 KB) her sayfaya enjekte edilmesin diye, ve daha
// önemlisi özel anahtar hiçbir zaman sayfa bağlamına (content script) düşmesin diye.
// Popup ve content script sadece mesaj gönderir; anahtar materyali buradan çıkmaz.
//
// KASA (vault): kullanıcı parola belirlerse özel anahtar VE kişi listesi
// PBKDF2 + AES-256-GCM ile şifrelenip saklanır. Türetilmiş anahtar diske asla
// yazılmaz; chrome.storage.session'da (RAM, tarayıcı kapanınca silinir) tutulur
// ve hareketsizlik süresi dolunca temizlenir.

importScripts('lib/openpgp.min.js');

const PBKDF2_ITERATIONS = 300000;
const DEFAULT_LOCK_MINUTES = 15;

// ============================================================
//  Küçük yardımcılar
// ============================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function local(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function localSet(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }
function localRemove(keys) { return new Promise(r => chrome.storage.local.remove(keys, r)); }
function session(keys) { return new Promise(r => chrome.storage.session.get(keys, r)); }
function sessionSet(obj) { return new Promise(r => chrome.storage.session.set(obj, r)); }
function sessionRemove(keys) { return new Promise(r => chrome.storage.session.remove(keys, r)); }

// ============================================================
//  Kasa kriptografisi
// ============================================================

async function deriveKey(password, saltBytes, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,                       // dışa aktarılabilir: session storage'a koyabilmek için
    ['encrypt', 'decrypt']
  );
}

async function aesEncrypt(key, plainText) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plainText));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function aesDecrypt(key, blob) {
  // AES-GCM authenticated encryption: yanlış parola ya da kurcalanmış veri burada patlar.
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct)
  );
  return dec.decode(pt);
}

// ============================================================
//  Oturum anahtarı (kilit durumu)
// ============================================================

async function getSessionKey() {
  const s = await session(['vaultKey', 'vaultExpiry']);
  if (!s.vaultKey) return null;
  if (s.vaultExpiry && Date.now() > s.vaultExpiry) {
    await lockVault();
    return null;
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw', unb64(s.vaultKey), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    await touchExpiry();
    return key;
  } catch (e) {
    await lockVault();
    return null;
  }
}

async function setSessionKey(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  await sessionSet({ vaultKey: b64(raw) });
  await touchExpiry();
}

async function touchExpiry() {
  const cfg = await local(['vault_lock_minutes']);
  const mins = cfg.vault_lock_minutes == null ? DEFAULT_LOCK_MINUTES : cfg.vault_lock_minutes;
  if (mins === 0) {                       // 0 = hiç kilitlenmesin
    await sessionSet({ vaultExpiry: 0 });
    return;
  }
  await sessionSet({ vaultExpiry: Date.now() + mins * 60000 });
}

async function lockVault() {
  await sessionRemove(['vaultKey', 'vaultExpiry']);
}

// ============================================================
//  Veri katmanı
//
//  Kasa KAPALIYKEN: privateKey / contacts / convMap düz olarak local storage'da.
//  Kasa AÇIKKEN  : hepsi tek bir şifreli blob içinde (vault_blob).
//  Açık anahtar her iki durumda da düz — zaten paylaşılan şey.
// ============================================================

async function vaultEnabled() {
  const d = await local(['vault_enabled']);
  return d.vault_enabled === true;
}

async function readData() {
  if (!(await vaultEnabled())) {
    const d = await local(['pgp_privateKeyEnc', 'contacts', 'convMap']);
    return {
      locked: false,
      data: {
        privateKey: d.pgp_privateKeyEnc || null,
        contacts: d.contacts || {},
        convMap: d.convMap || {}
      }
    };
  }
  const key = await getSessionKey();
  if (!key) return { locked: true, data: null };
  const d = await local(['vault_blob']);
  if (!d.vault_blob) return { locked: false, data: { privateKey: null, contacts: {}, convMap: {} } };
  try {
    const json = await aesDecrypt(key, d.vault_blob);
    const parsed = JSON.parse(json);
    return {
      locked: false,
      data: {
        privateKey: parsed.privateKey || null,
        contacts: parsed.contacts || {},
        convMap: parsed.convMap || {}
      }
    };
  } catch (e) {
    await lockVault();
    return { locked: true, data: null };
  }
}

async function writeData(data) {
  if (!(await vaultEnabled())) {
    await localSet({
      pgp_privateKeyEnc: data.privateKey || null,
      contacts: data.contacts || {},
      convMap: data.convMap || {}
    });
    return true;
  }
  const key = await getSessionKey();
  if (!key) return false;
  const blob = await aesEncrypt(key, JSON.stringify({
    privateKey: data.privateKey || null,
    contacts: data.contacts || {},
    convMap: data.convMap || {}
  }));
  await localSet({ vault_blob: blob });
  return true;
}

// Özel anahtar nesnesi önbelleği (yalnız bellek, SW ölünce gider)
let cachedPrivKeyArmored = null;
let cachedPrivKeyObj = null;

async function getPrivateKeyObj() {
  const r = await readData();
  if (r.locked || !r.data.privateKey) return null;
  if (cachedPrivKeyArmored === r.data.privateKey && cachedPrivKeyObj) return cachedPrivKeyObj;
  cachedPrivKeyObj = await openpgp.readPrivateKey({ armoredKey: r.data.privateKey });
  cachedPrivKeyArmored = r.data.privateKey;
  return cachedPrivKeyObj;
}

// ============================================================
//  Armored onarımı (bozulmuş PGP bloklarını kurtarır)
// ============================================================

function normalizeArmored(raw) {
  if (!raw) return null;
  const BEGIN = '-----BEGIN PGP MESSAGE-----';
  const END = '-----END PGP MESSAGE-----';
  const s = raw.indexOf(BEGIN);
  const e = raw.indexOf(END);
  if (s === -1 || e === -1) return null;

  let body = raw.slice(s + BEGIN.length, e);
  body = body.replace(/[​-‍﻿ ⁠]/g, ' ');
  body = body.replace(/^[^\n]*:[^\n]*\n/gm, '');

  const checksumMatch = body.match(/=([A-Za-z0-9+/]{4})(?![A-Za-z0-9+/=])/);
  const checksum = checksumMatch ? checksumMatch[1] : null;
  if (checksumMatch) body = body.replace(checksumMatch[0], '');

  const b = body.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!b) return null;
  const lines = [];
  for (let i = 0; i < b.length; i += 64) lines.push(b.slice(i, i + 64));
  return BEGIN + '\n\n' + lines.join('\n') + '\n' + (checksum ? '=' + checksum + '\n' : '') + END;
}

// ============================================================
//  İkili yardımcılar
// ============================================================

function bytesFromB64(s) { return unb64(s); }
function b64FromBytes(b) { return b64(b); }

// ============================================================
//  İstek işleyicileri
// ============================================================

async function publicKey() {
  const d = await local(['pgp_publicKey']);
  return d.pgp_publicKey || null;
}

async function handle(msg) {
  switch (msg.type) {

    // ---------- Durum ----------
    case 'BG_STATE': {
      const enabled = await vaultEnabled();
      const r = await readData();
      const pub = await publicKey();
      const cfg = await local(['vault_lock_minutes', 'vault_setup_seen', 'pgp_lang', 'pgp_enabled']);
      let fingerprint = null;
      if (pub) {
        try { fingerprint = (await openpgp.readKey({ armoredKey: pub })).getFingerprint().toUpperCase(); } catch (e) {}
      }
      return {
        ok: true,
        vault: { enabled, locked: r.locked, lockMinutes: cfg.vault_lock_minutes == null ? DEFAULT_LOCK_MINUTES : cfg.vault_lock_minutes },
        setupSeen: cfg.vault_setup_seen === true,
        lang: cfg.pgp_lang || 'en',
        extEnabled: cfg.pgp_enabled !== false,
        hasOwnKey: !!(r.data && r.data.privateKey),
        publicKey: pub,
        fingerprint,
        contacts: r.locked ? {} : r.data.contacts
      };
    }

    // ---------- Kasa ----------
    case 'BG_VAULT_ENABLE': {
      if (!msg.password || msg.password.length < 6) return { error: 'short_password' };
      if (await vaultEnabled()) return { error: 'already_enabled' };
      const cur = await local(['pgp_privateKeyEnc', 'contacts', 'convMap']);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(msg.password, salt, PBKDF2_ITERATIONS);
      const blob = await aesEncrypt(key, JSON.stringify({
        privateKey: cur.pgp_privateKeyEnc || null,
        contacts: cur.contacts || {},
        convMap: cur.convMap || {}
      }));
      await localSet({
        vault_enabled: true,
        vault_salt: b64(salt),
        vault_iterations: PBKDF2_ITERATIONS,
        vault_blob: blob,
        vault_setup_seen: true
      });
      // Düz metin kopyaları sil
      await localRemove(['pgp_privateKeyEnc', 'contacts', 'convMap']);
      await setSessionKey(key);
      cachedPrivKeyArmored = null;
      return { ok: true };
    }

    case 'BG_VAULT_UNLOCK': {
      if (!(await vaultEnabled())) return { ok: true };
      const d = await local(['vault_salt', 'vault_iterations', 'vault_blob']);
      if (!d.vault_salt) return { error: 'no_vault' };
      const key = await deriveKey(msg.password || '', unb64(d.vault_salt), d.vault_iterations || PBKDF2_ITERATIONS);
      try {
        if (d.vault_blob) await aesDecrypt(key, d.vault_blob);   // parola doğrulaması
      } catch (e) {
        return { error: 'wrong_password' };
      }
      await setSessionKey(key);
      cachedPrivKeyArmored = null;
      return { ok: true };
    }

    case 'BG_VAULT_LOCK': {
      await lockVault();
      cachedPrivKeyArmored = null;
      cachedPrivKeyObj = null;
      return { ok: true };
    }

    case 'BG_VAULT_DISABLE': {
      if (!(await vaultEnabled())) return { ok: true };
      const d = await local(['vault_salt', 'vault_iterations', 'vault_blob']);
      const key = await deriveKey(msg.password || '', unb64(d.vault_salt), d.vault_iterations || PBKDF2_ITERATIONS);
      let parsed;
      try {
        parsed = JSON.parse(await aesDecrypt(key, d.vault_blob));
      } catch (e) {
        return { error: 'wrong_password' };
      }
      await localSet({
        vault_enabled: false,
        pgp_privateKeyEnc: parsed.privateKey || null,
        contacts: parsed.contacts || {},
        convMap: parsed.convMap || {}
      });
      await localRemove(['vault_blob', 'vault_salt', 'vault_iterations']);
      await lockVault();
      cachedPrivKeyArmored = null;
      return { ok: true };
    }

    case 'BG_VAULT_CHANGE_PASSWORD': {
      if (!(await vaultEnabled())) return { error: 'not_enabled' };
      if (!msg.newPassword || msg.newPassword.length < 6) return { error: 'short_password' };
      const d = await local(['vault_salt', 'vault_iterations', 'vault_blob']);
      const oldKey = await deriveKey(msg.oldPassword || '', unb64(d.vault_salt), d.vault_iterations || PBKDF2_ITERATIONS);
      let json;
      try { json = await aesDecrypt(oldKey, d.vault_blob); }
      catch (e) { return { error: 'wrong_password' }; }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const newKey = await deriveKey(msg.newPassword, salt, PBKDF2_ITERATIONS);
      const blob = await aesEncrypt(newKey, json);
      await localSet({ vault_salt: b64(salt), vault_iterations: PBKDF2_ITERATIONS, vault_blob: blob });
      await setSessionKey(newKey);
      return { ok: true };
    }

    case 'BG_VAULT_SET_TIMEOUT': {
      await localSet({ vault_lock_minutes: msg.minutes });
      await touchExpiry();
      return { ok: true };
    }

    case 'BG_VAULT_SKIP_SETUP': {
      await localSet({ vault_setup_seen: true });
      return { ok: true };
    }

    // ---------- Anahtar yönetimi ----------
    case 'BG_GENERATE_KEY': {
      const r = await readData();
      if (r.locked) return { locked: true };
      const { privateKey, publicKey: pub } = await openpgp.generateKey({
        type: 'ecc', curve: 'curve25519',
        userIDs: [{ name: 'PGP User' }], format: 'armored'
      });
      r.data.privateKey = privateKey;
      const okw = await writeData(r.data);
      if (!okw) return { locked: true };
      await localSet({ pgp_publicKey: pub });
      cachedPrivKeyArmored = null;
      return { ok: true };
    }

    case 'BG_DELETE_KEYS': {
      const r = await readData();
      if (r.locked) return { locked: true };
      r.data.privateKey = null;
      await writeData(r.data);
      await localRemove(['pgp_publicKey']);
      cachedPrivKeyArmored = null;
      cachedPrivKeyObj = null;
      return { ok: true };
    }

    case 'BG_KEY_INFO': {
      try {
        const k = await openpgp.readKey({ armoredKey: msg.armoredKey });
        return { ok: true, fingerprint: k.getFingerprint().toUpperCase(), userIds: k.getUserIDs() };
      } catch (e) { return { error: e.message }; }
    }

    // ---------- Kişiler ----------
    case 'BG_GET_CONTACTS': {
      const r = await readData();
      if (r.locked) return { locked: true, contacts: {} };
      return { ok: true, contacts: r.data.contacts };
    }

    case 'BG_SAVE_CONTACT': {
      const r = await readData();
      if (r.locked) return { locked: true };
      try { await openpgp.readKey({ armoredKey: msg.publicKey }); }
      catch (e) { return { error: e.message }; }
      r.data.contacts[msg.id] = { name: msg.name, publicKey: msg.publicKey };
      await writeData(r.data);
      return { ok: true };
    }

    case 'BG_DELETE_CONTACT': {
      const r = await readData();
      if (r.locked) return { locked: true };
      delete r.data.contacts[msg.id];
      await writeData(r.data);
      return { ok: true };
    }

    // ---------- Konuşma → alıcı hafızası ----------
    case 'BG_GET_CONV': {
      const r = await readData();
      if (r.locked) return { locked: true, convMap: {} };
      return { ok: true, convMap: r.data.convMap };
    }

    case 'BG_SET_CONV': {
      const r = await readData();
      if (r.locked) return { locked: true };
      r.data.convMap[msg.key] = msg.contactId;
      await writeData(r.data);
      return { ok: true };
    }

    // ---------- Mesaj şifreleme / çözme ----------
    case 'BG_ENCRYPT': {
      const r = await readData();
      if (r.locked) return { locked: true };
      const contact = r.data.contacts[msg.contactId];
      if (!contact) return { error: 'no_contact' };
      const pub = await publicKey();
      const keys = [await openpgp.readKey({ armoredKey: contact.publicKey })];
      if (pub) keys.push(await openpgp.readKey({ armoredKey: pub }));
      const armored = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: msg.text }),
        encryptionKeys: keys, format: 'armored'
      });
      return { ok: true, armored };
    }

    case 'BG_DECRYPT': {
      if (await vaultEnabled()) {
        const k = await getSessionKey();
        if (!k) return { locked: true };
      }
      const privateKey = await getPrivateKeyObj();
      if (!privateKey) return { noKey: true };
      const attempts = [msg.armored, normalizeArmored(msg.armored)].filter(Boolean);
      let lastErr = 'decrypt_failed';
      for (const armored of attempts) {
        try {
          const message = await openpgp.readMessage({ armoredMessage: armored });
          const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey });
          return { ok: true, text: data };
        } catch (e) { lastErr = e.message; }
      }
      return { error: lastErr };
    }

    // ---------- Dosya / resim ----------
    case 'BG_ENCRYPT_FILE': {
      const r = await readData();
      if (r.locked) return { locked: true };
      const contact = r.data.contacts[msg.contactId];
      if (!contact) return { error: 'no_contact' };
      const pub = await publicKey();
      const keys = [await openpgp.readKey({ armoredKey: contact.publicKey })];
      if (pub) keys.push(await openpgp.readKey({ armoredKey: pub }));
      const message = await openpgp.createMessage({
        binary: bytesFromB64(msg.dataBase64), filename: msg.filename
      });
      const encrypted = await openpgp.encrypt({ message, encryptionKeys: keys, format: 'binary' });
      return { ok: true, dataBase64: b64FromBytes(encrypted) };
    }

    case 'BG_DECRYPT_FILE': {
      if (await vaultEnabled()) {
        const k = await getSessionKey();
        if (!k) return { locked: true };
      }
      const privateKey = await getPrivateKeyObj();
      if (!privateKey) return { noKey: true };
      try {
        const message = await openpgp.readMessage({ binaryMessage: bytesFromB64(msg.dataBase64) });
        const { data, filename } = await openpgp.decrypt({
          message, decryptionKeys: privateKey, format: 'binary'
        });
        return { ok: true, dataBase64: b64FromBytes(data), filename: filename || 'decrypted-file' };
      } catch (e) { return { error: e.message }; }
    }

    // ---------- Yedekleme ----------
    case 'BG_EXPORT_BACKUP': {
      const r = await readData();
      if (r.locked) return { locked: true };
      const pub = await publicKey();
      const cfg = await local(['pgp_lang']);
      const payload = JSON.stringify({
        format: 'pgp-webchat-backup-v3',
        exportedAt: new Date().toISOString(),
        publicKey: pub,
        privateKey: r.data.privateKey,
        contacts: r.data.contacts,
        convMap: r.data.convMap,
        lang: cfg.pgp_lang || 'en'
      }, null, 2);
      if (!msg.password) return { ok: true, text: payload, encrypted: false };
      const armored = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: payload }),
        passwords: [msg.password], format: 'armored'
      });
      return { ok: true, text: armored, encrypted: true };
    }

    case 'BG_IMPORT_BACKUP': {
      const r = await readData();
      if (r.locked) return { locked: true };
      let raw = msg.raw, parsed;
      try {
        if (raw.includes('BEGIN PGP MESSAGE')) {
          if (!msg.password) return { error: 'needs_password' };
          const message = await openpgp.readMessage({ armoredMessage: raw });
          const { data } = await openpgp.decrypt({ message, passwords: [msg.password] });
          parsed = JSON.parse(data);
        } else {
          parsed = JSON.parse(raw);
        }
      } catch (e) { return { error: e.message }; }

      if (parsed.privateKey) r.data.privateKey = parsed.privateKey;
      r.data.contacts = msg.merge
        ? Object.assign({}, r.data.contacts, parsed.contacts || {})
        : (parsed.contacts || {});
      r.data.convMap = Object.assign({}, r.data.convMap, parsed.convMap || {});
      await writeData(r.data);
      if (parsed.publicKey) await localSet({ pgp_publicKey: parsed.publicKey });
      cachedPrivKeyArmored = null;
      return { ok: true, contactCount: Object.keys(r.data.contacts).length };
    }

    // ---------- Sıfırlama ----------
    case 'BG_RESET_ALL': {
      const cfg = await local(['pgp_lang']);
      await new Promise(r2 => chrome.storage.local.clear(r2));
      await lockVault();
      cachedPrivKeyArmored = null;
      cachedPrivKeyObj = null;
      await localSet({ pgp_enabled: true, pgp_lang: cfg.pgp_lang || 'en', vault_setup_seen: true });
      return { ok: true };
    }

    default:
      return { error: 'unknown_request:' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || !msg.type.startsWith('BG_')) return;
  handle(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

// ============================================================
//  Kurulum ve eklenti simgesi menüsü
// ============================================================

chrome.runtime.onInstalled.addListener(async () => {
  const d = await local(['contacts', 'pgp_lang']);
  if (!d.contacts) await localSet({ contacts: {} });
  if (!d.pgp_lang) await localSet({ pgp_lang: 'en' });

  // Eklenti simgesine sağ tıklayınca çıkan menü
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: 'pgp_open', title: 'Open PGP', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'pgp_help', title: 'How to use', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'pgp_lock', title: 'Lock now', contexts: ['action'] });
  } catch (e) { /* contextMenus yoksa yoksay */ }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'pgp_open') {
    // Chrome 127+ popup'ı programatik açabiliyor; olmayan sürümlerde sekmede açıyoruz.
    try {
      if (chrome.action.openPopup) await chrome.action.openPopup();
      else chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
    } catch (e) {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
    }
  } else if (info.menuItemId === 'pgp_help') {
    chrome.tabs.create({ url: chrome.runtime.getURL('help/help.html') });
  } else if (info.menuItemId === 'pgp_lock') {
    await lockVault();
    cachedPrivKeyArmored = null;
    cachedPrivKeyObj = null;
  }
});
