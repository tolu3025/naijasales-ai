require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { 
  makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { useMongoDBAuthState } = require('./authStore');

const app = express();

// Raw body parser for Paystack webhook (must be before express.json)
app.use('/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── CONFIG ─────────────────────────────────────────────────────────
const ADMIN_PHONE = process.env.ADMIN_PHONE?.replace(/\D/g, '');
const MONGO_URI = process.env.MONGODB_URI;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET;
const WEBHOOK_BASE = process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const BASE_DIR = process.env.RENDER_DISK_PATH || '.';
const IS_RENDER = !!process.env.RENDER_DISK_PATH;
const IS_TEST_MODE = PAYSTACK_SECRET?.startsWith('sk_test_');

if (!ADMIN_PHONE) {
  console.error('❌ ADMIN_PHONE not set in .env');
  process.exit(1);
}

if (!PAYSTACK_SECRET) {
  console.error('❌ PAYSTACK_SECRET_KEY not set in .env');
  process.exit(1);
}

console.log(`🔑 Paystack mode: ${IS_TEST_MODE ? 'TEST (subaccounts disabled)' : 'LIVE (subaccounts enabled)'}`);

// ─── ENSURE AUTH DIRECTORY EXISTS (Local/Termux only) ───────────────
if (!IS_RENDER) {
  const authDir = `${BASE_DIR}/auth_info`;
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
}

// ─── MONGODB ────────────────────────────────────────────────────────
let dbReady = false;
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, { 
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    dbReady = true;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB error:', err.message);
    console.log('🔄 Retrying in 5 seconds...');
    setTimeout(connectDB, 5000);
  }
}
connectDB();

// ─── SCHEMAS ────────────────────────────────────────────────────────
const VendorSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  business_name: String,
  bank_name: String,
  bank_code: String,
  account_number: String,
  verified_name: String,
  subaccount_code: String,
  description: String,
  faqs: [{ q: String, a: String }],
  products: [{ name: String, price: Number, image_url: String }],
  group_rules: String,
  onboarding_step: { type: Number, default: 0 },
  status: { type: String, default: 'onboarding' },
  auth_connected: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

const OrderSchema = new mongoose.Schema({
  vendor_phone: String,
  customer_phone: String,
  customer_name: String,
  items: [{ name: String, qty: Number, price: Number }],
  total: Number,
  virtual_account: {
    account_name: String,
    account_number: String,
    bank_name: String,
    expires_at: Date
  },
  paystack_ref: String,
  paystack_transfer_ref: String,
  status: { type: String, default: 'pending' },
  receipt_url: String,
  created_at: { type: Date, default: Date.now },
  paid_at: Date
});

const Vendor = mongoose.model('Vendor', VendorSchema);
const Order = mongoose.model('Order', OrderSchema);

// ─── SESSIONS MAP ───────────────────────────────────────────────────
const sessions = new Map();
const activeCarts = new Map();

// ─── HELPERS ────────────────────────────────────────────────────────
function getMessageText(msg) {
  if (!msg.message) return '';
  if (msg.message.conversation) return msg.message.conversation;
  if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
  if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
  if (msg.message.buttonsResponseMessage?.selectedDisplayText) return msg.message.buttonsResponseMessage.selectedDisplayText;
  return '';
}

function cleanPhone(phone) {
  return phone.replace(/\D/g, '').replace(/^0/, '234');
}

function formatJid(phone) {
  return `${cleanPhone(phone)}@s.whatsapp.net`;
}

function formatDisplayNumber(phone) {
  const clean = cleanPhone(phone);
  if (clean.startsWith('234')) {
    return `+234 ${clean.slice(3, 6)} ${clean.slice(6, 9)} ${clean.slice(9)}`;
  }
  return clean;
}

async function sendMessage(fromPhone, toJid, text) {
  const session = sessions.get(fromPhone);
  if (!session?.socket) {
    console.log(`⚠️ No session for ${fromPhone}`);
    return false;
  }
  try {
    await session.socket.sendMessage(toJid, { text });
    console.log(`📤 [${fromPhone}] → ${toJid}: ${text.substring(0, 40)}...`);
    return true;
  } catch (err) {
    console.error(`❌ [${fromPhone}] Send error:`, err.message);
    return false;
  }
}

// ─── PAYSTACK FUNCTIONS ─────────────────────────────────────────────
async function createVendorSubaccount(vendor) {
  if (IS_TEST_MODE) {
    console.log(`🧪 Test mode: Skipping subaccount creation for ${vendor.phone}`);
    return {
      success: true,
      subaccount_code: null,
      account_name: vendor.business_name,
      test_mode: true
    };
  }

  try {
    const res = await axios.post('https://api.paystack.co/subaccount', {
      business_name: vendor.business_name,
      settlement_bank: vendor.bank_code,
      account_number: vendor.account_number,
      percentage_charge: 10,
      description: `Subaccount for ${vendor.business_name} - NaijaSales AI vendor`
    }, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.data.status) {
      return {
        success: true,
        subaccount_code: res.data.data.subaccount_code,
        account_name: res.data.data.account_name,
        settlement_bank: res.data.data.settlement_bank,
        percentage_charge: res.data.data.percentage_charge
      };
    }
    return { success: false, error: res.data.message };
  } catch (err) {
    return { 
      success: false, 
      error: err.response?.data?.message || err.message 
    };
  }
}

async function createVirtualAccount(order, customerName) {
  try {
    const customerRes = await axios.post('https://api.paystack.co/customer', {
      email: `${order.customer_phone}@temp.naijasales.ai`,
      first_name: customerName.split(' ')[0] || 'Customer',
      last_name: customerName.split(' ').slice(1).join(' ') || '',
      phone: `+${order.customer_phone}`
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }});
    
    if (!customerRes.data.status) return { success: false, error: customerRes.data.message };

    const vendor = await Vendor.findOne({ phone: order.vendor_phone });
    const subaccount = vendor?.subaccount_code;

    const payload = {
      customer: customerRes.data.data.customer_code,
      preferred_bank: 'wema-bank'
    };
    if (subaccount) payload.subaccount = subaccount;

    const vaRes = await axios.post('https://api.paystack.co/dedicated_account', payload, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }
    });

    if (vaRes.data.status) {
      const account = vaRes.data.data;
      return {
        success: true,
        account_name: account.account_name,
        account_number: account.account_number,
        bank_name: account.bank?.name || account.bank_slug,
        account_id: account.id,
        customer_code: customerRes.data.data.customer_code
      };
    }
    return { success: false, error: vaRes.data.message };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

