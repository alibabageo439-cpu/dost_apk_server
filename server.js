const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const https = require('https');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_PASS = process.env.GMAIL_PASS || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const admins = new Set();
const devices = new Map();

console.log('DOST Server running on port', PORT);

// Email transporter
let transporter = null;
if (GMAIL_USER && GMAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
}

wss.on('connection', (ws) => {
  let clientId = null;
  let clientRole = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'register') {
      if (msg.role === 'admin') {
        clientRole = 'admin';
        admins.add(ws);
        devices.forEach((info, id) => {
          safeSend(ws, {
            type: 'device-connected',
            deviceId: id,
            name: info.name,
            email: info.email,
            phone: info.phone
          });
        });
        console.log('Admin connected');

      } else if (msg.role === 'device') {
        clientRole = 'device';
        clientId = msg.deviceId || ('device_' + Date.now());
        devices.set(clientId, {
          ws,
          name: msg.name || clientId,
          email: msg.email || '',
          phone: msg.phone || '',
          telegram: msg.telegram || '',
          autoMode: false
        });
        broadcastToAdmins({
          type: 'device-connected',
          deviceId: clientId,
          name: msg.name || clientId,
          email: msg.email || '',
          phone: msg.phone || ''
        });
        console.log('Device connected:', msg.name || clientId);
      }
    }

    // Device → Admin
    if (clientRole === 'device' && clientId) {
      const dev = devices.get(clientId);
      if (['photo-front','photo-back','location','alert','audio-data','status'].includes(msg.type)) {
        broadcastToAdmins({ ...msg, deviceId: clientId });

        // Auto send email + telegram when auto mode on
        if (dev && dev.autoMode) {
          if (msg.type === 'location') {
            const lat = msg.lat;
            const lng = msg.lng;
            const mapsLink = `https://maps.google.com/?q=${lat},${lng}`;
            const time = new Date().toLocaleString();

            // Send to device owner email
            if (dev.email) {
              sendEmail(dev.email, dev.name, `
                <h2>DOST Location Update</h2>
                <p><b>Device:</b> ${dev.name}</p>
                <p><b>Time:</b> ${time}</p>
                <p><b>Location:</b> <a href="${mapsLink}">${mapsLink}</a></p>
              `);
            }

            // Send to device owner telegram
            if (dev.telegram) {
              sendTelegram(dev.telegram,
                `DOST Alert!\nDevice: ${dev.name}\nLocation: ${mapsLink}\nTime: ${time}`
              );
            }
          }
        }
      }
    }

    // Admin → Device
    if (clientRole === 'admin') {
      if (msg.type === 'command' && msg.target) {
        const dev = devices.get(msg.target);
        if (dev && dev.ws && dev.ws.readyState === WebSocket.OPEN) {
          if (msg.value === 'auto-start') dev.autoMode = true;
          if (msg.value === 'auto-stop') dev.autoMode = false;
          safeSend(dev.ws, { type: 'command', value: msg.value });
        }
      }
    }
  });

  ws.on('close', () => {
    if (clientRole === 'admin') {
      admins.delete(ws);
    } else if (clientRole === 'device' && clientId) {
      const dev = devices.get(clientId);
      if (dev) dev.ws = null;
      broadcastToAdmins({ type: 'device-disconnected', deviceId: clientId });
      // Keep in map for 30s for reconnect
      setTimeout(() => {
        const d = devices.get(clientId);
        if (d && !d.ws) devices.delete(clientId);
      }, 30000);
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

function broadcastToAdmins(data) {
  const str = JSON.stringify(data);
  admins.forEach(a => { if (a.readyState === WebSocket.OPEN) a.send(str); });
}

function safeSend(ws, data) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
  catch(e) { console.error('Send error:', e.message); }
}

function sendEmail(to, deviceName, htmlBody) {
  if (!transporter) {
    console.log('Email skip - transporter not ready');
    return;
  }
  if (!to) {
    console.log('Email skip - no recipient');
    return;
  }
  transporter.sendMail({
    from: GMAIL_USER,
    to: to,
    subject: 'DOST Alert — ' + deviceName,
    html: htmlBody
  }, (err, info) => {
    if (err) console.error('Email send error:', err.message);
    else console.log('Email sent OK to:', to, info.messageId);
  });
}

function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const body = JSON.stringify({ chat_id: chatId, text: text });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
  }, (res) => console.log('Telegram sent, status:', res.statusCode));
  req.on('error', (e) => console.error('Telegram error:', e.message));
  req.write(body);
  req.end();
}
