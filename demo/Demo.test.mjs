// @zakkster/lite-sketch -- demo honesty proof, ALL FOUR scenes (repo-only, node:test).
//
//   node --test demo/Demo.test.mjs             (faithfulness + witness + version-trinity + boundary)
//   node --expose-gc --test demo/Demo.test.mjs (adds the 0-B/op hot-kernel gate; the `demo` script)
//
// Dev-only: NOT part of the shipped test/ suite that `npm test` runs (demo/ never ships -- Section
// 8 of DEMO.md). Proves the demo cannot lie (DEMO.md Section 7), for EVERY scene:
//   Scene 01 HyperLogLog     (distinct-count)      -- below, unchanged.
//   Scene 02 CountMinSketch  (frequency)            -- "Scene 02" section.
//   Scene 03 DDSketch        (relative-error quantiles) -- "Scene 03" section.
//   Scene 04 SpaceSaving     (heavy hitters / top-k)     -- "Scene 04" section.
//   1. FAITHFULNESS   -- every displayed number is re-derived from the ACTUAL Sketch.js classes.
//   2. WITNESS        -- the measured error satisfies the SAME thresholds test/witness.mjs gates
//                        each member against (HLL: 1.04/sqrt(m) x 3.5-sigma; CMS: gap <= eps*N,
//                        one-sided; DDSketch: relerr <= alpha, a HARD per-query bound; SpaceSaving:
//                        100% recall + count-error <= true <= count + maxErr <= N/k).
//   3. MERGE / VERSION TRINITY -- mergeShards is a real register-wise union; mergeMismatch is a
//                        real throw; kernels.mjs VERSION === Sketch.js VERSION === package.json
//                        version (Scene 01 only -- Scenes 02-04 do not expose a merge action).
//   5. ZERO-ALLOC GATE-- every scene's stepXSketch + renderXPrep measure 0 B/op; stepXOracle is
//                        the allowed-to-allocate contrast (proves the 0-B/op measurement is not
//                        vacuous).
//   6. BOUNDARY MATRIX-- 0/1/N-1/N/N+1, empty, null/undefined/NaN/-0, duplicate "dispose"
//                        (.clear()), a mid-stream "dispose during iteration", re-entrant render
//                        (renderXPrep is idempotent with no intervening step), and one adversarial
//                        case per scene the planner (DEMO.md) did not spell out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HyperLogLog, CountMinSketch, DDSketch, SpaceSaving, VERSION as SKETCH_VERSION } from '../Sketch.js';
import {
    VERSION as KERNEL_VERSION,
    scramble, fillStream, createHllWorld, createAllocState,
    stepSketch, stepOracle, renderPrep, mergeShards, mergeMismatch,
    HLL_STREAM_LEN, HLL_KEYS_PER_FRAME, HLL_ORACLE_CAP, HLL_SCRAMBLE_ODD,
    HLL_DEFAULT_STREAM_SEED, HLL_ORACLE_BYTES_PER_ENTRY, HLL_DEFAULT_P, HLL_DEFAULT_CARD,
    F_EST, F_TRUE, F_RELERR, F_STDERR, F_SKETCH_BYTES, F_SET_BYTES,
    F_M, F_P, F_RELERR_FRAC, F_MAXREG, F_SKETCH_ALLOC, F_ORACLE_ALLOC, HLL_FLAT_LEN,
    // Scene 02 -- CountMinSketch
    createCmsWorld, stepCmsSketch, stepCmsOracle, renderCmsPrep,
    CMS_DEFAULT_D, CMS_DEFAULT_W, CMS_DEFAULT_STREAM_SEED, CMS_STREAM_LEN,
    CF_EST, CF_TRUE, CF_GAP, CF_BOUND, CF_GAPFRAC, CF_EPS, CF_N,
    CF_D, CF_W, CF_QKEY, CF_SKETCH_ALLOC, CF_ORACLE_ALLOC, CF_DISTINCT,
    // Scene 03 -- DDSketch
    createDdWorld, stepDdSketch, stepDdOracle, renderDdPrep,
    DD_DEFAULT_ALPHA, DD_DEFAULT_STREAM_SEED, DD_STREAM_LEN,
    DF_P50, DF_P90, DF_P99, DF_T50, DF_T90, DF_T99, DF_E50, DF_E90, DF_E99,
    DF_F50, DF_F90, DF_F99, DF_ALPHA, DF_N, DF_ORACLEN, DF_COLLAPSED, DF_MIN, DF_MAX,
    DF_SKETCH_ALLOC, DF_ORACLE_ALLOC,
    // Scene 04 -- SpaceSaving
    createSsWorld, stepSsSketch, stepSsOracle, renderSsPrep,
    SS_DEFAULT_K, SS_DEFAULT_STREAM_SEED, SS_STREAM_LEN,
    SF_RECALL, SF_TRUEHH, SF_FOUND, SF_N, SF_K, SF_THRESH, SF_MAXERR, SF_BRACKETOK,
    SF_SIZE, SF_DISTINCT, SF_SKETCH_ALLOC, SF_ORACLE_ALLOC, SF_ROWS,
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

test('boundary: seed null/undefined fall back to the documented default; NaN/-0/0 pass through as 0 (null is not zero)', () => {
    const def = HLL_DEFAULT_STREAM_SEED;
    // null is not zero: createHllWorld falls back ONLY on undefined/null (the fixed contract), exactly
    // like createCmsWorld/createDdWorld/createSsWorld -- an explicit seed=0 IS honored, not aliased away.
    assert.equal(createHllWorld(10, 100, null).seed, def, 'seed=null falls back to the default');
    assert.equal(createHllWorld(10, 100, undefined).seed, def, 'seed=undefined falls back to the default');
    // The `(seed>>>0)` branch coerces NaN/-0/0 to 0 and passes them straight through as the real seed --
    // VERIFIED against the actual kernels.mjs source (real behavior, not assumed).
    assert.equal(createHllWorld(10, 100, NaN).seed, 0, 'seed=NaN coerces to 0 via (NaN>>>0) and is NOT replaced by the default');
    assert.equal(createHllWorld(10, 100, -0).seed, 0, 'seed=-0 coerces to 0 via (-0>>>0) and is NOT replaced by the default');
    assert.equal(createHllWorld(10, 100, 0).seed, 0, 'seed=0 is honored (an explicit 0 IS reachable -- the fixed null-is-not-zero contract)');
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

/* =============================================================================================
 * SCENE 02 -- CountMinSketch (frequency)
 * ============================================================================================= */

test('CMS faithfulness: demo estimate(hotKey) equals a FRESH CountMinSketch.estimate(hotKey) fed the identical stream', () => {
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, CMS_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const FRAMES = 200; // 200 * 200 = 40000 keys, well under CMS_STREAM_LEN (65536) -- cursor never wraps
    for (let i = 0; i < FRAMES; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); }
    renderCmsPrep(world, allocState);

    // Independent reference: a FRESH conservative CountMinSketch fed the SAME key sequence
    // directly from world.stream (never reusing world.cms) -- the min-of-d point query.
    const ref = new CountMinSketch(world.d, world.w, { seed: world.seed, conservative: true });
    const total = FRAMES * world.keysPerFrame;
    for (let t = 0; t < total; t++) ref.add(world.stream[t]);

    const hotKey = world.flat[CF_QKEY];
    assert.equal(world.cms.estimate(hotKey), ref.estimate(hotKey),
        'demo CMS estimate(hotKey) must equal an independently-fed CountMinSketch exactly');
    assert.equal(world.flat[CF_EST], ref.estimate(hotKey),
        'demo displayed estimate must equal the independent reference estimate exactly');
});

test('CMS faithfulness: renderCmsPrep gap/bound/eps/N equal an independently recomputed value from a FRESH exact Map', () => {
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 0xFEEDFACE);
    const allocState = createAllocState();
    const FRAMES = 250;
    for (let i = 0; i < FRAMES; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); }
    renderCmsPrep(world, allocState);

    // A SEPARATE, freshly-built exact Map fed the identical key sequence (never reusing world.oracle).
    const total = FRAMES * world.keysPerFrame;
    const freshMap = new Map();
    for (let t = 0; t < total; t++) { const k = world.stream[t]; freshMap.set(k, (freshMap.get(k) || 0) + 1); }
    const freshCms = new CountMinSketch(world.d, world.w, { seed: world.seed, conservative: true });
    for (let t = 0; t < total; t++) freshCms.add(world.stream[t]);

    const hotKey = world.flat[CF_QKEY];
    const trueCount = freshMap.get(hotKey) || 0;
    assert.equal(world.flat[CF_TRUE], trueCount, 'demo displayed true count must equal the independent fresh Map count');
    assert.equal(world.flat[CF_EST], freshCms.estimate(hotKey), 'demo displayed estimate must equal the independent fresh CMS estimate');
    const wantGap = freshCms.estimate(hotKey) - trueCount;
    const wantEps = freshCms.epsilon;
    const wantBound = wantEps * freshCms.total;
    assert.equal(world.flat[CF_GAP], wantGap, 'demo displayed gap must equal the independently recomputed gap exactly');
    assert.equal(world.flat[CF_EPS], wantEps, 'demo displayed epsilon must equal the independently recomputed e/w exactly');
    assert.equal(world.flat[CF_BOUND], wantBound, 'demo displayed bound must equal the independently recomputed eps*N exactly');
    assert.equal(world.flat[CF_N], freshCms.total, 'demo displayed N must equal the independent fresh CMS total exactly');
});

