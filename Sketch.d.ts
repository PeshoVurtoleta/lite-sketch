/**
 * @zakkster/lite-sketch -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of Sketch.js. The three-place
 * version sync (package.json / Sketch.js VERSION / llms.txt) is enforced in review;
 * this file only declares that `VERSION` exists. ASCII-only.
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
 * @param key a numeric key (integer keys hash injectively; see the numeric-key note).
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
 * register per element (0 B/op); `count()` estimates the distinct total with standard
 * error `1.04/sqrt(m)`. Mergeable (register-wise max). Dense-only; no crypto hashing.
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

    /** Hash a numeric key and record its register (running max of rho). HOT, O(1), 0 B/op. Throws [lite-sketch] on a non-number / NaN key. */
    add(key: number): this;

    /** The pre-hashed fast path: two uint32 lanes hashed by the caller; skips the internal mix. HOT, O(1), 0 B/op. Throws [lite-sketch] on a non-uint32 lane. */
    addHashed(hi: number, lo: number): this;

    /** The estimated distinct count (raw HLL estimate + small-range linear counting). COLD, O(m) -- a disclosed co-headline, not per-add. Never throws. */
    count(): number;

    /** Register-wise max of `other` into this (the union). Throws [lite-sketch] on a non-HyperLogLog or unequal m. */
    merge(other: HyperLogLog): this;

    /** Zero the registers; reuse the same allocation. */
    clear(): this;
}

/** Options accepted by the `CountMinSketch` constructor and `withAccuracy`. */
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
 * ctor flag), 0 B/op; `estimate(key)` returns the minimum of its `d` cells -- a
 * ONE-SIDED over-estimate: `f_hat >= f_true` always, with `f_hat - f_true <=
 * epsilon * total` w.p. `>= 1 - delta` (`epsilon = e/w`, `delta = e^-d`). Plain
 * sketches merge EXACTLY (elementwise saturating add); conservative merge is a valid
 * but looser upper bound. Dense-only; no crypto hashing.
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
     * a power of two, clamped to the width cap), `d = ceil(ln(1/delta))` (clamped to
     * [1, 32]). Delegates remaining validation to the constructor.
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

    /** The theoretical relative error, e / w. O(1). */
    readonly epsilon: number;

    /** The theoretical failure probability, e^-d. O(1). */
    readonly delta: number;

    /** Hash a numeric key and increment its row cells by `count` (default 1). HOT, O(d), 0 B/op. Throws [lite-sketch] on a non-number / NaN key or an out-of-range count. */
    add(key: number, count?: number): this;

    /** The pre-hashed fast path: two uint32 lanes hashed by the caller; skips the internal mix. HOT, O(d), 0 B/op. Throws [lite-sketch] on a non-uint32 lane or an out-of-range count. */
    addHashed(hi: number, lo: number, count?: number): this;

    /** The minimum over the key's d cells -- the tightest one-sided over-estimate. HOT, O(d), 0 B/op. Never throws (a bad key estimates 0). */
    estimate(key: number): number;

    /** Estimate from a pre-hashed key (two uint32 lanes). HOT, O(d), 0 B/op. Never throws (a bad lane estimates 0). */
    estimateHashed(hi: number, lo: number): number;

    /** Element-wise saturating add of `other` into this. Exact for plain sketches; a valid but looser upper bound for conservative ones. Throws [lite-sketch] on a non-CountMinSketch or a d / w / seed mismatch. */
    merge(other: CountMinSketch): this;

    /** Zero every counter and the running total; reuse the same allocation. */
    clear(): this;
}

/** Options accepted by the `DDSketch` constructor. */
export interface DDSketchOptions {
    /** Bin-array length, an integer in [1, 2^20] (default 2048). Ignored in strict mode (derived from `range`). */
    maxBins?: number;
    /** `[min, max]` with finite `0 < min < max` -> STRICT mode (fail-closed, no collapse). */
    range?: [number, number];
}

