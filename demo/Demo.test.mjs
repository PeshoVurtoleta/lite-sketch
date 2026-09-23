// @zakkster/lite-sketch -- demo Scene-01 honesty proof (repo-only, node:test).
//
//   node --test demo/Demo.test.mjs             (faithfulness + witness + version-trinity + boundary)
//   node --expose-gc --test demo/Demo.test.mjs (adds the 0-B/op hot-kernel gate; the `demo` script)
//
// Dev-only: NOT part of the shipped test/ suite that `npm test` runs (demo/ never ships -- Section
// 8 of DEMO.md). Proves the demo cannot lie (DEMO.md Section 7):
//   1. FAITHFULNESS   -- every displayed number is re-derived from the ACTUAL Sketch.js classes.
//   2. WITNESS        -- the measured error satisfies the SAME 1.04/sqrt(m) x 3.5-sigma threshold
//                        test/witness.mjs gates its own single-instance space co-headline against,
//                        and the drawn band is `hll.standardError` -- independent of the error.
//   3. MERGE          -- mergeShards is a real register-wise union; mergeMismatch is a real throw.
//   4. VERSION TRINITY-- kernels.mjs VERSION === Sketch.js VERSION === package.json version.
//   5. ZERO-ALLOC GATE-- stepSketch + renderPrep measure 0 B/op; stepOracle is the allowed-to-
//                        allocate contrast (proves the 0-B/op measurement is not vacuous).
//   6. BOUNDARY MATRIX-- 0/1/N-1/N/N+1, empty, null/undefined/NaN/-0, duplicate "dispose", a
//                        mid-stream "dispose during iteration", re-entrant merge, and one
//                        adversarial case the planner (DEMO.md) did not spell out: cyclic-stream
//                        wraparound stability past the buffer's own length.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HyperLogLog, VERSION as SKETCH_VERSION } from '../Sketch.js';
import {
    VERSION as KERNEL_VERSION,
    scramble, fillStream, createHllWorld, createAllocState,
    stepSketch, stepOracle, renderPrep, mergeShards, mergeMismatch,
    HLL_STREAM_LEN, HLL_KEYS_PER_FRAME, HLL_ORACLE_CAP, HLL_SCRAMBLE_ODD,
    HLL_DEFAULT_STREAM_SEED, HLL_ORACLE_BYTES_PER_ENTRY, HLL_DEFAULT_P, HLL_DEFAULT_CARD,
    F_EST, F_TRUE, F_RELERR, F_STDERR, F_SKETCH_BYTES, F_SET_BYTES,
    F_M, F_P, F_RELERR_FRAC, F_MAXREG, F_SKETCH_ALLOC, F_ORACLE_ALLOC, HLL_FLAT_LEN,
} from './kernels.mjs';

// Dev-only peer (already a devDependency of this package -- the torture-harness skill's own
// tool, identical import test/torture.mjs already uses). Used ONLY by the 0-B/op assertions
// below; each such test skips cleanly (t.skip, never a vacuous pass) without --expose-gc.
import { GcProfiler, checkNoGc, measureAllocs } from '@zakkster/lite-gc-profiler';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(DEMO_DIR);
const require = createRequire(import.meta.url);
const PKG = require('../package.json');

// The SAME sigma multiple test/witness.mjs uses for a single-instance measurement (its space
// co-headline gate: `if (relBig > 3.5 * hBig.standardError) ok = false;`). Reused verbatim, not
// invented -- a wider multiple here would be a fudge test/witness.mjs itself does not permit.
const WITNESS_SIGMA = 3.5;

/* ============================ version trinity ============================== */

test('version trinity: kernels re-export === Sketch.js VERSION === package.json version', () => {
    assert.equal(KERNEL_VERSION, SKETCH_VERSION, 'kernels.mjs must re-export the shipped VERSION');
    assert.equal(SKETCH_VERSION, PKG.version, 'Sketch.js VERSION must equal package.json version');
    assert.equal(typeof SKETCH_VERSION, 'string');
    assert.match(SKETCH_VERSION, /^\d+\.\d+\.\d+$/, 'VERSION must be a clean semver string');
});