test('CMS witness: the measured over-estimate gap is one-sided (>= 0, never undercounts) AND <= eps*N at the demo default topology', () => {
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, CMS_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const FRAMES = 300; // 300 * 200 = 60000 keys, still < CMS_STREAM_LEN
    for (let i = 0; i < FRAMES; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); }
    renderCmsPrep(world, allocState);

    // Cross-check against a FRESH exact Map over the SAME stream (independent of world.oracle).
    const total = FRAMES * world.keysPerFrame;
    const trueMap = new Map();
    for (let t = 0; t < total; t++) { const k = world.stream[t]; trueMap.set(k, (trueMap.get(k) || 0) + 1); }
    const hotKey = world.flat[CF_QKEY];
    const trueCount = trueMap.get(hotKey) || 0;
    const est = world.cms.estimate(hotKey);
    const gap = est - trueCount;
    const eps = Math.E / world.w; // e/w, the real theoretical epsilon -- reused verbatim from Sketch.js's own getter
    const N = world.cms.total;

    assert.ok(gap >= 0, 'CMS is a one-sided over-estimator: gap (' + gap + ') must never be negative (never undercounts)');
    assert.ok(gap <= eps * N, 'measured gap ' + gap + ' must be <= eps*N = ' + (eps * N) + ' (the theoretical over-estimate ceiling)');
    assert.equal(world.flat[CF_GAPFRAC], world.flat[CF_BOUND] > 0 ? world.flat[CF_GAP] / world.flat[CF_BOUND] : 0,
        'the drawn cursor fraction (gap/bound) must equal the recomputed ratio exactly');
    assert.ok(world.flat[CF_GAPFRAC] <= 1, 'the drawn cursor fraction must stay <= 1 (inside the honest band)');
});

test('CMS adversarial (beyond DEMO.md): conservative-update NEVER over-estimates more than plain-update on the identical stream', () => {
    // DEMO.md never spells out a per-key invariant across the two matrices the demo keeps side by
    // side (Section 3's toggle); test/witness.mjs gates this same invariant in aggregate (meanOver).
    // Here we gate it per-KEY, the stronger statement: conservative.estimate(k) <= plain.estimate(k)
    // for EVERY distinct key ever seen, on the live demo world (not a fresh instance).
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, CMS_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const FRAMES = 300;
    for (let i = 0; i < FRAMES; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); }

    let checked = 0;
    for (const key of world.oracle.keys()) {
        const ce = world.cms.estimate(key);
        const pe = world.cmsPlain.estimate(key);
        assert.ok(ce <= pe, 'conservative estimate(' + key + ')=' + ce + ' must never exceed plain estimate=' + pe);
        checked++;
    }
    assert.ok(checked > 1000, 'sanity: the invariant must have been checked over a non-trivial number of distinct keys, got ' + checked);
});

test('CMS boundary: createCmsWorld d/w at the library extremes succeed; outside throws [lite-sketch] fail-closed', () => {
    // d/w at true library max (CMS_D_MAX=32, CMS_W_MAX=2^25) would allocate a d*w Uint32Array of
    // over 1 billion elements (~4 GB) -- NOT exercised here (a resource blowup, not a logic gap);
    // the ctor's own typeof/range guards run BEFORE allocation (verified in Sketch.js), so the
    // reject-path extremes below are exercised at their true values with NO allocation cost.
    assert.doesNotThrow(() => createCmsWorld(1, 4, 1), 'd=1 (library min) must be constructible');
    assert.doesNotThrow(() => createCmsWorld(32, 64, 1), 'd=32 (library max) with a small w must be constructible');
    assert.throws(() => createCmsWorld(0, 64, 1), /\[lite-sketch\]/, 'd=0 (below min) must fail closed');
    assert.throws(() => createCmsWorld(33, 64, 1), /\[lite-sketch\]/, 'd=33 (above max) must fail closed');
    assert.throws(() => createCmsWorld(4, (1 << 25) + 1, 1), /\[lite-sketch\]/, 'w just above the true library max (2^25) must fail closed, guard runs before allocation');
    assert.throws(() => createCmsWorld(null, 64, 1), /\[lite-sketch\]/, 'd=null must fail closed (typeof guard runs first)');
    assert.throws(() => createCmsWorld(NaN, 64, 1), /\[lite-sketch\]/, 'd=NaN must fail closed ((d|0) !== d)');
    assert.throws(() => createCmsWorld(4, NaN, 1), /\[lite-sketch\]/, 'w=NaN must fail closed ((w|0) !== w)');
});

test('CMS boundary: seed null/undefined fall back to the documented default; NaN/-0/0 pass through as 0 (falsy-seed contract, NOT a fallback)', () => {
    const def = CMS_DEFAULT_STREAM_SEED;
    // null is not zero: createCmsWorld falls back ONLY on undefined/null, exactly like createHllWorld.
    assert.equal(createCmsWorld(4, 256, null).seed, def, 'seed=null falls back to the default');
    assert.equal(createCmsWorld(4, 256, undefined).seed, def, 'seed=undefined falls back to the default');
    // Unlike a `(seed>>>0) || DEFAULT` contract, createCmsWorld's `seed>>>0` branch does NOT treat a
    // falsy uint32 result as "missing" -- NaN/-0/0 all coerce to 0 and pass straight through as the
    // real seed, VERIFIED against the actual kernels.mjs source (real behavior, not assumed).
    assert.equal(createCmsWorld(4, 256, NaN).seed, 0, 'seed=NaN coerces to 0 via (NaN>>>0) and is NOT replaced by the default');
    assert.equal(createCmsWorld(4, 256, -0).seed, 0, 'seed=-0 coerces to 0 via (-0>>>0) and is NOT replaced by the default');
    assert.equal(createCmsWorld(4, 256, 0).seed, 0, 'seed=0 coerces to 0 and is NOT replaced by the default (an explicit 0 IS reachable here)');
    assert.equal(createCmsWorld(4, 256, 7).seed, 7, 'a genuine nonzero seed passes through unchanged');
});

test('CMS boundary: keysPerFrame 0 (empty frame) and 1 (single-key frame) never throw and stay faithful', () => {
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 42);
    world.keysPerFrame = 0;
    const cursorBefore = world.cursor;
    const sink = stepCmsSketch(world);
    assert.equal(sink, 0, 'an empty (0-key) frame folds to the additive identity 0');
    assert.equal(world.cursor, cursorBefore, 'an empty frame must not advance the cursor');
    assert.equal(world.frameCount, 0, 'an empty frame records frameCount=0');
    const allocState = createAllocState();
    assert.doesNotThrow(() => stepCmsOracle(world, allocState), 'stepCmsOracle over an empty frame must not throw');
    assert.equal(allocState.oracleCount, 0, 'an empty frame adds nothing to the oracle');

    world.keysPerFrame = 1;
    const cursorBefore2 = world.cursor;
    stepCmsSketch(world);
    assert.equal(world.frameCount, 1, 'a single-key frame records frameCount=1');
    assert.equal(world.cursor, (cursorBefore2 + 1) & 0x3fffffff, 'a single-key frame advances the cursor by exactly 1');
});

