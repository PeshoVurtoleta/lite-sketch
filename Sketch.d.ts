/**
 * @zakkster/lite-sketch -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of Sketch.js. The three-place
 * version sync (package.json / Sketch.js VERSION / llms.txt) is enforced in review;
 * this file only declares that `VERSION` exists. ASCII-only.
 *
 * "0 library B/op" below means the LIBRARY allocates nothing on that path; a non-Smi
 * argument (a key or count `>= 2^31` on Node, `>= 2^30` in Chrome, or a fractional
 * DDSketch value) still boxes ~16 B (12 B in Chrome) at a call V8 does not inline --
 * the `addFrom` / `addHashedFrom` family reads it UNBOXED, so it stays at 0 B/op.
 *
 * @license MIT
 */

/** Package version string. */
export const VERSION: string;

/**
 * The canonical two-lane 64-bit-quality non-crypto hash (ADR 0001). Mixes a numeric
 * key + a uint32 seed into two uint32 lanes, written to internal module slots (NO
 * allocation -- no BigInt, no tuple). Read the lanes immediately via `hashHi()` /
 * `hashLo()`. Members call this internally; a caller who wants the canonical hash to
 * feed a pre-hashed entry point uses it then reads the two lanes.
 * @param key a numeric key. Integers with |key| <= 2^53 hash injectively WITH their sign
 *   (the sign lives in bit 31 of the high word; see the numeric-key note). The lanes changed
 *   for NEGATIVE keys in 1.2.0 (F12 -- positive keys and -0 are unchanged).
 * @param seed a uint32 seed (coerced via >>> 0).
 */
export function mix64(key: number, seed: number): void;

/** The high 32-bit lane written by the most recent `mix64` / `hashString`. O(1). */
export function hashHi(): number;

/** The low 32-bit lane written by the most recent `mix64` / `hashString`. O(1). */
export function hashLo(): number;

/**
 * Hash a string's char codes into the two lanes, alloc-free (no retained reference).
 * Read the result via `hashHi()` / `hashLo()`. The numeric core is primary; this is
 * the string convenience.
 */
export function hashString(str: string, seed: number): void;

/**
 * Derive an independent sub-hash for row `i` by seeded salting of a base hash `h`
 * (`mix(h ^ i * ODD_CONST)`) -- for future multi-row members (Count-Min's d rows).
 * Returns the salted 32-bit value.
 */
export function saltRow(h: number, i: number): number;

/**
 * HyperLogLog -- a zero-GC distinct-count (cardinality) sketch over a dense
 * `Uint8Array(m)` of one-byte registers, `m = 2^p`, `p in [4, 18]`. `add` records one
 * register per element (0 library B/op); `count()` estimates the distinct total via Ertl's
 * improved estimator with standard error `1.04/sqrt(m)`. Mergeable (register-wise max,
 * equal m AND seed). Dense-only; no crypto hashing.
 */
export class HyperLogLog {
    /** @param p precision, integer in [4, 18] (m = 2^p registers; default 14). @param seed per-instance uint32. Throws [lite-sketch] on a bad p / seed BEFORE the register array is allocated. */
    constructor(p?: number, seed?: number);

    /** The precision p. O(1). */
    readonly p: number;

    /** The register count, 2^p. O(1). */
    readonly m: number;

    /** The theoretical relative standard error, 1.04 / sqrt(m). O(1). */
    readonly standardError: number;

    /** The uint32 hash seed. O(1). */
    readonly seed: number;

    /** Hash a SAFE-INTEGER key (|key| <= 2^53 - 1; the hot body distinguishes low word + high word + sign) and record its register (running max of rho). HOT, O(1), 0 library B/op. Throws [lite-sketch] on a non-number / NaN / +-Infinity / non-integer / out-of-safe-range key (a byte-identical no-op). */
    add(key: number): this;

