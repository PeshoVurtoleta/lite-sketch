/**
 * @zakkster/lite-sketch -- a zero-GC, zero-runtime-dependency, single-file ESM
 * family of APPROXIMATE, sublinear-space streaming SUMMARIES that witness their
 * ACCURACY against the paper's theoretical bound (the lite-filter honesty move,
 * one axis over: measured error vs the theoretical error), while allocating ZERO
 * bytes on every hot op (the lite-o1 zero-GC discipline).
 *
 * v0.2.0 ships TWO members -- HyperLogLog (cardinality / distinct-count over an
 * unbounded stream in fixed space, via a dense Uint8Array register bank) and
 * CountMinSketch (point-query frequency estimation over a Uint32Array counter
 * matrix) -- both over the canonical two-lane 64-bit non-crypto hash. Future
 * members (DDSketch, SpaceSaving, ...) are PURE-APPENDED below the shared hash +
 * these classes; prior members stay byte-identical, only this header + VERSION change.
 *
 * ASCII-only source (no Unicode). Zero runtime deps; node:test only.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.2.0';

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
const CMS_KNOWN_OPTS = Object.freeze({ seed: true, conservative: true });

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
 * (rounded up to a power of two), `d = ceil(ln(1/delta))`. One-sided: the estimate
 * NEVER undercounts.
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
 * caller-supplied uint32 lanes and skips the mix.
 *
 * Fail closed: a bad d / w / seed / conservative / unknown option throws
 * `[lite-sketch]` at the ctor door BEFORE any allocation (no half-built instance);
 * `add` / `addHashed` typeof-guard key/lanes/count FIRST (Symbol / BigInt / NaN /
 * non-uint32 lane / out-of-range count is a throw, never a silent miss); `estimate`
 * / `estimateHashed` / getters / a valid `merge` never throw (a bad key estimates 0,
 * an incompatible merge throws). null is not zero.
 */
