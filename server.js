require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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

// ─── MONGODB ────────────────────────────────────────────────────────
let dbReady = false;
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => { dbReady = true; console.log('✅ MongoDB connected'); })
  .catch(err => { console.error('❌ MongoDB error:', err.message); });

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
  pairing_retries: { type: Number, default: 0 },
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

// ─── PAYSTACK: CREATE VIRTUAL ACCOUNT ───────────────────────────────
async function createVirtualAccount(order, customerName) {
  try {
    // Step 1: Create customer
    const customerRes = await axios.post(
      'https://api.paystack.co/customer',
      {
        email: `${order.customer_phone}@temp.naijasales.ai`,
        first_name: customerName.split(' ')[0] || 'Customer',
        last_name: customerName.split(' ').slice(1).join(' ') || '',
        phone: `+${order.customer_phone}`
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!customerRes.data.status) {
      return { success: false, error: customerRes.data.message };
    }

    const customerCode = customerRes.data.data.customer_code;

    // Step 2: Create dedicated virtual account
    const vaRes = await axios.post(
      'https://api.paystack.co/dedicated_account',
      {
        customer: customerCode,
        preferred_bank: 'wema-bank',
        // For test mode, use 'test-bank'
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (vaRes.data.status) {
      const account = vaRes.data.data;
      return {
        success: true,
        account_name: account.account_name,
        account_number: account.account_number,
        bank_name: account.bank.name || account.bank.slug,
        account_id: account.id,
        customer_code: customerCode
      };
    }

    return { success: false, error: vaRes.data.message };
  } catch (err) {
    console.error('Paystack VA error:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ─── PAYSTACK: VERIFY TRANSACTION ─────────────────────────────────
async function verifyTransaction(reference) {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
      }
    );
    return response.data;
  } catch (err) {
    console.error('Paystack verify error:', err.response?.data || err.message);
    return { status: false, message: err.message };
  }
}

// ─── PAYSTACK: TRANSFER TO VENDOR ──────────────────────────────────
async function transferToVendor(vendor, amountKobo, reference, reason) {
  try {
    const recipientRes = await axios.post(
      'https://api.paystack.co/transferrecipient',
      {
        type: 'nuban',
        name: vendor.verified_name || vendor.business_name,
        account_number: vendor.account_number,
        bank_code: vendor.bank_code || '058',
        currency: 'NGN'
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!recipientRes.data.status) {
      return { success: false, error: recipientRes.data.message };
    }

    const recipientCode = recipientRes.data.data.recipient_code;

    const transferRes = await axios.post(
      'https://api.paystack.co/transfer',
      {
        source: 'balance',
        amount: amountKobo,
        reference: reference,
        recipient: recipientCode,
        reason: reason
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return transferRes.data;
  } catch (err) {
    console.error('Paystack transfer error:', err.response?.data || err.message);
    return { status: false, message: err.message };
  }
}

// ─── SESSION CREATION (PAIRING FIX) ─────────────────────────────────
async function createSession(phone, isAdmin = false) {
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
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: isAdmin ? ['NaijaSales AI', 'Admin', '1.0'] : ['Chrome (Linux)', '', ''],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000
    });

    const sessionData = {
      socket: sock,
      connected: false,
      saveCreds,
      pairingCode: null,
      isAdmin,
      phone: clean
    };
    sessions.set(clean, sessionData);

    // Credentials update handler
    sock.ev.on('creds.update', saveCreds);

    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      console.log(`[${clean}] Connection: ${connection}`);

      if (connection === 'open') {
        sessionData.connected = true;
        console.log(`✅ [${clean}] CONNECTED`);
        if (!isAdmin) {
          await Vendor.updateOne({ phone: clean }, { $set: { auth_connected: true } });
        }
      }

      if (connection === 'close') {
        sessionData.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`❌ [${clean}] Disconnected (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => {
            if (!sessions.get(clean)?.connected) {
              console.log(`🔄 [${clean}] Auto-reconnecting...`);
              createSession(clean, isAdmin);
            }
          }, 5000);
        } else {
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

    // Message handler
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue;
        await handleIncomingMessage(clean, msg, isAdmin);
      }
    });

    // Wait for WebSocket to open before requesting pairing code
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (sock.ws?.readyState === 1) {
          clearInterval(check);
          resolve();
        }
      }, 500);
      setTimeout(() => { clearInterval(check); resolve(); }, 15000);
    });

    // If already authenticated, skip pairing
    if (state.creds?.me?.id) {
      return { success: true, alreadyConnected: true };
    }

    // Request pairing code
    const code = await sock.requestPairingCode(`+${clean}`);
    sessionData.pairingCode = code;
    console.log(`🔑 [${clean}] Pairing code: ${code}`);
    return { success: true, code };

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

  console.log(`📩 [${sessionPhone}] ${isAdminSession ? 'ADMIN' : 'VENDOR'} | From: ${senderClean} | "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

  if (!dbReady) {
    console.log('⚠️ DB not ready');
    return;
  }

  if (isAdminSession) {
    await handleAdminMessage(senderClean, fromJid, text, lowerText, sessionPhone);
    return;
  }

  const vendor = await Vendor.findOne({ phone: sessionPhone });
  if (!vendor) {
    console.log(`⚠️ No vendor found for session ${sessionPhone}`);
    return;
  }

  if (senderClean === sessionPhone) {
    await handleVendorSelfManagement(vendor, fromJid, text, lowerText, sessionPhone);
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
async function handleAdminMessage(sender, fromJid, text, lowerText, adminPhone) {
  
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
    let reply = `👤 *${vendor.business_name}*\nPhone: ${vendor.phone}\nStatus: ${vendor.status}\nConnected: ${vendor.auth_connected ? '✅' : '❌'}\nProducts: ${vendor.products.length}\nPaid Orders: ${salesCount}\n`;
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
    await handleOnboarding(vendor, fromJid, text, lowerText, adminPhone);
    return;
  }

  await sendMessage(adminPhone, fromJid, 
    `👋 *${vendor.business_name}*, your store is active!\n\n` +
    `To manage your store, message your own WhatsApp number: *${vendor.phone}*\n\n` +
    `Or type *"help"* for commands.`
  );
}

// ─── ONBOARDING FLOW ────────────────────────────────────────────────
async function handleOnboarding(vendor, fromJid, text, lowerText, adminPhone) {
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
          await sendMessage(adminPhone, fromJid, '✅ FAQ saved! Send another or type *"done"*.');
        } else {
          await sendMessage(adminPhone, fromJid, 'Please use format:\nQ: [question]\nA: [answer]\n\nOr type *"done"* to continue.');
        }
      }
      break;

    case 7:
      if (lowerText === 'done') {
        vendor.onboarding_step = 8;
        await vendor.save();
        await sendMessage(adminPhone, fromJid, 
          `Final step! 📋\n\n` +
          `What are your *group rules* for customers?\n\n` +
          `Example: "No price bargaining in group. DM for bulk orders. Respect everyone."`
        );
      } else {
        const captionText = text || '';
        const productMatch = captionText.match(/(.+?)\s*[₦N]\s*(\d+)/i);
        if (productMatch) {
          vendor.products.push({
            name: productMatch[1].trim(),
            price: parseInt(productMatch[2])
          });
          await vendor.save();
          await sendMessage(adminPhone, fromJid, 
            `✅ Added: ${productMatch[1].trim()} — ₦${parseInt(productMatch[2]).toLocaleString()}\n\n` +
            `Send another or type *"done"*`
          );
        } else {
          await sendMessage(adminPhone, fromJid, 'Please use format: "Product Name ₦Price"\n\nExample: "Red Ankara ₦5500"');
        }
      }
      break;

    case 8:
      vendor.group_rules = text.trim();
      vendor.onboarding_step = 9;
      await vendor.save();
      
      await sendMessage(adminPhone, fromJid, 
        `Almost done! 🎉\n\n` +
        `I need to connect to your WhatsApp to sell for you. Generating your connection code...`
      );
      
      setTimeout(async () => {
        const result = await createSession(vendor.phone, false);
        
        if (result.alreadyConnected) {
          vendor.status = 'active';
          vendor.onboarding_step = 10;
          vendor.auth_connected = true;
          await vendor.save();
          await sendMessage(adminPhone, fromJid, 
            `🎉 *${vendor.business_name}* is LIVE! 🎉\n\n` +
            `Your store is active on your number. Customers can now message you to buy.\n\n` +
            `*To manage your store, message your own number: ${vendor.phone}*\n\n` +
            `*Commands:*\n• "How much sales today?"\n• "Show my catalogue"\n• "Change [product] price to [amount]"\n• "Add product [name] ₦[price]"\n• "Pause my store" / "Resume"\n\nGood luck! 🚀`
          );
        } else if (result.success) {
          vendor.onboarding_step = 9.5;
          await vendor.save();
          await sendMessage(adminPhone, fromJid, 
            `📱 *Your connection code: ${result.code}*\n\n` +
            `👉 Open WhatsApp on THIS phone\n` +
            `👉 Go to: *Settings → Linked Devices → Link with Phone Number*\n` +
            `👉 Enter: *${result.code}*\n\n` +
            `⏰ You have 60 seconds. Reply *"done"* when finished.`
          );
        } else {
          vendor.pairing_retries += 1;
          await vendor.save();
          await sendMessage(adminPhone, fromJid, 
            `❌ Failed to generate code: ${result.error}\n\n` +
            `Reply *"retry"* to try again.`
          );
        }
      }, 2000);
      break;

    case 9.5:
      if (lowerText === 'done') {
        let attempts = 0;
        const maxAttempts = 12;
        
        const pollConnection = async () => {
          const session = sessions.get(vendor.phone);
          
          if (session?.connected) {
            vendor.status = 'active';
            vendor.onboarding_step = 10;
            vendor.pairing_retries = 0;
            vendor.auth_connected = true;
            await vendor.save();
            await sendMessage(adminPhone, fromJid, 
              `🎉 *${vendor.business_name}* is LIVE! 🎉\n\n` +
              `Your store is active on your number. Customers can now message you to buy.\n\n` +
              `*To manage your store, message your own number: ${vendor.phone}*\n\n` +
              `*Commands:*\n• "How much sales today?"\n• "Show my catalogue"\n• "Change [product] price to [amount]"\n• "Add product [name] ₦[price]"\n• "Pause my store" / "Resume"\n• "Show group rules"\n\nGood luck! 🚀`
            );
            return;
          }
          
          attempts++;
          if (attempts >= maxAttempts) {
            await sendMessage(adminPhone, fromJid, 
              `⏳ Connection not detected yet. Please check:\n` +
              `1. You entered the code: *${session?.pairingCode || 'unknown'}*\n` +
              `2. Your WhatsApp is the latest version\n` +
              `3. You have stable internet\n\n` +
              `Reply *"done"* to check again or *"retry"* for a new code.`
            );
            return;
          }
          
          setTimeout(pollConnection, 5000);
        };
        
        pollConnection();
        
      } else if (lowerText === 'retry') {
        if (vendor.pairing_retries >= 3) {
          await sendMessage(adminPhone, fromJid, 
            `❌ Too many retries. Please make sure:\n` +
            `1. You're using the latest WhatsApp\n` +
            `2. Go to Settings → Linked Devices → Link with Phone Number\n` +
            `3. Enter the code quickly (within 60 seconds)\n\n` +
            `Reply *"retry"* to try again or *"help"* for assistance.`
          );
          vendor.pairing_retries = 0;
          await vendor.save();
          return;
        }
        
        const oldSession = sessions.get(vendor.phone);
        if (oldSession) {
          try { oldSession.socket?.end(); } catch(e) {}
          sessions.delete(vendor.phone);
        }
        
        const result = await createSession(vendor.phone, false);
        vendor.pairing_retries += 1;
        await vendor.save();
        
        if (result.success) {
          await sendMessage(adminPhone, fromJid, 
            `📱 *New code: ${result.code}*\n\n` +
            `👉 Enter this code now: *${result.code}*\n` +
            `⏰ 60 seconds. Reply *"done"* when finished.`
          );
        } else {
          await sendMessage(adminPhone, fromJid, `❌ Error: ${result.error}. Reply *"retry"* to try again.`);
        }
      } else {
        await sendMessage(adminPhone, fromJid, 
          `⏳ Waiting for you to enter the pairing code.\n\n` +
          `Reply *"done"* once you've entered it, or *"retry"* for a new code.`
        );
      }
      break;

    default:
      await sendMessage(adminPhone, fromJid, 'Let\'s continue! What would you like to do?');
  }
}

// ─── VENDOR SELF-MANAGEMENT ─────────────────────────────────────────
async function handleVendorSelfManagement(vendor, fromJid, text, lowerText, vendorPhone) {
  
  if (vendor.status === 'paused') {
    if (lowerText.includes('resume')) {
      vendor.status = 'active';
      await vendor.save();
      await sendMessage(vendorPhone, fromJid, '▶️ Store resumed! Taking orders now. 💪');
    } else {
      await sendMessage(vendorPhone, fromJid, '⏸️ Your store is paused. Say *"resume"* to start taking orders again.');
    }
    return;
  }

  if (lowerText.includes('sales today') || lowerText.includes('how much sales') || lowerText.includes('money today')) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const orders = await Order.find({ vendor_phone: vendor.phone, status: 'paid', created_at: { $gte: today } });
    const total = orders.reduce((sum, o) => sum + o.total, 0);
    await sendMessage(vendorPhone, fromJid, `📊 *Today's Sales*\n\n💰 Total: ₦${total.toLocaleString()}\n📦 Orders: ${orders.length}\n\nKeep grinding! 💪`);
    return;
  }

  if (lowerText.includes('sales this week') || lowerText.includes('week sales')) {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const orders = await Order.find({ vendor_phone: vendor.phone, status: 'paid', created_at: { $gte: weekAgo } });
    const total = orders.reduce((sum, o) => sum + o.total, 0);
    await sendMessage(vendorPhone, fromJid, `📊 *This Week*\n\n💰 Total: ₦${total.toLocaleString()}\n📦 Orders: ${orders.length}`);
    return;
  }

  if (lowerText.includes('catalogue') || lowerText.includes('show my products') || lowerText.includes('my products')) {
    if (vendor.products.length === 0) {
      await sendMessage(vendorPhone, fromJid, '📭 Your catalogue is empty. Send me products to add them!');
      return;
    }
    let reply = `📦 *${vendor.business_name} — Catalogue*\n\n`;
    vendor.products.forEach((p, i) => {
      reply += `${i + 1}. ${p.name}\n   ₦${p.price.toLocaleString()}\n\n`;
    });
    reply += 'To change a price, say: "Change [product] price to [amount]"';
    await sendMessage(vendorPhone, fromJid, reply);
    return;
  }

  if (lowerText.includes('change') && lowerText.includes('price')) {
    const match = text.match(/change\s+(.+?)\s+price\s+to\s*[₦N]?\s*(\d+)/i);
    if (match) {
      const productName = match[1].trim();
      const newPrice = parseInt(match[2]);
      const product = vendor.products.find(p => p.name.toLowerCase().includes(productName.toLowerCase()));
      if (product) {
        product.price = newPrice;
        await vendor.save();
        await sendMessage(vendorPhone, fromJid, `✅ Updated!\n\n*${product.name}* is now ₦${newPrice.toLocaleString()}`);
      } else {
        await sendMessage(vendorPhone, fromJid, `❌ Product "${productName}" not found.\n\nSay *"show my catalogue"* to see your products.`);
      }
    } else {
      await sendMessage(vendorPhone, fromJid, 'Format: "Change [product name] price to [amount]"\n\nExample: "Change red ankara price to 6000"');
    }
    return;
  }

  if (lowerText.includes('add product') || lowerText.includes('new product')) {
    const match = text.match(/add\s+product\s+(.+?)\s*[₦N]\s*(\d+)/i);
    if (match) {
      vendor.products.push({
        name: match[1].trim(),
        price: parseInt(match[2])
      });
      await vendor.save();
      await sendMessage(vendorPhone, fromJid, `✅ Added: ${match[1].trim()} — ₦${parseInt(match[2]).toLocaleString()}`);
    } else {
      await sendMessage(vendorPhone, fromJid, 'Format: "Add product [name] ₦[price]"\n\nExample: "Add product Blue Lace ₦8000"');
    }
    return;
  }

  if (lowerText.includes('remove') || lowerText.includes('delete')) {
    const match = text.match(/(?:remove|delete)\s+(.+)/i);
    if (match) {
      const productName = match[1].trim();
      const idx = vendor.products.findIndex(p => p.name.toLowerCase().includes(productName.toLowerCase()));
      if (idx >= 0) {
        const removed = vendor.products.splice(idx, 1)[0];
        await vendor.save();
        await sendMessage(vendorPhone, fromJid, `🗑️ Removed: ${removed.name}`);
      } else {
        await sendMessage(vendorPhone, fromJid, `❌ Product "${productName}" not found.`);
      }
    }
    return;
  }

  if (lowerText.includes('pause')) {
    vendor.status = 'paused';
    await vendor.save();
    await sendMessage(vendorPhone, fromJid, '⏸️ *Store paused.*\n\nI won\'t take new orders until you say *"resume"*.');
    return;
  }

  if (lowerText.includes('group rules') || lowerText.includes('show rules')) {
    await sendMessage(vendorPhone, fromJid, `📋 *Group Rules*\n\n${vendor.group_rules || 'No rules set.'}\n\nReply *"edit rules"* to change.`);
    return;
  }

  if (lowerText.includes('edit rules')) {
    vendor.onboarding_step = 8;
    await vendor.save();
    await sendMessage(vendorPhone, fromJid, 'Send me your new group rules:');
    return;
  }

  if (lowerText.includes('help') || lowerText === 'commands' || lowerText === 'menu') {
    await sendMessage(vendorPhone, fromJid, 
      `📖 *NaijaSales AI Commands*\n\n` +
      `*Sales:*\n"How much sales today?"\n"Sales this week"\n\n` +
      `*Products:*\n"Show my catalogue"\n"Change [product] price to [amount]"\n"Add product [name] ₦[price]"\n"Remove [product]"\n\n` +
      `*Store:*\n"Pause my store"\n"Resume"\n"Show group rules"\n\n` +
      `*Need help?* Just ask me anything! 😊`
    );
    return;
  }

  await sendMessage(vendorPhone, fromJid, `👋 Hey *${vendor.business_name}*!\n\nWhat would you like to do?\n\nSay *"help"* for commands.`);
}

// ─── CUSTOMER MESSAGE HANDLER (PAYSTACK VIRTUAL ACCOUNT) ──────────
async function handleCustomerMessage(vendor, fromJid, text, lowerText, vendorPhone, customerPhone) {
  const cartKey = `${vendorPhone}:${customerPhone}`;
  
  // Product selection
  for (const product of vendor.products) {
    const productNameLower = product.name.toLowerCase();
    if (lowerText.includes(productNameLower) || 
        (lowerText.includes('price') && lowerText.includes(productNameLower.split(' ')[0]))) {
      
      await sendMessage(vendorPhone, fromJid, 
        `💰 *${product.name}*\n\n` +
        `Price: ₦${product.price.toLocaleString()}\n\n` +
        `How many do you want? Reply with a number (e.g., "2").`
      );
      
      activeCarts.set(cartKey, { 
        vendor, 
        customerPhone, 
        pendingProduct: product,
        items: [],
        step: 'quantity'
      });
      return;
    }
  }

  // Quantity input
  const qtyMatch = text.match(/^(\d+)$/);
  if (qtyMatch && activeCarts.has(cartKey)) {
    const cart = activeCarts.get(cartKey);
    if (cart.step === 'quantity' && cart.pendingProduct) {
      const qty = parseInt(qtyMatch[1]);
      const product = cart.pendingProduct;
      
      cart.items.push({
        name: product.name,
        qty: qty,
        price: product.price
      });
      cart.pendingProduct = null;
      cart.step = 'checkout_or_continue';
      
      const itemTotal = qty * product.price;
      let reply = `🛒 *Added to cart:*\n${qty}x ${product.name} = ₦${itemTotal.toLocaleString()}\n\n`;
      
      if (cart.items.length > 1) {
        const total = cart.items.reduce((s, i) => s + (i.qty * i.price), 0);
        reply += `*Cart total: ₦${total.toLocaleString()}*\n\n`;
      }
      
      reply += `Reply:\n• *"checkout"* to pay\n• *"more"* to add more items\n• Product name to add another`;
      
      await sendMessage(vendorPhone, fromJid, reply);
      return;
    }
  }

  // Checkout with virtual account
  if (lowerText === 'checkout' || lowerText === 'pay' || lowerText === 'done') {
    const cart = activeCarts.get(cartKey);
    if (!cart || cart.items.length === 0) {
      await sendMessage(vendorPhone, fromJid, 
        `🛒 Your cart is empty.\n\n` +
        `Say *"show products"* to see what we have.`
      );
      return;
    }
    
    const total = cart.items.reduce((s, i) => s + (i.qty * i.price), 0);
    
    // Create order
    const order = new Order({
      vendor_phone: vendor.phone,
      customer_phone: customerPhone,
      items: cart.items,
      total: total,
      status: 'pending'
    });
    await order.save();
    
    // Create Paystack virtual account
    const customerName = cart.customerName || `Customer ${customerPhone.slice(-4)}`;
    const vaResult = await createVirtualAccount(order, customerName);
    
    if (vaResult.success) {
      order.virtual_account = {
        account_name: vaResult.account_name,
        account_number: vaResult.account_number,
        bank_name: vaResult.bank_name,
        expires_at: new Date(Date.now() + 30 * 60 * 1000) // 30 min
      };
      order.status = 'awaiting_payment';
      await order.save();
      
      let itemsList = cart.items.map(i => `• ${i.qty}x ${i.name} = ₦${(i.qty * i.price).toLocaleString()}`).join('\n');
      
      await sendMessage(vendorPhone, fromJid, 
        `🛒 *Order Summary*\n\n` +
        `${itemsList}\n\n` +
        `*Total: ₦${total.toLocaleString()}*\n\n` +
        `*Pay via bank transfer:*\n` +
        `🏦 Bank: ${vaResult.bank_name}\n` +
        `👤 Name: ${vaResult.account_name}\n` +
        `🔢 Account: ${vaResult.account_number}\n\n` +
        `⏰ Transfer within 30 minutes.\n` +
        `You'll get a receipt automatically once payment is confirmed.`
      );
      
      // Notify vendor
      await sendMessage(vendorPhone, formatJid(vendor.phone), 
        `📦 *New Order!*\n\n` +
        `Customer: ${customerPhone}\n` +
        `${itemsList}\n\n` +
        `Total: ₦${total.toLocaleString()}\n` +
        `Status: Awaiting payment...\n` +
        `VA: ${vaResult.account_number}`
      );
      
      activeCarts.delete(cartKey);
    } else {
      await sendMessage(vendorPhone, fromJid, 
        `❌ Payment setup failed: ${vaResult.error}\n\n` +
        `Please try again or contact the vendor.`
      );
    }
    return;
  }

  // Continue shopping
  if (lowerText === 'more' || lowerText === 'continue') {
    await sendMessage(vendorPhone, fromJid, 
      `👍 Great! What else would you like?\n\n` +
      `Say *"show products"* to see the catalogue.`
    );
    return;
  }

  // Show products
  if (lowerText.includes('show products') || lowerText.includes('catalogue') || lowerText.includes('products')) {
    if (vendor.products.length === 0) {
      await sendMessage(vendorPhone, fromJid, '📭 No products available right now. Please check back later.');
      return;
    }
    let reply = `📦 *${vendor.business_name} — Catalogue*\n\n`;
    vendor.products.forEach((p, i) => {
      reply += `${i + 1}. ${p.name} — ₦${p.price.toLocaleString()}\n`;
    });
    reply += '\nReply with a product name to order.';
    await sendMessage(vendorPhone, fromJid, reply);
    return;
  }

  // Buy intent
  if (lowerText.includes('buy') || lowerText.includes('order') || lowerText.includes('want') || lowerText.includes('get')) {
    await sendMessage(vendorPhone, fromJid, 
      `🛒 Hi! Welcome to *${vendor.business_name}*.\n\n` +
      `What would you like to buy? Say *"show products"* to see our catalogue.`
    );
    return;
  }

  // FAQ matching
  for (const faq of vendor.faqs) {
    if (lowerText.includes(faq.q.toLowerCase().substring(0, 10))) {
      await sendMessage(vendorPhone, fromJid, `💬 *${faq.q}*\n\n${faq.a}`);
      return;
    }
  }

  await sendMessage(vendorPhone, fromJid, 
    `👋 Welcome to *${vendor.business_name}*!\n\n` +
    `How can I help you today?\n\n` +
    `Say *"show products"* to see what we have.`
  );
}

// ─── PAYSTACK WEBHOOK HANDLER ───────────────────────────────────────
app.post('/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const payload = req.body;
  
  // Verify signature using secret key
  const hash = crypto
    .createHmac('sha512', PAYSTACK_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  
  if (hash !== signature) {
    console.log('❌ Invalid webhook signature');
    return res.status(401).send('Unauthorized');
  }
  
  const event = JSON.parse(payload);
  console.log('📡 Paystack webhook:', event.event, event.data?.reference);
  
  res.status(200).send('OK');
  
  if (event.event === 'charge.success') {
    const { reference, amount, customer } = event.data;
    
    // Find order by virtual account or reference
    const order = await Order.findOne({ 
      $or: [
        { paystack_ref: reference },
        { 'virtual_account.account_number': customer?.account_number }
      ]
    });
    
    if (!order) {
      console.log('⚠️ Order not found for ref:', reference);
      return;
    }
    
    if (order.status === 'paid') {
      console.log('Order already paid:', order._id);
      return;
    }
    
    // Update order
    order.status = 'paid';
    order.paid_at = new Date();
    order.paystack_ref = reference;
    await order.save();
    
    const vendor = await Vendor.findOne({ phone: order.vendor_phone });
    
    // Commission (5%)
    const commissionRate = 0.05;
    const commission = Math.floor(order.total * commissionRate);
    const vendorAmount = order.total - commission;
    
    // Generate receipt
    const receiptId = `NS-${order._id.toString().slice(-8).toUpperCase()}`;
    const receiptText = 
      `🧾 *PAYMENT RECEIPT*\n\n` +
      `Receipt No: #${receiptId}\n` +
      `Date: ${new Date().toLocaleString('en-NG')}\n` +
      `Vendor: ${vendor?.business_name || 'NaijaSales'}\n\n` +
      `*Items:*\n` +
      order.items.map(i => `• ${i.qty}x ${i.name} @ ₦${i.price.toLocaleString()} = ₦${(i.qty * i.price).toLocaleString()}`).join('\n') +
      `\n\n*Total Paid: ₦${order.total.toLocaleString()}*\n` +
      `Payment Ref: ${reference}\n\n` +
      `Thank you for shopping with us! 🎉`;
    
    // Send receipt to customer
    await sendMessage(order.vendor_phone, formatJid(order.customer_phone), receiptText);
    
    // Notify vendor
    await sendMessage(order.vendor_phone, formatJid(order.vendor_phone), 
      `💰 *Payment Received!*\n\n` +
      `Order: #${receiptId}\n` +
      `Customer: ${order.customer_phone}\n` +
      `Amount: ₦${order.total.toLocaleString()}\n` +
      `Commission: ₦${commission.toLocaleString()}\n` +
      `You receive: ₦${vendorAmount.toLocaleString()}\n\n` +
      `Transfer initiated to your bank account.`
    );
    
    // Transfer to vendor
    const transferRef = `TRF_${order._id}_${Date.now()}`;
    const transferResult = await transferToVendor(
      vendor, 
      vendorAmount * 100, 
      transferRef,
      `Order #${receiptId} - ${vendor?.business_name}`
    );
    
    if (transferResult.status) {
      order.paystack_transfer_ref = transferRef;
      order.status = 'fulfilled';
      await order.save();
      console.log(`✅ Transfer initiated: ${transferRef}`);
    } else {
      console.log(`⚠️ Transfer failed: ${transferResult.message}`);
    }
    
    // Notify admin
    await sendMessage(ADMIN_PHONE, formatJid(ADMIN_PHONE), 
      `📊 *Commission Alert*\n\n` +
      `Order: #${receiptId}\n` +
      `Vendor: ${vendor?.business_name} (${order.vendor_phone})\n` +
      `Total: ₦${order.total.toLocaleString()}\n` +
      `Commission (5%): ₦${commission.toLocaleString()}`
    );
  }
  
  if (event.event === 'transfer.success') {
    const { reference, recipient, amount } = event.data;
    console.log(`✅ Transfer success: ${reference} → ${recipient.account_number}`);
  }
  
  if (event.event === 'transfer.failed') {
    const { reference, reason } = event.data;
    console.log(`❌ Transfer failed: ${reference} — ${reason}`);
  }
});

// Fallback callback
app.get('/paystack/callback', async (req, res) => {
  const { reference, trxref } = req.query;
  const ref = reference || trxref;
  
  if (!ref) {
    return res.status(400).send('Missing reference');
  }
  
  const verification = await verifyTransaction(ref);
  
  if (verification.status && verification.data.status === 'success') {
    const order = await Order.findOne({ paystack_ref: ref });
    if (order && order.status !== 'paid') {
      order.status = 'paid';
      order.paid_at = new Date();
      await order.save();
      // Trigger receipt (same logic as webhook)
    }
    res.send('✅ Payment successful! Check your WhatsApp for receipt.');
  } else {
    res.send('❌ Payment failed or pending. Please try again.');
  }
});

// ─── EXPRESS ROUTES ─────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const activeSessions = Array.from(sessions.entries())
    .filter(([_, s]) => s.connected)
    .map(([phone, s]) => ({ phone, isAdmin: s.isAdmin }));
  
  const vendorCount = await Vendor.countDocuments();
  const activeVendors = await Vendor.countDocuments({ status: 'active' });
  const todaySales = await Order.aggregate([
    { $match: { status: 'paid', paid_at: { $gte: new Date(new Date().setHours(0,0,0,0)) } } },
    { $group: { _id: null, total: { $sum: '$total' } } }
  ]);
  
  res.json({
    db: dbReady,
    adminConnected: sessions.get(ADMIN_PHONE)?.connected || false,
    activeSessions: activeSessions.length,
    sessions: activeSessions,
    vendors: { total: vendorCount, active: activeVendors },
    todaySales: todaySales[0]?.total || 0,
    uptime: process.uptime()
  });
});