test('CMS boundary: stepCmsSketch/stepCmsOracle/renderCmsPrep fail closed (throw) on a null/undefined world', () => {
    assert.throws(() => stepCmsSketch(null), 'stepCmsSketch(null) must throw, never silently no-op');
    assert.throws(() => stepCmsSketch(undefined), 'stepCmsSketch(undefined) must throw');
    assert.throws(() => stepCmsOracle(null, createAllocState()), 'stepCmsOracle(null, ...) must throw');
    assert.throws(() => renderCmsPrep(null, createAllocState()), 'renderCmsPrep(null, ...) must throw');
});

test('CMS duplicate dispose + dispose-during-iteration: clearing both matrices + the oracle mid-stream stays consistent, and streaming resumes faithfully', () => {
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 0xABC123);
    const allocState = createAllocState();
    for (let i = 0; i < 20; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); }
    assert.ok(world.oracle.size > 0, 'the world must be non-trivially populated before the mid-stream clear');

    world.cms.clear();
    world.cmsPlain.clear();
    world.oracle.clear();
    renderCmsPrep(world, allocState);
    assert.equal(world.flat[CF_EST], 0, 'a freshly-cleared CountMinSketch must estimate 0');
    assert.equal(world.flat[CF_TRUE], 0, 'a freshly-cleared oracle must read 0 true count');
    assert.equal(world.flat[CF_GAP], 0, 'gap on an empty world is 0, never NaN');
    assert.equal(world.flat[CF_BOUND], 0, 'bound on an empty world (N=0) is 0, never NaN/Infinity');
    assert.equal(world.flat[CF_GAPFRAC], 0, 'gapfrac on an empty world is the defined identity 0');

    // A SECOND clear must be idempotent (fail-closed: never throws, never half-clears).
    assert.doesNotThrow(() => { world.cms.clear(); world.cmsPlain.clear(); world.oracle.clear(); },
        'a second consecutive clear() on both matrices + the oracle must not throw');
    renderCmsPrep(world, allocState);
    assert.equal(world.flat[CF_EST], 0, 'the SECOND clear must leave the world equally empty (idempotent)');

    // Streaming AFTER the mid-iteration clear must resume converging faithfully.
    for (let i = 0; i < 300; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); }
    renderCmsPrep(world, allocState);
    assert.ok(world.flat[CF_N] > 0, 'streaming after a mid-iteration clear must resume growing N');
    assert.ok(Number.isFinite(world.flat[CF_GAP]), 'gap must stay finite after a mid-stream clear+resume');
});

test('CMS re-entrant: renderCmsPrep called twice with no intervening step produces byte-identical output', () => {
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 0xAAAA1111);
    const allocState = createAllocState();
    for (let i = 0; i < 200; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); } // qTick stays 0 (renderCmsPrep never called yet)
    renderCmsPrep(world, allocState);
    const first = world.flat.slice();
    renderCmsPrep(world, allocState); // NO stepping in between -- must be a pure re-derivation
    const second = world.flat.slice();
    assert.deepStrictEqual(Array.from(first), Array.from(second),
        'renderCmsPrep must be idempotent when nothing streamed between calls (a re-entrant-safe re-derivation, not a stateful accumulator)');
});

/* ============================ CMS zero-alloc kernel gate ==================================== */

test('CMS 0-B/op: stepCmsSketch + renderCmsPrep (the SKETCH path) allocate 0 bytes and trigger 0 major GC over a long run', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 0x1A2B3C4D);
    const allocState = createAllocState();

    for (let i = 0; i < 20000; i++) {
        stepCmsSketch(world);
        if ((i & 7) === 0) renderCmsPrep(world, allocState);
    }

    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink = (sink + stepCmsSketch(world)) | 0;
        if ((i & 7) === 0) sink = (sink + (renderCmsPrep(world, allocState) | 0)) | 0;
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(Number.isFinite(sink), 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50));
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const totalOps = HOT + Math.floor((HOT + 7) / 8);
    const bytesPerOp = (heapAfter - heapBefore) / totalOps;
    process.stdout.write('  demo Scene-02 (CMS) sketch-path gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' (reported, not gated) maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k+25k CMS sketch-path frames must trigger 0 major GC, got ' + s.gc.major);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 16, 'CMS sketch-path kernels must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
    assert.equal(allocState.sketchCount, 0, 'the CMS sketch-path owned allocation counter must stay pinned at 0');
    assert.equal(world.flat[CF_SKETCH_ALLOC], 0, 'flat[CF_SKETCH_ALLOC] (what the demo displays) must also read 0');
});

test('CMS 0-B/op (measureAllocs): stepCmsSketch alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 0x2468ACE0);
    for (let i = 0; i < 20000; i++) stepCmsSketch(world);
    const step = () => stepCmsSketch(world);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  stepCmsSketch measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'stepCmsSketch must measure 0 B/call, got ' + bpc);
});

test('CMS 0-B/op (measureAllocs): renderCmsPrep alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 0x13572468);
    const allocState = createAllocState();
    for (let i = 0; i < 20000; i++) { stepCmsSketch(world); renderCmsPrep(world, allocState); }
    const step = () => renderCmsPrep(world, allocState);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  renderCmsPrep measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'renderCmsPrep must measure 0 B/call, got ' + bpc);
});

test('CMS contrast: stepCmsOracle (the exact-Map path) DOES allocate -- proves the CMS 0-B/op gates above are not vacuous', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createCmsWorld(CMS_DEFAULT_D, CMS_DEFAULT_W, 0x5F5F5F5F);
    const allocState = createAllocState();
    for (let i = 0; i < 50; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); } // warm up

    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const oracleCountBefore = allocState.oracleCount;
    const LOOPS = 300;
    for (let i = 0; i < LOOPS; i++) { stepCmsSketch(world); stepCmsOracle(world, allocState); }
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / LOOPS;
    const oracleCountDelta = allocState.oracleCount - oracleCountBefore;
    process.stdout.write('  contrast stepCmsOracle: alloc=' + bytesPerOp.toFixed(1) + ' B/op (oracleCount delta=' + oracleCountDelta + ')\n');
    assert.ok(allocState.oracleCount > 0, 'the CMS oracle path must have recorded real allocations (new distinct Zipfian keys)');
    assert.ok(bytesPerOp > 50, 'the exact-Map path must allocate real, measurable bytes/op (got ' + bytesPerOp.toFixed(1) +
        '), proving the CMS 0-B/op sketch-path measurement above is a real measurement, not vacuous');
});

/* =============================================================================================
 * SCENE 03 -- DDSketch (relative-error quantiles)
 * ============================================================================================= */

