# @zakkster/lite-sketch

> Zero-GC approximate streaming summaries that **witness their accuracy against the paper's bound** -- HyperLogLog for distinct-count, CountMinSketch for frequency.

![zero deps](https://img.shields.io/badge/deps-0-brightgreen) ![zero GC](https://img.shields.io/badge/hot--path-0%20B%2Fop-brightgreen) ![ESM](https://img.shields.io/badge/module-ESM-blue) ![types](https://img.shields.io/badge/types-included-blue) ![license](https://img.shields.io/badge/license-MIT-blue)

## The approximate-summary family the ecosystem was missing

Exact analytics over an unbounded stream cost unbounded memory: a `Set` to count distinct values, a `Map` to count frequencies, a sorted array for quantiles. **Sketches** trade a small, *bounded* error for *fixed* memory -- and the trade is only honest if you can see it. `lite-sketch` is a zero-dependency, zero-GC family of streaming sketches whose signature is a shipped **accuracy witness**: every member proves its MEASURED error against the paper's THEORETICAL bound, next to the memory it saves.

It is the missing third corner of the suite: **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** answers approximate *membership*, **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** answers *exact* O(1), and `lite-sketch` answers *approximate* aggregates (count / frequency / quantile / top-k).

```bash
npm i @zakkster/lite-sketch
```

```js
import { HyperLogLog } from '@zakkster/lite-sketch';

const hll = new HyperLogLog(14);          // 2^14 = 16384 one-byte registers (~16 KB), ~0.8% std error
for (let i = 0; i < 1_000_000; i++) hll.add(i);   // 1M distinct keys, 0 bytes/op
hll.count();                               // ~1,000,000  (a Set would hold 1M entries; this holds 16 KB)
hll.standardError;                         // 0.008  -- the theoretical 1.04/sqrt(m)
```

## Contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [HyperLogLog](#hyperloglog)
- [CountMinSketch](#countminsketch)
- [API reference](#api-reference)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

## Why this exists

A sketch is a promise: "I use `X` bytes and my answer is within `E` of the truth." That promise is only as good as (1) the hash it is built on -- every accuracy proof assumes uniform, independent hashing -- and (2) whether anyone ever *checks* the error against the theory. Most libraries ship the structure and cite the paper. `lite-sketch` ships the structure, **ships its own tested hash** (zero-dep means it must), and **ships the witness that measures the error and gates it against the bound** on every release. Accuracy is a co-headline, stated honestly: space, error, one-sided-vs-two-sided, statistical-vs-hard.

## What you get

- **HyperLogLog** -- distinct-count (cardinality) in fixed space, `~1.04/sqrt(m)` standard error, mergeable. (The reference member.)
- **CountMinSketch** -- point-query frequency ("how many times have I seen `x`?") in a fixed `d x w` matrix, a one-sided over-estimate bounded by `epsilon * N`, with conservative update on by default and merge for map/reduce. (DDSketch and SpaceSaving follow, one per release, to a stable 1.0.0.)
- **A shipped, avalanche-tested hash** -- a two-lane 64-bit-quality non-crypto mix, zero-alloc, with a pre-hashed fast path for callers who bring their own.
- **The accuracy witness** -- measured error vs the theoretical bound, printed side by side, with the exact-`Set` foil whose memory climbs without bound.
- **Zero runtime dependencies**, ESM, tree-shakeable named exports, TypeScript types, and a **0 bytes/op hot path** proven by a leak + GC-profiler torture gate.

## HyperLogLog

Count the number of DISTINCT elements in an unbounded stream using a fixed `m = 2^p` array of one-byte registers. Each element is hashed; the top `p` bits pick a register, and the position of the leftmost 1-bit in the rest (`rho`) is recorded as a running max. The distribution of those maxima estimates the cardinality -- with standard error `1.04/sqrt(m)`, *independent of how many elements you add*.

```js
import { HyperLogLog } from '@zakkster/lite-sketch';

const a = new HyperLogLog(12);            // ~4 KB, ~1.6% std error
const b = new HyperLogLog(12);
for (const u of mondayUsers) a.add(u);    // numeric keys; pre-hash strings or use addHashed
for (const u of tuesdayUsers) b.add(u);

a.merge(b);                               // register-wise max -- union of the two days, equal-m-or-throw
a.count();                                // distinct users across both days, in ~4 KB
```

<details>
<summary><b>How the register / rho trick works (deep dive)</b></summary>

A uniformly random hash makes the leftmost-1 position `rho` geometrically distributed: `rho = 1` half the time, `2` a quarter, `3` an eighth. Across `m` registers, the maximum `rho` seen grows like `log2(n/m)` -- so `2^(max rho)` tracks the cardinality, with standard error `1.04/sqrt(m)`. `count()` uses **Ertl's improved estimator** (2017): a single **table-free** formula (`alpha_inf * m^2 / z`, where `z` folds the register value histogram through two self-terminating correction series, `sigma` for the empty-register / low-cardinality end and `tau` for the saturated / high-cardinality end). It is accurate across the *whole* range -- no range-switching, and crucially **no HyperLogLog++ empirical bias tables** (thousands of published constants). The registers are one byte each because `rho` never exceeds `64 - p + 1`. Merging two sketches is just the register-wise max -- which is why HLL is trivially parallel / distributed.

The estimator (`count()`) is O(m) and runs only when you ask; `add()` touches exactly one register.
</details>

## CountMinSketch

Count *how many times* you have seen a key, in a fixed `d x w` matrix of counters -- no matter how many distinct keys the stream carries. Each key hashes to one column per row; `add` bumps those `d` cells; `estimate` returns their **minimum**. Since collisions only ever add, the min is a one-sided over-estimate: `estimate(key) >= true count`, and it exceeds the truth by more than `epsilon * N` (N = total added) with probability at most `delta`.

```js
import { CountMinSketch } from '@zakkster/lite-sketch';

// Size it to a target accuracy: within 0.1% of N, 99% of the time.
const cms = CountMinSketch.withAccuracy(0.001, 0.01);   // -> d=5 rows, w=4096 cols (~80 KB)

for (const ev of events) cms.add(ev.userId);            // numeric keys; 0 bytes/op
cms.estimate(someUser);                                 // >= the true count, over by <= epsilon*N w.p. 1-delta
cms.epsilon;  // 0.00066  (e / w -- the achieved additive-error fraction)
cms.total;    // N -- the exact number of adds
```

Conservative update (Estan-Varghese) is **on by default**: an `add` raises the `d` cells only up to `min(cells) + count`, never higher. It cannot change the min-query answer, but it provably tightens the over-estimate on skewed (Zipfian) streams -- the usual shape of real frequency data. Pass `{ conservative: false }` for the classic plain-add matrix, which is *linearly mergeable* (needed for exact map/reduce).

```js
// Map/reduce frequency: plain mode merges EXACTLY (conservative merges as an upper bound).
const shard = () => new CountMinSketch(5, 4096, { conservative: false });
const total = shards
    .map(rows => { const c = shard(); for (const r of rows) c.add(r.key); return c; })
    .reduce((acc, c) => acc.merge(c), shard());          // element-wise saturating add, equal-d/w/seed-or-throw
total.estimate(k);                                       // same answer as one sketch over the whole stream
```

<details>
<summary><b>Why the min is the right answer, and the accuracy/space trade (deep dive)</b></summary>

Every counter a key touches is `true count + (collisions from other keys)`. Collisions are non-negative, so *every* cell is an over-estimate and the smallest one is the tightest -- that is why `estimate` takes the min, and why it can never undercount. The Cormode-Muthukrishnan bound sets the geometry: `w = ceil(e / epsilon)` columns cap the expected collision mass at `epsilon * N` per row, and `d = ceil(ln(1/delta))` independent rows drive the probability that *all* rows are unlucky down to `delta`. `withAccuracy(epsilon, delta)` inverts that; the raw `new CountMinSketch(d, w)` gives you the dial directly (`w` rounds up to a power of two so a column is a single `& (w-1)` mask). Memory is a flat `d * w * 4` bytes regardless of how many distinct keys arrive -- against an exact `Map` whose footprint grows with the distinct count. Counters saturate at `2^32 - 1` rather than wrapping (a wrap would break the min's monotonicity). The accuracy witness gates the measured over-estimate against `epsilon * N` on a Zipfian stream, and confirms conservative <= plain, on every release.
</details>

## API reference

```js
new HyperLogLog(p = 14, seed?)   // p in [4, 18]; m = 2^p registers. Throws [lite-sketch] on a bad p BEFORE allocating.

hll.add(key) -> this             // HOT, O(1), 0 B/op. Hash a numeric key + record its register. Throws on a non-number key.
hll.addHashed(hi, lo) -> this    // HOT, O(1), 0 B/op. Pre-hashed fast path: two uint32 lanes you hashed yourself.
hll.count() -> number            // COLD, O(m). Estimated distinct count (Ertl's improved estimator -- table-free, full-range).
hll.merge(other) -> this         // Register-wise max into this. Throws [lite-sketch] on a non-HLL or unequal m.
hll.clear() -> this              // Zero the registers; reuse the same allocation.
hll.p -> number                  // the precision p (getter)
hll.m -> number                  // register count, 2^p (getter)
hll.standardError -> number      // 1.04 / sqrt(m) -- the theoretical relative standard error (getter)
```

| p  | m = 2^p | memory  | standard error (1.04/sqrt(m)) |
|----|---------|---------|-------------------------------|
| 10 | 1024    | ~1 KB   | ~3.25%                        |
| 12 | 4096    | ~4 KB   | ~1.63%                        |
| 14 | 16384   | ~16 KB  | ~0.81%                        |
| 16 | 65536   | ~64 KB  | ~0.41%                        |

Error roughly halves each time `p` rises by 2 (`m` quadruples) -- the space/accuracy dial.

```js
new CountMinSketch(d, w, options?)                     // d in [1,32]; w rounds up to a power of two, <= 2^25; d*w <= 2^31.
CountMinSketch.withAccuracy(epsilon, delta, options?)  // w = ceil(e/epsilon) (pow2), d = ceil(ln 1/delta). epsilon, delta in (0,1).
// options: { seed?, conservative = true }             // an unknown option key throws [lite-sketch] with a did-you-mean hint.

cms.add(key, count = 1) -> this          // HOT, O(d), 0 B/op. Increment the d cells (conservative or plain). Throws on a bad key/count.
cms.addHashed(hi, lo, count = 1) -> this // HOT, O(d), 0 B/op. Pre-hashed fast path: two uint32 lanes you hashed yourself.
cms.estimate(key) -> number              // HOT, O(d), 0 B/op. The min of the d cells (one-sided over-estimate). NEVER throws (bad key -> 0).
cms.estimateHashed(hi, lo) -> number     // HOT, O(d), 0 B/op. Query form of the pre-hashed path (bad lane -> 0).
cms.merge(other) -> this                 // Element-wise saturating add. Throws [lite-sketch] on a non-CMS or mismatched d/w/seed.
cms.clear() -> this                      // Zero the counters + running total; reuse the allocation.
cms.d / cms.w / cms.seed                 // the frozen shape + hash seed (getters)
cms.conservative -> boolean              // whether conservative update is on (getter)
cms.total -> number                      // the exact running sum N of all added counts (getter)
cms.epsilon -> number                    // e / w -- the theoretical additive-error fraction (getter)
cms.delta -> number                      // e^-d -- the theoretical failure probability (getter)

VERSION -> string                        // '0.2.0'
```

| epsilon | w = next pow2 >= e/epsilon | delta | d = ceil(ln 1/delta) | memory (d*w*4) |
|---------|----------------------------|-------|----------------------|----------------|
| 0.01    | 512                        | 0.01  | 5                    | ~10 KB         |
| 0.001   | 4096                       | 0.01  | 5                    | ~80 KB         |
| 0.001   | 4096                       | 0.001 | 7                    | ~112 KB        |
| 0.0001  | 32768                      | 0.001 | 7                    | ~896 KB        |

More columns `w` shrink the error `epsilon`; more rows `d` shrink the failure probability `delta` -- the two independent dials, at `d * w * 4` bytes.

## Composability

Sketches are mergeable and hash-agnostic, so they fan out and back in:

```js
import { HyperLogLog } from '@zakkster/lite-sketch';

// Map/reduce distinct-count: each shard sketches its slice; the reducer merges.
function shardSketch(rows) {
    const hll = new HyperLogLog(14);
    for (const r of rows) hll.add(r.userId);   // or addHashed(hi, lo) if the row already carries a hash
    return hll;
}
const total = shards.map(shardSketch).reduce((acc, s) => acc.merge(s), new HyperLogLog(14));
total.count();   // distinct users across every shard, in fixed 16 KB per sketch
```

## Zero-GC design notes

<details>
<summary><b>Allocation table + the accuracy contract</b></summary>

Every hot op allocates **0 bytes** after construction; the only allocator is the constructor.

| Operation                   | Allocations |
| --------------------------- | ----------- |
| `add(key)`                  | **0** (one two-lane mix into module-scope slots + one register load/compare/store) |
| `addHashed(hi, lo)`         | **0** (skips the mix; the pre-hashed fast path) |
| `count()`                   | **0** (an O(m) scan over the register array; a disclosed co-headline, not per-add) |
| `merge(other)`              | **0** (register-wise max in place) |
| `clear()`                   | **0** (`fill(0)` over the reused array) |
| `p` / `m` / `standardError` | **0** (O(1) getters) |
| `new HyperLogLog(p)`        | once, at construction (one `Uint8Array(2^p)`) |

CountMinSketch is the same discipline: `add` / `addHashed` / `estimate` are **0 B/op** (the murmur is inlined into int32 locals and the `d` chosen cell indices are staged in a pre-allocated `Int32Array(d)` scratch, so even conservative update's two passes allocate nothing); `merge` / `clear` are in-place; only the constructor allocates (one `Uint32Array(d * w)`). The torture gate proves all of it.

**The hash (ADR 0001).** Zero-dep means the package ships its own hash, and accuracy proofs assume it is good. `lite-sketch` ships a two-lane 64-bit-quality non-crypto mix (`Math.imul`, no BigInt -- BigInt allocates), returned through module-scope lane slots so `add` allocates nothing. HLL reads both lanes for `rho`, so its bit-depth does not cap at high cardinality. The **avalanche property** -- a 1-bit input flip flips ~half the output bits -- is a shipped test.

**The accuracy witness.** The torture gate proves `add` at **0 B/op**; the accuracy witness proves the *number* is right: it drives the sketch on a stream with an exact `Set` oracle, measures the relative error across an N-sweep, and gates it against `~1.5 * 1.04/sqrt(m)` (p99 within ~3 sigma, error halving as `p += 2`), printing MEASURED vs THEORETICAL side by side. The `Set` foil's memory grows O(distinct) while HLL stays a fixed `m` bytes -- the space half of the co-headline.
</details>

## Design decisions worth knowing

- **Accuracy is a co-headline, stated honestly.** Every member states space AND error AND whether the error is one-sided or two-sided, statistical or hard. HLL's is a *statistical* two-sided `~1.04/sqrt(m)`; CountMinSketch's is a *one-sided* over-estimate bounded by `epsilon * N` with probability `1 - delta`.
- **Conservative update by default (CountMinSketch).** It cannot change the min-query answer, only tighten it, so it is a free accuracy win on skewed streams -- the default. The one cost is that it is not linearly mergeable, so plain mode stays available for exact map/reduce (an explicit `{ conservative: false }`).
- **Numeric-key core.** `add` hashes a number; strings/objects are the caller's to hash (or use `addHashed` with two lanes). The zero-GC law forbids retaining references.
- **Dense registers only.** A sparse representation is more accurate at tiny cardinality but allocates; it is deferred. The dense `Uint8Array` is the zero-GC reference.
- **Fail closed.** A bad `p` throws `[lite-sketch]` before the register array is allocated; `add` rejects a non-number key; queries never throw. Null is not zero.
- **Distinct classes, not one surface.** Sketches answer different questions (count vs frequency vs quantile vs top-k), so each ships as its own class over a shared hash + witness harness.

## Testing

`node:test` only, zero test deps beyond the leak + GC profilers. Run the full gate with `npm run verify`:

- `npm test` -- behavioral + fail-closed suites, plus the hash avalanche/determinism test.
- `npm run witness` -- the accuracy witness (measured error vs the theoretical bound).
- `npm run torture` -- the `0 B/op` leak + GC-profiler gate on `add` (`node --expose-gc`).
- `npm run test:perf` -- flat-throughput perf gate + a must-allocate control that the gate catches.

## What this is not

- **Not exact.** A sketch trades bounded error for fixed memory. Need an exact distinct count and can afford the memory? Use a `Set` (or `@zakkster/lite-o1`'s structures for exact O(1) work).
- **Not membership.** "Is `x` in the set?" is a filter's job -- see `@zakkster/lite-filter`.
- **Not cryptographic.** The shipped hash is a fast non-crypto mix; uniformity is statistical, not adversarial. Draw from `crypto` for adversarial inputs.
- **Not a key -> value store, and not enumerable.** CountMinSketch stores counts, not keys: there is no `forEach` / iterator, because the key set is not recoverable. It answers "how many times key `x`?", not "which keys?" -- for the top-k keys themselves, SpaceSaving is on the roadmap.
- **Not (yet) quantile / top-k.** DDSketch (quantiles) and SpaceSaving (heavy hitters) are on the roadmap to 1.0.0.

## Ecosystem

Part of the `@zakkster/lite-*` suite of zero-GC, single-file, zero-dependency micro-libraries:

- **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** -- exact O(1) data structures that witness their constant.
- **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** -- approximate membership (Bloom / cuckoo / ...), measured vs theoretical FPR.
- **@zakkster/lite-sketch** -- approximate streaming summaries (this package).

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
