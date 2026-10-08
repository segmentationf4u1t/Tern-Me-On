// Fake Lovense toy for the e2e: connects to Intiface Engine's device-websocket server and speaks the
// Lovense text protocol. Appends one line per event to the log:  <epoch ms> <ISO time> <kind> <text>
//   kind: open | close | tx (toy -> engine) | rx (engine -> toy, one line per `;`-terminated command)
// Usage: node fake-lovense.mjs --port DEVICE_WS_PORT --log FILE
import fs from 'node:fs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const port = arg('port'), logFile = arg('log');
if (!port || !logFile) { console.error('usage: fake-lovense.mjs --port PORT --log FILE'); process.exit(2); }

const ADDRESS = '8A3D9FAC2A45';
const log = (kind, text) => { const t = Date.now(); fs.appendFileSync(logFile, `${t} ${new Date(t).toISOString()} ${kind} ${text}\n`); };
const REPLIES = { DeviceType: `Z:11:${ADDRESS};`, Battery: '85;' };  // a Lovense Hush at 85 %

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = 'arraybuffer';
  let opened = false;
  ws.onopen = () => {
    opened = true;
    ws.send(JSON.stringify({ identifier: 'LVSDevice', address: ADDRESS, version: 0 }));
    log('open', `identified as LVSDevice ${ADDRESS}`);
  };
  ws.onmessage = ({ data }) => {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString();
    for (const cmd of text.split(';').filter(Boolean)) {
      log('rx', `${cmd};`);
      const reply = REPLIES[cmd];
      if (reply) { ws.send(Buffer.from(reply)); log('tx', reply); }
    }
  };
  ws.onclose = () => { if (opened) log('close', 'engine closed the connection; retrying in 500 ms'); setTimeout(connect, 500); };
  ws.onerror = () => {};  // onclose follows
}
connect();
