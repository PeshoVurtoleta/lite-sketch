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
