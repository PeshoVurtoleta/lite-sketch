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

import { HyperLogLog, CountMinSketch, DDSketch, SpaceSaving, VERSION } from '../Sketch.js';

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
    // null is not zero: fall back ONLY on undefined/null so an explicit seed=0 is honored.
    const s = (seed === undefined || seed === null) ? HLL_DEFAULT_STREAM_SEED : (seed >>> 0);
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

// =======================================================================================
// Shared stream generators (WARMUP-only; allocation is fine here, NEVER per frame)
// =======================================================================================

/** A small deterministic mulberry32 PRNG (matches test/witness.mjs). Cold, warmup-only. */
function makeRng(seed) {
    let s = seed >>> 0;
    return function rng() {
        s = (s + 0x6d2b79f5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Fill a world's reused Uint32Array stream with Zipfian keys over ranks [0, nKeys) at the
 * world's skew (harmonic-CDF binary search -- the same shape witness.mjs uses). The scratch
 * harmonic table is a warmup temp (freed after); the stream itself is the reused per-frame
 * buffer. Called at warmup + on a topology change, NEVER per frame.
 * @param {object} world
 */
function fillZipfStream(world) {
    const stream = world.stream, len = stream.length, nKeys = world.nKeys, skew = world.skew;
    const rng = makeRng(world.seed);
    const harm = new Float64Array(nKeys);
    let sum = 0;
    for (let i = 1; i <= nKeys; i++) { sum += 1 / Math.pow(i, skew); harm[i - 1] = sum; }
    const total = sum;
    for (let n = 0; n < len; n++) {
        const target = rng() * total;
        let lo = 0, hi = nKeys - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (harm[mid] < target) lo = mid + 1; else hi = mid; }
        stream[n] = lo;
    }
}

// =======================================================================================
// Murmur mirror (VISUALIZATION ONLY) -- lets the demo recompute a key's probed cells so the
// canvas can light the exact d cells the library touches. The ANSWER (estimate / quantile /
// topK) is ALWAYS taken from the shipped class; this only re-derives cell POSITIONS. Pure
// int32 locals (identical math to Sketch.js), so the render-prep tick stays 0 B/op.
// =======================================================================================

const _HASH_C1 = 0xcc9e2d51 | 0;
const _HASH_C2 = 0x1b873593 | 0;
const _FMIX_C1 = 0x85ebca6b | 0;
const _FMIX_C2 = 0xc2b2ae35 | 0;
const _LANE_SALT = 0x85ebca6b | 0;
const _ODD_CONST = 0x9e3779b1 | 0;

function _m3round(h, k) {
    k = Math.imul(k, _HASH_C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, _HASH_C2);
    h = h ^ k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    return h;
}

function _m3final(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, _FMIX_C1);
    h = h ^ (h >>> 13);
    h = Math.imul(h, _FMIX_C2);
    h = h ^ (h >>> 16);
    return h;
}

/** The CountMinSketch base lane (h ^ g) for a numeric key + seed -- mirrors Sketch.js exactly. */
function _cmsBase(key, seed) {
    let a = key, neg = 0;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;
    const hiw = a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0);
    const s = seed;
    let h = s;
    h = _m3round(h, lo);
    h = _m3round(h, hiw ^ neg);
    h = _m3final(h ^ 8);
    let g = s ^ _LANE_SALT;
    g = _m3round(g, lo);
    g = _m3round(g, hiw ^ neg);
    g = _m3final(g ^ 8);
    return (h ^ g) | 0;
}

// =======================================================================================
// Scene 02 -- CountMinSketch (frequency)
// =======================================================================================

/** Pre-generated Zipfian key stream length (pow2 so a `& mask` cursor never allocates). */
export const CMS_STREAM_LEN = 1 << 16;
/** Keys streamed per rAF frame (into BOTH the conservative and the plain matrix). */
export const CMS_KEYS_PER_FRAME = 200;
/** Distinct key universe for the Zipfian stream. */
export const CMS_NKEYS = 4000;
/** Zipfian skew (heavier tail -> a sharper conservative-vs-plain contrast). */
export const CMS_SKEW = 1.1;
/** How many hot query keys the demo cycles through (the probed key). */
export const CMS_QKEY_COUNT = 4;
/** 10Hz ticks between advancing the cycled query key (~1.5s per key). */
export const CMS_QTICKS = 15;
/** Default stream + hash seed. */
export const CMS_DEFAULT_STREAM_SEED = 0x1a2b3c4d;
/** A Map<number,number> entry: ~32 B/entry lower bound (matches witness.mjs). */
export const CMS_MAP_BYTES_PER_ENTRY = 32;
/** Default topology (d rows x w cols). */
export const CMS_DEFAULT_D = 4;
export const CMS_DEFAULT_W = 256;