    /** The pre-hashed fast path: two uint32 lanes hashed by the caller; skips the internal mix. HOT, O(1), 0 library B/op (a lane >= 2^31 boxes at a non-inlined call -> addHashedFrom). Throws [lite-sketch] on a non-uint32 lane. */
    addHashed(hi: number, lo: number): this;

    /** Add the key at `buf[i]` of a caller-owned Float64Array -- the ZERO-BOX entry point for a key >= 2^31 (0 library B/op; `add` boxes a non-Smi argument (~16 B) at a non-inlined call). Same validation / throws / no-op-on-reject as `add`. The buffer check stays `instanceof` (D3): a `Proxy` over a typed array passes it and its get traps run, but `buf[i]` is read exactly once, so no value changes mid-add. */
    addFrom(buf: Float64Array, i: number): this;

    /** Add a pre-hashed key from two uint32 lanes read UNBOXED at `buf[i]`, `buf[i+1]` (Uint32Array or Int32Array) -- the zero-box sibling of `addHashed`. Throws [lite-sketch] on a bad buffer / index, and with addHashed's lane error on a lane read that is neither uint32 nor int32 (e.g. through a Proxy), before any write. */
    addHashedFrom(buf: Uint32Array | Int32Array, i: number): this;

    /** The estimated distinct count via Ertl's improved estimator (table-free, accurate across the whole range). COLD, O(m) -- a disclosed co-headline, not per-add. Never throws. The result is `Math.round(...)`, a Smi below 2^31 on Node (2^30 on 31-bit-Smi Chrome), so it is returned UNBOXED there; an estimate above that boxes a ~16 B HeapNumber on the non-inlined return (at realistic cardinalities it does not). */
    count(): number;

    /** Register-wise max of `other` into this (the union). Throws [lite-sketch] on a non-HyperLogLog or a m / seed mismatch. Brand-checked (a private `#brand`, not `instanceof`): a `Proxy` over an instance or a field-copy forgery is NOT a HyperLogLog and throws tagged before any read of `other`. */
    merge(other: HyperLogLog): this;

    /** Zero the registers; reuse the same allocation. */
    clear(): this;
}

/**
 * Options accepted by the `CountMinSketch` constructor and `withAccuracy`.
 *
 * Must be a PLAIN bag: own STRING keys only, on a `null` prototype, THIS realm's `Object.prototype`,
 * or another root prototype that carries NO own known key -- so a clean `vm` / iframe literal stays
 * legal, but a cross-realm `Object.prototype` polluted with a known key is rejected. A Map / Date / RegExp / array / class
 * instance / `Object.create(proto)`, an own ACCESSOR (no getter is ever run), or an own
 * Symbol key is rejected with the plain-object `[lite-sketch]` TypeError; an unknown string
 * key throws with a did-you-mean hint. Inherited values are NOT read. A revoked or
 * throwing-trap `Proxy` is caught and rejected with that same tagged TypeError, never an
 * untagged engine error.
 */
export interface CountMinSketchOptions {
    /** Uint32 hash seed (any integer, coerced with `| 0`). Default shared with HyperLogLog. */
    seed?: number;
    /** Conservative-update mode (Estan-Varghese). Default true. */
    conservative?: boolean;
}

/**
 * CountMinSketch -- a zero-GC point-query FREQUENCY sketch over a dense
 * `Uint32Array(d * w)` counter matrix, `d` hash rows x `w` columns (`w` a power of
 * two). `add(key, count?)` increments one cell per row (conservative or plain per the
 * ctor flag), 0 library B/op; `estimate(key)` returns the minimum of its `d` cells -- a
 * ONE-SIDED over-estimate while `!saturated`: `f_hat >= f_true`, with `f_hat - f_true <=
 * epsilon * total` w.p. `>= 1 - delta` (`epsilon = e/w`, `delta = e^-d`) -- one-sided
 * while `!saturated` (once a counter saturates at 2^32-1 the `saturated` getter is set
 * and a query over a saturated key may read low). Plain sketches merge EXACTLY
 * (elementwise saturating add); conservative merge is a valid but looser upper bound; a
 * cross-`conservative` merge is allowed (S7, `this` keeps its own flag). Dense-only; no
 * crypto hashing.
 */
