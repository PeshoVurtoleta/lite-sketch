// @zakkster/lite-sketch -- the child half of the lane harness (repo-only).
//
// ONE lane per child process. The parent (test/lanes.mjs) spawns this with
// `--expose-gc --max-semi-space-size=4` plus, in no-inline mode,
// `--max-inlined-bytecode-size=0`; the deopt lane is additionally spawned under
// `--trace-deopt`. A lane either counts minor GCs (scavenges) over 8N = 1.6M ops
// after a forced gc(), or runs the audit-shape deopt driver (whose `--trace-deopt`
// output the parent greps). Keys are read from a prefilled Float64Array -- NEVER
// from a closure int -- so a key >= 2^31 crosses the add boundary as a double, the
// exact shape F1 fixes. `--lib <absolute path>` runs a lane against another module
// (the revert-check). Prints one JSON line the parent parses. ASCII-only.
import { PerformanceObserver, constants } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const laneType = argv[0];
const flag = (name, dflt) => { const k = argv.indexOf(name); return k >= 0 ? argv[k + 1] : dflt; };
const lib = flag('--lib', null);
const MODULE = lib || new URL('../../Sketch.js', import.meta.url).pathname;

const N = 200000;
const OPS = 8 * N;                 // 8N = 1.6M ops
const SIZE = 65536;
const MASK = SIZE - 1;

// Prefill the key ring. A key >= 2^31 is NOT a Smi, so reading it from this
// Float64Array and passing it to a non-inlined add() is exactly the double the
// lane measures -- the keys never live in a closure int.
function fillKeys(kc) {
    const K = new Float64Array(SIZE);
    let base;
    switch (kc) {
        case 'small': base = 0; break;
        case 'b30': base = 2 ** 30; break;
        case 'b31': base = 2 ** 31; break;                 // >= 2^31 (non-Smi positive)
        case 'u32': base = 2 ** 32 - 1 - 65536; break;     // up to 2^32-1
        case 'n31': base = -(2 ** 31) - 65536; break;      // negative, |key| >= 2^31
        case 'safe': base = 2 ** 53 - 1 - 65536; break;    // up to 2^53-1 (two-word)
        default: base = 0;
    }
    for (let i = 0; i < SIZE; i++) K[i] = base + i;
    return K;
}

async function countScav(step, warm) {
    if (warm) { for (let i = 0; i < N; i++) step(i); }   // warm = run N ops before the window
    let minor = 0;
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            const kind = e.detail ? e.detail.kind : e.kind;   // detail on new Node, e.kind fallback
            if (kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
        }
    });
    if (globalThis.gc) globalThis.gc();
    obs.observe({ entryTypes: ['gc'] });
    for (let i = 0; i < OPS; i++) step(i);
    await new Promise((r) => setTimeout(r, 50));
    obs.takeRecords().forEach((e) => {   // drain any entries still queued before disconnect
        const kind = e.detail ? e.detail.kind : e.kind;
        if (kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
    });
    obs.disconnect();
    return minor;
}

// A no-op class with a REAL body (so V8 cannot elide the call). Its add reads BOTH the
// key and the count argument, proving the lane can see one HeapNumber box per op for a
// boxed key AND a boxed count (CTRL / CV-CTRL teeth). Every counted kind passes it the
// same count expression, so lane - noop isolates the LIBRARY's boxing.
class Noop {
    constructor() { this.s = 0; }
    add(k, c) { this.s = (this.s + (k > 0 ? 1 : 2) + (c > 0 ? 1 : 0)) | 0; return this; }
    // AH-CTRL teeth: a real-bodied addHashed fed uint32 lanes AS ARGS. hi/lo >= 2^31 are boxed
    // doubles at the call boundary -- the exact box addHashedFrom(buf, i) reads UNBOXED. In ni
    // it must read >= 12, proving the AHF lanes' ~0 is a real elision, not a dead call.
    addHashed(hi, lo) { this.s = (this.s + (hi > 0 ? 1 : 2) + (lo > 0 ? 1 : 0)) | 0; return this; }
}

