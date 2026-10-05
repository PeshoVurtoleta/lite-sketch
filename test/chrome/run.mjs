// @zakkster/lite-sketch -- the headless-Chrome B/op gate (repo-only; `npm run chrome`,
// appended LAST to `verify`). Also `node test/chrome/run.mjs --lib <path>` (revert-check).
//
// Node measures scavenges (test/lanes.mjs, test/torture.mjs); this gate measures the
// other half -- actual per-op heap GROWTH in V8, read from a REAL browser via
// performance.memory.usedJSHeapSize with --enable-precise-memory-info. It launches a
// local Chrome headless, serves test/chrome/page.html + the module at /lib.js, and the
// page POSTs back each lane's 3 windows. The gate is the MIN of the VALID windows vs a
// per-group limit.
//
// Modes: df (default) and ni (--max-inlined-bytecode-size=0, V8's no-inline tier). nc
// (--allow-natives-syntax + %NeverOptimizeFunction) is NOT gated: the never-optimized
// interpreter caller boxes its own Float64Array read, so every lane -- addFrom included --
// reads ~12 B/op (the driver's box, not the library's); there is no library signal to gate.
//
// Per-mode box count k (the limit = 12*k + 0.5, so ONE extra 12 B library box per op trips
// it). k is the number of FRESH per-op non-Smi argument boxes the CORRECT library legitimately
// produces in that mode, declared by each lane's structural facts (page.html):
//   add/estimate (HLL/CMS/SS, inlines=true): df -> k=0 (the wrapper inlines and stages the key
//     in _buf, no per-op box); ni -> k = boxKey + boxCount (a non-Smi key / a v31 variable count
//     each box crossing the non-inlined call). A constant count (c1 Smi, c30 hoisted) does NOT box.
//   DD add (inlines=false): k = boxKey in BOTH modes -- a fractional value boxes even in df (DD
//     add's value box is exactly what DD addFrom removes). int -> k=0, frac -> k=1.
//   from (addFrom / addHashedFrom): limit 0.5 -- the sibling reads every arg unboxed.
//   into (topKInto / quantilesInto): limit 1 B/call.
//   ctrl: a floor, >= 8 B/op (one boxed HeapNumber per op).
//
// Finding Chrome: CHROME_BIN, else the macOS default
// (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome), else google-chrome /
// chromium on PATH. Launch flags: --headless=new --disable-gpu --no-first-run
// --no-default-browser-check, a per-run mkdtemp --user-data-dir (removed afterwards),
// --enable-precise-memory-info, and --js-flags=--expose-gc --min-semi-space-size=64
// --max-semi-space-size=64 [+ --max-inlined-bytecode-size=0 for ni].
//
// Fail closed, exit 1: Chrome absent / unlaunchable / a 120 s launch timeout / no gc /
// no precise-memory API / a mode-mismatched or malformed payload each print
// `GATE chrome: UNVERIFIED (<reason>)`. There is no skip env var. A missing method is
// ABSENT, which FAILs. A window that is NaN (JSON null) or negative (a GC fired inside it)
// is INVALID -- discarded; a lane with no valid window FAILs. A dropped
// --enable-precise-memory-info leaves performance.memory present but quantized -> 0 B/op
// -> the CTRL lane FAILs (< 8). ASCII-only; no deps.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, 'page.html');

const libArg = (() => { const k = process.argv.indexOf('--lib'); return k >= 0 ? process.argv[k + 1] : null; })();
const LIB = libArg ? path.resolve(libArg) : path.join(HERE, '..', '..', 'Sketch.js');
const LAUNCH_TIMEOUT_MS = 120000;
const MODES = [
  { tag: 'df', jsFlags: '' },
  { tag: 'ni', jsFlags: ' --max-inlined-bytecode-size=0' },
];

let server = null;
let profileDir = null;
function cleanup() {
  if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
  if (profileDir) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } profileDir = null; }
}
function unverified(reason) {
  cleanup();
  console.log('GATE chrome: UNVERIFIED (' + reason + ')');
  process.exit(1);
}

// ---- find Chrome: CHROME_BIN, macOS default, then PATH -----------------------
function findChrome() {
  if (process.env.CHROME_BIN) {
    return fs.existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;   // explicit + absent = fail closed
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  }
  return null;
}

if (!fs.existsSync(LIB)) unverified('lib not found: ' + LIB);
const CHROME = findChrome();
if (!CHROME) unverified(process.env.CHROME_BIN ? 'CHROME_BIN not found: ' + process.env.CHROME_BIN : 'no Chrome (set CHROME_BIN, or install Google Chrome / chromium)');

const libSrc = fs.readFileSync(LIB, 'utf8');
const pageSrc = fs.readFileSync(PAGE);

// ---- server: /page.html, /lib.js, POST /result -------------------------------
let resolveResult = null;
server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.end('ok'); if (resolveResult) { const r = resolveResult; resolveResult = null; r(body); } });
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/lib.js') { res.setHeader('content-type', 'text/javascript'); res.end(libSrc); return; }
  if (url.pathname === '/' || url.pathname === '/page.html') { res.setHeader('content-type', 'text/html'); res.end(pageSrc); return; }
  res.statusCode = 404; res.end('not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-sketch-chrome-'));

