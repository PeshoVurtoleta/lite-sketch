// @zakkster/lite-sketch -- demo Scene-01 hot kernels (repo-only dev artifact, NEVER shipped).
//
// Pure, zero-allocation-after-warmup math driving the "HyperLogLog cardinality" scene, plus a
// world factory that wraps the REAL shipped HyperLogLog + an exact `Set` oracle so the demo can
// never drift from the library it demonstrates. Imported by BOTH:
//   - demo/index.html    (the browser rAF loop -- the visualization state IS these classes)
//   - demo/Demo.test.mjs (the honesty gate -- faithfulness + witness + version-trinity + 0-B/op)
//
// The two non-negotiables (DEMO.md section 0):
//   1. The SKETCH path is zero-GC. `stepSketch` + `renderPrep` allocate NOTHING after warmup;
//      Demo.test.mjs gates them at 0 B/op. The ONLY code allowed to allocate is `stepOracle`
//      (the exact Set foil) -- that is the contrast, and it bumps the owned-allocation counter.
//   2. Every accuracy / space number is re-derived LIVE from the shipped `Sketch.js` against the
//      in-tab exact `Set` oracle -- never hardcoded, never faked.
// ASCII-only per suite law ("us" for microseconds, "->", "<=", "x" -- never Unicode).

import { HyperLogLog, VERSION } from '../Sketch.js';

// Re-export the SHIPPED VERSION so index.html and Demo.test.mjs read the one true source
// (never a hardcoded string -- the version-trinity test in Demo.test.mjs gates this).
export { VERSION };

// ---- tunables (topology + stream) -----------------------------------------------------
/** Pre-generated key-stream length (a power of two so a `& mask` cursor never allocates). */
export const HLL_STREAM_LEN = 1 << 16;      // 65536 keys held in one reused Uint32Array
/** Keys streamed per rAF frame (drives how fast the true distinct count climbs to cardinality). */
export const HLL_KEYS_PER_FRAME = 128;
/** Exact-oracle cap (DEMO.md section 10 call 4): keep the tab alive; the sketch would keep going. */
export const HLL_ORACLE_CAP = 60000;
/** Odd multiplier for the key-scramble bijection (Knuth) -- injective in i, so keys stay distinct. */
export const HLL_SCRAMBLE_ODD = 2654435761;
/** Default stream seed if the caller passes 0. */
export const HLL_DEFAULT_STREAM_SEED = 0x51ed270b;
/** A Set of numbers: ~8 bytes/entry lower bound (references + slots are more) -- matches witness.mjs. */
export const HLL_ORACLE_BYTES_PER_ENTRY = 8;
/** Default precision p and stream cardinality (hooked into the sliders at init). */
export const HLL_DEFAULT_P = 11;
export const HLL_DEFAULT_CARD = 20000;

// ---- flat render-prep buffer layout (the Truth Panel reads these at ~10Hz) -------------
// A single reused Float64Array: renderPrep WRITES every displayed number here (typed-array
// stores never box a HeapNumber), and the draw / telemetry paths only READ it. Indices are
// exported so Demo.test.mjs can assert against them by name.
export const F_EST = 0;            // HyperLogLog.count() estimate
export const F_TRUE = 1;           // exact Set.size (the oracle truth)
export const F_RELERR = 2;         // |est - true| / true
export const F_STDERR = 3;         // theoretical std err 1.04 / sqrt(m)
export const F_SKETCH_BYTES = 4;   // fixed: m bytes (1 byte / register)
export const F_SET_BYTES = 5;      // climbing: true * ~8 bytes / entry
export const F_M = 6;              // register count m = 2^p
export const F_P = 7;             // precision p
export const F_RELERR_FRAC = 8;    // relerr / stderr -- the accuracy cursor position (inside band <= 1)
export const F_MAXREG = 9;         // max register value (heat-grid normalization)
export const F_SKETCH_ALLOC = 10;  // owned allocation counter, SKETCH path (provably 0 after warmup)
export const F_ORACLE_ALLOC = 11;  // owned allocation counter, exact-Set path (climbs)
export const HLL_FLAT_LEN = 12;

