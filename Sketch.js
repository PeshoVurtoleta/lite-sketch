/**
 * @zakkster/lite-sketch -- a zero-GC, zero-runtime-dependency, single-file ESM
 * family of APPROXIMATE, sublinear-space streaming SUMMARIES that witness their
 * ACCURACY against the paper's theoretical bound (the lite-filter honesty move,
 * one axis over: measured error vs the theoretical error), while allocating ZERO
 * bytes on every hot op (the lite-o1 zero-GC discipline).
 *
 * v1.1.2 ships the STABLE FOUR-member API (frozen at 1.0.0; 1.1.0 added DDSketch addFrom + getters; 1.1.1-1.1.2 = packaging metadata only) -- HyperLogLog (cardinality / distinct-count over an
 * unbounded stream in fixed space, via a dense Uint8Array register bank),
 * CountMinSketch (point-query frequency estimation over a Uint32Array counter
 * matrix), both over the canonical two-lane 64-bit non-crypto hash, DDSketch
 * (relative-error quantiles over a Float64Array of log-scale bins -- NOT hashed,
 * it bins raw values), and SpaceSaving (heavy-hitters / top-k over a fixed
 * counter set with an intrusive count-bucket forest + open-addressing key map).
 * Future members are PURE-APPENDED below the shared hash + these classes; prior
 * members stay byte-identical, only this header + VERSION change.
 *
 * ASCII-only source (no Unicode). Zero runtime deps; node:test only.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '1.1.2';

// ===========================================================================
// The canonical two-lane 64-bit hash (ADR 0001 -- LOCKED)
// ===========================================================================
//
// A 64-bit-quality hash realized as TWO decorrelated uint32 LANES (hi, lo),
// computed entirely with Math.imul in the int32 domain -- NO BigInt (it boxes),
// NO object / array return (it allocates). Each lane is an independent MurmurHash3
// 32-bit body over the key's low + high words, one seeded s, the other seeded
// (s ^ LANE_SALT); two independent murmur outputs give a 64-bit-quality pair whose
// avalanche is ~0.5 across BOTH lanes (a 1-bit input flip flips ~half of the 64
// output bits -- see test/Hash.test.js). The lanes are returned via two
// module-scope mutable slots the mixer writes and the caller reads IMMEDIATELY,
// on the same synchronous line -- zero allocation, no reentrancy in a hot add().

/** MurmurHash3 mixing constants (SMIs; the classic well-mixed choices). */
const HASH_C1 = 0xcc9e2d51 | 0;
const HASH_C2 = 0x1b873593 | 0;
/** MurmurHash3 fmix32 finalizer constants (SMIs). */
const FMIX_C1 = 0x85ebca6b | 0;
const FMIX_C2 = 0xc2b2ae35 | 0;
/** Lane decorrelation salt: lane LO seeds from (seed ^ LANE_SALT). */
const LANE_SALT = 0x85ebca6b | 0;
/** Large ODD constant for per-row salting (Count-Min's d rows, M2): h_i = mix(h ^ i*ODD_CONST). */
const ODD_CONST = 0x9e3779b1 | 0;
/** murmur3's round constant 0xe6546b64 as an int32 (same low 32 bits; keeps the inlined body pure int32). */
const M3_ADD = 0xe6546b64 | 0;

/**
 * The two output lanes of the last mix64 / hashString call. Written by the mixer,
 * read by the caller on the immediately following synchronous line -- the alloc-free
 * "return two uint32s" trick. Held as SIGNED int32 (`| 0`) so the module slots are
 * always SMIs and never box a HeapNumber (a uint32 >= 2^31 is a boxed double, and
 * storing that to a module slot allocates per op). The bit pattern is the full 32-bit
 * hash; readers recover the unsigned value with `>>> 0` at the boundary, and `add`'s
 * `>>> (32-p)` / `(x << p)` / `clz32` are bit-identical on the signed slot (the suffix
 * `x << p` stays a signed int32: `clz32` reads the same 32 bits and `!== 0` has the same
 * truth value as the old `(x << p) >>> 0`, so no `>>> 0` coercion is needed).
 */
let HASH_HI = 0;
let HASH_LO = 0;

/** Read the HI lane of the last mix64 / hashString call (uint32). Cold accessor. */
export function hashHi() { return HASH_HI >>> 0; }
/** Read the LO lane of the last mix64 / hashString call (uint32). Cold accessor. */
export function hashLo() { return HASH_LO >>> 0; }

/**
 * One MurmurHash3 body round: fold a 32-bit block `k` into the running state `h`.
 * Pure int32 math (Math.imul + rotates + the +constant, `| 0`-clamped). Zero-alloc.
 * @param {number} h int32 running state
 * @param {number} k int32 input block
 * @returns {number} int32 updated state
 */
function _m3round(h, k) {
    k = Math.imul(k, HASH_C1);
    k = (k << 15) | (k >>> 17);        // rotl 15
    k = Math.imul(k, HASH_C2);
    h = h ^ k;
    h = (h << 13) | (h >>> 19);        // rotl 13
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    return h;
}

/**
 * MurmurHash3 fmix32 finalizer -- the avalanche step. Pure int32, zero-alloc.
 * @param {number} h int32
 * @returns {number} int32 well-mixed
 */
function _m3final(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, FMIX_C1);
    h = h ^ (h >>> 13);
    h = Math.imul(h, FMIX_C2);
    h = h ^ (h >>> 16);
    return h;
}

/**
 * Hash a numeric key with a uint32 seed into the two lanes HASH_HI / HASH_LO.
 * Splits the key into its low 32 bits and its high word (exact for integers up to
 * 2^53), then folds BOTH words through TWO independently seeded murmur3 bodies. The
 * sign lives in bit 31 of the high word (`hi ^ (neg << 31)`), which is free because a
 * safe integer's high word is < 2^21, so the sign bit never collides with a magnitude
 * bit -- `-k` and `k` hash distinctly. Zero allocation, no BigInt, no ref retained.
 * @param {number} key  a finite number (integers up to +/-2^53 hash exactly)
 * @param {number} seed a uint32 seed
 */
export function mix64(key, seed) {
    let a = key;
    let neg = 0;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;                        // low 32 bits (ToUint32)
    const hi = ((a - lo) / 4294967296) >>> 0;  // high word (exact for safe integers)
    const s = seed >>> 0;
    // lane HI (seed s)
    let h = s | 0;
    h = _m3round(h, lo);
    h = _m3round(h, hi ^ (neg << 31));
    h = h ^ 8;                                 // length tag (two 32-bit blocks)
    HASH_HI = _m3final(h) | 0;
    // lane LO (seed s ^ LANE_SALT -- decorrelated)
    let g = (s ^ LANE_SALT) | 0;
    g = _m3round(g, lo);
    g = _m3round(g, hi ^ (neg << 31));
    g = g ^ 8;
    HASH_LO = _m3final(g) | 0;
}

/**
 * Hash a string with a uint32 seed into the two lanes HASH_HI / HASH_LO by walking
 * its UTF-16 code units alloc-free (charCodeAt, no substring, no ref retained). Two
 * independently seeded murmur3 folds. Empty string is legal (folds the seed alone).
 * @param {string} str  the input string
 * @param {number} seed a uint32 seed
 */
export function hashString(str, seed) {
    const s = seed >>> 0;
    let h = s | 0;
    let g = (s ^ LANE_SALT) | 0;
    const n = str.length;
    for (let i = 0; i < n; i++) {
        const c = str.charCodeAt(i);
        h = _m3round(h, c);
        g = _m3round(g, c ^ ODD_CONST);
    }
    h = h ^ n;
    g = g ^ n;
    HASH_HI = _m3final(h) | 0;
    HASH_LO = _m3final(g) | 0;
}

/**
 * Per-row salt of a base lane for Count-Min's d rows (M2): row i's hash is derived
 * from ONE base hash by `mix(h ^ (i * ODD_CONST))` -- cheap, accuracy-preserving,
 * standard. Wired here for the append-only roster; not used by HyperLogLog.
 * @param {number} h base lane (uint32)
 * @param {number} i row index (>= 0)
 * @returns {number} the salted, finalized uint32 for row i
 */
export function saltRow(h, i) {
    return _m3final((h ^ Math.imul(i, ODD_CONST)) | 0) >>> 0;
}

/**
 * @private Cold describe of ANY value for a throw message, running NO user code (F20):
 * `typeof` first, so a null-prototype object or a `toString` / `valueOf` / `Symbol.toPrimitive`
 * that throws or mutates the receiver can NEVER run during a rejection that must be a
 * byte-identical no-op. A string returns itself; a number / boolean / undefined / bigint /
 * symbol (and null) is `String`-safe and formats directly; any object is `'[object]'` and any
 * function `'[function]'`. It touches `x` only through `typeof` / `===`, never a property read.
 * @param {*} x the rejected value
 * @returns {string} a message fragment that is byte-identical to HEAD for every primitive
 */
function _describe(x) {
    const t = typeof x;
    if (t === 'string') return x;
    if (t === 'object') return x === null ? 'null' : '[object]';
    if (t === 'function') return '[function]';
    return String(x);
}

// ===========================================================================
// HyperLogLog (ADR 0002) -- the reference member (cardinality / distinct-count)
// ===========================================================================

/** Default per-instance seed (a uint32). Two default-seeded HLLs hash identically. */
const HLL_DEFAULT_SEED = 0x9e3779b1;
/** Lowest legal precision (m = 16 registers). */
const HLL_P_MIN = 4;
/** Highest legal precision (m = 262144 registers). */
const HLL_P_MAX = 18;
/** alpha_inf = 1 / (2 * ln 2) -- the asymptotic bias constant of Ertl's improved estimator. */
const HLL_ALPHA_INF = 0.5 / Math.LN2;

/**
 * sigma -- the small-range correction series of Ertl's improved HyperLogLog estimator
 * ("New cardinality estimation algorithms for HyperLogLog sketches", Ertl 2017). x is
 * the fraction of EMPTY registers. Converges to a fixed point (self-terminating), so it
 * is table-free -- no HLL++ empirical bias tables. Cold (called once per `count()`).
 * @param {number} x C[0] / m
 * @returns {number}
 */
function hllSigma(x) {
    if (x === 1) return Infinity;
    let y = 1;
    let z = x;
    let prev;
    do {
        x = x * x;
        prev = z;
        z += x * y;
        y += y;
    } while (z !== prev);
    return z;
}

/**
 * tau -- the large-range correction series of Ertl's improved estimator (companion to
 * hllSigma). x is 1 minus the fraction of SATURATED registers. Self-terminating fixed
 * point; table-free. Cold (called once per `count()`).
 * @param {number} x (m - C[q+1]) / m
 * @returns {number}
 */
function hllTau(x) {
    if (x === 0 || x === 1) return 0;
    let y = 1;
    let z = 1 - x;
    let prev;
    do {
        x = Math.sqrt(x);
        prev = z;
        y *= 0.5;
        const d = 1 - x;
        z -= d * d * y;
    } while (z !== prev);
    return z / 3;
}

/**
 * HyperLogLog -- distinct-count over an unbounded stream in FIXED space. A dense
 * `Uint8Array(m)` register bank, m = 2^p (p in [4, 18]). One byte per register holds
 * `rho`, the position of the leftmost 1-bit of the (64 - p)-bit hash suffix
 * (<= 64 - p + 1 <= 61, fits a byte).
 *
 * Headline (space, error, statistical): p=14 -> ~16 KB -> ~0.8% standard error;
 * two-sided; STATISTICAL (1.04/sqrt(m) is a standard error, gated at ~3 sigma, not a
 * hard per-query bound). Mergeable: register-wise max combines shard sketches losslessly.
 *
 * Hot path (`add` / `addHashed`, 0 B/op): the top p bits of the 64-bit hash pick a
 * register j; rho is the leftmost-1 position of the remaining 64 - p bits; a single
 * `reg[j] = max(reg[j], rho)`. `add` mixes the numeric key; `addHashed` takes two
 * caller-supplied uint32 lanes and skips the mix (the pre-hashed fast path). `addFrom(buf,
 * i)` / `addHashedFrom(buf, i)` are the ZERO-BOX siblings that read the key (resp. the two
 * lanes) from a caller-owned typed array, so a key >= 2^31 never boxes at the call boundary.
 *
 * Cold path: `count()` is O(m) (a disclosed co-headline, NOT per-add) -- Ertl's
 * improved estimator (2017), a single table-free formula accurate across the whole
 * cardinality range (no range-switching, no HLL++ empirical bias tables); `merge` /
 * `clear` are O(m).
 *
 * Fail closed: a bad p / seed throws `[lite-sketch]` at the ctor door BEFORE any
 * allocation (no half-built instance); `add` / `addHashed` typeof-guard their args
 * FIRST (a Symbol / BigInt / NaN / non-number is a throw, never a silent miss);
 * `count` / getters / a valid `merge` never throw. null is not zero.
 */
export class HyperLogLog {
    /** @private Brand (F21): installed by the ctor on every real instance; `#brand in x` runs no user code, is false for a Proxy / field-copy forgery, and adds no module state. */
    #brand;
    /**
     * @param {number} [p=14]   precision; an integer in [4, 18]. m = 1 << p.
     * @param {number} [seed]   uint32 hash seed (any integer, coerced with >>> 0).
     */
    constructor(p = 14, seed = HLL_DEFAULT_SEED) {
        // typeof guard FIRST, BEFORE any allocation: (p | 0) !== p rejects every
        // non-integer number; typeof rejects Symbol / BigInt before | coerces them.
        if (typeof p !== 'number' || (p | 0) !== p || p < HLL_P_MIN || p > HLL_P_MAX) {
            throw new RangeError(
                '[lite-sketch] HyperLogLog p must be an integer in [4, 18], got ' + _describe(p));
        }
        if (typeof seed !== 'number' || !Number.isInteger(seed)) {
            throw new RangeError(
                '[lite-sketch] HyperLogLog seed must be an integer, got ' + _describe(seed));
        }
        const m = 1 << p;
        this._p = p;
        this._m = m;
        this._seed = seed | 0;   // SMI-safe (signed int32); the murmur uses it as `s | 0` either way
        this._reg = new Uint8Array(m);
        // Register values (rho) are in [0, q+1], q = 64 - p; _hist is the reused
        // multiplicity vector Ertl's estimator folds over (scratch for count(), so
        // count() itself allocates nothing -- it is a cold O(m) co-headline either way).
        this._q = 64 - p;
        this._hist = new Int32Array(this._q + 2);
        this._buf = new Float64Array(1);   // add() scratch: the key crosses _addAt as buf[0], never as an argument
    }

    /** Precision p. O(1). */
    get p() { return this._p; }
    /** Register count m = 2^p. O(1). */
    get m() { return this._m; }
    /** The theoretical standard error 1.04 / sqrt(m). O(1). */
    get standardError() { return 1.04 / Math.sqrt(this._m); }
    /** The uint32 hash seed. O(1). */
    get seed() { return this._seed >>> 0; }

    /**
     * Add a SAFE-INTEGER key. HOT, 0 B/op. A thin typeof wrapper: it rejects a non-number
     * FIRST (a byte-identical `[lite-sketch]` no-op), writes the key into the per-instance
     * `_buf` scratch, and defers the hash + register update to `_addAt(_buf, 0)` -- so the
     * key never crosses an inner call boundary as a (boxable) argument. The accepted domain
     * is every safe integer |key| <= 2^53 - 1 (the full magnitude: low word + high word +
     * sign), matching CountMinSketch / SpaceSaving; a NaN / +-Infinity / non-integer /
     * out-of-safe-range key throws `[lite-sketch]` in `_addAt`. For a key >= 2^31 on a hot
     * path, `addFrom(buf, i)` avoids even the caller's own argument box.
     * @param {number} key a safe integer, |key| <= 2^53 - 1
     * @returns {HyperLogLog} this
     */
    add(key) {
        if (typeof key !== 'number') return this._badKey(key);
        const b = this._buf;
        b[0] = key;
        return this._addAt(b, 0);
    }

    /**
     * Add the SAFE-INTEGER key at `buf[i]` of a caller-owned `Float64Array` -- the ZERO-BOX
     * entry point for a hot-path key >= 2^31. HOT, 0 B/op. Identical validation, throws,
     * byte-identical-no-op-on-reject, and register update as `add(key)`; it differs ONLY in
     * how the key crosses the call boundary: `add(bigKey)` boxes its tagged argument into a
     * ~16 B HeapNumber per call when V8 does not inline the call, whereas `addFrom` crosses
     * as (object, Smi) and reads `buf[i]` as an UNBOXED double in a local. A consumer whose
     * keys exceed the Smi range (e.g. a 53-bit composite id) writes each key into a scratch
     * slot and calls `addFrom(scratch, i)` to stay at 0 library B/op.
     *
     * Fails closed BEFORE any state write: a non-Float64Array `buf`, or a non-integer /
     * out-of-bounds `i`, throws a tagged TypeError; then the value rejects exactly as `add`
     * (a non-integer / out-of-safe-range key throws `[lite-sketch]`).
     * @param {Float64Array} buf a caller-owned Float64Array holding the key.
     * @param {number} i an in-bounds index into `buf`.
     * @returns {HyperLogLog} this
     */
    addFrom(buf, i) {
        if (!(buf instanceof Float64Array) || !Number.isInteger(i) ||
            i < 0 || i >= buf.length) return this._badBuf(buf, i);
        return this._addAt(buf, i);
    }