// flat render-prep layout (the Truth Panel reads these at ~10Hz)
export const CF_EST = 0;            // estimate(qkey): the returned MIN-of-d over-estimate
export const CF_TRUE = 1;           // exact Map count for qkey
export const CF_GAP = 2;            // est - true (the one-sided over-estimate, >= 0)
export const CF_BOUND = 3;          // eps * N (the theoretical gap ceiling)
export const CF_GAPFRAC = 4;        // gap / bound -- the accuracy cursor (must be <= 1)
export const CF_EPS = 5;            // epsilon = e / w
export const CF_N = 6;              // total added (N)
export const CF_SKETCH_BYTES = 7;   // fixed: d * w * 4
export const CF_MAP_BYTES = 8;      // climbing: distinct * ~32
export const CF_D = 9;
export const CF_W = 10;
export const CF_MAXCELL = 11;       // max counter value (heat-grid normalization)
export const CF_QKEY = 12;          // the cycled query key
export const CF_SKETCH_ALLOC = 13;  // sketch owned-alloc counter (pinned 0)
export const CF_ORACLE_ALLOC = 14;  // exact-Map owned-alloc counter (climbs)
export const CF_DISTINCT = 15;      // distinct keys seen (Map size)
export const CMS_FLAT_LEN = 16;

/**
 * Build the Scene-02 world ONCE (warmup / topology change). Two REAL CountMinSketch matrices
 * (conservative + plain) over the SAME stream so the toggle can show conservative tightening
 * the over-estimate, an exact Map oracle, the reused Zipfian stream, and the flat buffer.
 * @param {number} d depth (rows)   -- CountMinSketch validates [1, 32]
 * @param {number} w width (cols)   -- rounded up to a power of two by the ctor
 * @param {number} [seed] uint32 stream + hash seed
 */
export function createCmsWorld(d, w, seed) {
    const s = (seed === undefined || seed === null) ? CMS_DEFAULT_STREAM_SEED : (seed >>> 0);
    const cms = new CountMinSketch(d, w, { seed: s | 0, conservative: true });
    const cmsPlain = new CountMinSketch(d, w, { seed: s | 0, conservative: false });
    const world = {
        cms, cmsPlain, conservative: true, active: cms,
        oracle: new Map(),
        stream: new Uint32Array(CMS_STREAM_LEN),
        streamMask: CMS_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        keysPerFrame: CMS_KEYS_PER_FRAME,
        d, w: cms.w, seed: s,
        nKeys: CMS_NKEYS, skew: CMS_SKEW,
        probe: new Int32Array(d), probeMin: 0,
        qKeys: new Int32Array(CMS_QKEY_COUNT), qIndex: 0, qTick: 0,
        flat: new Float64Array(CMS_FLAT_LEN),
    };
    fillZipfStream(world);
    for (let i = 0; i < CMS_QKEY_COUNT; i++) world.qKeys[i] = i;   // hottest ranks
    return world;
}

/**
 * One SKETCH-path frame: advance the cursor `keysPerFrame` keys and feed each to BOTH the REAL
 * conservative and plain CountMinSketch (both add() are 0 B/op). Records the frame's consumed
 * range so the oracle replays EXACTLY the same keys. 0 B/op.
 * @param {object} world
 * @returns {number} a fold of the keys (so the loop is never DCE'd)
 */
