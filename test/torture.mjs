// @zakkster/lite-sketch -- the torture gate (repo-only; run: `node --expose-gc test/torture.mjs`).
//
// Proves the ZERO-GC claim the family sells: every hot op allocates 0 B/op after
// construction, retains nothing, and triggers no major GC over a long run. Uses:
//   - @zakkster/lite-gc-profiler -- measureAllocs (bytes/op) + GcProfiler + checkNoGc
//   - @zakkster/lite-leak        -- retention: do instances outlive their scope?
// No gate output is a FAIL. ASCII-only.

async function main() {
    if (typeof globalThis.gc !== 'function') {
        console.error('FAIL: run with --expose-gc  (node --expose-gc test/torture.mjs)');
        process.exitCode = 1;
        return;
    }
    for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
        try { await import(pkg); }
        catch { console.error('FAIL: missing devDep ' + pkg + ' (npm install)'); process.exitCode = 1; return; }
    }
    const { GcProfiler, checkNoGc, measureAllocs } = await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const { HyperLogLog } = await import('../Sketch.js');

    const noop = () => {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- phase 1: retention (do build/fill/count/clear cycles reclaim fully?) ----
    const tracker = createLeakTracker();
    function fillTracker() {
        for (let i = 0; i < 256; i++) {
            const h = new HyperLogLog(12, (0x9e3779b1 ^ i) >>> 0);
            for (let k = 0; k < 4096; k++) h.add(((k * 2654435761) ^ i) | 0);
            h.count();                 // exercise the cold estimator (reused _hist, 0 alloc)
            h.clear();
            tracker.track(h, noop, 'hyperloglog', { audit: true });
        }
        return tracker.size();
    }
    const trackedMid = fillTracker();
    const trackedOk = trackedMid > 0;   // non-vacuous: the tracker really holds instances
    let live = tracker.size();
    for (let g = 0; g < 20 && live > 0; g++) { globalThis.gc(); await sleep(25); live = tracker.size(); }
    const findings = tracker.audit();

    // ---- phase 2a: 0 B/op on the hot path ----
    // add(key): hash a numeric key + one register max. Built/primed OUTSIDE the window.
    const M = 1 << 14;
    const hll = new HyperLogLog(14, 0x9e3779b1);
    for (let k = 0; k < M; k++) hll.add(k);          // prime the registers (steady state)
    let addKey = 0, addSink = 0;
    const addStep = () => {
        addKey = (addKey + 0x9e3779b1) | 0;          // walk the key space (int32)
        hll.add(addKey);
        addSink = (addSink + hll._reg[addKey & (M - 1)]) | 0;   // observe the store (defeat DCE)
    };
    const addRes = measureAllocs(addStep, { iterations: 100000, batches: 8 });
    const addBpc = addRes.bytesPerCall === null ? 0 : addRes.bytesPerCall;
    const addBytes = Math.max(0, Math.round(addBpc));
    const addOk = addBytes === 0;

    // addHashed(hi, lo): the pre-hashed fast path (skips the mix).
    let ahHi = 0, ahSink = 0;
    const ahStep = () => {
        ahHi = (ahHi + 0x9e3779b1) >>> 0;
        hll.addHashed(ahHi, (ahHi ^ 0x5bd1e995) >>> 0);
        ahSink = (ahSink + hll._reg[ahHi & (M - 1)]) | 0;
    };
    const ahRes = measureAllocs(ahStep, { iterations: 100000, batches: 8 });
    const ahBpc = ahRes.bytesPerCall === null ? 0 : ahRes.bytesPerCall;
    const ahBytes = Math.max(0, Math.round(ahBpc));
    const ahOk = ahBytes === 0;

    // ---- phase 2b: GC budget over a long hot run ----
    const gc = new GcProfiler().start();
    const HOT = 2000000;
    let SINK = 0;
    for (let i = 0; i < HOT; i++) { addStep(); }
    SINK += addSink + ahSink;
    await sleep(50);
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });

    // ---- phase 2c: arrayBuffers growth (the reused register bank grows no store) ----
    const abBefore = process.memoryUsage().arrayBuffers;
    const reuse = new HyperLogLog(14, 0x1234);
    for (let c = 0; c < 200; c++) {
        for (let k = 0; k < M; k++) reuse.add((k ^ c) | 0);
        reuse.count();
        reuse.clear();                 // O(m) fill(0), no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----
    const ok = trackedOk && live === 0 && findings.length === 0 &&
        addOk && ahOk && report.ok && abOk;
    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) +
        ' | alloc=' + addBytes + ' B/op (HyperLogLog add) ' + ahBytes + ' B/op (HyperLogLog addHashed)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' abGrowth=' + abDelta + ')');

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: tracker held ' + trackedMid + ' (expected > 0)');
        if (live !== 0) console.error('  retain: ' + live + ' HyperLogLog instances survived');
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        if (!addOk) console.error('  alloc ' + addBytes + ' B/op HyperLogLog add (raw ' + addBpc + ')');
        if (!ahOk) console.error('  alloc ' + ahBytes + ' B/op HyperLogLog addHashed (raw ' + ahBpc + ')');
        if (!report.ok) console.error('  gc ' + JSON.stringify(report.violations));
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