    /**
     * @private The one add body: the key = `buf[i]` is read UNBOXED into a local and never
     * crosses another call. Shared by `add` (via `_buf`) and `addFrom` (via the caller's
     * buffer). Numeric guards use the two-compare range check (`!Number.isInteger(key) ||
     * key > 2^53-1 || key < -(2^53-1)`; NaN / Infinity fail isInteger), then the two-lane
     * murmur is HAND-INLINED (identical bits to `_m3round` / `_m3final`): the two mixed
     * blocks k1 (from `a | 0`) and k2 (from `hiw ^ (neg << 31)`) are lane-independent, so
     * each is computed once and folded into both lanes. The lanes stay pure int32 LOCALS
     * (never the module HASH_HI / HASH_LO slots), so a uint32 >= 2^31 lane never boxes a
     * HeapNumber on the hot path -- that holds add at a true 0 scavenges (mix64 / hashHi /
     * hashLo remain the standalone hash for external callers). Over the 460-byte V8 inline
     * cap, so it is never inlined -- and never needs to be: its arguments are (object, Smi).
     */
    _addAt(buf, i) {
        const key = buf[i];
        if (!Number.isInteger(key) || key > 9007199254740991 || key < -9007199254740991) return this._badKey(key);
        const neg = key < 0 ? 1 : 0;
        const a = Math.abs(key);
        // The murmur3 body, hand-inlined (identical bits to _m3round / _m3final): the two
        // mixed blocks are lane-independent, so each is computed once and folded into both lanes.
        let k1 = Math.imul(a | 0, HASH_C1);
        k1 = Math.imul((k1 << 15) | (k1 >>> 17), HASH_C2);
        let k2 = Math.imul((a < 4294967296 ? 0 : ((a / 4294967296) | 0)) ^ (neg << 31), HASH_C1);
        k2 = Math.imul((k2 << 15) | (k2 >>> 17), HASH_C2);
        let h = this._seed ^ k1;
        h = (Math.imul((h << 13) | (h >>> 19), 5) + M3_ADD) | 0;
        h ^= k2;
        h = (Math.imul((h << 13) | (h >>> 19), 5) + M3_ADD) ^ 8;
        h ^= h >>> 16; h = Math.imul(h, FMIX_C1); h ^= h >>> 13; h = Math.imul(h, FMIX_C2); h ^= h >>> 16;    // HI lane
        let g = this._seed ^ LANE_SALT ^ k1;
        g = (Math.imul((g << 13) | (g >>> 19), 5) + M3_ADD) | 0;
        g ^= k2;
        g = (Math.imul((g << 13) | (g >>> 19), 5) + M3_ADD) ^ 8;
        g ^= g >>> 16; g = Math.imul(g, FMIX_C1); g ^= g >>> 13; g = Math.imul(g, FMIX_C2); g ^= g >>> 16;    // LO lane
        const p = this._p;
        const j = h >>> (32 - p);
        const hiSuf = h << p;
        const rho = hiSuf !== 0
            ? Math.clz32(hiSuf) + 1
            : (32 - p) + Math.clz32(g) + 1;
        if (rho > this._reg[j]) this._reg[j] = rho;
        return this;
    }

    /**
     * Add a PRE-HASHED key -- the fast path: the caller supplies two uint32 lanes
     * (their own good 64-bit hash), skipping mix64. HOT, 0 B/op. Same index + rho +
     * store as `add`. Fails closed: a non-uint32 lane throws `[lite-sketch]`.
     * @param {number} hi high lane (uint32)
     * @param {number} lo low lane (uint32)
     * @returns {HyperLogLog} this
     */
    addHashed(hi, lo) {
        if (typeof hi !== 'number' || (hi >>> 0) !== hi) return this._badLane(hi);
        if (typeof lo !== 'number' || (lo >>> 0) !== lo) return this._badLane(lo);
        const p = this._p;
        const j = hi >>> (32 - p);
        const hiSuf = hi << p;
        const rho = hiSuf !== 0
            ? Math.clz32(hiSuf) + 1
            : (32 - p) + Math.clz32(lo) + 1;
        if (rho > this._reg[j]) this._reg[j] = rho;
        return this;
    }

    /**
     * Add a PRE-HASHED key from two uint32 lanes read UNBOXED at `buf[i]`, `buf[i+1]` of a
     * caller-owned `Uint32Array` or `Int32Array` -- the zero-box sibling of `addHashed`.
     * HOT, 0 B/op. Same register index + rho + store as `addHashed`; lanes are read as int32
     * (`buf[i] | 0`), so an Int32Array lane is reinterpreted bit-for-bit as the uint32 lane.
     * Fails closed BEFORE any write: a non-Uint32Array/Int32Array `buf`, or a non-integer /
     * out-of-bounds `i` (needs `i` and `i+1` in range), throws a tagged TypeError; a lane that is
     * neither a uint32 nor an int32 (e.g. from a Proxy or an overridden-`length` view) is
     * addHashed's lane error.
     * @param {Uint32Array|Int32Array} buf a caller-owned lane buffer.
     * @param {number} i an index with `i` and `i+1` in bounds.
     * @returns {HyperLogLog} this
     */
    addHashedFrom(buf, i) {
        if (!(buf instanceof Uint32Array || buf instanceof Int32Array) || !Number.isInteger(i) ||
            i < 0 || i + 1 >= buf.length) return this._badHashBuf(buf, i);
        // Read each lane ONCE into a local, then validate BEFORE any state write: a Proxy over a
        // typed array (passes instanceof) or a subclass with an overridden `length` can yield a
        // non-int32 lane (undefined / 'x' / NaN / 2^40 / -1.5 / an out-of-bounds undefined). A
        // uint32 (`(x>>>0)===x`) OR an int32 (`(x|0)===x`, the Int32Array reinterpret) is legal;
        // anything else is addHashed's lane error (fail closed, byte-identical no-op).
        const hi = buf[i];
        if (!((hi >>> 0) === hi || (hi | 0) === hi)) return this._badLane(hi);
        const lo = buf[i + 1];
        if (!((lo >>> 0) === lo || (lo | 0) === lo)) return this._badLane(lo);
        const hw = hi | 0, lw = lo | 0;   // bit-identical to addHashed's uint32 lanes (>>>/<<< read the same 32 bits)
        const p = this._p;
        const j = hw >>> (32 - p);
        const hiSuf = hw << p;
        const rho = hiSuf !== 0
            ? Math.clz32(hiSuf) + 1
            : (32 - p) + Math.clz32(lw) + 1;
        if (rho > this._reg[j]) this._reg[j] = rho;
        return this;
    }

    /**
     * Estimate the distinct-count via Ertl's IMPROVED estimator (Ertl 2017) -- a single
     * TABLE-FREE formula accurate across the whole range (low, mid, and high cardinality),
     * so there is NO range-switching and NO HLL++ empirical bias tables. Build the register
     * multiplicity vector, fold it through the self-terminating sigma / tau corrections, and
     * divide alpha_inf * m^2 by the result. COLD, O(m) (a disclosed co-headline, NOT per-add):
     * 0 alloc (the histogram is the reused `_hist`). NEVER throws. Returns a rounded count.
     * @returns {number}
     */
    count() {
        const m = this._m;
        const reg = this._reg;
        const q = this._q;
        const C = this._hist;
        C.fill(0);
        for (let i = 0; i < m; i++) C[reg[i]]++;   // multiplicity vector, values in [0, q+1]
        // Ertl improved estimator: z accumulates the corrected inverse-sum.
        let z = m * hllTau((m - C[q + 1]) / m);    // large-range (saturated) correction
        for (let k = q; k >= 1; k--) z = 0.5 * (z + C[k]);
        z += m * hllSigma(C[0] / m);               // small-range (empty) correction
        // Empty sketch: sigma(1) = Infinity -> z = Infinity -> estimate 0 (exact). All-saturated:
        // z = 0 -> estimate Infinity (honest: ~2^(64-p) elements, unreachable in practice).
        return Math.round(HLL_ALPHA_INF * m * m / z);
    }

    /**
     * Merge `other` into this by register-wise max (the mergeability that makes HLL
     * distributable). O(m), 0 alloc. Equal-m-AND-seed-or-throw: fails closed
     * `[lite-sketch]` if `other` is not a HyperLogLog or differs in m / seed (a
     * differently-seeded HLL hashes the same key to a different register, so a
     * register-wise max would silently combine to garbage).
     * A Proxy over an instance or a field copy is NOT a HyperLogLog (the brand is checked, not
     * `instanceof`): the brand predicate is the first statement, before any read of `other`.
     * @param {HyperLogLog} other
     * @returns {HyperLogLog} this
     */
    merge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) return this._badMerge(other);
        if (other._m !== this._m || other._seed !== this._seed) {
            return this._badMerge(other);
        }
        const a = this._reg;
        const b = other._reg;
        const m = this._m;
        for (let i = 0; i < m; i++) {
            if (b[i] > a[i]) a[i] = b[i];
        }
        return this;
    }

    /** Reset every register to 0. O(m). @returns {HyperLogLog} this */
    clear() {
        this._reg.fill(0);
        return this;
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-sketch] HyperLogLog.addFrom(buf, i) needs a Float64Array and an in-bounds integer index, got ' +
            _describe(buf) + ', ' + _describe(i));
    }

    /** @private Cold thrower for a bad addHashedFrom buffer/index. */
    _badHashBuf(buf, i) {
        throw new TypeError(
            '[lite-sketch] HyperLogLog.addHashedFrom(buf, i) needs a Uint32Array or Int32Array and an integer index with i and i+1 in bounds, got ' +
            _describe(buf) + ', ' + _describe(i));
    }

    /** @private Cold thrower for a bad key (_describe runs no user code -- F20). */
    _badKey(key) {
        throw new TypeError('[lite-sketch] HyperLogLog.add key must be a number, got ' + _describe(key));
    }

    /** @private Cold thrower for a bad pre-hashed lane. */
    _badLane(x) {
        throw new TypeError('[lite-sketch] HyperLogLog.addHashed lanes must be uint32, got ' + _describe(x));
    }

    /** @private Cold thrower for an incompatible merge (non-instance vs m/seed mismatch). */
    _badMerge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) {
            throw new TypeError('[lite-sketch] HyperLogLog.merge expects a HyperLogLog');
        }
        if (other._m !== this._m) {
            throw new RangeError(
                '[lite-sketch] HyperLogLog.merge requires equal m: this m=' + this._m + ', other m=' + other._m);
        }
        throw new RangeError(
            '[lite-sketch] HyperLogLog.merge requires equal seed: this seed=' + (this._seed >>> 0) +
            ', other seed=' + (other._seed >>> 0));
    }
}

// ===========================================================================
// CountMinSketch (ADR 0003) -- the frequency member (point-query frequency estimation)
// ===========================================================================

/** Highest legal depth d (number of hash rows). */
const CMS_D_MAX = 32;
/** Highest legal width w (columns per row) BEFORE the SMI-cap check. m = d * w. */
const CMS_W_MAX = 1 << 25;
/** Every flat counter index d*w must stay <= this, so counts[i*w+col] is always a SMI. */
const CMS_SMI_CAP = 2 ** 31;
/** Counter saturation: a Uint32Array cell tops out here (saturating add, never wraps). */
const CMS_MAX_COUNT = 0xffffffff;
/** Default per-instance seed (shared with HyperLogLog so both members hash identically). */
const CMS_DEFAULT_SEED = HLL_DEFAULT_SEED;
/** Frozen marker of the known option keys -- an unknown key is a throw with a did-you-mean. */
const CMS_KNOWN_OPTS = Object.freeze({ __proto__: null, seed: true, conservative: true });

/**
 * CountMinSketch -- POINT-QUERY FREQUENCY estimation over an unbounded stream in
 * FIXED space. A dense `Uint32Array(d * w)` counter matrix of d rows x w columns,
 * w a power of two so a column is picked with a single `hash & (w - 1)` mask. Each
 * key increments one cell per row (the row's independent hash); a query returns the
 * MINIMUM of its d cells -- the tightest over-estimate, since collisions only ever
 * add.
 *
 * Headline (space, error co-headline): the matrix is `d * w * 4` bytes; a point
 * query returns `f_hat >= f_true` with `f_hat - f_true <= epsilon * N` (N = total
 * count) with probability `>= 1 - delta`, where `epsilon = e / w` and
 * `delta = e^-d`. `withAccuracy(epsilon, delta)` inverts that: `w = ceil(e/epsilon)`
 * (rounded up to a power of two), `d = ceil(ln(1/delta))`. One-sided while `!saturated`:
 * the estimate never undercounts until a counter saturates at 2^32-1 (then the sticky
 * `saturated` getter reads true and a query over a saturated key may read low).
 *
 * Conservative update (default, Estan-Varghese): instead of `+count` on every row,
 * raise each of the d cells only up to `min(cells) + count` -- it never changes the
 * min-query answer but provably tightens the over-estimate on skewed streams. Set
 * `conservative: false` for the classic plain-add matrix (still one-sided; needed
 * for `merge`-based distribution, where conservative update is not linearly mergeable
 * -- merge is exact for plain sketches and a valid upper bound otherwise).
 *
 * Hot path (`add` / `addHashed` / `estimate`, 0 B/op): the two-lane murmur is INLINED
 * into int32 LOCALS exactly like `HyperLogLog.add` -- it NEVER writes the module
 * HASH_HI / HASH_LO slots, so a uint32 >= 2^31 lane never boxes a HeapNumber. The d
 * row hashes derive from one base lane `(hi ^ lo)` via `mix(base ^ i*ODD_CONST)`
 * (the standard cheap per-row salt), and the d chosen flat indices are staged in a
 * pre-allocated `Int32Array(d)` scratch (`_idx`) so conservative update touches each
 * cell twice with zero allocation. `add` mixes a numeric key; `addHashed` takes two
 * caller-supplied uint32 lanes and skips the mix. `addFrom(buf, i)` / `addHashedFrom(buf,
 * i)` are the ZERO-BOX siblings that read the key + count (resp. hi, lo, count) from a
 * caller-owned typed array, so a key or count >= 2^31 never boxes at the call boundary.
 *
 * Fail closed: a bad d / w / seed / conservative / unknown option throws
 * `[lite-sketch]` at the ctor door BEFORE any allocation (no half-built instance);
 * `add` / `addHashed` typeof-guard key/lanes/count FIRST (Symbol / BigInt / NaN /
 * non-uint32 lane / out-of-range count is a throw, never a silent miss); `estimate`
 * / `estimateHashed` / getters / a valid `merge` never throw (a bad key estimates 0,
 * an incompatible merge throws). null is not zero.
 */
