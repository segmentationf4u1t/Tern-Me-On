// TernMeOn end-to-end test: real Intiface Engine + fake Lovense toy + the plugin in an isolated Tern.
// `node e2e/run.mjs [--engine PATH] [--smoke] [--keep] [--out DIR]`, `node e2e/run.mjs --verify DIR`. See e2e/README.md.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// =====================================================================================================================
// UI FLOWS: the only part that knows the plugin's UI. Steps run in order after the block is open and focused.
//   name     report label                      smoke    also part of `--smoke`
//   ctl      tern ctl commands, run once       expect   {tree, treeNot, fakeLog, noFakeLog, kv, fn}, polled until `timeout`
//   shot     screenshot name, taken after the expectations hold           sel   tree selector (default TREE_SEL)
// ctl: any `tern ctl` command line (`key 5`, `type hello`, `run "two words"`; quotes are literal, no shell layer),
// `@click SEL` (click the first match's centre: moves DOM focus there), `@tern ARGS` (the tern CLI on the isolated daemon,
// e.g. `@tern new tab -- pwsh`), `@wait MS`. expect.fn({ctl, tree, toyLines, bridge}) returns truthy (a string is evidence)
// or throws/returns false while not yet true. fakeLog regexes match `<kind> <text>` of device.log lines written since the
// step began, in order (`rx Vibrate:11;`, `tx Z:11:8A3D9FAC2A45;`). tree regexes match the text of the elements at `sel`.
// =====================================================================================================================
const TREE_SEL = '.sf-main';
// Written into the isolated config before Tern starts. `shell: pwsh`: Tern's shell integration (the source of the
// `command_finished` event the buzz feature listens to) does not load in Windows PowerShell 5, the Windows default.
const THEME = process.argv.includes('--theme') ? process.argv[process.argv.indexOf('--theme') + 1] : null;  // `--theme light`
const SETTINGS = { ...(process.platform === 'win32' ? { shell: 'pwsh' } : {}), ...(THEME ? { theme: THEME[0].toUpperCase() + THEME.slice(1).toLowerCase() } : {}) };
// kv written before Tern starts; `server_url` (the engine's port) is added by the harness.
const KV = { notify: true, notify_after_ms: 1000 };
const shellFocused = ({ ctl }) => { const f = ctl('state').focused; if (f?.prompt !== true) throw new Error(`focused pane is no shell at its prompt: ${JSON.stringify(f)}`); return `focused shell pane ${f.id} at its prompt`; };
const vib = (n) => new RegExp(`^rx Vibrate:${n};$`);
const upTo = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => vib(a + i));
const downTo = (a, b) => Array.from({ length: a - b + 1 }, (_, i) => vib(a - i));
const level = (n) => new RegExp(`(^|\\D)${n}/20`);  // the big numeral and its "/20"
const DOCK = '.tmo-dock';
const patternPlaying = async ({ bridge }) => (await bridge('GET', '/state')).json.state.pattern === true;
const FLOWS = [
  // ---- Devices ----
  { name: 'devices: connected, one output at 0/20', smoke: true, timeout: 20000,
    expect: { tree: [/connected\s*·\s*Buttplug Server/, level(0), /Lovense Hush\s*·\s*Vibrate/] }, shot: 'devices' },
  { name: 'wire: the handshake is listed (Tab, Tab)', smoke: true, ctl: ['key tab', 'key tab'],
    expect: { lines: [/RequestServerInfo → ServerInfo → RequestDeviceList → DeviceList → OutputCmd \/ StopCmd/,
      /→ \+\d+\.\ds\s+RequestServerInfo\s+#1\s+v4\.0/, /← \+\d+\.\ds\s+ServerInfo\s+#1\s+Buttplug Server · ping \d+/, /← \+\d+\.\ds\s+DeviceList\s+1 device\b/] } },
  { name: 'devices: back with Tab', ctl: ['key tab'], expect: { tree: [level(0), /Lovense Hush/] } },
  { name: 'devices: key 7 sets 16/20', ctl: ['key 7'], expect: { tree: level(16), fakeLog: [vib(16)] } },
  { name: 'devices: space switches off', ctl: ['key space'], expect: { tree: level(0), fakeLog: [vib(0)] } },
  { name: 'devices: space again restores 16/20', ctl: ['key space'], expect: { tree: level(16), fakeLog: [vib(16)] } },
  { name: 'devices: right steps to 17/20', ctl: ['key right'], expect: { tree: level(17), fakeLog: [vib(17)] } },
  { name: 'devices: x stops everything', ctl: ['key x'], expect: { tree: level(0), fakeLog: [vib(0)] } },
  { name: 'devices: s starts scanning', ctl: ['key s'], expect: { tree: /scanning/ } },
  { name: 'devices: s again stops scanning', ctl: ['key s'], expect: { treeNot: /scanning/, tree: /connected/ } },
  { name: 'open again: still exactly one TernMeOn block, focused', ctl: ['plugins run plugin.ternmeon.open'],
    expect: { fn: ({ ctl, blocks }) => { const b = blocks().filter((x) => x.program === 'ternmeon.control'); const f = ctl('state').focused;
      if (b.length !== 1 || f?.id !== b[0].id) throw new Error(`blocks ${JSON.stringify(b.map((x) => x.id))}, focused ${f?.id}`); return `one block, pane ${b[0].id}, focused`; } } },
  // ---- Studio ----
  { name: 'studio: Tab shows the slots and the scratch pattern', ctl: ['key tab'],
    expect: { tree: [/done\s*failed\s*scratch/, /42 steps · 2\.9 s/, /# a swell, three throbs, a fade/] }, shot: 'studio' },
  { name: 'studio: Enter starts editing, the dock shows the editing keys', ctl: ['key enter'],
    expect: { at: { [DOCK]: [/play/, /stop/, /slot/, /undo/] } } },
  { name: 'studio: ctrl+enter plays the scratch pattern (ramp, throbs, fade)', ctl: ['key ctrl+enter'], timeout: 12000,
    midShot: { name: 'studio-play', when: patternPlaying },
    expect: { fakeLog: [...upTo(1, 16), vib(20), vib(4), vib(20), vib(4), vib(20), vib(4), ...downTo(12, 0)] } },
  { name: 'studio: a line that does not parse shows its error', ctl: ['type 6'],
    expect: { tree: [/1 line\(s\) to fix/, /missing % after the number/] } },
  { name: 'studio: ctrl+enter on an error plays nothing', ctl: ['key ctrl+enter'],
    expect: { tree: /1 line\(s\) to fix/, noFakeLog: /^rx Vibrate:/ }, shot: 'studio-error' },
  { name: 'studio: ctrl+z restores the pattern', ctl: ['key ctrl+z'], expect: { tree: /42 steps · 2\.9 s/, treeNot: /to fix/ } },
  { name: 'studio: a non-numeric percent in ramp says what is expected', ctl: ['key down', 'key right', 'key right', 'key right', 'key right', 'key right', 'type x'],
    expect: { tree: /expected a percent like 60%/ } },
  { name: 'studio: ctrl+z restores the pattern again', ctl: ['key ctrl+z'], expect: { tree: /42 steps · 2\.9 s/, treeNot: /to fix/ } },
  { name: 'studio: ctrl+left selects the failed slot', ctl: ['key ctrl+left'], expect: { tree: [/100% 700ms/, /1 steps · 0\.7 s/] } },
  { name: 'studio: ctrl+enter plays failed: 20, then 0 about 0.7 s later', ctl: ['key ctrl+enter'], timeout: 8000,
    expect: { fakeLog: [vib(20), vib(0)], fn: ({ toyLines }) => { const l = toyLines(); const a = l.find((x) => x.line === 'rx Vibrate:20;'); const b = a && l.find((x) => x.t > a.t && x.line === 'rx Vibrate:0;');
      if (!b) throw new Error('no 20 then 0 yet'); const dt = b.t - a.t; if (dt < 600 || dt > 1000) throw new Error(`20 to 0 took ${dt} ms`); return `20 -> 0 after ${dt} ms`; } } },
  { name: 'studio: escape leaves editing and sends StopCmd', ctl: ['key escape'],
    expect: { at: { [DOCK]: /edit/ }, atNot: { [DOCK]: [/play/, /undo/] },
      fn: async ({ bridge }) => { const w = (await bridge('GET', '/state')).json.state.wire.slice(-3); if (!w.some((f) => f.dir === 'out' && f.msg.includes('StopCmd'))) throw new Error('no StopCmd in the last frames'); return 'last frames hold StopCmd'; } } },
  // ---- Wire ----
  { name: 'wire: Tab shows the legend and formatted frames', ctl: ['key tab'],
    expect: { lines: [/RequestServerInfo → ServerInfo → RequestDeviceList → DeviceList → OutputCmd \/ StopCmd/,
      /→ \+\d+\.\ds\s+OutputCmd\s+#\d+\s+dev 0 · feat 0 · Vibrate \d+/, /← \+\d+\.\ds\s+Ok\s+#\d+/, /→ \+\d+\.\ds\s+StopCmd\s+#\d+/] } },
  { name: 'wire: after key 5 and x on Devices, the OutputCmd value is the toy\'s and a StopCmd follows', ctl: ['key tab', 'key 5', 'key x', 'key tab', 'key tab'], timeout: 10000,
    expect: { fakeLog: [vib(11), vib(0)], lines: /Vibrate 11\n[\s\S]*StopCmd/,
      fn: ({ labels, toyLines }) => { const wire = [...labels().matchAll(/OutputCmd\s+#\d+\s+dev \d+ · feat \d+ · Vibrate (\d+)/g)].map((m) => +m[1]);
        const toy = toyLines().map((l) => l.line.match(/^rx Vibrate:(\d+);$/)?.[1]).filter(Boolean).map(Number).slice(0, -1);  // the last 0 answers the StopCmd
        if (!toy.length || JSON.stringify(wire.slice(-toy.length)) !== JSON.stringify(toy)) throw new Error(`wire ${JSON.stringify(wire)} vs toy ${JSON.stringify(toy)}`); return `wire OutputCmd values ${JSON.stringify(wire.slice(-toy.length))} = toy ${JSON.stringify(toy)}`; } },
    shot: 'wire' },
  // ---- Devices with a level, for the artifact ----
  { name: 'devices: a non-zero level (rings animating)', ctl: ['key tab', 'key 5', '@wait 600'], expect: { tree: level(11), fakeLog: [vib(11)] }, shot: 'devices-level' },
  { name: 'devices: x stops again', ctl: ['key x'], expect: { tree: level(0), fakeLog: [vib(0)] } },
  // ---- Buzz hook (plays the kv `patterns` slots) ----
  { name: 'focus the shell pane (pwsh, Tern shell integration on)', ctl: ['focus left'], expect: { fn: shellFocused } },
  { name: 'a command finishing after 3 s plays the done slot: 8, 0, 8, 0', ctl: ['run "Start-Sleep 3"'], timeout: 12000,
    expect: { fakeLog: [vib(8), vib(0), vib(8), vib(0)] }, shot: 'buzz' },
  { name: 'a command finishing under 1 s does not buzz', ctl: ['run "Get-Date"'],
    expect: { fn: ({ ctl }) => { const l = ctl('state').focused?.last; if (l?.line !== 'Get-Date') throw new Error(`last command is ${JSON.stringify(l)}`); return `Tern saw ${JSON.stringify(l)}`; }, noFakeLog: /^rx Vibrate:/ } },
  { name: 'a failing command plays the failed slot: 20, 0', ctl: ['run "Start-Sleep 2; cmd /c exit 3"'], timeout: 12000,
    expect: { fakeLog: [vib(20), vib(0)] } },
];

// ---- pinned engine release ----
const ENGINE_VERSION = '5.0.4';
const ENGINE_ASSETS = {
  'win32-x64': ['intiface-engine-v5.0.4-win-x64.zip', '29ea7051b23f7a05124e65581df48c8600070c83adc0348f0738b9ba75b58782'],
  'linux-x64': ['intiface-engine-v5.0.4-linux-x64.zip', 'ea2b40eca8369e01edcaa00076315bde0d7352108d38c226b77f1818395d2e66'],
  'linux-arm64': ['intiface-engine-v5.0.4-linux-arm64.zip', '01536003a3075ddb896552b70d2024f19992099b9ea1aef93459f9084aacb7e2'],
  'darwin-arm64': ['intiface-engine-v5.0.4-macos-arm64.zip', '430fbea694cbbde60e567c2f8e01c297db040259f02e541a5bf3d2abdbdf3d0d'],
};
// A user device config: lets the engine's websocket device manager accept a Lovense toy named LVSDevice.
const UDCF = {
  version: { major: 5, minor: 57 },
  user_configs: {
    protocols: { lovense: { communication: [{ websocket: { name: 'LVSDevice' } }], configurations: [] } },
    devices: [{
      identifier: { protocol: 'lovense', identifier: 'Z', address: '8A3D9FAC2A45' },
      config: {
        id: '5c26c653-0db2-4eed-a9fa-0a71cac1a63e', base_id: '37642e1c-a416-44d3-bada-76b6d9e245c9',
        features: [
          { id: '24bd4e1e-a02f-4528-ac1c-87e29871fcbe', base_id: '3f7a25a5-df21-42ca-bf9f-d1c52df1f37e', output: { vibrate: { disabled: false } } },
          { id: '1f04d2cf-3dc2-4b2f-a64d-bcc7e066b8ab', base_id: '14bd7637-13ed-49ba-9eb9-9c8ba9abec20' },
        ],
        user_config: { allow: false, deny: false, index: 0 },
      },
    }],
  },
};

// =====================================================================================================================
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CACHE = path.join(HERE, '.cache');
const IS_WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));
const clip = (s, n = 600) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);
const norm = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (p, dir) => { const a = norm(p), b = norm(dir); return a === b || a.startsWith(b + path.sep); };

if (opt('verify')) process.exit(verify(opt('verify')));
if (typeof WebSocket !== 'function') { console.error(`e2e needs Node 22+ (global WebSocket); this is ${process.version}`); process.exit(2); }

// ---- run state ----
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(opt('out') ?? path.join(HERE, 'out'), RUN_ID);
const RUN = path.join(CACHE, `run-${RUN_ID}`);
const CFG = path.join(RUN, 'cfg'), CWD = path.join(RUN, 'cwd'), STAGE = path.join(RUN, 'stage');
const DATA = path.join(CFG, 'plugin-data', 'ternmeon');
const PIPE = IS_WIN ? `\\\\.\\pipe\\tern-e2e-${RUN_ID}` : path.join(os.tmpdir(), `tern-e2e-${RUN_ID}.sock`);
const DEVICE_LOG = path.join(OUT, 'device.log');
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(RUN, 'logs'), { recursive: true });

const meta = { mode: flag('smoke') ? 'smoke' : 'full', theme: SETTINGS.theme ?? 'default', ports: {}, tern: null, engine: null, plugin: null, node: process.version, platform: `${process.platform}-${process.arch}`, isolation: { config: CFG, daemon: PIPE } };
const results = [];
const procs = [];            // {name, pid, proc?}: everything this run started
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

// ---- processes ----
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function listProcs() {
  const r = IS_WIN
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true })
    : spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return [];
  if (IS_WIN) { const j = JSON.parse(r.stdout || '[]'); return (Array.isArray(j) ? j : [j]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine ?? '' })); }
  return r.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
}
function killTree(pid) {
  if (!pid || pid === process.pid) return;
  if (IS_WIN) { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; }
  const all = listProcs();
  const walk = (p) => [...all.filter((x) => x.ppid === p).flatMap((x) => walk(x.pid)), p];
  for (const p of walk(pid)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
}
function savePids() {
  fs.writeFileSync(path.join(RUN, 'pids.json'), JSON.stringify({ harness: process.pid, runId: RUN_ID, procs: procs.map(({ name, pid }) => ({ name, pid })) }));
}
// Starts a child with stdout+stderr appended to `logFile`; `exited` resolves with its exit code.
function start(name, cmd, args, { env = process.env, cwd = RUN, logFile }) {
  const fd = fs.openSync(logFile, 'a');
  const proc = spawn(cmd, args, { env, cwd, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  const entry = { name, pid: proc.pid, proc, exited: new Promise((r) => proc.once('exit', (code, sig) => r(code ?? sig))) };
  proc.on('error', () => {});
  entry.proc.once('exit', () => { entry.dead = true; });
  procs.push(entry);
  savePids();
  return entry;
}

// Kills what a harness that died without cleaning up (kill -9, power loss) left behind: every process whose command line
// names a run whose harness is gone.
function sweepStale() {
  const stale = new Set();
  for (const dir of fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : []) {
    const m = dir.match(/^run-(.+)$/);
    if (!m || m[1] === RUN_ID) continue;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(CACHE, dir, 'pids.json'), 'utf8')).harness; } catch { /* no pids.json */ }
    const young = Date.now() - fs.statSync(path.join(CACHE, dir)).mtimeMs < 600000;  // a run that is only starting
    if (!(owner && alive(owner)) && !(owner === null && young)) stale.add(m[1]);
  }
  if (!stale.size) return 0;
  let killed = 0;
  for (const p of listProcs()) {
    if ([...stale].some((id) => p.cmd.includes(id))) { killTree(p.pid); killed++; }
  }
  for (const id of stale) fs.rmSync(path.join(CACHE, `run-${id}`), { recursive: true, force: true });
  return killed;
}
const mine = () => listProcs().filter((p) => p.pid !== process.pid && p.cmd.includes(RUN_ID));

// ---- ports, polling, http ----
function freePort(taken = []) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => (taken.includes(port) ? freePort(taken).then(resolve, reject) : resolve(port))); });
  });
}
const portOpen = (port) => new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
async function until(fn, ms, step = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}
function bridgeInfo() { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'bridge.json'), 'utf8')); } catch { return null; } }
function bridge(method, p, body) {
  const info = bridgeInfo();
  if (!info) return Promise.reject(new Error('no bridge.json'));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: info.port, method, path: p, timeout: 3000,
      headers: { 'x-ternmeon-token': info.token, 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch { reject(new Error(`bridge replied ${res.statusCode} ${clip(s, 100)}`)); } });
    });
    req.on('timeout', () => req.destroy(new Error('bridge timeout')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// ---- the toy's log ----
function toyLines() {
  let text = '';
  try { text = fs.readFileSync(DEVICE_LOG, 'utf8'); } catch { /* not created yet */ }
  return text.split('\n').filter(Boolean).map((l) => { const m = l.match(/^(\d+) \S+ (\w+) (.*)$/); return m ? { t: +m[1], line: `${m[2]} ${m[3]}` } : { t: 0, line: l }; });
}
// Ordered match: each regex must match a later line than the previous one. Returns the matched lines or null.
function sequence(lines, regexes) {
  const found = []; let at = 0;
  for (const re of regexes) {
    const i = lines.findIndex((l, k) => k >= at && re.test(l.line));
    if (i < 0) return null;
    found.push(lines[i].line); at = i + 1;
  }
  return found;
}

// ---- tern ----
let TERN = null, ternEnv = null;
function findTern() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, IS_WIN ? 'tern.exe' : 'tern');
    if (dir && fs.existsSync(file)) return file;
  }
  return null;
}
function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^TERN_/i.test(k) && !/^TERN_(AUTH|BUILD)_URL$/i.test(k)) delete env[k];
  return { ...env, TERN_CONFIG_DIR: CFG, TERN_DAEMON_SOCKET: PIPE, STENCIL_LOG_DIR: path.join(RUN, 'logs') };
}
// `tern ARGS` against the isolated daemon.
function tern(args, { timeout = 30000 } = {}) {
  const r = spawnSync(TERN, args, { env: ternEnv, cwd: CWD, encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}
let controlPort = 0;
// One `tern ctl` command line, passed as a single argument: ctl splits it itself and honours embedded quotes.
function ctl(line, { timeout = 30000 } = {}) {
  const r = tern(['ctl', '--control', String(controlPort), line], { timeout });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = { ok: false, error: clip(r.stdout || r.stderr || `exit ${r.status}`, 300) }; }
  return json;
}
const must = (reply, what) => { if (!reply.ok) throw new Error(`${what}: ${clip(reply.error ?? JSON.stringify(reply), 300)}`); return reply; };
function listBlocks() {
  const r = tern(['ls', '--json']);
  if (r.status !== 0) throw new Error(`tern ls failed: ${clip(r.stderr || r.stdout, 200)}`);
  return JSON.parse(r.stdout).sessions.flatMap((s) => s.tabs.flatMap((t) => t.blocks));
}
function treeText(sel) {
  const r = ctl(`tree ${sel}`);
  return r.ok ? (r.nodes ?? []).map((n) => n.text ?? '').join('\n') : `<tree error: ${r.error}>`;
}
// `tree` cuts an element's text at ~200 characters; the accessibility tree keeps every label whole (one per line of
// a code block). Returns the values of all labels, one per line.
function labels() {
  const r = ctl('a11y');
  const out = [];
  const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (typeof n.value === 'string') out.push(n.value); Object.values(n).forEach(walk); } };
  walk(r.ok ? r : {});
  return r.ok ? out.join('\n') : `<a11y error: ${r.error}>`;
}