export class CountMinSketch {
    /**
     * @param d depth (hash rows), integer in [1, 32].
     * @param w width (columns/row), integer in [1, 2^25], rounded UP to a power of two.
     * @param options seed / conservative. Throws [lite-sketch] on any bad argument
     *   BEFORE the counter matrix is allocated (incl. an unknown option key).
     */
    constructor(d: number, w: number, options?: CountMinSketchOptions);

    /**
     * Build a sketch sized to a target accuracy: `w = ceil(e/epsilon)` (rounded up to
     * a power of two), `d = ceil(ln(1/delta))` (clamped UP to >= 1). Throws [lite-sketch]
     * when the request is UNATTAINABLE -- `w > 2^25` or `d > 32` (F16/S6) -- rather than
     * silently clamping down to a weaker guarantee. Delegates remaining validation to the
     * constructor.
     * @param epsilon relative error, in (0, 1).
     * @param delta failure probability, in (0, 1).
     */
    static withAccuracy(epsilon: number, delta: number, options?: CountMinSketchOptions): CountMinSketch;

    /** Depth d (hash rows). O(1). */
    readonly d: number;

    /** Width w (columns/row, a power of two). O(1). */
    readonly w: number;

    /** The uint32 hash seed. O(1). */
    readonly seed: number;

    /** Whether conservative update is on. O(1). */
    readonly conservative: boolean;

    /** Total count added (sum of all `count`s). O(1). */
    readonly total: number;

    /** Whether any counter has saturated at 2^32-1 (F14/S4). Sticky: set on any clamp, carried by `merge` from either side, reset only by `clear()`. While false the estimate is strictly one-sided (never undercounts); once true a saturated key may read low. O(1). */
    readonly saturated: boolean;

    /** The theoretical relative error, e / w. O(1). */
    readonly epsilon: number;

    /** The theoretical failure probability, e^-d. O(1). */
    readonly delta: number;

    /** Hash a SAFE-INTEGER key (|key| <= 2^53 - 1; the hot body distinguishes low word + high word + sign) and increment its row cells by `count` (default 1, domain [1, 2^32-1]). HOT, O(d), 0 library B/op. Throws [lite-sketch] on a non-number / NaN / +-Infinity / non-integer / out-of-safe-range key, an out-of-range count, or an add that would push the running `total` past 2^53-1 (F15/S5) -- a byte-identical no-op. */
    add(key: number, count?: number): this;

    /** The pre-hashed fast path: two uint32 lanes hashed by the caller; skips the internal mix. HOT, O(d), 0 library B/op (a lane or count >= 2^31 boxes at a non-inlined call -> addHashedFrom). Throws [lite-sketch] on a non-uint32 lane, an out-of-range count, or a running `total` past 2^53-1. */
    addHashed(hi: number, lo: number, count?: number): this;

    /** Add the key at `buf[i]` with count at `buf[i+1]` of a caller-owned Float64Array -- the ZERO-BOX entry point for a key or count >= 2^31 (0 library B/op; `add` boxes a non-Smi argument (~16 B) at a non-inlined call). Same validation / throws / no-op-on-reject as `add`. The buffer check stays `instanceof` (D3): a `Proxy` over a typed array passes it and its get traps run, but each slot is read exactly once. */
    addFrom(buf: Float64Array, i: number): this;

    /** Add a pre-hashed key from three slots [hi, lo, count] read UNBOXED at `buf[i..i+2]` (Uint32Array or Int32Array; an Int32Array caps count at 2^31-1). The zero-box sibling of `addHashed`. Throws [lite-sketch] on a bad buffer / index / count, and with addHashed's lane error on a lane read that is neither uint32 nor int32 (e.g. through a Proxy), before any write. */
    addHashedFrom(buf: Uint32Array | Int32Array, i: number): this;