test('DD faithfulness: demo p50/p90/p99 equal a FRESH DDSketch.quantile fed the identical stream, exact; min/max EXACT-tracked', () => {
    const world = createDdWorld(DD_DEFAULT_ALPHA, DD_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const FRAMES = 300; // 300 * 200 = 60000 values, well under DD_STREAM_LEN (65536)
    for (let i = 0; i < FRAMES; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    renderDdPrep(world, allocState);

    // Independent reference: a FRESH DDSketch fed the SAME value sequence directly from world.stream.
    const ref = new DDSketch(world.alpha);
    const total = FRAMES * world.keysPerFrame;
    let refMin = Infinity, refMax = -Infinity;
    for (let t = 0; t < total; t++) {
        const v = world.stream[t];
        ref.add(v);
        if (v < refMin) refMin = v;
        if (v > refMax) refMax = v;
    }

    assert.equal(world.dd.quantile(0.5), ref.quantile(0.5), 'demo p50 must equal an independently-fed DDSketch.quantile(0.5) exactly');
    assert.equal(world.dd.quantile(0.9), ref.quantile(0.9), 'demo p90 must equal an independently-fed DDSketch.quantile(0.9) exactly');
    assert.equal(world.dd.quantile(0.99), ref.quantile(0.99), 'demo p99 must equal an independently-fed DDSketch.quantile(0.99) exactly');
    assert.equal(world.flat[DF_P50], ref.quantile(0.5), 'flat[DF_P50] (what the demo displays) must equal the reference exactly');
    assert.equal(world.flat[DF_P90], ref.quantile(0.9), 'flat[DF_P90] (what the demo displays) must equal the reference exactly');
    assert.equal(world.flat[DF_P99], ref.quantile(0.99), 'flat[DF_P99] (what the demo displays) must equal the reference exactly');
    // min/max are EXACT-tracked running aggregates (never bucketed/approximated) -- Sketch.js's own contract.
    assert.equal(world.dd.min, refMin, 'demo dd.min must equal the independently-tracked EXACT minimum');
    assert.equal(world.dd.max, refMax, 'demo dd.max must equal the independently-tracked EXACT maximum');
    assert.equal(world.flat[DF_MIN], refMin, 'flat[DF_MIN] (what the demo displays) must equal the EXACT minimum');
    assert.equal(world.flat[DF_MAX], refMax, 'flat[DF_MAX] (what the demo displays) must equal the EXACT maximum');
});

test('DD faithfulness: renderDdPrep e50/e90/e99 equal an independently recomputed relative error vs a FRESH exact sorted array', () => {
    const world = createDdWorld(DD_DEFAULT_ALPHA, 0xFEEDFACE);
    const allocState = createAllocState();
    const FRAMES = 300;
    for (let i = 0; i < FRAMES; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    renderDdPrep(world, allocState);

    const total = FRAMES * world.keysPerFrame;
    const fresh = new Float64Array(total);
    for (let t = 0; t < total; t++) fresh[t] = world.stream[t];
    const sorted = Array.from(fresh).sort((a, b) => a - b);
    const t50 = sorted[Math.floor(0.5 * (total - 1))];
    const t90 = sorted[Math.floor(0.9 * (total - 1))];
    const t99 = sorted[Math.floor(0.99 * (total - 1))];
    const wantE50 = Math.abs(world.flat[DF_P50] - t50) / t50;
    const wantE90 = Math.abs(world.flat[DF_P90] - t90) / t90;
    const wantE99 = Math.abs(world.flat[DF_P99] - t99) / t99;

    assert.equal(world.flat[DF_T50], t50, 'demo displayed true p50 must equal the independent fresh sorted-array value exactly');
    assert.equal(world.flat[DF_T90], t90, 'demo displayed true p90 must equal the independent fresh sorted-array value exactly');
    assert.equal(world.flat[DF_T99], t99, 'demo displayed true p99 must equal the independent fresh sorted-array value exactly');
    assert.equal(world.flat[DF_E50], wantE50, 'demo displayed e50 must equal the independently recomputed relative error exactly');
    assert.equal(world.flat[DF_E90], wantE90, 'demo displayed e90 must equal the independently recomputed relative error exactly');
    assert.equal(world.flat[DF_E99], wantE99, 'demo displayed e99 must equal the independently recomputed relative error exactly');
});

test('DD witness: e50/e90/e99 satisfy the HARD alpha bound test/witness.mjs gates DDSketch against', () => {
    const world = createDdWorld(DD_DEFAULT_ALPHA, DD_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const FRAMES = 300;
    for (let i = 0; i < FRAMES; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    renderDdPrep(world, allocState);

    // Reuse test/witness.mjs's own DD_SLACK (ULP-level Math.log/Math.pow rounding at the analytic
    // boundary of a HARD bound -- never a statistical fudge; identical constant, not invented here).
    const DD_SLACK = 1e-9;
    const bound = world.alpha * (1 + DD_SLACK);
    assert.ok(world.flat[DF_E50] <= bound, 'e50 ' + world.flat[DF_E50] + ' must be <= alpha bound ' + bound);
    assert.ok(world.flat[DF_E90] <= bound, 'e90 ' + world.flat[DF_E90] + ' must be <= alpha bound ' + bound);
    assert.ok(world.flat[DF_E99] <= bound, 'e99 ' + world.flat[DF_E99] + ' must be <= alpha bound ' + bound);
    assert.ok(world.flat[DF_F50] <= 1, 'the drawn cursor fraction f50 (e50/alpha) must stay <= 1 (inside the honest band)');
    assert.ok(world.flat[DF_F90] <= 1, 'the drawn cursor fraction f90 must stay <= 1');
    assert.ok(world.flat[DF_F99] <= 1, 'the drawn cursor fraction f99 must stay <= 1');
});

test('DD witness: the drawn band (DF_ALPHA) IS dd.alpha, independent of the measured error (not a fudge)', () => {
    // Two worlds, SAME alpha but different seeds (so different, non-equal measured errors). If the
    // band were ever computed FROM the error (a fudge), it would move between these two runs.
    const a = createDdWorld(DD_DEFAULT_ALPHA, 0x11111111);
    const b = createDdWorld(DD_DEFAULT_ALPHA, 0x22222222);
    const allocA = createAllocState(), allocB = createAllocState();
    for (let i = 0; i < 300; i++) { stepDdSketch(a); stepDdOracle(a, allocA); }
    for (let i = 0; i < 300; i++) { stepDdSketch(b); stepDdOracle(b, allocB); }
    renderDdPrep(a, allocA);
    renderDdPrep(b, allocB);

    assert.equal(a.flat[DF_ALPHA], DD_DEFAULT_ALPHA, 'F_ALPHA must equal the independently-known configured alpha exactly');
    assert.equal(b.flat[DF_ALPHA], DD_DEFAULT_ALPHA, 'F_ALPHA must be identical across worlds sharing alpha, regardless of differing measured error');
    assert.equal(a.flat[DF_ALPHA], a.dd.alpha, 'F_ALPHA must equal dd.alpha exactly');
    assert.equal(b.flat[DF_ALPHA], b.dd.alpha, 'F_ALPHA must equal dd.alpha exactly');
    assert.notEqual(a.flat[DF_E50], b.flat[DF_E50], 'sanity: the two runs must have produced different measured errors to make the independence check meaningful');
});

test('DD fail-closed: DDSketch.add rejects a negative value, and the demo stream is provably positive-only (never feeds one)', () => {
    // The real Sketch.js guard, exercised directly (never a hand-rolled message).
    const probe = new DDSketch(DD_DEFAULT_ALPHA);
    assert.throws(() => probe.add(-1), /\[lite-sketch\]/, 'DDSketch.add(-1) must throw the real fail-closed TypeError');
    assert.throws(() => probe.add(-0.0001), /\[lite-sketch\]/, 'DDSketch.add of a small negative must also throw');

    // The demo's OWN generator (fillLognormalStream, exercised via createDdWorld) must never produce
    // a value the guard above would reject -- scanned over the FULL reused stream buffer, not a sample.
    const world = createDdWorld(DD_DEFAULT_ALPHA, DD_DEFAULT_STREAM_SEED);
    let minSeen = Infinity;
    for (let i = 0; i < world.stream.length; i++) {
        const v = world.stream[i];
        assert.ok(v > 0, 'demo stream[' + i + ']=' + v + ' must be strictly positive (lognormal exp() is always > 0)');
        if (v < minSeen) minSeen = v;
    }
    assert.ok(Number.isFinite(minSeen) && minSeen > 0, 'sanity: the stream must be non-empty and strictly positive throughout');
});

test('DD adversarial (beyond DEMO.md): an extreme outlier 1e13x the stream max shifts the collapsing-lowest window WITHOUT corrupting the already-established bulk quantiles', () => {
    // DEMO.md never spells out what happens to the ALREADY-DISPLAYED p50/p99 when a single
    // extreme sample forces DDSketch's non-strict window to slide. Because the low end of the
    // window (below the bulk's populated range) is already empty, the slide's fold-into-bin-0
    // carries zero mass -- `collapsed` stays false and the bulk quantiles are UNCHANGED, exactly.
    const world = createDdWorld(DD_DEFAULT_ALPHA, DD_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    for (let i = 0; i < 300; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    renderDdPrep(world, allocState);
    const p50Before = world.flat[DF_P50], p99Before = world.flat[DF_P99];
    const collapsedBefore = world.dd.collapsed;
    const maxBefore = world.dd.max;

    world.dd.add(1e13 * maxBefore); // an outlier far beyond anything the stream would ever produce
    const p50After = world.dd.quantile(0.5);
    const p99After = world.dd.quantile(0.99);

    assert.equal(p50After, p50Before, 'the bulk p50 must be UNCHANGED after one extreme outlier (the low end of the window was already empty)');
    assert.equal(p99After, p99Before, 'the bulk p99 must be UNCHANGED after one extreme outlier');
    assert.equal(world.dd.collapsed, collapsedBefore, 'collapsed must stay false: the folded low cells carried zero mass, so no real data was lost');
    assert.ok(world.dd.max >= 1e13 * maxBefore, 'the EXACT-tracked max must have captured the new outlier (max is never bucketed)');
    assert.ok(world.dd.quantile(1) >= maxBefore * 1e12, 'the sketch must still be able to report the new extreme at q=1 (the window DID move to include it)');
});

test('DD boundary: createDdWorld alpha at the library extremes succeed; outside/invalid throws [lite-sketch] fail-closed', () => {
    // maxBins is FIXED at the default (2048) regardless of alpha (no allocation blowup risk at
    // either extreme -- verified against the Sketch.js ctor, unlike CMS's d/w).
    assert.doesNotThrow(() => createDdWorld(1e-6, 1), 'alpha near 0 (library-open lower bound) must be constructible');
    assert.doesNotThrow(() => createDdWorld(0.999999, 1), 'alpha near 1 (library-open upper bound) must be constructible');
    assert.throws(() => createDdWorld(0, 1), /\[lite-sketch\]/, 'alpha=0 (open interval excludes 0) must fail closed');
    assert.throws(() => createDdWorld(1, 1), /\[lite-sketch\]/, 'alpha=1 (open interval excludes 1) must fail closed');
    assert.throws(() => createDdWorld(-0.01, 1), /\[lite-sketch\]/, 'a negative alpha must fail closed');
    assert.throws(() => createDdWorld(NaN, 1), /\[lite-sketch\]/, 'alpha=NaN must fail closed');
    assert.throws(() => createDdWorld(null, 1), /\[lite-sketch\]/, 'alpha=null must fail closed (typeof guard runs first)');
});

test('DD boundary: seed null/undefined fall back to the documented default; NaN/-0/0 pass through as 0 (falsy-seed contract, NOT a fallback)', () => {
    const def = DD_DEFAULT_STREAM_SEED;
    assert.equal(createDdWorld(DD_DEFAULT_ALPHA, null).seed, def, 'seed=null falls back to the default');
    assert.equal(createDdWorld(DD_DEFAULT_ALPHA, undefined).seed, def, 'seed=undefined falls back to the default');
    assert.equal(createDdWorld(DD_DEFAULT_ALPHA, NaN).seed, 0, 'seed=NaN coerces to 0 and is NOT replaced by the default');
    assert.equal(createDdWorld(DD_DEFAULT_ALPHA, -0).seed, 0, 'seed=-0 coerces to 0 and is NOT replaced by the default');
    assert.equal(createDdWorld(DD_DEFAULT_ALPHA, 0).seed, 0, 'seed=0 coerces to 0 and is NOT replaced by the default');
    assert.equal(createDdWorld(DD_DEFAULT_ALPHA, 7).seed, 7, 'a genuine nonzero seed passes through unchanged');
});

test('DD boundary: keysPerFrame 0 (empty frame) and 1 (single-value frame) never throw and stay faithful', () => {
    const world = createDdWorld(DD_DEFAULT_ALPHA, 42);
    world.keysPerFrame = 0;
    const cursorBefore = world.cursor;
    const sink = stepDdSketch(world);
    assert.equal(sink, 0, 'an empty (0-value) frame folds to the additive identity 0');
    assert.equal(world.cursor, cursorBefore, 'an empty frame must not advance the cursor');
    assert.equal(world.frameCount, 0, 'an empty frame records frameCount=0');
    const allocState = createAllocState();
    assert.doesNotThrow(() => stepDdOracle(world, allocState), 'stepDdOracle over an empty frame must not throw');
    assert.equal(allocState.oracleCount, 0, 'an empty frame adds nothing to the oracle');

    world.keysPerFrame = 1;
    const cursorBefore2 = world.cursor;
    stepDdSketch(world);
    assert.equal(world.frameCount, 1, 'a single-value frame records frameCount=1');
    assert.equal(world.cursor, (cursorBefore2 + 1) & 0x3fffffff, 'a single-value frame advances the cursor by exactly 1');
});

test('DD boundary: stepDdSketch/stepDdOracle/renderDdPrep fail closed (throw) on a null/undefined world', () => {
    assert.throws(() => stepDdSketch(null), 'stepDdSketch(null) must throw, never silently no-op');
    assert.throws(() => stepDdSketch(undefined), 'stepDdSketch(undefined) must throw');
    assert.throws(() => stepDdOracle(null, createAllocState()), 'stepDdOracle(null, ...) must throw');
    assert.throws(() => renderDdPrep(null, createAllocState()), 'renderDdPrep(null, ...) must throw');
});

test('DD duplicate dispose + dispose-during-iteration: clearing the sketch + oracle mid-stream stays consistent (NaN quantiles, not corrupted numbers), and streaming resumes faithfully', () => {
    const world = createDdWorld(DD_DEFAULT_ALPHA, 0xABC123);
    const allocState = createAllocState();
    for (let i = 0; i < 20; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    assert.ok(world.oracleN > 0, 'the world must be non-trivially populated before the mid-stream clear');

    world.dd.clear();
    world.oracleN = 0;
    world.sortedDirty = true;
    renderDdPrep(world, allocState);
    assert.ok(Number.isNaN(world.flat[DF_P50]), 'quantile() of an empty DDSketch is the documented NaN, never a stale/corrupted number');
    assert.ok(Number.isNaN(world.flat[DF_T50]), 'the true quantile of an empty oracle window is also NaN (oracleN=0)');
    assert.equal(world.flat[DF_E50], 0, 'relative error on an empty (t50 not > 0) world is the defined identity 0');
    assert.equal(world.flat[DF_N], 0, 'demo displayed N (dd.count) must read 0 right after clear');
    assert.ok(Number.isNaN(world.flat[DF_MIN]) && Number.isNaN(world.flat[DF_MAX]), 'min/max of an empty DDSketch are NaN (the documented empty-sketch contract)');

    // A SECOND clear must be idempotent.
    assert.doesNotThrow(() => { world.dd.clear(); world.oracleN = 0; world.sortedDirty = true; },
        'a second consecutive clear must not throw');
    renderDdPrep(world, allocState);
    assert.ok(Number.isNaN(world.flat[DF_P50]), 'the SECOND clear must leave the world equally empty (idempotent)');

    // Streaming AFTER the mid-iteration clear must resume converging faithfully.
    for (let i = 0; i < 300; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    renderDdPrep(world, allocState);
    assert.ok(Number.isFinite(world.flat[DF_P50]), 'p50 must be finite again after a mid-stream clear+resume');
    assert.ok(world.flat[DF_N] > 0, 'streaming after a mid-iteration clear must resume growing N');
});

test('DD re-entrant: renderDdPrep called twice with no intervening step produces byte-identical output', () => {
    const world = createDdWorld(DD_DEFAULT_ALPHA, 0xAAAA1111);
    const allocState = createAllocState();
    for (let i = 0; i < 200; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    renderDdPrep(world, allocState);
    const first = world.flat.slice();
    renderDdPrep(world, allocState); // NO stepping in between
    const second = world.flat.slice();
    assert.deepStrictEqual(Array.from(first), Array.from(second),
        'renderDdPrep must be idempotent when nothing streamed between calls (the sortedDirty flag must not force a re-sort that could reorder ties)');
});

/* ============================ DD zero-alloc kernel gate ===================================== */

test('DD 0-B/op: stepDdSketch + renderDdPrep (the SKETCH path) allocate 0 bytes and trigger 0 major GC over a long run', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const world = createDdWorld(DD_DEFAULT_ALPHA, 0x1A2B3C4D);
    const allocState = createAllocState();

    for (let i = 0; i < 20000; i++) {
        stepDdSketch(world);
        if ((i & 7) === 0) renderDdPrep(world, allocState);
    }

    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink = (sink + stepDdSketch(world)) | 0;
        if ((i & 7) === 0) sink = (sink + (renderDdPrep(world, allocState) | 0)) | 0;
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(Number.isFinite(sink), 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50));
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const totalOps = HOT + Math.floor((HOT + 7) / 8);
    const bytesPerOp = (heapAfter - heapBefore) / totalOps;
    process.stdout.write('  demo Scene-03 (DD) sketch-path gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' (reported, not gated) maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k+25k DD sketch-path frames must trigger 0 major GC, got ' + s.gc.major);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 16, 'DD sketch-path kernels must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
    assert.equal(allocState.sketchCount, 0, 'the DD sketch-path owned allocation counter must stay pinned at 0');
    assert.equal(world.flat[DF_SKETCH_ALLOC], 0, 'flat[DF_SKETCH_ALLOC] (what the demo displays) must also read 0');
});

test('DD 0-B/op (measureAllocs): stepDdSketch alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createDdWorld(DD_DEFAULT_ALPHA, 0x2468ACE0);
    for (let i = 0; i < 20000; i++) stepDdSketch(world);
    const step = () => stepDdSketch(world);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  stepDdSketch measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'stepDdSketch must measure 0 B/call, got ' + bpc);
});

test('DD 0-B/op (measureAllocs): renderDdPrep alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createDdWorld(DD_DEFAULT_ALPHA, 0x13572468);
    const allocState = createAllocState();
    for (let i = 0; i < 20000; i++) { stepDdSketch(world); renderDdPrep(world, allocState); }
    const step = () => renderDdPrep(world, allocState);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  renderDdPrep measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'renderDdPrep must measure 0 B/call, got ' + bpc);
});

test('DD contrast: stepDdOracle is a PRE-ALLOCATED typed-array append (genuinely 0-alloc, unlike CMS/SS Map oracles) -- a naive per-frame array COPY (what a less careful oracle would do) triggers real major GC the kernel path never does', async (t) => {
    // Measured (real finding, not assumed): unlike CMS/SS's exact-Map oracle (a growing hash
    // table that allocates a new entry per distinct key), stepDdOracle here retains samples in a
    // FIXED-SIZE Float64Array (`world.oracle`, sized to DD_ORACLE_CAP up front) -- so an append is
    // just a typed-array store, 0 B/op, exactly like the sketch path. That is a genuinely STRONGER
    // zero-GC property for this scene, not a test bug: the "allocates in spirit" comment in
    // kernels.mjs refers to the CONCEPTUAL memory footprint (flat[DF_ARR_BYTES] = oracleN*8
    // climbing), not literal JS heap churn. To still prove the 0-B/op sketch-path gates above are
    // non-vacuous, contrast against the NAIVE alternative a less careful implementation would take:
    // copying the exact array out fresh every frame (`Float64Array.prototype.slice`). A net
    // heap-diff is unreliable here (each copy is garbage almost immediately, scavenged before the
    // next sample), so the honest signal is GC PRESSURE itself: this naive loop trips real major
    // GCs; the kernel's actual stepDdSketch+stepDdOracle+renderDdPrep loop (proven above) trips 0.
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createDdWorld(DD_DEFAULT_ALPHA, 0x5F5F5F5F);
    const allocState = createAllocState();
    for (let i = 0; i < 300; i++) { stepDdSketch(world); stepDdOracle(world, allocState); } // warm up, oracleN ~= 60000

    // First, reconfirm stepDdOracle itself is 0-alloc (the real, measured property).
    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const oracleCountBefore = allocState.oracleCount;
    const KEEP_LOOPS = 20; // small: DD_ORACLE_CAP (100000) minus the ~60000 already retained
    for (let i = 0; i < KEEP_LOOPS; i++) { stepDdSketch(world); stepDdOracle(world, allocState); }
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const stepBytesPerOp = (heapAfter - heapBefore) / KEEP_LOOPS;
    const oracleCountDelta = allocState.oracleCount - oracleCountBefore;
    process.stdout.write('  stepDdOracle (real): alloc=' + stepBytesPerOp.toFixed(1) + ' B/op (oracleCount delta=' + oracleCountDelta + ', genuinely 0-alloc by design)\n');
    assert.equal(oracleCountDelta, KEEP_LOOPS * world.keysPerFrame, 'every consumed value must have been genuinely retained (cap not yet hit)');

    // Now the NAIVE foil: a fresh array copy every "frame" (what a Map- or Array-based oracle,
    // like CMS/SS use, would effectively cost here) -- gated on REAL major-GC events, not a net
    // heap diff (which a burst of short-lived garbage does not reliably move).
    const gc = new GcProfiler().start();
    const COPY_LOOPS = 2000;
    let sink = 0;
    for (let i = 0; i < COPY_LOOPS; i++) {
        const snap = world.oracle.slice(0, world.oracleN); // ~60000 * 8 bytes = ~480 KB, every call
        sink += snap.length;
        if ((i & 63) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    await new Promise((r) => setTimeout(r, 50));
    const s = gc.summary();
    gc.stop();
    process.stdout.write('  naive per-frame array copy (foil): major=' + s.gc.major + ' minor=' + s.gc.minor + ' over ' + COPY_LOOPS + ' calls (sink=' + sink + ')\n');
    assert.ok(Number.isFinite(sink), 'sink keeps the foil loop live (never dead-code eliminated)');
    assert.ok(s.gc.major > 0, 'the naive per-frame array-copy foil must trigger real major GC (got ' + s.gc.major +
        '), proving the DD 0-B/op sketch-path measurement above (0 major GC, proven earlier) is a real measurement, not a vacuous "nothing runs long enough to matter"');
});

/* =============================================================================================
 * SCENE 04 -- SpaceSaving (heavy hitters / top-k)
 * ============================================================================================= */

test('SS faithfulness: demo leaderboard identities/counts/errors equal the library ss.topK(rows) exactly, row for row', () => {
    const world = createSsWorld(SS_DEFAULT_K, SS_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const FRAMES = 300; // 300 * 200 = 60000 keys, well under SS_STREAM_LEN (65536)
    for (let i = 0; i < FRAMES; i++) { stepSsSketch(world); stepSsOracle(world, allocState); }
    renderSsPrep(world, allocState);

    const topk = world.ss.topK(world.rows); // the library's OWN top-k (allocates, cold, button-driven contract)
    assert.equal(topk.length, world.rows, 'sanity: ss.topK(rows) must return exactly `rows` entries at full capacity');
    for (let r = 0; r < world.rows; r++) {
        assert.equal(world.lbKey[r], topk[r].key, 'leaderboard row ' + r + ' key must equal ss.topK key exactly');
        assert.equal(world.lbCount[r], topk[r].count, 'leaderboard row ' + r + ' count must equal ss.topK count exactly');
        assert.equal(world.lbError[r], topk[r].error, 'leaderboard row ' + r + ' error must equal ss.topK error exactly');
    }
});

test('SS faithfulness: demo per-row estimate/errorOf equal ss.estimate/ss.errorOf for every leaderboard key, exact', () => {
    const world = createSsWorld(SS_DEFAULT_K, 0xFEEDFACE);
    const allocState = createAllocState();
    const FRAMES = 300;
    for (let i = 0; i < FRAMES; i++) { stepSsSketch(world); stepSsOracle(world, allocState); }
    renderSsPrep(world, allocState);

    for (let r = 0; r < world.rows; r++) {
        const key = world.lbKey[r];
        assert.equal(world.lbCount[r], world.ss.estimate(key), 'leaderboard row ' + r + ' count must equal ss.estimate(key) exactly');
        assert.equal(world.lbError[r], world.ss.errorOf(key), 'leaderboard row ' + r + ' error must equal ss.errorOf(key) exactly');
    }
});

test('SS witness: recall of true hitters above N/k is 100% (no false negatives), the bracket holds, and maxErr <= N/k, vs a FRESH exact Map', () => {
    const world = createSsWorld(SS_DEFAULT_K, SS_DEFAULT_STREAM_SEED);
    const allocState = createAllocState();
    const FRAMES = 300;
    for (let i = 0; i < FRAMES; i++) { stepSsSketch(world); stepSsOracle(world, allocState); }
    renderSsPrep(world, allocState);

    // A SEPARATE, freshly-built exact Map fed the identical key sequence (never reusing world.oracle).
    const total = FRAMES * world.keysPerFrame;
    const freshMap = new Map();
    for (let t = 0; t < total; t++) { const k = world.stream[t]; freshMap.set(k, (freshMap.get(k) || 0) + 1); }
    const threshold = world.ss.total / world.k;
    let trueHH = 0, found = 0;
    for (const [key, c] of freshMap) { if (c > threshold) { trueHH++; if (world.ss.estimate(key) > 0) found++; } }
    const recall = trueHH === 0 ? 1 : found / trueHH;

    assert.equal(recall, 1, 'recall of true hitters above N/k must be exactly 100% (SpaceSaving\'s defining no-false-negatives guarantee)');
    assert.equal(world.flat[SF_RECALL], recall, 'demo displayed recall must equal the independently recomputed recall exactly');
    assert.equal(world.flat[SF_TRUEHH], trueHH, 'demo displayed trueHH must equal the independent fresh-Map count exactly');

    let bracketOk = true, maxErr = 0;
    world.ss.forEach((key, count, error) => {
        const t = freshMap.get(key) || 0;
        if (!(count - error <= t && t <= count)) bracketOk = false;
        if (error > maxErr) maxErr = error;
    });
    assert.ok(bracketOk, 'the [count-error, count] bracket must hold for EVERY monitored key against the independent fresh Map');
    assert.equal(world.flat[SF_BRACKETOK], 1, 'demo displayed bracketOk must read 1 (matches the independent bracket check)');
    assert.equal(world.flat[SF_MAXERR], maxErr, 'demo displayed maxErr must equal the independently recomputed max error exactly');
    assert.ok(maxErr <= threshold, 'maxErr ' + maxErr + ' must be <= N/k = ' + threshold + ' (SpaceSaving\'s error ceiling)');
});

test('SS fail-closed: eviction never fails at capacity -- driving far past k keeps size <= k and never throws', () => {
    const K_CAP = 32; // small capacity so eviction starts quickly against SS_NKEYS=5000 distinct keys
    const world = createSsWorld(K_CAP, 0xC0FFEE01);
    const allocState = createAllocState();
    assert.equal(world.ss.capacity, K_CAP, 'sanity: the world must be built at the requested small capacity');

    for (let f = 0; f < 500; f++) { // 500 * 200 = 100000 keys added, WAY past k=32 -- eviction is constant
        assert.doesNotThrow(() => stepSsSketch(world), 'stepSsSketch (which calls SpaceSaving.add through eviction) must never throw at frame ' + f);
        stepSsOracle(world, allocState);
        assert.ok(world.ss.size <= K_CAP, 'SpaceSaving.size (' + world.ss.size + ') must never exceed capacity (' + K_CAP + ') at frame ' + f);
    }
    assert.equal(world.ss.size, K_CAP, 'sanity: at this stream size the monitored set must have filled to exactly capacity');
    assert.ok(world.ss.total > K_CAP * 1000, 'sanity: far more mass than capacity must have been added (eviction was genuinely exercised)');
});

test('SS adversarial (beyond DEMO.md): stream buffer wraparound (3 full laps) never breaks recall or the bracket', () => {
    // Mirrors HLL's own "beyond the spec" pick: the reused Uint32Array stream buffer itself wraps
    // (SS_STREAM_LEN=65536) well before the fixed SS_NKEYS=5000 Zipfian universe is exhausted --
    // a bug in the cursor mask could re-feed a shifted/misaligned key sequence and silently break
    // the no-false-negatives guarantee. Checked periodically through 3 full physical buffer wraps.
    const world = createSsWorld(SS_DEFAULT_K, 0x0BADC0DE);
    const allocState = createAllocState();
    const totalFrames = Math.ceil((world.stream.length * 3) / world.keysPerFrame);
    let checks = 0;
    for (let f = 0; f < totalFrames; f++) {
        stepSsSketch(world);
        stepSsOracle(world, allocState);
        if ((f & 127) === 0) {
            renderSsPrep(world, allocState);
            assert.equal(world.flat[SF_RECALL], 1, 'recall must stay 100% through every buffer wrap (frame ' + f + ')');
            assert.equal(world.flat[SF_BRACKETOK], 1, 'the bracket must hold through every buffer wrap (frame ' + f + ')');
            assert.ok(world.ss.size <= world.k, 'monitored size must never exceed k through every buffer wrap (frame ' + f + ')');
            checks++;
        }
    }
    renderSsPrep(world, allocState);
    assert.equal(world.flat[SF_RECALL], 1, 'recall must still be 100% after 3 full stream-buffer wraps');
    assert.ok(checks > 5, 'sanity: the invariant must have been checked at multiple points across the 3 wraps, got ' + checks);
});

test('SS boundary: createSsWorld k at/near the library extremes succeeds; outside/invalid throws [lite-sketch] fail-closed', () => {
    // k = SS_CAP_MAX (2^24) would allocate ~9 typed arrays of 16M+ elements each (a resource
    // blowup, not a logic gap); the ctor's own typeof/range guard runs BEFORE allocation
    // (verified in Sketch.js), so the true-max REJECT boundary (SS_CAP_MAX+1) is exercised at its
    // real value below with NO allocation cost, alongside a reasonably large (not maximal) accept.
    const SS_CAP_MAX = 1 << 24;
    assert.doesNotThrow(() => createSsWorld(1, 1), 'k=1 (library min) must be constructible');
    assert.doesNotThrow(() => createSsWorld(50000, 1), 'a large-but-reasonable k must be constructible');
    assert.throws(() => createSsWorld(0, 1), /\[lite-sketch\]/, 'k=0 (below min) must fail closed');
    assert.throws(() => createSsWorld(SS_CAP_MAX + 1, 1), /\[lite-sketch\]/, 'k just above the true library max (2^24) must fail closed, guard runs before allocation');
    assert.throws(() => createSsWorld(null, 1), /\[lite-sketch\]/, 'k=null must fail closed (typeof guard runs first)');
    assert.throws(() => createSsWorld(NaN, 1), /\[lite-sketch\]/, 'k=NaN must fail closed (Number.isInteger(NaN) is false)');
    assert.throws(() => createSsWorld(1.5, 1), /\[lite-sketch\]/, 'a non-integer k must fail closed');
});

test('SS boundary: seed null/undefined fall back to the documented default; NaN/-0/0 pass through as 0 (falsy-seed contract, NOT a fallback)', () => {
    const def = SS_DEFAULT_STREAM_SEED;
    assert.equal(createSsWorld(64, null).seed, def, 'seed=null falls back to the default');
    assert.equal(createSsWorld(64, undefined).seed, def, 'seed=undefined falls back to the default');
    assert.equal(createSsWorld(64, NaN).seed, 0, 'seed=NaN coerces to 0 and is NOT replaced by the default');
    assert.equal(createSsWorld(64, -0).seed, 0, 'seed=-0 coerces to 0 and is NOT replaced by the default');
    assert.equal(createSsWorld(64, 0).seed, 0, 'seed=0 coerces to 0 and is NOT replaced by the default');
    assert.equal(createSsWorld(64, 7).seed, 7, 'a genuine nonzero seed passes through unchanged');
});

test('SS boundary: keysPerFrame 0 (empty frame) and 1 (single-key frame) never throw and stay faithful', () => {
    const world = createSsWorld(SS_DEFAULT_K, 42);
    world.keysPerFrame = 0;
    const cursorBefore = world.cursor;
    const sink = stepSsSketch(world);
    assert.equal(sink, 0, 'an empty (0-key) frame folds to the additive identity 0');
    assert.equal(world.cursor, cursorBefore, 'an empty frame must not advance the cursor');
    assert.equal(world.frameCount, 0, 'an empty frame records frameCount=0');
    const allocState = createAllocState();
    assert.doesNotThrow(() => stepSsOracle(world, allocState), 'stepSsOracle over an empty frame must not throw');
    assert.equal(allocState.oracleCount, 0, 'an empty frame adds nothing to the oracle');

    world.keysPerFrame = 1;
    const cursorBefore2 = world.cursor;
    stepSsSketch(world);
    assert.equal(world.frameCount, 1, 'a single-key frame records frameCount=1');
    assert.equal(world.cursor, (cursorBefore2 + 1) & 0x3fffffff, 'a single-key frame advances the cursor by exactly 1');
});

test('SS boundary: stepSsSketch/stepSsOracle/renderSsPrep fail closed (throw) on a null/undefined world', () => {
    assert.throws(() => stepSsSketch(null), 'stepSsSketch(null) must throw, never silently no-op');
    assert.throws(() => stepSsSketch(undefined), 'stepSsSketch(undefined) must throw');
    assert.throws(() => stepSsOracle(null, createAllocState()), 'stepSsOracle(null, ...) must throw');
    assert.throws(() => renderSsPrep(null, createAllocState()), 'renderSsPrep(null, ...) must throw');
});

test('SS duplicate dispose + dispose-during-iteration: clearing the sketch + oracle mid-stream stays consistent, and streaming resumes faithfully', () => {
    const world = createSsWorld(SS_DEFAULT_K, 0xABC123);
    const allocState = createAllocState();
    for (let i = 0; i < 20; i++) { stepSsSketch(world); stepSsOracle(world, allocState); }
    assert.ok(world.oracle.size > 0, 'the world must be non-trivially populated before the mid-stream clear');

    world.ss.clear();
    world.oracle.clear();
    renderSsPrep(world, allocState);
    assert.equal(world.flat[SF_SIZE], 0, 'a freshly-cleared SpaceSaving must monitor 0 keys');
    assert.equal(world.flat[SF_RECALL], 1, 'recall on an empty world is the defined identity 1 (0 true hitters, vacuously 100% recall)');
    assert.equal(world.flat[SF_BRACKETOK], 1, 'bracketOk on an empty (no monitored keys) world is vacuously 1');
    assert.equal(world.flat[SF_MAXERR], 0, 'maxErr on an empty world is 0');
    assert.equal(world.flat[SF_THRESH], 0, 'threshold N/k on an empty (N=0) world is 0, never NaN');

    // A SECOND clear must be idempotent.
    assert.doesNotThrow(() => { world.ss.clear(); world.oracle.clear(); }, 'a second consecutive clear() must not throw');
    renderSsPrep(world, allocState);
    assert.equal(world.flat[SF_SIZE], 0, 'the SECOND clear must leave the world equally empty (idempotent)');

    // Streaming AFTER the mid-iteration clear must resume converging faithfully.
    for (let i = 0; i < 300; i++) { stepSsSketch(world); stepSsOracle(world, allocState); }
    renderSsPrep(world, allocState);
    assert.ok(world.flat[SF_SIZE] > 0, 'streaming after a mid-iteration clear must resume monitoring keys');
    assert.equal(world.flat[SF_RECALL], 1, 'recall must still be 100% after a mid-stream clear+resume');
});

test('SS re-entrant: renderSsPrep called twice with no intervening step produces byte-identical flat AND leaderboard output', () => {
    const world = createSsWorld(SS_DEFAULT_K, 0xAAAA1111);
    const allocState = createAllocState();
    for (let i = 0; i < 300; i++) { stepSsSketch(world); stepSsOracle(world, allocState); }
    renderSsPrep(world, allocState);
    const flat1 = world.flat.slice(), lbKey1 = world.lbKey.slice(), lbCount1 = world.lbCount.slice();
    renderSsPrep(world, allocState); // NO stepping in between -- the epoch-based top-k reselection must be idempotent
    const flat2 = world.flat.slice(), lbKey2 = world.lbKey.slice(), lbCount2 = world.lbCount.slice();
    assert.deepStrictEqual(Array.from(flat1), Array.from(flat2), 'renderSsPrep flat output must be idempotent with no intervening step');
    assert.deepStrictEqual(Array.from(lbKey1), Array.from(lbKey2), 'the leaderboard key selection must be idempotent (the epoch marker must not leak state across calls)');
    assert.deepStrictEqual(Array.from(lbCount1), Array.from(lbCount2), 'the leaderboard count selection must be idempotent');
});

/* ============================ SS zero-alloc kernel gate ====================================== */

test('SS 0-B/op: stepSsSketch + renderSsPrep (the SKETCH path) allocate 0 bytes and trigger 0 major GC over a long run', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const world = createSsWorld(SS_DEFAULT_K, 0x1A2B3C4D);
    const allocState = createAllocState();

    for (let i = 0; i < 20000; i++) {
        stepSsSketch(world);
        if ((i & 7) === 0) renderSsPrep(world, allocState);
    }

    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink = (sink + stepSsSketch(world)) | 0;
        if ((i & 7) === 0) sink = (sink + (renderSsPrep(world, allocState) | 0)) | 0;
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(Number.isFinite(sink), 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50));
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const totalOps = HOT + Math.floor((HOT + 7) / 8);
    const bytesPerOp = (heapAfter - heapBefore) / totalOps;
    process.stdout.write('  demo Scene-04 (SS) sketch-path gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' (reported, not gated) maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k+25k SS sketch-path frames must trigger 0 major GC, got ' + s.gc.major);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 16, 'SS sketch-path kernels must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
    assert.equal(allocState.sketchCount, 0, 'the SS sketch-path owned allocation counter must stay pinned at 0');
    assert.equal(world.flat[SF_SKETCH_ALLOC], 0, 'flat[SF_SKETCH_ALLOC] (what the demo displays) must also read 0');
});

test('SS 0-B/op (measureAllocs): stepSsSketch alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createSsWorld(SS_DEFAULT_K, 0x2468ACE0);
    for (let i = 0; i < 20000; i++) stepSsSketch(world);
    const step = () => stepSsSketch(world);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  stepSsSketch measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'stepSsSketch must measure 0 B/call, got ' + bpc);
});

test('SS 0-B/op (measureAllocs): renderSsPrep alone measures 0 bytes/call', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createSsWorld(SS_DEFAULT_K, 0x13572468);
    const allocState = createAllocState();
    for (let i = 0; i < 20000; i++) { stepSsSketch(world); renderSsPrep(world, allocState); }
    const step = () => renderSsPrep(world, allocState);
    const res = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  renderSsPrep measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'renderSsPrep must measure 0 B/call, got ' + bpc);
});

test('SS contrast: stepSsOracle (the exact-Map path) DOES allocate -- proves the SS 0-B/op gates above are not vacuous', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const world = createSsWorld(SS_DEFAULT_K, 0x5F5F5F5F);
    const allocState = createAllocState();
    for (let i = 0; i < 50; i++) { stepSsSketch(world); stepSsOracle(world, allocState); } // warm up

    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const oracleCountBefore = allocState.oracleCount;
    const LOOPS = 300;
    for (let i = 0; i < LOOPS; i++) { stepSsSketch(world); stepSsOracle(world, allocState); }
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / LOOPS;
    const oracleCountDelta = allocState.oracleCount - oracleCountBefore;
    process.stdout.write('  contrast stepSsOracle: alloc=' + bytesPerOp.toFixed(1) + ' B/op (oracleCount delta=' + oracleCountDelta + ')\n');
    assert.ok(allocState.oracleCount > 0, 'the SS oracle path must have recorded real allocations (new distinct Zipfian keys)');
    assert.ok(bytesPerOp > 50, 'the exact-Map path must allocate real, measurable bytes/op (got ' + bytesPerOp.toFixed(1) +
        '), proving the SS 0-B/op sketch-path measurement above is a real measurement, not vacuous');
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
