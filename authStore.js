const { initAuthCreds } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');

const AuthStateSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  creds: { type: Object, required: true },
  keys: { type: Object, default: {} },
  updated_at: { type: Date, default: Date.now }
});

const AuthState = mongoose.model('AuthState', AuthStateSchema);

async function useMongoDBAuthState(phone) {
  let creds = initAuthCreds();
  let keys = {};

  const existing = await AuthState.findOne({ phone });
  if (existing) {
    creds = existing.creds;
    keys = existing.keys || {};
    console.log(`🔑 Loaded auth from MongoDB for ${phone}`);
  }

  const saveCreds = async () => {
    await AuthState.findOneAndUpdate(
      { phone },
      { phone, creds, keys, updated_at: new Date() },
      { upsert: true }
    );
    console.log(`💾 Saved auth to MongoDB for ${phone}`);
  };

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const key = keys[`${type}-${id}`];
          if (key) result[id] = key;
        }
        return result;
      },
      set: async (data) => {
        for (const category in data) {
          for (const id in data[category]) {
            keys[`${category}-${id}`] = data[category][id];
          }
        }
        await saveCreds();
      }
    }
  };

  return { state, saveCreds };
}

module.exports = { useMongoDBAuthState };
