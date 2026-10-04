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

// ---- N3 (H2.4 hash-word boxes) + N3c (H2.5 count boxes, F3/F4) ---------------
// 192 fresh children, all REPS=3. H2.4: {hll,cms,cmsest} x {b31,u32,n31,safe} x {df,ni,nc}
// (36) + Noop x 4kc x {ni,nc} (8, the subtraction baseline + never-optimize teeth). SS add
// count-1 x 4kc x {df,ni,nc} (12) -- print-only in H2.4, now GATED (G1 ni/nc, G2 df; F3).
// N3c count lanes (F3/F4): SS add count-2^30 small {ni,df} (G3); SS bump (--hit) count-2^31
// small+b31 ni with a Noop.hitv31 baseline (G4, + CV-CTRL); CMS cons + plain count-2^31 small
// df (G5). Run through an execFile pool of N3_JOBS (default 4; 1 = serial). Scavenges over 8N
// with a 4 MB semi-space; one HeapNumber box/op reads ~24.
const N3_JOBS = Math.max(1, parseInt(process.env.N3_JOBS || '4', 10) || 4);
const N3_KINDS = ['hll', 'cms', 'cmsest'];
const N3_MODES = ['df', 'ni', 'nc'];
const N3_KCS = ['b31', 'u32', 'n31', 'safe'];

function n3Flags(mode) {
    if (mode === 'ni') return [...BASE, ...NOINL];
    if (mode === 'nc') return [...BASE, '--allow-natives-syntax'];   // for natives.mjs's %NeverOptimizeFunction
    return [...BASE];
}
function scavJob(job) {
    const { kind, kc, mode, count, countv, hit } = job;
    const extra = [];
    if (mode === 'nc') extra.push('--nc');
    if (count != null) extra.push('--count', String(count));
    if (countv != null) extra.push('--countv', String(countv));
    if (hit) extra.push('--hit');
    const args = [...n3Flags(mode), LANE, 'scav', kind, kc, 'fresh', ...extra, ...LIBFLAGS];
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(new Error('scav ' + job.key + ': ' + err.message));
            const v = JSON.parse(stdout.trim().split('\n').pop()).scav;
            if (!Number.isInteger(v) || v < 0) return reject(new Error('scav ' + job.key + ' returned ' + v));
            resolve(v);
        });
    });
}

// Every lane -- gated or baseline -- is run REPS times as separate children; the gate is on the
// MIN. Scheduler jitter / caller tier-up under CPU load only ADDS scavenges, never removes a real
// library box, so the MIN is the honest library estimate for all three modes.
const REPS = 3;
const jobs = [];
const addLane = (job) => { for (let r = 0; r < REPS; r++) jobs.push(job); };

// H2.4: the gated hash-word lanes + their Noop baselines.
for (const kind of N3_KINDS) for (const kc of N3_KCS) for (const mode of N3_MODES) {
    addLane({ kind, kc, mode, key: kind + '/' + kc + '/' + mode });
}
for (const kc of N3_KCS) for (const mode of ['ni', 'nc']) {
    addLane({ kind: 'noop', kc, mode, key: 'noop/' + kc + '/' + mode });
}
// SS add count-1 x 4kc x 3 modes: print-only in H2.4, GATED here (G1 ni/nc, G2 df; F3).
for (const kc of N3_KCS) for (const mode of N3_MODES) {
    addLane({ kind: 'ss', kc, mode, key: 'ss/' + kc + '/' + mode });
}
// N3c H2.5 count lanes.
// G3: SS add, small key, CONSTANT count 2^30 (every arg a Smi -> 0), ni + df.
addLane({ kind: 'ss', kc: 'small', mode: 'ni', count: 2 ** 30, key: 'ss.c30/small/ni' });
addLane({ kind: 'ss', kc: 'small', mode: 'df', count: 2 ** 30, key: 'ss.c30/small/df' });
// G4: SS bump (--hit), VARIABLE count 2^31, small + b31, ni; vs a Noop.hitv31 baseline (also CV-CTRL).
for (const kc of ['small', 'b31']) {
    addLane({ kind: 'ss', kc, mode: 'ni', countv: 2 ** 31, hit: true, key: 'ss.hitv31/' + kc + '/ni' });
    addLane({ kind: 'noop', kc, mode: 'ni', countv: 2 ** 31, hit: true, key: 'noop.hitv31/' + kc + '/ni' });
}
// G5: CMS cons + plain, small key, VARIABLE count 2^31, df (the count crosses _applyCons/_applyPlain).
addLane({ kind: 'cms', kc: 'small', mode: 'df', countv: 2 ** 31, key: 'cms.v31/small/df' });
addLane({ kind: 'cmsp', kc: 'small', mode: 'df', countv: 2 ** 31, key: 'cmsp.v31/small/df' });

