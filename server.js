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

if (!ADMIN_PHONE) {
  console.error('❌ ADMIN_PHONE not set in .env');
  process.exit(1);
}

if (!PAYSTACK_SECRET) {
  console.error('❌ PAYSTACK_SECRET_KEY not set in .env');
  process.exit(1);
}

// ─── ENSURE AUTH DIRECTORY EXISTS (Render persistence) ──────────────
const authBaseDir = process.env.RENDER_DISK_PATH || '.';
const authDir = `${authBaseDir}/auth_info`;
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
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
async function createVirtualAccount(order, customerName) {
  try {
    const customerRes = await axios.post('https://api.paystack.co/customer', {
      email: `${order.customer_phone}@temp.naijasales.ai`,
      first_name: customerName.split(' ')[0] || 'Customer',
      last_name: customerName.split(' ').slice(1).join(' ') || '',
      phone: `+${order.customer_phone}`
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }});
    if (!customerRes.data.status) return { success: false, error: customerRes.data.message };
    const vaRes = await axios.post('https://api.paystack.co/dedicated_account', {
      customer: customerRes.data.data.customer_code, preferred_bank: 'wema-bank'
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }});
    if (vaRes.data.status) {
      const account = vaRes.data.data;
      return { success: true, account_name: account.account_name, account_number: account.account_number, bank_name: account.bank.name || account.bank_slug, account_id: account.id, customer_code: customerRes.data.data.customer_code };
    }
    return { success: false, error: vaRes.data.message };
  } catch (err) { return { success: false, error: err.response?.data?.message || err.message }; }
}

async function verifyTransaction(reference) {
  try { return (await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }})).data; }
  catch (err) { return { status: false, message: err.message }; }
}

async function transferToVendor(vendor, amountKobo, reference, reason) {
  try {
    const recipientRes = await axios.post('https://api.paystack.co/transferrecipient', {
      type: 'nuban', name: vendor.verified_name || vendor.business_name,
      account_number: vendor.account_number, bank_code: vendor.bank_code || '058', currency: 'NGN'
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }});
    if (!recipientRes.data.status) return { success: false, error: recipientRes.data.message };
    const transferRes = await axios.post('https://api.paystack.co/transfer', {
      source: 'balance', amount: amountKobo, reference, recipient: recipientRes.data.data.recipient_code, reason
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }});
    return transferRes.data;
  } catch (err) { return { status: false, message: err.message }; }
}