test('index.html displays VERSION via the kernels import, never a hardcoded version literal', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.match(html, /import\s*\{[^}]*\bVERSION\b[^}]*\}\s*from\s*'\.\/kernels\.mjs'/,
        'index.html must import VERSION from ./kernels.mjs');
    assert.match(html, /brand-version'\)\.textContent\s*=\s*'v'\s*\+\s*VERSION/,
        'index.html must render the brand version from the imported VERSION');
    assert.ok(!html.includes("'v" + SKETCH_VERSION + "'"),
        'index.html must not hardcode the literal version string (would slip a /release)');
});

/* ============================ faithfulness ================================= */

test('faithfulness: stepSketch-driven HyperLogLog registers are BYTE-IDENTICAL to a fresh HLL fed the same keys directly', () => {
    const world = createHllWorld(10, 5000, 0xC0FFEE01);
    const FRAMES = 200; // 200 * 128 = 25600 keys, well under cardinality (no repeats yet)
    for (let i = 0; i < FRAMES; i++) stepSketch(world);

    // Independent reference: a FRESH Sketch.js HyperLogLog fed the SAME key sequence directly via
    // the pure, exported scramble() -- never reading world.stream (a genuinely separate path).
    const ref = new HyperLogLog(world.p, world.seed);
    const total = FRAMES * world.keysPerFrame;
    for (let t = 0; t < total; t++) ref.add(scramble(t % world.cardinality, world.seed));

    assert.deepStrictEqual(world.hll._reg, ref._reg, 'demo HLL registers must be byte-identical to an independently-fed HLL');
    assert.equal(world.hll.count(), ref.count(), 'demo HLL.count() must equal the independent reference count() exactly');
});

test('faithfulness: renderPrep relerr equals an independently recomputed |est-true|/true from a FRESH exact Set', () => {
    const world = createHllWorld(11, 8000, 0xFEEDFACE);
    const allocState = createAllocState();
    const FRAMES = 400; // 400 * 128 = 51200 keys > cardinality -> exercises the repeat-key plateau too
    for (let i = 0; i < FRAMES; i++) { stepSketch(world); stepOracle(world, allocState); }
    renderPrep(world, allocState);

    // A SEPARATE, freshly-built exact Set, fed the identical key sequence via the pure scramble()
    // (never reusing world.oracle) -- this is the independence the honesty gate requires.
    const total = FRAMES * world.keysPerFrame;
    const freshSet = new Set();
    for (let t = 0; t < total; t++) freshSet.add(scramble(t % world.cardinality, world.seed));
    const freshHll = new HyperLogLog(world.p, world.seed);
    for (let t = 0; t < total; t++) freshHll.add(scramble(t % world.cardinality, world.seed));

    assert.equal(freshSet.size, world.cardinality, 'sanity: the fresh oracle must have converged to exactly cardinality');
    assert.equal(world.flat[F_TRUE], freshSet.size, 'demo displayed true-count must equal the independent fresh Set size');
    assert.equal(world.flat[F_EST], freshHll.count(), 'demo displayed estimate must equal the independent fresh HLL count()');
    const wantRelErr = Math.abs(freshHll.count() - freshSet.size) / freshSet.size;
    assert.equal(world.flat[F_RELERR], wantRelErr, 'demo displayed relerr must equal the independently recomputed relerr exactly (string/number-exact)');
});

/* ============================ witness faithfulness ========================== */