// N5 POSITIVE CONTROL -- library-independent, carries the OLD suffix shape
// `(h << p) >>> 0` on purpose. It ALWAYS deopt-loops ("not int32") regardless of the
// module under test, so the parent can confirm the --trace-deopt machinery actually
// sees deopts this run (else N5's 0 would be a vacuous pass). Its method name `ctlSuf`
// lets the parent attribute and subtract its deopts from the gated HLL count.
class Ctl {
    constructor(p) { this.p = p; this.r = new Uint8Array(1 << p); }
    ctlSuf(x) {
        const h = Math.imul(x | 0, 0x9e3779b1);
        const p = this.p;
        const j = h >>> (32 - p);
        const s = (h << p) >>> 0;                  // the pre-F1 shape: a uint32 >= 2^31 deopts
        const rho = s !== 0 ? Math.clz32(s) + 1 : 33;
        if (rho > this.r[j]) this.r[j] = rho;
        return this;
    }
}

async function main() {
    if (laneType === 'scav') {
        // scav <kind: hll|cms|cmsp|cmsest|ss|noop> <kc: small|b30|b31|u32|n31|safe> <warm: fresh|warm>
        //   [--nc] [--count C | --countv C] [--hit] [--from] [--hfrom] [--prefill C]
        // --nc pins step in the interpreter (standalone add) via test/lanes/natives.mjs.
        // --count C   a CONSTANT count C (a Smi when C=1, the H2.4 shape; default 1).
        // --countv C  a VARIABLE count read from a Float64Array, CS[i] = C + (i & 7) (the
        //             lite-hud cumulative-microseconds shape; a non-Smi for C >= 2^31).
        // --hit       SS key index i & 511 on SS(1024), so every op is a bump (no evictions).
        // --from      drive addFrom(F, 0): F[0] = K[i], F[1] = CS?[i] : CNT (N1). The key + count
        //             cross as (Float64Array, Smi) -- no caller box. A missing addFrom on the
        //             --lib build prints {"absent":"addFrom"} and exits 0 (the parent FAILs it).
        // --hfrom     drive addHashedFrom(U, j*stride): a prefilled Uint32Array, hi = 2^31 + j,
        //             lo = (hi ^ 0x5bd1e995) >>> 0, CMS count slot = 1 (stride 2 HLL / 3 CMS).
        //             noop runs the AH-CTRL: addHashed(U[j*2], U[j*2+1]) (lanes AS ARGS, boxed).
        // --prefill C cmsest only: add every ring key with count C first, so estimate returns C
        //             (>= 2^31 for C = 2^31) and a non-inlined boxed return would show (N1e).
        // The count/key expressions are baked into the step closure at setup; the loop never branches.
        const kind = argv[1], kc = argv[2], warm = argv[3] === 'warm';
        const nc = argv.indexOf('--nc') >= 0;
        const hit = argv.indexOf('--hit') >= 0;
        const from = argv.indexOf('--from') >= 0;
        const hfrom = argv.indexOf('--hfrom') >= 0;
        const countvS = flag('--countv', null);
        const countS = flag('--count', null);
        const prefillS = flag('--prefill', null);
        const M = await import(MODULE);
        const K = fillKeys(kc);
        // The count source: a Float64Array (variable) or a closure const (constant, Smi for 1).
        let CS = null, CNT = 1;
        if (countvS !== null) {
            const C = Number(countvS);
            CS = new Float64Array(SIZE);
            for (let i = 0; i < SIZE; i++) CS[i] = C + (i & 7);
        } else if (countS !== null) {
            CNT = Number(countS);
        }
        const KM = hit ? 511 : MASK;      // bump-only key window for --hit
        const F = new Float64Array(2);    // addFrom scratch: F[0] = key, F[1] = count
        let sink = 0;
        let step = null;
        let absent = null;                // set to a method name when --lib lacks addFrom/addHashedFrom
        if (hfrom) {
            // F6: a prefilled uint32-lane buffer. hi = 2^31 + j is a non-Smi uint32; reading it
            // from the Uint32Array through addHashedFrom is unboxed, while the AH-CTRL passes the
            // same lanes as plain args (boxed). CMS carries a count-1 slot (stride 3).
            const stride = (kind === 'cms' || kind === 'cmsp') ? 3 : 2;
            const U = new Uint32Array(SIZE * stride);
            for (let j = 0; j < SIZE; j++) {
                const hi = (2 ** 31 + j) >>> 0;
                U[j * stride] = hi;
                U[j * stride + 1] = (hi ^ 0x5bd1e995) >>> 0;
                if (stride === 3) U[j * stride + 2] = 1;
            }
            if (kind === 'hll') {
                const hll = new M.HyperLogLog(14);
                if (typeof hll.addHashedFrom !== 'function') absent = 'addHashedFrom';
                else step = (i) => { const j = i & MASK; hll.addHashedFrom(U, j * 2); sink = (sink + hll._reg[j & 16383]) | 0; };
            } else if (kind === 'cms' || kind === 'cmsp') {
                const cms = new M.CountMinSketch(5, 16384, { conservative: kind === 'cms' });
                if (typeof cms.addHashedFrom !== 'function') absent = 'addHashedFrom';
                else step = (i) => { const j = i & MASK; cms.addHashedFrom(U, j * 3); sink = (sink + cms._counts[j & 16383]) | 0; };
            } else {
                const noop = new Noop();
                step = (i) => { const j = i & MASK; noop.addHashed(U[j * 2], U[j * 2 + 1]); sink = (sink + noop.s) | 0; };
            }
        } else if (from) {
            // F5: the key (and count) land in a Float64Array slot, read by addFrom(F, 0) -- so a
            // key / count >= 2^31 crosses as (object, Smi), never as a boxed argument.
            if (kind === 'hll') {
                const hll = new M.HyperLogLog(14);
                if (typeof hll.addFrom !== 'function') absent = 'addFrom';
                else step = (i) => { F[0] = K[i & MASK]; hll.addFrom(F, 0); sink = (sink + hll._reg[i & 16383]) | 0; };
            } else if (kind === 'cms' || kind === 'cmsp') {
                const cms = new M.CountMinSketch(5, 16384, { conservative: kind === 'cms' });
                if (typeof cms.addFrom !== 'function') absent = 'addFrom';
                else step = CS
                    ? (i) => { F[0] = K[i & MASK]; F[1] = CS[i & MASK]; cms.addFrom(F, 0); sink = (sink + cms._counts[i & 16383]) | 0; }
                    : (i) => { F[0] = K[i & MASK]; F[1] = CNT; cms.addFrom(F, 0); sink = (sink + cms._counts[i & 16383]) | 0; };
            } else if (kind === 'ss') {
                const ss = new M.SpaceSaving(1024);
                if (typeof ss.addFrom !== 'function') absent = 'addFrom';
                // Sink `_mapOcc` (Uint8Array -> Smi), NOT `_count` (large counts would box in the sink).
                else step = CS
                    ? (i) => { F[0] = K[i & KM]; F[1] = CS[i & MASK]; ss.addFrom(F, 0); sink = (sink + ss._mapOcc[i & 1023]) | 0; }
                    : (i) => { F[0] = K[i & KM]; F[1] = CNT; ss.addFrom(F, 0); sink = (sink + ss._mapOcc[i & 1023]) | 0; };
            }
        } else if (kind === 'hll') {
            const hll = new M.HyperLogLog(14);
            step = (i) => { hll.add(K[i & MASK]); sink = (sink + hll._reg[i & 16383]) | 0; };
        } else if (kind === 'cms' || kind === 'cmsp') {
            const cms = new M.CountMinSketch(5, 16384, { conservative: kind === 'cms' });
            step = CS
                ? (i) => { cms.add(K[i & MASK], CS[i & MASK]); sink = (sink + cms._counts[i & 16383]) | 0; }
                : (i) => { cms.add(K[i & MASK], CNT); sink = (sink + cms._counts[i & 16383]) | 0; };
        } else if (kind === 'cmsest') {
            const cms = new M.CountMinSketch(5, 16384, { conservative: true });
            // --prefill C: establish counts (>= 2^31 for C = 2^31) BEFORE the window, so estimate's
            // return is a non-Smi -- a non-inlined boxed return would show up here (N1e / D3 teeth).
            if (prefillS !== null) { const C = Number(prefillS); for (let i = 0; i < SIZE; i++) cms.add(K[i], C); }
            step = (i) => { sink = (sink + (cms.estimate(K[i & MASK]) > 0 ? 1 : 0)) | 0; };
        } else if (kind === 'ss') {
            const ss = new M.SpaceSaving(1024);
            // Sink `_mapOcc` (a Uint8Array -> Smi), NOT `_count` (a Float64Array whose large
            // evicted/bumped counts would box in the sink read and pollute the lane). The `add`
            // call is side-effecting, so it cannot be dead-code-eliminated regardless.
            step = CS
                ? (i) => { ss.add(K[i & KM], CS[i & MASK]); sink = (sink + ss._mapOcc[i & 1023]) | 0; }
                : (i) => { ss.add(K[i & KM], CNT); sink = (sink + ss._mapOcc[i & 1023]) | 0; };
        } else {
            const noop = new Noop();
            step = CS
                ? (i) => { noop.add(K[i & KM], CS[i & MASK]); sink = (sink + noop.s) | 0; }
                : (i) => { noop.add(K[i & KM], CNT); sink = (sink + noop.s) | 0; };
        }
        if (absent) { console.log(JSON.stringify({ absent })); return; }
        if (nc) { const { neverOpt } = await import('./natives.mjs'); neverOpt(step); }
        const scav = await countScav(step, warm);
        console.log(JSON.stringify({ scav, sink: sink & 1 }));
        return;
    }
    if (laneType === 'query') {
        // query <kind> [--n N]  -- the COLD-READ zero-box lanes (N8, H2.7). One SS(64) / DD(0.01)
        //   fixture built once, then 1.6M UNITS stepped (units = entries written / scanned, or
        //   quantiles) so the lane scale matches the add lanes. A method absent on the --lib build
        //   prints {"absent": name} and exits 0 (the parent FAILs the gate valued ABSENT). kinds:
        //     ss.topKInto.big     topKInto(ok,oc,oe,n) over the big fixture; per = w (entries written)
        //     ss.forEach.small    forEach over the small (Smi) fixture; per = size (scanned) -> 0
        //     ss.forEach.big      FE-CTRL: forEach over big; a non-inlined fn boxes 3 doubles/entry
        //     dd.quantilesInto.q4 quantilesInto([.5,.9,.99,.999], out); per = 4 (q read / written via F64)
        //     dd.quantile         Q-CTRL: quantile(.5) read into a sink; per = 1 (the return box)
        // The big fixture's keys (>= 2^31) and counts (>= 2^31) are non-Smi doubles, so forEach boxes
        // them crossing the callback; topKInto writes them into Float64Arrays (no box). ASCII-only.
        const kind = argv[1];
        const nOpt = flag('--n', null);
        const M = await import(MODULE);
        const SINK = new Float64Array(4);
        let sink = 0;
        let step = null, per = 1, absent = null;
        if (kind === 'ss.topKInto.big' || kind === 'ss.forEach.small' || kind === 'ss.forEach.big') {
            const big = kind !== 'ss.forEach.small';
            const ss = new M.SpaceSaving(64);
            for (let i = 0; i < 256; i++) {
                if (big) ss.add(2 ** 31 + (i % 128), 2 ** 31 + i);   // non-Smi key + count
                else ss.add(i % 128, 1 + i);                          // Smi key + count
            }
            if (kind === 'ss.topKInto.big') {
                if (typeof ss.topKInto !== 'function') absent = 'topKInto';
                else {
                    const n = nOpt !== null ? Number(nOpt) : 64;
                    const ok = new Float64Array(64), oc = new Float64Array(64), oe = new Float64Array(64);
                    per = n < 64 ? n : 64;                            // entries written per call
                    step = () => { sink = (sink + ss.topKInto(ok, oc, oe, n)) | 0; };
                }
            } else {
                per = 64;                                             // forEach scans all 64 entries
                // The callback reads all three args: a non-inlined fn (ni mode) boxes each >= 2^31
                // double crossing the call (3/entry for big; 0 for small Smi -- the regression guard).
                const fn = (k, c, e) => { sink = (sink + (k > 0 ? 1 : 0) + (c > 0 ? 1 : 0) + (e > 0 ? 1 : 0)) | 0; };
                step = () => { ss.forEach(fn); };
            }
        } else if (kind === 'dd.quantilesInto.q4' || kind === 'dd.quantile') {
            const d = new M.DDSketch(0.01);
            for (let i = 1; i <= 10000; i++) d.add(1e6 + i * 1.37);
            if (kind === 'dd.quantilesInto.q4') {
                if (typeof d.quantilesInto !== 'function') absent = 'quantilesInto';
                else {
                    const qs = new Float64Array([0.5, 0.9, 0.99, 0.999]);
                    const out = new Float64Array(4);
                    per = 4;                                          // quantiles written per call
                    step = () => { sink = (sink + d.quantilesInto(qs, out)) | 0; };
                }
            } else {
                // Q-CTRL: quantile returns a fractional double across a non-inlined call -> a 16 B box
                // per call. Stored into a Float64Array AFTER the box already crossed the call boundary.
                per = 1;
                step = () => { SINK[0] = d.quantile(0.5); };
            }
        }
        if (absent) { console.log(JSON.stringify({ absent })); return; }
        if (step === null) { console.error('lane.mjs: unknown query kind ' + JSON.stringify(kind)); process.exitCode = 2; return; }
        // 1.6M units: iters = OPS / per step-calls. Warm the step closure (capped) so df tiers up,
        // then gc() and count scavenges over the window (one 16 B box/op reads ~24 at 4 MB semi-space).
        const iters = Math.max(1, Math.floor(OPS / per));
        const warm = Math.min(iters >> 3, 50000);
        for (let i = 0; i < warm; i++) step();
        let minor = 0;
        const obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                const k = e.detail ? e.detail.kind : e.kind;
                if (k === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
            }
        });
        if (globalThis.gc) globalThis.gc();
        obs.observe({ entryTypes: ['gc'] });
        for (let i = 0; i < iters; i++) step();
        await new Promise((r) => setTimeout(r, 50));
        obs.takeRecords().forEach((e) => {
            const k = e.detail ? e.detail.kind : e.kind;
            if (k === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
        });
        obs.disconnect();
        console.log(JSON.stringify({ scav: minor, sink: (sink + (SINK[0] > 0 ? 1 : 0)) & 1 }));
        return;
    }
    if (laneType === 'deopt') {
        // The audit shape: 3 instances at p 4/12/18, driven 1.6M ops each through a
        // non-inlined closure, keys read from a Float64Array in [0, 2^31). The parent
        // runs this under --trace-deopt and counts the `not int32` deopts, attributing
        // by JSFunction name: HLL `add` (gated <= 3) vs the `ctlSuf` positive control.
        // Two separate phases keep attribution clean.
        const M = await import(MODULE);
        const K = new Float64Array(SIZE);
        for (let i = 0; i < SIZE; i++) K[i] = (i * 2654435761) % 2147483647;   // [0, 2^31)
        let sink = 0;
        // phase 1: the HLL add path under test
        for (const p of [4, 12, 18]) {
            const h = new M.HyperLogLog(p);
            const f = (x) => h.add(x);
            for (let i = 0; i < OPS; i++) f(K[i & MASK]);
            sink = (sink + h._reg[0]) | 0;
        }
        // phase 2: the library-independent positive control (always deopts)
        for (const p of [4, 12, 18]) {
            const c = new Ctl(p);
            const g = (x) => c.ctlSuf(x);
            for (let i = 0; i < OPS; i++) g(K[i & MASK]);
            sink = (sink + c.r[0]) | 0;
        }
        if (sink === 0x7fffffff) process.stderr.write('');   // defeat DCE without emitting trace noise
        return;
    }
    console.error('lane.mjs: unknown lane type ' + JSON.stringify(laneType));
    process.exitCode = 2;
}

main();