export function stepCmsSketch(world) {
    const stream = world.stream, mask = world.streamMask, kpf = world.keysPerFrame;
    const cms = world.cms, plain = world.cmsPlain;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        const key = stream[pos & mask];
        cms.add(key);
        plain.add(key);
        sink = (sink + key) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.frameCount = kpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (allowed to allocate): replay the frame's keys into the exact Map and
 * bump the owned allocation counter once per genuinely-new key (a REAL allocation). The ONLY
 * per-frame code that allocates in this scene.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the Map size after this frame
 */
export function stepCmsOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask, map = world.oracle;
    const start = world.frameStart, count = world.frameCount;
    for (let i = 0; i < count; i++) {
        const key = stream[(start + i) & mask];
        const c = map.get(key);
        if (c === undefined) { map.set(key, 1); allocState.oracleCount++; }  // a new entry allocates
        else map.set(key, c + 1);
    }
    return map.size;
}

/**
 * Render-prep (~10Hz, NOT per frame): re-derive every displayed CMS number LIVE from the active
 * shipped matrix vs the exact Map, and stage the d probed cells for the canvas. 0 B/op (the
 * probe re-hash is pure int32; estimate / Map.get allocate nothing).
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the estimate (folded)
 */
export function renderCmsPrep(world, allocState) {
    const active = world.conservative ? world.cms : world.cmsPlain;
    world.active = active;
    const flat = world.flat, d = active.d, w = active.w, mask = w - 1;
    // advance the cycled query key slowly
    world.qTick++;
    if (world.qTick >= CMS_QTICKS) { world.qTick = 0; world.qIndex = (world.qIndex + 1) % world.qKeys.length; }
    const qkey = world.qKeys[world.qIndex];
    // probed cells (VISUALIZATION mirror of the library's row hash) + the MIN row
    const base = _cmsBase(qkey, active.seed);
    const counts = active._counts;
    let mn = 0xffffffff, mnRow = 0;
    for (let i = 0; i < d; i++) {
        const x = _m3final((base ^ Math.imul(i, _ODD_CONST)) | 0);
        const id = i * w + (x & mask);
        world.probe[i] = id;
        const v = counts[id];
        if (v < mn) { mn = v; mnRow = i; }
    }
    world.probeMin = mnRow;
    const est = active.estimate(qkey);       // the ANSWER, from the shipped class (== mn)
    const c = world.oracle.get(qkey);
    const trueC = c === undefined ? 0 : c;
    const N = active.total;
    const eps = active.epsilon;
    const bound = eps * N;
    const gap = est - trueC;
    let maxCell = 0;
    const n = counts.length;
    for (let i = 0; i < n; i++) { const v = counts[i]; if (v > maxCell) maxCell = v; }
    flat[CF_EST] = est;
    flat[CF_TRUE] = trueC;
    flat[CF_GAP] = gap;
    flat[CF_BOUND] = bound;
    flat[CF_GAPFRAC] = bound > 0 ? gap / bound : 0;
    flat[CF_EPS] = eps;
    flat[CF_N] = N;
    flat[CF_SKETCH_BYTES] = d * w * 4;
    flat[CF_MAP_BYTES] = world.oracle.size * CMS_MAP_BYTES_PER_ENTRY;
    flat[CF_D] = d;
    flat[CF_W] = w;
    flat[CF_MAXCELL] = maxCell;
    flat[CF_QKEY] = qkey;
    flat[CF_SKETCH_ALLOC] = allocState.sketchCount;
    flat[CF_ORACLE_ALLOC] = allocState.oracleCount;
    flat[CF_DISTINCT] = world.oracle.size;
    return est;
}

// =======================================================================================
// Scene 03 -- DDSketch (quantiles / p99)
// =======================================================================================

export const DD_STREAM_LEN = 1 << 16;
export const DD_KEYS_PER_FRAME = 200;
/** Exact-oracle cap (DEMO.md section 10 call 4): keep the tab alive; the sketch keeps going. */
export const DD_ORACLE_CAP = 100000;
export const DD_DEFAULT_ALPHA = 0.02;
/** Lognormal latency parameters: exp(mu + sigma * gaussian) (a realistic long-tailed latency). */
export const DD_LOG_MU = 5;
export const DD_LOG_SIGMA = 1.0;
export const DD_DEFAULT_STREAM_SEED = 0x2b7e1516;

