// TernMeOn bridge: holds the Buttplug spec v4 WebSocket client (Tern plugins can only do HTTP)
// and serves a small token-guarded HTTP API on 127.0.0.1.
// Usage: node bridge.mjs [--data DIR] [--idle-ms N]   (DIR defaults to $TERN_PLUGIN_DATA)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const die = (code, msg) => { fs.writeSync(2, msg + '\n'); process.exit(code); };
if (typeof WebSocket !== 'function') die(3, `TernMeOn bridge needs Node 22 or newer (this is ${process.version})`);
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg('data') ?? process.env.TERN_PLUGIN_DATA;
if (!dir) die(2, 'TernMeOn bridge: pass --data DIR or set TERN_PLUGIN_DATA');
const idleMs = Number(arg('idle-ms')) || 20000;
const token = crypto.randomBytes(24).toString('hex');
const infoFile = path.join(dir, 'bridge.json');

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const need = (ok, message) => { if (!ok) throw new Fail(400, message); };
const inRange = (x, lo, hi) => typeof x === 'number' && x >= lo && x <= hi;
const noop = () => {};

// ---- Buttplug client state ----
let want = null, status = 'disconnected', serverName = null, error = null;
let ws = null, retries = 0, retryTimer, pinger, nextId = 1, scanning = false;
let devices = [];           // [{index, name, features: [{index, description, outputs: [{type, min, max, value}]}]}]
let pattern = null;         // {timer, saved: Map<"dev/feat", value>} while a pattern plays
const pending = new Map();  // message Id -> {resolve, reject, timer}
const wire = [];           // last 40 Buttplug frames, oldest first: {dir, t, msg}
const t0 = Date.now();
const pingIds = new Set(); // Ids of client Pings; their Ok replies stay out of the wire log
function record(dir, msg) { wire.push({ dir, t: Date.now() - t0, msg: JSON.stringify(msg) }); if (wire.length > 40) wire.shift(); }

// Send a message and resolve with the server's reply (Error replies, timeouts and socket loss reject).
const call = (type, body) => new Promise((resolve, reject) => {
  if (ws?.readyState !== 1) return reject(new Fail(409, 'not connected'));
  const Id = nextId;
  nextId = (nextId % 0xFFFFFFFF) + 1;
  const msg = { [type]: { Id, ...body } };
  if (type === 'Ping') pingIds.add(Id); else record('out', msg);
  ws.send(JSON.stringify([msg]));
  const timer = setTimeout(() => { pending.delete(Id); pingIds.delete(Id); reject(new Fail(502, `${type} timed out`)); }, 3000);
  pending.set(Id, { resolve, reject, timer });
});

// Forget the current socket's session.
function drop() {
  clearInterval(pinger);
  clearTimeout(retryTimer);
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Fail(502, 'connection lost')); }
  pending.clear();
  pingIds.clear();
  endPattern(false);
  ws = null; devices = []; scanning = false; serverName = null;
}

// Replace the device list; keep tracked values only for devices whose index AND name still match.
function setDevices({ Devices = {} }) {
  const old = devices;
  // Integer-keyed objects iterate in ascending key order, so devices/features come out sorted by index.
  devices = Object.values(Devices).map((d) => {
    const prev = old.find((p) => p.index === d.DeviceIndex && p.name === d.DeviceName);
    const features = Object.values(d.DeviceFeatures ?? {}).filter((f) => f.Output).map((f) => ({
      index: f.FeatureIndex,
      description: f.FeatureDescription,
      outputs: Object.entries(f.Output).map(([type, { Value: [min, max] }]) => ({
        type, min, max,
        value: prev?.features.find((p) => p.index === f.FeatureIndex)?.outputs.find((o) => o.type === type)?.value ?? 0,
      })),
    }));
    return { index: d.DeviceIndex, name: d.DeviceName, features };
  });
}