export class CountMinSketch {
    /** @private Brand (F21): installed by the ctor on every real instance; `#brand in x` runs no user code, is false for a Proxy / field-copy forgery, and adds no module state. */
    #brand;
    /**
     * @param {number} d depth (hash rows); an integer in [1, 32].
     * @param {number} w width (columns/row); an integer in [1, 2^25], rounded UP to a power of two.
     * @param {{seed?: number, conservative?: boolean}} [options]
     *   seed: uint32 hash seed (any integer, coerced with `| 0`); default shared with HLL.
     *   conservative: conservative-update mode; default true.
     */
    constructor(d, w, options) {
        // typeof guard FIRST, BEFORE any allocation -- reject non-integers / Symbol / BigInt.
        if (typeof d !== 'number' || (d | 0) !== d || d < 1 || d > CMS_D_MAX) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch d must be an integer in [1, ' + CMS_D_MAX + '], got ' + _describe(d));
        }
        if (typeof w !== 'number' || (w | 0) !== w || w < 1 || w > CMS_W_MAX) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch w must be an integer in [1, ' + CMS_W_MAX + '], got ' + _describe(w));
        }
        // Round w UP to the next power of two (no-op if already one) so column = hash & (w-1).
        let cw = 1;
        while (cw < w) cw <<= 1;
        if (cw > CMS_W_MAX) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch w rounded up to ' + cw + ' exceeds max ' + CMS_W_MAX);
        }
        // SMI cap: keep every flat index i*w+col a SMI (else counts[id] boxes / deopts).
        if (d * cw > CMS_SMI_CAP) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch d*w=' + (d * cw) + ' exceeds SMI cap ' + CMS_SMI_CAP);
        }
        let seed = CMS_DEFAULT_SEED;
        let conservative = true;
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError(
                    '[lite-sketch] CountMinSketch options must be a plain object, got ' + _describe(options));
            }
            // F18: classify the bag and read its own data values inside ONE try, so a revoked /
            // throwing-trap Proxy becomes the plain-object TypeError (not an untagged engine throw).
            let bad, seedOwn, consOwn;
            try {
                bad = _optScan(options, CMS_KNOWN_OPTS);
                if (bad === null) {
                    seedOwn = _optOwn(options, 'seed');
                    consOwn = _optOwn(options, 'conservative');
                }
            } catch (e) {
                bad = _NOT_BAG;
            }
            if (bad === _NOT_BAG) {
                throw new TypeError(
                    '[lite-sketch] CountMinSketch options must be a plain object, got ' + _describe(options));
            }
            if (bad !== null) this._badOption(bad);
            // Value checks AFTER the try (never swallowed by it), verbatim from HEAD.
            if (seedOwn !== undefined) {
                seed = seedOwn;
                if (typeof seed !== 'number' || !Number.isInteger(seed)) {
                    throw new RangeError(
                        '[lite-sketch] CountMinSketch seed must be an integer, got ' + _describe(seed));
                }
            }
            if (consOwn !== undefined) {
                conservative = consOwn;
                if (typeof conservative !== 'boolean') {
                    throw new TypeError(
                        '[lite-sketch] CountMinSketch conservative must be a boolean, got ' + _describe(conservative));
                }
            }
        }
        // Only now allocate (no half-built instance on any thrown path above).
        this._d = d;
        this._w = cw;
        this._mask = cw - 1;
        this._seed = seed | 0;          // SMI-safe (signed int32); murmur uses it as `s | 0` either way
        this._conservative = conservative;
        this._counts = new Uint32Array(d * cw);
        this._idx = new Int32Array(d);  // pre-allocated per-row flat-index scratch (0-alloc conservative update)
        this._base = new Int32Array(1); // F4: per-instance base lane (int32 slot; argument-free _apply*)
        this._cnt = new Float64Array(1);   // F4: per-instance count (f64 slot; a count >= 2^31 never crosses as an arg)
        this._buf = new Float64Array(2);   // add / estimate scratch: key, count cross _addAt as buf[0..1]; _estimateAt writes the min to buf[1] (D3)
        this._total = 0;
        this._saturated = false;        // sticky: set on any CMS_MAX_COUNT clamp; while false, estimate is one-sided
    }

    /**
     * Build a sketch sized to a target accuracy: `w = ceil(e/epsilon)` (then rounded up to
     * a power of two), `d = ceil(ln(1/delta))` (clamped UP to >= 1, which only strengthens
     * the guarantee). An UNATTAINABLE request -- `w > 2^25` or `d > 32` (F16/S6) -- throws
     * a tagged RangeError rather than silently clamping down to a weaker guarantee.
     * Delegates ALL remaining validation (incl. the SMI cap) to the ctor.
     * @param {number} epsilon relative error, in (0, 1).
     * @param {number} delta   failure probability, in (0, 1).
     * @param {{seed?: number, conservative?: boolean}} [options]
     * @returns {CountMinSketch}
     */
    static withAccuracy(epsilon, delta, options) {
        if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch.withAccuracy epsilon must be in (0, 1), got ' + _describe(epsilon));
        }
        if (typeof delta !== 'number' || !(delta > 0 && delta < 1)) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch.withAccuracy delta must be in (0, 1), got ' + _describe(delta));
        }
        // F16/S6: a request that needs w > 2^25 or d > 32 is UNATTAINABLE, so throw tagged
        // rather than silently clamp to a weaker guarantee. Infinity (a denormal epsilon/delta)
        // exceeds the cap and throws too. Both checks precede the power-of-two round-up loop.
        const w = Math.ceil(Math.E / epsilon);
        if (w > CMS_W_MAX) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch.withAccuracy epsilon ' + epsilon + ' needs w=' + w +
                ' > the width cap 33554432 (2^25); it is unattainable');
        }
        let d = Math.ceil(Math.log(1 / delta));
        if (d > CMS_D_MAX) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch.withAccuracy delta ' + delta + ' needs d=' + d +
                ' > the depth cap 32; it is unattainable');
        }
        if (d < 1) d = 1;
        let cw = 1;
        while (cw < w) cw <<= 1;
        return new CountMinSketch(d, cw, options);
    }

    /** Depth d (hash rows). O(1). */
    get d() { return this._d; }
    /** Width w (columns/row, a power of two). O(1). */
    get w() { return this._w; }
    /** The uint32 hash seed. O(1). */
    get seed() { return this._seed >>> 0; }
    /** Whether conservative update is on. O(1). */
    get conservative() { return this._conservative; }
    /** Total count added (sum of all `count`s). O(1). */
    get total() { return this._total; }
    /**
     * Whether any counter has saturated at CMS_MAX_COUNT (2^32-1). Sticky: once true it
     * stays true until `clear()`, and `merge` carries it from either side. While it is
     * false the estimate is strictly one-sided (never undercounts); once true a saturated
     * cell may read low, so a query over a saturated key is no longer an upper bound. O(1).
     */
    get saturated() { return this._saturated; }
    /** The theoretical relative error e / w. O(1). */
    get epsilon() { return Math.E / this._w; }
    /** The theoretical failure probability e^-d. O(1). */
    get delta() { return Math.exp(-this._d); }

    /**
     * Add a SAFE-INTEGER key with a positive integer `count` (default 1). HOT, 0 B/op. A thin
     * typeof wrapper: it rejects a non-number key OR count FIRST (via `_badArgs`, which replays
     * add's exact guard order so the thrown class + message are byte-identical), writes key and
     * count into the per-instance `_buf` scratch, and defers to `_addAt(_buf, 0)` -- so neither
     * the key nor a count >= 2^31 crosses an inner call as a (boxable) argument. The accepted
     * domain is every safe integer |key| <= 2^53 - 1 (the full magnitude: low word + high word +
     * sign), matching HyperLogLog / SpaceSaving; an out-of-range count, or an add that would push
     * the running `total` past 2^53-1 (F15/S5, the aggregate stays exact), throws `[lite-sketch]`
     * in `_addAt`. For a key or count >= 2^31 on a hot path, `addFrom(buf, i)` avoids even the
     * caller's own argument box.
     * @param {number} key a safe integer, |key| <= 2^53 - 1
     * @param {number} [count=1] a positive integer in [1, 2^32-1].
     * @returns {CountMinSketch} this
     */
    add(key, count = 1) {
        if (typeof key !== 'number' || typeof count !== 'number') return this._badArgs(key, count);
        const b = this._buf;
        b[0] = key;
        b[1] = count;
        return this._addAt(b, 0);
    }

    /**
     * Add the key at `buf[i]` with the count at `buf[i+1]`, both read UNBOXED from a
     * caller-owned `Float64Array` -- the ZERO-BOX entry point for a key or count >= 2^31.
     * HOT, 0 B/op. Identical validation, throws, byte-identical-no-op-on-reject, and cell
     * update as `add(key, count)`; it differs ONLY in how the values cross the call boundary:
     * `add(bigKey, bigCount)` boxes each tagged argument into a ~16 B HeapNumber per call when
     * V8 does not inline the call, whereas `addFrom` crosses as (object, Smi) and reads both
     * slots as UNBOXED doubles. A consumer with full-range keys / counts (e.g. lite-hud's
     * `ch*2^32 + tag` key and cumulative-microsecond count) writes them into a scratch and
     * calls `addFrom(scratch, i)` to stay at 0 library B/op.
     *
     * Fails closed BEFORE any state write: a non-Float64Array `buf`, or a non-integer /
     * out-of-bounds `i` (needs `i` and `i+1` in range), throws a tagged TypeError; then the
     * key / count reject exactly as `add`.
     * @param {Float64Array} buf a caller-owned Float64Array holding `[..., key, count, ...]`.
     * @param {number} i an index with `i` and `i+1` in bounds (key at `i`, count at `i+1`).
     * @returns {CountMinSketch} this
     */
    addFrom(buf, i) {
        if (!(buf instanceof Float64Array) || !Number.isInteger(i) ||
            i < 0 || i + 1 >= buf.length) return this._badBuf(buf, i);
        return this._addAt(buf, i);
    }

    /**
     * @private The one add body: key = `buf[i]`, count = `buf[i+1]`, read UNBOXED into locals
     * that never cross another call. Shared by `add` (via `_buf`) and `addFrom` (via the
     * caller's buffer). Guards (two-compare key range, count range, running-total ceiling) run
     * BEFORE any write, so `_base` / `_cnt` are untouched on every rejection. Then the two-lane
     * murmur is HAND-INLINED (identical bits to `_m3round` / `_m3final`): the two mixed blocks
     * k1 (from `a | 0`) and k2 (from `hiw ^ (neg << 31)`) are lane-independent, computed once
     * and folded into both lanes, and `base = (h ^ g)` into `_base[0]`, `count` into `_cnt[0]`,
     * so the argument-free `_applyCons` / `_applyPlain` touch each cell with no boxed argument.
     * Over the 460-byte V8 inline cap, so it is never inlined -- its arguments are (object, Smi).
     */
    _addAt(buf, i) {
        const key = buf[i], count = buf[i + 1];
        if (!Number.isInteger(key) || key > 9007199254740991 || key < -9007199254740991) return this._badKey(key);
        if (!Number.isInteger(count) || count < 1 || count > CMS_MAX_COUNT) return this._badCount(count);
        if (this._total + count > 9007199254740991) return this._badTotal(count);
        const neg = key < 0 ? 1 : 0;
        const a = Math.abs(key);
        // The murmur3 body, hand-inlined (identical bits to _m3round / _m3final): the two
        // mixed blocks are lane-independent, so each is computed once and folded into both lanes.
        let k1 = Math.imul(a | 0, HASH_C1);
        k1 = Math.imul((k1 << 15) | (k1 >>> 17), HASH_C2);
        let k2 = Math.imul((a < 4294967296 ? 0 : ((a / 4294967296) | 0)) ^ (neg << 31), HASH_C1);
        k2 = Math.imul((k2 << 15) | (k2 >>> 17), HASH_C2);
        let h = this._seed ^ k1;
        h = (Math.imul((h << 13) | (h >>> 19), 5) + M3_ADD) | 0;
        h ^= k2;
        h = (Math.imul((h << 13) | (h >>> 19), 5) + M3_ADD) ^ 8;
        h ^= h >>> 16; h = Math.imul(h, FMIX_C1); h ^= h >>> 13; h = Math.imul(h, FMIX_C2); h ^= h >>> 16;    // HI lane
        let g = this._seed ^ LANE_SALT ^ k1;
        g = (Math.imul((g << 13) | (g >>> 19), 5) + M3_ADD) | 0;
        g ^= k2;
        g = (Math.imul((g << 13) | (g >>> 19), 5) + M3_ADD) ^ 8;
        g ^= g >>> 16; g = Math.imul(g, FMIX_C1); g ^= g >>> 13; g = Math.imul(g, FMIX_C2); g ^= g >>> 16;    // LO lane
        this._base[0] = h ^ g;
        this._cnt[0] = count;
        if (this._conservative) return this._applyCons();
        return this._applyPlain();
    }

    /**
     * Add a PRE-HASHED key -- the fast path: two caller-supplied uint32 lanes, skipping
     * the mix. HOT, 0 B/op. Same base + row increment as `add`. Fails closed: a
     * non-uint32 lane or bad count throws `[lite-sketch]`.
     * @param {number} hi high lane (uint32)
     * @param {number} lo low lane (uint32)
     * @param {number} [count=1] a positive integer in [1, 2^32-1].
     * @returns {CountMinSketch} this
     */
    addHashed(hi, lo, count = 1) {
        if (typeof hi !== 'number' || (hi >>> 0) !== hi) return this._badLane(hi);
        if (typeof lo !== 'number' || (lo >>> 0) !== lo) return this._badLane(lo);
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > CMS_MAX_COUNT) {
            return this._badCount(count);
        }
        if (this._total + count > 9007199254740991) return this._badTotal(count);
        this._base[0] = hi ^ lo;
        this._cnt[0] = count;
        if (this._conservative) return this._applyCons();
        return this._applyPlain();
    }

    /**
     * Add a PRE-HASHED key from three slots read UNBOXED at `buf[i]`, `buf[i+1]`, `buf[i+2]`
     * of a caller-owned `Uint32Array` or `Int32Array` -- hi, lo and count -- the zero-box
     * sibling of `addHashed(hi, lo, count)`. HOT, 0 B/op. Same base + row increment as
     * `addHashed`; a fixed count of 1 would push a counted stream's count back across the call,
     * so count rides the third slot. NOTE: an Int32Array caps count at 2^31 - 1 (a larger count
     * needs a Uint32Array). Fails closed BEFORE any write: a non-Uint32Array/Int32Array `buf`,
     * or a non-integer / out-of-bounds `i` (needs `i`..`i+2` in range), throws a tagged
     * TypeError; a lane that is neither a uint32 nor an int32 (e.g. from a Proxy or an
     * overridden-`length` view) is addHashed's lane error; an out-of-range count throws
     * `[lite-sketch]`; and an add that would push the running `total` past 2^53-1 (F15/S5)
     * throws tagged (byte-identical no-op).
     * @param {Uint32Array|Int32Array} buf a caller-owned buffer holding `[..., hi, lo, count, ...]`.
     * @param {number} i an index with `i`..`i+2` in bounds.
     * @returns {CountMinSketch} this
     */
    addHashedFrom(buf, i) {
        if (!(buf instanceof Uint32Array || buf instanceof Int32Array) || !Number.isInteger(i) ||
            i < 0 || i + 2 >= buf.length) return this._badHashBuf(buf, i);
        // Read each slot ONCE, then validate in addHashed's order (hi, lo, count) BEFORE any write:
        // a Proxy over a typed array (passes instanceof) or a subclass with an overridden `length`
        // can yield a non-int32 lane (undefined / 'x' / NaN / 2^40 / -1.5 / an out-of-bounds
        // undefined). A uint32 (`(x>>>0)===x`) OR an int32 (`(x|0)===x`) lane is legal; anything
        // else is addHashed's lane error (D2: count uses addHashed's guard verbatim). Fail closed.
        const hi = buf[i];
        if (!((hi >>> 0) === hi || (hi | 0) === hi)) return this._badLane(hi);
        const lo = buf[i + 1];
        if (!((lo >>> 0) === lo || (lo | 0) === lo)) return this._badLane(lo);
        const count = buf[i + 2];
        if (!Number.isInteger(count) || count < 1 || count > CMS_MAX_COUNT) return this._badCount(count);
        if (this._total + count > 9007199254740991) return this._badTotal(count);
        this._base[0] = (hi | 0) ^ (lo | 0);
        this._cnt[0] = count;
        if (this._conservative) return this._applyCons();
        return this._applyPlain();
    }

    /**
     * @private Conservative update (Estan-Varghese), 0 B/op, monomorphic. Stage each
     * row's flat index in `_idx`, find the current min across the d cells, then raise
     * only the cells below `min + count` up to it (saturating at CMS_MAX_COUNT). Two
     * passes over d rows, no allocation.
     *
     * ARGUMENT-FREE (F4): `base` and `count` are read from the `_base` / `_cnt` slots
     * the caller wrote, not passed in. A `count` >= 2^31 (lite-hud's cumulative
     * microseconds) passed as an argument boxes a HeapNumber crossing this call in the
     * default tier; reading it from the Float64Array slot keeps the double in-place. The
     * per-row fmix is hand-inlined (identical math to `_m3final`) so this stays monomorphic.
     */
    _applyCons() {
        const d = this._d, w = this._w, mask = this._mask, counts = this._counts, idx = this._idx;
        const base = this._base[0], count = this._cnt[0];
        let mn = 0xffffffff;
        for (let i = 0; i < d; i++) {
            let x = base ^ Math.imul(i, ODD_CONST);
            x = x ^ (x >>> 16); x = Math.imul(x, FMIX_C1); x = x ^ (x >>> 13); x = Math.imul(x, FMIX_C2); x = x ^ (x >>> 16);
            const col = x & mask;
            const id = i * w + col;
            idx[i] = id;
            const v = counts[id];
            if (v < mn) mn = v;
        }
        let target = mn + count;
        if (target > CMS_MAX_COUNT) { target = CMS_MAX_COUNT; this._saturated = true; }
        for (let i = 0; i < d; i++) {
            const id = idx[i];
            if (counts[id] < target) counts[id] = target;
        }
        this._total += count;
        return this;
    }

    /**
     * @private Plain update (classic Count-Min), 0 B/op. Add `count` to one cell per
     * row (saturating at CMS_MAX_COUNT). Linearly mergeable.
     *
     * ARGUMENT-FREE (F4): `base` and `count` are read from the `_base` / `_cnt` slots the
     * caller wrote (see `_applyCons`). The per-row fmix is hand-inlined (identical math to
     * `_m3final`).
     */
    _applyPlain() {
        const d = this._d, w = this._w, mask = this._mask, counts = this._counts;
        const base = this._base[0], count = this._cnt[0];
        for (let i = 0; i < d; i++) {
            let x = base ^ Math.imul(i, ODD_CONST);
            x = x ^ (x >>> 16); x = Math.imul(x, FMIX_C1); x = x ^ (x >>> 13); x = Math.imul(x, FMIX_C2); x = x ^ (x >>> 16);
            const id = i * w + (x & mask);
            let v = counts[id] + count;
            if (v > CMS_MAX_COUNT) { v = CMS_MAX_COUNT; this._saturated = true; }
            counts[id] = v;
        }
        this._total += count;
        return this;
    }

    /**
     * Estimate a key's frequency: the MINIMUM over its d cells (the tightest one-sided
     * over-estimate). HOT, 0 B/op. NEVER throws -- a key that `add` would REJECT (a
     * non-number / NaN / +-Infinity / non-integer / out-of-safe-range key) returns 0
     * (fail-closed: an un-addable key has frequency 0, and never aliases a real key).
     * A typeof wrapper: it writes the key into `_buf[0]`, runs `_estimateAt(_buf, 0)` (which
     * deposits the cell-min into `_buf[1]`, D3), and returns `_buf[1]` -- so the min, a uint32
     * that may be >= 2^31, never boxes a HeapNumber on the non-inlined return from `_estimateAt`.
     * @param {number} key
     * @returns {number}
     */
    estimate(key) {
        if (typeof key !== 'number') return 0;
        const b = this._buf;
        b[0] = key;
        this._estimateAt(b, 0);
        return b[1];
    }

    /**
     * @private The one estimate body: key = `buf[i]`, read UNBOXED. Hand-inlines the two-lane
     * murmur and the per-row fmix (identical bits to `_m3round` / `_m3final`), walks the d cells
     * for their minimum, and writes it into `this._buf[1]` (D3) rather than returning it -- a
     * min >= 2^31 would box on the non-inlined return. A rejected key writes 0. Returns nothing.
     */
    _estimateAt(buf, i) {
        const key = buf[i];
        if (!Number.isInteger(key) || key > 9007199254740991 || key < -9007199254740991) { this._buf[1] = 0; return; }
        const neg = key < 0 ? 1 : 0;
        const a = Math.abs(key);
        // The murmur3 body, hand-inlined (identical bits to _m3round / _m3final): the two
        // mixed blocks are lane-independent, so each is computed once and folded into both lanes.
        let k1 = Math.imul(a | 0, HASH_C1);
        k1 = Math.imul((k1 << 15) | (k1 >>> 17), HASH_C2);
        let k2 = Math.imul((a < 4294967296 ? 0 : ((a / 4294967296) | 0)) ^ (neg << 31), HASH_C1);
        k2 = Math.imul((k2 << 15) | (k2 >>> 17), HASH_C2);
        let h = this._seed ^ k1;
        h = (Math.imul((h << 13) | (h >>> 19), 5) + M3_ADD) | 0;
        h ^= k2;
        h = (Math.imul((h << 13) | (h >>> 19), 5) + M3_ADD) ^ 8;
        h ^= h >>> 16; h = Math.imul(h, FMIX_C1); h ^= h >>> 13; h = Math.imul(h, FMIX_C2); h ^= h >>> 16;    // HI lane
        let g = this._seed ^ LANE_SALT ^ k1;
        g = (Math.imul((g << 13) | (g >>> 19), 5) + M3_ADD) | 0;
        g ^= k2;
        g = (Math.imul((g << 13) | (g >>> 19), 5) + M3_ADD) ^ 8;
        g ^= g >>> 16; g = Math.imul(g, FMIX_C1); g ^= g >>> 13; g = Math.imul(g, FMIX_C2); g ^= g >>> 16;    // LO lane
        const base = h ^ g;
        const d = this._d, w = this._w, mask = this._mask, counts = this._counts;
        let mn = 0xffffffff;
        for (let r = 0; r < d; r++) {
            let x = base ^ Math.imul(r, ODD_CONST);
            x ^= x >>> 16; x = Math.imul(x, FMIX_C1); x ^= x >>> 13; x = Math.imul(x, FMIX_C2); x ^= x >>> 16;
            const v = counts[r * w + (x & mask)];
            if (v < mn) mn = v;
        }
        this._buf[1] = mn;
    }

    /**
     * Estimate from a PRE-HASHED key (two uint32 lanes). HOT, 0 B/op. NEVER throws --
     * a non-uint32 lane returns 0.
     * @param {number} hi high lane (uint32)
     * @param {number} lo low lane (uint32)
     * @returns {number}
     */
    estimateHashed(hi, lo) {
        if (typeof hi !== 'number' || (hi >>> 0) !== hi) return 0;
        if (typeof lo !== 'number' || (lo >>> 0) !== lo) return 0;
        const base = (hi ^ lo) | 0;
        const d = this._d, w = this._w, mask = this._mask, counts = this._counts;
        let mn = 0xffffffff;
        for (let i = 0; i < d; i++) {
            const x = _m3final((base ^ Math.imul(i, ODD_CONST)) | 0);
            const v = counts[i * w + (x & mask)];
            if (v < mn) mn = v;
        }
        return mn;
    }

    /**
     * Merge `other` into this by element-wise saturating add (the mergeability of plain
     * Count-Min; for conservative sketches merge is a valid upper bound, not exact).
     * O(d*w), 0 alloc. A cross-flag merge is allowed (S7): `this` keeps its own
     * `conservative` flag, and the result stays one-sided (exact only when both sides are
     * plain). `saturated` is carried from either side, and any clamp during the merge sets
     * it. Fails closed `[lite-sketch]` if `other` is not a CountMinSketch, differs in
     * d / w / seed, or would push the running `total` past 2^53-1 (F15/S5, byte-identical).
     * A Proxy over an instance or a field copy is NOT a CountMinSketch (the brand is checked, not
     * `instanceof`): the brand predicate is the first statement, before any read of `other`.
     * @param {CountMinSketch} other
     * @returns {CountMinSketch} this
     */
    merge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) return this._badMerge(other);
        if (other._d !== this._d || other._w !== this._w || other._seed !== this._seed) {
            return this._badMerge(other);
        }
        // Total guard BEFORE the first write (F15): a merged total past 2^53-1 is no longer exact.
        if (this._total + other._total > 9007199254740991) return this._badTotal(other._total);
        const a = this._counts, b = other._counts, n = a.length;
        let sat = other._saturated;
        for (let i = 0; i < n; i++) {
            let v = a[i] + b[i];
            if (v > CMS_MAX_COUNT) { v = CMS_MAX_COUNT; sat = true; }
            a[i] = v;
        }
        this._total += other._total;
        if (sat) this._saturated = true;
        return this;
    }

    /** Reset every counter to 0, the running total, and the sticky `saturated` flag. O(d*w). @returns {CountMinSketch} this */
    clear() {
        this._counts.fill(0);
        this._total = 0;
        this._saturated = false;
        return this;
    }

    /** @private Cold: replay add's original guard order for a non-number key or count. */
    _badArgs(key, count) {
        if (typeof key !== 'number' || key !== key || !Number.isInteger(key) ||
            Math.abs(key) > 9007199254740991) return this._badKey(key);
        return this._badCount(count);
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-sketch] CountMinSketch.addFrom(buf, i) needs a Float64Array and an integer index with i and i+1 in bounds, got ' +
            _describe(buf) + ', ' + _describe(i));
    }

    /** @private Cold thrower for a bad addHashedFrom buffer/index. */
    _badHashBuf(buf, i) {
        throw new TypeError(
            '[lite-sketch] CountMinSketch.addHashedFrom(buf, i) needs a Uint32Array or Int32Array and an integer index with i..i+2 in bounds, got ' +
            _describe(buf) + ', ' + _describe(i));
    }

    /** @private Cold thrower for a bad key (_describe runs no user code -- F20). */
    _badKey(key) {
        throw new TypeError('[lite-sketch] CountMinSketch.add key must be a number, got ' + _describe(key));
    }

    /** @private Cold thrower for a bad pre-hashed lane. */
    _badLane(x) {
        throw new TypeError('[lite-sketch] CountMinSketch.addHashed lanes must be uint32, got ' + _describe(x));
    }

    /** @private Cold thrower for a bad count. */
    _badCount(count) {
        throw new RangeError(
            '[lite-sketch] CountMinSketch count must be an integer in [1, ' + CMS_MAX_COUNT + '], got ' + _describe(count));
    }

    /** @private Cold thrower: the running total would exceed the exact-aggregate ceiling 2^53-1. */
    _badTotal(n) {
        throw new RangeError(
            '[lite-sketch] CountMinSketch total would exceed the exact integer ceiling 9007199254740991 (2^53-1): ' +
            'current total ' + this._total + ' + ' + _describe(n));
    }

    /** @private Cold thrower for an incompatible merge (non-instance vs d/w/seed mismatch). */
    _badMerge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) {
            throw new TypeError('[lite-sketch] CountMinSketch.merge expects a CountMinSketch');
        }
        throw new RangeError(
            '[lite-sketch] CountMinSketch.merge requires equal d/w/seed: this d=' + this._d +
            ' w=' + this._w + ' seed=' + (this._seed >>> 0) +
            ', other d=' + other._d + ' w=' + other._w + ' seed=' + (other._seed >>> 0));
    }

    /** @private Cold thrower for an unknown option key (did-you-mean listing known keys). */
    _badOption(key) {
        throw new TypeError(
            '[lite-sketch] CountMinSketch unknown option "' + _describe(key) +
            '"; known options: ' + Object.keys(CMS_KNOWN_OPTS).join(', '));
    }
}