    /** The minimum over the key's d cells -- the tightest one-sided over-estimate. HOT, O(d), 0 library B/op. Never throws: a key `add` would reject (non-integer / non-finite / out-of-safe-range) estimates 0 and never aliases a real key (F13). The returned count is a Smi below 2^31 (Node); a cell value >= 2^31 boxes a ~16 B HeapNumber on the non-inlined return (documented, not fixed: there is deliberately no `estimateInto`). */
    estimate(key: number): number;

    /** Estimate from a pre-hashed key (two uint32 lanes). HOT, O(d), 0 library B/op. Never throws (a bad lane estimates 0). */
    estimateHashed(hi: number, lo: number): number;

    /** Element-wise saturating add of `other` into this. Exact for plain sketches; a valid but looser upper bound for conservative ones; a cross-`conservative` merge is allowed (S7, `this` keeps its flag). Carries `other.saturated` and any merge-time clamp into `this.saturated`. Throws [lite-sketch] on a non-CountMinSketch, a d / w / seed mismatch, or a running `total` past 2^53-1 (byte-identical). Brand-checked (a private `#brand`, not `instanceof`): a `Proxy` over an instance or a field-copy forgery is NOT a CountMinSketch and throws tagged before any read of `other`. */
    merge(other: CountMinSketch): this;

    /** Zero every counter, the running total, and the sticky `saturated` flag; reuse the same allocation. */
    clear(): this;
}

/**
 * Options accepted by the `DDSketch` constructor.
 *
 * Must be a PLAIN bag: own STRING keys only, on a `null` prototype, THIS realm's `Object.prototype`,
 * or another root prototype that carries NO own known key (a clean cross-realm literal stays legal; a
 * cross-realm `Object.prototype` polluted with a known key is rejected). A Map / Date / RegExp / array / class instance / `Object.create(proto)`, an
 * own ACCESSOR (no getter is ever run), or an own Symbol key is rejected with the plain-object
 * `[lite-sketch]` TypeError; an unknown string key throws with a did-you-mean hint. Inherited
 * values are NOT read. A revoked or throwing-trap `Proxy` -- whether as the bag or as `range`
 * -- is caught and rejected tagged (the bag with the plain-object TypeError, `range` with the
 * `_badRange` TypeError), never an untagged engine error.
 */
export interface DDSketchOptions {
    /** Bin-array length, an integer in [1, 2^20] (default 2048). Ignored in strict mode (derived from `range`). */
    maxBins?: number;
    /** `[min, max]` with finite `0 < min < max` -> STRICT mode (fail-closed, no collapse): a value whose BUCKET KEY falls outside the range's key span throws (at alpha 0.01, `[1, 100]` accepts 0.99 and 101 -- key(0.99)=key(1)=0, key(101)=key(100)=231). */
    range?: [number, number];
}

/**
 * Smallest supported DDSketch `alpha` (1e-6). The ctor accepts `DD_ALPHA_MIN <= alpha < 1`;
 * a smaller alpha throws [lite-sketch] at the ctor door.
 */
export const DD_ALPHA_MIN: number;

/**
 * DDSketch -- a zero-GC, relative-error QUANTILE sketch over a dense
 * `Float64Array` of log-scale bins (Masson, Rim, Lee -- "DDSketch: A Fast and
 * Fully-Mergeable Quantile Sketch with Relative-Error Guarantees"). Unlike
 * HyperLogLog / CountMinSketch it does NOT hash -- it bins raw values on a log
 * scale, `key(x) = ceil(ln(x) * multiplier)` with `gamma = (1+alpha)/(1-alpha)`.
 * `quantile(q)` returns `v` with `|v - v_true| <= alpha * v_true`. Zeros route to
 * a dedicated exact `zeroCount`; negatives fail closed. Default mode collapses the
 * LOWEST bins under a fixed `maxBins` window (disclosed via `collapsed`): once collapsed,
 * a quantile is within `alpha` only if its rank lies above the mass folded into the floor
 * bucket, and which quantiles survive depends on the value span vs `maxBins`, not on `q`.
 * `range` switches to a STRICT fixed window that throws on a value whose BUCKET KEY falls
 * outside the range's key span instead of collapsing. `count` / `sum` / `min` / `max` /
 * `zeroCount` are EXACT running aggregates; `quantile` is the alpha-approximate member.
 */
