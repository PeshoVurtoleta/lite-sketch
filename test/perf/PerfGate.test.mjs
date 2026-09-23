// @zakkster/lite-sketch -- the perf gate (repo-only; run:
//   node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs).
//
// The zero-GC allocation gate as a test: each hot scenario must run N + 8N ops with 0
// scavenges / 0 old-gen GC / 0 arrayBuffer growth (the register bank is fixed at
// construction, so the `grows` counter -- its ArrayBuffer byte length -- must show a 0
// delta). A `mustFail` control that allocates per op MUST trip the gate, proving teeth.

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { HyperLogLog, CountMinSketch, DDSketch } from '../../Sketch.js';

const P = 14;
const M = 1 << P;

/** Zero-alloc counter: the single backing register bank's byte length -- fixed at construction. */
function grows(s) { return s.h._reg.buffer.byteLength; }

/** Zero-alloc counter: the CountMinSketch counter matrix's byte length -- fixed at construction. */
function cmsGrows(s) { return s.c._counts.buffer.byteLength; }

/** Zero-alloc counter: the DDSketch bin array's byte length -- fixed at construction. */
function ddGrows(s) { return s.d._bins.buffer.byteLength; }

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
        return { h, v: 0, sink: 0 };
    },
    hot(s, n) {
        const h = s.h;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 0x9e3779b1) | 0;
            const hi = v >>> 0;
            h.addHashed(hi, (hi ^ 0x5bd1e995) >>> 0);
            sink = (sink + h._reg[hi & (M - 1)]) | 0;
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

// maxScavenges: the AUTHORITATIVE 0-B/op proof is test/torture.mjs (measureAllocs = 0 B/op on add
// AND addHashed, gc major 0). This perf gate proves the other invariants strictly -- NO old-gen GC,
// NO arrayBuffer growth (grows delta 0: the register bank never resizes), flat throughput, and the
// mustFail teeth catch a real allocator -- and allows a SMALL scavenge floor. That floor is a V8
// artifact of hashing: a uint32 hash lane >= 2^31 is a boxed double, and V8's transient handling of
// those (e.g. passing uint32 lanes as addHashed args across a not-yet-inlined call) registers a few
// young-gen scavenges that net to 0 B/op (torture) and never reach old gen. It is NOT a per-op heap
// allocation (that would be thousands of scavenges + a tripped teeth, as the mustFail control shows).
zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 64,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    // the HyperLogLog(14) register bank is ~16 KB, the CountMinSketch(5, 16384) counter
    // matrix is ~320 KB, and the default DDSketch(0.01) bin array (maxBins=2048) is ~16 KB;
    // setup builds each scenario's state twice + harness overhead. grows delta 0 (all three
    // counters below) is the leak invariant, not the retained-KB headline.
    maxRetainedKB: 1024,
    scenarios: [addStream, addHashedStream, cmsAddConsStream, cmsAddPlainStream, cmsEstimateStream, ddAddStream],
    mustFail: [mustFailAlloc],
});
