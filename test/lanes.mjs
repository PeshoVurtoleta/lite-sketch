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
//   * N4-CTRL[df/ring] (H2.8) -- the `ring` laneType: a library-INDEPENDENT one-box
//     control (the perf2 / PerfGate oneBoxCtl shape -- a fractional double from a
//     Float64Array stored into a PACKED Array(64), one 16 B HeapNumber per op), df, min
//     of 3 >= 8. It promotes the CTRL precursor to a gated lane and records the scavenge
//     count PerfGate's maxScavenges-2 gate can only pass/fail, not PRINT. It passes
//     identically under `--lib` (the revert-check relies on this).
//   * N3c[cap120/...] -- the cmax WRAPPER-SIZE teeth lane (H2.6, F5). It pins
//     `--max-inlined-bytecode-size=120` (via scavJob's inlineCap), a value BETWEEN the H2.6 add
//     wrapper (74 B) and HEAD's add (378 B): so the box is controlled by add's BODY SIZE -- the
//     tree wrapper inlines (key -> _buf, 0 box), HEAD's oversized add cannot and the caller boxes
//     its non-Smi key. This is NOT a df lane; the `cap120` mode tag says so.
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
// H2.8: the revert-check asserts teeth BY NAME, so collect the failed / absent gate
// names (a gate valued exactly 'ABSENT' is a missing method; any other !ok is a FAIL).
// Printed as two parseable lines below the GATE line. Additive -- gating is unchanged.
const failedGates = [];
const absentGates = [];
function gate(name, value, ok) {
    results.push(name + '=' + value);
    if (!ok) { fails++; if (value === 'ABSENT') absentGates.push(name); else failedGates.push(name); }
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

// ---- N4-CTRL (H2.8): a library-INDEPENDENT one-box ring, df, min of 3 >= 8 -----
// The `ring` laneType stores one ~16 B HeapNumber per op into a PACKED Array(64) (the perf2 /
// PerfGate oneBoxCtl shape). This records the scavenge count PerfGate's maxScavenges-2 gate can
// only pass/fail, not PRINT. 8 = 2/3 of the low mode (12) and 4x the <= 2 lane gate. It touches no
// module, so it reads the same under --lib -- the revert-check keeps N4-CTRL PASSing on 1.1.2.
function runRing() {
    const out = execFileSync(process.execPath, [...BASE, LANE, 'ring', ...LIBFLAGS], { encoding: 'utf8' });
    const v = JSON.parse(out.trim().split('\n').pop()).scav;
    if (!Number.isInteger(v) || v < 0) throw new Error('ring lane returned ' + v);
    return v;
}
{
    const rr = [runRing(), runRing(), runRing()];
    const mn = Math.min(...rr);
    gate('N4-CTRL[df/ring]', 'min=' + mn + '[' + rr.join(',') + ']', mn >= 8);
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
// ABSENT: the --lib build lacks the method the lane drives (addFrom / addHashedFrom). The child
// prints {"absent": name} and exits 0, so the lane never crashes and is never rerun; the parent
// resolves this sentinel and the gate FAILs valued ABSENT. The revert-check (--lib HEAD) turns
// every N1 / AHF gate ABSENT this way.
const ABSENT = 'ABSENT';
function scavJob(job) {
    const { kind, kc, mode, count, countv, hit, from, hfrom, prefill, warm } = job;
    const extra = [];
    if (mode === 'nc') extra.push('--nc');
    if (count != null) extra.push('--count', String(count));
    if (countv != null) extra.push('--countv', String(countv));
    if (hit) extra.push('--hit');
    if (from) extra.push('--from');
    if (hfrom) extra.push('--hfrom');
    if (prefill != null) extra.push('--prefill', String(prefill));
    // An optional pinned inline cap (cmax teeth): a value BETWEEN the H2.6 wrapper (74 B) and
    // HEAD's add (378 B) so the wrapper inlines (key -> _buf, 0 box) while HEAD's add cannot
    // (the non-inlined caller boxes its non-Smi key). Deterministic where pure-df tier-up is not.
    const capFlag = job.inlineCap != null ? ['--max-inlined-bytecode-size=' + job.inlineCap] : [];
    const args = [...n3Flags(mode), ...capFlag, LANE, 'scav', kind, kc, warm || 'fresh', ...extra, ...LIBFLAGS];
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(new Error('scav ' + job.key + ': ' + err.message));
            const obj = JSON.parse(stdout.trim().split('\n').pop());
            if (obj && obj.absent) return resolve(ABSENT);
            const v = obj.scav;
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
// background compilation under CPU load) only ADDS scavenges, never removes a real library box, so
// the MIN is the honest library estimate. Since H2.6 `add` is a wrapper that inlines and stages the
// key in `_buf`, every HLL df lane -- n31 included -- reads 0-1 on the tree and is gated on a hard
// MIN <= 2 (hll/n31 no longer rides the LIVE Noop(ni,n31) + 2). These df lanes are TREE REGRESSION
// GUARDS, not reliable HEAD teeth: whether HEAD's larger add boxes in df is tier-up dependent, so on
// a fast/early-tiering run hll/n31 can fall to min 2 on HEAD and PASS (observed reps 2,24,24). The
// HEAD teeth live elsewhere -- the ni / nc lanes (and, for addFrom, the ABSENT N1 lanes).
for (const kind of N3_KINDS) {
    for (const kc of N3_KCS) {
        const k = kind + '/' + kc + '/df';
        const mn = vmin(k);
        const all = R[k].join(',');
        if (kind === 'hll' && kc === 'n31') {
            // Tightened (F5, H2.6): a hard <= 2, no longer the LIVE Noop(ni,n31) + 2. `add` is now a
            // wrapper that inlines and stages the key in `_buf`, so hll/n31 df reads 0-1; HEAD's
            // de-inlined add boxed its own negative-large key read.
            gate('N3[df/hll/n31]', 'min=' + mn + '[' + all + '](<=2)', mn <= 2);
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
// G2 (tightened, F5/H2.6): SS add count-1, df. A hard min <= 2, no longer the LIVE Noop(ni,kc) + 2.
// SS `add` is now a <= 74-byte wrapper that inlines into the caller and stages the key in `_buf`, so
// the caller no longer boxes its own non-Smi key read: the df lane reads 0-1. HEAD's 790-byte add was
// never inlined and the caller boxed its K[..] read inside the library (24-25); it FAILs this gate.
for (const kc of N3_KCS) {
    const lk = 'ss/' + kc + '/df';
    const mn = vmin(lk);
    gate('N3[df/ss/' + kc + ']', 'min=' + mn + '[' + reps(lk) + '](<=2)', mn <= 2);
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

// ---- N1 + AHF (F5 / F6): the addFrom / addHashedFrom zero-box lanes --------------------------
// A shared child pool (N3_JOBS). The N1 / AHF lanes run REP 1 first; any lane that reads > 2 is
// rerun up to 3 children and gated on the MIN (tier-up / jitter under CPU load only adds scavenges,
// never removes a real library box). ABSENT (the --lib build lacks the method) is a FAIL valued
// ABSENT, never rerun. nc is NOT a lane here: the never-optimized interpreter caller boxes its own
// F[0] / F[1] Float64Array reads (the driver's box, identical to a Noop addFrom), so there is no
// library signal to gate -- addFrom exists precisely to move that box off the hot path, and df + ni
// (where the caller tiers up and the wrapper / From sibling inline) are the gated modes.
const ALL_KCS = ['small', 'b30', 'b31', 'u32', 'n31', 'safe'];
async function runPool(jobList, concurrency) {
    const res = {};
    let next = 0;
    async function worker() {
        while (next < jobList.length) {
            const job = jobList[next++];
            const v = await scavJob(job);
            (res[job.key] || (res[job.key] = [])).push(v);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobList.length) }, worker));
    return res;
}

// N1: addFrom, <= 2. HLL (6 kc x {fresh,warm} x {df,ni} = 24); CMS / CMSp / SS x {c1,c30,v31}
// (3 counts x 6 kc x 2 warm x 2 mode = 72 each) = 240 lanes total.
const N1_SPECS = [];
for (const warm of ['fresh', 'warm']) for (const mode of ['df', 'ni']) for (const kc of ALL_KCS) {
    N1_SPECS.push({ kind: 'hll', from: true, kc, warm, mode, key: 'N1[' + mode + '/hll/' + kc + '/' + warm + ']' });
}
const N1_COUNTS = [['c1', { count: 1 }], ['c30', { count: 2 ** 30 }], ['v31', { countv: 2 ** 31 }]];
for (const [member, kind] of [['cms', 'cms'], ['cmsp', 'cmsp'], ['ss', 'ss']]) {
    for (const [ctag, copt] of N1_COUNTS) for (const warm of ['fresh', 'warm']) for (const mode of ['df', 'ni']) for (const kc of ALL_KCS) {
        N1_SPECS.push(Object.assign({ kind, from: true, kc, warm, mode, key: 'N1[' + mode + '/' + member + '.' + ctag + '/' + kc + '/' + warm + ']' }, copt));
    }
}
// AHF: addHashedFrom, <= 2. HLL | CMS x {fresh,warm} x {df,ni} = 8 lanes.
const AHF_SPECS = [];
for (const member of ['hll', 'cms']) for (const warm of ['fresh', 'warm']) for (const mode of ['df', 'ni']) {
    AHF_SPECS.push({ kind: member, hfrom: true, kc: 'small', warm, mode, key: 'AHF[' + mode + '/' + member + '/' + warm + ']' });
}

const REP1_SPECS = [...N1_SPECS, ...AHF_SPECS];
const rep1 = await runPool(REP1_SPECS.map((s) => Object.assign({}, s)), N3_JOBS);
// Rerun (two more reps) only the lanes whose rep 1 read > 2 (a numeric read; ABSENT is never rerun).
const rerun = [];
for (const s of REP1_SPECS) {
    const v = rep1[s.key][0];
    if (v !== ABSENT && v > 2) { rerun.push(Object.assign({}, s)); rerun.push(Object.assign({}, s)); }
}
const rep23 = rerun.length ? await runPool(rerun, N3_JOBS) : {};
function n1Gate(s) {
    const all = [...(rep1[s.key] || []), ...(rep23[s.key] || [])];
    if (all.includes(ABSENT)) { gate(s.key, ABSENT, false); return; }
    const mn = Math.min(...all);
    gate(s.key, 'min=' + mn + '[' + all.join(',') + ']', mn <= 2);
}
for (const s of N1_SPECS) n1Gate(s);
for (const s of AHF_SPECS) n1Gate(s);

// The min-of-3 lanes: AH-CTRL (teeth), N1e (D3 teeth), N3c cmax (F5 wrapper-size teeth, cap120). Each is 3 children.
const THREE = [];
const push3 = (job) => { for (let r = 0; r < 3; r++) THREE.push(Object.assign({}, job)); };
// AH-CTRL: a Noop addHashed fed uint32 lanes AS ARGS, ni, must read >= 12 (proves AHF's ~0 is a real
// elision, not an elided call). Uses the --hfrom buffer but the noop kind routes to addHashed(args).
const ahCtrl = { kind: 'noop', hfrom: true, kc: 'small', mode: 'ni', warm: 'fresh', key: 'AH-CTRL[noop/ni]' };
push3(ahCtrl);
// N1e: CMS estimate, df, prefill 2^31 so the return is a non-Smi -- D3 (write the min into _buf[1],
// return it from the wrapper) keeps it off the non-inlined _estimateAt return. <= 2 (tree 0). The
// teeth is the D3 REVERT (`return this._estimateAt(b, 0)`), which reads 24-25. HEAD is NOT a teeth
// here: it reads min 0-2 and PASSES (its estimate return inlines under default tier-up).
for (const kc of ['small', 'b31']) push3({ kind: 'cmsest', prefill: 2 ** 31, kc, mode: 'df', warm: 'fresh', key: 'N1e[df/cmsest.c31/' + kc + ']' });
// N3c cmax: CMS add, CONSTANT count 2^32-1, pinned to a 120-byte inline cap (NOT df -- the `cap120`
// mode tag says so). This is F5 WRAPPER-SIZE teeth: the cap sits between the H2.6 add wrapper (74 B,
// inlines even under the cap -> key lands in _buf, 0 box) and HEAD's 378 B add (cannot inline under
// the cap -> the caller boxes its non-Smi key). So it proves add shrank to a wrapper that inlines
// and _addAt (object, Smi) adds no box. Deterministic: tree 1,1,1; HEAD ~24 (pure-df tier-up on a
// loaded machine inlines HEAD's add early and reads a vacuous 0-1). It is NOT an F2 gate: an F2
// revert (CMS _addAt back on _m3round / _m3final helper calls instead of the hand-inline) is not
// gated in Node -- it reads 1,1,1 at cap120 (the hand-inline vs helper call changes neither the
// wrapper's inlinability nor the key box; F2's win is Chrome ni B/op, out of this harness's scope).
for (const kc of ['b31', 'n31', 'safe']) push3({ kind: 'cms', count: 2 ** 32 - 1, kc, mode: 'df', inlineCap: 120, warm: 'fresh', key: 'N3c[cap120/cms.cmax/' + kc + ']' });

const r3 = await runPool(THREE, N3_JOBS);
function minGate(key, ok) {
    const all = r3[key] || [];
    if (all.includes(ABSENT)) { gate(key, ABSENT, false); return; }
    const mn = Math.min(...all);
    gate(key, 'min=' + mn + '[' + all.join(',') + ']', ok(mn));
}
minGate('AH-CTRL[noop/ni]', (mn) => mn >= 12);
for (const kc of ['small', 'b31']) minGate('N1e[df/cmsest.c31/' + kc + ']', (mn) => mn <= 2);
for (const kc of ['b31', 'n31', 'safe']) minGate('N3c[cap120/cms.cmax/' + kc + ']', (mn) => mn <= 2);

// ---- N8 (H2.7, F7/F8): the cold-read query zero-box lanes. Each gate min-of-3, every rep ----
// printed. A new `query` laneType in lane.mjs; 1.6M units/lane. topKInto / quantilesInto are
// ABSENT on HEAD (--lib revert-check FAILs exactly these 6 as ABSENT); forEach / quantile exist,
// so both CTRLs stay live. ~30 children (+5-8 s at N3_JOBS=4).
function queryJob(job) {
    const flags = [...BASE, ...(job.mode === 'ni' ? NOINL : [])];
    const extra = job.n != null ? ['--n', String(job.n)] : [];
    const args = [...flags, LANE, 'query', job.qkind, ...extra, ...LIBFLAGS];
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(new Error('query ' + job.key + ': ' + err.message));
            const obj = JSON.parse(stdout.trim().split('\n').pop());
            if (obj && obj.absent) return resolve(ABSENT);
            const v = obj.scav;
            if (!Number.isInteger(v) || v < 0) return reject(new Error('query ' + job.key + ' returned ' + v));
            resolve(v);
        });
    });
}
const N8_SPECS = [];
const push8 = (job) => { for (let r = 0; r < 3; r++) N8_SPECS.push(Object.assign({}, job)); };
for (const mode of ['df', 'ni']) {
    for (const n of [16, 64]) {
        push8({ qkind: 'ss.topKInto.big', n, mode, key: 'N8[' + mode + '/ss.topKInto.n' + n + '/big]' });
    }
    push8({ qkind: 'dd.quantilesInto.q4', mode, key: 'N8[' + mode + '/dd.quantilesInto.q4]' });
    push8({ qkind: 'ss.forEach.small', mode, key: 'N8[' + mode + '/ss.forEach/small]' });
}
push8({ qkind: 'dd.quantile', mode: 'ni', key: 'Q-CTRL[ni/dd.quantile]' });
push8({ qkind: 'ss.forEach.big', mode: 'ni', key: 'FE-CTRL[ni/ss.forEach/big]' });

const r8 = {};
{
    let next8 = 0;
    const worker8 = async () => {
        while (next8 < N8_SPECS.length) {
            const job = N8_SPECS[next8++];
            const v = await queryJob(job);
            (r8[job.key] || (r8[job.key] = [])).push(v);
        }
    };
    await Promise.all(Array.from({ length: Math.min(N3_JOBS, N8_SPECS.length) }, worker8));
}
function n8Gate(key, ok) {
    const all = r8[key] || [];
    if (all.includes(ABSENT)) { gate(key, ABSENT, false); return; }
    const mn = Math.min(...all);
    gate(key, 'min=' + mn + '[' + all.join(',') + ']', ok(mn));
}
for (const mode of ['df', 'ni']) {
    for (const n of [16, 64]) n8Gate('N8[' + mode + '/ss.topKInto.n' + n + '/big]', (mn) => mn <= 2);
    n8Gate('N8[' + mode + '/dd.quantilesInto.q4]', (mn) => mn <= 2);
    n8Gate('N8[' + mode + '/ss.forEach/small]', (mn) => mn <= 2);
}
n8Gate('Q-CTRL[ni/dd.quantile]', (mn) => mn >= 12);
n8Gate('FE-CTRL[ni/ss.forEach/big]', (mn) => mn >= 12);

const ok = fails === 0;
console.log('GATE lanes' + (libArg ? ' (lib=' + libArg + ')' : '') + ': ' + results.join(' ') +
    ' | ' + (ok ? 'ok' : 'FAIL (' + fails + ')'));
console.log('LANES-FAILED=' + failedGates.join(','));
console.log('LANES-ABSENT=' + absentGates.join(','));
if (!ok) process.exitCode = 1;