function open() {
  const sock = (ws = new WebSocket(want));
  sock.onerror = (e) => { if (sock === ws) error = e.message || 'connection failed'; };
  sock.onclose = () => {
    if (sock !== ws) return;
    error ??= status === 'connected' ? 'connection lost' : 'server closed the connection before the handshake finished';
    drop();
    status = 'reconnecting';
    retryTimer = setTimeout(open, Math.min(1000 * 2 ** retries++, 10000));
  };
  sock.onmessage = ({ data }) => {
    if (sock !== ws || typeof data !== 'string') return;
    try {
      for (const msg of JSON.parse(data)) {
        const [kind, body] = Object.entries(msg)[0];
  const wasPing = pingIds.delete(body.Id);
  if (kind !== 'Ping' && !(kind === 'Ok' && wasPing)) record('in', msg);
        if (kind === 'DeviceList') setDevices(body);
        else if (kind === 'ScanningFinished') scanning = false;
        const p = pending.get(body.Id);
        if (!p) continue;
        pending.delete(body.Id);
        clearTimeout(p.timer);
        if (kind === 'Error') p.reject(new Fail(502, body.ErrorMessage));
        else p.resolve(body);
      }
    } catch (e) { error = `bad message from server: ${e.message}`; }
  };
  sock.onopen = async () => {
    if (sock !== ws) return;
    try {
      const info = await call('RequestServerInfo', { ClientName: 'TernMeOn', ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 });
      need(info.ProtocolVersionMajor === 4, `server speaks protocol v${info.ProtocolVersionMajor}, TernMeOn needs v4`);
      if (info.MaxPingTime > 0) pinger = setInterval(() => call('Ping').catch(noop), info.MaxPingTime / 2);
      await call('RequestDeviceList');
      status = 'connected'; error = null; retries = 0; serverName = info.ServerName || null;
    } catch (e) {
      if (sock === ws) { error = e.message; sock.close(); }  // onclose schedules the retry
    }
  };
}

function connect(url) {
  if (url === want && status !== 'reconnecting') return;
  if (url !== want) wire.length = 0;
  const old = ws;
  drop();
  old?.close();
  want = url; status = 'connecting'; error = null; retries = 0;
  open();
}

// ---- outputs and patterns ----
const slots = () => devices.flatMap((d) => d.features.flatMap((f) => f.outputs.map((out) => ({ dev: d.index, feat: f.index, out }))));
const vibes = () => slots().filter((s) => s.out.type === 'Vibrate');
const key = (s) => `${s.dev}/${s.feat}`;

// Command one output and track the commanded value (reverted if the server refuses it).
function put({ dev, feat, out }, value) {
  const prev = out.value;
  out.value = value;
  const params = { Value: value, ...(out.type === 'HwPositionWithDuration' && { Duration: 500 }) };
  return call('OutputCmd', { DeviceIndex: dev, FeatureIndex: feat, Command: { [out.type]: params } })
    .catch((e) => { if (out.value === value) out.value = prev; throw e; });
}

function endPattern(restore) {
  if (!pattern) return;
  const { timer, saved } = pattern;
  clearTimeout(timer);
  pattern = null;
  if (restore) for (const s of vibes()) put(s, saved.get(key(s)) ?? 0).catch(noop);
}

function playPattern(steps) {
  endPattern(true);  // restore first so `saved` is the real baseline, not a mid-pattern value
  const p = pattern = { timer: null, saved: new Map(vibes().map((s) => [key(s), s.out.value])) };
  let i = 0;
  const tick = () => {
    if (i === steps.length) return endPattern(true);
    p.step = i;
    const [fraction, ms] = steps[i++];
    for (const s of vibes()) put(s, Math.round(fraction * s.out.max)).catch(noop);
    p.timer = setTimeout(tick, ms);
  };
  tick();
}

const needConnected = () => { if (status !== 'connected') throw new Fail(409, 'not connected'); };

function state() {
  const outs = slots().map((s) => s.out);
  const level = outs.map((o) => Math.abs(o.value) / (Math.max(Math.abs(o.min), Math.abs(o.max)) || 1));
  return {
    server: { url: want, status, name: serverName, error },
    scanning, pattern: pattern !== null, step: pattern?.step ?? null,
    wire,
    active: outs.some((o) => o.value !== 0),
    level: Math.max(0, ...level),
    devices,
  };
}