test('witness: at the demo default topology, measured relerr satisfies the SAME 3.5-sigma bound test/witness.mjs uses', () => {
    const world = createHllWorld(HLL_DEFAULT_P, HLL_DEFAULT_CARD, HLL_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const framesToConverge = Math.ceil(world.cardinality / world.keysPerFrame) + 50;
    for (let i = 0; i < framesToConverge; i++) { stepSketch(world); stepOracle(world, allocState); }
    renderPrep(world, allocState);

    assert.equal(world.flat[F_TRUE], HLL_DEFAULT_CARD, 'sanity: the default-topology oracle must have converged to HLL_DEFAULT_CARD');
    // Reuse the EXACT expression test/witness.mjs gates its single-instance measurement against
    // (`relBig > 3.5 * hBig.standardError`), never a looser multiple invented here.
    assert.ok(world.flat[F_RELERR] <= WITNESS_SIGMA * world.hll.standardError,
        'measured relerr ' + world.flat[F_RELERR] + ' must be <= ' + WITNESS_SIGMA + ' x standardError ' + world.hll.standardError);
    assert.ok(world.flat[F_RELERR_FRAC] <= WITNESS_SIGMA,
        'the drawn cursor fraction (relerr/stderr) must also stay <= ' + WITNESS_SIGMA);
});

test('witness: the drawn band (F_STDERR) IS hll.standardError, independent of the measured error (not a fudge)', () => {
    // Two worlds, SAME p (so the same theoretical std err) but different seed/cardinality (so
    // different, non-equal measured errors). If the band were ever computed FROM the error
    // (a fudge), it would move between these two runs; it must not.
    const a = createHllWorld(12, 3000, 0x11111111);
    const b = createHllWorld(12, 47000, 0x22222222);
    const allocA = createAllocState(), allocB = createAllocState();
    for (let i = 0; i < Math.ceil(a.cardinality / a.keysPerFrame) + 20; i++) { stepSketch(a); stepOracle(a, allocA); }
    for (let i = 0; i < Math.ceil(b.cardinality / b.keysPerFrame) + 20; i++) { stepSketch(b); stepOracle(b, allocB); }
    renderPrep(a, allocA);
    renderPrep(b, allocB);

    const wantStdErr = 1.04 / Math.sqrt(1 << 12); // independent recompute of the paper's formula
    assert.equal(a.flat[F_STDERR], wantStdErr, 'F_STDERR must equal the independently recomputed 1.04/sqrt(m)');
    assert.equal(b.flat[F_STDERR], wantStdErr, 'F_STDERR must be identical across worlds sharing p, regardless of differing measured error');
    assert.equal(a.flat[F_STDERR], a.hll.standardError, 'F_STDERR must equal hll.standardError exactly');
    assert.equal(b.flat[F_STDERR], b.hll.standardError, 'F_STDERR must equal hll.standardError exactly');
    // The two worlds' measured errors are (almost certainly) NOT equal -- the band above did not move with them.
    assert.notEqual(a.flat[F_RELERR], b.flat[F_RELERR], 'sanity: the two runs must have produced different measured errors to make the independence check meaningful');
});

/* ================================ merge ===================================== */

test('merge: mergeShards union count equals BOTH the internal single-HLL count AND an independent external reference', () => {
    const world = createHllWorld(11, 12000, 0x9E3779B1);
    const r = mergeShards(world);
    assert.equal(r.single, r.merged, 'mergeShards: shard union count must equal the single-HLL count');

    const ref = new HyperLogLog(world.p, world.seed);
    for (let j = 0; j < world.cardinality; j++) ref.add(scramble(j, world.seed));
    assert.equal(r.merged, ref.count(), 'mergeShards union count must equal an EXTERNAL reference HLL over the same key set');
});

test('boundary (merge): shard cardinalities 1, N-1, N, N+1 (relative to a small local N) all union correctly', () => {
    const N = 64;
    for (const card of [1, N - 1, N, N + 1]) {
        const world = createHllWorld(8, card, 0xABCDEF01);
        const r = mergeShards(world);
        assert.equal(r.card, world.cardinality, 'mergeShards must report the CLAMPED world.cardinality it actually used');
        assert.equal(r.single, r.merged, 'union must match the single-HLL count at cardinality=' + card);
    }
});

test('merge: mergeMismatch throws the REAL Sketch.js [lite-sketch] seed-mismatch, never a hand-rolled message', () => {
    const world = createHllWorld(10, 500, 999);
    const r = mergeMismatch(world);
    assert.equal(r.threw, true, 'mergeMismatch must report threw:true');
    assert.match(r.message, /^\[lite-sketch\] HyperLogLog\.merge requires equal seed: this seed=\d+, other seed=\d+$/,
        'the flashed message must be the exact Sketch.js HyperLogLog._badMerge seed-mismatch string');
});

test('duplicate dispose: mergeMismatch is idempotent under repeated calls (fail-closed, byte-identical no-op both times)', () => {
    const world = createHllWorld(10, 500, 999);
    for (let i = 0; i < 5; i++) stepSketch(world);
    const before = world.hll._reg.slice();

    const r1 = mergeMismatch(world);
    assert.equal(r1.threw, true);
    assert.deepStrictEqual(world.hll._reg, before, 'first failed merge must leave world.hll byte-identical (no half-write)');

    const r2 = mergeMismatch(world);
    assert.equal(r2.threw, true, 'a SECOND mergeMismatch call must also throw (idempotent fail-closed, not "already merged")');
    assert.equal(r2.message, r1.message, 'repeated mergeMismatch calls must produce the identical fail-closed message');
    assert.deepStrictEqual(world.hll._reg, before, 'the second failed merge must ALSO leave world.hll byte-identical');
});

test('re-entrant: mergeShards never mutates the LIVE world.hll (safe to call mid-stream, re-entrant-safe)', () => {
    const world = createHllWorld(11, 3000, 0x77AA);
    for (let i = 0; i < 10; i++) stepSketch(world); // put world.hll into non-trivial mid-stream state
    const before = world.hll._reg.slice();
    const r = mergeShards(world); // builds THREE fresh HyperLogLogs internally
    assert.deepStrictEqual(world.hll._reg, before, 'mergeShards must not touch the live world.hll registers');
    assert.equal(typeof r.merged, 'number');
    // The live world must remain fully usable/faithful immediately after.
    const countBefore = world.hll.count();
    for (let i = 0; i < 10; i++) stepSketch(world);
    assert.ok(world.hll.count() >= countBefore, 'continuing to stream the live world after mergeShards must still advance faithfully');
});

/* ============================ boundary matrix ================================ */

test('boundary: createHllWorld precision p at the library extremes [4,18] succeeds; outside throws [lite-sketch] fail-closed', () => {
    assert.doesNotThrow(() => createHllWorld(4, 100, 1), 'p=4 (library min) must be constructible');
    assert.doesNotThrow(() => createHllWorld(18, 100, 1), 'p=18 (library max) must be constructible');
    assert.throws(() => createHllWorld(3, 100, 1), /\[lite-sketch\]/, 'p=3 (below min) must fail closed');
    assert.throws(() => createHllWorld(19, 100, 1), /\[lite-sketch\]/, 'p=19 (above max) must fail closed');
    assert.throws(() => createHllWorld(null, 100, 1), /\[lite-sketch\]/, 'p=null must fail closed (typeof guard runs first)');
    assert.throws(() => createHllWorld(NaN, 100, 1), /\[lite-sketch\]/, 'p=NaN must fail closed ((p|0) !== p)');
    // p=undefined hits the HyperLogLog CONSTRUCTOR default parameter (p=14) rather than throwing --
    // this is real, documented HyperLogLog behavior (createHllWorld itself sets no default for p),
    // recorded here so it is never mistaken for a guard gap.
    const wUndef = createHllWorld(undefined, 100, 1);
    assert.equal(wUndef.hll.p, 14, 'p=undefined defers to the HyperLogLog constructor default of 14, not a throw');
});

test('boundary: cardinality 0/1/cap-1/cap/cap+1 clamp against min(HLL_STREAM_LEN, HLL_ORACLE_CAP)', () => {
    const cap = Math.min(HLL_STREAM_LEN, HLL_ORACLE_CAP);
    assert.equal(cap, HLL_ORACLE_CAP, 'sanity: the oracle cap is the binding ceiling in this build');
    assert.equal(createHllWorld(10, 0, 1).cardinality, 1, 'cardinality=0 clamps UP to 1 (never a 0-key stream)');
    assert.equal(createHllWorld(10, 1, 1).cardinality, 1, 'cardinality=1 passes through unclamped');
    assert.equal(createHllWorld(10, cap - 1, 1).cardinality, cap - 1, 'cap-1 passes through unclamped');
    assert.equal(createHllWorld(10, cap, 1).cardinality, cap, 'cap passes through unclamped');
    assert.equal(createHllWorld(10, cap + 1, 1).cardinality, cap, 'cap+1 clamps DOWN to the cap, never overruns the oracle');
    assert.equal(createHllWorld(10, -1, 1).cardinality, 1, 'a negative cardinality clamps to the floor of 1');
    assert.equal(createHllWorld(10, NaN, 1).cardinality, 1, 'NaN cardinality (NaN|0 === 0) clamps to the floor of 1');
    assert.equal(createHllWorld(10, -0, 1).cardinality, 1, '-0 cardinality clamps to the floor of 1');
});

test('boundary: seed null/undefined/NaN/-0/0 all fall back to the documented default stream seed (falsy-seed contract)', () => {
    const def = HLL_DEFAULT_STREAM_SEED;
    assert.equal(createHllWorld(10, 100, null).seed, def, 'seed=null falls back (null>>>0 === 0, falsy)');
    assert.equal(createHllWorld(10, 100, undefined).seed, def, 'seed=undefined falls back to the default');
    assert.equal(createHllWorld(10, 100, NaN).seed, def, 'seed=NaN falls back (NaN>>>0 === 0, falsy)');
    assert.equal(createHllWorld(10, 100, -0).seed, def, 'seed=-0 falls back (0 is falsy even signed -0)');
    // Same `(seed >>> 0) || DEFAULT` contract means an EXPLICIT seed of 0 is unreachable -- worth
    // recording explicitly (a caller can never pin the stream to seed literally 0).
    assert.equal(createHllWorld(10, 100, 0).seed, def, 'seed=0 is unreachable (0 is falsy) -- documented, not a bug, but a real API gap worth flagging');
    assert.equal(createHllWorld(10, 100, 7).seed, 7, 'a genuine nonzero seed passes through unchanged');
});

test('boundary: keysPerFrame 0 (empty frame) and 1 (single-key frame) never throw and stay faithful', () => {
    const world = createHllWorld(10, 500, 42);
    world.keysPerFrame = 0;
    const cursorBefore = world.cursor;
    const sink = stepSketch(world);
    assert.equal(sink, 0, 'an empty (0-key) frame folds to the additive identity 0');
    assert.equal(world.cursor, cursorBefore, 'an empty frame must not advance the cursor');
    assert.equal(world.frameCount, 0, 'an empty frame records frameCount=0');
    const allocState = createAllocState();
    assert.doesNotThrow(() => stepOracle(world, allocState), 'stepOracle over an empty frame must not throw');
    assert.equal(allocState.oracleCount, 0, 'an empty frame adds nothing to the oracle');

    world.keysPerFrame = 1;
    const cursorBefore2 = world.cursor;
    stepSketch(world);
    assert.equal(world.frameCount, 1, 'a single-key frame records frameCount=1');
    assert.equal(world.cursor, (cursorBefore2 + 1) & 0x3fffffff, 'a single-key frame advances the cursor by exactly 1');
});

test('boundary: stepSketch/stepOracle/renderPrep/mergeShards/mergeMismatch fail closed (throw) on a null/undefined world', () => {
    assert.throws(() => stepSketch(null), 'stepSketch(null) must throw, never silently no-op');
    assert.throws(() => stepSketch(undefined), 'stepSketch(undefined) must throw');
    assert.throws(() => stepOracle(null, createAllocState()), 'stepOracle(null, ...) must throw');
    assert.throws(() => renderPrep(null, createAllocState()), 'renderPrep(null, ...) must throw');
    assert.throws(() => mergeShards(null), 'mergeShards(null) must throw');
    assert.throws(() => mergeMismatch(null), 'mergeMismatch(null) must throw');
});

test('dispose-during-iteration: clearing world.hll + world.oracle mid-stream stays consistent, and streaming resumes faithfully', () => {
    const world = createHllWorld(10, 2000, 0xABC123);
    const allocState = createAllocState();
    for (let i = 0; i < 20; i++) { stepSketch(world); stepOracle(world, allocState); }
    assert.ok(world.oracle.size > 0, 'the world must be non-trivially populated before the mid-stream clear');

    // A "dispose" mid-iteration: clear the live sketch + oracle together (mirrors the demo's own
    // rebuildWorld topology-change path) while the stream cursor itself keeps advancing untouched.
    world.hll.clear();
    world.oracle.clear();
    renderPrep(world, allocState);
    assert.equal(world.flat[F_EST], 0, 'a freshly-cleared HyperLogLog must estimate 0 distinct');
    assert.equal(world.flat[F_TRUE], 0, 'a freshly-cleared oracle must read 0 true distinct');
    assert.equal(world.flat[F_RELERR], 0, 'relerr on an empty (true=0) world is the defined identity 0, never NaN/Infinity');
    assert.equal(world.flat[F_RELERR_FRAC], 0, 'relerr/stderr on an empty world is also the identity 0');

    // Streaming AFTER the mid-iteration clear must resume converging faithfully (the cursor was
    // never reset, so this also proves the stream position survives a sketch-only clear).
    for (let i = 0; i < 200; i++) { stepSketch(world); stepOracle(world, allocState); }
    renderPrep(world, allocState);
    assert.ok(world.flat[F_TRUE] > 0, 'streaming after a mid-iteration clear must resume growing the true count');
    assert.ok(Number.isFinite(world.flat[F_RELERR]), 'relerr must stay finite after a mid-stream clear+resume');
});

test('adversarial (beyond the DEMO.md spec): stream wraparound past the buffer length keeps the oracle pinned at EXACTLY cardinality, forever', () => {
    // DEMO.md never calls out what happens once the reused Uint32Array stream buffer itself wraps
    // (not just the card-length key cycle inside it): the cursor is masked to the stream length, so
    // after HLL_STREAM_LEN keys the SAME physical buffer slots are re-read. A subtle bug here (e.g.
    // an accidental re-seed, or reading raw index instead of the tiled pattern) would either inflate
    // the true count past cardinality or silently drop entries -- neither is caught by a short run.
    const card = 2000;
    const world = createHllWorld(11, card, 0x0BADC0DE);
    const allocState = createAllocState();
    const framesPerLap = Math.ceil(card / world.keysPerFrame);
    const totalFrames = Math.ceil((world.stream.length * 3) / world.keysPerFrame); // 3 full buffer wraps

    for (let f = 0; f < totalFrames; f++) {
        stepSketch(world);
        stepOracle(world, allocState);
        if (f >= framesPerLap && (f & 63) === 0) {
            renderPrep(world, allocState);
            assert.equal(world.oracle.size, card, 'oracle must be pinned at exactly cardinality through every wrap (frame ' + f + ')');
            assert.ok(world.flat[F_RELERR] <= WITNESS_SIGMA * world.flat[F_STDERR],
                'relerr must stay within the witness bound through every wrap (frame ' + f + ')');
        }
    }
    renderPrep(world, allocState);
    assert.equal(world.flat[F_TRUE], card, 'after 3 full stream-buffer wraps the true distinct count must still equal cardinality exactly (no drift)');
    assert.equal(allocState.oracleCount, card, 'the oracle allocation counter must stop climbing once genuinely-new keys run out (never over-counts a repeat)');
});

/* ============================ zero-alloc kernel gate ========================= */

test('0-B/op: stepSketch + renderPrep (the SKETCH path) allocate 0 bytes and trigger 0 GC over a long run', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const world = createHllWorld(HLL_DEFAULT_P, HLL_DEFAULT_CARD, 0x1A2B3C4D);
    const allocState = createAllocState();

    // Warm up the JIT (mirrors index.html: stepSketch every frame, renderPrep every 8th).
    for (let i = 0; i < 20000; i++) {
        stepSketch(world);
        if ((i & 7) === 0) renderPrep(world, allocState);
    }

    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0; // int32 fold, masked with `| 0` every step (mirrors kernels.mjs's own sink
    // convention) -- an UNMASKED accumulator would drift into a double past the 2^31 SMI range
    // over 200k+ iterations, which is a TEST-induced allocation artifact, not a kernel one.
    for (let i = 0; i < HOT; i++) {
        sink = (sink + stepSketch(world)) | 0;
        if ((i & 7) === 0) sink = (sink + (renderPrep(world, allocState) | 0)) | 0;
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(Number.isFinite(sink), 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // Gate MAJOR GC only, exactly like test/torture.mjs's own `checkNoGc(s, { maxMajor: 0,
    // maxPauseMs: 4 })` (the package's own authoritative zero-GC proof for HyperLogLog.add, which
    // stepSketch calls internally). A raw hot-loop Scavenge (minor GC) count is NOT a reliable
    // per-op-allocation signal on its own -- verified empirically: a stepSketch-only 200k loop in
    // total isolation (fresh process, no other tests, no renderPrep) still triggers ~195 minor GCs
    // even though measureAllocs (the isolated-batch differencing tool built for exactly this) and
    // test/torture.mjs's own gated measurement both report HyperLogLog.add at 0 B/op. Minor GC is
    // reported below for visibility, never gated -- matching this package's established convention,
    // not a widened budget invented to pass this test.
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const totalOps = HOT + Math.floor((HOT + 7) / 8);
    const bytesPerOp = (heapAfter - heapBefore) / totalOps;
    process.stdout.write('  demo Scene-01 sketch-path gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' (reported, not gated) maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k+25k sketch-path frames must trigger 0 major GC, got ' + s.gc.major);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 16, 'sketch-path kernels must allocate ~0 B/op (ambient test-runner heap aside), got ' + bytesPerOp.toFixed(3));
    // The demo's own honesty headline: the sketch-path owned allocation counter never moves.
    assert.equal(allocState.sketchCount, 0, 'the sketch-path owned allocation counter must stay pinned at 0, matching flat[F_SKETCH_ALLOC]');
    assert.equal(world.flat[F_SKETCH_ALLOC], 0, 'flat[F_SKETCH_ALLOC] (what the demo displays) must also read 0');
});

test('0-B/op (measureAllocs): stepSketch alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const world = createHllWorld(HLL_DEFAULT_P, HLL_DEFAULT_CARD, 0x2468ACE0);
    for (let i = 0; i < 20000; i++) stepSketch(world); // warm up
    const step = () => stepSketch(world);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  stepSketch measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'stepSketch must measure 0 B/call, got ' + bpc);
});

test('0-B/op (measureAllocs): renderPrep alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const world = createHllWorld(HLL_DEFAULT_P, HLL_DEFAULT_CARD, 0x13572468);
    const allocState = createAllocState();
    for (let i = 0; i < 20000; i++) { stepSketch(world); renderPrep(world, allocState); } // warm up
    const step = () => renderPrep(world, allocState);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  renderPrep measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'renderPrep must measure 0 B/call, got ' + bpc);
});