// ===========================================================================
// DDSketch (ADR 0004) -- the quantile member (relative-error quantiles)
// ===========================================================================

/** Default bin-array length when no strict range is given. */
const DD_MAX_BINS_DEFAULT = 2048;
/** Hard ceiling on the bin array so a strict range can never request an unbounded alloc. */
const DD_MAX_BINS_CAP = 1 << 20;
/** Frozen marker of the known option keys -- an unknown key is a throw with a did-you-mean. */
const DD_KNOWN_OPTS = Object.freeze({ __proto__: null, maxBins: true, range: true });
/**
 * Smallest supported DDSketch `alpha`. At the 2^20-bin cap a single filled window spans
 * only about 8x of value range at this alpha, so it is the practical floor; a smaller
 * alpha is rejected at the ctor door (and below ~1e-10 the pre-1.2.0 bound search also
 * hung for seconds as its decrement loop walked a 2^53-scale overshoot one key at a time).
 * The ctor accepts `DD_ALPHA_MIN <= alpha < 1`.
 * @type {number}
 */
export const DD_ALPHA_MIN = 1e-6;

/**
 * DDSketch -- RELATIVE-ERROR QUANTILE estimation over a positive-and-zero value
 * stream in bounded space (Masson, Rim, Lee -- "DDSketch: A Fast and Fully-Mergeable
 * Quantile Sketch with Relative-Error Guarantees", Datadog / VLDB 2019). Unlike the
 * other members it does NOT hash -- it BINS raw values on a log scale.
 *
 * Headline (the family's SHARPEST honesty anchor -- a HARD per-query bound, not a
 * statistical one): `quantile(q)` returns v with `|v - v_true| <= alpha * v_true`.
 * A value x > 0 lands in bucket `key(x) = ceil(ln(x) * multiplier)` where
 * `gamma = (1 + alpha) / (1 - alpha)` and `multiplier = 1 / ln(gamma)`; every x in a
 * bucket shares the representative `gamma^key`, which is within `alpha` relative error
 * of x. Zeros go to a dedicated `_zeroCount` (they are the smallest values); negatives
 * are outside the log domain and fail closed (throw, after the zero check).
 *
 * Bounded space, two disclosed modes:
 *   - DEFAULT (collapsing-lowest): a `Float64Array(maxBins)` window. When a value's key
 *     climbs above the array top the window slides UP and the lowest cells fold (sum)
 *     into the collapsed floor (bin 0). Collapsing the LOW end keeps the HIGH tail
 *     (p90 / p99 / p999 -- what quantile sketches are bought for) exact; only the
 *     smallest values degrade, and `collapsed` discloses when it has happened.
 *   - STRICT (`range: [min, max]`): a fixed bin array sized to exactly cover
 *     `[key(min), key(max)]`; a positive value whose key falls outside THROWS
 *     `[lite-sketch]` -- it never silently collapses. `min` must be > 0 (the log domain).
 *
 * Hot path (`add`, 0 B/op): typeof-guard value + count FIRST, update running stats,
 * route zeros / negatives, compute the bucket key (a transient double -- no BigInt, no
 * box), and in the common steady state increment ONE `Float64Array` cell in the live
 * window and return. The window math (first value, slide + collapse, strict range
 * check) is a COLD tail-call (`_addKey`) off the hot body.
 *
 * Exact vs approximate (disclosed): `count` / `sum` / `min` / `max` / `zeroCount` are
 * EXACT running aggregates; `quantile` is the alpha-approximate one. `merge` folds
 * another same-gamma sketch bucket-by-bucket through the same collapse logic.
 *
 * Indexable range (fail-closed door, the DDSketch-reference behavior): a positive value
 * so large or so tiny that its bucket representative `2*gamma^K/(gamma+1)` would overflow
 * to Infinity or underflow to 0 is REJECTED at `add` time (a throw, byte-identical no-op)
 * -- so `quantile` is ALWAYS a finite, alpha-bounded value. At alpha=0.01 the door admits
 * roughly `(~2.2e-308, ~8.9e307]` (the low end is exclusive: `add` accepts x > the floor);
 * the window widens as alpha grows and narrows as it shrinks. The EXACT runtime bounds are
 * the `minIndexable` / `maxIndexable` getters (`minIndexable` is that low floor).
 *
 * Fail closed: a bad alpha / maxBins / range (incl. a range whose ends are not indexable) /
 * unknown option throws `[lite-sketch]` at the ctor door BEFORE any allocation (no half-built
 * instance); `add` typeof-guards value + count FIRST (Symbol / BigInt / NaN / +-Infinity /
 * non-integer count is a throw, negative value is a throw, out-of-indexable-range is a throw,
 * strict-out-of-range is a throw) -- every throwing path is a byte-identical no-op; `quantile`
 * / getters / a valid `merge` never throw (`quantile` of an empty sketch is NaN). null is not zero.
 */
