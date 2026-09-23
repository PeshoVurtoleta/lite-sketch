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
    const { HyperLogLog, CountMinSketch, DDSketch, SpaceSaving } = await import('../Sketch.js');

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

    // ---- phase 1d: SpaceSaving retention (build/fill-past-capacity/clear cycles reclaim fully?) ----
    const ssTracker = createLeakTracker();
    function fillSsTracker() {
        for (let i = 0; i < 256; i++) {
            const ss = new SpaceSaving(256, { seed: (0x9e3779b1 ^ i) >>> 0 });
            for (let k = 0; k < 4096; k++) ss.add(((k * 2654435761) ^ i) | 0);  // fill PAST capacity -> evictions
            ss.estimate(0);            // exercise the query path
            ss.topK(3);                // exercise the cold ALLOCATING path (its garbage must reclaim too)
            ss.clear();
            ssTracker.track(ss, noop, 'spacesaving', { audit: true });
        }
        return ssTracker.size();
    }
    const ssTrackedMid = fillSsTracker();
    const ssTrackedOk = ssTrackedMid > 0;
    let ssLive = ssTracker.size();
    for (let g = 0; g < 20 && ssLive > 0; g++) { globalThis.gc(); await sleep(25); ssLive = ssTracker.size(); }
    const ssFindings = ssTracker.audit();

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

    // ---- phase 2a-ss: 0 B/op on the SpaceSaving hot path ----
    const SSK = 4096;
    // ss.add EVICT: prime k distinct keys (FULL / at capacity), then a walking NEW key each op
    // forces the eviction path (map backshift-delete + slot reassign + bucket-forest move) EVERY
    // op -- the important 0-B/op case.
    const ssE = new SpaceSaving(SSK, { seed: 0x9e3779b1 });
    for (let k = 0; k < SSK; k++) ssE.add(k);        // fill to capacity (steady-state FULL)
    // Push _total past 2^31 BEFORE measuring so `_total += count` runs against a DOUBLE field
    // during the window -- proves the running total does not box a HeapNumber per op (a per-op
    // box would show as > 0 B/op below). key 0 becomes a high counter, never the evicted min.
    ssE.add(0, 0xffffffff);
    ssE.add(0, 0xffffffff);
    let ssEKey = SSK, ssESink = 0;
    const ssEStep = () => {
        ssEKey++;                                    // a FRESH key each op -> forces eviction
        ssE.add(ssEKey);
        ssESink = (ssESink + ssE.size) | 0;          // observe (defeat DCE)
    };
    const ssERes = measureAllocs(ssEStep, { iterations: 100000, batches: 8 });
    const ssEBpc = ssERes.bytesPerCall === null ? 0 : ssERes.bytesPerCall;
    const ssEBytes = Math.max(0, Math.round(ssEBpc));
    const ssEOk = ssEBytes === 0;

    // ss.add BUMP: re-add already-monitored keys (present -> pure bucket-forest bump, no evict).
    const ssB = new SpaceSaving(SSK, { seed: 0x1234 });
    for (let k = 0; k < SSK; k++) ssB.add(k);        // fill to capacity; every key is monitored
    ssB.add(0, 0xffffffff);                          // push _total past 2^31 (see above)
    ssB.add(0, 0xffffffff);
    let ssBi = 0, ssBSink = 0;
    const ssBStep = () => {
        ssBi++; if (ssBi >= SSK) ssBi = 0;           // rotate over the monitored keys
        ssB.add(ssBi);                               // present -> bump, no eviction
        ssBSink = (ssBSink + ssB.size) | 0;          // observe (defeat DCE)
    };
    const ssBRes = measureAllocs(ssBStep, { iterations: 100000, batches: 8 });
    const ssBBpc = ssBRes.bytesPerCall === null ? 0 : ssBRes.bytesPerCall;
    const ssBBytes = Math.max(0, Math.round(ssBBpc));
    const ssBOk = ssBBytes === 0;

    // ---- phase 2b: GC budget over a long hot run ----
    const gc = new GcProfiler().start();
    const HOT = 2000000;
    let SINK = 0;
    for (let i = 0; i < HOT; i++) { addStep(); ccStep(); ceStep(); ddStep(); ssEStep(); ssBStep(); }   // HLL + CMS + DD + SpaceSaving hot ops
    SINK += addSink + ahSink + ccSink + cpSink + chSink + ceSink + ddSink + ssESink + ssBSink;
    await sleep(50);
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });

    // ---- phase 2c: arrayBuffers growth (the reused banks grow no store, HLL + CMS) ----
    const abBefore = process.memoryUsage().arrayBuffers;
    const reuse = new HyperLogLog(14, 0x1234);
    const cmsReuse = new CountMinSketch(6, 1 << 13, { seed: 0x1234 });
    const ddReuse = new DDSketch(0.01);
    const ssReuse = new SpaceSaving(1024, { seed: 0x1234 });
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
        for (let k = 0; k < 8192; k++) ssReuse.add(((k * 2654435761) ^ c) | 0);   // fill past capacity -> evictions
        ssReuse.estimate(c);
        ssReuse.clear();             // O(M) occ fill + O(k) free-list, no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- phase 2d: per-method SCAVENGE lane (N6) --------------------------------
    // measureAllocs (phase 2a) reports net bytes/op and CANNOT see TRANSIENT young-gen
    // churn (the lite-hud M1 finding); the perf gate discloses a maxScavenges floor as a
    // V8 uint32-lane-boxing artifact. This lane makes that floor VISIBLE and GATED per
    // method: force a full GC, then count minor GCs (scavenges) over a hot loop.
    //
    // Result (isolated + written reasons, measured stable over SCAV_HOT=2e6):
    //   * The SIX int32-clean lanes -- CMS add cons/plain, CMS estimate, DD add, SS evict,
    //     SS bump -- are driven to EXACTLY 0 scavenges: their hot bodies keep every hash
    //     word an int32 SMI (base = (h ^ g) | 0), so nothing boxes.
    //   * THREE lanes carry a small, pinned floor from a uint32 >= 2^31 boxed double:
    //       - HyperLogLog add / addHashed: the register-suffix `hiSuf = (h << p) >>> 0` is a
    //         uint32 local that is >= 2^31 about half the time -> a transient HeapNumber that
    //         nets to 0 B/op (phase 2a) and never reaches old gen. This is IN the byte-identical
    //         hot body (widening it would be a feature), so the floor is pinned, not removed.
    //       - CountMinSketch addHashed: the caller passes uint32 lanes (hi/lo >= 2^31) as args,
    //         boxed at the call boundary -- the disclosed caller-side artifact.
    //     Floor 48 is ~3x the measured ~15 (HLL) / ~7 (CMS addHashed) over 2e6, well under the
    //     perf gate's disclosed 64, and astronomically under a real per-op allocator (the
    //     perf gate's mustFail control shows thousands). A regression trips this immediately.
    const SCAV_HOT = 2000000;
    const SCAV_CLEAN = 0;    // int32-clean lanes: exactly 0 (transient churn isolated away)
    const SCAV_BOX = 48;     // uint32 >= 2^31 boxed-double lanes: pinned floor (see above)
    async function scavLane(step) {
        for (let i = 0; i < 50000; i++) step();       // JIT warm
        globalThis.gc(); await sleep(30);
        const g2 = new GcProfiler().start();
        for (let i = 0; i < SCAV_HOT; i++) step();
        await sleep(50);
        const s2 = g2.summary(); g2.stop();
        return s2.gc.minor | 0;
    }
    const scAdd = await scavLane(addStep);
    const scAh = await scavLane(ahStep);
    const scCc = await scavLane(ccStep);
    const scCp = await scavLane(cpStep);
    const scCh = await scavLane(chStep);
    const scCe = await scavLane(ceStep);
    const scDd = await scavLane(ddStep);
    const scSsE = await scavLane(ssEStep);
    const scSsB = await scavLane(ssBStep);

    // ---- N7: FRACTIONAL-input lane -- DDSketch.addFrom(buf, i) vs add(value) ------
    // WHY addFrom exists: a FRACTIONAL double passed as an ARGUMENT to add(value) is boxed
    // (~16 B HeapNumber) at a NON-INLINED call boundary; addFrom reads it UNBOXED from a
    // Float64Array. This lane feeds genuinely fractional values (v + 0.5) and GATES that
    // addFrom stays at the clean floor (0). It also prints add(value) for visibility.
    // HONEST LIMIT: in this ISOLATED tight loop V8 INLINES dd.add(x), so the argument box
    // does NOT reproduce here (measured add=~0..1, addFrom=0) -- the box only manifests at a
    // real non-inlined CONSUMER boundary (the lite-hud M2 review measured add=43 vs a 24
    // baseline, addFrom=24). So the "add(value) MUST show the box" teeth-control lives in
    // lite-hud M2's gate (its real write() boundary), per LiteHud/ROADMAP section 6.1; here we
    // gate only the delta-0 half we can honestly reproduce: addFrom on fractional input = 0.
    const ddFrac = new DDSketch(0.01);
    for (let k = 1; k <= 100000; k++) ddFrac.add(k);   // warm the window
    const ddFracBuf = new Float64Array(1);
    let ddFracV = 0, ddFracSink = 0;
    const ddFracFromStep = () => {
        ddFracV++; if (ddFracV > 99999) ddFracV = 1;
        ddFracBuf[0] = ddFracV + 0.5;                  // a genuine fractional double
        ddFrac.addFrom(ddFracBuf, 0);
        ddFracSink = (ddFracSink + ddFrac._maxKeyPop) | 0;
    };
    const ddFracAddStep = () => {
        ddFracV++; if (ddFracV > 99999) ddFracV = 1;
        ddFrac.add(ddFracV + 0.5);                     // same fractional value, as an argument
        ddFracSink = (ddFracSink + ddFrac._maxKeyPop) | 0;
    };
    const scDdFrom = await scavLane(ddFracFromStep);
    const scDdAdd = await scavLane(ddFracAddStep);
    SINK = (SINK + ddFracSink) | 0;

    const scavOk =
        scAdd <= SCAV_BOX && scAh <= SCAV_BOX && scCh <= SCAV_BOX &&
        scCc <= SCAV_CLEAN && scCp <= SCAV_CLEAN && scCe <= SCAV_CLEAN &&
        scDd <= SCAV_CLEAN && scSsE <= SCAV_CLEAN && scSsB <= SCAV_CLEAN &&
        scDdFrom <= SCAV_CLEAN;   // N7: addFrom on FRACTIONAL input stays at the clean floor (the delta-0 proof)

    // ---- verdict + GATE line ----
    const cmsAllocOk = ccOk && cpOk && chOk && ceOk;
    const ssAllocOk = ssEOk && ssBOk;
    const ok = trackedOk && live === 0 && findings.length === 0 &&
        cmsTrackedOk && cmsLive === 0 && cmsFindings.length === 0 &&
        ddTrackedOk && ddLive === 0 && ddFindings.length === 0 &&
        ssTrackedOk && ssLive === 0 && ssFindings.length === 0 &&
        addOk && ahOk && cmsAllocOk && ddOk && ssAllocOk && report.ok && abOk && scavOk;
    const gateLive = live + cmsLive + ddLive + ssLive;
    const gateFindings = findings.length + cmsFindings.length + ddFindings.length + ssFindings.length;
    console.log(
        'GATE leak=size ' + gateLive + '/0 findings=' + gateFindings +
        ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) +
        ' | alloc=' + addBytes + ' B/op (HyperLogLog add) ' + ahBytes + ' B/op (HyperLogLog addHashed) ' +
        ccBytes + ' B/op (CountMinSketch add cons) ' + cpBytes + ' B/op (CountMinSketch add plain) ' +
        chBytes + ' B/op (CountMinSketch addHashed) ' + ceBytes + ' B/op (CountMinSketch estimate) ' +
        ddBytes + ' B/op (DDSketch add) ' +
        ssEBytes + ' B/op (SpaceSaving add evict) ' + ssBBytes + ' B/op (SpaceSaving add bump)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + '/' + cmsTrackedMid + '/' + ddTrackedMid + '/' + ssTrackedMid +
        ' sink=' + SINK + ' abGrowth=' + abDelta + ')');
    console.log(
        'SCAV/2e6 (minor GCs per hot method; clean floor=' + SCAV_CLEAN + ' box floor=' + SCAV_BOX + '): ' +
        'HLL add=' + scAdd + ' HLL addHashed=' + scAh + ' | ' +
        'CMS add cons=' + scCc + ' plain=' + scCp + ' addHashed=' + scCh + ' estimate=' + scCe + ' | ' +
        'DD add=' + scDd + ' | SS evict=' + scSsE + ' bump=' + scSsB +
        ' | ' + (scavOk ? 'ok' : 'FAIL'));
    console.log(
        'N7 DDSketch fractional lane (add(value) boxes at a non-inlined boundary; addFrom reads unboxed): ' +
        'addFrom=' + scDdFrom + ' (gated <=' + SCAV_CLEAN + ') add(value)=' + scDdAdd +
        ' (isolated -- V8 inlines it; the box teeth-control is lite-hud M2\'s at its real write() boundary)');

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: HLL tracker held ' + trackedMid + ' (expected > 0)');
        if (!cmsTrackedOk) console.error('  vacuous: CMS tracker held ' + cmsTrackedMid + ' (expected > 0)');
        if (!ddTrackedOk) console.error('  vacuous: DD tracker held ' + ddTrackedMid + ' (expected > 0)');
        if (!ssTrackedOk) console.error('  vacuous: SS tracker held ' + ssTrackedMid + ' (expected > 0)');
        if (live !== 0) console.error('  retain: ' + live + ' HyperLogLog instances survived');
        if (cmsLive !== 0) console.error('  retain: ' + cmsLive + ' CountMinSketch instances survived');
        if (ddLive !== 0) console.error('  retain: ' + ddLive + ' DDSketch instances survived');
        if (ssLive !== 0) console.error('  retain: ' + ssLive + ' SpaceSaving instances survived');
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        for (const f of cmsFindings) console.error('  cms finding ' + f.kind + ':' + f.reason);
        for (const f of ddFindings) console.error('  dd finding ' + f.kind + ':' + f.reason);
        for (const f of ssFindings) console.error('  ss finding ' + f.kind + ':' + f.reason);
        if (!addOk) console.error('  alloc ' + addBytes + ' B/op HyperLogLog add (raw ' + addBpc + ')');
        if (!ahOk) console.error('  alloc ' + ahBytes + ' B/op HyperLogLog addHashed (raw ' + ahBpc + ')');
        if (!ccOk) console.error('  alloc ' + ccBytes + ' B/op CountMinSketch add cons (raw ' + ccBpc + ')');
        if (!cpOk) console.error('  alloc ' + cpBytes + ' B/op CountMinSketch add plain (raw ' + cpBpc + ')');
        if (!chOk) console.error('  alloc ' + chBytes + ' B/op CountMinSketch addHashed (raw ' + chBpc + ')');
        if (!ceOk) console.error('  alloc ' + ceBytes + ' B/op CountMinSketch estimate (raw ' + ceBpc + ')');
        if (!ddOk) console.error('  alloc ' + ddBytes + ' B/op DDSketch add (raw ' + ddBpc + ')');
        if (!ssEOk) console.error('  alloc ' + ssEBytes + ' B/op SpaceSaving add evict (raw ' + ssEBpc + ')');
        if (!ssBOk) console.error('  alloc ' + ssBBytes + ' B/op SpaceSaving add bump (raw ' + ssBBpc + ')');
        if (!report.ok) console.error('  gc ' + JSON.stringify(report.violations));
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        if (!scavOk) console.error('  scavenge floor exceeded (clean<=' + SCAV_CLEAN + ' box<=' + SCAV_BOX +
            '): HLL add=' + scAdd + ' addHashed=' + scAh + ' CMS cons=' + scCc + ' plain=' + scCp +
            ' addHashed=' + scCh + ' estimate=' + scCe + ' DD=' + scDd + ' SS evict=' + scSsE + ' bump=' + scSsB);
        process.exitCode = 1;
    }
}

main();
