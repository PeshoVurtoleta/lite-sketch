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

// A no-op class with a REAL body (so V8 cannot elide the call). Its add reads the
// boxed key argument, proving the lane can see one HeapNumber box per op (CTRL teeth).
class Noop {
    constructor() { this.s = 0; }
    add(k) { this.s = (this.s + (k > 0 ? 1 : 2)) | 0; return this; }
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
        // scav <kind: hll|cms|cmsest|ss|noop> <kc: small|b30|b31|u32|n31|safe> <warm: fresh|warm> [--nc]
        // --nc pins step in the interpreter (standalone add) via test/lanes/natives.mjs.
        const kind = argv[1], kc = argv[2], warm = argv[3] === 'warm';
        const nc = argv.indexOf('--nc') >= 0;
        const M = await import(MODULE);
        const K = fillKeys(kc);
        let sink = 0;
        let step;
        if (kind === 'hll') {
            const hll = new M.HyperLogLog(14);
            step = (i) => { hll.add(K[i & MASK]); sink = (sink + hll._reg[i & 16383]) | 0; };
        } else if (kind === 'cms') {
            const cms = new M.CountMinSketch(5, 16384, { conservative: true });
            step = (i) => { cms.add(K[i & MASK], 1); sink = (sink + cms._counts[i & 16383]) | 0; };
        } else if (kind === 'cmsest') {
            const cms = new M.CountMinSketch(5, 16384, { conservative: true });
            step = (i) => { sink = (sink + (cms.estimate(K[i & MASK]) > 0 ? 1 : 0)) | 0; };
        } else if (kind === 'ss') {
            const ss = new M.SpaceSaving(1024);
            step = (i) => { ss.add(K[i & MASK], 1); sink = (sink + ss._count[i & 1023]) | 0; };
        } else {
            const noop = new Noop();
            step = (i) => { noop.add(K[i & MASK]); sink = (sink + noop.s) | 0; };
        }
        if (nc) { const { neverOpt } = await import('./natives.mjs'); neverOpt(step); }
        const scav = await countScav(step, warm);
        console.log(JSON.stringify({ scav, sink: sink & 1 }));
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
