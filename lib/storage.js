// Ortak depolama yardımcıları — hem popup hem content script tarafından kullanılır.
// chrome.storage.local içinde şunlar tutulur:
//   pgp_publicKey        : kendi açık anahtarımız (armored, string)
//   pgp_privateKeyEnc    : kendi özel anahtarımız (armored, parola ile KORUNMUŞ haldeymiş gibi
//                          OpenPGP'nin kendi passphrase mekanizmasıyla saklanır — key.armor() çıktısı
//                          zaten passphrase ile encrypt edilmiş private key materyali içerir)
//   pgp_userId           : { name, email } - anahtar üretilirken kullanılan kimlik
//   contacts             : { [waChatId]: { name, publicKey } } - karşı tarafların açık anahtarları

const PGPStorage = {
  async get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  },
  async set(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  },
  async remove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  },

  async getOwnKeys() {
    const data = await this.get(['pgp_publicKey', 'pgp_privateKeyEnc', 'pgp_userId']);
    return {
      publicKey: data.pgp_publicKey || null,
      privateKeyEnc: data.pgp_privateKeyEnc || null,
      userId: data.pgp_userId || null
    };
  },

  async saveOwnKeys({ publicKey, privateKeyEnc, userId }) {
    await this.set({
      pgp_publicKey: publicKey,
      pgp_privateKeyEnc: privateKeyEnc,
      pgp_userId: userId
    });
  },

  async clearOwnKeys() {
    await this.remove(['pgp_publicKey', 'pgp_privateKeyEnc', 'pgp_userId']);
  },

  async getContacts() {
    const data = await this.get(['contacts']);
    return data.contacts || {};
  },

  async saveContact(chatId, contact) {
    const contacts = await this.getContacts();
    contacts[chatId] = contact;
    await this.set({ contacts });
  },

  async removeContact(chatId) {
    const contacts = await this.getContacts();
    delete contacts[chatId];
    await this.set({ contacts });
  }
};

if (typeof module !== 'undefined') module.exports = PGPStorage;