export class DDSketch {
    /** @private Brand (F21): installed by the ctor on every real instance; `#brand in x` runs no user code, is false for a Proxy / field-copy forgery, and adds no module state. */
    #brand;
    /**
     * @param {number} alpha relative-error target; a number in `[DD_ALPHA_MIN, 1)` =
     *   `[1e-6, 1)`. A smaller alpha throws `[lite-sketch]` at the ctor door.
     * @param {{maxBins?: number, range?: [number, number]}} [options]
     *   maxBins: bin-array length in [1, 2^20] (default 2048); ignored in strict mode
     *            where the length is derived from `range`.
     *   range: [min, max] with finite `0 < min < max` -> STRICT mode (fail-closed, no collapse).
     */
    constructor(alpha, options) {
        // typeof guard FIRST, BEFORE any allocation. The domain floor is DD_ALPHA_MIN (S2):
        // a smaller alpha is rejected here, before the indexable-bound math runs.
        if (typeof alpha !== 'number' || !(alpha >= DD_ALPHA_MIN && alpha < 1)) {
            throw new RangeError(
                '[lite-sketch] DDSketch alpha must be a number in [' + DD_ALPHA_MIN.toExponential() + ', 1), got ' + _describe(alpha));
        }
        let maxBins = DD_MAX_BINS_DEFAULT;
        let range;
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError(
                    '[lite-sketch] DDSketch options must be a plain object, got ' + _describe(options));
            }
            // F18: classify the bag and read its own data values inside ONE try, so a revoked /
            // throwing-trap Proxy becomes the plain-object TypeError (not an untagged engine throw).
            let bad, maxBinsOwn, rangeOwn;
            try {
                bad = _optScan(options, DD_KNOWN_OPTS);
                if (bad === null) {
                    maxBinsOwn = _optOwn(options, 'maxBins');
                    rangeOwn = _optOwn(options, 'range');
                }
            } catch (e) {
                bad = _NOT_BAG;
            }
            if (bad === _NOT_BAG) {
                throw new TypeError(
                    '[lite-sketch] DDSketch options must be a plain object, got ' + _describe(options));
            }
            if (bad !== null) this._badOption(bad);
            // Value checks AFTER the try (never swallowed by it), verbatim from HEAD.
            if (maxBinsOwn !== undefined) {
                maxBins = maxBinsOwn;
                if (typeof maxBins !== 'number' || (maxBins | 0) !== maxBins ||
                    maxBins < 1 || maxBins > DD_MAX_BINS_CAP) {
                    throw new RangeError(
                        '[lite-sketch] DDSketch maxBins must be an integer in [1, ' +
                        DD_MAX_BINS_CAP + '], got ' + _describe(maxBins));
                }
            }
            if (rangeOwn !== undefined) range = rangeOwn;
        }
        const gamma = (1 + alpha) / (1 - alpha);
        const multiplier = 1 / Math.log(gamma);
        const lnGamma = Math.log(gamma);
        // Defensive, unreachable inside the [DD_ALPHA_MIN, 1) domain (gamma is ~1.000002..Inf there):
        // a non-log base (gamma <= 1, or a non-finite multiplier / lnGamma) fails closed, not silently.
        if (!(gamma > 1) || !Number.isFinite(multiplier) || !Number.isFinite(lnGamma)) {
            throw new RangeError(
                '[lite-sketch] DDSketch could not derive a finite log base from alpha ' + _describe(alpha));
        }
        // The KEY bounds for which the representative `2*gamma^K/(gamma+1)` stays a finite,
        // NORMAL (full-relative-precision) double: above _maxKeyIndexable it overflows to
        // Infinity; below _minKeyIndexable it falls into the denormal range where a double
        // loses relative precision and the alpha guarantee breaks (bottoming out at
        // underflow-to-0 / ~100% error). A value whose key falls outside is rejected at add()
        // time (the DDSketch-reference fail-closed door). The closed form
        // `K = floor((ln MAX_VALUE - ln 2) / ln gamma)` lands on the exact bound at every alpha
        // in the supported domain (0 fix-up steps measured over 3000 alphas); the OLD form added
        // `ln((gamma+1)/2)` instead of subtracting `ln 2`, overshooting by ~0.3466/alpha keys,
        // and the decrement loop below then walked that back one key at a time -- a multi-second
        // hang for small alpha, infinite once K passed 2^53 (F10). The BIDIRECTIONAL fix-up (one
        // shared cap of 4 steps PER BOUND, then a tagged throw) is now a defensive guard against
        // float rounding of the log/pow, not a corrector of a systematic overshoot. It uses the
        // SAME representative expression quantile() evaluates. MIN_NORMAL = 2^-1022 is the
        // smallest normal double.
        const MIN_NORMAL = 2 ** -1022;
        const lnHalfGammaPlus1 = Math.log((gamma + 1) / 2);
        let boundOk = true;
        let maxKeyIndexable = Math.floor((Math.log(Number.MAX_VALUE) - Math.LN2) / lnGamma);
        let fx = 0;
        while (!Number.isFinite(2 * Math.pow(gamma, maxKeyIndexable) / (gamma + 1))) {
            maxKeyIndexable--;
            if (++fx > 4) { boundOk = false; break; }
        }
        while (boundOk && Number.isFinite(2 * Math.pow(gamma, maxKeyIndexable + 1) / (gamma + 1))) {
            maxKeyIndexable++;
            if (++fx > 4) { boundOk = false; break; }
        }
        let minKeyIndexable = Math.ceil((Math.log(MIN_NORMAL) + lnHalfGammaPlus1) / lnGamma);
        fx = 0;
        while (boundOk && 2 * Math.pow(gamma, minKeyIndexable) / (gamma + 1) < MIN_NORMAL) {
            minKeyIndexable++;
            if (++fx > 4) { boundOk = false; break; }
        }
        while (boundOk && 2 * Math.pow(gamma, minKeyIndexable - 1) / (gamma + 1) >= MIN_NORMAL) {
            minKeyIndexable--;
            if (++fx > 4) { boundOk = false; break; }
        }
        if (!boundOk) {
            throw new RangeError(
                '[lite-sketch] DDSketch could not bound the indexable key range for alpha ' + _describe(alpha));
        }
        // EXACT acceptance edges of add's OWN key expression `ceil(log(x) * multiplier)` (F17),
        // found by bit-level bisection of THAT expression with THIS multiplier -- so the
        // minIndexable / maxIndexable getters are the real door, not the off-by-ulps
        // `pow(gamma, K+-1)` the pre-1.2.0 code exposed (up to ~4e-13 relative). add accepts a
        // finite x > 0 iff `minKeyIndexable <= ceil(log(x)*multiplier) <= maxKeyIndexable`, so the
        // LOWER edge is EXCLUSIVE (the last REJECTED double; add accepts x > it) and the UPPER edge
        // is INCLUSIVE (the last ACCEPTED double). maxKeyIndexable keeps `2*gamma^maxK/(gamma+1)`
        // finite, hence `gamma^maxK <= MAX_VALUE/2`, so MAX_VALUE ALWAYS maps above maxKeyIndexable
        // and the top accepted value is strictly below it. Cold, plain doubles -- no BigInt, no
        // array. Over 3000 alphas this converges in <= 25 steps; a broken bracket or the 80-step
        // cap fails closed.
        let edgeOk = true;
        let eLo = Math.pow(gamma, minKeyIndexable - 1) * (1 - 1e-9);
        let eHi = Math.pow(gamma, minKeyIndexable - 1) * (1 + 1e-9);
        if (Math.ceil(Math.log(eLo) * multiplier) >= minKeyIndexable ||
            Math.ceil(Math.log(eHi) * multiplier) < minKeyIndexable) edgeOk = false;
        if (edgeOk) {
            let bs = 0;
            for (;;) {
                const mid = eLo + (eHi - eLo) / 2;
                if (mid === eLo || mid === eHi) break;
                if (Math.ceil(Math.log(mid) * multiplier) >= minKeyIndexable) eHi = mid; else eLo = mid;
                if (++bs > 80) { edgeOk = false; break; }
            }
        }
        const minIndexable = eLo;   // EXCLUSIVE floor: add accepts x > this (the last rejected double)
        eLo = Math.pow(gamma, maxKeyIndexable) * (1 - 1e-9);
        eHi = Math.pow(gamma, maxKeyIndexable) * (1 + 1e-9);
        if (Math.ceil(Math.log(eLo) * multiplier) > maxKeyIndexable ||
            Math.ceil(Math.log(eHi) * multiplier) <= maxKeyIndexable) edgeOk = false;
        if (edgeOk) {
            let bs = 0;
            for (;;) {
                const mid = eLo + (eHi - eLo) / 2;
                if (mid === eLo || mid === eHi) break;
                if (Math.ceil(Math.log(mid) * multiplier) > maxKeyIndexable) eHi = mid; else eLo = mid;
                if (++bs > 80) { edgeOk = false; break; }
            }
        }
        const maxIndexable = eLo;   // INCLUSIVE ceiling: the last accepted double (always < MAX_VALUE)
        if (!edgeOk) {
            throw new RangeError(
                '[lite-sketch] DDSketch could not resolve the exact indexable edges for alpha ' + _describe(alpha));
        }
        let strict = false;
        let minKey = 0, maxKeyStrict = 0, nb = 0;
        let rangeMinVal = NaN, rangeMaxVal = NaN;   // the VALIDATED range ends, read exactly once per index (F18 TOCTOU)
        if (range !== undefined) {
            // F18: the container reads (isArray / length / [0] / [1]) run inside ONE try, so a
            // revoked / throwing-trap Proxy range becomes the tagged _badRange, not an engine throw.
            let rmin, rmax, okr = false;
            try {
                if (Array.isArray(range) && range.length === 2) {
                    rmin = range[0];
                    rmax = range[1];
                    okr = true;
                }
            } catch (e) {
                okr = false;
            }
            if (!okr) this._badRange(range);
            // min must be > 0 (the log domain); zeros always route to _zeroCount regardless.
            if (typeof rmin !== 'number' || typeof rmax !== 'number' ||
                !Number.isFinite(rmin) || !Number.isFinite(rmax) ||
                !(rmin > 0) || !(rmin < rmax)) {
                this._badRange(range);
            }
            strict = true;
            rangeMinVal = rmin;   // keep the VALIDATED numbers; never re-read range[0] / range[1]
            rangeMaxVal = rmax;
            minKey = Math.ceil(Math.log(rmin) * multiplier);
            maxKeyStrict = Math.ceil(Math.log(rmax) * multiplier);
            // A declared range whose ends can't be represented is invalid (fail closed).
            if (minKey < minKeyIndexable || maxKeyStrict > maxKeyIndexable) this._badRange(range);
            nb = maxKeyStrict - minKey + 1;
            if (nb > DD_MAX_BINS_CAP) {
                throw new RangeError(
                    '[lite-sketch] DDSketch strict range needs ' + nb +
                    ' bins, exceeds cap ' + DD_MAX_BINS_CAP);
            }
        }
        // Allocate LAST (no half-built instance on any thrown path above).
        this._alpha = alpha;
        this._gamma = gamma;
        this._multiplier = multiplier;
        this._strict = strict;
        this._minKey = minKey;              // strict: lowest legal key (also the fixed _offset)
        this._maxKeyStrict = maxKeyStrict;  // strict: highest legal key
        this._maxKeyIndexable = maxKeyIndexable;  // key ceiling: representative stays finite
        this._minKeyIndexable = minKeyIndexable;  // key floor: representative stays positive
        // The EXACT x bounds add() accepts at this alpha (0-alloc getters read these), resolved
        // above by bisecting add's own key expression -- NOT `pow(gamma, K+-1)`, which is off by
        // ulps. add accepts a finite x > 0 iff `_minIndexable < x <= _maxIndexable` (plus exact 0
        // always): the floor is the last REJECTED double, the ceiling the last ACCEPTED one.
        this._minIndexable = minIndexable;  // EXCLUSIVE floor: add accepts x > this
        this._maxIndexable = maxIndexable;  // INCLUSIVE ceiling: add accepts x <= this
        this._rangeMin = rangeMinVal;   // the VALIDATED range ends (NaN if not strict); never re-read range[i]
        this._rangeMax = rangeMaxVal;
        this._bins = new Float64Array(strict ? nb : maxBins);
        this._maxBins = this._bins.length;
        // physical index of key K is K - _offset; the array spans keys [_offset, _offset+maxBins-1].
        this._offset = strict ? minKey : 0;
        this._maxKeyPop = 0;   // highest populated key -- bounds the quantile walk (valid iff _binCount)
        this._zeroCount = 0;
        this._count = 0;
        this._sum = 0;
        this._min = Infinity;
        this._max = -Infinity;
        this._collapsed = false;
        this._binCount = 0;    // 0 => no bin populated yet (the window is not yet anchored)
    }

    /** The relative-error target alpha. O(1). */
    get alpha() { return this._alpha; }
    /** Total values added (sum of all counts, incl. zeros). O(1). */
    get count() { return this._count; }
    /** Exact running sum of every added value. O(1). */
    get sum() { return this._sum; }
    /** EXACT minimum value seen (NaN if empty). `+ 0` normalizes a stored -0 to +0 (F18). O(1). */
    get min() { return this._count ? this._min + 0 : NaN; }
    /** EXACT maximum value seen (NaN if empty). `+ 0` normalizes a stored -0 to +0 (F18). O(1). */
    get max() { return this._count ? this._max + 0 : NaN; }
    /** How many exact zeros were added. O(1). */
    get zeroCount() { return this._zeroCount; }
    /** Bin-array length (the space cap on the log-scale window). O(1). */
    get maxBins() { return this._maxBins; }
    /** Count of currently non-empty bins (COLD, O(maxBins) scan). */
    get numBins() {
        const bins = this._bins;
        const n = bins.length;
        let c = 0;
        for (let i = 0; i < n; i++) if (bins[i] !== 0) c++;
        return c;
    }
    /** Whether any nonzero mass has ever been folded into the collapsed floor (precision lost at the low end). O(1). */
    get collapsed() { return this._collapsed; }
    /** Whether this is a STRICT fixed-range sketch (range given at construction; no collapse). O(1). */
    get strict() { return this._strict; }
    /**
     * The smallest x > 0 that `add` accepts at this alpha (the EXCLUSIVE lower floor:
     * `add` accepts a finite x with `minIndexable < x <= maxIndexable`, plus exact 0).
     * Below it the bucket representative would fall denormal and lose the alpha guarantee.
     * The exact runtime answer to the "low indexable bound" -- roughly 2.2e-308 at alpha=0.01,
     * narrowing as alpha shrinks. O(1), 0 B/op, never throws. `null` is not zero.
     */
    get minIndexable() { return this._minIndexable; }
    /**
     * The largest x that `add` accepts at this alpha (INCLUSIVE): `add` accepts a finite x
     * with `minIndexable < x <= maxIndexable`. Above it the representative would overflow to
     * Infinity. Roughly 8.9e307 at alpha=0.01. O(1), 0 B/op, never throws.
     */
    get maxIndexable() { return this._maxIndexable; }
    /** STRICT mode: the configured range minimum passed at construction (NaN if not strict). O(1). */
    get rangeMin() { return this._rangeMin; }
    /** STRICT mode: the configured range maximum passed at construction (NaN if not strict). O(1). */
    get rangeMax() { return this._rangeMax; }

    /**
     * Add a value with a positive integer `count` (default 1). HOT, 0 B/op. Updates the
     * exact running stats, routes zeros to `_zeroCount`, fails closed on negatives, then
     * bins the value on the log scale: in the steady state it increments ONE cell of the
     * live window and returns. Everything else (first value, window slide + collapse,
     * strict range check) is the cold `_addKey` tail-call.
     *
     * `Math.log` and the bucket key are transient DOUBLES kept in locals -- no BigInt, no
     * object, no boxed slot -- so the in-window path is a true 0 B/op.
     *
     * Fails closed: a non-number / NaN / +-Infinity value throws, a negative value throws
     * (positive+zero domain), a count outside [1, 2^32-1] throws, and an add that would push
     * the running `count` past 2^53-1 throws (F15/S5, the aggregate stays exact) -- all
     * `[lite-sketch]`, typeof guards FIRST, each a byte-identical no-op.
     * @param {number} value a finite number >= 0 (negatives throw).
     * @param {number} [count=1] a positive integer in [1, 2^32-1].
     * @returns {DDSketch} this
     */
    add(value, count = 1) {
        // ALL validation precedes ANY state write: every throwing path is a byte-identical no-op.
        // Number.isFinite rejects a non-number / NaN / +-Infinity in one non-coercing call (identical
        // accept/reject set to the explicit chain, and no user code runs on a non-number), which keeps
        // the hot body under the V8 inline-bytecode cap.
        if (!Number.isFinite(value)) return this._badValue(value);
        // ONE cold branch for count-domain AND running-total overflow: Number.isInteger never coerces,
        // so the typeof check folds in, and `_badCount` picks the count-domain vs total-ceiling message.
        // Runs BEFORE the value<0 check.
        if (!(Number.isInteger(count) && count >= 1 && count <= 4294967295) ||
            this._count + count > 9007199254740991) return this._badCount(count);
        if (value < 0) return this._badValue(value);   // negatives fail closed BEFORE any aggregate write
        if (value === 0) {                             // zeros are the smallest values (0 can be a new min/max)
            this._count += count;
            if (value < this._min) this._min = value;
            if (value > this._max) this._max = value;
            this._zeroCount += count;
            return this;
        }
        const k = Math.ceil(Math.log(value) * this._multiplier);
        // INDEXABLE range: a key whose representative would overflow/underflow the double
        // range is rejected (fail closed) so quantile() is always a finite, alpha-bounded value.
        if (k > this._maxKeyIndexable || k < this._minKeyIndexable) return this._badIndexable(value);
        // STRICT range validated BEFORE aggregates so a rejected add corrupts nothing.
        if (this._strict && (k < this._minKey || k > this._maxKeyStrict)) return this._badValue(value);
        // Only now, past every throw, write the exact running aggregates.
        this._count += count;
        this._sum += value * count;
        if (value < this._min) this._min = value;
        if (value > this._max) this._max = value;
        const idx = k - this._offset;
        if (this._binCount !== 0 && idx >= 0 && idx < this._maxBins) {
            this._bins[idx] += count;                  // the HOT common path: one in-window increment
            if (k > this._maxKeyPop) this._maxKeyPop = k;
            return this;
        }
        return this._addKey(k, count);                 // cold: first value / slide (strict already validated)
    }

    /**
     * Add the value at `buf[i]` of a caller-owned `Float64Array` (count = 1). HOT, 0 B/op --
     * the ZERO-BOX entry point for a FRACTIONAL hot-path value. Identical validation, throws,
     * byte-identical-no-op-on-reject, and binning as `add(value)`; it differs ONLY in how the
     * value crosses the call boundary: `add(fractionalDouble)` boxes its tagged argument into a
     * ~16 B HeapNumber per call when V8 does not inline the call, whereas `addFrom(buf, i)`
     * crosses as (object, Smi) and reads `buf[i]` as an UNBOXED double in a local. A consumer
     * that computes a fractional value on its own hot path (e.g. a span duration `t - tOpen`)
     * writes it into a length-1 scratch and calls `addFrom(scratch, 0)` to stay at 0 B/op.
     * Integer-valued inputs box as Smi and cost nothing either way; the win is fractional values.
     *
     * Fails closed BEFORE any state write (typeof-first): a non-Float64Array `buf`, a non-integer
     * or out-of-bounds `i`, then the same value rejects as `add` (non-number is impossible from a
     * Float64Array read, but NaN / +-Infinity / negative / out-of-indexable / strict-out-of-range
     * all still throw `[lite-sketch]`).
     * @param {Float64Array} buf a caller-owned Float64Array holding the value.
     * @param {number} i an in-bounds index into `buf`.
     * @returns {DDSketch} this
     */
    addFrom(buf, i) {
        // Validate the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(buf instanceof Float64Array) || !Number.isInteger(i) ||
            i < 0 || i >= buf.length) return this._badBuf(buf, i);
        const value = buf[i];   // UNBOXED Float64Array read -- the whole point (no argument box).
        // From here the body mirrors add(value, 1) exactly; count is a literal 1 (a Smi, never boxed).
        // Number.isFinite rejects NaN / +-Infinity in one call (buf[i] is always a number), keeping the
        // hot body under the V8 inline-bytecode cap.
        if (!Number.isFinite(value)) return this._badValue(value);
        if (this._count + 1 > 9007199254740991) return this._badTotal(1);
        if (value < 0) return this._badValue(value);
        if (value === 0) {
            this._count += 1;
            if (value < this._min) this._min = value;
            if (value > this._max) this._max = value;
            this._zeroCount += 1;
            return this;
        }
        const k = Math.ceil(Math.log(value) * this._multiplier);
        if (k > this._maxKeyIndexable || k < this._minKeyIndexable) return this._badIndexable(value);
        if (this._strict && (k < this._minKey || k > this._maxKeyStrict)) return this._badValue(value);
        this._count += 1;
        this._sum += value;
        if (value < this._min) this._min = value;
        if (value > this._max) this._max = value;
        const idx = k - this._offset;
        if (this._binCount !== 0 && idx >= 0 && idx < this._maxBins) {
            this._bins[idx] += 1;                      // the HOT common path: one in-window increment
            if (k > this._maxKeyPop) this._maxKeyPop = k;
            return this;
        }
        return this._addKey(k, 1);                     // cold: first value / slide
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-sketch] DDSketch.addFrom(buf, i) needs a Float64Array and an in-bounds integer index, got ' +
            _describe(buf) + ', ' + _describe(i));
    }

    /**
     * @private The cold window math shared by `add` (out-of-window) and `merge`
     * (bucket-by-bucket). NEVER throws -- both callers validate the strict range up
     * front (a rejected add/merge must be a byte-identical no-op), so by the time a
     * key reaches here it is guaranteed placeable. Routes a (key, mass) pair:
     *   - strict mode: the array already spans exactly [_minKey, _maxKeyStrict], so
     *     drop the key straight into its cell (no collapse, no slide);
     *   - non-strict first bucketed value: anchor the key at the TOP of the array so
     *     smaller values fill downward (collapsing-lowest protects the high end);
     *   - non-strict in-window key (merge case): a single increment;
     *   - non-strict, key BELOW the floor: fold into bin 0 (collapsed, offset unchanged);
     *   - non-strict, key ABOVE the top: slide the window up, folding the vacated low
     *     cells into the new bin 0.
     * @param {number} k bucket key
     * @param {number} mass count to add
     * @returns {DDSketch} this
     */
    _addKey(k, mass) {
        const maxBins = this._maxBins;
        const bins = this._bins;
        if (this._strict) {                            // _offset == _minKey; k pre-validated in range
            bins[k - this._offset] += mass;
            if (this._binCount === 0) { this._binCount = 1; this._maxKeyPop = k; }
            else if (k > this._maxKeyPop) this._maxKeyPop = k;
            return this;
        }
        if (this._binCount === 0) {
            this._offset = k - (maxBins - 1);          // anchor at the TOP, fill downward
            bins[k - this._offset] += mass;
            this._maxKeyPop = k;
            this._binCount = 1;
            return this;
        }
        const idx = k - this._offset;
        if (idx >= 0 && idx < maxBins) {               // in-window (reached via merge)
            bins[idx] += mass;
            if (k > this._maxKeyPop) this._maxKeyPop = k;
            return this;
        }
        if (idx < 0) {                                  // below the floor: collapsing-lowest fold
            bins[0] += mass;
            this._collapsed = true;
            return this;                                // _offset unchanged (the low end is collapsed)
        }
        // idx > maxBins - 1: slide the window UP so k sits at the top.
        const newOffset = k - (maxBins - 1);
        const delta = newOffset - this._offset;         // > 0
        if (delta >= maxBins) {                          // everything folds into bin 0
            let m = 0;
            for (let i = 0; i < maxBins; i++) { m += bins[i]; bins[i] = 0; }
            if (m !== 0) this._collapsed = true;
            bins[0] = m;
        } else {                                         // fold the delta lowest cells into bin 0
            let m = 0;
            for (let i = 0; i < delta; i++) m += bins[i];
            bins.copyWithin(0, delta, maxBins);          // shift counts DOWN by delta (in place)
            bins.fill(0, maxBins - delta, maxBins);      // zero the vacated top
            bins[0] += m;
            if (m !== 0) this._collapsed = true;
        }
        this._offset = newOffset;
        bins[k - this._offset] += mass;
        this._maxKeyPop = k;                             // the floor rose; the new key is the top
        return this;
    }

    /**
     * Estimate the value at quantile q in [0, 1] -- the alpha-approximate member. COLD,
     * O(bins), NEVER throws. Returns NaN for a bad q or an empty sketch. Zeros are the
     * smallest values (they precede bin 0); the returned representative
     * `2 * gamma^K / (gamma + 1)` is the bucket midpoint, within `alpha` relative error
     * of the true value.
     * @param {number} q a number in [0, 1].
     * @returns {number}
     */
    quantile(q) {
        if (typeof q !== 'number' || q !== q || q < 0 || q > 1 || this._count === 0) return NaN;
        const rank = Math.floor(q * (this._count - 1));  // 0-indexed target rank
        let cum = this._zeroCount;
        if (rank < cum) return 0;                         // the target falls in the zero bucket
        const bins = this._bins;
        const offset = this._offset;
        const gamma = this._gamma;
        const top = this._binCount === 0 ? -1 : this._maxKeyPop - offset;
        for (let i = 0; i <= top; i++) {
            cum += bins[i];
            if (cum > rank) {
                const K = i + offset;
                return 2 * Math.pow(gamma, K) / (gamma + 1);
            }
        }
        if (top >= 0) {                                   // rounding at q=1: highest populated bucket
            return 2 * Math.pow(gamma, this._maxKeyPop) / (gamma + 1);
        }
        return NaN;
    }

    /**
     * Estimate several quantiles at once into a caller-owned Float64Array, 0 ALLOC (F8) -- the
     * zero-alloc render for p50/p90/p99/p999. `out[j]` receives `quantile(qs[j])` BIT-FOR-BIT
     * (the walk below is quantile's own body, duplicated per q; a shared helper would box the
     * returned double at the call boundary -- the cost `quantile(q)` itself pays, 16 B in a
     * non-inlined call). `q` is read from `qs` and the value written to `out`, so neither crosses
     * a call. The number written is `m = min(qs.length, out.length)`, returned; a bad `q` value
     * (NaN / out of [0,1] / empty sketch) writes NaN and NEVER throws. In-place `qs === out` is
     * allowed (each index is read before it is written). An arg that is not a Float64Array, or a
     * PARTIAL overlap of distinct views, throws a tagged TypeError BEFORE any write.
     * @param {Float64Array} qs quantiles in [0, 1]
     * @param {Float64Array} out destination (may be `qs`)
     * @returns {number} the number of quantiles written
     */
    quantilesInto(qs, out) {
        const lq = _f64Len(qs), lo = _f64Len(out);
        if (lq < 0 || lo < 0 || _f64Clash(qs, out, true)) return this._badQuantiles(qs, out);
        const m = lq < lo ? lq : lo;
        for (let j = 0; j < m; j++) {
            const q = qs[j];
            // --- quantile(q)'s body verbatim; each `return X` becomes `out[j] = X; break qrun` ---
            qrun: {
                if (typeof q !== 'number' || q !== q || q < 0 || q > 1 || this._count === 0) { out[j] = NaN; break qrun; }
                const rank = Math.floor(q * (this._count - 1));  // 0-indexed target rank
                let cum = this._zeroCount;
                if (rank < cum) { out[j] = 0; break qrun; }       // the target falls in the zero bucket
                const bins = this._bins;
                const offset = this._offset;
                const gamma = this._gamma;
                const top = this._binCount === 0 ? -1 : this._maxKeyPop - offset;
                for (let i = 0; i <= top; i++) {
                    cum += bins[i];
                    if (cum > rank) {
                        const K = i + offset;
                        out[j] = 2 * Math.pow(gamma, K) / (gamma + 1);
                        break qrun;
                    }
                }
                if (top >= 0) {                                   // rounding at q=1: highest populated bucket
                    out[j] = 2 * Math.pow(gamma, this._maxKeyPop) / (gamma + 1);
                    break qrun;
                }
                out[j] = NaN;
            }
        }
        return m;
    }

    /**
     * Merge `other` into this: add the running aggregates and fold every populated bin of
     * `other` through the same collapse logic as `add` (so the collapsed floor stays
     * consistent). O(other bins), NEVER allocates. Fails closed `[lite-sketch]` if `other`
     * is not a DDSketch or has a different gamma (i.e. a different alpha). If this is in
     * STRICT mode, an incoming key outside the fixed range throws (documented fail-closed),
     * and a COLLAPSED `other` is rejected outright (S3): its low-end mass has already folded,
     * so a strict sketch cannot absorb it without breaking its range guarantee. A non-strict
     * `this` carries `other._collapsed` forward (merging collapsed mass makes `this` collapsed).
     * A merge that would push the running `count` past 2^53-1 throws tagged (F15/S5), as a
     * byte-identical no-op.
     * A Proxy over an instance or a field copy is NOT a DDSketch (the brand is checked, not
     * `instanceof`): the brand predicate is the first statement, before any read of `other`.
     * @param {DDSketch} other
     * @returns {DDSketch} this
     */
    merge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) return this._badMerge(other);
        if (other._gamma !== this._gamma) return this._badMerge(other);
        // A strict sketch cannot absorb a collapsed other (S3): reject AFTER the gamma check and
        // BEFORE the strict pre-scan, as a byte-identical no-op (no write has happened yet).
        if (this._strict && other._collapsed) return this._badMergeCollapsed();
        // STRICT: pre-scan other's populated keys against this fixed range and fail closed
        // BEFORE any aggregate/bin write -- a rejected merge is a byte-identical no-op too.
        if (this._strict && other._binCount !== 0) {
            const ob = other._bins;
            const ooff = other._offset;
            const gamma = this._gamma;
            const otop = other._maxKeyPop - ooff;
            for (let i = 0; i <= otop; i++) {
                if (ob[i] !== 0) {
                    const key = i + ooff;
                    if (key < this._minKey || key > this._maxKeyStrict) {
                        return this._badValue(2 * Math.pow(gamma, key) / (gamma + 1));
                    }
                }
            }
        }
        // Total guard BEFORE the first write (F15): a merged count past 2^53-1 is no longer exact.
        if (this._count + other._count > 9007199254740991) return this._badTotal(other._count);
        // Past every throw (gamma, strict-collapsed, strict pre-scan, total): carry other's collapsed
        // state, then write the aggregates and fold each populated bin.
        if (other._collapsed) this._collapsed = true;
        this._zeroCount += other._zeroCount;
        this._count += other._count;
        this._sum += other._sum;
        if (other._min < this._min) this._min = other._min;
        if (other._max > this._max) this._max = other._max;
        if (other._binCount !== 0) {
            const ob = other._bins;
            const ooff = other._offset;
            const otop = other._maxKeyPop - ooff;
            for (let i = 0; i <= otop; i++) {
                const mass = ob[i];
                if (mass !== 0) this._addKey(i + ooff, mass);
            }
        }
        return this;
    }

    /** Reset the sketch to empty. O(maxBins). @returns {DDSketch} this */
    clear() {
        this._bins.fill(0);
        this._offset = this._strict ? this._minKey : 0;
        this._maxKeyPop = 0;
        this._zeroCount = 0;
        this._count = 0;
        this._sum = 0;
        this._min = Infinity;
        this._max = -Infinity;
        this._collapsed = false;
        this._binCount = 0;
        return this;
    }

    /** @private Cold thrower for a bad value (non-finite / negative / strict-out-of-range). */
    _badValue(value) {
        throw new TypeError(
            '[lite-sketch] DDSketch value must be finite, non-negative, and within the strict ' +
            'range if configured, got ' + _describe(value));
    }

    /** @private Cold thrower for a value outside the indexable range (representative would over/underflow). */
    _badIndexable(value) {
        throw new RangeError(
            '[lite-sketch] DDSketch.add value ' + _describe(value) + ' is outside the sketch\'s indexable range');
    }

    /**
     * @private Cold thrower for the folded count branch: dispatches to the running-total ceiling
     * message when the count itself is valid (so the only cause left is overflow), else the
     * count-domain message. Keeps both H2.3 messages byte-identical while the hot `add` uses one branch.
     */
    _badCount(count) {
        if (Number.isInteger(count) && count >= 1 && count <= 4294967295) return this._badTotal(count);
        throw new RangeError(
            '[lite-sketch] DDSketch count must be an integer in [1, 4294967295], got ' + _describe(count));
    }

    /** @private Cold thrower: the running count would exceed the exact-aggregate ceiling 2^53-1. */
    _badTotal(n) {
        throw new RangeError(
            '[lite-sketch] DDSketch count would exceed the exact integer ceiling 9007199254740991 (2^53-1): ' +
            'current count ' + this._count + ' + ' + _describe(n));
    }

    /** @private Cold thrower for a bad strict range. */
    _badRange(range) {
        throw new RangeError(
            '[lite-sketch] DDSketch range must be [min, max] with finite 0 < min < max, got ' + _describe(range));
    }

    /** @private Cold thrower for bad quantilesInto arrays (not two non-overlapping Float64Arrays). */
    _badQuantiles(qs, out) {
        throw new TypeError(
            '[lite-sketch] DDSketch.quantilesInto(qs, out) needs two non-overlapping Float64Arrays, got ' +
            _describe(qs) + ', ' + _describe(out));
    }

    /** @private Cold thrower: a strict sketch cannot absorb a collapsed sketch's low-end mass (S3). */
    _badMergeCollapsed() {
        throw new RangeError(
            '[lite-sketch] DDSketch.merge: a strict sketch cannot absorb a collapsed sketch ' +
            '(its low-end mass has already folded, so the strict range guarantee cannot hold)');
    }

    /** @private Cold thrower for an incompatible merge (non-instance vs unequal gamma/alpha). */
    _badMerge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) {
            throw new TypeError('[lite-sketch] DDSketch.merge expects a DDSketch');
        }
        throw new RangeError(
            '[lite-sketch] DDSketch.merge requires equal gamma/alpha: this alpha=' + this._alpha +
            ', other alpha=' + other._alpha);
    }

    /** @private Cold thrower for an unknown option key (did-you-mean listing known keys). */
    _badOption(key) {
        throw new TypeError(
            '[lite-sketch] DDSketch unknown option "' + _describe(key) +
            '"; known options: ' + Object.keys(DD_KNOWN_OPTS).join(', '));
    }
}