/**
 * DDSketch -- a zero-GC, relative-error QUANTILE sketch over a dense
 * `Float64Array` of log-scale bins (Masson, Rim, Lee -- "DDSketch: A Fast and
 * Fully-Mergeable Quantile Sketch with Relative-Error Guarantees"). Unlike
 * HyperLogLog / CountMinSketch it does NOT hash -- it bins raw values on a log
 * scale, `key(x) = ceil(ln(x) * multiplier)` with `gamma = (1+alpha)/(1-alpha)`.
 * `quantile(q)` returns `v` with `|v - v_true| <= alpha * v_true`. Zeros route to
 * a dedicated exact `zeroCount`; negatives fail closed. Default mode collapses the
 * LOWEST bins under a fixed `maxBins` window (disclosed via `collapsed`); `range`
 * switches to a STRICT fixed window that throws on an out-of-range value instead
 * of collapsing. `count` / `sum` / `min` / `max` / `zeroCount` are EXACT running
 * aggregates; `quantile` is the alpha-approximate member.
 */
export class DDSketch {
    /**
     * @param alpha relative-error target, a number in (0, 1).
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

    /** EXACT minimum value seen (NaN if empty). O(1). */
    readonly min: number;

    /** EXACT maximum value seen (NaN if empty). O(1). */
    readonly max: number;

    /** How many exact zeros were added. O(1). */
    readonly zeroCount: number;

    /** Bin-array length (the space cap on the log-scale window). O(1). */
    readonly maxBins: number;

    /** Count of currently non-empty bins. COLD, O(maxBins) scan. */
    readonly numBins: number;

    /** Whether any nonzero mass has ever been folded into the collapsed floor. O(1). */
    readonly collapsed: boolean;

    /** Add a value with a positive integer `count` (default 1). HOT, O(1) amortized, 0 B/op. Throws [lite-sketch] on a non-finite / negative value, a non-positive-integer count, or (strict mode) a value outside the fixed range. */
    add(value: number, count?: number): this;

    /** Estimate the value at quantile q in [0, 1] -- the alpha-approximate member. COLD, O(bins). NEVER throws; returns NaN for a bad q or an empty sketch. */
    quantile(q: number): number;

    /** Merge `other` into this: fold the running aggregates and every populated bin through the same collapse logic as `add`. O(other bins). Throws [lite-sketch] on a non-DDSketch, an unequal alpha/gamma, or (strict mode) an incoming key outside the fixed range. */
    merge(other: DDSketch): this;

    /** Reset the sketch to empty. O(maxBins). */
    clear(): this;
}

/** Options accepted by the `SpaceSaving` constructor. */
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
     * Build a summary sized to a target error: `k = ceil(1 / epsilon)` (clamped to
     * 2^24). A monitored key's over-estimate is then bounded by `epsilon * N`.
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

    /** Add a safe-integer `key` with a positive integer `count` (default 1). HOT, O(1) amortized, 0 B/op. Increments, inserts, or evicts the min. Throws [lite-sketch] on a non-safe-integer key or a non-positive-integer count (a byte-identical no-op). */
    add(key: number, count?: number): this;

    /** The estimated frequency of `key` (an upper bound), or 0 if not monitored. HOT, O(1). NEVER throws. */
    estimate(key: number): number;

    /** The over-estimate bound for `key` (true count is in `[estimate - errorOf, estimate]`), or 0 if not monitored. HOT, O(1). NEVER throws. */
    errorOf(key: number): number;

    /** Iterate the monitored entries alloc-free (storage order, NOT sorted): `fn(key, count, error, this)`. NEVER throws. */
    forEach(fn: (key: number, count: number, error: number, ss: SpaceSaving) => void): void;

    /** The top `n` monitored keys by count, DESCENDING (default n = size). COLD; ALLOCATES the result array. NEVER throws. */
    topK(n?: number): SpaceSavingEntry[];

    /** Every monitored key with `count > threshold * total` -- a SUPERSET with NO false negatives (every true heavy hitter is included; a few false positives may be too). Filter the result by `(count - error) > threshold * total` for the guaranteed-frequent subset. COLD; ALLOCATES. NEVER throws. */
    heavyHitters(threshold: number): SpaceSavingEntry[];

    /** Merge `other` into this (min-imputation for absent keys, keep the top-k). O(k). Throws [lite-sketch] on a non-SpaceSaving or an unequal capacity/seed. */
    merge(other: SpaceSaving): this;

    /** Reset the summary to empty. O(capacity). */
    clear(): this;
}
