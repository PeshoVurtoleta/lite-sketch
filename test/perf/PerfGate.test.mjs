// @zakkster/lite-sketch -- the perf gate (repo-only; run:
//   node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs).
//
// The zero-GC allocation gate as a test: each hot scenario must run N + 8N ops with 0
// scavenges (gated at <= 2, the suite's lane convention) / 0 old-gen GC / 0 arrayBuffer
// growth (the register bank is fixed at construction, so the `grows` counter -- its
// ArrayBuffer byte length -- must show a 0 delta). Two `mustFail` controls that allocate
// per op MUST trip the gate, proving teeth: a fresh escaping Array, and a single boxed
// double per op (oneBoxCtl).

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { HyperLogLog, CountMinSketch, DDSketch, SpaceSaving } from '../../Sketch.js';

const P = 14;
const M = 1 << P;

/** Zero-alloc counter: the single backing register bank's byte length -- fixed at construction. */
function grows(s) { return s.h._reg.buffer.byteLength; }

/** Zero-alloc counter: the CountMinSketch counter matrix's byte length -- fixed at construction. */
function cmsGrows(s) { return s.c._counts.buffer.byteLength; }

/** Zero-alloc counter: the DDSketch bin array's byte length -- fixed at construction. */
function ddGrows(s) { return s.d._bins.buffer.byteLength; }

/** Zero-alloc counter: a SpaceSaving counter pool's byte length -- fixed at construction. */
function ssGrows(s) { return s.s._count.buffer.byteLength; }

/** SpaceSaving capacity for the perf scenario (a realistic top-k size). */
const SS_K = 1024;

/** add-stream: hash a walking numeric key + one register max each op (the hot path). */
const addStream = {
    name: 'HyperLogLog add-stream (hash + register max)',
    setup() {
        const h = new HyperLogLog(P, 0x9e3779b1);
        for (let k = 0; k < M; k++) h.add(k);     // prime to steady state
        return { h, v: 0, sink: 0 };
    },
    hot(s, n) {
        const h = s.h;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 0x9e3779b1) | 0;
            h.add(v);
            sink = (sink + h._reg[v & (M - 1)]) | 0;
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** addHashed: the pre-hashed fast path -- two uint32 lanes, skips the mix. */
const addHashedStream = {
    name: 'HyperLogLog addHashed (pre-hashed lanes)',
    setup() {
        const h = new HyperLogLog(P, 0x9e3779b1);
        for (let k = 0; k < M; k++) h.add(k);
        return { h, v: 0, sink: 0, buf: new Uint32Array(2) };
    },
    hot(s, n) {
        const h = s.h;
        const buf = s.buf;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 0x9e3779b1) | 0;
            buf[0] = v; buf[1] = v ^ 0x5bd1e995;    // ToUint32 on store: same lane bits as addHashed(hi, lo)
            h.addHashedFrom(buf, 0);                 // F6: lanes >= 2^31 read UNBOXED from the Uint32Array
            sink = (sink + h._reg[v & (M - 1)]) | 0;
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** CMS width (a power of two, matches the family default sizing at this depth). */
const CW = 1 << 14;

/** add-stream conservative: hash a numeric key + the two-pass conservative row update. */
const cmsAddConsStream = {
    name: 'CountMinSketch add-stream conservative (hash + 2-pass row update)',
    setup() {
        const c = new CountMinSketch(5, CW, { conservative: true });
        for (let k = 0; k < 100000; k++) c.add(k);   // prime to steady state
        return { c, v: 0, sink: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 0x9e3779b1) | 0;
            c.add(v);
            sink = (sink + c._counts[v & (CW - 1)]) | 0;
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: cmsGrows(s) }; },
};

/** add-stream plain: hash a numeric key + one saturating add per row. */
const cmsAddPlainStream = {
    name: 'CountMinSketch add-stream plain (hash + saturating row add)',
    setup() {
        const c = new CountMinSketch(5, CW, { conservative: false });
        for (let k = 0; k < 100000; k++) c.add(k);
        return { c, v: 0, sink: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 0x9e3779b1) | 0;
            c.add(v);
            sink = (sink + c._counts[v & (CW - 1)]) | 0;
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: cmsGrows(s) }; },
};

/** estimate-stream: the min-of-d point query, never throws, 0 B/op. */
const cmsEstimateStream = {
    name: 'CountMinSketch estimate-stream (min-of-d point query)',
    setup() {
        const c = new CountMinSketch(5, CW, { conservative: true });
        for (let k = 0; k < 100000; k++) c.add(k);
        return { c, v: 0, sink: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 0x9e3779b1) | 0;
            sink = (sink + c.estimate(v)) | 0;
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: cmsGrows(s) }; },
};

/**
 * add-stream: DDSketch's hot path -- one Math.log/key compute + one in-window
 * Float64Array increment. Primed to a warm, stable window OUTSIDE the measured run,
 * then walked over a bounded positive range that stays in-window for the whole hot
 * loop (no slide, no collapse) so the bin array never resizes.
 */
const ddAddStream = {
    name: 'DDSketch add-stream (log-scale key + in-window Float64Array increment)',
    setup() {
        const d = new DDSketch(0.01);
        for (let k = 1; k <= 100000; k++) d.add(k);   // prime to a warm, stable window
        return { d, v: 0, sink: 0 };
    },
    hot(s, n) {
        const d = s.d;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v++; if (v > 99999) v = 1;                // walk a bounded positive range (stays in-window)
            d.add(v);
            sink = (sink + d._bins[0] + d._maxKeyPop) | 0;   // observe the bank (defeat DCE)
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: ddGrows(s) }; },
};

