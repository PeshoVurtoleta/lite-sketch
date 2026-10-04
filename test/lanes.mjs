// @zakkster/lite-sketch -- the child-process lane harness (repo-only; `npm run lanes`).
//
// The measuring instrument H2.1 builds and H2.4-H2.8 reuse. Each lane is its OWN
// child (test/lanes/lane.mjs), spawned with `--expose-gc --max-semi-space-size=4`,
// in two modes: default and `--max-inlined-bytecode-size=0` (no-inline). A tiny
// semi-space makes one HeapNumber box per op show as scavenges at 8N = 1.6M ops.
//
// Lanes (H2.1):
//   * N2-HLL -- HyperLogLog.add, key classes {small, 2^30+} x {fresh, warm} x
//     {default, no-inline} = 8 lanes, each <= 2 scavenges. This is the F1 fix:
//     the deopt loop on `(h << p) >>> 0` boxed every uint32 temporary.
//   * N5 -- a --trace-deopt child in the AUDIT shape (3 instances at p 4/12/18,
//     keys from a Float64Array, driven through a closure); the `not int32` deopts
//     of add, gated <= 3 (default + no-inline). A positive control (Ctl.ctlSuf, the
//     pre-F1 `(h << p) >>> 0` shape) runs in the same child in its own phase and must
//     deopt at least CTRL_DEOPT_MIN times, so a dropped flag, a re-routed trace or a
//     reworded reason FAILs (VACUOUS) instead of passing at 0.
//   * CTRL (teeth) -- a no-op add fed 2^31+ keys in no-inline mode must read >= 12,
//     proving the lane sees one 16 B box per op. The local precursor of N4.
//
// `--lib <absolute path>` runs every lane against another module (the revert-check:
// the N2-HLL and N5 lanes FAIL on HEAD, while CTRL still passes). ASCII-only.
import { execFileSync, spawnSync } from 'node:child_process';

const LANE = new URL('./lanes/lane.mjs', import.meta.url).pathname;
const libArg = (() => { const k = process.argv.indexOf('--lib'); return k >= 0 ? process.argv[k + 1] : null; })();
const LIBFLAGS = libArg ? ['--lib', libArg] : [];
const BASE = ['--expose-gc', '--max-semi-space-size=4'];
const NOINL = ['--max-inlined-bytecode-size=0'];

// The deopt positive control (Ctl.ctlSuf, the pre-F1 `(h << p) >>> 0` shape) deopts on
// every run regardless of the module under test: measured 13-48 default (9 under a
// 36-way CPU overload) and ~400-1250 no-inline. Its job is only to prove the trace pipe
// and the reason text are live, which ONE attributed bailout does, so the floor is 1:
// a higher floor would only add false FAILs under load, never catch a vacuous pass.
const CTRL_DEOPT_MIN = 1;

function runScav(kind, kc, warm, noInline) {
    const flags = [...BASE, ...(noInline ? NOINL : [])];
    const out = execFileSync(process.execPath, [...flags, LANE, 'scav', kind, kc, warm, ...LIBFLAGS],
        { encoding: 'utf8' });
    const v = JSON.parse(out.trim().split('\n').pop()).scav;
    if (!Number.isInteger(v) || v < 0) throw new Error('lane scav returned ' + v + ' (' + kind + '/' + kc + '/' + warm + ')');
    return v;
}

function runDeopt(noInline) {
    const flags = ['--trace-deopt', ...BASE, ...(noInline ? NOINL : [])];
    const r = spawnSync(process.execPath, [...flags, LANE, 'deopt', ...LIBFLAGS],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('deopt child exited ' + r.status + (r.stderr ? '\n' + r.stderr : ''));
    const text = (r.stdout || '') + '\n' + (r.stderr || '');   // trace routing-agnostic
    // Attribute each `not int32` bailout to its JSFunction by name. The gated count is
    // every such deopt EXCEPT the control's (ctlSuf); the child drives nothing else.
    const re = /reason: not int32\)[^\n]*<JSFunction (\S+) /g;
    let total = 0, ctl = 0, m;
    while ((m = re.exec(text)) !== null) { total++; if (m[1] === 'ctlSuf') ctl++; }
    return { gated: total - ctl, ctl, total };
}

const results = [];
let fails = 0;
function gate(name, value, ok) {
    results.push(name + '=' + value);
    if (!ok) fails++;
    return ok;
}

// ---- N2-HLL: 8 lanes, each <= 2 ----------------------------------------------
for (const noInline of [false, true]) {
    const modeTag = noInline ? 'ni' : 'df';
    for (const kc of ['small', 'b30']) {
        for (const warm of ['fresh', 'warm']) {
            const v = runScav('hll', kc, warm, noInline);
            gate('N2-HLL[' + kc + '/' + warm + '/' + modeTag + ']', v, v <= 2);
        }
    }
}

// ---- N5: deopt-loop gate, <= 3 add deopts per mode; control proves non-vacuity ----
for (const noInline of [false, true]) {
    const tag = noInline ? 'ni' : 'df';
    const d = runDeopt(noInline);
    // non-vacuity: the trace machinery saw deopts AND the control fired at its floor
    const live = d.total > 0 && d.ctl >= CTRL_DEOPT_MIN;
    gate('N5[' + tag + ']', d.gated, d.gated <= 3 && live);
    results.push('N5ctl[' + tag + ']=' + d.ctl);
    if (!live) results.push('N5[' + tag + ']VACUOUS(total=' + d.total + ',ctl=' + d.ctl + ')');
}

// ---- CTRL (teeth): no-op add on 2^31+ keys, no-inline, must read >= 12 --------
{
    const v = runScav('noop', 'b31', 'fresh', true);
    gate('CTRL[b31/ni]', v, v >= 12);
}

const ok = fails === 0;
console.log('GATE lanes' + (libArg ? ' (lib=' + libArg + ')' : '') + ': ' + results.join(' ') +
    ' | ' + (ok ? 'ok' : 'FAIL (' + fails + ')'));
if (!ok) process.exitCode = 1;
