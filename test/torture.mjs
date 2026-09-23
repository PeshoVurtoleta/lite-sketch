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
    const { HyperLogLog, CountMinSketch, DDSketch } = await import('../Sketch.js');

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

    // ---- phase 1b: CountMinSketch retention (build/fill/clear cycles reclaim fully?) ----
    const cmsTracker = createLeakTracker();
    function fillCmsTracker() {
        for (let i = 0; i < 256; i++) {
            const c = new CountMinSketch(5, 1024, { seed: (0x9e3779b1 ^ i) >>> 0 });
            for (let k = 0; k < 4096; k++) c.add(((k * 2654435761) ^ i) | 0);
            c.estimate(0);             // exercise the query path
            c.clear();
            cmsTracker.track(c, noop, 'countminsketch', { audit: true });
        }
        return cmsTracker.size();
    }
    const cmsTrackedMid = fillCmsTracker();
    const cmsTrackedOk = cmsTrackedMid > 0;
    let cmsLive = cmsTracker.size();
    for (let g = 0; g < 20 && cmsLive > 0; g++) { globalThis.gc(); await sleep(25); cmsLive = cmsTracker.size(); }
    const cmsFindings = cmsTracker.audit();

    // ---- phase 1c: DDSketch retention (build/fill/quantile/clear cycles reclaim fully?) ----
    const ddTracker = createLeakTracker();
    function fillDdTracker() {
        for (let i = 0; i < 256; i++) {
            const d = new DDSketch(0.01);
            for (let k = 1; k <= 4096; k++) d.add(((k ^ i) & 0x3fffffff) | 1);   // positive values
            d.quantile(0.5);           // exercise the cold quantile walk (0 alloc)
            d.clear();
            ddTracker.track(d, noop, 'ddsketch', { audit: true });
        }
        return ddTracker.size();
    }
    const ddTrackedMid = fillDdTracker();
    const ddTrackedOk = ddTrackedMid > 0;
    let ddLive = ddTracker.size();
    for (let g = 0; g < 20 && ddLive > 0; g++) { globalThis.gc(); await sleep(25); ddLive = ddTracker.size(); }
    const ddFindings = ddTracker.audit();

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

    // ---- phase 2a-cms: 0 B/op on the CountMinSketch hot path ----
    const CW = 1 << 14;   // width (pow2); flat index i*w+col stays well under the SMI cap
    // cms.add conservative: hash a numeric key + two-pass conservative row update.
    const cmsC = new CountMinSketch(5, CW, { conservative: true });
    for (let k = 0; k < 100000; k++) cmsC.add(k);
    // Push _total past 2^31 BEFORE measuring so `_total += count` runs against a DOUBLE
    // field during the window -- proves the running total does not box a HeapNumber per op
    // (the risk flagged in the brief; a per-op box would show as > 0 B/op below).
    cmsC.add(0, 0xffffffff);
    let ccKey = 0, ccSink = 0;
    const ccStep = () => {
        ccKey = (ccKey + 0x9e3779b1) | 0;
        cmsC.add(ccKey);
        ccSink = (ccSink + cmsC._counts[ccKey & (CW - 1)]) | 0;   // observe a store (defeat DCE)
    };
    const ccRes = measureAllocs(ccStep, { iterations: 100000, batches: 8 });
    const ccBpc = ccRes.bytesPerCall === null ? 0 : ccRes.bytesPerCall;
    const ccBytes = Math.max(0, Math.round(ccBpc));
    const ccOk = ccBytes === 0;

    // cms.add plain: classic per-row add.
    const cmsP = new CountMinSketch(5, CW, { conservative: false });
    for (let k = 0; k < 100000; k++) cmsP.add(k);
    let cpKey = 0, cpSink = 0;
    const cpStep = () => {
        cpKey = (cpKey + 0x9e3779b1) | 0;
        cmsP.add(cpKey);
        cpSink = (cpSink + cmsP._counts[cpKey & (CW - 1)]) | 0;
    };
    const cpRes = measureAllocs(cpStep, { iterations: 100000, batches: 8 });
    const cpBpc = cpRes.bytesPerCall === null ? 0 : cpRes.bytesPerCall;
    const cpBytes = Math.max(0, Math.round(cpBpc));
    const cpOk = cpBytes === 0;

    // cms.addHashed: the pre-hashed fast path (skips the mix).
    let chHi = 0, chSink = 0;
    const chStep = () => {
        chHi = (chHi + 0x9e3779b1) >>> 0;
        cmsC.addHashed(chHi, (chHi ^ 0x5bd1e995) >>> 0);
        chSink = (chSink + cmsC._counts[chHi & (CW - 1)]) | 0;
    };
    const chRes = measureAllocs(chStep, { iterations: 100000, batches: 8 });
    const chBpc = chRes.bytesPerCall === null ? 0 : chRes.bytesPerCall;
    const chBytes = Math.max(0, Math.round(chBpc));
    const chOk = chBytes === 0;

    // cms.estimate: the min-of-d point query (never throws).
    let ceKey = 0, ceSink = 0;
    const ceStep = () => {
        ceKey = (ceKey + 0x9e3779b1) | 0;
        ceSink = (ceSink + cmsC.estimate(ceKey)) | 0;
    };
    const ceRes = measureAllocs(ceStep, { iterations: 100000, batches: 8 });
    const ceBpc = ceRes.bytesPerCall === null ? 0 : ceRes.bytesPerCall;
    const ceBytes = Math.max(0, Math.round(ceBpc));
    const ceOk = ceBytes === 0;

    // ---- phase 2a-dd: 0 B/op on the DDSketch hot path ----
    // add(value): compute the log-scale bucket key + one in-window Float64Array increment.
    // Prime a positive stream OUTSIDE the measured window so the window/offset are WARM and
    // the common path is a pure in-window increment (no slide, no collapse).
    const dd = new DDSketch(0.01);
    for (let k = 1; k <= 100000; k++) dd.add(k);   // anchors the window; offset now stable
    // Push _count past 2^31 and _sum to a large double BEFORE measuring, so `_count += count`
    // and `_sum += value*count` run against DOUBLE fields during the window -- proves the
    // running aggregates (and the transient Math.log key) do not box a HeapNumber per op
    // (the risk flagged in the brief; a per-op box would show as > 0 B/op below).
    dd.add(50000, 0x7fffffff);
    dd.add(50000, 0x7fffffff);
    let ddV = 0, ddSink = 0;
    const ddStep = () => {
        ddV++; if (ddV > 99999) ddV = 1;             // walk a bounded positive range (stays in-window)
        dd.add(ddV);
        ddSink = (ddSink + dd._bins[0] + dd._maxKeyPop) | 0;   // observe the bank (defeat DCE)
    };
    const ddRes = measureAllocs(ddStep, { iterations: 100000, batches: 8 });
    const ddBpc = ddRes.bytesPerCall === null ? 0 : ddRes.bytesPerCall;
    const ddBytes = Math.max(0, Math.round(ddBpc));
    const ddOk = ddBytes === 0;

    // ---- phase 2b: GC budget over a long hot run ----
    const gc = new GcProfiler().start();
    const HOT = 2000000;
    let SINK = 0;
    for (let i = 0; i < HOT; i++) { addStep(); ccStep(); ceStep(); ddStep(); }   // HLL + CMS + DD hot ops
    SINK += addSink + ahSink + ccSink + cpSink + chSink + ceSink + ddSink;
    await sleep(50);
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });

    // ---- phase 2c: arrayBuffers growth (the reused banks grow no store, HLL + CMS) ----
    const abBefore = process.memoryUsage().arrayBuffers;
    const reuse = new HyperLogLog(14, 0x1234);
    const cmsReuse = new CountMinSketch(6, 1 << 13, { seed: 0x1234 });
    const ddReuse = new DDSketch(0.01);
    for (let c = 0; c < 200; c++) {
        for (let k = 0; k < M; k++) reuse.add((k ^ c) | 0);
        reuse.count();
        reuse.clear();                 // O(m) fill(0), no new store
        for (let k = 0; k < 8192; k++) cmsReuse.add((k ^ c) | 0);
        cmsReuse.estimate(c);
        cmsReuse.clear();              // O(d*w) fill(0), no new store
        for (let k = 1; k <= 8192; k++) ddReuse.add(((k ^ c) & 0x3fffffff) | 1);
        ddReuse.quantile(0.9);
        ddReuse.clear();              // O(maxBins) fill(0), no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----
    const cmsAllocOk = ccOk && cpOk && chOk && ceOk;
    const ok = trackedOk && live === 0 && findings.length === 0 &&
        cmsTrackedOk && cmsLive === 0 && cmsFindings.length === 0 &&
        ddTrackedOk && ddLive === 0 && ddFindings.length === 0 &&
        addOk && ahOk && cmsAllocOk && ddOk && report.ok && abOk;
    const gateLive = live + cmsLive + ddLive;
    const gateFindings = findings.length + cmsFindings.length + ddFindings.length;
    console.log(
        'GATE leak=size ' + gateLive + '/0 findings=' + gateFindings +
        ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) +
        ' | alloc=' + addBytes + ' B/op (HyperLogLog add) ' + ahBytes + ' B/op (HyperLogLog addHashed) ' +
        ccBytes + ' B/op (CountMinSketch add cons) ' + cpBytes + ' B/op (CountMinSketch add plain) ' +
        chBytes + ' B/op (CountMinSketch addHashed) ' + ceBytes + ' B/op (CountMinSketch estimate) ' +
        ddBytes + ' B/op (DDSketch add)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + '/' + cmsTrackedMid + '/' + ddTrackedMid + ' sink=' + SINK + ' abGrowth=' + abDelta + ')');

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: HLL tracker held ' + trackedMid + ' (expected > 0)');
        if (!cmsTrackedOk) console.error('  vacuous: CMS tracker held ' + cmsTrackedMid + ' (expected > 0)');
        if (!ddTrackedOk) console.error('  vacuous: DD tracker held ' + ddTrackedMid + ' (expected > 0)');
        if (live !== 0) console.error('  retain: ' + live + ' HyperLogLog instances survived');
        if (cmsLive !== 0) console.error('  retain: ' + cmsLive + ' CountMinSketch instances survived');
        if (ddLive !== 0) console.error('  retain: ' + ddLive + ' DDSketch instances survived');
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        for (const f of cmsFindings) console.error('  cms finding ' + f.kind + ':' + f.reason);
        for (const f of ddFindings) console.error('  dd finding ' + f.kind + ':' + f.reason);
        if (!addOk) console.error('  alloc ' + addBytes + ' B/op HyperLogLog add (raw ' + addBpc + ')');
        if (!ahOk) console.error('  alloc ' + ahBytes + ' B/op HyperLogLog addHashed (raw ' + ahBpc + ')');
        if (!ccOk) console.error('  alloc ' + ccBytes + ' B/op CountMinSketch add cons (raw ' + ccBpc + ')');
        if (!cpOk) console.error('  alloc ' + cpBytes + ' B/op CountMinSketch add plain (raw ' + cpBpc + ')');
        if (!chOk) console.error('  alloc ' + chBytes + ' B/op CountMinSketch addHashed (raw ' + chBpc + ')');
        if (!ceOk) console.error('  alloc ' + ceBytes + ' B/op CountMinSketch estimate (raw ' + ceBpc + ')');
        if (!ddOk) console.error('  alloc ' + ddBytes + ' B/op DDSketch add (raw ' + ddBpc + ')');
        if (!report.ok) console.error('  gc ' + JSON.stringify(report.violations));
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