async function verifyTransaction(reference) {
  try { 
    return (await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { 
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    })).data; 
  }
  catch (err) { 
    return { status: false, message: err.message }; 
  }
}

async function transferToVendor(vendor, amountKobo, reference, reason) {
  try {
    const recipientRes = await axios.post('https://api.paystack.co/transferrecipient', {
      type: 'nuban', 
      name: vendor.verified_name || vendor.business_name,
      account_number: vendor.account_number, 
      bank_code: vendor.bank_code || '058', 
      currency: 'NGN'
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }});
    
    if (!recipientRes.data.status) return { success: false, error: recipientRes.data.message };
    
    const transferRes = await axios.post('https://api.paystack.co/transfer', {
      source: 'balance', 
      amount: amountKobo, 
      reference, 
      recipient: recipientRes.data.data.recipient_code, 
      reason
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }});
    
    return transferRes.data;
  } catch (err) { 
    return { status: false, message: err.message }; 
  }
}

// ─── SESSION CREATION ────────────────────────────────────────────────
async function createSession(phone, isAdmin = false, requesterJid = null) {
  const clean = cleanPhone(phone);

  if (IS_RENDER && !dbReady) {
    console.log(`⏸️ Cannot create session for ${clean}: DB not ready`);
    return { success: false, error: 'Database not connected' };
  }

  if (sessions.has(clean)) {
    const existing = sessions.get(clean);
    console.log(`🧹 Cleaning up existing session for ${clean}`);
    
    try { 
      existing.socket?.end(); 
      existing.socket?.ev.removeAllListeners();
    } catch(e) {}
    
    sessions.delete(clean);
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[${clean}] Using WA version: ${version.join('.')}, isLatest: ${isLatest}`);

    let state, saveCreds;
    
    if (IS_RENDER && dbReady) {
      console.log(`☁️ Using MongoDB auth state for ${clean}`);
      try {
        const mongoAuth = await useMongoDBAuthState(clean);
        state = mongoAuth.state;
        saveCreds = mongoAuth.saveCreds;
      } catch (mongoErr) {
        console.log(`⚠️ MongoDB auth failed, falling back to file auth: ${mongoErr.message}`);
        const sessionDir = `${BASE_DIR}/auth_info/${clean}`;
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        const fileAuth = await useMultiFileAuthState(sessionDir);
        state = fileAuth.state;
        saveCreds = fileAuth.saveCreds;
      }
    } else {
      console.log(`💾 Using file auth state for ${clean}`);
      const sessionDir = `${BASE_DIR}/auth_info/${clean}`;
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      const fileAuth = await useMultiFileAuthState(sessionDir);
      state = fileAuth.state;
      saveCreds = fileAuth.saveCreds;
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['Mac OS', 'Chrome', '14.4.1'],
      defaultQueryTimeoutMs: undefined,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
    });

    const sessionData = {
      socket: sock,
      connected: false,
      saveCreds,
      isAdmin,
      phone: clean,
      qrSent: false,
      resolved: false,
      reconnectAttempts: 0,
      maxReconnects: 10,
      pairingStable: false
    };
    sessions.set(clean, sessionData);

    sock.ev.on('creds.update', saveCreds);

    const connectionPromise = new Promise((resolve) => {
      let qrTimeoutId = null;
      let stabilityTimeoutId = null;
      
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection === undefined && !qr) {
          console.log(`[${clean}] Connection state undefined, waiting...`);
          return;
        }
        
        console.log(`[${clean}] Connection update:`, { connection, hasQR: !!qr });
        
        if (qr && !sessionData.qrSent) {
          sessionData.qrSent = true;
          
          try {
            const qrBuffer = await QRCode.toBuffer(qr, { 
              width: 400,
              margin: 2,
              type: 'png'
            });
            
            if (!IS_RENDER) {
              const qrPath = `${BASE_DIR}/auth_info/${clean}/qr-code.png`;
              fs.writeFileSync(qrPath, qrBuffer);
              console.log(`   Saved to: ${qrPath}`);
            }
            console.log(`\n📱 [${clean}] QR Code generated!`);
            
            if (requesterJid) {
              const adminSession = sessions.get(cleanPhone(ADMIN_PHONE));
              
              if (adminSession?.socket) {
                await adminSession.socket.sendMessage(requesterJid, {
                  image: qrBuffer,
                  caption: `🔑 *QR Code for ${clean}*\n\n` +
                    `Scan this with your WhatsApp:\n` +
                    `1. Open WhatsApp on your phone\n` +
                    `2. Tap ⋮ → Linked Devices → Link a Device\n` +
                    `3. Point camera at this QR code\n\n` +
                    `⏰ Expires in 3 minutes!`
                });
                console.log(`   📤 QR code sent to ${requesterJid} via admin session`);
              } else {
                console.log(`   ⚠️ Admin session not available, showing terminal QR`);
                const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
                console.log(terminalQR);
              }
            } else {
              const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
              console.log(terminalQR);
            }
            
          } catch (err) {
            console.error(`❌ QR generation error:`, err.message);
          }
        }
        
        if (connection === 'open' && !sessionData.resolved) {
          if (qrTimeoutId) {
            clearTimeout(qrTimeoutId);
            qrTimeoutId = null;
          }
          
          sessionData.connected = true;
          sessionData.reconnectAttempts = 0;
          console.log(`✅ [${clean}] CONNECTED`);
          
          if (!isAdmin) {
            await Vendor.updateOne({ phone: clean }, { $set: { auth_connected: true } });
          }

          if (!isAdmin && requesterJid) {
            console.log(`[${clean}] Waiting 8 seconds for pairing to stabilize...`);
            
            stabilityTimeoutId = setTimeout(async () => {
              try {
                const currentSession = sessions.get(clean);
                if (!currentSession?.connected) {
                  console.log(`⏸️ [${clean}] Session disconnected during stability wait, skipping congratulations`);
                  return;
                }
                
                const vendor = await Vendor.findOne({ phone: clean });
                if (!vendor) return;
                
                const displayPhone = formatDisplayNumber(vendor.phone);
                const selfJid = formatJid(vendor.phone);
                
                await sock.sendMessage(selfJid, {
                  text: `🎉 *Congratulations ${vendor.business_name}!*\n\n` +
                    `Your WhatsApp store is now *LIVE*! 🚀\n\n` +
                    `*What happens now:*\n` +
                    `• Customers can message you on WhatsApp\n` +
                    `• The AI will handle sales 24/7\n` +
                    `• You'll get notified of every order\n\n` +
                    `*To manage your store, save and message this number:*\n` +
                    `${displayPhone}\n\n` +
                    `Type *"help"* for commands.\n\n` +
                    `${IS_TEST_MODE ? '⚠️ Test mode: Payments are simulated. Switch to live keys for real transactions.' : ''}`
                });
                console.log(`✅ Congratulations sent via vendor session ${clean} to ${selfJid}`);
                
                sessionData.pairingStable = true;
                sessionData.resolved = true;
              } catch (err) {
                console.error(`❌ Failed to send congratulations via vendor session:`, err.message);
                sessionData.resolved = true;
              }
            }, 8000);
          } else {
            sessionData.resolved = true;
          }
          
          resolve({ success: true });
        }
        
        if (connection === 'close') {
          sessionData.connected = false;
          
          if (stabilityTimeoutId) {
            clearTimeout(stabilityTimeoutId);
            stabilityTimeoutId = null;
          }
          
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          
          if (statusCode === 515) {
            console.log(`🔄 [${clean}] Stream error (515), will retry with existing auth...`);
            if (qrTimeoutId) { clearTimeout(qrTimeoutId); qrTimeoutId = null; }
            
            sessionData.resolved = false;
            
            try { sock.end(); } catch(e) {}
            
            const delay = sessionData.pairingStable ? 5000 : 10000;
            console.log(`[${clean}] Waiting ${delay/1000}s before reconnect...`);
            
            setTimeout(() => {
              console.log(`🔄 [${clean}] Reconnecting after 515...`);
              createSession(clean, isAdmin, requesterJid);
            }, delay);
            return;
          }
          
          if (statusCode === 440) {
            console.log(`⏳ [${clean}] Rate limited (440), waiting 60s...`);
            if (qrTimeoutId) { clearTimeout(qrTimeoutId); qrTimeoutId = null; }
            setTimeout(() => {
              if (!sessions.get(clean)?.connected) {
                createSession(clean, isAdmin, requesterJid);
              }
            }, 60000);
            return;
          }
          
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log(`❌ [${clean}] Disconnected (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

          if (qrTimeoutId) {
            clearTimeout(qrTimeoutId);
            qrTimeoutId = null;
          }

          if (statusCode === 401) {
            console.log(`🚫 [${clean}] Session unauthorized. Clearing auth...`);
            sessionData.resolved = true;
            sessions.delete(clean);
            
            if (IS_RENDER && dbReady) {
              await mongoose.model('AuthState').deleteOne({ phone: clean });
            } else {
              const sessionDir = `${BASE_DIR}/auth_info/${clean}`;
              if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
              }
            }
            
            if (!isAdmin) {
              await Vendor.updateOne(
                { phone: clean },
                { $set: { auth_connected: false, status: 'onboarding', onboarding_step: 9 } }
              );
              const adminSession = sessions.get(cleanPhone(ADMIN_PHONE));
              if (adminSession?.socket && requesterJid) {
                await adminSession.socket.sendMessage(requesterJid, {
                  text: `❌ Your WhatsApp was unlinked. Please reply *"reconnect"* to link again.`
                });
              }
            }
            return;
          }

          if (shouldReconnect) {
            if (sessionData.reconnectAttempts < sessionData.maxReconnects) {
              sessionData.reconnectAttempts++;
              console.log(`🔄 [${clean}] Reconnecting... (attempt ${sessionData.reconnectAttempts}/${sessionData.maxReconnects})`);
              
              const delay = Math.min(5000 * sessionData.reconnectAttempts, 30000);
              setTimeout(() => {
                if (!sessions.get(clean)?.connected) {
                  createSession(clean, isAdmin, requesterJid);
                }
              }, delay);
            } else {
              console.log(`❌ [${clean}] Max reconnection attempts reached`);
              sessionData.resolved = true;
              
              if (!isAdmin) {
                await Vendor.updateOne(
                  { phone: clean },
                  { $set: { auth_connected: false, status: 'onboarding', onboarding_step: 9 } }
                );
                const adminSession = sessions.get(cleanPhone(ADMIN_PHONE));
                if (adminSession?.socket && requesterJid) {
                  await adminSession.socket.sendMessage(requesterJid, {
                    text: `❌ WhatsApp connection lost after multiple attempts. Please reply *"reconnect"* to try again.`
                  });
                }
              }
            }
          } else {
            sessionData.resolved = true;
            sessions.delete(clean);
            
            if (IS_RENDER && dbReady) {
              await mongoose.model('AuthState').deleteOne({ phone: clean });
            } else {
              const sessionDir = `${BASE_DIR}/auth_info/${clean}`;
              if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
              }
            }
            
            if (!isAdmin) {
              await Vendor.updateOne(
                { phone: clean },
                { $set: { auth_connected: false, status: 'onboarding', onboarding_step: 9 } }
              );
            }
          }
        }
      });
      
      qrTimeoutId = setTimeout(() => {
        if (!sessionData.resolved && !sessionData.connected) {
          console.log(`⏰ [${clean}] QR timeout reached`);
          sessionData.resolved = true;
          resolve({ success: false, error: 'Timeout - QR code expired. Please try again.' });
        }
      }, 180000);
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      
      const currentSession = sessions.get(clean);
      if (currentSession && !currentSession.pairingStable && !currentSession.isAdmin) {
        if (m.messages.length > 0) {
          const firstMsg = m.messages[0];
          console.log(`[${clean}] ⏸️ Ignoring message during pairing stabilization: ${firstMsg.key.remoteJid}`);
        }
        return;
      }
      
      for (const msg of m.messages) {
        const selfJid = `${clean}@s.whatsapp.net`;
        const remoteJid = msg.key.remoteJid || '';
        const senderJid = msg.key.participant || remoteJid;
        const remoteJidBase = remoteJid.split(':')[0];
        const senderJidBase = senderJid.split(':')[0];
        const senderPhone = cleanPhone(senderJidBase.split('@')[0]);
        const isSelfChat = remoteJidBase === selfJid || senderPhone === clean;
        
        console.log(`[${clean}] Msg check: fromMe=${msg.key.fromMe}, remoteJid=${remoteJid}, sender=${senderJid}, senderPhone=${senderPhone}, isSelfChat=${isSelfChat}`);
        
        if (msg.key.fromMe && !isSelfChat) {
          console.log(`[${clean}] Skipping non-self fromMe message from ${senderJid}`);
          continue;
        }
        
        await handleIncomingMessage(clean, msg, isAdmin);
      }
    });

    if (state.creds?.me?.id) {
      return { success: true, alreadyConnected: true };
    }

    return await connectionPromise;

  } catch (err) {
    console.error(`❌ [${clean}] Session creation failed:`, err.message);
    sessions.delete(clean);
    return { success: false, error: err.message };
  }
}

// ─── MESSAGE ROUTER ─────────────────────────────────────────────────
async function handleIncomingMessage(sessionPhone, msg, isAdminSession) {
  const fromJid = msg.key.remoteJid;
  const isGroup = fromJid.endsWith('@g.us');
  const senderJid = msg.key.participant || fromJid;
  const senderClean = cleanPhone(senderJid.split('@')[0].split(':')[0]);
  const text = getMessageText(msg);
  const lowerText = text.toLowerCase().trim();

  console.log(`📩 [${sessionPhone}] ${isAdminSession ? 'ADMIN' : 'VENDOR'} | From: ${senderClean} | Self: ${senderClean === sessionPhone} | Group: ${isGroup} | Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

  if (!dbReady) {
    console.log('⚠️ DB not ready');
    return;
  }

  if (isGroup && !isAdminSession) {
    const vendor = await Vendor.findOne({ phone: sessionPhone });
    if (!vendor || vendor.status !== 'active') {
      return;
    }
    await handleCustomerMessage(vendor, fromJid, text, lowerText, sessionPhone, senderClean);
    return;
  }

  if (isGroup && isAdminSession) {
    console.log(`⏸️ Ignoring group message in admin session`);
    return;
  }

  if (isAdminSession) {
    await handleAdminMessage(senderClean, fromJid, text, lowerText, sessionPhone, msg);
    return;
  }

  const vendor = await Vendor.findOne({ phone: sessionPhone });
  if (!vendor) {
    console.log(`⚠️ No vendor found for session ${sessionPhone}`);
    return;
  }

  if (senderClean === sessionPhone) {
    console.log(`🔧 Vendor self-management: ${senderClean}`);
    const handled = await handleVendorCommands(vendor, fromJid, text, lowerText, sessionPhone, msg);
    if (!handled) {
      await sendMessage(sessionPhone, fromJid, `Type *"help"* for available commands.`);
    }
    return;
  }

  if (vendor.status === 'active') {
    await handleCustomerMessage(vendor, fromJid, text, lowerText, sessionPhone, senderClean);
    return;
  }

  if (vendor.status === 'paused') {
    await sendMessage(sessionPhone, fromJid, '⏸️ This store is currently paused. Please check back later.');
  }
}

// ─── ADMIN HANDLER ──────────────────────────────────────────────────
async function handleAdminMessage(sender, fromJid, text, lowerText, adminPhone, msg) {
  
  if (!text || text.trim().length === 0) {
    return;
  }
  
  if (fromJid.includes('@newsletter') || fromJid.includes('@broadcast') || fromJid.endsWith('@g.us')) {
    console.log(`⏸️ Ignoring non-DM from ${sender}`);
    return;
  }
  
  if (lowerText === '/vendors' || lowerText === 'vendors') {
    const vendors = await Vendor.find().sort({ created_at: -1 }).limit(20);
    let reply = `📋 *All Vendors (${vendors.length})*\n\n`;
    vendors.forEach((v, i) => {
      const status = v.auth_connected ? '✅' : '❌';
      reply += `${i+1}. ${status} *${v.business_name || 'Unnamed'}* (${v.phone})\n   Status: ${v.status} | Step: ${v.onboarding_step}\n\n`;
    });
    await sendMessage(adminPhone, fromJid, reply);
    return;
  }

  if (lowerText.startsWith('/vendor ')) {
    const targetPhone = cleanPhone(text.split(' ')[1]);
    const vendor = await Vendor.findOne({ phone: targetPhone });
    if (!vendor) {
      await sendMessage(adminPhone, fromJid, `❌ Vendor ${targetPhone} not found.`);
      return;
    }
    const salesCount = await Order.countDocuments({ vendor_phone: vendor.phone, status: 'paid' });
    let reply = `👤 *${vendor.business_name}*\nPhone: ${vendor.phone}\nStatus: ${v.status}\nConnected: ${v.auth_connected ? '✅' : '❌'}\nProducts: ${vendor.products.length}\nPaid Orders: ${salesCount}\n`;
    await sendMessage(adminPhone, fromJid, reply);
    return;
  }

  let vendor = await Vendor.findOne({ phone: sender });

  if (vendor) {
    if (vendor.status === 'onboarding') {
      await handleOnboarding(vendor, fromJid, text, lowerText, adminPhone, msg);
      return;
    }
    
    const handled = await handleVendorCommands(vendor, fromJid, text, lowerText, adminPhone, msg);
    if (handled) return;
    
    const displayPhone = formatDisplayNumber(vendor.phone);
    await sendMessage(adminPhone, fromJid, 
      `👋 *${vendor.business_name}*, your store is active!\n\n` +
      `You can manage your store right here or message your store number:\n` +
      `${displayPhone}\n\n` +
      `Type *"help"* for commands.`
    );
    return;
  }

  const triggerWords = ['register', 'start', 'sell', 'onboard', 'setup', 'join'];
  const hasTrigger = triggerWords.some(word => lowerText.includes(word));
  
  if (hasTrigger) {
    vendor = new Vendor({ phone: sender, onboarding_step: 0 });
    await vendor.save();
    await sendMessage(adminPhone, fromJid, 
      `👋 *Welcome to NaijaSales AI!*\n\n` +
      `I'm your personal sales assistant. I'll help you sell your products 24/7 on WhatsApp.\n\n` +
      `Reply *"start"* to begin setup.`
    );
    vendor.onboarding_step = 0.5;
    await vendor.save();
    return;
  }
  
  console.log(`🔇 Silent: Ignoring message from ${sender}: "${text.substring(0, 30)}"`);
}

// ─── VENDOR COMMANDS (shared) ───────────────────────────────────────
async function handleVendorCommands(vendor, fromJid, text, lowerText, sessionPhone, msg) {
  console.log(`🔧 Vendor command from ${vendor.phone}: "${text.substring(0, 30)}"`);

  if (lowerText === 'help') {
    const displayPhone = formatDisplayNumber(vendor.phone);
    await sendMessage(sessionPhone, fromJid, 
      `*Store Management Commands:*\n\n` +
      `• *products* - View your products\n` +
      `• *add product* - Add a new product\n` +
      `• *remove [name]* - Remove a product\n` +
      `• *pause* - Pause your store\n` +
      `• *resume* - Resume your store\n` +
      `• *stats* - View sales stats\n` +
      `• *sales today* - Today's sales\n` +
      `• *sales week* - This week's sales\n` +
      `• *sales month* - This month's sales\n` +
      `• *balance* - Check payouts\n` +
      `• *payout* - Withdraw balance\n` +
      `• *disconnect* - Disconnect WhatsApp\n\n` +
      `Your store number: ${displayPhone}`
    );
    return true;
  }

  if (lowerText === 'products') {
    if (vendor.products.length === 0) {
      await sendMessage(sessionPhone, fromJid, `You have no products yet. Send *"add product"* to add one.`);
      return true;
    }
    let reply = `*Your Products:*\n\n`;
    vendor.products.forEach((p, i) => {
      reply += `${i+1}. ${p.name} - ₦${p.price.toLocaleString()}\n`;
    });
    await sendMessage(sessionPhone, fromJid, reply);
    return true;
  }

  if (lowerText === 'add product') {
    await sendMessage(sessionPhone, fromJid, `Send a product photo with the name and price in the caption.\nExample: "Red Ankara ₦5500"`);
    return true;
  }

  // ── FIX: Handle "done" after adding products ──
  if (lowerText === 'done') {
    await sendMessage(sessionPhone, fromJid, `✅ Product adding complete. Type *"products"* to view your catalog.`);
    return true;
  }

  if (lowerText.startsWith('remove ')) {
    const productName = text.substring(7).trim();
    const idx = vendor.products.findIndex(p => p.name.toLowerCase() === productName.toLowerCase());
    if (idx >= 0) {
      vendor.products.splice(idx, 1);
      await vendor.save();
      await sendMessage(sessionPhone, fromJid, `✅ *${productName}* removed.`);
    } else {
      await sendMessage(sessionPhone, fromJid, `❌ Product "${productName}" not found.`);
    }
    return true;
  }

  if (lowerText === 'pause') {
    vendor.status = 'paused';
    await vendor.save();
    await sendMessage(sessionPhone, fromJid, `⏸️ Store paused. Customers will see a pause message.`);
    return true;
  }

  if (lowerText === 'resume') {
    vendor.status = 'active';
    await vendor.save();
    await sendMessage(sessionPhone, fromJid, `▶️ Store resumed! Customers can now order.`);
    return true;
  }

  if (lowerText === 'stats') {
    const totalOrders = await Order.countDocuments({ vendor_phone: vendor.phone });
    const paidOrders = await Order.countDocuments({ vendor_phone: vendor.phone, status: 'paid' });
    const totalRevenue = await Order.aggregate([
      { $match: { vendor_phone: vendor.phone, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);
    const revenue = totalRevenue[0]?.total || 0;
    
    await sendMessage(sessionPhone, fromJid, 
      `*Sales Stats:*\n\n` +
      `Total Orders: ${totalOrders}\n` +
      `Paid Orders: ${paidOrders}\n` +
      `Total Revenue: ₦${revenue.toLocaleString()}`
    );
    return true;
  }

  if (lowerText === 'sales today') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const orders = await Order.find({ 
      vendor_phone: vendor.phone, 
      status: 'paid',
      paid_at: { $gte: start }
    });
    const total = orders.reduce((sum, o) => sum + o.total, 0);
    await sendMessage(sessionPhone, fromJid, 
      `*Today's Sales*\n\n` +
      `Orders: ${orders.length}\n` +
      `Revenue: ₦${total.toLocaleString()}`
    );
    return true;
  }

  if (lowerText === 'sales week') {
    const start = new Date();
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    const orders = await Order.find({ 
      vendor_phone: vendor.phone, 
      status: 'paid',
      paid_at: { $gte: start }
    });
    const total = orders.reduce((sum, o) => sum + o.total, 0);
    await sendMessage(sessionPhone, fromJid, 
      `*This Week's Sales*\n\n` +
      `Orders: ${orders.length}\n` +
      `Revenue: ₦${total.toLocaleString()}`
    );
    return true;
  }

  if (lowerText === 'sales month') {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const orders = await Order.find({ 
      vendor_phone: vendor.phone, 
      status: 'paid',
      paid_at: { $gte: start }
    });
    const total = orders.reduce((sum, o) => sum + o.total, 0);
    await sendMessage(sessionPhone, fromJid, 
      `*This Month's Sales*\n\n` +
      `Orders: ${orders.length}\n` +
      `Revenue: ₦${total.toLocaleString()}`
    );
    return true;
  }

  if (lowerText === 'balance') {
    await sendMessage(sessionPhone, fromJid, 
      `💰 *Balance Info*\n\n` +
      `Your earnings are automatically split and settled to your bank account (T+1).\n\n` +
      `Type *"stats"* for order totals, or *"sales today/week/month"* for breakdowns.`
    );
    return true;
  }

  if (lowerText === 'payout') {
    await sendMessage(sessionPhone, fromJid, 
      `💰 *Payout*\n\n` +
      `With Paystack subaccounts, your earnings are automatically settled to your bank account.\n\n` +
      `No manual payout needed! Money arrives in your bank within 24 hours of each payment.`
    );
    return true;
  }

  if (lowerText === 'disconnect') {
    const session = sessions.get(sessionPhone);
    if (session?.socket) {
      try { session.socket.end(); } catch(e) {}
    }
    sessions.delete(sessionPhone);
    vendor.auth_connected = false;
    vendor.status = 'onboarding';
    vendor.onboarding_step = 9;
    await vendor.save();
    await sendMessage(sessionPhone, fromJid, `❌ Disconnected. Reply *"reconnect"* on the admin number to link again.`);
    return true;
  }

  // ── FIX: Support # and $ in price matching ──
  if (msg.message?.imageMessage) {
    const caption = msg.message.imageMessage.caption || '';
    // ── FIX: Regex now matches ₦, N, #, and $ symbols ──
    const priceMatch = caption.match(/[₦N#$]\s*(\d+(?:,\d{3})*)/);
    // ── FIX: Remove all price symbols from caption to get name ──
    const nameMatch = caption.replace(/[₦N#$]\s*\d+(?:,\d{3})*/, '').trim();
    
    if (priceMatch && nameMatch) {
      const price = parseInt(priceMatch[1].replace(/,/g, ''));
      vendor.products.push({
        name: nameMatch,
        price: price,
        image_url: msg.message.imageMessage.url || ''
      });
      await vendor.save();
      await sendMessage(sessionPhone, fromJid, `✅ *${nameMatch}* added at ₦${price.toLocaleString()}. Send another or type *"done"*.`);
    } else {
      await sendMessage(sessionPhone, fromJid, `❌ Please include price in caption.\nExample: "Red Ankara ₦5500" or "Red Ankara #5500"`);
    }
    return true;
  }

  return false;
}

// ─── ONBOARDING FLOW ────────────────────────────────────────────────
async function handleOnboarding(vendor, fromJid, text, lowerText, adminPhone, msg) {
  const step = vendor.onboarding_step;

  switch (step) {
    case 0:
    case 0.5:
      if (lowerText.includes('start') || lowerText.includes('register')) {
        vendor.onboarding_step = 1;
        await vendor.save();
        await sendMessage(adminPhone, fromJid, `Let's get you set up! 🚀\n\n*What's your business name?*`);
      }
      break;

    case 1:
      vendor.business_name = text.trim();
      vendor.onboarding_step = 2;
      await vendor.save();
      await sendMessage(adminPhone, fromJid, `Nice, *${vendor.business_name}*! 🎉\n\nWhich bank do you use?\n\nExamples: GTBank, First Bank, Kuda, Opay, Palmpay`);
      break;

    case 2:
      vendor.bank_name = text.trim();
      const bankCodes = {
        'gtbank': '058', 'gtb': '058', 'guaranty trust': '058',
        'first bank': '011', 'fbn': '011',
        'uba': '033',
        'zenith': '057',
        'access': '044',
        'kuda': '50211',
        'opay': '999992', 'paycom': '999992',
        'palmpay': '999991',
        'moniepoint': '50515'
      };
      const bankKey = Object.keys(bankCodes).find(k => lowerText.includes(k));
      vendor.bank_code = bankKey ? bankCodes[bankKey] : '';
      vendor.onboarding_step = 3;
      await vendor.save();
      await sendMessage(adminPhone, fromJid, `What's your account number? (10 digits)`);
      break;

    case 3:
      const accNum = text.trim().replace(/\D/g, '');
      if (accNum.length !== 10) {
        await sendMessage(adminPhone, fromJid, '❌ Please enter a valid 10-digit account number.');
        return;
      }
      vendor.account_number = accNum;
      
      await sendMessage(adminPhone, fromJid, `⏳ Creating your payment account...`);
      const subaccountResult = await createVendorSubaccount(vendor);
      
      if (!subaccountResult.success) {
        await sendMessage(adminPhone, fromJid, 
          `❌ Failed to create payment account: ${subaccountResult.error}\n\n` +
          `Please check your bank details and try again, or contact support.`
        );
        return;
      }
      
      vendor.subaccount_code = subaccountResult.subaccount_code;
      vendor.verified_name = subaccountResult.account_name || vendor.business_name;
      vendor.onboarding_step = 5;
      await vendor.save();
      
      const testNote = IS_TEST_MODE ? '\n\n⚠️ *Test mode active:* Subaccounts are simulated. Switch to live Paystack keys for real auto-payouts.' : '';
      
      await sendMessage(adminPhone, fromJid, 
        `✅ Account verified and payment account created!${testNote}\n\n` +
        `Now send me a *short description* of what you sell.\n\n` +
        `Example: "I sell quality ankara and aso-oke fabrics for weddings and events."`
      );
      break;

    case 5:
      vendor.description = text.trim();
      vendor.onboarding_step = 6;
      await vendor.save();
      await sendMessage(adminPhone, fromJid, 
        `Great! Now send me common questions customers ask and your answers.\n\n` +
        `Format:\nQ: Do you deliver?\nA: Yes, nationwide delivery 🚚\n\n` +
        `Type *"done"* when finished.`
      );
      break;

    case 6:
      if (lowerText === 'done') {
        vendor.onboarding_step = 7;
        await vendor.save();
        await sendMessage(adminPhone, fromJid, 
          `Awesome! Now send me your *product photos* with names and prices in the caption.\n\n` +
          `Example caption: "Red Ankara ₦5500"\n\n` +
          `Type *"done"* when finished.`
        );
      } else {
        const faqMatch = text.match(/Q:\s*(.+?)\s*A:\s*(.+)/i);
        if (faqMatch) {
          vendor.faqs.push({ q: faqMatch[1].trim(), a: faqMatch[2].trim() });
          await vendor.save();
          console.log(`📝 FAQ added for ${vendor.phone}: ${faqMatch[1].trim()}`);
        } else {
          if (text.includes('?') || text.toLowerCase().includes('q:') || text.toLowerCase().includes('a:')) {
            await sendMessage(adminPhone, fromJid, `❌ Please use the format:\nQ: Question\nA: Answer\n\nOr type *"done"* to continue.`);
          }
        }
      }
      break;

    case 7:
      if (lowerText === 'done') {
        vendor.onboarding_step = 8;
        await vendor.save();
        await sendMessage(adminPhone, fromJid, 
          `🎉 *Setup Complete!*\n\n` +
          `Now let's connect your WhatsApp so customers can message you.\n\n` +
          `Reply *"connect"* to generate a QR code.`
        );
      } else if (msg.message?.imageMessage) {
        const caption = msg.message.imageMessage.caption || '';
        // ── FIX: Same regex fix for onboarding product photos ──
        const priceMatch = caption.match(/[₦N#$]\s*(\d+(?:,\d{3})*)/);
        const nameMatch = caption.replace(/[₦N#$]\s*\d+(?:,\d{3})*/, '').trim();
        
        if (priceMatch && nameMatch) {
          const price = parseInt(priceMatch[1].replace(/,/g, ''));
          vendor.products.push({
            name: nameMatch,
            price: price,
            image_url: msg.message.imageMessage.url || ''
          });
          await vendor.save();
          await sendMessage(adminPhone, fromJid, `✅ *${nameMatch}* added at ₦${price.toLocaleString()}. Send another or type *"done"*.`);
        } else {
          await sendMessage(adminPhone, fromJid, `❌ Please include price in caption.\nExample: "Red Ankara ₦5500" or "Red Ankara #5500"`);
        }
      } else {
        await sendMessage(adminPhone, fromJid, `Send a *photo* with name and price in caption, or type *"done"*.`);
      }
      break;

    case 8:
      if (lowerText === 'connect') {
        vendor.onboarding_step = 9;
        await vendor.save();
        await sendMessage(adminPhone, fromJid, `🔑 Generating QR code... Please wait.`);
        
        const result = await createSession(vendor.phone, false, fromJid);
        if (result.success) {
          vendor.status = 'active';
          vendor.onboarding_step = 10;
          await vendor.save();
        } else {
          await sendMessage(adminPhone, fromJid, `❌ Failed to connect: ${result.error || 'Unknown error'}`);
        }
      } else {
        await sendMessage(adminPhone, fromJid, `Reply *"connect"* to link your WhatsApp.`);
      }
      break;

    case 9:
      if (lowerText === 'reconnect') {
        console.log(`🧹 Clearing old auth for ${vendor.phone} before reconnect...`);
        
        if (IS_RENDER && dbReady) {
          await mongoose.model('AuthState').deleteOne({ phone: cleanPhone(vendor.phone) });
        } else {
          const sessionDir = `${BASE_DIR}/auth_info/${cleanPhone(vendor.phone)}`;
          if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }
        }
        
        sessions.delete(cleanPhone(vendor.phone));
        
        await sendMessage(adminPhone, fromJid, `🔑 Generating fresh QR code... Please wait.`);
        
        const result = await createSession(vendor.phone, false, fromJid);
        if (result.success) {
          await sendMessage(adminPhone, fromJid, `✅ Reconnected!`);
          vendor.status = 'active';
          vendor.onboarding_step = 10;
          await vendor.save();
        } else {
          await sendMessage(adminPhone, fromJid, `❌ Reconnection failed: ${result.error || 'Unknown error'}`);
        }
      } else {
        await sendMessage(adminPhone, fromJid, `Your WhatsApp disconnected. Reply *"reconnect"* to link again.`);
      }
      break;

    default:
      await sendMessage(adminPhone, fromJid, `Something went wrong. Please contact support.`);
      break;
  }
}

// ─── CUSTOMER MESSAGE HANDLER ───────────────────────────────────────
async function handleCustomerMessage(vendor, fromJid, text, lowerText, sessionPhone, customerPhone) {
  if (fromJid.includes('status@broadcast')) {
    return;
  }
  
  const cartKey = `${vendor.phone}:${customerPhone}`;
  
  const buyingTriggers = ['menu', 'buy', 'product', 'order', 'price', 'how much', 'do you have', 'i want', 'i need', 'available', 'stock', '₦', 'naira'];
  const casualGreetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'how are you', 'sup', 'wetin dey', 'how far'];
  const isCasualGreeting = casualGreetings.some(g => lowerText.includes(g));
  const hasBuyingIntent = buyingTriggers.some(t => lowerText.includes(t));
  
  if (isCasualGreeting && !hasBuyingIntent && !activeCarts.has(cartKey)) {
    console.log(`🔇 Silent: Casual greeting from ${customerPhone} to ${vendor.phone}: "${text.substring(0, 30)}"`);
    return;
  }
  
  if (lowerText === 'menu' || lowerText === 'start' || hasBuyingIntent) {
    let menu = `👋 *Welcome to ${vendor.business_name}!*\n\n`;
    menu += `${vendor.description}\n\n`;
    menu += `*Our Products:*\n`;
    vendor.products.forEach((p, i) => {
      menu += `${i+1}. ${p.name} - ₦${p.price.toLocaleString()}\n`;
    });
    menu += `\nReply with a product *number* to order.\n`;
    menu += `Or type *"help"* for assistance.`;
    await sendMessage(sessionPhone, fromJid, menu);
    return;
  }

  if (lowerText === 'help') {
    let help = `*How to Order:*\n\n`;
    help += `1. Type *"menu"* to see products\n`;
    help += `2. Reply with product number\n`;
    help += `3. Confirm your order\n`;
    help += `4. Pay into the virtual account\n`;
    help += `5. We'll notify the vendor!\n\n`;
    if (vendor.faqs.length > 0) {
      help += `*FAQs:*\n`;
      vendor.faqs.forEach((f, i) => {
        help += `Q: ${f.q}\nA: ${f.a}\n\n`;
      });
    }
    await sendMessage(sessionPhone, fromJid, help);
    return;
  }

  const productNum = parseInt(lowerText);
  if (!isNaN(productNum) && productNum > 0 && productNum <= vendor.products.length) {
    const product = vendor.products[productNum - 1];
    activeCarts.set(cartKey, { product, qty: 1 });
    
    await sendMessage(sessionPhone, fromJid, 
      `*${product.name}*\n` +
      `Price: ₦${product.price.toLocaleString()}\n\n` +
      `Reply *"buy"* to purchase, or *"cancel"* to go back.`
    );
    return;
  }

  if (lowerText === 'buy') {
    const cart = activeCarts.get(cartKey);
    if (!cart) {
      await sendMessage(sessionPhone, fromJid, `No item selected. Type *"menu"* to browse.`);
      return;
    }

    const order = new Order({
      vendor_phone: vendor.phone,
      customer_phone: customerPhone,
      customer_name: 'Customer',
      items: [{ name: cart.product.name, qty: cart.qty, price: cart.product.price }],
      total: cart.product.price * cart.qty
    });
    await order.save();

    const va = await createVirtualAccount(order, 'Customer');
    if (va.success) {
      order.virtual_account = {
        account_name: va.account_name,
        account_number: va.account_number,
        bank_name: va.bank_name,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      };
      await order.save();

      await sendMessage(sessionPhone, fromJid, 
        `🛒 *Order Confirmed!*\n\n` +
        `Item: ${cart.product.name}\n` +
        `Total: ₦${order.total.toLocaleString()}\n\n` +
        `*Payment Details:*\n` +
        `Bank: ${va.bank_name}\n` +
        `Account: ${va.account_number}\n` +
        `Name: ${va.account_name}\n\n` +
        `⏰ Valid for 24 hours. Pay to complete your order!`
      );
      
      await sendMessage(vendor.phone, formatJid(vendor.phone), 
        `📦 *New Order!*\n\n` +
        `Customer: ${customerPhone}\n` +
        `Item: ${cart.product.name}\n` +
        `Amount: ₦${order.total.toLocaleString()}\n\n` +
        `Waiting for payment...`
      );
    } else {
      await sendMessage(sessionPhone, fromJid, `❌ Failed to create payment account. Please try again.`);
    }
    activeCarts.delete(cartKey);
    return;
  }

  if (lowerText === 'cancel') {
    activeCarts.delete(cartKey);
    await sendMessage(sessionPhone, fromJid, `❌ Cancelled. Type *"menu"* to browse.`);
    return;
  }

  if (!hasBuyingIntent && !activeCarts.has(cartKey)) {
    console.log(`🔇 Silent: No buying intent from ${customerPhone}: "${text.substring(0, 30)}"`);
    return;
  }

  await sendMessage(sessionPhone, fromJid, 
    `I didn't understand that. Type *"menu"* to see products or *"help"* for assistance.`
  );
}

// ─── PAYSTACK WEBHOOK ───────────────────────────────────────────────
app.post('/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_WEBHOOK_SECRET).update(req.body).digest('hex');
  
  if (hash !== signature) {
    return res.status(400).send('Invalid signature');
  }

  const event = JSON.parse(req.body);
  console.log('🔔 Paystack webhook:', event.event);

  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    const order = await Order.findOne({ paystack_ref: reference });
    
    if (order) {
      order.status = 'paid';
      order.paid_at = new Date();
      await order.save();

      const vendor = await Vendor.findOne({ phone: order.vendor_phone });
      if (vendor) {
        const payoutMsg = IS_TEST_MODE 
          ? '✅ Payment confirmed (test mode — no real money moved).'
          : 'Your share (90%) has been credited to your subaccount and will settle to your bank shortly.';
        
        await sendMessage(vendor.phone, formatJid(vendor.phone), 
          `🎉 *Order Paid!*\n\n` +
          `Customer: ${order.customer_phone}\n` +
          `Amount: ₦${order.total.toLocaleString()}\n` +
          `${payoutMsg}`
        );
      }

      await sendMessage(order.vendor_phone, formatJid(order.customer_phone), 
        `✅ *Payment Received!*\n\n` +
        `Your order has been confirmed.\n` +
        `The vendor will process it shortly.`
      );
    }
  }

  res.status(200).send('OK');
});

// ─── EXPRESS ROUTES ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'NaijaSales AI is running', connectedSessions: sessions.size });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    db: dbReady,
    sessions: Array.from(sessions.keys()),
    uptime: process.uptime()
  });
});

// ─── KEEP-ALIVE PING ────────────────────────────────────────────────
setInterval(() => {
  if (WEBHOOK_BASE && WEBHOOK_BASE !== `http://localhost:${process.env.PORT || 3000}`) {
    axios.get(`${WEBHOOK_BASE}/health`)
      .then(() => console.log('💓 Keep-alive ping sent'))
      .catch(err => console.log('⚠️ Keep-alive ping failed:', err.message));
  }
}, 5 * 60 * 1000);

// ─── CONNECTION MONITOR ─────────────────────────────────────────────
setInterval(async () => {
  for (const [phone, session] of sessions.entries()) {
    if (!session.connected || !session.socket?.ws) {
      console.log(`⏸️ Skipping heartbeat for ${phone} (not connected)`);
      continue;
    }
    
    try {
      await session.socket.sendPresenceUpdate('available');
      console.log(`💓 Heartbeat sent for ${phone}`);
    } catch (err) {
      console.log(`⚠️ Heartbeat failed for ${phone}:`, err.message);
      session.connected = false;
      setTimeout(() => {
        if (!sessions.get(phone)?.connected) {
          createSession(phone, session.isAdmin);
        }
      }, 3000);
    }
  }
}, 60000);

// ─── ADMIN SESSION WATCHDOG ─────────────────────────────────────────
setInterval(async () => {
  if (!dbReady) {
    console.log('⏸️ Watchdog skipped: DB not ready');
    return;
  }
  
  const adminClean = cleanPhone(ADMIN_PHONE);
  const adminSession = sessions.get(adminClean);
  
  if (!adminSession) {
    console.log('👀 Admin session watchdog: no session, reconnecting...');
    await createSession(ADMIN_PHONE, true);
  }
  else if (adminSession.resolved && !adminSession.connected) {
    console.log('👀 Admin session watchdog: was disconnected, reconnecting...');
    await createSession(ADMIN_PHONE, true);
  }
}, 30000);

// ─── AUTO-RECONNECT ALL SESSIONS ON STARTUP ─────────────────────────
async function reconnectAllSessions() {
  if (!dbReady) {
    console.log('⏸️ Reconnect skipped: DB not ready');
    return;
  }
  
  console.log('🔄 Checking for sessions to reconnect...');
  
  if (ADMIN_PHONE && !sessions.get(cleanPhone(ADMIN_PHONE))?.connected) {
    console.log('🔑 Reconnecting admin session...');
    await createSession(ADMIN_PHONE, true);
  }
  
  const activeVendors = await Vendor.find({ auth_connected: true });
  for (const vendor of activeVendors) {
    if (!sessions.get(vendor.phone)?.connected) {
      console.log(`🔄 Reconnecting vendor ${vendor.phone}...`);
      await createSession(vendor.phone, false);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ─── START SERVER ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`☁️ Render mode: ${IS_RENDER ? 'YES (MongoDB auth)' : 'NO (file auth)'}`);
  console.log(`📱 Admin: ${ADMIN_PHONE}`);
  
  if (ADMIN_PHONE) {
    console.log('🔑 Starting admin session...');
    await createSession(ADMIN_PHONE, true);
  }
  
  setTimeout(reconnectAllSessions, 5000);
});
