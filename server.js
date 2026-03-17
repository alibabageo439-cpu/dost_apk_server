const WebSocket = require('ws');
const https = require('https');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const RESEND_KEY = process.env.RESEND_KEY || '';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'antitheftapp-7dc5e';

const admins = new Set();
const devices = new Map();

console.log('DOST Server v2.0 running on port', PORT);
console.log('Telegram:', TELEGRAM_BOT_TOKEN ? 'YES' : 'NO');
console.log('Resend:', RESEND_KEY ? 'YES' : 'NO');

// FCM V1 Access Token
let fcmAccessToken = null;
let fcmTokenExpiry = 0;

async function getFCMAccessToken() {
  try {
    if (fcmAccessToken && Date.now() < fcmTokenExpiry) return fcmAccessToken;
    const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountStr) { console.log('No Firebase service account'); return null; }
    const sa = JSON.parse(serviceAccountStr);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600
    })).toString('base64url');
    const crypto = require('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(header + '.' + payload);
    const signature = sign.sign(sa.private_key, 'base64url');
    const jwt = header + '.' + payload + '.' + signature;
    const token = await exchangeJWT(jwt);
    fcmAccessToken = token;
    fcmTokenExpiry = Date.now() + 3500000;
    return token;
  } catch (e) { console.error('FCM token error:', e.message); return null; }
}