export const DF_P50 = 0, DF_P90 = 1, DF_P99 = 2;      // sketch quantiles
export const DF_T50 = 3, DF_T90 = 4, DF_T99 = 5;      // exact-oracle quantiles
export const DF_E50 = 6, DF_E90 = 7, DF_E99 = 8;      // relative errors
export const DF_F50 = 9, DF_F90 = 10, DF_F99 = 11;    // relerr / alpha (must be <= 1 -- HARD cap)
export const DF_ALPHA = 12, DF_GAMMA = 13;
export const DF_SKETCH_BYTES = 14;                    // fixed: maxBins * 8
export const DF_ARR_BYTES = 15;                       // climbing: oracleN * 8
export const DF_N = 16, DF_ORACLEN = 17;
export const DF_COLLAPSED = 18;                       // 1 if any collapsing-lowest has happened
export const DF_MIN = 19, DF_MAX = 20;               // EXACT min/max (not bucketed)
export const DF_MAXBINPOP = 21;                      // tallest bin (histogram normalization)
export const DF_NUMBINS = 22;                        // populated bin count
export const DF_SKETCH_ALLOC = 23, DF_ORACLE_ALLOC = 24;
export const DF_M50 = 25, DF_M90 = 26, DF_M99 = 27;  // physical bin index of each marker
export const DF_LOWBIN = 28;                         // lowest populated physical bin (histogram view floor)
export const DF_TOPBIN = 29;                         // highest populated physical bin (maxKeyPop - offset)
export const DD_FLAT_LEN = 30;

/** Fill the reused stream with lognormal latencies (Box-Muller). Warmup / topology change only. */
function fillLognormalStream(world) {
    const stream = world.stream, len = stream.length;
    const rng = makeRng(world.seed);
    let spare = null;
    for (let n = 0; n < len; n++) {
        let g;
        if (spare !== null) { g = spare; spare = null; }
        else {
            let u1 = rng(); if (u1 < 1e-12) u1 = 1e-12;
            const u2 = rng();
            const r = Math.sqrt(-2 * Math.log(u1));
            const th = 2 * Math.PI * u2;
            spare = r * Math.sin(th);
            g = r * Math.cos(th);
        }
        stream[n] = Math.exp(DD_LOG_MU + DD_LOG_SIGMA * g);
    }
}

/**
 * Build the Scene-03 world ONCE. The REAL DDSketch (collapsing-lowest default), an exact sorted
 * Float64Array oracle CAPPED at DD_ORACLE_CAP (labeled in the panel), the reused lognormal
 * stream, and the flat buffer.
 * @param {number} alpha  relative accuracy in (0, 1) -- DDSketch validates
 * @param {number} [seed] uint32 stream seed
 */
export function createDdWorld(alpha, seed) {
    const s = (seed === undefined || seed === null) ? DD_DEFAULT_STREAM_SEED : (seed >>> 0);
    const dd = new DDSketch(alpha);
    const world = {
        dd,
        oracle: new Float64Array(DD_ORACLE_CAP),   // sorted in place at 10Hz; real values live at the TOP
        oracleN: 0, oracleCap: DD_ORACLE_CAP, sortedDirty: true,
        stream: new Float64Array(DD_STREAM_LEN),
        streamMask: DD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        keysPerFrame: DD_KEYS_PER_FRAME,
        alpha, seed: s,
        flat: new Float64Array(DD_FLAT_LEN),
    };
    fillLognormalStream(world);
    return world;
}

/**
 * One SKETCH-path frame: feed `keysPerFrame` lognormal latencies to the REAL DDSketch (add is
 * 0 B/op). 0 B/op.
 * @param {object} world
 * @returns {number} a fold (defeat DCE)
 */