// ---- steps ----
let nextShot = 0;
function flush() {
  const passed = results.length > 0 && results.every((r) => r.status === 'pass');
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.status]++;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ schema: 1, id: RUN_ID, passed, counts, ...meta, steps: results, files: hashes() }, null, 2));
  fs.writeFileSync(path.join(OUT, 'summary.md'), summary(passed, counts));
}
function hashes() {
  const out = {};
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else out[path.relative(OUT, p).replaceAll('\\', '/')] = sha256File(p); } };
  walk(OUT);
  delete out['report.json']; delete out['summary.md'];
  return out;
}
function summary(passed, counts) {
  const cell = (s) => clip(String(s ?? '').replace(/\s+/g, ' '), 160).replaceAll('|', '\\|');
  const lines = [`# TernMeOn e2e: ${passed ? 'PASS' : 'FAIL'}${meta.mode === 'smoke' ? ' (smoke subset only)' : ''}`, '',
    `Run \`${RUN_ID}\` on ${meta.platform}, Node ${meta.node}, ${meta.tern ?? 'tern ?'}, Intiface Engine ${meta.engine?.version ?? '?'}, plugin ${meta.plugin?.version ?? '?'} (snapshot ${meta.plugin?.snapshotSha256?.slice(0, 12) ?? '?'}).`,
    `${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped. Raw evidence: \`report.json\`, \`device.log\`, \`engine.log\`, \`tern-logs/\`.`, '',
    '| # | Phase | Step | Result | ms | Evidence |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of results) lines.push(`| ${r.n} | ${r.phase} | ${cell(r.name)} | ${r.status.toUpperCase()} | ${r.ms} | ${cell(r.error ? `${r.error} :: ${r.evidence}` : r.evidence)} |`);
  const shots = results.filter((r) => r.shots.length);
  if (shots.length) lines.push('', '## Screenshots');
  for (const r of shots) for (const s of r.shots) lines.push('', `### ${r.n}. ${r.name}`, '', `![${s}](${s})`);
  return `${lines.join('\n')}\n`;
}
async function step(name, phase, fn) {
  const r = { n: results.length + 1, name, phase, status: 'pass', ms: 0, evidence: '', error: null, shots: [] };
  results.push(r);
  const t = Date.now();
  try { r.evidence = clip(await fn(r)); } catch (e) {
    r.status = 'fail'; r.error = clip(e.message, 500); r.evidence = clip(e.evidence ?? '');
    if (phase === 'flow' && controlPort) { try { await shot(r, `fail-${name}`); } catch { /* the window is gone */ } }
  }
  r.ms = Date.now() - t;
  flush();
  say(`${r.status === 'pass' ? 'PASS' : 'FAIL'}  ${name} (${r.ms} ms)${r.error ? `\n          ${r.error}` : ''}`);
  return r.status === 'pass';
}
function skip(name, phase, why) {
  results.push({ n: results.length + 1, name, phase, status: 'skip', ms: 0, evidence: '', error: why, shots: [] });
  flush();
  say(`SKIP  ${name}: ${why}`);
}
// `shot NAME`: Tern writes the PNG and its layout JSON under the window's cwd; copy both into the artifact.
async function shot(r, name) {
  const base = `${String(++nextShot).padStart(2, '0')}-${slug(name)}`;
  const reply = must(ctl(`shot ${base}`), 'shot');
  for (const [src, ext] of [[reply.png, '.png'], [reply.layout, '.layout.json']]) {
    fs.copyFileSync(path.resolve(CWD, src), path.join(OUT, 'screenshots', base + ext));
  }
  r.shots.push(`screenshots/${base}.png`);
}

// ---- flow steps ----
async function runCtl(command) {
  if (command.startsWith('@wait ')) { await sleep(Number(command.slice(6))); return command; }
  if (command.startsWith('@tern ')) {  // the tern CLI against the isolated daemon: `@tern new tab -- pwsh -NoLogo`
    const r = tern(command.slice(6).trim().split(/\s+/));
    if (r.status !== 0) throw new Error(`${command}: exit ${r.status} ${clip(r.stderr || r.stdout, 200)}`);
    return command;
  }
  if (command.startsWith('@click ')) {
    const sel = command.slice(7).trim();
    const node = must(ctl(`tree ${sel}`), `tree ${sel}`).nodes?.[0];
    if (!node) throw new Error(`@click: nothing matches ${sel}`);
    const [x, y, w, h] = node.rect;
    must(ctl(`click ${Math.round(x + w / 2)} ${Math.round(y + h / 2)}`), 'click');
    return `${command} @${Math.round(x + w / 2)},${Math.round(y + h / 2)}`;
  }
  must(ctl(command), command);
  return command;
}
const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const around = (text, re) => { const m = text.match(re); if (!m) return ''; const i = m.index; return text.slice(Math.max(0, i - 40), i + m[0].length + 40).replace(/\s+/g, ' '); };
async function check(s, mark) {
  const exp = s.expect ?? {};
  const missing = [], evidence = [];
  if (exp.lines) {
    const text = labels();
    for (const re of arr(exp.lines)) { if (re.test(text)) evidence.push(`labels: …${around(text, re)}…`); else missing.push(`labels lack ${re}`); }
    if (missing.length) evidence.push(`labels: ${clip(text.replace(/\s+/g, ' '), 400)}`);
  }
  if (exp.tree || exp.treeNot) {
    const text = treeText(s.sel ?? TREE_SEL);
    for (const re of arr(exp.tree)) { if (re.test(text)) evidence.push(`tree: …${around(text, re)}…`); else missing.push(`tree lacks ${re}`); }
    for (const re of arr(exp.treeNot)) { if (re.test(text)) missing.push(`tree has ${re}`); }
    if (missing.length) evidence.push(`tree text: ${clip(text.replace(/\s+/g, ' '), 300)}`);
  }
  for (const [neg, map] of [[false, exp.at], [true, exp.atNot]]) {  // {selector: regex(es)} on other regions (the dock)
    for (const [sel, res] of Object.entries(map ?? {})) {
      const text = treeText(sel);
      for (const re of arr(res)) {
        if (re.test(text) !== neg) { if (!neg) evidence.push(`${sel}: …${around(text, re)}…`); } else { missing.push(`${sel} ${neg ? 'has' : 'lacks'} ${re}`); evidence.push(`${sel} text: ${clip(text.replace(/\s+/g, ' '), 200)}`); }
      }
    }
  }
  if (exp.fakeLog) {
    const lines = toyLines().slice(mark);
    const found = sequence(lines, arr(exp.fakeLog));
    if (found) evidence.push(`toy: ${found.join(' | ')}`);
    else missing.push(`toy log lacks ${arr(exp.fakeLog).join(' then ')} (got: ${clip(lines.map((l) => l.line).join(' | '), 200) || 'nothing'})`);
  }
  if (exp.kv) {
    let kv = {};
    try { kv = JSON.parse(fs.readFileSync(path.join(DATA, 'kv.json'), 'utf8')); } catch { /* none yet */ }
    for (const [k, v] of Object.entries(exp.kv)) { if (JSON.stringify(kv[k]) === JSON.stringify(v)) evidence.push(`kv ${k}=${JSON.stringify(v)}`); else missing.push(`kv ${k} is ${JSON.stringify(kv[k])}, want ${JSON.stringify(v)}`); }
  }
  if (exp.fn) {  // truthy (a string is evidence) = holds; false or a thrown Error (its message is the reason) = not yet
    try { const v = await exp.fn({ ctl, tree: treeText, labels, toyLines: () => toyLines().slice(mark), bridge, blocks: listBlocks }); if (v) evidence.push(String(v)); else missing.push('fn returned false'); } catch (e) { missing.push(`fn: ${e.message}`); }
  }
  return { ok: missing.length === 0, missing, evidence };
}
// A step starts only once the toy is quiet, so the tail of the previous step's effect (a pattern's restore) is not
// taken for this step's: no new toy line for 500 ms and no pattern running in the bridge (capped at 5 s).
async function settle() {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const quietFor = Date.now() - (toyLines().at(-1)?.t ?? 0);
    let playing = false;
    try { playing = (await bridge('GET', '/state')).json.state?.pattern === true; } catch { /* no bridge: nothing plays */ }
    if (quietFor >= 500 && !playing) return;
    await sleep(100);
  }
}
function flowStep(s) {
  return step(s.name, 'flow', async (r) => {
    await settle();
    const mark = toyLines().length;
    const done = [];
    for (const c of s.ctl ?? []) done.push(await runCtl(c));
    const end = Date.now() + (s.timeout ?? 8000);
    let res;
    let shotDone = !s.midShot;
    for (;;) {
      res = await check(s, mark);
      if (!shotDone) { try { if (await s.midShot.when({ ctl, bridge })) { await shot(r, s.midShot.name); shotDone = true; } } catch { /* not yet */ } }
      if ((res.ok && shotDone) || Date.now() > end) break;
      await sleep(200);
    }
    if (!shotDone && res.ok) throw Object.assign(new Error(`mid-step shot ${s.midShot.name}: its condition never held`), { evidence: done.join(' ; ') });
    const evidence = [...done, ...res.evidence].join(' ; ');
    const errors = pluginErrors();
    if (!res.ok) throw Object.assign(new Error(`expectation not met after ${s.timeout ?? 8000} ms: ${res.missing.join('; ')}${errors.length ? `; the plugin logged: ${errors.join(' || ')}` : ''}`), { evidence });
    if (s.expect?.noFakeLog) {
      await sleep(700);
      const bad = toyLines().slice(mark).filter((l) => s.expect.noFakeLog.test(l.line));
      if (bad.length) throw Object.assign(new Error(`toy log has ${s.expect.noFakeLog}: ${bad.map((l) => l.line).join(' | ')}`), { evidence });
    }
    if (s.shot) await shot(r, s.shot);
    return evidence;
  });
}

