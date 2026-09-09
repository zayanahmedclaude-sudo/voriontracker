const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
function harness() {
  const sockets = [];
  const source = fs.readFileSync(path.join(__dirname, '../agent/src/service-ipc.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const net = { createConnection() {
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.write = text => { socket.request = JSON.parse(text); };
    socket.destroy = () => { socket.destroyed = true; };
    socket.reply = () => socket.emit('data', JSON.stringify({ id: socket.request.id, ok: true }) + '\n');
    sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
  } };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => name === 'net' ? net : require(name), module, module.exports);
  return { ...module.exports, sockets, settle: () => new Promise(resolve => setImmediate(resolve)) };
}
test('IPC uses one connection and prioritizes heartbeat over waiting screenshot work', async () => {
  const h = harness();
  const first = h.sendServiceCommand({ command: 'queue-list', pid: 1 });
  const second = h.sendServiceCommand({ command: 'queue-delete', pid: 1, localId: 'one' });
  const heartbeat = h.sendServiceCommand({ command: 'agent-heartbeat', pid: 1 });
  await h.settle(); assert.equal(h.sockets.length, 1);
  h.sockets[0].reply(); await first; await h.settle();
  assert.equal(h.sockets[0].destroyed, true);
  assert.equal(h.sockets[1].request.payload.command, 'agent-heartbeat');
  h.sockets[1].reply(); await heartbeat; await h.settle();
  assert.equal(h.sockets[2].request.payload.command, 'queue-delete');
  h.sockets[2].reply(); await second;
});
test('IPC timeout destroys connection and releases queued requests', async () => {
  const h = harness();
  const stalled = h.sendServiceCommand({ command: 'ping' }, 15);
  const rejection = assert.rejects(stalled, /timed out/);
  const next = h.sendServiceCommand({ command: 'ping' });
  await rejection; await h.settle();
  assert.equal(h.sockets[0].destroyed, true);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].reply(); await next;
  h.sockets[0].emit('error', new Error('late disconnect'));
});