export function stepDdSketch(world) {
    const stream = world.stream, mask = world.streamMask, dd = world.dd, kpf = world.keysPerFrame;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        const v = stream[pos & mask];
        dd.add(v);
        sink = (sink + (v | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.frameCount = kpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (allowed to allocate in spirit -- it RETAINS every sample the sketch
 * refuses to): append the frame's values to the sorted-array oracle up to the cap and bump the
 * owned allocation counter once per retained sample (each is 8 bytes the exact oracle must keep;
 * the sketch keeps NONE). Marks the oracle dirty so the 10Hz tick re-sorts.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the oracle sample count
 */
export function stepDdOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask, arr = world.oracle, cap = world.oracleCap;
    const start = world.frameStart, count = world.frameCount;
    let n = world.oracleN;
    for (let i = 0; i < count; i++) {
        if (n >= cap) break;
        arr[n++] = stream[(start + i) & mask];
        allocState.oracleCount++;               // a retained sample the sketch would not store
    }
    if (n !== world.oracleN) world.sortedDirty = true;
    world.oracleN = n;
    return n;
}

/**
 * Render-prep (~10Hz): re-sort the capped oracle in place (0 B/op), re-derive the exact p50/p90/
 * p99, pull the sketch's own p50/p90/p99 from the SHIPPED DDSketch.quantile, compute each error
 * as a fraction of alpha (the HARD cap), and stage the histogram + marker bins. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} p99 (folded)
 */
export function renderDdPrep(world, allocState) {
    const dd = world.dd, flat = world.flat, arr = world.oracle, cap = world.oracleCap;
    const oracleN = world.oracleN;
    if (world.sortedDirty) { arr.sort(); world.sortedDirty = false; }  // in-place typed sort, 0 alloc
    // all values are > 0, so the unused tail zeros sort to the FRONT; real values live at [off0, cap)
    const off0 = cap - oracleN;
    const t50 = oracleN > 0 ? arr[off0 + Math.floor(0.5 * (oracleN - 1))] : NaN;
    const t90 = oracleN > 0 ? arr[off0 + Math.floor(0.9 * (oracleN - 1))] : NaN;
    const t99 = oracleN > 0 ? arr[off0 + Math.floor(0.99 * (oracleN - 1))] : NaN;
    const p50 = dd.quantile(0.5);
    const p90 = dd.quantile(0.9);
    const p99 = dd.quantile(0.99);
    const alpha = dd.alpha;
    const e50 = t50 > 0 ? Math.abs(p50 - t50) / t50 : 0;
    const e90 = t90 > 0 ? Math.abs(p90 - t90) / t90 : 0;
    const e99 = t99 > 0 ? Math.abs(p99 - t99) / t99 : 0;
    // histogram scan + marker bins (physical indices) -- all from live internals
    const bins = dd._bins, offset = dd._offset, mult = dd._multiplier, maxBins = dd._maxBins;
    const top = dd._binCount === 0 ? -1 : dd._maxKeyPop - offset;
    let maxBinPop = 0, numBins = 0, lowBin = top;
    for (let i = 0; i <= top; i++) {
        const v = bins[i];
        if (v !== 0) { numBins++; if (i < lowBin) lowBin = i; }
        if (v > maxBinPop) maxBinPop = v;
    }
    if (numBins === 0) lowBin = 0;
    flat[DF_P50] = p50; flat[DF_P90] = p90; flat[DF_P99] = p99;
    flat[DF_T50] = t50; flat[DF_T90] = t90; flat[DF_T99] = t99;
    flat[DF_E50] = e50; flat[DF_E90] = e90; flat[DF_E99] = e99;
    flat[DF_F50] = alpha > 0 ? e50 / alpha : 0;
    flat[DF_F90] = alpha > 0 ? e90 / alpha : 0;
    flat[DF_F99] = alpha > 0 ? e99 / alpha : 0;
    flat[DF_ALPHA] = alpha;
    flat[DF_GAMMA] = dd._gamma;
    flat[DF_SKETCH_BYTES] = dd.maxBins * 8;
    flat[DF_ARR_BYTES] = oracleN * 8;
    flat[DF_N] = dd.count;
    flat[DF_ORACLEN] = oracleN;
    flat[DF_COLLAPSED] = dd.collapsed ? 1 : 0;
    flat[DF_MIN] = dd.min;
    flat[DF_MAX] = dd.max;
    flat[DF_MAXBINPOP] = maxBinPop;
    flat[DF_NUMBINS] = numBins;
    flat[DF_SKETCH_ALLOC] = allocState.sketchCount;
    flat[DF_ORACLE_ALLOC] = allocState.oracleCount;
    flat[DF_M50] = p50 > 0 ? Math.ceil(Math.log(p50) * mult) - offset : -1;
    flat[DF_M90] = p90 > 0 ? Math.ceil(Math.log(p90) * mult) - offset : -1;
    flat[DF_M99] = p99 > 0 ? Math.ceil(Math.log(p99) * mult) - offset : -1;
    flat[DF_LOWBIN] = lowBin;
    flat[DF_TOPBIN] = top < 0 ? 0 : top;
    return p99;
}

// =======================================================================================
// Scene 04 -- SpaceSaving (heavy hitters / top-k)
// =======================================================================================

export const SS_STREAM_LEN = 1 << 16;
export const SS_KEYS_PER_FRAME = 200;
export const SS_NKEYS = 5000;
export const SS_SKEW = 1.2;
/** Leaderboard rows drawn on the canvas (top-k by count). */
export const SS_ROWS = 12;
export const SS_DEFAULT_STREAM_SEED = 0x3243f6a8;
/** A Map<number,number> entry (key + count) lower bound, matching witness.mjs. */
export const SS_MAP_BYTES_PER_ENTRY = 16;
/** Per-counter bytes: key + count + error, Float64 each (the witness's ssBytesPerCounter). */
export const SS_BYTES_PER_COUNTER = 24;
export const SS_DEFAULT_K = 64;

export const SF_RECALL = 0;         // found / trueHH (target 1.0 -- no false negatives)
export const SF_TRUEHH = 1;         // number of TRUE hitters with count > N/k
export const SF_FOUND = 2;          // of those, how many are monitored
export const SF_N = 3;              // total mass
export const SF_K = 4;              // capacity
export const SF_THRESH = 5;         // N / k (the heavy-hitter threshold)
export const SF_MAXERR = 6;         // max error over monitored keys (must be <= N/k)
export const SF_BRACKETOK = 7;      // 1 if count-error <= true <= count for every monitored key
export const SF_SKETCH_BYTES = 8;   // fixed: k * 24
export const SF_MAP_BYTES = 9;      // climbing: distinct * 16
export const SF_SIZE = 10;          // monitored count (<= k)
export const SF_DISTINCT = 11;      // distinct keys seen (Map size)
export const SF_SKETCH_ALLOC = 12;
export const SF_ORACLE_ALLOC = 13;
export const SF_ROWS = 14;          // leaderboard rows populated
export const SF_MAXCOUNT = 15;      // top count (leaderboard normalization)
export const SF_MINCOUNT = 16;      // min monitored count (the eviction floor)
export const SS_FLAT_LEN = 17;

/** Build the per-world recall callback ONCE (never per frame) -- 0-alloc when Map.forEach calls it. */
function makeSsRecallCb(world) {
    return function recallCb(count, key) {
        const ss = world.ss;
        const thr = ss.total / world.k;
        if (count > thr) { world.recallTrue++; if (ss.estimate(key) > 0) world.recallFound++; }
    };
}

/**
 * Build the Scene-04 world ONCE. The REAL SpaceSaving (k counters), an exact Map oracle, the
 * reused Zipfian stream, pre-allocated leaderboard buffers, and an integer epoch marker for the
 * 0-alloc top-k selection (no visited Set/array -- DEMO.md guardrail 6).
 * @param {number} k      capacity -- SpaceSaving validates [1, 2^24]
 * @param {number} [seed] uint32 stream + hash seed
 */
export function createSsWorld(k, seed) {
    const s = (seed === undefined || seed === null) ? SS_DEFAULT_STREAM_SEED : (seed >>> 0);
    const ss = new SpaceSaving(k, { seed: s | 0 });
    const world = {
        ss,
        oracle: new Map(),
        stream: new Uint32Array(SS_STREAM_LEN),
        streamMask: SS_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        keysPerFrame: SS_KEYS_PER_FRAME,
        k, seed: s, nKeys: SS_NKEYS, skew: SS_SKEW,
        rows: Math.min(SS_ROWS, k),
        lbKey: new Float64Array(SS_ROWS), lbCount: new Float64Array(SS_ROWS),
        lbError: new Float64Array(SS_ROWS), lbTrue: new Float64Array(SS_ROWS),
        lbTaken: new Int32Array(k), lbEpoch: 0,
        recallTrue: 0, recallFound: 0,
        flat: new Float64Array(SS_FLAT_LEN),
    };
    fillZipfStream(world);
    world.recallCb = makeSsRecallCb(world);
    return world;
}

/**
 * One SKETCH-path frame: feed `keysPerFrame` Zipfian keys to the REAL SpaceSaving (add is
 * 0 B/op amortized, incl. the evict path). 0 B/op.
 * @param {object} world
 * @returns {number} a fold (defeat DCE)
 */
export function stepSsSketch(world) {
    const stream = world.stream, mask = world.streamMask, ss = world.ss, kpf = world.keysPerFrame;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        const key = stream[pos & mask];
        ss.add(key);
        sink = (sink + key) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.frameCount = kpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/** One EXACT-ORACLE frame (allowed to allocate): replay the frame's keys into the exact Map. */
export function stepSsOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask, map = world.oracle;
    const start = world.frameStart, count = world.frameCount;
    for (let i = 0; i < count; i++) {
        const key = stream[(start + i) & mask];
        const c = map.get(key);
        if (c === undefined) { map.set(key, 1); allocState.oracleCount++; }
        else map.set(key, c + 1);
    }
    return map.size;
}

/**
 * Render-prep (~10Hz): select the top `rows` monitored counters by count with an INTEGER EPOCH
 * marker (0-alloc, no visited Set), read each true count from the exact Map, verify the
 * [count-error, count] bracket + max error over every monitored key, and compute RECALL of the
 * true hitters above N/k via Map.forEach with the hoisted callback (0-alloc). topK/heavyHitters
 * are NEVER called here (they allocate by contract). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} recall (folded via the flat buffer)
 */
export function renderSsPrep(world, allocState) {
    const ss = world.ss, flat = world.flat, map = world.oracle;
    const size = ss._size, cnt = ss._count, keys = ss._key, errs = ss._error;
    const ep = ++world.lbEpoch, taken = world.lbTaken;
    const rows = world.rows < size ? world.rows : size;
    let maxCount = 0, minCount = size > 0 ? Infinity : 0;
    for (let r = 0; r < rows; r++) {
        let best = -1, bestV = -1;
        for (let i = 0; i < size; i++) {
            if (taken[i] === ep) continue;
            const v = cnt[i];
            if (v > bestV) { bestV = v; best = i; }
        }
        taken[best] = ep;
        const key = keys[best];
        const tc = map.get(key);
        world.lbKey[r] = key;
        world.lbCount[r] = cnt[best];
        world.lbError[r] = errs[best];
        world.lbTrue[r] = tc === undefined ? 0 : tc;
        if (r === 0) maxCount = cnt[best];
    }
    // bracket + min/max over EVERY monitored key (0-alloc)
    let maxErr = 0, bracketOk = 1;
    for (let i = 0; i < size; i++) {
        const key = keys[i];
        const tc = map.get(key);
        const t = tc === undefined ? 0 : tc;
        const c = cnt[i], e = errs[i];
        if (!(c - e <= t && t <= c)) bracketOk = 0;
        if (e > maxErr) maxErr = e;
        if (c < minCount) minCount = c;
    }
    if (minCount === Infinity) minCount = 0;
    // recall (the headline) -- Map.forEach with the hoisted callback: 0-alloc
    world.recallTrue = 0; world.recallFound = 0;
    map.forEach(world.recallCb);
    const recall = world.recallTrue === 0 ? 1 : world.recallFound / world.recallTrue;
    const N = ss.total, k = world.k;
    flat[SF_RECALL] = recall;
    flat[SF_TRUEHH] = world.recallTrue;
    flat[SF_FOUND] = world.recallFound;
    flat[SF_N] = N;
    flat[SF_K] = k;
    flat[SF_THRESH] = N / k;
    flat[SF_MAXERR] = maxErr;
    flat[SF_BRACKETOK] = bracketOk;
    flat[SF_SKETCH_BYTES] = k * SS_BYTES_PER_COUNTER;
    flat[SF_MAP_BYTES] = map.size * SS_MAP_BYTES_PER_ENTRY;
    flat[SF_SIZE] = size;
    flat[SF_DISTINCT] = map.size;
    flat[SF_SKETCH_ALLOC] = allocState.sketchCount;
    flat[SF_ORACLE_ALLOC] = allocState.oracleCount;
    flat[SF_ROWS] = rows;
    flat[SF_MAXCOUNT] = maxCount;
    flat[SF_MINCOUNT] = minCount;
    return recall;
}