/**
 * add-stream at STEADY-STATE FULL: prime k distinct keys so the summary is at capacity,
 * then feed a walk of FRESH (never-seen) keys so every op takes the EVICT path -- delete
 * the min key from the map (backshift), reassign its slot, and re-file it in the forest.
 * This is SpaceSaving's important 0-alloc case (eviction IS the algorithm). The counter
 * pools are fixed at construction, so `grows` (a pool's byte length) shows a 0 delta.
 */
const ssEvictStream = {
    name: 'SpaceSaving add-stream steady-state-full (evict every op: map backshift + forest re-file)',
    setup() {
        const s = new SpaceSaving(SS_K, { seed: 0x9e3779b1 });
        for (let k = 0; k < SS_K; k++) s.add(k);      // prime to capacity (full)
        const kb = new Float64Array(2); kb[1] = 1;    // addFrom scratch: KB[0] = key, KB[1] = count 1
        return { s, v: SS_K, sink: 0, kb };
    },
    hot(s, n) {
        const ss = s.s;
        const kb = s.kb;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 0x9e3779b1) | 0;                  // a fresh, unmonitored key every op -> forces evict
            kb[0] = v >>> 0;                           // F5: the key crosses UNBOXED via (Float64Array, i)
            ss.addFrom(kb, 0);
            sink = (sink + ss.size) | 0;               // observe state (defeat DCE)
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: ssGrows(s) }; },
};

/**
 * The teeth: a per-op call that builds a FRESH array each op -- it MUST trip the gate
 * (scavenges scale with n), proving the instrument catches a real allocation.
 */
const mustFailAlloc = {
    name: 'HyperLogLog add + a fresh escaping array per op (MUST allocate)',
    setup() { return { h: new HyperLogLog(P, 0x9e3779b1), leak: null, sink: 0 }; },
    hot(s, n) {
        const h = s.h;
        let sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            h.add(i);
            // A sizeable fresh array that ESCAPES to the retained state each op -> genuine per-op
            // heap churn far above the uint32-lane-transient floor (no escape-analysis elision).
            const arr = new Array(64);
            arr[0] = i;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * N4 one-box control (the perf2 shape, verbatim): read a FRACTIONAL double from a Float64Array,
 * multiply, and store the result into a PACKED (`new Array(64).fill(null)`, PACKED_ELEMENTS) ring.
 * Each store is one ~16 B HeapNumber, so scavenges scale with n and it MUST trip at maxScavenges 2.
 * This is the tooth that BINDS the threshold: at the old 64 it does NOT trip (8N reads 12-25 < 64),
 * so putting 64 back turns the suite red.
 */
const oneBoxCtl = {
    name: 'N4 one-box control: Float64Array -> fractional value -> ring store (MUST trip at maxScavenges 2)',
    setup() { const F = new Float64Array(1024); for (let i = 0; i < 1024; i++) F[i] = i + 0.5; const ring = new Array(64).fill(null); return { F, ring, sink: 0 }; },
    hot(s, n) { const F = s.F, ring = s.ring; for (let i = 0; i < n; i++) ring[i & 63] = F[i & 1023] * 1.5; s.sink = ring.length; },
    statsOf() { return { grows: 0 }; },
};

// maxScavenges is 2 -- the suite's lane `<= 2` convention. The AUTHORITATIVE 0-B/op proof is
// test/torture.mjs (measureAllocs = 0 B/op on add AND addHashed, gc major 0). This perf gate
// proves the other invariants strictly -- NO old-gen GC, NO arrayBuffer growth (grows delta 0:
// the register bank never resizes), flat throughput -- and both mustFail controls catch a real
// per-op box. Every hot scenario reads 0 scavenges at N and 8N today; the earlier 64 floor is
// gone because its two true causes are both fixed:
//   (1) H2.1 F1: a Maglev deopt loop on `hiSuf = (h << p) >>> 0` ("not int32") in HLL add, fixed
//       by `h << p` (clz32 reads the same bits); HLL add is now 0 scavenges.
//   (2) H2.6 F5 / F6 + N7: the DRIVER passed keys and uint32 hash lanes >= 2^31 as ARGUMENTS to a
//       not-yet-inlined add / addHashed -- the caller's own box, netting 0 B/op (torture) and never
//       reaching old gen. Since H2.6 this scenario drives addHashedFrom and ssEvict drives addFrom,
//       reading the lanes / key UNBOXED from a caller buffer (F6 / F5), so the floor is gone.
// Neither was ever a per-op heap allocation (that is thousands of scavenges + tripped teeth, as the
// mustFailAlloc and oneBoxCtl controls show). The value is LOWERED to 2 in H2.8 (was 64).
zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 2,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    // the HyperLogLog(14) register bank is ~16 KB, the CountMinSketch(5, 16384) counter
    // matrix is ~320 KB, the default DDSketch(0.01) bin array (maxBins=2048) is ~16 KB, and
    // the SpaceSaving(1024) fixed pools (key/count/error + forest + map) are ~90 KB; setup
    // builds each scenario's state twice + harness overhead. grows delta 0 (all four
    // counters) is the leak invariant, not the retained-KB headline.
    maxRetainedKB: 2048,
    scenarios: [addStream, addHashedStream, cmsAddConsStream, cmsAddPlainStream, cmsEstimateStream, ddAddStream, ssEvictStream],
    mustFail: [mustFailAlloc, oneBoxCtl],
});