// === SpaceSaving (ADR 0005) -- the heavy-hitters / top-k member ===

/** Highest legal counter capacity k. A TYPE bound (k typed arrays + a 2k map), not a size any host materializes. */
const SS_CAP_MAX = 1 << 24;
/** Frozen marker of the known option keys -- an unknown key is a throw with a did-you-mean. */
const SS_KNOWN_OPTS = Object.freeze({ __proto__: null, seed: true });
/** Default per-instance seed (shared with the other members so a default-seeded SpaceSaving hashes identically). */
const SS_DEFAULT_SEED = HLL_DEFAULT_SEED;

/**
 * SpaceSaving -- HEAVY-HITTERS / TOP-K estimation over an unbounded stream in FIXED
 * space (Metwally, Agrawal, El Abbadi -- "Efficient Computation of Frequent and Top-k
 * Elements in Data Streams", ICDT 2005). Monitor at most k counters; every stream
 * element either bumps a monitored counter, fills a free slot, or -- when full -- EVICTS
 * the MIN-count key and reassigns its slot to the newcomer at `count = min + count` with
 * `error = min`. It NEVER fails at capacity (eviction IS the algorithm).
 *
 * Headline (the guarantee): any key with true frequency `> N / k` (N = the total mass) is
 * GUARANTEED monitored; a monitored key's true count is bracketed in `[count - error,
 * count]`; and `error <= min counter <= N / k`. So `epsilon = 1 / k` is the relative error
 * on the reported count. `heavyHitters(threshold)` returns every monitored key with
 * `count > threshold * total` -- a SUPERSET with NO FALSE NEGATIVES (a true hitter is never
 * missed); it may include false positives. For the guaranteed-frequent subset, filter the
 * results by `(count - error) > threshold * total`.
 *
 * Substrate (all typed arrays allocated ONCE in the ctor; every hot op is 0-alloc):
 *   - k COUNTER SLOTS: `_key` / `_count` / `_error` (Float64Array; safe-int keys exact to
 *     2^53). Each slot links into an intrusive COUNT-BUCKET FOREST: `_cNext` / `_cPrev`
 *     (its sibling list within a bucket) + `_cBucket` (its owning bucket id).
 *   - a BUCKET POOL of at most k distinct count-values: `_bVal` (the count a bucket
 *     represents), `_bNext` / `_bPrev` (a doubly-linked list of buckets sorted ASCENDING by
 *     `_bVal`), `_bHead` (the head counter-slot of the bucket's sibling list; -1 = empty), a
 *     free-list `_bFree` + `_bFreeTop`, and `_minBucket` (the lowest-value bucket, -1 when
 *     empty). The min-count key is therefore `O(1)`: the head of the min bucket.
 *   - an OPEN-ADDRESSING key map (`M = next pow2 >= 2k`, load <= 0.5): `_mapKey`
 *     (Float64Array), `_mapOcc` (Uint8Array so key 0 is a legal, distinguishable key --
 *     "null is not zero"), `_mapSlot` (Int32Array), `_mask = M - 1`. Linear probe with
 *     Knuth BACKSHIFT deletion (no tombstones), so an eviction's map-delete keeps the probe
 *     invariants exact. The map's canonical home is `_hash(storedKey) & _mask` for EVERY entry,
 *     computed in TWO BIT-IDENTICAL, site-tested copies: `_hash(key)` (the reference, used by
 *     `merge` placement and the tests) and `_homeAt(arr, i)` (every hot site -- `_addAt`'s insert /
 *     bump / evict, estimate / errorOf, the evicted-key delete probe and the backshift -- reading
 *     the key from a buffer so a key >= 2^31 never boxes a HeapNumber crossing a call). An identity
 *     test pins `_homeAt(_key, sl) === (_hash(_key[sl]) & _mask)` for every slot.
 *
 * Hot path (`add` / `addFrom`, 0 B/op amortized): `add` is a typeof wrapper that stages key +
 * count in the `_buf` scratch and runs `_addAt(_buf, 0)`; `addFrom(buf, i)` copies them from a
 * caller-owned Float64Array into `_buf` (D1: a Proxy / shared view could change value between the
 * three reads) and runs `_addAt(_buf, 0)` -- the ZERO-BOX entry for a key or count >= 2^31. `_addAt`
 * takes the key's home via `_homeAt(buf, i)` (the HI-lane murmur hand-inlined into int32 locals,
 * never the module HASH_HI / HASH_LO slots) and probes with `_probeAt`, so no key crosses a call as
 * a boxed argument. A `add` is one of three O(1)-amortized cases:
 * monitored -> bump (detach + re-attach one slot, the target bucket is the immediate next in
 * sorted order for a unit add); free slot -> insert at count with error 0; full -> evict the
 * min key (map-delete via backshift, reassign the slot, move it from bucket `min` to bucket
 * `min + count`). A WEIGHTED add (count > 1) walks forward across the distinct bucket-values
 * it crosses (documented: unit adds amortize O(1); a weighted add is O(bucket-values crossed)).
 *
 * NO addHashed: unlike HyperLogLog / CountMinSketch (which keep only aggregate counters),
 * SpaceSaving must RETAIN each key's identity -- to return it from topK / forEach and to
 * re-probe it on eviction -- so there is no honest pre-hashed fast path (a hash alone is not
 * an identity). `add(key)` is the only ingest; it stores the key and hashes it internally.
 *
 * Exact vs approximate (disclosed): `total` (N), `size`, `capacity`, `epsilon` are EXACT;
 * `estimate` / `errorOf` are the bracketed approximate counts. `topK` / `heavyHitters` /
 * `merge` are COLD and ALLOCATE (disclosed, the lite-o1 iterator precedent) -- they build
 * and sort result arrays; keep them off the hot path. `forEach` is alloc-free (storage
 * order, NOT sorted).
 *
 * merge (Cormode / Hadjieleftheriou): merges another same-(capacity, seed) summary. Over the
 * UNION of monitored keys, `mergedCount(key) = countThis(key) + countOther(key)` where a key
 * ABSENT from a summary is credited that summary's MIN counter (its unmonitored-mass upper
 * bound; 0 if that summary is not yet full), and `mergedError = errorThis + errorOther` with
 * an absent summary contributing its min as error too. The k highest merged counts are kept
 * and this's map + forest are rebuilt. The `[count - error, count]` bracket is PRESERVED
 * (still sound) but LOOSER after a merge. COLD, with a bounded scratch allocation (disclosed).
 * Fails closed on an incompatible (capacity / seed) other.
 *
 * Fail closed: a bad capacity / seed / unknown option throws `[lite-sketch]` at the ctor door
 * BEFORE any allocation (no half-built instance); `add` typeof-guards the key (a safe integer)
 * + count FIRST (a Symbol / BigInt / NaN / non-integer / out-of-range key or count is a
 * throw, never a silent miss); `estimate` / `errorOf` / `topK` / `heavyHitters` / getters /
 * a valid `merge` never throw (a bad key estimates 0, an incompatible merge throws). null is
 * not zero.
 */
