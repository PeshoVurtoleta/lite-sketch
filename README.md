# @zakkster/lite-sketch

> Zero-GC approximate streaming summaries that **witness their accuracy against the paper's bound** -- starting with HyperLogLog.

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

- **HyperLogLog** -- distinct-count (cardinality) in fixed space, `~1.04/sqrt(m)` standard error, mergeable. (The reference member; CountMinSketch, DDSketch, and SpaceSaving follow, one per release, to a stable 1.0.0.)
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

VERSION -> string                // '0.1.0'
```

| p  | m = 2^p | memory  | standard error (1.04/sqrt(m)) |
|----|---------|---------|-------------------------------|
| 10 | 1024    | ~1 KB   | ~3.25%                        |
| 12 | 4096    | ~4 KB   | ~1.63%                        |
| 14 | 16384   | ~16 KB  | ~0.81%                        |
| 16 | 65536   | ~64 KB  | ~0.41%                        |

Error roughly halves each time `p` rises by 2 (`m` quadruples) -- the space/accuracy dial.

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

**The hash (ADR 0001).** Zero-dep means the package ships its own hash, and accuracy proofs assume it is good. `lite-sketch` ships a two-lane 64-bit-quality non-crypto mix (`Math.imul`, no BigInt -- BigInt allocates), returned through module-scope lane slots so `add` allocates nothing. HLL reads both lanes for `rho`, so its bit-depth does not cap at high cardinality. The **avalanche property** -- a 1-bit input flip flips ~half the output bits -- is a shipped test.

**The accuracy witness.** The torture gate proves `add` at **0 B/op**; the accuracy witness proves the *number* is right: it drives the sketch on a stream with an exact `Set` oracle, measures the relative error across an N-sweep, and gates it against `~1.5 * 1.04/sqrt(m)` (p99 within ~3 sigma, error halving as `p += 2`), printing MEASURED vs THEORETICAL side by side. The `Set` foil's memory grows O(distinct) while HLL stays a fixed `m` bytes -- the space half of the co-headline.
</details>

## Design decisions worth knowing

- **Accuracy is a co-headline, stated honestly.** Every member states space AND error AND whether the error is one-sided or two-sided, statistical or hard. HLL's is a *statistical* two-sided `~1.04/sqrt(m)`.
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
- **Not (yet) frequency / quantile / top-k.** CountMinSketch, DDSketch, and SpaceSaving are on the roadmap to 1.0.0.

## Ecosystem

Part of the `@zakkster/lite-*` suite of zero-GC, single-file, zero-dependency micro-libraries:

- **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** -- exact O(1) data structures that witness their constant.
- **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** -- approximate membership (Bloom / cuckoo / ...), measured vs theoretical FPR.
- **@zakkster/lite-sketch** -- approximate streaming summaries (this package).

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