// ---- HTTP API ----
const routes = {
  'GET /state': () => {},
  'POST /connect': ({ url = 'ws://127.0.0.1:12345' }) => {
    need(typeof url === 'string' && /^wss?:\/\//i.test(url) && URL.canParse(url), 'url must be a ws:// or wss:// URL');
    connect(url);
  },
  'POST /scan': async ({ on }) => {
    need(typeof on === 'boolean', 'on must be a boolean');
    needConnected();
    await call(on ? 'StartScanning' : 'StopScanning');
    scanning = on;
  },
  'POST /output': async ({ device, feature, type, value }) => {
    need(Number.isInteger(device) && Number.isInteger(feature) && typeof type === 'string' && Number.isFinite(value),
      'device, feature (integers), type (string) and value (number) are required');
    needConnected();
    const out = devices.find((d) => d.index === device)?.features.find((f) => f.index === feature)?.outputs.find((o) => o.type === type);
    if (!out) throw new Fail(404, `device ${device} feature ${feature} has no ${type} output`);
    endPattern(true);
    await put({ dev: device, feat: feature, out }, Math.min(out.max, Math.max(out.min, Math.round(value))));
  },
  'POST /stop': async ({ device }) => {
    need(device === undefined || Number.isInteger(device), 'device must be an integer');
    endPattern(false);
    if (status === 'connected') await call('StopCmd', device === undefined ? {} : { DeviceIndex: device });
    for (const s of slots()) if (device === undefined || s.dev === device) s.out.value = 0;
  },
  'POST /pattern': ({ steps }) => {
    need(Array.isArray(steps) && steps.length >= 1 && steps.length <= 256
      && steps.every((s) => Array.isArray(s) && inRange(s[0], 0, 1) && inRange(s[1], 10, 10000)),
      'steps must be 1-256 entries of [fraction 0..1, ms 10..10000]');
    needConnected();
    playPattern(steps);
  },
  'POST /shutdown': (_, res) => { res.once('finish', shutdown); },
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) if ((size += c.length) <= 65536) chunks.push(c);  // keep draining past the limit
  if (size > 65536) throw new Fail(413, 'body too large (64 KiB max)');
  try {
    const body = size ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* falls through to the 400 below */ }
  throw new Fail(400, 'body must be a JSON object');
}

const tokenOk = (h) => typeof h === 'string' && h.length === token.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(token));

const server = http.createServer(async (req, res) => {
  const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  // Unauthenticated replies carry no state: a DNS-rebinding page could otherwise read device names.
  if ('origin' in req.headers) return reply(403, { ok: false, error: 'requests with an Origin header are refused' });
  if (!tokenOk(req.headers['x-ternmeon-token'])) return reply(401, { ok: false, error: 'missing or invalid token' });
  kick();
  try {
    const route = routes[`${req.method} ${new URL(req.url, 'http://localhost').pathname}`];
    if (!route) throw new Fail(404, 'unknown route');
    await route(await readJson(req), res);
    reply(200, { ok: true, state: state() });
  } catch (e) {
    reply(e instanceof Fail ? e.code : 500, { ok: false, error: e.message, state: state() });
  }
});

// ---- lifecycle ----
let watchdog;
const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(shutdown, idleMs); };

let closing;
function shutdown() {
  closing ??= (async () => {
    if (status === 'connected') await call('StopCmd').catch(noop);  // stop every device before the socket goes away
    process.exit(0);
  })();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
process.on('exit', () => {
  try { if (JSON.parse(fs.readFileSync(infoFile, 'utf8')).pid === process.pid) fs.unlinkSync(infoFile); } catch { /* already gone */ }
});

server.listen(0, '127.0.0.1', () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${infoFile}.tmp`, JSON.stringify({ port: server.address().port, token, pid: process.pid, version: '1.0.0' }));
  fs.renameSync(`${infoFile}.tmp`, infoFile);
  kick();
});