const R = {};   // key -> array of REPS scav values
let nextJob = 0;
async function n3Worker() {
    while (nextJob < jobs.length) {
        const job = jobs[nextJob++];
        const v = await scavJob(job);
        (R[job.key] || (R[job.key] = [])).push(v);
    }
}
await Promise.all(Array.from({ length: Math.min(N3_JOBS, jobs.length) }, n3Worker));
const vmin = (k) => Math.min(...R[k]);
const reps = (k) => R[k].join(',');

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
// Print-only: the ni Noop baseline (min).
for (const kc of N3_KCS) results.push('noop-ni[' + kc + ']=' + vmin('noop/' + kc + '/ni'));

// ---- N3c (H2.5, F3/F4): the count-box gates. Every rep is printed; the gate is on the MIN. ----
// G1 (teeth): SS add count-1, ni/nc. lane - noop(same mode, kc) <= 2. HEAD boxes the caller's key
// INSIDE the library (ni 74-75 / nc 25-26) so it FAILs; the tree reads the Noop floor.
for (const mode of ['ni', 'nc']) {
    for (const kc of N3_KCS) {
        const lk = 'ss/' + kc + '/' + mode, nk = 'noop/' + kc + '/' + mode;
        const delta = vmin(lk) - vmin(nk);
        gate('N3[' + mode + '/ss/' + kc + ']', delta + '[ss=' + reps(lk) + ',noop=' + reps(nk) + ']', delta <= 2);
    }
}
// G2 (regression guard): SS add count-1, df. min <= the LIVE vmin(noop, ni, kc) + 2 -- SS add is
// > 460 bytes (never inlined) so the df floor IS the caller's own box; the limit is never raised.
for (const kc of N3_KCS) {
    const lk = 'ss/' + kc + '/df';
    const mn = vmin(lk), lim = vmin('noop/' + kc + '/ni') + 2;
    gate('N3[df/ss/' + kc + ']', 'min=' + mn + '[' + reps(lk) + '](<=' + lim + ')', mn <= lim);
}
// G3 (teeth): SS add, small key, constant count 2^30 (every arg a Smi). min <= 2. HEAD reads ~24.
for (const mode of ['ni', 'df']) {
    const lk = 'ss.c30/small/' + mode, mn = vmin(lk);
    gate('N3c[' + mode + '/ss.c30/small]', 'min=' + mn + '[' + reps(lk) + ']', mn <= 2);
}
// G4 (teeth): SS bump, variable count 2^31, ni. lane - noop.hitv31(ni, kc) <= 2. HEAD boxes the
// count INSIDE the bump (delta ~25) so it FAILs; the tree reads the Noop floor (the caller's box).
for (const kc of ['small', 'b31']) {
    const lk = 'ss.hitv31/' + kc + '/ni', nk = 'noop.hitv31/' + kc + '/ni';
    const delta = vmin(lk) - vmin(nk);
    gate('N3c[ni/ss.hitv31/' + kc + ']', delta + '[ss=' + reps(lk) + ',noop=' + reps(nk) + ']', delta <= 2);
}
// CV-CTRL (teeth, non-vacuity): the variable count 2^31 really crosses as a non-Smi -> the Noop
// baseline must box it, reading >= 12. A Smi count or an elided arg would read ~0 and pass vacuously.
{
    const v = vmin('noop.hitv31/small/ni');
    gate('CV-CTRL[noop.hitv31/small]', v + '[' + reps('noop.hitv31/small/ni') + ']', v >= 12);
}
// G5 (teeth): CMS cons + plain, small key, variable count 2^31, df. min <= 2. HEAD boxes the count
// crossing _applyCons / _applyPlain (24-25) so it FAILs; the tree reads it from the _cnt slot.
for (const tag of ['cms', 'cmsp']) {
    const lk = tag + '.v31/small/df', mn = vmin(lk);
    gate('N3c[df/' + tag + '.v31/small]', 'min=' + mn + '[' + reps(lk) + ']', mn <= 2);
}

const ok = fails === 0;
console.log('GATE lanes' + (libArg ? ' (lib=' + libArg + ')' : '') + ': ' + results.join(' ') +
    ' | ' + (ok ? 'ok' : 'FAIL (' + fails + ')'));
if (!ok) process.exitCode = 1;