export class CountMinSketch {
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
                '[lite-sketch] CountMinSketch d must be an integer in [1, ' + CMS_D_MAX + '], got ' + String(d));
        }
        if (typeof w !== 'number' || (w | 0) !== w || w < 1 || w > CMS_W_MAX) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch w must be an integer in [1, ' + CMS_W_MAX + '], got ' + String(w));
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
            if (typeof options !== 'object' || options === null || Array.isArray(options)) {
                throw new TypeError(
                    '[lite-sketch] CountMinSketch options must be a plain object, got ' + String(options));
            }
            const keys = Object.keys(options);
            for (let i = 0; i < keys.length; i++) {
                if (!(keys[i] in CMS_KNOWN_OPTS)) this._badOption(keys[i]);
            }
            if (options.seed !== undefined) {
                seed = options.seed;
                if (typeof seed !== 'number' || !Number.isInteger(seed)) {
                    throw new RangeError(
                        '[lite-sketch] CountMinSketch seed must be an integer, got ' + String(seed));
                }
            }
            if (options.conservative !== undefined) {
                conservative = options.conservative;
                if (typeof conservative !== 'boolean') {
                    throw new TypeError(
                        '[lite-sketch] CountMinSketch conservative must be a boolean, got ' + String(conservative));
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
        this._total = 0;
    }

    /**
     * Build a sketch sized to a target accuracy: `w = ceil(e/epsilon)` (rounded up to
     * a power of two, clamped to the width cap), `d = ceil(ln(1/delta))` (clamped to
     * [1, 32]). Delegates ALL remaining validation (incl. the SMI cap) to the ctor.
     * @param {number} epsilon relative error, in (0, 1).
     * @param {number} delta   failure probability, in (0, 1).
     * @param {{seed?: number, conservative?: boolean}} [options]
     * @returns {CountMinSketch}
     */
    static withAccuracy(epsilon, delta, options) {
        if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch.withAccuracy epsilon must be in (0, 1), got ' + String(epsilon));
        }
        if (typeof delta !== 'number' || !(delta > 0 && delta < 1)) {
            throw new RangeError(
                '[lite-sketch] CountMinSketch.withAccuracy delta must be in (0, 1), got ' + String(delta));
        }
        // Clamp the target width to the cap BEFORE rounding up: `cw <<= 1` is an int32
        // shift, so a w > 2^30 (epsilon < ~2.53e-9, still inside (0,1)) would overflow cw
        // to 0 and spin forever. Clamped here, the round-up tops out at CMS_W_MAX.
        let w = Math.ceil(Math.E / epsilon);
        if (w > CMS_W_MAX) w = CMS_W_MAX;
        let cw = 1;
        while (cw < w) cw <<= 1;
        let d = Math.ceil(Math.log(1 / delta));
        if (d < 1) d = 1;
        if (d > CMS_D_MAX) d = CMS_D_MAX;
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
    /** The theoretical relative error e / w. O(1). */
    get epsilon() { return Math.E / this._w; }
    /** The theoretical failure probability e^-d. O(1). */
    get delta() { return Math.exp(-this._d); }

    /**
     * Add a numeric key with a positive integer `count` (default 1). HOT, 0 B/op.
     * Hashes the key to a base lane, then increments one cell per row (conservative or
     * plain per the ctor flag). Fails closed: a non-number / NaN key or an out-of-range
     * count throws `[lite-sketch]` -- the typeof guards run FIRST.
     *
     * The two-lane murmur is INLINED (identical math to mix64) into int32 LOCALS so it
     * never writes the module HASH_HI / HASH_LO slots (a uint32 >= 2^31 lane never boxes
     * a HeapNumber on the hot path). base = (hi ^ lo) | 0 folds both lanes.
     * @param {number} key
     * @param {number} [count=1] a positive integer in [1, 2^32-1].
     * @returns {CountMinSketch} this
     */
    add(key, count = 1) {
        if (typeof key !== 'number' || key !== key) return this._badKey(key);
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > CMS_MAX_COUNT) {
            return this._badCount(count);
        }
        let a = key;
        let neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        // High word: 0 for |key| < 2^32 (incl. every int32 id) so the hot body stays PURE
        // int32; the float divide runs ONLY for a genuine > 32-bit key.
        const hiw = a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0);
        const s = this._seed;
        let h = s;
        h = _m3round(h, lo);
        h = _m3round(h, hiw ^ neg);
        h = _m3final(h ^ 8);                        // HI lane (int32 local)
        let g = s ^ LANE_SALT;
        g = _m3round(g, lo);
        g = _m3round(g, hiw ^ neg);
        g = _m3final(g ^ 8);                        // LO lane (int32 local)
        const base = (h ^ g) | 0;
        if (this._conservative) return this._applyCons(base, count);
        return this._applyPlain(base, count);
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
        const base = (hi ^ lo) | 0;
        if (this._conservative) return this._applyCons(base, count);
        return this._applyPlain(base, count);
    }

    /**
     * @private Conservative update (Estan-Varghese), 0 B/op, monomorphic. Stage each
     * row's flat index in `_idx`, find the current min across the d cells, then raise
     * only the cells below `min + count` up to it (saturating at CMS_MAX_COUNT). Two
     * passes over d rows, no allocation.
     */
    _applyCons(base, count) {
        const d = this._d, w = this._w, mask = this._mask, counts = this._counts, idx = this._idx;
        let mn = 0xffffffff;
        for (let i = 0; i < d; i++) {
            const x = _m3final((base ^ Math.imul(i, ODD_CONST)) | 0);
            const col = x & mask;
            const id = i * w + col;
            idx[i] = id;
            const v = counts[id];
            if (v < mn) mn = v;
        }
        let target = mn + count;
        if (target > CMS_MAX_COUNT) target = CMS_MAX_COUNT;
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
     */
    _applyPlain(base, count) {
        const d = this._d, w = this._w, mask = this._mask, counts = this._counts;
        for (let i = 0; i < d; i++) {
            const x = _m3final((base ^ Math.imul(i, ODD_CONST)) | 0);
            const id = i * w + (x & mask);
            let v = counts[id] + count;
            if (v > CMS_MAX_COUNT) v = CMS_MAX_COUNT;
            counts[id] = v;
        }
        this._total += count;
        return this;
    }

    /**
     * Estimate a key's frequency: the MINIMUM over its d cells (the tightest one-sided
     * over-estimate). HOT, 0 B/op. NEVER throws -- a non-number / NaN key returns 0
     * (fail-closed: an un-addable key has frequency 0).
     * @param {number} key
     * @returns {number}
     */
    estimate(key) {
        if (typeof key !== 'number' || key !== key) return 0;
        let a = key;
        let neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        const hiw = a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0);
        const s = this._seed;
        let h = s;
        h = _m3round(h, lo);
        h = _m3round(h, hiw ^ neg);
        h = _m3final(h ^ 8);
        let g = s ^ LANE_SALT;
        g = _m3round(g, lo);
        g = _m3round(g, hiw ^ neg);
        g = _m3final(g ^ 8);
        const base = (h ^ g) | 0;
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
     * O(d*w), 0 alloc. Fails closed `[lite-sketch]` if `other` is not a CountMinSketch
     * or differs in d / w / seed.
     * @param {CountMinSketch} other
     * @returns {CountMinSketch} this
     */
    merge(other) {
        if (!(other instanceof CountMinSketch) ||
            other._d !== this._d || other._w !== this._w || other._seed !== this._seed) {
            return this._badMerge(other);
        }
        const a = this._counts, b = other._counts, n = a.length;
        for (let i = 0; i < n; i++) {
            let v = a[i] + b[i];
            if (v > CMS_MAX_COUNT) v = CMS_MAX_COUNT;
            a[i] = v;
        }
        this._total += other._total;
        return this;
    }

    /** Reset every counter to 0 and the running total. O(d*w). @returns {CountMinSketch} this */
    clear() {
        this._counts.fill(0);
        this._total = 0;
        return this;
    }

    /** @private Cold thrower for a bad key (String is Symbol / BigInt-safe). */
    _badKey(key) {
        throw new TypeError('[lite-sketch] CountMinSketch.add key must be a number, got ' + String(key));
    }

    /** @private Cold thrower for a bad pre-hashed lane. */
    _badLane(x) {
        throw new TypeError('[lite-sketch] CountMinSketch.addHashed lanes must be uint32, got ' + String(x));
    }

    /** @private Cold thrower for a bad count. */
    _badCount(count) {
        throw new RangeError(
            '[lite-sketch] CountMinSketch count must be an integer in [1, ' + CMS_MAX_COUNT + '], got ' + String(count));
    }

    /** @private Cold thrower for an incompatible merge (non-instance vs d/w/seed mismatch). */
    _badMerge(other) {
        if (!(other instanceof CountMinSketch)) {
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
            '[lite-sketch] CountMinSketch unknown option "' + String(key) +
            '"; known options: ' + Object.keys(CMS_KNOWN_OPTS).join(', '));
    }
}