// Launch one Chrome for a mode and resolve with the page's POST body (or reject on
// timeout / early exit / spawn error -- every one of which is fail-closed UNVERIFIED).
function runMode(mode) {
  return new Promise((resolve, reject) => {
    const flags = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profileDir + '/' + mode.tag,
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc --min-semi-space-size=64 --max-semi-space-size=64' + mode.jsFlags,
      'http://127.0.0.1:' + PORT + '/page.html?mode=' + mode.tag,
    ];
    let done = false;
    const child = spawn(CHROME, flags, { stdio: 'ignore' });
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* ignore */ } fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error('timeout after ' + (LAUNCH_TIMEOUT_MS / 1000) + ' s (' + mode.tag + ')')), LAUNCH_TIMEOUT_MS);
    timer.unref();
    child.on('error', (e) => finish(reject, new Error('unlaunchable: ' + e.message)));
    child.on('exit', (code) => { if (!done) finish(reject, new Error('Chrome exited (' + code + ') before posting (' + mode.tag + ')')); });
    resolveResult = (body) => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { finish(reject, new Error('bad result JSON (' + mode.tag + '): ' + e.message)); return; }
      finish(resolve, parsed);
    };
  });
}

// ---- gate: per-group limit on the MIN of the VALID windows -------------------
function kFor(lane, mode) {
  if (lane.inlines && mode === 'df') return 0;
  return (lane.boxKey ? 1 : 0) + (lane.boxCount ? 1 : 0);
}
function limitForAdd(lane, mode) { return 12 * kFor(lane, mode) + 0.5; }

const lines = [];
let pass = 0, fail = 0, absent = 0;
const ctrlVal = {};

try {
  for (const mode of MODES) {
    let payload;
    try { payload = await runMode(mode); }
    catch (e) { unverified(e.message); }
    if (payload.error) unverified(payload.error + ' (' + mode.tag + ')');
    if (payload.mode !== mode.tag) unverified('mode mismatch: asked ' + mode.tag + ', page reported ' + payload.mode);
    const laneList = payload.lanes;
    if (!Array.isArray(laneList) || laneList.length !== 49) unverified('expected 49 lanes in ' + mode.tag + ', got ' + (Array.isArray(laneList) ? laneList.length : 'none'));

    for (const lane of laneList) {
      if (lane.absent) {
        absent++; fail++;
        lines.push(mode.tag + ' ' + lane.name + ' (' + lane.group + ') ABSENT(' + lane.absent + ') -> FAIL');
        continue;
      }
      // Validate windows: finite and >= 0. A NaN (JSON null) or negative (GC inside the
      // window) value is discarded; a lane with no valid window FAILs closed.
      const raw = Array.isArray(lane.windows) ? lane.windows : [];
      const valid = raw.filter((w) => typeof w === 'number' && isFinite(w) && w >= 0);
      const rawStr = '[' + raw.map((w) => (typeof w === 'number' && isFinite(w)) ? w.toFixed(2) : String(w)).join(',') + ']';
      const k = lane.group === 'add' ? kFor(lane, mode.tag) : 0;
      const label = mode.tag + ' ' + lane.name + ' (' + lane.group + ',k=' + k + ')';
      if (valid.length === 0) {
        fail++;
        lines.push(label + ' INVALID ' + rawStr + ' -> FAIL');
        continue;
      }
      const min = Math.min(...valid);
      if (lane.group === 'ctrl') {
        ctrlVal[mode.tag] = min;
        const ok = min >= 8;
        if (ok) pass++; else fail++;
        lines.push(label + ' min=' + min.toFixed(2) + ' ' + rawStr + ' (>= 8) ' + (ok ? 'PASS' : 'FAIL'));
        continue;
      }
      const lim = lane.group === 'from' ? 0.5 : lane.group === 'into' ? 1 : limitForAdd(lane, mode.tag);
      const ok = min <= lim;
      if (ok) pass++; else fail++;
      lines.push(label + ' min=' + min.toFixed(2) + ' ' + rawStr + ' (<= ' + lim.toFixed(2) + ') ' + (ok ? 'PASS' : 'FAIL'));
    }
  }
} finally {
  cleanup();
}

for (const l of lines) console.log(l);

const ok = fail === 0;
console.log(
  'GATE chrome' + (libArg ? ' (lib=' + LIB + ')' : '') + ': lanes=' + (pass + fail) +
  ' pass=' + pass + ' fail=' + fail + ' absent=' + absent +
  ' | CTRL df=' + (ctrlVal.df !== undefined ? ctrlVal.df.toFixed(2) : 'n/a') +
  ' ni=' + (ctrlVal.ni !== undefined ? ctrlVal.ni.toFixed(2) : 'n/a') +
  ' | ' + (ok ? 'ok' : 'FAIL (' + fail + ')'),
);
if (!ok) process.exit(1);
