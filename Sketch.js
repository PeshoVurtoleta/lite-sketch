/**
 * @zakkster/lite-sketch -- a zero-GC, zero-runtime-dependency, single-file ESM
 * family of APPROXIMATE, sublinear-space streaming SUMMARIES that witness their
 * ACCURACY against the paper's theoretical bound (the lite-filter honesty move,
 * one axis over: measured error vs the theoretical error), while allocating ZERO
 * bytes on every hot op (the lite-o1 zero-GC discipline).
 *
 * v0.1.0 ships ONE member -- HyperLogLog (cardinality / distinct-count over an
 * unbounded stream in fixed space, via a dense Uint8Array register bank) -- over
 * the canonical two-lane 64-bit non-crypto hash. Future members (CountMinSketch,
 * DDSketch, SpaceSaving, ...) are PURE-APPENDED below the shared hash + this class;
 * prior members stay byte-identical, only this header + VERSION change.
 *
 * ASCII-only source (no Unicode). Zero runtime deps; node:test only.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.1.0';

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

/**
 * The two output lanes of the last mix64 / hashString call. Written by the mixer,
 * read by the caller on the immediately following synchronous line -- the alloc-free
 * "return two uint32s" trick. Held as SIGNED int32 (`| 0`) so the module slots are
 * always SMIs and never box a HeapNumber (a uint32 >= 2^31 is a boxed double, and
 * storing that to a module slot allocates per op). The bit pattern is the full 32-bit
 * hash; readers recover the unsigned value with `>>> 0` at the boundary, and `add`'s
 * `>>> (32-p)` / `(x << p) >>> 0` / `clz32` are bit-identical on the signed slot.
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
 * 2^53) plus a sign flag, folds both words through TWO independently seeded murmur3
 * bodies. Zero allocation, no BigInt, no ref retained.
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
    h = _m3round(h, hi ^ neg);
    h = h ^ 8;                                 // length tag (two 32-bit blocks)
    HASH_HI = _m3final(h) | 0;
    // lane LO (seed s ^ LANE_SALT -- decorrelated)
    let g = (s ^ LANE_SALT) | 0;
    g = _m3round(g, lo);
    g = _m3round(g, hi ^ neg);
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
 * caller-supplied uint32 lanes and skips the mix (the pre-hashed fast path).
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
    /**
     * @param {number} [p=14]   precision; an integer in [4, 18]. m = 1 << p.
     * @param {number} [seed]   uint32 hash seed (any integer, coerced with >>> 0).
     */
    constructor(p = 14, seed = HLL_DEFAULT_SEED) {
        // typeof guard FIRST, BEFORE any allocation: (p | 0) !== p rejects every
        // non-integer number; typeof rejects Symbol / BigInt before | coerces them.
        if (typeof p !== 'number' || (p | 0) !== p || p < HLL_P_MIN || p > HLL_P_MAX) {
            throw new RangeError(
                '[lite-sketch] HyperLogLog p must be an integer in [4, 18], got ' + String(p));
        }
        if (typeof seed !== 'number' || !Number.isInteger(seed)) {
            throw new RangeError(
                '[lite-sketch] HyperLogLog seed must be an integer, got ' + String(seed));
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
    }

    /** Precision p. O(1). */
    get p() { return this._p; }
    /** Register count m = 2^p. O(1). */
    get m() { return this._m; }
    /** The theoretical standard error 1.04 / sqrt(m). O(1). */
    get standardError() { return 1.04 / Math.sqrt(this._m); }

    /**
     * Add a numeric key. HOT, 0 B/op. Hashes the key to two lanes, picks register j
     * from the top p bits, computes rho over the 64 - p bit suffix, stores the max.
     * Fails closed: a non-number / NaN key throws `[lite-sketch]` (byte-identical
     * no-op) -- the typeof guard runs FIRST.
     *
     * The two-lane murmur is INLINED here (identical math to mix64) so the lanes are
     * pure LOCALS (int32), which TurboFan keeps in registers -- it never writes the
     * module HASH_HI / HASH_LO slots on the hot path, so a uint32 >= 2^31 lane never
     * boxes a HeapNumber into a slot. That is what keeps add at a true 0 scavenges
     * (mix64 / hashHi / hashLo remain the standalone hash for external callers).
     * @param {number} key
     * @returns {HyperLogLog} this
     */
    add(key) {
        if (typeof key !== 'number' || key !== key) return this._badKey(key);
        let a = key;
        let neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        // High word: 0 for the common case (|key| < 2^32, incl. every int32 id) so the hot
        // body stays PURE int32 -- the float divide runs ONLY for a genuine > 32-bit key.
        const hiw = a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0);
        const s = this._seed;
        let h = s;
        h = _m3round(h, lo);
        h = _m3round(h, hiw ^ neg);
        h = _m3final(h ^ 8);                       // HI lane (int32 local)
        let g = s ^ LANE_SALT;
        g = _m3round(g, lo);
        g = _m3round(g, hiw ^ neg);
        g = _m3final(g ^ 8);                       // LO lane (int32 local)
        const p = this._p;
        const j = h >>> (32 - p);
        const hiSuf = (h << p) >>> 0;
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
        const hiSuf = (hi << p) >>> 0;
        const rho = hiSuf !== 0
            ? Math.clz32(hiSuf) + 1
            : (32 - p) + Math.clz32(lo) + 1;
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
     * distributable). O(m), 0 alloc. Equal-m-or-throw: fails closed `[lite-sketch]`
     * if `other` is not a HyperLogLog or has a different m.
     * @param {HyperLogLog} other
     * @returns {HyperLogLog} this
     */
    merge(other) {
        if (!(other instanceof HyperLogLog) || other._m !== this._m) return this._badMerge(other);
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

    /** @private Cold thrower for a bad key (String is Symbol / BigInt-safe). */
    _badKey(key) {
        throw new TypeError('[lite-sketch] HyperLogLog.add key must be a number, got ' + String(key));
    }

    /** @private Cold thrower for a bad pre-hashed lane. */
    _badLane(x) {
        throw new TypeError('[lite-sketch] HyperLogLog.addHashed lanes must be uint32, got ' + String(x));
    }

    /** @private Cold thrower for an incompatible merge. */
    _badMerge(other) {
        if (!(other instanceof HyperLogLog)) {
            throw new TypeError('[lite-sketch] HyperLogLog.merge expects a HyperLogLog');
        }
        throw new RangeError(
            '[lite-sketch] HyperLogLog.merge requires equal m: this m=' + this._m + ', other m=' + other._m);
    }
}
