const WebSocket = require('ws');
const https = require('https');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const GMAIL_USER = process.env.GMAIL_USER || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const RESEND_KEY = process.env.RESEND_KEY || '';

const admins = new Set();
const devices = new Map();

console.log('DOST Server running on port', PORT);
console.log('Telegram:', TELEGRAM_BOT_TOKEN ? 'YES' : 'NO');
console.log('Resend:', RESEND_KEY ? 'YES' : 'NO');

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

        if (dev && dev.autoMode) {
          const time = new Date().toLocaleString();

          if (msg.type === 'location') {
            const mapsLink = 'https://maps.google.com/?q=' + msg.lat + ',' + msg.lng;
            const text = 'DOST Alert!\nDevice: ' + dev.name + '\nLocation: ' + mapsLink + '\nTime: ' + time;
            if (dev.telegram) sendTelegram(dev.telegram, text);
            if (dev.email) sendEmail(dev.email, dev.name,
              '<h2>DOST Location</h2><p>Device: ' + dev.name + '</p><p>Time: ' + time + '</p><p><a href="' + mapsLink + '">' + mapsLink + '</a></p>');
          }

          if (msg.type === 'photo-front' && dev.telegram) {
            sendTelegramPhoto(dev.telegram, msg.value, 'DOST Front Camera\n' + dev.name + '\n' + time);
          }
          if (msg.type === 'photo-back' && dev.telegram) {
            sendTelegramPhoto(dev.telegram, msg.value, 'DOST Back Camera\n' + dev.name + '\n' + time);
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

function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text: text });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, (res) => console.log('Telegram text sent, status:', res.statusCode));
  req.on('error', e => console.error('Telegram error:', e.message));
  req.write(body);
  req.end();
}

function sendTelegramPhoto(chatId, base64Data, caption) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(b64, 'base64');
    const boundary = 'boundary' + Date.now();

    const parts = [];
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId + '\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + (caption||'').substring(0,200) + '\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'));
    parts.push(imageBuffer);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) console.log('Telegram photo sent to:', chatId);
        else console.error('Telegram photo failed:', res.statusCode, d.substring(0,100));
      });
    });
    req.on('error', e => console.error('Telegram photo error:', e.message));
    req.write(body);
    req.end();
  } catch(e) {
    console.error('Telegram photo exception:', e.message);
  }
}

function sendEmail(to, deviceName, htmlBody) {
  if (!RESEND_KEY || !to) {
    console.log('Email skip - no Resend key or recipient');
    return;
  }
  const data = JSON.stringify({
    from: 'DOST Alert <onboarding@resend.dev>',
    to: [to],
    subject: 'DOST Alert — ' + deviceName,
    html: htmlBody
  });
  const req = https.request({
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      if (res.statusCode === 200 || res.statusCode === 201) console.log('Email sent to:', to);
      else console.error('Email error:', res.statusCode, d.substring(0,100));
    });
  });
  req.on('error', e => console.error('Email error:', e.message));
  req.write(data);
  req.end();
}