function exchangeJWT(jwt) {
  return new Promise((resolve, reject) => {
    const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).access_token); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function sendFCM(token, command) {
  if (!token) return;
  try {
    const accessToken = await getFCMAccessToken();
    if (!accessToken) return;
    const body = JSON.stringify({
      message: { token, data: { command }, android: { priority: 'HIGH' } }
    });
    const req = https.request({
      hostname: 'fcm.googleapis.com',
      path: `/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) console.log('FCM V1 sent:', command);
        else console.error('FCM error:', res.statusCode, d.substring(0, 200));
      });
    });
    req.on('error', e => console.error('FCM error:', e.message));
    req.write(body); req.end();
  } catch (e) { console.error('FCM send error:', e.message); }
}

wss.on('connection', (ws) => {
  let clientId = null;
  let clientRole = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'register') {
      if (msg.role === 'admin') {
        clientRole = 'admin';
        admins.add(ws);
        devices.forEach((info, id) => {
          safeSend(ws, { type: 'device-connected', deviceId: id, name: info.name, email: info.email, phone: info.phone });
        });
        console.log('Admin connected');
      } else if (msg.role === 'device') {
        clientRole = 'device';
        clientId = msg.deviceId || ('device_' + Date.now());
        devices.set(clientId, {
          ws, name: msg.name || clientId,
          email: msg.email || '', phone: msg.phone || '',
          telegram: msg.telegram || '', fcmToken: msg.fcmToken || '',
          autoMode: false
        });
        broadcastToAdmins({ type: 'device-connected', deviceId: clientId, name: msg.name || clientId, email: msg.email || '', phone: msg.phone || '' });
        console.log('Device connected:', msg.name || clientId);
      }
    }

    if (clientRole === 'device' && clientId) {
      const dev = devices.get(clientId);
      const allowed = ['photo-front', 'photo-back', 'location', 'alert', 'audio', 'video', 'status', 'info'];
      if (allowed.includes(msg.type)) {
        broadcastToAdmins({ ...msg, deviceId: clientId });
        if (dev && dev.autoMode) {
          const time = new Date().toLocaleString();
          if (msg.type === 'location') {
            const link = 'https://maps.google.com/?q=' + msg.lat + ',' + msg.lng;
            if (dev.telegram) sendTelegram(dev.telegram, '📍 DOST Alert!\nDevice: ' + dev.name + '\nLocation: ' + link + '\nTime: ' + time);
            if (dev.email) sendEmail(dev.email, dev.name, '<h2>📍 DOST Location</h2><p><b>Device:</b> ' + dev.name + '</p><p><b>Time:</b> ' + time + '</p><p><a href="' + link + '">' + link + '</a></p>');
          }
          if (msg.type === 'photo-front') {
            if (dev.telegram) sendTelegramPhoto(dev.telegram, msg.value, '📷 Front Camera\n' + dev.name + '\n' + time);
            if (dev.email) sendEmailPhoto(dev.email, dev.name, msg.value, 'Front Camera', time);
          }
          if (msg.type === 'photo-back') {
            if (dev.telegram) sendTelegramPhoto(dev.telegram, msg.value, '📷 Back Camera\n' + dev.name + '\n' + time);
            if (dev.email) sendEmailPhoto(dev.email, dev.name, msg.value, 'Back Camera', time);
          }
          if (msg.type === 'audio') {
            if (dev.telegram) sendTelegram(dev.telegram, '🎤 Audio Recorded\nDevice: ' + dev.name + '\nTime: ' + time);
          }
          if (msg.type === 'video') {
            if (dev.telegram) sendTelegram(dev.telegram, '🎥 Video Recorded\nDevice: ' + dev.name + '\nTime: ' + time);
          }
        }
      }
    }

    if (clientRole === 'admin') {
      if (msg.type === 'command' && msg.target) {
        const dev = devices.get(msg.target);
        if (dev) {
          if (msg.value === 'auto-start') dev.autoMode = true;
          if (msg.value === 'auto-stop') dev.autoMode = false;
          if (dev.ws && dev.ws.readyState === WebSocket.OPEN) {
            safeSend(dev.ws, { type: 'command', value: msg.value });
            console.log('Command via WS:', msg.value, '->', dev.name);
          } else if (dev.fcmToken) {
            sendFCM(dev.fcmToken, msg.value);
            console.log('Command via FCM:', msg.value, '->', dev.name);
          }
        }
      }
    }
  });

  ws.on('close', () => {
    if (clientRole === 'admin') { admins.delete(ws); }
    else if (clientRole === 'device' && clientId) {
      const dev = devices.get(clientId);
      if (dev) dev.ws = null;
      broadcastToAdmins({ type: 'device-disconnected', deviceId: clientId });
      setTimeout(() => { const d = devices.get(clientId); if (d && !d.ws) devices.delete(clientId); }, 30000);
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
  catch (e) { console.error('Send error:', e.message); }
}

function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text: text });
  const req = https.request({
    hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => console.log('Telegram sent:', res.statusCode));
  req.on('error', e => console.error('Telegram error:', e.message));
  req.write(body); req.end();
}

function sendTelegramPhoto(chatId, base64Data, caption) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(b64, 'base64');
    const boundary = 'boundary' + Date.now();
    const parts = [];
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId + '\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + (caption || '').substring(0, 200) + '\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'));
    parts.push(imageBuffer);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    const req = https.request({
      hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode === 200) console.log('Photo sent'); else console.error('Photo failed:', res.statusCode); });
    });
    req.on('error', e => console.error('Photo error:', e.message));
    req.write(body); req.end();
  } catch (e) { console.error('Photo exception:', e.message); }
}

function sendEmail(to, deviceName, htmlBody) {
  if (!RESEND_KEY || !to) return;
  const data = JSON.stringify({ from: 'DOST Alert <onboarding@resend.dev>', to: [to], subject: 'DOST Alert — ' + deviceName, html: htmlBody });
  const req = https.request({
    hostname: 'api.resend.com', path: '/emails', method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if ([200, 201, 202].includes(res.statusCode)) console.log('Email sent to:', to); else console.error('Email error:', res.statusCode); }); });
  req.on('error', e => console.error('Email error:', e.message));
  req.write(data); req.end();
}

function sendEmailPhoto(to, deviceName, base64Data, cameraType, time) {
  if (!RESEND_KEY || !to) return;
  const html = '<h2>DOST ' + cameraType + '</h2><p><b>Device:</b> ' + deviceName + '</p><p><b>Time:</b> ' + time + '</p><img src="' + base64Data + '" style="max-width:100%;border-radius:8px"/>';
  const data = JSON.stringify({ from: 'DOST Alert <onboarding@resend.dev>', to: [to], subject: 'DOST ' + cameraType + ' — ' + deviceName, html });
  const req = https.request({
    hostname: 'api.resend.com', path: '/emails', method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if ([200, 201, 202].includes(res.statusCode)) console.log('Photo email sent'); else console.error('Photo email error:', res.statusCode); }); });
  req.on('error', e => console.error('Photo email error:', e.message));
  req.write(data); req.end();
}
