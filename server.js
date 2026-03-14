const WebSocket = require('ws');
const https = require('https');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Store connected clients
const admins = new Set();
const devices = new Map(); // deviceId -> { ws, name, email, phone, telegram }

console.log('DOST Server running on port', PORT);

wss.on('connection', (ws) => {
  let clientId = null;
  let clientRole = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // === REGISTER ===
    if (msg.type === 'register') {
      if (msg.role === 'admin') {
        clientRole = 'admin';
        admins.add(ws);
        // Send all currently connected devices to new admin
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
          ws: ws,
          name: msg.name || clientId,
          email: msg.email || '',
          phone: msg.phone || '',
          telegram: msg.telegram || ''
        });
        // Notify all admins
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

    // === DEVICE → ADMIN: photo, location, alert ===
    if (clientRole === 'device' && clientId) {
      if (msg.type === 'photo-front' || msg.type === 'photo-back' ||
          msg.type === 'location' || msg.type === 'alert' ||
          msg.type === 'status') {
        broadcastToAdmins({ ...msg, deviceId: clientId });
      }
    }

    // === ADMIN → DEVICE: commands ===
    if (clientRole === 'admin') {
      if (msg.type === 'command' && msg.target) {
        const dev = devices.get(msg.target);
        if (dev && dev.ws && dev.ws.readyState === WebSocket.OPEN) {
          safeSend(dev.ws, { type: 'command', value: msg.value });
        }
      }
    }
  });

  ws.on('close', () => {
    if (clientRole === 'admin') {
      admins.delete(ws);
      console.log('Admin disconnected');
    } else if (clientRole === 'device' && clientId) {
      devices.delete(clientId);
      broadcastToAdmins({ type: 'device-disconnected', deviceId: clientId });
      console.log('Device disconnected:', clientId);
    }
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
});

function broadcastToAdmins(data) {
  const str = JSON.stringify(data);
  admins.forEach((admin) => {
    if (admin.readyState === WebSocket.OPEN) {
      admin.send(str);
    }
  });
}

function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch (e) {
    console.error('Send error:', e.message);
  }
}