export class DDSketch {
    /**
     * @param alpha relative-error target, a number in `[1e-6, 1)` (the floor is
     *   `DD_ALPHA_MIN`; a smaller alpha throws [lite-sketch] at the ctor door).
     * @param options maxBins / range. Throws [lite-sketch] on any bad argument
     *   BEFORE the bin array is allocated (incl. an unknown option key).
     */
    constructor(alpha: number, options?: DDSketchOptions);

    /** The relative-error target alpha. O(1). */
    readonly alpha: number;

    /** Total values added (sum of all counts, incl. zeros). O(1). */
    readonly count: number;

    /** Exact running sum of every added value. O(1). */
    readonly sum: number;

    /** EXACT minimum value seen (NaN if empty). A stored -0 reads as +0 (`+ 0` in the getter; F18). O(1). */
    readonly min: number;

    /** EXACT maximum value seen (NaN if empty). A stored -0 reads as +0 (`+ 0` in the getter; F18). O(1). */
    readonly max: number;

    /** How many exact zeros were added. O(1). */
    readonly zeroCount: number;

    /** Bin-array length (the space cap on the log-scale window). O(1). */
    readonly maxBins: number;

    /** Count of currently non-empty bins. COLD, O(maxBins) scan. */
    readonly numBins: number;

    /** Whether any nonzero mass has ever been folded into the collapsed floor. O(1). */
    readonly collapsed: boolean;

    /** Whether this is a STRICT fixed-range sketch (a `range` was given at construction; no collapse). O(1). */
    readonly strict: boolean;

    /** The smallest x > 0 `add` accepts at this alpha, the EXACT bisected edge of `add`'s own key expression (EXCLUSIVE floor: `add` accepts finite `minIndexable < x <= maxIndexable`, plus exact 0). ~2.2e-308 at alpha=0.01. O(1), 0 library B/op. */
    readonly minIndexable: number;

    /** The largest x `add` accepts at this alpha, the EXACT bisected edge of `add`'s own key expression (INCLUSIVE ceiling: `add` accepts finite `minIndexable < x <= maxIndexable`; always below `Number.MAX_VALUE`, whose representative would overflow). ~8.9e307 at alpha=0.01. O(1), 0 library B/op. */
    readonly maxIndexable: number;

    /** STRICT mode: the configured range minimum passed at construction (NaN if not strict). O(1). */
    readonly rangeMin: number;

    /** STRICT mode: the configured range maximum passed at construction (NaN if not strict). O(1). */
    readonly rangeMax: number;

    /** Add a value with a positive integer `count` (default 1, domain [1, 2^32-1]). HOT, O(1) amortized, 0 library B/op. Throws [lite-sketch] on a non-finite / negative value, a count outside [1, 2^32-1], an add that would push the running `count` past 2^53-1 (F15/S5), or (strict mode) a value outside the fixed range -- each a byte-identical no-op. A doubly-invalid add (negative value + over-cap count) names the count (the count check precedes the negative-value check; a non-finite value is still caught first). */
    add(value: number, count?: number): this;

    /** Add the value at `buf[i]` (count = 1) -- the ZERO-BOX entry point for a FRACTIONAL hot-path value: `add(fractionalDouble)` boxes its argument (~16 B/call) when not inlined, whereas `addFrom` reads `buf[i]` unboxed. Same validation / throws / binning as `add`. HOT, O(1) amortized, 0 B/op. Throws [lite-sketch] on a non-Float64Array `buf`, an out-of-bounds / non-integer `i`, or a value `add` would reject. The buffer check stays `instanceof` (D3): a `Proxy` over a typed array passes it and its get traps run, but `buf[i]` is read exactly once. */
    addFrom(buf: Float64Array, i: number): this;