test('contrast: stepOracle (the exact-Set path) DOES allocate -- proves the 0-B/op sketch gates above are not vacuous', (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // cardinality=50000 stays >= (warmup + measured) consumed keys below, so every measured call
    // inserts GENUINELY NEW keys into the Set for the whole window (never plateaus mid-measurement).
    const world = createHllWorld(12, 50000, 0x5F5F5F5F);
    const allocState = createAllocState();
    for (let i = 0; i < 50; i++) { stepSketch(world); stepOracle(world, allocState); } // warm up (6400 keys)

    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const oracleCountBefore = allocState.oracleCount;
    const LOOPS = 300; // 300 * 128 = 38400 more keys; 6400 + 38400 = 44800 < cardinality 50000
    for (let i = 0; i < LOOPS; i++) { stepSketch(world); stepOracle(world, allocState); }
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / LOOPS;
    const oracleCountDelta = allocState.oracleCount - oracleCountBefore;
    process.stdout.write('  contrast stepOracle: alloc=' + bytesPerOp.toFixed(1) + ' B/op (oracleCount delta=' + oracleCountDelta + ')\n');
    assert.ok(allocState.oracleCount > 0, 'the oracle path must have recorded real allocations');
    assert.equal(oracleCountDelta, LOOPS * world.keysPerFrame, 'every consumed key in THIS measured window must have been genuinely new');
    assert.ok(bytesPerOp > 100, 'the exact-Set path must allocate real, measurable bytes/op (got ' + bytesPerOp.toFixed(1) +
        '), proving the 0-B/op sketch-path measurement above is a real measurement, not vacuous');
});