export class SpaceSaving {
    /** @private Brand (F21): installed by the ctor on every real instance; `#brand in x` runs no user code, is false for a Proxy / field-copy forgery, and adds no module state. */
    #brand;
    /**
     * @param {number} capacity  counter count k; an integer in [1, 2^24]. epsilon = 1 / k.
     * @param {{seed?: number}} [options]  seed: uint32 hash seed (any integer, coerced with `| 0`).
     */
    constructor(capacity, options) {
        // typeof guard FIRST, BEFORE any allocation (Number.isInteger never coerces; false on
        // a Symbol / BigInt), and _describe(x) in the cold message runs no user code (F20).
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > SS_CAP_MAX) {
            return this._badCapacity(capacity);
        }
        let seed = SS_DEFAULT_SEED;
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError(
                    '[lite-sketch] SpaceSaving options must be a plain object, got ' + _describe(options));
            }
            // F18: classify the bag and read its own data values inside ONE try, so a revoked /
            // throwing-trap Proxy becomes the plain-object TypeError (not an untagged engine throw).
            let bad, seedOwn;
            try {
                bad = _optScan(options, SS_KNOWN_OPTS);
                if (bad === null) seedOwn = _optOwn(options, 'seed');
            } catch (e) {
                bad = _NOT_BAG;
            }
            if (bad === _NOT_BAG) {
                throw new TypeError(
                    '[lite-sketch] SpaceSaving options must be a plain object, got ' + _describe(options));
            }
            if (bad !== null) this._badOption(bad);
            // Value checks AFTER the try (never swallowed by it), verbatim from HEAD.
            if (seedOwn !== undefined) {
                seed = seedOwn;
                if (typeof seed !== 'number' || !Number.isInteger(seed)) {
                    throw new RangeError(
                        '[lite-sketch] SpaceSaving seed must be an integer, got ' + _describe(seed));
                }
            }
        }
        const k = capacity;
        // Map capacity: next power of two >= 2k (load <= 0.5, so probing stays short).
        let M = 1;
        while (M < 2 * k) M <<= 1;
        // Allocate LAST (no half-built instance on any thrown path above).
        this._capacity = k;
        this._seed = seed | 0;          // SMI-safe (signed int32); murmur uses it as `s | 0` either way
        // counter slots
        this._key = new Float64Array(k);
        this._count = new Float64Array(k);
        this._error = new Float64Array(k);
        // intrusive count-bucket forest (per-slot links)
        this._cNext = new Int32Array(k);
        this._cPrev = new Int32Array(k);
        this._cBucket = new Int32Array(k);
        // bucket pool (at most k distinct count-values), sorted ascending by _bVal
        this._bVal = new Float64Array(k);
        this._bNext = new Int32Array(k);
        this._bPrev = new Int32Array(k);
        this._bHead = new Int32Array(k);
        this._bFree = new Int32Array(k);
        for (let i = 0; i < k; i++) this._bFree[i] = i;   // free-list: all k bucket ids
        this._bFreeTop = k;
        this._minBucket = -1;
        // open-addressing key -> slot map
        this._mapKey = new Float64Array(M);
        this._mapOcc = new Uint8Array(M);
        this._mapSlot = new Int32Array(M);
        this._buf = new Float64Array(2);   // add / estimate scratch
        this._mask = M - 1;
        // scalars
        this._size = 0;
        this._total = 0;
    }

    /** Counter capacity k. O(1). */
    get capacity() { return this._capacity; }
    /** Number of monitored keys (<= capacity). O(1). */
    get size() { return this._size; }
    /** Total mass N added (sum of every `count`). O(1). */
    get total() { return this._total; }
    /** The relative-error target 1 / k. O(1). */
    get epsilon() { return 1 / this._capacity; }
    /** The uint32 hash seed. O(1). */
    get seed() { return this._seed >>> 0; }

    /**
     * Build a SpaceSaving sized to a target relative error: `k = ceil(1/epsilon)`. An
     * UNATTAINABLE request -- `k > 2^24` (F16/S6) -- throws a tagged RangeError rather than
     * silently clamping down to a weaker guarantee. Delegates all remaining validation to the ctor.
     * @param {number} epsilon relative error, in (0, 1). epsilon = 1 / k.
     * @param {{seed?: number}} [options]
     * @returns {SpaceSaving}
     */
    static withError(epsilon, options) {
        if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
            throw new RangeError(
                '[lite-sketch] SpaceSaving.withError epsilon must be in (0, 1), got ' + _describe(epsilon));
        }
        const k = Math.ceil(1 / epsilon);
        if (k > SS_CAP_MAX) {
            throw new RangeError(
                '[lite-sketch] SpaceSaving.withError epsilon ' + epsilon + ' needs k=' + k +
                ' > the capacity cap 16777216 (2^24); it is unattainable');
        }
        return new SpaceSaving(k, options);
    }

    /**
     * Add a SAFE-INTEGER key with a positive integer `count` (default 1). HOT, 0 B/op amortized.
     * A thin typeof wrapper: it rejects a non-number key OR count FIRST (via `_badArgs`, which
     * replays add's exact guard order so the thrown class + message are byte-identical), writes
     * key and count into the per-instance `_buf` scratch, and defers to `_addAt(_buf, 0)` -- so
     * neither the key nor a count >= 2^31 crosses an inner call as a (boxable) argument. The
     * accepted domain is every safe integer |key| <= 2^53 - 1; a non-integer / out-of-safe-range
     * key, a count outside [1, 2^32-1], or an add that would push the running `total` past 2^53-1
     * (F15/S5, the aggregate stays exact), throws `[lite-sketch]` as a byte-identical no-op. For a
     * key or count >= 2^31 on a hot path, `addFrom(buf, i)` avoids even the caller's own box.
     * @param {number} key   a safe integer, |key| <= 2^53 - 1
     * @param {number} [count=1] a positive integer in [1, 2^32-1]
     * @returns {SpaceSaving} this
     */
    add(key, count = 1) {
        if (typeof key !== 'number' || typeof count !== 'number') return this._badArgs(key, count);
        const b = this._buf;
        b[0] = key;
        b[1] = count;
        return this._addAt(b, 0);
    }

    /**
     * Add the key at `buf[i]` with the count at `buf[i+1]`, both read from a caller-owned
     * `Float64Array` -- the ZERO-BOX entry point for a key or count >= 2^31. HOT, 0 B/op
     * amortized. Identical validation, throws, byte-identical-no-op-on-reject, and dispatch
     * (bump / insert / evict) as `add(key, count)`; it differs ONLY in how the values cross the
     * call boundary: `add(bigKey, bigCount)` boxes each tagged argument into a ~16 B HeapNumber
     * per call when V8 does not inline the call, whereas `addFrom` reads both slots UNBOXED.
     *
     * Both slots are read into LOCALS and then COPIED into `_buf`, and `_addAt(_buf, 0)` runs on
     * that snapshot (D1): `_addAt` reads the key three times (the range guard, `_homeAt`,
     * `_probeAt`), and a Proxy over a Float64Array or a SharedArrayBuffer view a worker rewrites
     * could pass `instanceof` yet change value between reads, storing a key under another key's
     * home. Reading both slots into locals FIRST also survives a re-entrant read: a Proxy whose
     * read of slot `i` or `i+1` calls back into add/addFrom on THIS sketch completes before our
     * `_buf` stores, so the key/count that crossed `addFrom` are the ones used. Fails closed
     * BEFORE any write: a non-Float64Array `buf`, or
     * a non-integer / out-of-bounds `i` (needs `i` and `i+1` in range), throws a tagged
     * TypeError; then the key / count reject exactly as `add`.
     * @param {Float64Array} buf a caller-owned Float64Array holding `[..., key, count, ...]`.
     * @param {number} i an index with `i` and `i+1` in bounds (key at `i`, count at `i+1`).
     * @returns {SpaceSaving} this
     */
    addFrom(buf, i) {
        if (!(buf instanceof Float64Array) || !Number.isInteger(i) ||
            i < 0 || i + 1 >= buf.length) return this._badBuf(buf, i);
        // Read BOTH slots into locals BEFORE touching `_buf` (D1): a Proxy / shared view whose read
        // of slot i or i+1 re-enters add/addFrom on THIS sketch would otherwise overwrite `_buf[0]`
        // between our two stores. Snapshotting into locals first lets any re-entry complete, then our
        // scratch writes are the last word -- the key/count that crossed addFrom are the ones used.
        const k = buf[i], c = buf[i + 1];
        const b = this._buf;
        b[0] = k;
        b[1] = c;
        return this._addAt(b, 0);
    }

    /**
     * @private The one add body: key = `buf[i]`, count = `buf[i+1]`, read UNBOXED into locals.
     * Shared by `add` and `addFrom`, which both pass the `_buf` snapshot. Guards (two-compare
     * key range, count range, running-total ceiling) run BEFORE any write. The map home comes
     * from `_homeAt(buf, i)` (the HI-lane murmur hand-inlined into int32 locals, identical bits
     * to `_hash`) and the probe from `_probeAt(buf, i, home)`, so the key never crosses `_probe`
     * as a (boxable) argument. Dispatches: monitored -> bump (read `prevB` BEFORE `_detach`);
     * free slot -> insert (count, error 0); full -> evict the min-count key, reassign its slot at
     * `count = min + count`, `error = min`, and RE-PROBE the newcomer via `_probeAt(this._key,
     * sl, home)` AFTER `this._key[sl] = key` -- reading OUR stored copy, so a caller buffer is
     * read only before any write. NEVER fails at capacity (eviction IS the algorithm). Over the
     * 460-byte V8 inline cap, never inlined -- its arguments are (object, Smi).
     */
    _addAt(buf, i) {
        const key = buf[i], count = buf[i + 1];
        if (!Number.isInteger(key) || key > 9007199254740991 || key < -9007199254740991) return this._badKey(key);
        if (!Number.isInteger(count) || count < 1 || count > 4294967295) return this._badCount(count);
        if (this._total + count > 9007199254740991) return this._badTotal(count);
        const home = this._homeAt(buf, i);
        const j0 = this._probeAt(buf, i, home);
        if (this._mapOcc[j0] === 1) {                // monitored -> bump
            const sl = this._mapSlot[j0];
            const prevB = this._bPrev[this._cBucket[sl]];
            this._count[sl] += count;
            this._detach(sl);
            this._attach(sl, prevB);
            this._total += count;
            return this;
        }
        if (this._size < this._capacity) {          // free slot -> insert
            const sl = this._size++;
            this._key[sl] = key;
            this._count[sl] = count;
            this._error[sl] = 0;
            this._mapOcc[j0] = 1;
            this._mapKey[j0] = key;
            this._mapSlot[j0] = sl;
            this._attach(sl, -1);
            this._total += count;
            return this;
        }
        const minB = this._minBucket;
        const sl = this._bHead[minB];
        const m = this._bVal[minB];
        this._mapDelete(this._probeAt(this._key, sl, this._homeAt(this._key, sl)));
        this._key[sl] = key;
        this._error[sl] = m;
        this._count[sl] = m + count;
        const prevB = this._bPrev[minB];
        this._detach(sl);
        this._attach(sl, prevB);
        const j = this._probeAt(this._key, sl, home);   // re-probe the newcomer from OUR copy of the key
        this._mapOcc[j] = 1;
        this._mapKey[j] = key;
        this._mapSlot[j] = sl;
        this._total += count;
        return this;
    }

    /**
     * The estimated (upper-bound) count of a key: `_count[slot]` if monitored, else 0. HOT,
     * 0 B/op. NEVER throws -- an un-addable key is not monitored, so its estimate is 0.
     * @param {number} key
     * @returns {number}
     */
    estimate(key) {
        if (typeof key !== 'number' || key !== key) return 0;
        const b = this._buf;
        b[0] = key;
        const i = this._probeAt(b, 0, this._homeAt(b, 0));
        return this._mapOcc[i] === 1 ? this._count[this._mapSlot[i]] : 0;
    }

    /**
     * The over-estimation error of a key: `_error[slot]` if monitored, else 0. The true count
     * is in `[estimate(key) - errorOf(key), estimate(key)]`. HOT, 0 B/op. NEVER throws.
     * @param {number} key
     * @returns {number}
     */
    errorOf(key) {
        if (typeof key !== 'number' || key !== key) return 0;
        const b = this._buf;
        b[0] = key;
        const i = this._probeAt(b, 0, this._homeAt(b, 0));
        return this._mapOcc[i] === 1 ? this._error[this._mapSlot[i]] : 0;
    }

    /**
     * Iterate the monitored entries in STORAGE order (NOT sorted), alloc-free, calling
     * `fn(key, count, error, this)`. O(size). A HOISTED callback keeps this a 0-alloc scan.
     * The loop bound is the LIVE `this._size` (F18): do NOT mutate the sketch inside `fn` -- a
     * mutation never produces ghosts, but entries may be skipped or revisited. `key` is `+ 0`
     * (a -0 reads +0). NOTE: a non-inlined `fn` boxes ~49 B/entry for entries >= 2^31 (a key /
     * count / error >= 2^31 crosses the call as a boxed double); `topKInto` renders those 0-alloc.
     * @param {(key:number, count:number, error:number, ss:SpaceSaving)=>void} fn
     * @returns {void}
     */
    forEach(fn) {
        const keys = this._key, counts = this._count, errors = this._error;
        for (let i = 0; i < this._size; i++) fn(keys[i] + 0, counts[i], errors[i], this);
    }

    /**
     * The top-n monitored entries by count, DESCENDING. COLD, ALLOCATES (disclosed): builds
     * and sorts a result array of `{key, count, error}`. `n` defaults to `size`; it is
     * clamped to `[0, size]`. NEVER throws.
     * @param {number} [n=size]
     * @returns {Array<{key:number, count:number, error:number}>}
     */
    topK(n) {
        const size = this._size;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) n = size;
        const take = n < size ? n : size;
        const idx = [];
        for (let i = 0; i < size; i++) idx.push(i);
        const counts = this._count;
        idx.sort((a, b) => counts[b] - counts[a]);
        const out = [];
        for (let i = 0; i < take; i++) {
            const sl = idx[i];
            out.push({ key: this._key[sl] + 0, count: this._count[sl], error: this._error[sl] });
        }
        return out;
    }

    /**
     * Every monitored key with `count > threshold * N` (N = total), DESCENDING by count -- a
     * SUPERSET with NO FALSE NEGATIVES: a key whose TRUE frequency exceeds the threshold is
     * never missed (Space-Saving's defining guarantee), since its reported `count` is an upper
     * bound. The result MAY include false positives. For the GUARANTEED-frequent SUBSET (no
     * false positives), a caller filters the returned entries by `(count - error) > threshold
     * * N` -- each entry carries `error` for exactly that. COLD, ALLOCATES (disclosed).
     * `threshold` is a fraction in [0, 1]. NEVER throws -- a bad threshold returns an empty array.
     * @param {number} threshold a fraction in [0, 1]
     * @returns {Array<{key:number, count:number, error:number}>}
     */
    heavyHitters(threshold) {
        const out = [];
        if (typeof threshold !== 'number' || threshold !== threshold ||
            threshold < 0 || threshold > 1) return out;
        const cut = threshold * this._total;
        const size = this._size;
        for (let i = 0; i < size; i++) {
            if (this._count[i] > cut) {            // upper bound -> SUPERSET, no false negatives
                out.push({ key: this._key[i] + 0, count: this._count[i], error: this._error[i] });
            }
        }
        out.sort((a, b) => b.count - a.count);
        return out;
    }

    /**
     * Write the top-n monitored entries by count into three caller-owned Float64Arrays, 0 ALLOC
     * (F7) -- the zero-alloc top-N render `topK()` is not (it allocates ~160 B/entry). `outKeys[j]`,
     * `outCounts[j]`, `outErrors[j]` receive entry j, best-first, in EXACTLY `topK(n)`'s order:
     * count DESCENDING, ties by ASCENDING slot. `n` follows topK's rule (defaults to / clamps to
     * `size`; a non-integer / negative n is treated as `size`, never throws). The number written is
     * `w = min(n, size, outKeys.length, outCounts.length, outErrors.length)`; it is returned, and a
     * too-short out simply receives its own length. Keys are `+ 0` (a -0 reads +0). An out that is
     * not a Float64Array, or three that overlap in memory, throws a tagged TypeError BEFORE any
     * write (like addFrom: a wrong array type would silently truncate a key >= 2^32). Disjoint
     * views over one buffer are fine. O(size log w), monomorphic, no boxing.
     * @param {Float64Array} outKeys
     * @param {Float64Array} outCounts
     * @param {Float64Array} outErrors
     * @param {number} [n=size]
     * @returns {number} the number of entries written
     */
    topKInto(outKeys, outCounts, outErrors, n) {
        const la = _f64Len(outKeys), lb = _f64Len(outCounts), lc = _f64Len(outErrors);
        if (la < 0 || lb < 0 || lc < 0 ||
            _f64Clash(outKeys, outCounts, false) ||
            _f64Clash(outKeys, outErrors, false) ||
            _f64Clash(outCounts, outErrors, false)) {
            return this._badOut(outKeys, outCounts, outErrors);
        }
        const size = this._size;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) n = size;
        let w = n < size ? n : size;
        if (w > la) w = la;
        if (w > lb) w = lb;
        if (w > lc) w = lc;
        if (w === 0) return 0;
        const counts = this._count;
        // Bounded MIN-heap of slot ids in outKeys[0..w-1], root = the WORST kept entry:
        // worse(a,b) = counts[a] < counts[b] || (counts[a] === counts[b] && a > b).
        // Seed with slots 0..w-1, heapify, then replace the root with any later slot that beats it.
        for (let i = 0; i < w; i++) outKeys[i] = i;
        for (let p = (w >> 1) - 1; p >= 0; p--) {
            let i = p;
            const sv = outKeys[i] | 0;
            const sc = counts[sv];
            for (;;) {
                let c = 2 * i + 1;
                if (c >= w) break;
                let cj = outKeys[c] | 0, cc = counts[cj];
                const r = c + 1;
                if (r < w) {
                    const rj = outKeys[r] | 0, rc = counts[rj];
                    if (rc < cc || (rc === cc && rj > cj)) { c = r; cj = rj; cc = rc; }
                }
                if (cc < sc || (cc === sc && cj > sv)) { outKeys[i] = cj; i = c; } else break;
            }
            outKeys[i] = sv;
        }
        for (let s = w; s < size; s++) {
            const rootSlot = outKeys[0] | 0;
            const rc0 = counts[rootSlot];
            const sc = counts[s];
            // s beats the worst kept entry (root)?  i.e. worse(root, s).
            if (rc0 < sc || (rc0 === sc && rootSlot > s)) {
                let i = 0;
                const sv = s;
                for (;;) {
                    let c = 2 * i + 1;
                    if (c >= w) break;
                    let cj = outKeys[c] | 0, cc = counts[cj];
                    const r = c + 1;
                    if (r < w) {
                        const rj = outKeys[r] | 0, rc = counts[rj];
                        if (rc < cc || (rc === cc && rj > cj)) { c = r; cj = rj; cc = rc; }
                    }
                    if (cc < sc || (cc === sc && cj > sv)) { outKeys[i] = cj; i = c; } else break;
                }
                outKeys[i] = sv;
            }
        }
        // In-place heapsort to best-first: repeatedly move the root (worst) past the live region.
        for (let end = w - 1; end > 0; end--) {
            const tmp = outKeys[0];
            outKeys[0] = outKeys[end];
            outKeys[end] = tmp;
            let i = 0;
            const sv = outKeys[0] | 0;
            const sc = counts[sv];
            for (;;) {
                let c = 2 * i + 1;
                if (c >= end) break;
                let cj = outKeys[c] | 0, cc = counts[cj];
                const r = c + 1;
                if (r < end) {
                    const rj = outKeys[r] | 0, rc = counts[rj];
                    if (rc < cc || (rc === cc && rj > cj)) { c = r; cj = rj; cc = rc; }
                }
                if (cc < sc || (cc === sc && cj > sv)) { outKeys[i] = cj; i = c; } else break;
            }
            outKeys[i] = sv;
        }
        // outKeys[0..w-1] now holds slot ids best-first; materialize into the three outs.
        const keyArr = this._key, errArr = this._error;
        for (let j = 0; j < w; j++) {
            const sl = outKeys[j] | 0;
            outKeys[j] = keyArr[sl] + 0;
            outCounts[j] = counts[sl];
            outErrors[j] = errArr[sl];
        }
        return w;
    }

    /**
     * Merge `other` into this (Cormode / Hadjieleftheriou). Over the union of monitored keys,
     * `mergedCount = countThis + countOther` (an absent summary contributes its MIN counter,
     * 0 if not yet full), `mergedError = errorThis + errorOther` (an absent summary
     * contributes its min as error). Keeps the k highest merged counts, rebuilds this's map +
     * forest, and adds `other._total`. The bracket is preserved but LOOSER after a merge.
     * COLD, with a bounded scratch allocation (disclosed). Fails closed `[lite-sketch]` if
     * `other` is not a SpaceSaving, differs in capacity / seed, or would push the running
     * `total` past 2^53-1 (F15/S5, byte-identical no-op).
     * A Proxy over an instance or a field copy is NOT a SpaceSaving (the brand is checked, not
     * `instanceof`): the brand predicate is the first statement, before any read of `other`.
     * @param {SpaceSaving} other
     * @returns {SpaceSaving} this
     */
    merge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) return this._badMerge(other);
        if (other._capacity !== this._capacity || other._seed !== this._seed) {
            return this._badMerge(other);
        }
        // Total guard BEFORE the first write (F15): a merged total past 2^53-1 is no longer exact.
        if (this._total + other._total > 9007199254740991) return this._badTotal(other._total);
        // Imputation floors: each summary's min counter, or 0 if it is not yet full.
        const minThis = this._size < this._capacity ? 0 : this._minCount();
        const minOther = other._size < other._capacity ? 0 : other._minCount();
        // Build the union with merged (count, error). COLD scratch (disclosed).
        const merged = new Map();
        for (let i = 0; i < this._size; i++) {
            merged.set(this._key[i], { c: this._count[i], e: this._error[i], both: false });
        }
        for (let i = 0; i < other._size; i++) {
            const key = other._key[i];
            const cur = merged.get(key);
            if (cur === undefined) {
                merged.set(key, { c: other._count[i] + minThis, e: other._error[i] + minThis, both: true });
            } else {
                cur.c += other._count[i];
                cur.e += other._error[i];
                cur.both = true;
            }
        }
        merged.forEach((v) => { if (!v.both) { v.c += minOther; v.e += minOther; } });
        const arr = [];
        merged.forEach((v, key) => arr.push({ key: key, count: v.c, error: v.e }));
        arr.sort((a, b) => b.count - a.count);           // DESCENDING
        const keep = Math.min(this._capacity, arr.length);
        const otherTotal = other._total;
        const oldTotal = this._total;
        // Reset this (forest + map + slots), then rebuild from the top-keep entries.
        this._size = 0;
        this._minBucket = -1;
        this._mapOcc.fill(0);
        for (let i = 0; i < this._capacity; i++) this._bFree[i] = i;
        this._bFreeTop = this._capacity;
        // Inserting in DESCENDING count order makes each _attach an O(1) new-min splice.
        for (let i = 0; i < keep; i++) {
            const it = arr[i];
            const sl = this._size++;
            this._key[sl] = it.key;
            this._count[sl] = it.count;
            this._error[sl] = it.error;
            const idx = this._probe(it.key, this._hash(it.key) & this._mask);
            this._mapOcc[idx] = 1;
            this._mapKey[idx] = it.key;
            this._mapSlot[idx] = sl;
            this._attach(sl, -1);
        }
        this._total = oldTotal + otherTotal;
        return this;
    }

    /**
     * Reset the sketch to empty. O(M) (the map occupancy fill) + O(k) (the free-list re-init);
     * the numeric pools are left untouched -- occupancy / size gate them. @returns {SpaceSaving} this
     */
    clear() {
        this._size = 0;
        this._total = 0;
        this._minBucket = -1;
        this._mapOcc.fill(0);
        for (let i = 0; i < this._capacity; i++) this._bFree[i] = i;
        this._bFreeTop = this._capacity;
        return this;
    }

    /**
     * @private HI-lane murmur of a numeric key (identical math to `add`'s inline mix and to
     * mix64's HI lane). Returns a SIGNED int32 (SMI) -- callers take `& _mask`, so the sign
     * never matters. 0-alloc, monomorphic (keys are always numbers). This is the REFERENCE copy
     * of the map home: estimate / errorOf / merge placement and the tests call it; `add`'s inline
     * mix and `_homeAt` are bit-identical, site-tested copies of the same home.
     * @param {number} key
     * @returns {number} int32 HI lane
     */
    _hash(key) {
        const neg = key < 0 ? 1 : 0;
        const a = Math.abs(key);
        const lo = a | 0;
        const hiw = a < 4294967296 ? 0 : ((a / 4294967296) | 0);
        const s = this._seed;
        let h = s;
        h = _m3round(h, lo);
        h = _m3round(h, hiw ^ (neg << 31));
        h = _m3final(h ^ 8);
        return h | 0;
    }

    /**
     * @private Linear-probe the map for `key` from `h`. Returns the matching index (if present)
     * or the first empty index (if absent). 0-alloc. `h` may be a pre-masked home (`_hash & _mask`)
     * OR a raw `_hash` (int32): `h & mask` is idempotent on a home, so EVERY production caller --
     * `add` (hot) and estimate / errorOf / merge (cold) -- passes the home `_hash(key) & _mask`;
     * only the tests pass a raw `_hash`, which this `& mask` still handles.
     * @param {number} key
     * @param {number} h the key's `_hash` (int32) or its home (`_hash & _mask`)
     * @returns {number} map index
     */
    _probe(key, h) {
        const occ = this._mapOcc, mkey = this._mapKey, mask = this._mask;
        let i = h & mask;
        while (occ[i] === 1) {
            if (mkey[i] === key) return i;
            i = (i + 1) & mask;
        }
        return i;
    }

    /**
     * @private The canonical map home of the numeric key stored at `arr[i]` (a Float64Array
     * slot, e.g. `_key` or `_mapKey`), i.e. `_hash(arr[i]) & _mask`, with the HI-lane murmur
     * HAND-INLINED (the same neg / `Math.abs` / low-word / high-word split as `_hash`, the same
     * `_m3round` rotl-15/13 + 0xe6546b64 steps and `_m3final` fmix) so the key never crosses a
     * call boundary as an argument -- a key >= 2^31 read from `arr` would box a HeapNumber
     * passed to `_hash`. Returns a Smi (`h & _mask`). This is the second bit-identical, site-
     * tested copy of the canonical home (the first is `add`'s inline mix). 0-alloc.
     * @param {Float64Array} arr the key pool (`_key` on eviction, `_mapKey` on backshift)
     * @param {number} i the slot index to read
     * @returns {number} the key's home, `_hash(arr[i]) & _mask`
     */
    _homeAt(arr, i) {
        const key = arr[i];
        const neg = key < 0 ? 1 : 0;
        const a = Math.abs(key);
        let k = a | 0;
        let h = this._seed;
        k = Math.imul(k, HASH_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HASH_C2);
        h = h ^ k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
        k = (a < 4294967296 ? 0 : ((a / 4294967296) | 0)) ^ (neg << 31);
        k = Math.imul(k, HASH_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HASH_C2);
        h = h ^ k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
        h = h ^ 8;
        h = h ^ (h >>> 16); h = Math.imul(h, FMIX_C1); h = h ^ (h >>> 13); h = Math.imul(h, FMIX_C2); h = h ^ (h >>> 16);
        return h & this._mask;
    }

    /**
     * @private Linear-probe the map for the key stored at `arr[i]`, starting from its pre-masked
     * `home`. Returns the matching index (if present) or the first empty index. 0-alloc. The key
     * is read from the buffer here, so it never crosses `_probe` as a (possibly boxed) argument.
     * @param {Float64Array} arr the key pool
     * @param {number} i the slot index to read
     * @param {number} home the key's home (`_homeAt(arr, i)`)
     * @returns {number} map index
     */
    _probeAt(arr, i, home) {
        const occ = this._mapOcc, mkey = this._mapKey, mask = this._mask;
        const key = arr[i];
        let j = home;
        while (occ[j] === 1) {
            if (mkey[j] === key) return j;
            j = (j + 1) & mask;
        }
        return j;
    }

    /**
     * @private Knuth backshift deletion at map index `i` (open addressing, no tombstones).
     * Walk forward from the hole; an entry `j` moves into the hole iff its home lies cyclically
     * outside `(i, j]`. Recomputes each home via `_homeAt(_mapKey, j)` -- the canonical home of
     * the stored key, with the key read from the buffer (no double crosses a call per step).
     * Runs on every eviction, so it must be correct + 0-alloc.
     * @param {number} i the (occupied) index to delete
     */
    _mapDelete(i) {
        const occ = this._mapOcc, mkey = this._mapKey, mslot = this._mapSlot, mask = this._mask;
        occ[i] = 0;
        let j = (i + 1) & mask;
        while (occ[j] === 1) {
            const home = this._homeAt(mkey, j);
            const a = (home - i) & mask;             // steps from the hole i to the entry's home
            const d = (j - i) & mask;                // steps from the hole i to the entry j
            if (a === 0 || a > d) {                   // home NOT in (i, j] -> j can fill the hole
                mkey[i] = mkey[j];
                mslot[i] = mslot[j];
                occ[i] = 1;
                occ[j] = 0;
                i = j;
            }
            j = (j + 1) & mask;
        }
    }

    /**
     * @private The min monitored count (the min bucket's value), or 0 if empty. O(1).
     * @returns {number}
     */
    _minCount() {
        return this._minBucket >= 0 ? this._bVal[this._minBucket] : 0;
    }

    /**
     * @private Attach `slot` to the bucket of its CURRENT count `_count[slot]`, birthing that
     * bucket (from the free-list) and splicing it into the ascending bucket list if none exists.
     * Reads the target value from `_count[slot]` itself -- every caller (insert, the inlined
     * bump, evict, merge rebuild) writes `_count[slot]` FIRST -- so a count >= 2^31 never crosses
     * this call as a (boxed) argument (F3). `hint` is a bucket with value <= the count to begin
     * the forward walk (or -1 to start at `_minBucket`). Pushes `slot` at the HEAD of the target
     * bucket's sibling list. Keeps `_minBucket` correct. 0-alloc.
     * @param {number} slot
     * @param {number} hint a bucket id with value <= `_count[slot]`, or -1
     */
    _attach(slot, hint) {
        const bVal = this._bVal, bNext = this._bNext, bPrev = this._bPrev, bHead = this._bHead;
        const val = this._count[slot];
        let prev = -1;
        let b = hint >= 0 ? hint : this._minBucket;
        while (b >= 0 && bVal[b] < val) { prev = b; b = bNext[b]; }
        if (b >= 0 && bVal[b] === val) {             // bucket exists -> push at its head (FIFO head)
            const head = bHead[b];
            this._cPrev[slot] = -1;
            this._cNext[slot] = head;
            if (head >= 0) this._cPrev[head] = slot;
            bHead[b] = slot;
            this._cBucket[slot] = b;
            return;
        }
        // Birth a new bucket for `val`, spliced between `prev` and `b`.
        const nb = this._bFree[--this._bFreeTop];
        bVal[nb] = val;
        bPrev[nb] = prev;
        bNext[nb] = b;
        if (prev >= 0) bNext[prev] = nb; else this._minBucket = nb;
        if (b >= 0) bPrev[b] = nb;
        this._cPrev[slot] = -1;
        this._cNext[slot] = -1;
        bHead[nb] = slot;
        this._cBucket[slot] = nb;
    }

    /**
     * @private Detach `slot` from its bucket's sibling list; if the bucket empties, unlink it
     * from the ascending bucket list (fixing `_minBucket`) and return it to the free-list.
     * 0-alloc.
     * @param {number} slot
     */
    _detach(slot) {
        const b = this._cBucket[slot];
        const p = this._cPrev[slot];
        const n = this._cNext[slot];
        if (p >= 0) this._cNext[p] = n; else this._bHead[b] = n;
        if (n >= 0) this._cPrev[n] = p;
        if (this._bHead[b] < 0) {                    // bucket now empty -> unlink + free
            const bp = this._bPrev[b];
            const bn = this._bNext[b];
            if (bp >= 0) this._bNext[bp] = bn; else this._minBucket = bn;
            if (bn >= 0) this._bPrev[bn] = bp;
            this._bFree[this._bFreeTop++] = b;
        }
    }

    /** @private Cold: replay add's original guard order for a non-number key or count. */
    _badArgs(key, count) {
        if (typeof key !== 'number' || key !== key || !Number.isInteger(key) ||
            Math.abs(key) > 9007199254740991) return this._badKey(key);
        return this._badCount(count);
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-sketch] SpaceSaving.addFrom(buf, i) needs a Float64Array and an integer index with i and i+1 in bounds, got ' +
            _describe(buf) + ', ' + _describe(i));
    }

    /** @private Cold thrower for a bad key (_describe runs no user code -- F20). */
    _badKey(key) {
        throw new TypeError(
            '[lite-sketch] SpaceSaving.add key must be a safe integer, got ' + _describe(key));
    }

    /** @private Cold thrower for a bad count. */
    _badCount(count) {
        throw new RangeError(
            '[lite-sketch] SpaceSaving count must be an integer in [1, 4294967295], got ' + _describe(count));
    }

    /** @private Cold thrower: the running total would exceed the exact-aggregate ceiling 2^53-1. */
    _badTotal(n) {
        throw new RangeError(
            '[lite-sketch] SpaceSaving total would exceed the exact integer ceiling 9007199254740991 (2^53-1): ' +
            'current total ' + this._total + ' + ' + _describe(n));
    }

    /** @private Cold thrower for a bad capacity. */
    _badCapacity(capacity) {
        throw new RangeError(
            '[lite-sketch] SpaceSaving capacity must be an integer in [1, ' + SS_CAP_MAX +
            '], got ' + _describe(capacity));
    }

    /** @private Cold thrower for bad topKInto out arrays (not three non-overlapping Float64Arrays). */
    _badOut(a, b, c) {
        throw new TypeError(
            '[lite-sketch] SpaceSaving.topKInto(outKeys, outCounts, outErrors, n) needs three ' +
            'non-overlapping Float64Arrays, got ' + _describe(a) + ', ' + _describe(b) + ', ' + _describe(c));
    }

    /** @private Cold thrower for an incompatible merge (non-instance vs capacity/seed mismatch). */
    _badMerge(other) {
        if (typeof other !== 'object' || other === null || !(#brand in other)) {
            throw new TypeError('[lite-sketch] SpaceSaving.merge expects a SpaceSaving');
        }
        throw new RangeError(
            '[lite-sketch] SpaceSaving.merge requires equal capacity/seed: this capacity=' +
            this._capacity + ' seed=' + (this._seed >>> 0) +
            ', other capacity=' + other._capacity + ' seed=' + (other._seed >>> 0));
    }

    /** @private Cold thrower for an unknown option key (did-you-mean listing known keys). */
    _badOption(key) {
        throw new TypeError(
            '[lite-sketch] SpaceSaving unknown option "' + _describe(key) +
            '"; known options: ' + Object.keys(SS_KNOWN_OPTS).join(', '));
    }
}