    /** Estimate the value at quantile q in [0, 1] -- the alpha-approximate member. COLD, O(bins). NEVER throws; returns NaN for a bad q or an empty sketch. Returns a FRACTIONAL double and is not inlined, so EVERY call boxes a ~16 B HeapNumber on the return (gated: the `Q-CTRL[ni/dd.quantile]` lane reads 24 scavenges over 1.6M calls). Use `quantilesInto` for a 0-alloc multi-quantile render. */
    quantile(q: number): number;

    /**
     * Estimate several quantiles at once into a caller-owned Float64Array, allocation-free (F8) --
     * the 0-alloc render for p50/p90/p99/p999, where N calls to `quantile` would box N HeapNumbers.
     * For each j in `[0, min(qs.length, out.length))`, `out[j]` receives `quantile(qs[j])`
     * BIT-FOR-BIT (quantile's walk is duplicated per q, so no double crosses a call boundary); the
     * number written is returned. A bad `q` value (NaN / outside [0, 1] / empty sketch) writes NaN
     * and NEVER throws, exactly like `quantile`. In-place `qs === out` is allowed (each index is
     * read before it is written). The `ni/dd.quantilesInto.q4` lane reads 0 scavenges over 1.6M
     * quantiles (N8 gate <= 2). Views on DIFFERENT SharedArrayBuffer objects are rejected (two
     * distinct SAB objects may alias one block of memory, which cannot be verified).
     * @param qs quantiles in [0, 1] (a real Float64Array)
     * @param out destination (a real Float64Array; may be `qs`)
     * @returns the number of quantiles written, `min(qs.length, out.length)`
     * @throws TypeError `[lite-sketch]` BEFORE any write when `qs` or `out` is not a Float64Array,
     *   the two are distinct views that PARTIALLY overlap in memory, or they are backed by DIFFERENT
     *   SharedArrayBuffer objects (aliasing cannot be verified).
     */
    quantilesInto(qs: Float64Array, out: Float64Array): number;

    /** Merge `other` into this: fold the running aggregates and every populated bin through the same collapse logic as `add`, and carry `other.collapsed` forward (merging collapsed mass makes this collapsed). O(other bins). Throws [lite-sketch] on a non-DDSketch, an unequal alpha/gamma, a running `count` past 2^53-1 (F15/S5), (strict mode) an incoming key outside the fixed range, or (strict mode) a COLLAPSED `other`. Brand-checked (a private `#brand`, not `instanceof`): a `Proxy` over an instance or a field-copy forgery is NOT a DDSketch and throws tagged before any read of `other` (a `_gamma`-only forgery previously merged and left count / sum NaN). */
    merge(other: DDSketch): this;

    /** Reset the sketch to empty. O(maxBins). */
    clear(): this;
}

/**
 * Options accepted by the `SpaceSaving` constructor and `withError`.
 *
 * Must be a PLAIN bag: own STRING keys only, on a `null` prototype, THIS realm's `Object.prototype`,
 * or another root prototype that carries NO own known key (a clean cross-realm literal stays legal; a
 * cross-realm `Object.prototype` polluted with a known key is rejected). A Map / Date / RegExp / array / class instance / `Object.create(proto)`, an
 * own ACCESSOR (no getter is ever run), or an own Symbol key is rejected with the plain-object
 * `[lite-sketch]` TypeError; an unknown string key throws with a did-you-mean hint. Inherited
 * values are NOT read. A revoked or throwing-trap `Proxy` is caught and rejected with that same
 * tagged TypeError, never an untagged engine error.
 */