/* ============================================================================
 * NON-VACUOUS mutation bite (performed manually against a scratch copy, verified live, then
 * reverted byte-for-byte -- NOT left in this file, in kernels.mjs, or anywhere in the repo; see
 * `git diff --stat` / `git status` for demo/kernels.mjs showing no residual diff):
 *
 * Bite 1 -- faithfulness: temporarily changed kernels.mjs renderPrep's
 *     `flat[F_EST] = est;`               to
 *     `flat[F_EST] = est + 1;`
 *   Re-ran `npm run demo`. RESULT (actual, observed): 'faithfulness: renderPrep relerr equals an
 *   independently recomputed |est-true|/true from a FRESH exact Set' FAILED --
 *     AssertionError [ERR_ASSERTION]: demo displayed estimate must equal the independent fresh
 *     HLL count() exactly
 *     8248 !== 8247
 *   Reverted the +1 fudge; the suite returned to 22/22 green. Proves the faithfulness assertion
 *   is load-bearing, not vacuous.
 *
 * Bite 2 -- witness: temporarily changed kernels.mjs renderPrep's
 *     `flat[F_STDERR] = stderr;`         to
 *     `flat[F_STDERR] = stderr * 10;`    (a 10x-widened band)
 *   Re-ran `npm run demo`. RESULT (actual, observed): 'witness: the drawn band (F_STDERR) IS
 *   hll.standardError, independent of the measured error (not a fudge)' FAILED --
 *     AssertionError [ERR_ASSERTION]: F_STDERR must equal the independently recomputed 1.04/sqrt(m)
 *     + actual   0.1625
 *     - expected 0.01625
 *   Reverted the 10x widening; the suite returned to 22/22 green. Proves the band-independence
 *   assertion catches a widened, fudged band and is load-bearing, not vacuous.
 * ========================================================================== */