app.get('/vendors', async (req, res) => {
  const vendors = await Vendor.find().select('-__v').sort({ created_at: -1 });
  res.json(vendors);
});

app.get('/orders', async (req, res) => {
  const { vendor_phone, status } = req.query;
  const filter = {};
  if (vendor_phone) filter.vendor_phone = cleanPhone(vendor_phone);
  if (status) filter.status = status;
  const orders = await Order.find(filter).sort({ created_at: -1 });
  res.json(orders);
});

// ─── STARTUP ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 NaijaSales AI running on port ${PORT}`);
  console.log(`📱 Admin number: ${ADMIN_PHONE}`);
  console.log(`🔗 Webhook URL: ${WEBHOOK_BASE}/webhook/paystack`);
  
  console.log('🔌 Starting admin session...');
const adminResult = await createSession(ADMIN_PHONE, true);

if (adminResult.alreadyConnected) {
  console.log('✅ Admin session already connected');
} else if (adminResult.success) {
  // Wait up to 60 seconds for connection
  let attempts = 0;
  const maxAttempts = 12;
  
  const checkConnection = setInterval(() => {
    const session = sessions.get(ADMIN_PHONE);
    attempts++;
    
    if (session?.connected) {
      clearInterval(checkConnection);
      console.log('✅ Admin session connected');
    } else if (attempts >= maxAttempts) {
      clearInterval(checkConnection);
      console.log('⚠️ Admin session pairing pending — enter code on your phone');
    }
  }, 5000);
  
  // Give immediate feedback
  console.log(`📱 Admin pairing code: ${adminResult.code}`);
  console.log('👉 Enter this code in WhatsApp → Settings → Linked Devices → Link with Phone Number');
} else {
  console.error('❌ Admin session failed:', adminResult.error);
}
  
  console.log('🔄 Restoring vendor sessions...');
  const activeVendors = await Vendor.find({ status: 'active', auth_connected: true });
  for (const vendor of activeVendors) {
    console.log(`🔄 Restoring ${vendor.phone}...`);
    await createSession(vendor.phone, false);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('✅ Startup complete');
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  for (const [phone, session] of sessions) {
    try { session.socket?.end(); } catch(e) {}
  }
  await mongoose.connection.close();
  process.exit(0);
});
