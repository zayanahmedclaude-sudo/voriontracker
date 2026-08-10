require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

// Managed hosts (Railway, Render, Fly, etc.) provide PORT. Keep the explicit
// local override for development while making the public relay deployable.
const PORT = process.env.PORT || process.env.SOCKET_SERVER_PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const SOCKET_SERVER_SECRET = process.env.SOCKET_SERVER_SECRET || JWT_SECRET || '';
const allowedOrigins = (process.env.SOCKET_CLIENT_ORIGIN || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const allowedServerEvents = new Set([
  'employee-status',
  'employee-work-started',
  'employee-break-started',
  'employee-break-ended',
  'employee-checked-out',
  'employee-activity-updated',
  'employee-logged-out',
  'heartbeat',
  'new-alert',
  'new-screenshot',
  'screenshot-deleted',
  'security-event',
  'policy-updated',
]);

function normalizeRole(role) {
  return String(role || 'unknown').toLowerCase();
}

function isAdminRole(role) {
  return ['super_admin', 'superadmin', 'admin', 'qa_manager', 'team_lead', 'qa_lead'].includes(normalizeRole(role));
}

function canRequestStreams(role) {
  return ['super_admin', 'superadmin', 'admin', 'qa_manager', 'team_lead', 'qa_lead'].includes(normalizeRole(role));
}

function verifySocketToken(token) {
  if (!token || !JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    console.warn('Socket auth failed:', error.message);
    return null;
  }
}

function getSocketToken(socket, payload) {
  const candidate = payload?.token
    || socket.handshake.auth?.token
    || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function cleanIdentifier(value) {
  return String(value || '').trim();
}

function timingSafeMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function allowCorsOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (allowedOrigins.length > 0) {
    return callback(null, allowedOrigins.includes(origin));
  }
  const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  return callback(null, isLocalOrigin);
}

function rejectSocket(socket, reason) {
  socket.emit('error', { message: reason });
  socket.disconnect(true);
}

function requireRegistered(socket) {
  return Boolean(socket.data?.authenticated && socket.data?.userId && socket.data?.role);
}

function requireEmployeeSocket(socket) {
  return requireRegistered(socket) && socket.data.role === 'employee' && socket.data.employeeId;
}

function requireAdminSocket(socket) {
  return requireRegistered(socket) && canRequestStreams(socket.data.role);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/emit') {
    const providedSecret = req.headers['x-socket-secret'];
    if (!SOCKET_SERVER_SECRET || !timingSafeMatch(providedSecret, SOCKET_SERVER_SECRET)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { event, payload, toEmployeeId, toAdmins, toEmployees } = JSON.parse(body || '{}');
        if (event && allowedServerEvents.has(event)) {
          const targetEmployeeId = cleanIdentifier(toEmployeeId);
          // Alerts must never use the generic broadcast path. A missing
          // recipient is a delivery error, not an instruction to notify every
          // connected client.
          if (event === 'new-alert' && !targetEmployeeId) {
            throw new Error('new-alert requires a target employee');
          }
          if (targetEmployeeId) {
            io.to(`employee:${targetEmployeeId}`).emit(event, payload);
          }
          if (toAdmins) {
            io.to('admins').emit(event, payload);
          }
          if (toEmployees) {
            io.to('employees').emit(event, payload);
          }
          if (!targetEmployeeId && !toAdmins && !toEmployees) {
            io.emit(event, payload);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Socket.IO server is running');
});

const io = new Server(server, {
  cors: {
    origin: allowCorsOrigin,
    methods: ['GET', 'POST'],
  },
});

const employeeSocketMap = new Map();

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id, socket.handshake.query.role || 'unknown');

  socket.on('register', (payload = {}) => {
    const verified = verifySocketToken(getSocketToken(socket, payload));
    if (!verified) return rejectSocket(socket, 'Unauthorized');

    const role = normalizeRole(verified.role);
    const requestedEmployeeId = cleanIdentifier(payload.employeeId || socket.handshake.query.employeeId);
    const userId = cleanIdentifier(verified.sub);
    const employeeId = role === 'employee' ? userId : (requestedEmployeeId || userId);

    if (!userId) return rejectSocket(socket, 'Unauthorized');
    if (role === 'employee' && requestedEmployeeId && requestedEmployeeId !== userId) {
      return rejectSocket(socket, 'Forbidden');
    }

    socket.data.authenticated = true;
    socket.data.role = role;
    socket.data.userId = userId;
    socket.data.employeeId = employeeId || null;
    socket.data.teamId = verified.teamId || null;

    console.log('[socket-server] register received', {
      employeeId: socket.data.employeeId,
      role: socket.data.role,
      socketId: socket.id,
    });

    if (isAdminRole(socket.data.role)) {
      socket.join('admins');
    }

    if (socket.data.role === 'employee' && socket.data.employeeId) {
      const existingSocketId = employeeSocketMap.get(socket.data.employeeId);
      if (existingSocketId && existingSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existingSocketId);
        if (oldSocket) {
          console.log(`[dedupe] Disconnecting stale socket ${existingSocketId} for employeeId ${socket.data.employeeId}`);
          oldSocket.disconnect(true);
        }
      }
      employeeSocketMap.set(socket.data.employeeId, socket.id);
      socket.join(`employee:${socket.data.employeeId}`);
      socket.join('employees');
      console.log('[socket-server] Socket joined room:', `employee:${socket.data.employeeId}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', socket.id, reason);
    for (const [empId, sockId] of employeeSocketMap.entries()) {
      if (sockId === socket.id) employeeSocketMap.delete(empId);
    }
  });

  socket.on('employee-status', (payload) => {
    if (!requireEmployeeSocket(socket)) return;
    const targetEmployeeId = cleanIdentifier(payload?.employeeId || socket.data.employeeId);
    if (targetEmployeeId && targetEmployeeId === socket.data.employeeId) {
      io.to(`employee:${targetEmployeeId}`).emit('employee-status', payload);
    }
    io.to('admins').emit('employee-status', payload);
  });

  socket.on('heartbeat', (payload) => {
    if (!requireEmployeeSocket(socket)) return;
    io.to('admins').emit('heartbeat', payload);
  });

  socket.on('new-alert', (payload) => {
    if (!requireAdminSocket(socket)) return;
    const targetEmployeeId = cleanIdentifier(payload?.employee_id || payload?.employeeId);
    if (!targetEmployeeId) return;
    io.to(`employee:${targetEmployeeId}`).emit('new-alert', payload);
  });

  socket.on('security-event', (payload) => {
    if (!requireEmployeeSocket(socket)) return;
    io.to('admins').emit('security-event', payload);
  });

  socket.on('new-screenshot', (payload) => {
    if (!requireEmployeeSocket(socket)) return;
    const targetEmployeeId = cleanIdentifier(payload?.employeeId || payload?.userId || socket.data.employeeId);
    if (targetEmployeeId && targetEmployeeId === socket.data.employeeId) {
      io.to(`employee:${targetEmployeeId}`).emit('new-screenshot', payload);
    }
    io.to('admins').emit('new-screenshot', payload);
  });

  socket.on('stream-request', ({ employeeId, adminId }) => {
    if (!requireAdminSocket(socket) || !employeeId) return;
    console.log('[socket-server] stream-request received', {
      employeeId,
      adminId: socket.id,
      requester: socket.data.userId,
    });
    io.to(`employee:${employeeId}`).emit('stream-request', { employeeId, adminId: socket.id });
  });

  socket.on('stream-offer', ({ employeeId, adminId, sdp }) => {
    if (!requireEmployeeSocket(socket) || !employeeId || !adminId) return;
    if (cleanIdentifier(employeeId) !== socket.data.employeeId) return;
    io.to(adminId).emit('stream-offer', { employeeId, sdp });
  });

  socket.on('stream-answer', ({ employeeId, adminId, sdp }) => {
    if (!requireAdminSocket(socket) || !employeeId || !adminId) return;
    io.to(`employee:${employeeId}`).emit('stream-answer', { employeeId, adminId: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ employeeId, adminId, candidate, from }) => {
    if (from === 'admin' && requireAdminSocket(socket) && employeeId) {
      io.to(`employee:${employeeId}`).emit('ice-candidate', {
        employeeId,
        adminId: socket.id,
        candidate,
        from: 'admin',
      });
    } else if (from === 'agent' && requireEmployeeSocket(socket) && adminId) {
      io.to(adminId).emit('ice-candidate', {
        employeeId: socket.data.employeeId,
        candidate,
        from: 'agent',
      });
    }
  });

  socket.on('stop-stream', ({ employeeId, adminId }) => {
    if (!requireAdminSocket(socket) || !employeeId) return;
    io.to(`employee:${employeeId}`).emit('stop-stream', { employeeId, adminId: socket.id });
    if (adminId) {
      io.to(adminId).emit('stop-stream', { employeeId });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Socket.IO server listening on port ${PORT}`);
});