export interface SpaceSavingOptions {
    /** Per-instance uint32 hash seed (any integer, coerced with `| 0`); default shared with the family. */
    seed?: number;
}

/** A monitored entry returned by `SpaceSaving.topK` / `heavyHitters`. */
export interface SpaceSavingEntry {
    /** The monitored key. */
    key: number;
    /** Its estimated frequency (an upper bound on the true count). */
    count: number;
    /** The maximum over-estimate: the true count lies in `[count - error, count]`. */
    error: number;
}

/**
 * SpaceSaving -- a zero-GC HEAVY-HITTERS / TOP-K sketch (Metwally, Agrawal, El
 * Abbadi -- "Efficient Computation of Frequent and Top-k Elements in Data
 * Streams"). Monitors a fixed `capacity` (k) counters over an intrusive
 * frequency-bucket forest + a fixed open-addressing key map. `add(key)`
 * increments a monitored key, inserts a free slot, or -- when full -- EVICTS the
 * minimum-count key and reassigns its slot to the newcomer at `count = min + 1`,
 * `error = min` (eviction IS the algorithm; it never fails at capacity).
 * Guarantee: every key with true frequency > N/k is monitored (NO false
 * negatives), a monitored key's true count lies in `[count - error, count]`, and
 * `error <= N/k`. There is deliberately NO `addHashed`: a heavy-hitters sketch
 * must retain each key's identity, so there is no honest pre-hashed fast path.
 */
export class SpaceSaving {
    /**
     * @param capacity the number of monitored counters k, an integer in [1, 2^24].
     * @param options seed. Throws [lite-sketch] on any bad argument (incl. an
     *   unknown option key) BEFORE the pools are allocated.
     */
    constructor(capacity: number, options?: SpaceSavingOptions);

    /**
     * Build a summary sized to a target error: `k = ceil(1 / epsilon)`. A monitored key's
     * over-estimate is then bounded by `epsilon * N`. Throws [lite-sketch] when the request
     * is UNATTAINABLE -- `k > 2^24` (F16/S6) -- rather than silently clamping down.
     * @param epsilon the target error fraction, a number in (0, 1).
     */
    static withError(epsilon: number, options?: SpaceSavingOptions): SpaceSaving;

    /** The monitored-counter capacity k. O(1). */
    readonly capacity: number;

    /** The number of keys currently monitored (<= capacity). O(1). */
    readonly size: number;

    /** Total weight added (the exact running sum N of all counts). O(1). */
    readonly total: number;

    /** The theoretical error fraction 1 / capacity. O(1). */
    readonly epsilon: number;

    /** The uint32 hash seed. O(1). */
    readonly seed: number;

    /** Add a safe-integer `key` with a positive integer `count` (default 1, domain [1, 2^32-1]). HOT, O(1) amortized, 0 library B/op. Increments, inserts, or evicts the min. Throws [lite-sketch] on a non-safe-integer key, a count outside [1, 2^32-1], or an add that would push the running `total` past 2^53-1 (F15/S5) -- a byte-identical no-op. */
    add(key: number, count?: number): this;

    /** Add the key at `buf[i]` with count at `buf[i+1]` of a caller-owned Float64Array -- the ZERO-BOX entry point for a key or count >= 2^31 (0 library B/op; `add` boxes a non-Smi argument (~16 B) at a non-inlined call). Snapshots both slots before use (D1). Same validation / throws / no-op-on-reject as `add`. */
    addFrom(buf: Float64Array, i: number): this;

    /** The estimated frequency of `key` (an upper bound), or 0 if not monitored. HOT, O(1). NEVER throws. */
    estimate(key: number): number;

    /** The over-estimate bound for `key` (true count is in `[estimate - errorOf, estimate]`), or 0 if not monitored. HOT, O(1). NEVER throws. */
    errorOf(key: number): number;

