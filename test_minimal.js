const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

(async () => {
  const { state } = await useMultiFileAuthState('./test_auth_minimal');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Chrome (Linux)', '', ''],
    keepAliveIntervalMs: 30000
  });
  
  sock.ev.on('connection.update', (update) => {
    console.log('Update:', update.connection, 'QR:', !!update.qr);
  });
  
  // Wait and try pairing code after 10 seconds
  await new Promise(r => setTimeout(r, 10000));
  
  try {
    const code = await sock.requestPairingCode('2348148698365');
    console.log('CODE:', code);
  } catch(e) {
    console.log('PAIRING ERROR:', e.message);
  }
})();
