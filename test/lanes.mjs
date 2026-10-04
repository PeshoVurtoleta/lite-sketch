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
import { execFileSync, spawnSync, execFile } from 'node:child_process';

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

// ---- N3 (H2.4): the F2-Node + F12 hash-word box lanes ------------------------
// 144 fresh children ((36 gated + 8 Noop) x REPS=3, + 12 SS once): {hll,cms,cmsest} x {b31,u32,n31,safe} x {df,ni,nc}, Noop x 4kc x
// {ni,nc} (the subtraction baseline + the never-optimize teeth), ss x 4kc x 3 modes
// (print-only; F3 is gated in H2.5). Run through an execFile pool of N3_JOBS (default 4;
// 1 = serial). Scavenges over 8N with a 4 MB semi-space; one HeapNumber box/op reads ~24.
const N3_JOBS = Math.max(1, parseInt(process.env.N3_JOBS || '4', 10) || 4);
const N3_KINDS = ['hll', 'cms', 'cmsest'];
const N3_MODES = ['df', 'ni', 'nc'];
const N3_KCS = ['b31', 'u32', 'n31', 'safe'];

function n3Flags(mode) {
    if (mode === 'ni') return [...BASE, ...NOINL];
    if (mode === 'nc') return [...BASE, '--allow-natives-syntax'];   // for natives.mjs's %NeverOptimizeFunction
    return [...BASE];
}
function scavJob(kind, kc, mode) {
    const args = [...n3Flags(mode), LANE, 'scav', kind, kc, 'fresh',
        ...(mode === 'nc' ? ['--nc'] : []), ...LIBFLAGS];
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(new Error('scav ' + kind + '/' + kc + '/' + mode + ': ' + err.message));
            const v = JSON.parse(stdout.trim().split('\n').pop()).scav;
            if (!Number.isInteger(v) || v < 0) return reject(new Error('scav ' + kind + '/' + kc + '/' + mode + ' returned ' + v));
            resolve(v);
        });
    });
}

// Every GATED lane (the 3 kinds x 4 kc x {df,ni,nc}) and its Noop baseline is run REPS times
// as separate children; the gate is on the MIN. Scheduler jitter / caller tier-up under CPU
// load only ADDS scavenges, never removes a real library box, so the MIN is the honest library
// estimate for all three modes. SS lanes are print-only (F3) and run once.
const REPS = 3;
const jobs = [];
for (const kind of N3_KINDS) for (const kc of N3_KCS) for (const mode of N3_MODES) {
    for (let r = 0; r < REPS; r++) jobs.push([kind, kc, mode]);
}
for (const kc of N3_KCS) for (const mode of ['ni', 'nc']) {
    for (let r = 0; r < REPS; r++) jobs.push(['noop', kc, mode]);
}
for (const kc of N3_KCS) for (const mode of N3_MODES) jobs.push(['ss', kc, mode]);

const R = {};   // key -> array of scav values (REPS entries for every gated lane and its Noop; one for SS)
let nextJob = 0;
async function n3Worker() {
    while (nextJob < jobs.length) {
        const idx = nextJob++;
        const [kind, kc, mode] = jobs[idx];
        const k = kind + '/' + kc + '/' + mode;
        const v = await scavJob(kind, kc, mode);
        (R[k] || (R[k] = [])).push(v);
    }
}
await Promise.all(Array.from({ length: Math.min(N3_JOBS, jobs.length) }, n3Worker));
const one = (k) => R[k][0];
const vmin = (k) => Math.min(...R[k]);

// Gates, fixed order. (1) ni/nc: min(lane) - min(noop, same mode, kc) <= 2 (24 lanes). Both
// sides are the MIN over REPS children (tier / jitter noise only adds scavenges).
for (const mode of ['ni', 'nc']) {
    for (const kind of N3_KINDS) {
        for (const kc of N3_KCS) {
            const delta = vmin(kind + '/' + kc + '/' + mode) - vmin('noop/' + kc + '/' + mode);
            gate('N3[' + mode + '/' + kind + '/' + kc + ']', delta, delta <= 2);
        }
    }
}
// (2) df: every rep is PRINTED, the gate is on the MIN. Default-tier caller tier-up (starved
// background compilation under CPU load) only ADDS scavenges, never removes a real library
// box, so the MIN is the honest library estimate. The HLL df lanes carry HEAD teeth (HEAD min
// b31/u32/safe ~25, n31 ~49). hll/n31 is gated against the LIVE Noop(ni, n31): under the default
// cumulative inline budget `add` stays OUT of the lane loop so the caller boxes its own read and
// the library adds 0 -- but when V8 DOES inline `add` the same lane reads 2-3, so the gate is
// min <= noop(ni,n31) + 2, not a hard 24. The cms / cmsest df lanes read 1-2 on HEAD too, so
// they are regression guards (gated on MIN <= 2; the ni / nc lanes are their HEAD teeth).
for (const kind of N3_KINDS) {
    for (const kc of N3_KCS) {
        const k = kind + '/' + kc + '/df';
        const mn = vmin(k);
        const all = R[k].join(',');
        if (kind === 'hll' && kc === 'n31') {
            const lim = vmin('noop/n31/ni') + 2;
            gate('N3[df/hll/n31]', 'min=' + mn + '[' + all + '](<=' + lim + ')', mn <= lim);
        } else {
            const guard = kind === 'hll' ? '' : ' (regression guard; ni/nc are the HEAD teeth)';
            gate('N3[df/' + kind + '/' + kc + ']', 'min=' + mn + '[' + all + ']' + guard, mn <= 2);
        }
    }
}
// (3) NC-CTRL teeth: a never-optimize that silently failed would read 0 (the caller would
// be optimized and unbox the Float64Array read); the interpreter caller boxes, so >= 12.
for (const kc of N3_KCS) {
    const v = vmin('noop/' + kc + '/nc');
    gate('NC-CTRL[noop/' + kc + ']', v, v >= 12);
}
// Print-only: the ni Noop baseline (min), and the SS lanes (F3, gated in H2.5).
for (const kc of N3_KCS) results.push('noop-ni[' + kc + ']=' + vmin('noop/' + kc + '/ni'));
for (const mode of N3_MODES) for (const kc of N3_KCS) results.push('SS[' + mode + '/' + kc + ']=' + one('ss/' + kc + '/' + mode) + ' (print-only: F3, gated in H2.5)');

const ok = fails === 0;
console.log('GATE lanes' + (libArg ? ' (lib=' + libArg + ')' : '') + ': ' + results.join(' ') +
    ' | ' + (ok ? 'ok' : 'FAIL (' + fails + ')'));
if (!ok) process.exitCode = 1;