// ─── SESSION CREATION (QR CODE VERSION) ──────────────────────────────
async function createSession(phone, isAdmin = false, requesterJid = null) {
  const clean = cleanPhone(phone);
  const sessionDir = `${BASE_DIR}/auth_info/${clean}`;

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  if (sessions.has(clean)) {
    const existing = sessions.get(clean);
    if (existing.connected) {
      return { success: true, alreadyConnected: true };
    }
    try { existing.socket?.end(); } catch(e) {}
    sessions.delete(clean);
  }

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[${clean}] Using WA version: ${version.join('.')}, isLatest: ${isLatest}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

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
      maxReconnects: 10
    };
    sessions.set(clean, sessionData);

    sock.ev.on('creds.update', saveCreds);

    const connectionPromise = new Promise((resolve) => {
      
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`[${clean}] Connection update:`, { connection, hasQR: !!qr });
        
        // ── GENERATE AND SEND QR CODE ──
        if (qr && !sessionData.qrSent) {
          sessionData.qrSent = true;
          
          try {
            const qrBuffer = await QRCode.toBuffer(qr, { 
              width: 400,
              margin: 2,
              type: 'png'
            });
            
            const qrPath = `${sessionDir}/qr-code.png`;
            fs.writeFileSync(qrPath, qrBuffer);
            console.log(`\n📱 [${clean}] QR Code generated!`);
            console.log(`   Saved to: ${qrPath}`);
            
            // ── FIX: Send QR via ADMIN session ──
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
        
        // ── CONNECTION OPENED ──
        if (connection === 'open' && !sessionData.resolved) {
          sessionData.connected = true;
          sessionData.resolved = true;
          sessionData.reconnectAttempts = 0;
          console.log(`✅ [${clean}] CONNECTED`);
          if (!isAdmin) {
            await Vendor.updateOne({ phone: clean }, { $set: { auth_connected: true } });
          }
          resolve({ success: true });
        }
        
        // ── CONNECTION CLOSED ──
        if (connection === 'close') {
          sessionData.connected = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          
          console.log(`❌ [${clean}] Disconnected (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

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
            fs.rmSync(sessionDir, { recursive: true, force: true });
            if (!isAdmin) {
              await Vendor.updateOne(
                { phone: clean },
                { $set: { auth_connected: false, status: 'onboarding', onboarding_step: 9 } }
              );
            }
          }
        }
      });
      
      // ── FIX: 3 minute timeout ──
      setTimeout(() => {
        if (!sessionData.resolved) {
          resolve({ success: false, error: 'Timeout - QR code expired. Please try again.' });
        }
      }, 180000);
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue;
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
  const senderClean = cleanPhone(senderJid.split('@')[0]);
  const text = getMessageText(msg);
  const lowerText = text.toLowerCase().trim();

  console.log(`📩 [${sessionPhone}] ${isAdminSession ? 'ADMIN' : 'VENDOR'} | From: ${senderClean} | Group: ${isGroup} | "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

  if (!dbReady) {
    console.log('⚠️ DB not ready');
    return;
  }

  // ── Ignore group chats for onboarding/admin ──
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
    await handleVendorSelfManagement(vendor, fromJid, text, lowerText, sessionPhone, msg);
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
  
  if (fromJid.endsWith('@g.us')) {
    console.log(`⏸️ Admin handler ignoring group message from ${sender}`);
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
    let reply = `👤 *${vendor.business_name}*\nPhone: ${vendor.phone}\nStatus: ${v.status}\nConnected: ${vendor.auth_connected ? '✅' : '❌'}\nProducts: ${vendor.products.length}\nPaid Orders: ${salesCount}\n`;
    await sendMessage(adminPhone, fromJid, reply);
    return;
  }

  let vendor = await Vendor.findOne({ phone: sender });

  if (!vendor) {
    if (lowerText.includes('register') || lowerText.includes('start') || lowerText.includes('sell')) {
      vendor = new Vendor({ phone: sender, onboarding_step: 0 });
      await vendor.save();
      await sendMessage(adminPhone, fromJid, 
        `👋 *Welcome to NaijaSales AI!*\n\n` +
        `I'm your personal sales assistant. I'll help you sell your products 24/7 on WhatsApp.\n\n` +
        `Reply *"start"* to begin setup.`
      );
      vendor.onboarding_step = 0.5;
      await vendor.save();
    } else {
      await sendMessage(adminPhone, fromJid, 
        `👋 Hi! Want to start selling on WhatsApp?\n\n` +
        `Reply *"register"* to get started.`
      );
    }
    return;
  }

  if (vendor.status === 'onboarding') {
    await handleOnboarding(vendor, fromJid, text, lowerText, adminPhone, msg);
    return;
  }

  await sendMessage(adminPhone, fromJid, 
    `👋 *${vendor.business_name}*, your store is active!\n\n` +
    `To manage your store, message your own WhatsApp number: *${vendor.phone}*\n\n` +
    `Or type *"help"* for commands.`
  );
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
      vendor.onboarding_step = 4;
      await vendor.save();
      
      setTimeout(async () => {
        vendor.verified_name = vendor.business_name;
        vendor.onboarding_step = 5;
        await vendor.save();
        await sendMessage(adminPhone, fromJid, 
          `✅ Account verified!\n\n` +
          `Now send me a *short description* of what you sell.\n\n` +
          `Example: "I sell quality ankara and aso-oke fabrics for weddings and events."`
        );
      }, 1500);
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
        const priceMatch = caption.match(/[₦N]\s*(\d+(?:,\d{3})*)/);
        const nameMatch = caption.replace(/[₦N]\s*\d+(?:,\d{3})*/, '').trim();
        
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
          await sendMessage(adminPhone, fromJid, `❌ Please include price in caption.\nExample: "Red Ankara ₦5500"`);
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
          await sendMessage(adminPhone, fromJid, `✅ WhatsApp connected! Your store is now active.`);
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

// ─── VENDOR SELF-MANAGEMENT ─────────────────────────────────────────
async function handleVendorSelfManagement(vendor, fromJid, text, lowerText, sessionPhone, msg) {
  if (lowerText === 'help') {
    await sendMessage(sessionPhone, fromJid, 
      `*Store Management Commands:*\n\n` +
      `• *products* - View your products\n` +
      `• *add product* - Add a new product\n` +
      `• *remove [name]* - Remove a product\n` +
      `• *pause* - Pause your store\n` +
      `• *resume* - Resume your store\n` +
      `• *stats* - View sales stats\n` +
      `• *balance* - Check payouts\n` +
      `• *disconnect* - Disconnect WhatsApp`
    );
    return;
  }

  if (lowerText === 'products') {
    if (vendor.products.length === 0) {
      await sendMessage(sessionPhone, fromJid, `You have no products yet. Send *"add product"* to add one.`);
      return;
    }
    let reply = `*Your Products:*\n\n`;
    vendor.products.forEach((p, i) => {
      reply += `${i+1}. ${p.name} - ₦${p.price.toLocaleString()}\n`;
    });
    await sendMessage(sessionPhone, fromJid, reply);
    return;
  }

  if (lowerText === 'add product') {
    await sendMessage(sessionPhone, fromJid, `Send a product photo with the name and price in the caption.\nExample: "Red Ankara ₦5500"`);
    return;
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
    return;
  }

  if (lowerText === 'pause') {
    vendor.status = 'paused';
    await vendor.save();
    await sendMessage(sessionPhone, fromJid, `⏸️ Store paused. Customers will see a pause message.`);
    return;
  }

  if (lowerText === 'resume') {
    vendor.status = 'active';
    await vendor.save();
    await sendMessage(sessionPhone, fromJid, `▶️ Store resumed! Customers can now order.`);
    return;
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
    return;
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
    return;
  }

  if (msg.message?.imageMessage && vendor.onboarding_step >= 10) {
    const caption = msg.message.imageMessage.caption || '';
    const priceMatch = caption.match(/[₦N]\s*(\d+(?:,\d{3})*)/);
    const nameMatch = caption.replace(/[₦N]\s*\d+(?:,\d{3})*/, '').trim();
    
    if (priceMatch && nameMatch) {
      const price = parseInt(priceMatch[1].replace(/,/g, ''));
      vendor.products.push({
        name: nameMatch,
        price: price,
        image_url: msg.message.imageMessage.url || ''
      });
      await vendor.save();
      await sendMessage(sessionPhone, fromJid, `✅ *${nameMatch}* added at ₦${price.toLocaleString()}.`);
    } else {
      await sendMessage(sessionPhone, fromJid, `❌ Please include price in caption.\nExample: "Red Ankara ₦5500"`);
    }
    return;
  }

  await sendMessage(sessionPhone, fromJid, `Type *"help"* for available commands.`);
}

// ─── CUSTOMER MESSAGE HANDLER ───────────────────────────────────────
async function handleCustomerMessage(vendor, fromJid, text, lowerText, sessionPhone, customerPhone) {
  // ── FIX: Skip status/broadcast messages ──
  if (fromJid.includes('status@broadcast')) {
    return;
  }
  
  const cartKey = `${vendor.phone}:${customerPhone}`;
  
  if (lowerText === 'hi' || lowerText === 'hello' || lowerText === 'start' || lowerText === 'menu') {
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
        const commissionRate = 0.05;
        const amountKobo = Math.floor(order.total * (1 - commissionRate) * 100);
        const transferRef = `tf_${Date.now()}_${order._id}`;
        
        const transfer = await transferToVendor(vendor, amountKobo, transferRef, `Order payment - ${order.customer_phone}`);
        
        if (transfer.status) {
          order.paystack_transfer_ref = transferRef;
          await order.save();
          
          await sendMessage(vendor.phone, formatJid(vendor.phone), 
            `🎉 *New Order Paid!*\n\n` +
            `Customer: ${order.customer_phone}\n` +
            `Amount: ₦${order.total.toLocaleString()}\n` +
            `Payout: ₦${(amountKobo / 100).toLocaleString()}\n` +
            `Transfer Ref: ${transferRef}`
          );
        }
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

// ─── KEEP-ALIVE PING (Prevents Render from sleeping) ─────────────────
setInterval(() => {
  if (WEBHOOK_BASE && WEBHOOK_BASE !== `http://localhost:${process.env.PORT || 3000}`) {
    axios.get(`${WEBHOOK_BASE}/health`)
      .then(() => console.log('💓 Keep-alive ping sent'))
      .catch(err => console.log('⚠️ Keep-alive ping failed:', err.message));
  }
}, 5 * 60 * 1000);

// ─── AUTO-RECONNECT ALL SESSIONS ON STARTUP ─────────────────────────
async function reconnectAllSessions() {
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
  console.log(`📱 Admin: ${ADMIN_PHONE}`);
  
  if (ADMIN_PHONE) {
    console.log('🔑 Starting admin session...');
    await createSession(ADMIN_PHONE, true);
  }
  
  setTimeout(reconnectAllSessions, 5000);
});