/**
 * The key-scramble bijection: maps stream index i -> a distinct uint32 key, seeded so different
 * seeds give different key sets. Multiply-by-odd is injective in i (bijective on uint32), and xor
 * with a constant is bijective, so the first `cardinality` values are all distinct -> the exact
 * Set converges to EXACTLY `cardinality` entries. Used by both fillStream and mergeShards so the
 * shards partition the same key set the single sketch sees (the merge-faithfulness proof). 0-alloc.
 * @param {number} i     stream index (integer)
 * @param {number} seed  uint32 stream seed
 * @returns {number} a uint32 key
 */
export function scramble(i, seed) {
    return (Math.imul(i, HLL_SCRAMBLE_ODD) ^ (seed | 0)) >>> 0;
}

/**
 * Fill the world's reused stream buffer with `cardinality` distinct keys cycled over its full
 * length. Called at warmup and on a topology change (a new p / cardinality) -- NEVER per frame.
 * stream[i] = scramble(i % cardinality, seed): the first `cardinality` reads are all-distinct,
 * so the true count climbs to `cardinality` then plateaus (the honest witness settling). 0-alloc.
 * @param {object} world
 */
export function fillStream(world) {
    const stream = world.stream, len = stream.length, card = world.cardinality, seed = world.seed;
    for (let i = 0; i < len; i++) stream[i] = scramble(i % card, seed);
}

/**
 * Build the Scene-01 world ONCE (warmup / topology change). Allocates the REAL HyperLogLog, the
 * exact Set oracle, the reused key-stream Uint32Array, and the flat render-prep Float64Array, then
 * fills the stream. Fails closed on a bad p via HyperLogLog's own constructor guard.
 * @param {number} p            precision (m = 2^p) -- HyperLogLog validates [4, 18]
 * @param {number} cardinality  target true distinct count (clamped to the stream / oracle caps)
 * @param {number} [seed]       uint32 stream + hash seed
 */
export function createHllWorld(p, cardinality, seed) {
    const s = (seed >>> 0) || HLL_DEFAULT_STREAM_SEED;
    const hll = new HyperLogLog(p, s);
    const card = Math.max(1, Math.min(cardinality | 0, HLL_STREAM_LEN, HLL_ORACLE_CAP));
    const world = {
        hll,
        oracle: new Set(),
        oracleCap: HLL_ORACLE_CAP,
        stream: new Uint32Array(HLL_STREAM_LEN),
        streamMask: HLL_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        keysPerFrame: HLL_KEYS_PER_FRAME,
        p, cardinality: card, seed: s,
        flat: new Float64Array(HLL_FLAT_LEN),
    };
    fillStream(world);
    return world;
}

/**
 * Fresh owned-allocation state: two counters we increment ourselves (Truth Panel PRIMARY #2). The
 * SKETCH path never touches `sketchCount` (it stays 0 -- the whole claim); the exact-Set path bumps
 * `oracleCount` once per genuinely-new key it inserts (a REAL count of REAL allocations).
 */
export function createAllocState() {
    return { sketchCount: 0, oracleCount: 0 };
}

/**
 * One SKETCH-path frame: advance the cursor `keysPerFrame` keys over the pre-generated stream and
 * feed each to the REAL HyperLogLog.add (0 B/op, proven by test/torture.mjs). Records the frame's
 * consumed [start, count) range (masked) so the oracle can replay EXACTLY the same keys -- the
 * faithfulness contract. The cursor is masked to 30 bits (SMI-safe, a multiple of the stream
 * length) so `world.cursor = ...` never boxes a HeapNumber, keeping this provably 0 B/op forever.
 * Demo.test.mjs gates this at 0 B/op with the lite-gc-profiler measureAllocs approach.
 * @param {object} world
 * @returns {number} an int32 fold of the keys added (so the loop is never dead-code-eliminated)
 */
export function stepSketch(world) {
    const stream = world.stream, mask = world.streamMask, hll = world.hll, kpf = world.keysPerFrame;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        const key = stream[pos & mask];
        hll.add(key);
        sink = (sink + key) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;   // wrap inside SMI range; low `mask` bits preserved (pow2 divides 2^30)
    world.frameCount = kpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate contrast): replay the keys `stepSketch` just
 * consumed into the exact Set and bump the owned allocation counter once per genuinely-new key.
 * This is the ONLY per-frame code that allocates -- it exists so the sketch path's provable 0 is
 * legible against something that visibly climbs. Fails closed on the oracle cap (Section 10 call 4).
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the Set size after this frame (folded)
 */