    /** Iterate the monitored entries alloc-free (storage order, NOT sorted): `fn(key, count, error, this)`. NEVER throws. The loop bound is the LIVE `size` (F18): do NOT mutate the sketch inside `fn` -- a mutation never produces ghosts, but entries may be skipped or revisited. `key` is normalized (a stored -0 reads +0). NOTE the per-entry cost: a NON-inlined `fn` boxes ~49 B/entry for entries with a key / count / error >= 2^31 (three doubles cross the call; the `ni/ss.forEach/big` lane reads 73 scavenges over 1.6M entries). Use `topKInto` for a 0-alloc render of large-keyed entries. */
    forEach(fn: (key: number, count: number, error: number, ss: SpaceSaving) => void): void;

    /** The top `n` monitored keys by count, DESCENDING, ties by ASCENDING slot (default n = size). COLD; ALLOCATES the result array (~160 B/entry, approx, v8 total_allocated_bytes; not gated); each `key` is normalized (a stored -0 reads +0). NEVER throws. Use `topKInto` for a 0-alloc render. */
    topK(n?: number): SpaceSavingEntry[];

    /** Every monitored key with `count > threshold * total` -- a SUPERSET with NO false negatives (every true heavy hitter is included; a few false positives may be too). Filter the result by `(count - error) > threshold * total` for the guaranteed-frequent subset. COLD; ALLOCATES (~135 B/entry, approx, v8 total_allocated_bytes; not gated); each `key` is normalized (a stored -0 reads +0). NEVER throws. */
    heavyHitters(threshold: number): SpaceSavingEntry[];

    /**
     * Write the top-`n` monitored entries by count into three caller-owned Float64Arrays,
     * allocation-free (F7) -- the 0-alloc top-N render, where `topK(n)` allocates (~160 B/entry).
     * `outKeys[j]`, `outCounts[j]`, `outErrors[j]` receive entry j best-first, in EXACTLY `topK(n)`'s
     * order: count DESCENDING, ties by ASCENDING slot. `n` follows topK's rule (defaults to / clamps
     * to `size`; a non-integer / negative `n` is treated as `size`, never throws). The number written
     * is `w = min(n, size, outKeys.length, outCounts.length, outErrors.length)`, returned; a too-short
     * out simply receives its own length. Each key is normalized (a stored -0 reads +0). O(size log w),
     * monomorphic, no boxing: the `ni/ss.topKInto.n16|n64/big` lanes read 0 scavenges over 1.6M entries
     * (N8 gate <= 2). Disjoint views over one buffer are allowed. Views on DIFFERENT
     * SharedArrayBuffer objects are rejected (two distinct SAB objects may alias one block of
     * memory -- e.g. a `structuredClone` or a worker round-trip -- which cannot be verified).
     * @param outKeys destination for the keys (a real Float64Array)
     * @param outCounts destination for the counts (a real Float64Array)
     * @param outErrors destination for the errors (a real Float64Array)
     * @param n how many entries, best-first (default `size`)
     * @returns the number of entries written
     * @throws TypeError `[lite-sketch]` BEFORE any write when any out is not a Float64Array, two of
     *   the three overlap in memory (a wrong array type would silently truncate a key >= 2^32), or
     *   two are backed by DIFFERENT SharedArrayBuffer objects (aliasing cannot be verified).
     */
    topKInto(outKeys: Float64Array, outCounts: Float64Array, outErrors: Float64Array, n?: number): number;

    /** Merge `other` into this (min-imputation for absent keys, keep the top-k). O(k), with a bounded cold scratch allocation (~300 B/entry, approx, v8 total_allocated_bytes; not gated). Throws [lite-sketch] on a non-SpaceSaving, an unequal capacity/seed, or a running `total` past 2^53-1 (F15/S5, byte-identical). Brand-checked (a private `#brand`, not `instanceof`): a `Proxy` over an instance or a field-copy forgery is NOT a SpaceSaving and throws tagged before any read of `other`. */
    merge(other: SpaceSaving): this;

    /** Reset the summary to empty. O(capacity). */
    clear(): this;
}