// ===========================================================================
// Cold module helpers -- placed AFTER every class so they take the LAST module
// context slots and never shift the slot operands of the hot class methods (the
// bytecode of add / addHashed(From) / _addAt / _apply* / count / ... is byte- AND
// operand-identical to HEAD). They are only ever called at method-call time, after
// module evaluation completes, so trailing position raises no TDZ issue.
// ===========================================================================

// --- Option-bag validation (F18), all COLD (ctor door only) ---------------

/**
 * @private Module sentinel returned by `_optScan` for a NON-bag option argument (wrong
 * prototype, or an own accessor). A unique object, so it can never collide with a string /
 * symbol "unknown key" result nor with `null` (a valid bag). Frozen, null-proto.
 */
const _NOT_BAG = Object.freeze({ __proto__: null });

/**
 * @private `Object.hasOwn`, captured at module evaluation BEFORE any user code can monkeypatch
 * it. Used for the descriptor OWN-`value` test: a plain `'value' in d` walks d's prototype
 * chain, so `Object.prototype.value = 5` (data or getter) would make an own-accessor bag look
 * like a data descriptor and read / run the inherited value. `_hasOwn(d, 'value')` is own-only.
 */
const _hasOwn = Object.hasOwn;

/** @private This realm's `Object.prototype`, captured at module eval (a non-configurable intrinsic). */
const _OBJ_PROTO = Object.prototype;

/**
 * @private Classify an option argument against a null-proto KNOWN set (F18). A valid bag is a
 * non-null object whose prototype `p` is one of:
 *   - `null`;
 *   - THIS realm's `Object.prototype` (its keys are ignored -- a polluted `Object.prototype.seed`
 *     still yields the default, not a smuggled value);
 *   - any OTHER root prototype (`Object.getPrototypeOf(p) === null`, e.g. a cross-realm vm / iframe
 *     `Object.prototype`, or a bare null-proto object) ONLY IF `p` carries NO own property named by
 *     a KNOWN key -- otherwise an inherited option would be silently dropped, so it fails closed.
 * Map / Date / RegExp / arrays / class instances / `Object.create(proto)` are not bags. Every own
 * key of `o` (`Reflect.ownKeys`: symbols and non-enumerable keys included) must be a string present
 * in `known`, and every own property must be a DATA descriptor (an OWN `value`, via `_hasOwn` --
 * never the prototype chain) -- an own accessor makes the object a non-bag, so no getter ever runs.
 * The Proxy-trap-bearing steps (getPrototypeOf, ownKeys, getOwnPropertyDescriptor) run inside the
 * caller's one try; `getOwnPropertyDescriptor` reads a descriptor, so no getter on `p` is run either.
 * @param {object} o the option argument (already known to be a non-null object)
 * @param {object} known a null-proto frozen set of legal keys
 * @returns {null|object|string|symbol} null for a valid bag, `_NOT_BAG` for a non-bag, else the first unknown own key
 */
function _optScan(o, known) {
    const p = Object.getPrototypeOf(o);
    if (p !== null && p !== _OBJ_PROTO) {
        if (Object.getPrototypeOf(p) !== null) return _NOT_BAG;
        // A non-(this realm) root prototype must carry NO own KNOWN key (else it smuggles a dropped option).
        const kk = Reflect.ownKeys(known);
        for (let i = 0; i < kk.length; i++) {
            if (Object.getOwnPropertyDescriptor(p, kk[i]) !== undefined) return _NOT_BAG;
        }
    }
    const keys = Reflect.ownKeys(o);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const d = Object.getOwnPropertyDescriptor(o, k);
        if (d === undefined || !_hasOwn(d, 'value')) return _NOT_BAG;   // an own accessor -> not a bag
        if (!(typeof k === 'string' && k in known)) return k;          // unknown own key (string or symbol)
    }
    return null;
}

/**
 * @private The own DATA value of key `k` on a validated bag `o`, or undefined (missing or an
 * accessor -- though `_optScan` has already rejected any accessor). Reads the descriptor's OWN
 * `value` (via `_hasOwn`), never `[[Get]]` and never the prototype chain, so no inherited value
 * and no getter. Cold.
 * @param {object} o a bag already passed by `_optScan`
 * @param {string} k a known option key
 * @returns {*} the own data value, or undefined
 */
function _optOwn(o, k) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d !== undefined && _hasOwn(d, 'value') ? d.value : undefined;
}

// --- Float64Array out-array validation (F7 / F8), COLD (into-method door) --
// Cached %TypedArray%.prototype getters: they run NO Proxy trap (a Proxy has no TypedArray
// internal slots, so the @@toStringTag getter returns undefined and length / buffer / byteOffset
// throw, never forwarding to a trap) and NO subclass override.

const _TA_PROTO = Object.getPrototypeOf(Float64Array.prototype);
const _taTag = Object.getOwnPropertyDescriptor(_TA_PROTO, Symbol.toStringTag).get;
const _taLen = Object.getOwnPropertyDescriptor(_TA_PROTO, 'length').get;
const _taBuf = Object.getOwnPropertyDescriptor(_TA_PROTO, 'buffer').get;
const _taOff = Object.getOwnPropertyDescriptor(_TA_PROTO, 'byteOffset').get;
// The ArrayBuffer.prototype byteLength getter tells a SAB from a plain ArrayBuffer with no user
// code (an internal-slot check, no Proxy trap): it returns a number for a plain ArrayBuffer and
// THROWS for a SharedArrayBuffer. Used by `_isSAB` this way round so the COMMON case (plain
// ArrayBuffer out arrays) never throws -- zero allocation -- and only a genuine SAB pays the throw.
// Two DISTINCT SAB objects can alias the same memory (structuredClone / a worker round-trip), which
// a buffer-identity test cannot see, so a cross-SAB pair fails closed.
const _hasSAB = typeof SharedArrayBuffer === 'function';
const _abByteLen = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const _AB_PROTO = ArrayBuffer.prototype;   // probe-order hint for _f64Clash (never the answer)

/**
 * @private The element length of `x` if it is a REAL Float64Array, else -1. The @@toStringTag
 * getter is 'Float64Array' only for a genuine Float64Array (not a Float32Array, not an Array,
 * not a Proxy over one, not a subclass tagged otherwise); length is then read with no trap.
 * @param {*} x
 * @returns {number} length, or -1
 */
function _f64Len(x) {
    if (typeof x !== 'object' || x === null) return -1;
    if (_taTag.call(x) !== 'Float64Array') return -1;
    return _taLen.call(x);
}

/**
 * @private True when `buf` is a SharedArrayBuffer, decided with NO user code: the cached
 * ArrayBuffer byteLength getter reads an internal slot and throws ONLY on a SharedArrayBuffer
 * (returning a number for a plain ArrayBuffer). `buf` here is always a real buffer from a real
 * Float64Array's `.buffer`, so "the AB getter throws" means exactly "is a SAB". The common
 * plain-ArrayBuffer path returns `false` with no throw, hence 0 allocation. False on a host
 * without SharedArrayBuffer (no buffer can be shared).
 * @param {ArrayBufferLike} buf
 * @returns {boolean}
 */
function _isSAB(buf) {
    if (!_hasSAB) return false;
    try { _abByteLen.call(buf); return false; } catch (e) { return true; }
}

/**
 * @private True when `a` and `b` could write the same memory. SAME buffer object: the byte
 * ranges intersect (equal offsets allowed only if `sameOk` -- the exact in-place view
 * quantilesInto reads-then-writes index by index). DIFFERENT buffer objects that are BOTH
 * SharedArrayBuffers: fail closed (`true`) -- two distinct SAB objects can alias one block of
 * memory and that cannot be verified. Different objects otherwise (plain ArrayBuffers, or one
 * SAB and one plain buffer) cannot alias: no clash. The plain buffer is probed first so an
 * accepted mixed pair never triggers the SAB internal throw (0 alloc). Both args are already real
 * Float64Arrays.
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @param {boolean} sameOk allow equal offsets (same-view in-place)
 * @returns {boolean}
 */
function _f64Clash(a, b, sameOk) {
    const ba = _taBuf.call(a), bb = _taBuf.call(b);
    if (ba === bb) {
        const ao = _taOff.call(a);
        const bo = _taOff.call(b);
        if (ao === bo) return !sameOk;
        const ae = ao + _taLen.call(a) * 8;
        const be = bo + _taLen.call(b) * 8;
        return ao < be && bo < ae;
    }
    // Distinct buffer objects clash only if BOTH are SharedArrayBuffers. Probe a PLAIN ArrayBuffer
    // FIRST: `_isSAB` on a plain AB returns false with no throw, so an ACCEPTED mixed pair (one SAB,
    // one plain -- the SAB-to-worker case) short-circuits before ever probing the SAB, 0 alloc. The
    // prototype only picks the probe ORDER, never the answer (the getter reads internal slots), so a
    // SAB with a swapped-to-AB prototype is still probed and still rejected; only a two-SAB pair,
    // which is rejected anyway, pays the internal throw.
    if (Object.getPrototypeOf(bb) === _AB_PROTO) return _isSAB(bb) && _isSAB(ba);
    return _isSAB(ba) && _isSAB(bb);
}