export function stepOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask, set = world.oracle;
    const cap = world.oracleCap, start = world.frameStart, count = world.frameCount;
    for (let i = 0; i < count; i++) {
        if (set.size >= cap) break;
        const key = stream[(start + i) & mask];
        const before = set.size;
        set.add(key);                          // the allocation the sketch path refuses
        if (set.size !== before) allocState.oracleCount++;
    }
    return set.size;
}

/**
 * Render-prep (~10Hz, NOT per frame): re-derive every displayed number from the SHIPPED HyperLogLog
 * against the exact Set oracle and write them into the reused flat Float64Array. Calls the COLD
 * `count()` (O(m), reuses the sketch's own _hist, 0 alloc -- a disclosed co-headline, never per-add)
 * and scans the register bank once for the heat-grid max. Every write is a typed-array store (no
 * boxed HeapNumber), so renderPrep is itself 0 B/op -- Demo.test.mjs gates it alongside stepSketch.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the estimate (folded)
 */
export function renderPrep(world, allocState) {
    const hll = world.hll, flat = world.flat, reg = hll._reg, m = hll.m;
    const est = hll.count();
    const trueN = world.oracle.size;
    let maxReg = 0;
    for (let i = 0; i < m; i++) { const v = reg[i]; if (v > maxReg) maxReg = v; }
    const relerr = trueN > 0 ? Math.abs(est - trueN) / trueN : 0;
    const stderr = hll.standardError;
    flat[F_EST] = est;
    flat[F_TRUE] = trueN;
    flat[F_RELERR] = relerr;
    flat[F_STDERR] = stderr;
    flat[F_SKETCH_BYTES] = m;                               // 1 byte per register, FIXED
    flat[F_SET_BYTES] = trueN * HLL_ORACLE_BYTES_PER_ENTRY; // climbs O(distinct)
    flat[F_M] = m;
    flat[F_P] = hll.p;
    flat[F_RELERR_FRAC] = stderr > 0 ? relerr / stderr : 0;
    flat[F_MAXREG] = maxReg;
    flat[F_SKETCH_ALLOC] = allocState.sketchCount;          // provably 0
    flat[F_ORACLE_ALLOC] = allocState.oracleCount;          // climbing
    return est;
}

/**
 * Merge action (cold, button-driven -- allocation fine): split the FULL cardinality key set into
 * two shards (even / odd stream index), give each its own HyperLogLog (same p + seed), then
 * `merge()` by register-wise max. Also builds a single HyperLogLog over the whole key set. The
 * union count MUST match the single count (the mergeability proof), because both cover the exact
 * same distinct keys via `scramble`. Uses the REAL HyperLogLog.merge -- never a hand-rolled union.
 * @param {object} world
 * @returns {{single:number, merged:number, card:number}}
 */
export function mergeShards(world) {
    const p = world.p, seed = world.seed, card = world.cardinality;
    const a = new HyperLogLog(p, seed);
    const b = new HyperLogLog(p, seed);
    const single = new HyperLogLog(p, seed);
    for (let j = 0; j < card; j++) {
        const key = scramble(j, seed);
        single.add(key);
        if (j & 1) b.add(key); else a.add(key);
    }
    a.merge(b);
    return { single: single.count(), merged: a.count(), card };
}

/**
 * Merge-mismatch action (cold, button-driven): attempt to merge a DIFFERENT-seed HyperLogLog into
 * the live sketch. The 1.0.0 fail-closed seed check MUST throw (a differently-seeded HLL hashes the
 * same key to a different register). Returns the real thrown message for the demo to flash.
 * @param {object} world
 * @returns {{threw:boolean, message:string}}
 */
export function mergeMismatch(world) {
    const other = new HyperLogLog(world.p, (world.seed ^ 0x9e3779b1) >>> 0);
    other.add(1); other.add(2); other.add(3);
    try {
        world.hll.merge(other);
        return { threw: false, message: '' };
    } catch (e) {
        return { threw: true, message: String((e && e.message) || e) };
    }
}