// ---- setup ----
async function locateEngine() {
  const given = opt('engine') ?? process.env.INTIFACE_ENGINE;
  let exe, source;
  if (given) {
    exe = path.resolve(given); source = opt('engine') ? '--engine' : '$INTIFACE_ENGINE';
    if (!fs.existsSync(exe)) throw new Error(`${source} ${exe} does not exist`);
  } else {
    const key = `${process.platform}-${process.arch}`, asset = ENGINE_ASSETS[key];
    if (!asset) throw new Error(`no Intiface Engine ${ENGINE_VERSION} release asset for ${key}; pass --engine PATH`);
    const [name, digest] = asset;
    const dir = path.join(CACHE, `intiface-engine-${ENGINE_VERSION}-${key}`);
    exe = path.join(dir, IS_WIN ? 'intiface-engine.exe' : 'intiface-engine'); source = 'cache';
    if (!fs.existsSync(exe)) {
      const zip = path.join(CACHE, name);
      if (!fs.existsSync(zip) || sha256File(zip) !== digest) {
        const url = `https://github.com/buttplugio/buttplug/releases/download/intiface-engine-${ENGINE_VERSION}/${name}`;
        say(`downloading ${url}`);
        fs.mkdirSync(CACHE, { recursive: true });
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
        if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${zip}.part`));
        if (sha256File(`${zip}.part`) !== digest) { fs.rmSync(`${zip}.part`); throw new Error(`download ${url}: SHA-256 mismatch (pinned ${digest})`); }
        fs.renameSync(`${zip}.part`, zip); source = 'downloaded';
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const tools = IS_WIN || process.platform === 'darwin' ? [['tar', ['-xf', zip, '-C', dir]], ['unzip', ['-o', '-q', zip, '-d', dir]]] : [['unzip', ['-o', '-q', zip, '-d', dir]], ['tar', ['-xf', zip, '-C', dir]]];
      if (!tools.some(([cmd, args]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0)) throw new Error(`could not extract ${zip} (need tar or unzip)`);
      if (!fs.existsSync(exe)) throw new Error(`${zip} holds no ${path.basename(exe)}`);
      if (!IS_WIN) fs.chmodSync(exe, 0o755);
    }
  }
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (v.status !== 0) throw new Error(`${exe} --version failed: ${clip(v.stderr || v.error?.message, 200)}`);
  meta.engine = { path: exe, source, version: v.stdout.match(/Version ([\w.+-]+)/)?.[1] ?? v.stdout.trim(), banner: v.stdout.trim(), sha256: sha256File(exe) };
  return `${meta.engine.banner} (${source}: ${exe})`;
}
let engine = null;
async function startEngine() {
  fs.writeFileSync(path.join(RUN, 'udcf.json'), JSON.stringify(UDCF));
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ws = await freePort(), dev = await freePort([ws]);
    meta.ports = { ...meta.ports, engineWs: ws, deviceWs: dev };
    engine = start('engine', meta.engine.path, ['--websocket-port', ws, '--use-device-websocket-server', '--device-websocket-server-port', dev,
      '--user-device-config-file', path.join(RUN, 'udcf.json'), '--max-ping-time', '2000'], { logFile: path.join(OUT, 'engine.log') });
    const up = await until(async () => (engine.dead ? 'dead' : (await portOpen(ws)) && (await portOpen(dev))), 15000, 100);
    if (up === true) return `pid ${engine.pid}, websocket ${ws}, device websocket ${dev}${attempt > 1 ? ` (attempt ${attempt})` : ''}`;
    last = up === 'dead' ? `engine exited with ${await engine.exited}` : 'engine did not open its ports in 15 s';
    killTree(engine.pid);
  }
  throw new Error(`${last}; see engine.log`);
}
async function startFake() {
  start('fake-lovense', process.execPath, [path.join(HERE, 'fake-lovense.mjs'), '--port', String(meta.ports.deviceWs), '--log', DEVICE_LOG], { logFile: path.join(OUT, 'fake.err') });
  const found = await until(() => toyLines().find((l) => /^tx Z:11:/.test(l.line)), 15000, 100);
  if (!found) throw new Error(`the engine never asked the toy for DeviceType (device.log: ${clip(toyLines().map((l) => l.line).join(' | '), 300) || 'empty'})`);
  return `engine accepted the toy: ${toyLines().map((l) => l.line).join(' | ')}`;
}
// The working tree minus dotfiles, e2e/, node_modules/ and target/ (cpSync refuses to copy a directory into itself).
function copyTree(src, dst, top = true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') || (top && ['e2e', 'node_modules', 'target'].includes(e.name))) continue;
    if (e.isDirectory()) copyTree(path.join(src, e.name), path.join(dst, e.name), false); else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
function snapshotPlugin() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  copyTree(REPO, STAGE);
  const hash = crypto.createHash('sha256'); const names = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { const rel = path.relative(STAGE, p).replaceAll('\\', '/'); names.push(rel); hash.update(`${rel}\0`).update(fs.readFileSync(p)); } } };
  walk(STAGE);
  const toml = fs.readFileSync(path.join(STAGE, 'plugin.toml'), 'utf8');
  const version = toml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  meta.plugin = { version, snapshotSha256: hash.digest('hex'), files: names };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'settings.json'), JSON.stringify(SETTINGS));
  fs.writeFileSync(path.join(DATA, 'kv.json'), JSON.stringify({ ...KV, server_url: `ws://127.0.0.1:${meta.ports.engineWs}` }));
  const r = tern(['plugin', 'install', STAGE]);
  if (r.status !== 0) throw new Error(`tern plugin install failed: ${clip(r.stderr || r.stdout, 300)}`);
  return `${names.length} files, sha256 ${meta.plugin.snapshotSha256.slice(0, 16)}; ${r.stdout.split('\n')[0]}; settings ${JSON.stringify(SETTINGS)}; kv ${fs.readFileSync(path.join(DATA, 'kv.json'), 'utf8')}`;
}
let window = null;
async function startWindow() {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    controlPort = await freePort(Object.values(meta.ports));
    meta.ports.control = controlPort;
    window = start('tern-window', TERN, ['--control', String(controlPort), '--dir', CWD], { env: ternEnv, cwd: CWD, logFile: path.join(RUN, 'logs', 'window.out') });
    const up = await until(async () => (window.dead ? 'dead' : ctl('state', { timeout: 5000 }).ok), 60000, 300);
    if (up === true) break;
    last = up === 'dead' ? `the window exited with ${await window.exited} before its control endpoint answered` : 'the control endpoint did not answer in 60 s';
    killTree(window.pid); controlPort = 0;
    if (attempt === 3) throw new Error(`${last}; see tern.log`);
  }
  const state = must(ctl('state'), 'state');
  if (state.gate?.applies && !state.gate.signed_in) throw new Error(`Tern's closed-beta gate is not signed in (gate: ${JSON.stringify(state.gate)}); sign in to Tern once`);
  const daemon = mine().find((p) => p.cmd.includes('daemon') && p.cmd.includes(PIPE));
  if (!daemon) throw new Error('the isolated daemon (a `tern daemon --socket` of this run) is not running');
  meta.isolation.daemonPid = daemon.pid;
  return `window pid ${window.pid} control ${controlPort}, daemon pid ${daemon.pid}, gate signed_in=${state.gate?.signed_in} (${state.gate?.handle}), viewport ${state.viewport?.join('x')}`;
}
function checkIsolation() {
  const dir = tern(['plugin', 'dir']).stdout;
  if (!inside(dir, path.join(CFG, 'plugins'))) throw new Error(`tern plugin dir is ${dir}, not this run's ${path.join(CFG, 'plugins')}`);
  const list = tern(['plugin', 'list']).stdout;
  const line = list.split('\n').find((l) => /^ternmeon /.test(l));
  if (!line) throw new Error(`the daemon does not list ternmeon: ${clip(list, 300)}`);
  if (!/\bready\b/.test(line)) throw new Error(`ternmeon is not ready: ${clip(list, 300)}`);
  const blocks = listBlocks();
  const foreign = blocks.filter((b) => !inside(b.cwd === '~' ? CWD : b.cwd, CWD));
  if (foreign.length) throw new Error(`the daemon lists panes this run did not create: ${JSON.stringify(foreign.map((b) => [b.id, b.program, b.cwd]))}`);
  return `plugin dir ${dir}; ${blocks.length} pane(s), all ours: ${blocks.map((b) => `${b.id}:${b.program}`).join(', ')}; ${line}`;
}
async function openBlock(r) {
  if (bridgeInfo()) throw new Error('bridge.json exists before the block was opened (stale file)');
  must(ctl('plugins run plugin.ternmeon.open'), 'plugins run plugin.ternmeon.open');
  const block = await until(() => listBlocks().find((b) => b.program === 'ternmeon.control'), 10000);
  if (!block) throw new Error('no ternmeon.control block appeared in `tern ls` within 10 s');
  const info = await until(bridgeInfo, 15000, 100);
  if (!info) throw new Error('the host never started the bridge (no bridge.json within 15 s)');
  if (!alive(info.pid)) throw new Error(`bridge.json names pid ${info.pid}, which is not running`);
  const state = await until(async () => { try { const s = await bridge('GET', '/state'); return s.status === 200 && s.json.ok ? s.json.state : null; } catch { return null; } }, 10000, 200);
  if (!state) throw new Error('the bridge does not answer GET /state with its token');
  const focused = await until(() => { const s = ctl('state'); return s.ok && s.focused?.id === block.id ? s.focused : null; }, 5000, 200);
  if (!focused) throw new Error(`the block (pane ${block.id}) is not the focused pane; keys would go elsewhere`);
  r.block = block.id;
  await shot(r, 'block-open');
  return `block pane ${block.id} focused; bridge pid ${info.pid} port ${info.port} (token ${info.token.slice(0, 4)}…, ${info.token.length} chars), server status ${state.server.status}`;
}

// Handler errors the plugin host logged (a Luau runtime error in a view or key handler shows nowhere else).
function pluginErrors() {
  const found = new Set();
  for (const file of fs.readdirSync(path.join(RUN, 'logs')).filter((f) => f.endsWith('.log'))) {
    for (const line of fs.readFileSync(path.join(RUN, 'logs', file), 'utf8').split('\n')) {
      if (!/\b(WARN|ERROR)\b/.test(line) || !/plugin[ =]"?ternmeon/.test(line)) continue;
      const m = line.match(/hook="([^"]*)" error="(.*)$/);
      found.add(m ? `${m[1]}: ${m[2].replace(/\\n.*$/, '').replace(/^runtime error: .*?plugins\\\\ternmeon\\\\/, '')}` : clip(line.replace(/^\S+\s+\d+\s+/, ''), 200));
    }
  }
  return [...found];
}
// ---- teardown ----
let closeMark = 0;
async function armToy() {
  if (!bridgeInfo()) throw new Error('no bridge.json: nothing to arm');
  const state = (await bridge('GET', '/state')).json.state;
  const slot = state.devices.flatMap((d) => d.features.flatMap((f) => f.outputs.filter((o) => o.type === 'Vibrate').map((o) => ({ device: d.index, feature: f.index, type: 'Vibrate', value: Math.min(3, o.max) }))))[0];
  if (!slot) throw new Error('the bridge lists no Vibrate output');
  const mark = toyLines().length;
  const res = await bridge('POST', '/output', slot);
  if (res.status !== 200) throw new Error(`POST /output -> ${res.status} ${JSON.stringify(res.json.error)}`);
  const got = await until(() => sequence(toyLines().slice(mark), [new RegExp(`^rx Vibrate:${slot.value};$`)]), 5000, 100);
  if (!got) throw new Error(`the toy never received Vibrate:${slot.value};`);
  return `bridge set ${JSON.stringify(slot)}; toy: ${got[0]}`;
}
async function closeBlock() {
  const blocks = listBlocks().filter((b) => b.program.startsWith('ternmeon.'));
  if (!blocks.length) throw new Error('no ternmeon block pane left to close');
  closeMark = toyLines().length;
  for (const b of blocks) { const r = tern(['close', String(b.id)]); if (r.status !== 0) throw new Error(`tern close ${b.id}: ${clip(r.stderr || r.stdout, 200)}`); }
  closeAt = Date.now();
  return `closed pane(s) ${blocks.map((b) => b.id).join(', ')}`;
}
let closeAt = 0;
async function bridgeGone(pid) {
  const gone = await until(() => !bridgeInfo() && !alive(pid), 30000, 250);
  if (!gone) throw new Error('the bridge is still running 30 s after its block closed (bridge.json present or process alive)');
  return `bridge.json removed and pid ${pid} exited ${((Date.now() - closeAt) / 1000).toFixed(1)} s after the close (limit 30 s)`;
}
async function toyStopped() {
  const got = await until(() => sequence(toyLines().slice(closeMark), [/^rx Vibrate:0;$/]), 30000, 200);
  if (!got) throw new Error(`the toy never received Vibrate:0; after the close (log since: ${clip(toyLines().slice(closeMark).map((l) => l.line).join(' | '), 200) || 'nothing'})`);
  return got[0];
}
async function quitWindow() {
  const reply = ctl('quit', { timeout: 10000 });
  const code = await Promise.race([window.exited, sleep(10000).then(() => 'timeout')]);
  if (code === 'timeout') { killTree(window.pid); throw new Error(`ctl quit ${JSON.stringify(reply)} but the window did not exit in 10 s (killed)`); }
  return `ctl quit ${JSON.stringify(reply)}; window exited ${code}`;
}
let cleanupPromise = null;
const cleanup = () => (cleanupPromise ??= doCleanup());
async function doCleanup() {
  if (bridgeInfo()) { try { await bridge('POST', '/shutdown', {}); } catch { /* already gone */ } }
  if (window && !window.dead && controlPort) { ctl('quit', { timeout: 5000 }); await Promise.race([window.exited, sleep(3000)]); }
  for (const p of [...procs].reverse()) if (!p.dead) killTree(p.pid);
  for (const p of mine()) killTree(p.pid);
}
async function noOrphans() {
  await sleep(500);
  await cleanup();
  await sleep(500);
  const left = mine();
  if (left.length) throw new Error(`processes of this run survived: ${left.map((p) => `${p.pid} ${clip(p.cmd, 80)}`).join('; ')}`);
  return 'no process with this run id in its command line is left (window, daemon, bridge, engine, fake all gone)';
}

// ---- main ----
// Gathers what only exists while the run dir does, writes the report, and removes the run dir (unless --keep).
function collect() {
  try { fs.copyFileSync(path.join(DATA, 'kv.json'), path.join(OUT, 'kv.json')); } catch { /* never written */ }
  try { fs.cpSync(path.join(RUN, 'logs'), path.join(OUT, 'tern-logs'), { recursive: true }); } catch { /* no logs */ }
  try { if (fs.statSync(path.join(OUT, 'fake.err')).size === 0) fs.rmSync(path.join(OUT, 'fake.err')); } catch { /* keep it */ }
  flush();
  if (!flag('keep')) { try { fs.rmSync(RUN, { recursive: true, force: true }); } catch { /* a handle still open: the next run's sweep removes it */ } }
}
async function finish(code) {
  try { await cleanup(); } catch { /* best effort */ }
  collect();
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { say(`${sig}: cleaning up`); results.push({ n: results.length + 1, name: `interrupted by ${sig}`, phase: 'setup', status: 'fail', ms: 0, evidence: '', error: sig, shots: [] }); flush(); finish(130); });
process.on('exit', () => { if (!cleanupPromise) { for (const p of procs) if (!p.dead) killTree(p.pid); for (const p of mine()) killTree(p.pid); } });

async function main() {
  say(`run ${RUN_ID}; artifact ${OUT}`);
  savePids();
  const swept = sweepStale();
  if (swept) say(`killed ${swept} process(es) left by a dead earlier run`);
  let ok = await step('preflight: node, tern, isolated environment', 'setup', async () => {
    TERN = findTern();
    if (!TERN) throw new Error('tern is not on PATH');
    ternEnv = scrubbedEnv();
    const v = tern(['--version']);
    if (v.status !== 0) throw new Error(`tern --version: ${clip(v.stderr || v.stdout, 200)}`);
    meta.tern = v.stdout;
    let shell = 'default shell';
    if (SETTINGS.shell) {
      const s = spawnSync(SETTINGS.shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      if (s.status !== 0) throw new Error(`the test config sets shell=${SETTINGS.shell}, which does not run (${clip(s.stderr || s.error?.message, 150)}); install PowerShell 7`);
      shell = `${SETTINGS.shell} ${s.stdout.trim()}`;
    }
    return `${TERN}: ${v.stdout}; node ${process.version}; shell ${shell}; isolated config ${CFG}; daemon ${PIPE}`;
  });
  const setup = (name, fn) => { if (!ok) { skip(name, 'setup', 'an earlier setup step failed'); return false; } return step(name, 'setup', fn).then((r) => { ok = r; return r; }); };
  await setup('engine: locate or download Intiface Engine', locateEngine);
  await setup('engine: start on free ports', startEngine);
  await setup('fake toy: connects and the engine accepts it', startFake);
  await setup('config: install a plugin snapshot, write settings and kv', snapshotPlugin);
  await setup('tern: isolated window up, signed in, daemon found', startWindow);
  await setup('tern: isolation holds (own config, daemon, panes)', checkIsolation);
  let opened = false;
  if (ok) opened = await step('plugin: open the block; bridge starts, answers, block focused', 'setup', openBlock);
  const flows = flag('smoke') ? FLOWS.filter((s) => s.smoke) : FLOWS;
  for (const s of flows) { if (opened) await flowStep(s); else skip(s.name, 'flow', 'the block did not open'); }
  if (opened) await step('plugin: the host logged no handler errors during the flows', 'flow', async () => { const e = pluginErrors(); if (e.length) throw new Error(e.join(' || ')); return 'no WARN/ERROR line about the plugin in the Tern logs'; });

  // Teardown always runs; its checks need the earlier setup (an unarmed toy or missing bridge makes them skip).
  const bridgePid = bridgeInfo()?.pid;
  const armed = bridgePid ? await step('teardown: leave the toy vibrating (bridge API)', 'teardown', armToy) : (skip('teardown: leave the toy vibrating (bridge API)', 'teardown', 'no bridge is running'), false);
  const closed = window && !window.dead ? await step('teardown: close the block pane', 'teardown', closeBlock) : (skip('teardown: close the block pane', 'teardown', 'no window'), false);
  if (closed && bridgePid) await step('teardown: bridge exits and bridge.json disappears within 30 s', 'teardown', () => bridgeGone(bridgePid));
  else skip('teardown: bridge exits and bridge.json disappears within 30 s', 'teardown', 'the block was not closed or no bridge ran');
  if (closed && armed) await step('teardown: the toy receives Vibrate:0;', 'teardown', toyStopped);
  else skip('teardown: the toy receives Vibrate:0;', 'teardown', 'the block was not closed or the toy was not armed');
  if (window && !window.dead) await step('teardown: quit the window', 'teardown', quitWindow);
  await step('teardown: kill daemon, engine, toy; nothing of this run survives', 'teardown', noOrphans);
}

let failure = null;
try { await main(); } catch (e) { failure = e; say(`harness error: ${e.stack ?? e}`); results.push({ n: results.length + 1, name: 'harness', phase: 'setup', status: 'fail', ms: 0, evidence: '', error: clip(e.stack ?? e.message, 800), shots: [] }); }
try { await cleanup(); } catch { /* best effort */ }
collect();
const passed = !failure && results.length > 0 && results.every((r) => r.status === 'pass');
say(`${passed ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.status === 'pass').length}/${results.length} steps passed; artifact ${OUT}`);
process.exit(passed ? 0 : 1);

// ---- --verify ----
function verify(dir) {
  const root = path.resolve(dir);
  const problems = [];
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8')); } catch (e) { console.error(`cannot read ${root}/report.json: ${e.message}`); return 2; }
  for (const [file, digest] of Object.entries(report.files ?? {})) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) problems.push(`missing ${file}`); else if (sha256File(p) !== digest) problems.push(`hash mismatch ${file}`);
  }
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const s of report.steps ?? []) counts[s.status]++;
  if (JSON.stringify(counts) !== JSON.stringify(report.counts)) problems.push(`counts ${JSON.stringify(report.counts)} disagree with the steps ${JSON.stringify(counts)}`);
  const allPass = (report.steps ?? []).length > 0 && counts.fail === 0 && counts.skip === 0;
  if (allPass !== report.passed) problems.push(`passed=${report.passed} disagrees with the steps`);
  for (const s of report.steps ?? []) for (const shotFile of s.shots ?? []) if (!fs.existsSync(path.join(root, shotFile))) problems.push(`step ${s.n} names missing screenshot ${shotFile}`);
  if (!fs.existsSync(path.join(root, 'summary.md'))) problems.push('missing summary.md');
  for (const p of problems) console.error(`VERIFY FAIL: ${p}`);
  console.log(`${problems.length ? 'INVALID' : 'INTACT'}: ${root}: ${report.steps?.length} steps, ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ${Object.keys(report.files ?? {}).length} files hashed`);
  return problems.length ? 1 : report.passed ? 0 : 1;
}
