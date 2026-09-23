# @zakkster/lite-sketch

> Zero-GC approximate streaming summaries that **witness their accuracy against the paper's bound** -- HyperLogLog for distinct-count, CountMinSketch for frequency, DDSketch for quantiles, SpaceSaving for top-k.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-sketch.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-sketch)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-sketch?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-sketch)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-sketch?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-sketch)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-sketch?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-sketch)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

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
- [DDSketch](#ddsketch)
- [SpaceSaving](#spacesaving)
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
- **CountMinSketch** -- point-query frequency ("how many times have I seen `x`?") in a fixed `d x w` matrix, a one-sided over-estimate bounded by `epsilon * N`, with conservative update on by default and merge for map/reduce.
- **DDSketch** -- relative-error quantiles (p50/p90/p99/...) in fixed space, with a *hard* per-query guarantee `|v - v_true| <= alpha * v_true` -- the family's sharpest bound. Collapsing-lowest keeps the tail accurate; strict fixed-range is an opt-in.
- **SpaceSaving** -- heavy hitters / top-k in `k` fixed counters: every element above `N/k` frequency is reported (no false negatives), with a bracketed `[count - error, count]` on each. Completes the roster -- the four-member API is stable as of 1.0.0.
- **A shipped, avalanche-tested hash** -- a two-lane 64-bit-quality non-crypto mix, zero-alloc, with a pre-hashed fast path for callers who bring their own. (HyperLogLog and CountMinSketch use it; DDSketch bins raw values.)
- **The accuracy witness** -- measured error vs the theoretical bound, printed side by side, with the exact-`Set` foil whose memory climbs without bound.
- **Zero runtime dependencies**, ESM, tree-shakeable named exports, TypeScript types, and a **0 bytes/op hot path** proven by a leak + GC-profiler torture gate.

## HyperLogLog

Count the number of DISTINCT elements in an unbounded stream using a fixed `m = 2^p` array of one-byte registers. Each element is hashed; the top `p` bits pick a register, and the position of the leftmost 1-bit in the rest (`rho`) is recorded as a running max. The distribution of those maxima estimates the cardinality -- with standard error `1.04/sqrt(m)`, *independent of how many elements you add*.

```js
import { HyperLogLog } from '@zakkster/lite-sketch';

const a = new HyperLogLog(12);            // ~4 KB, ~1.6% std error
const b = new HyperLogLog(12);
for (const u of mondayUsers) a.add(u);    // safe-integer keys; pre-hash strings or use addHashed
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

for (const ev of events) cms.add(ev.userId);            // safe-integer keys; 0 bytes/op
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

## DDSketch

Answer "what is the p99?" over an unbounded stream in fixed space, with a **hard relative-error guarantee**: for any quantile q, the returned value v satisfies `|v - v_true| <= alpha * v_true`. Unlike HyperLogLog (statistical error) and CountMinSketch (additive error), DDSketch's bound is *per-query and worst-case* -- the sharpest promise in the family. It works by bucketing on a log scale: with `gamma = (1 + alpha) / (1 - alpha)`, a value `x > 0` lands in bucket `ceil(log_gamma x)`, and every value in that bucket is within `alpha` relative error of the bucket's representative.

```js
import { DDSketch } from '@zakkster/lite-sketch';

const lat = new DDSketch(0.01);           // 1% relative accuracy on every quantile
for (const ms of responseTimes) lat.add(ms);
lat.quantile(0.5);                        // p50, within 1% of the true median
lat.quantile(0.99);                       // p99, within 1% of the true p99 -- the number that matters
lat.max;                                  // the EXACT max (not bucketed); min/max are exact
```

`add` takes raw values (no hashing) and is 0 bytes/op; `quantile` is a cold O(bins) walk. The domain is **positive + zero** (a negative value throws -- latencies, sizes, and durations are non-negative); values are bucketed on a log scale, so the dynamic range is enormous (a single small sketch spans nanoseconds to hours). Memory is bounded by `maxBins` (default 2048): when a stream's value range would exceed the budget, DDSketch **collapses the smallest-value buckets** into the floor, which keeps the *upper* quantiles (p50/p90/p99 -- the ones you page on) within `alpha` and degrades only the smallest values. For a hard cap on the value range instead, pass `{ range: [min, max] }` for strict fixed-range mode, which throws on an out-of-range value rather than collapsing.

```js
// Distributed p99: sketch per shard, merge for the global quantile (same alpha).
const merged = shards
    .map(rows => { const s = new DDSketch(0.01); for (const r of rows) s.add(r.latency); return s; })
    .reduce((acc, s) => acc.merge(s), new DDSketch(0.01));
merged.quantile(0.99);                     // global p99 across every shard, within 1%
```

<details>
<summary><b>Why relative-error bucketing beats rank-error sketches for tails (deep dive)</b></summary>

Rank-error quantile sketches (t-digest, GK) promise the returned value is near the value at rank `q +/- epsilon` -- but at the tail, a tiny rank error can be a huge *value* error, exactly where latencies matter most. DDSketch instead fixes the *relative value* error: bucket `i` covers `(gamma^(i-1), gamma^i]`, so the representative `2 * gamma^i / (gamma + 1)` is within `alpha` of every value in the bucket, at *every* quantile equally. The bins are a dense `Float64Array` (counts exact to 2^53 -- no saturation, because a quantile needs an exact cumulative count), allocated once at `maxBins` and never re-grown: "extending" the window and "collapsing the lowest buckets" both shift counts *within* the fixed array, so `add` stays 0 bytes/op. `count` and `sum` are exact; `min` and `max` are tracked exactly (not read from a bucket). Values outside the representable double range (roughly `(~2.2e-308, ~8.9e307]` at `alpha=0.01`, the low end exclusive; the exact runtime bounds are the `minIndexable` / `maxIndexable` getters) are rejected fail-closed so a bucket representative can never overflow to `Infinity`. The accuracy witness gates the measured relative error against `alpha` at p50/p90/p99/p999 on uniform, lognormal, and pareto streams on every release.
</details>

## SpaceSaving

Find the **heavy hitters** -- the top-k most frequent keys -- of an unbounded stream in `k` fixed counters. `add(key)` increments a monitored key; when all `k` slots are full it **evicts the current minimum-count key** and hands its slot to the newcomer at `count = min + 1`, recording `error = min`. That single rule buys the guarantee that makes SpaceSaving famous: **every element whose true frequency exceeds `N/k` is monitored -- no false negatives** -- and each monitored key's true count is bracketed by `[count - error, count]`.

```js
import { SpaceSaving } from '@zakkster/lite-sketch';

const top = new SpaceSaving(1000);        // track the ~top-1000 keys in 1000 counters
for (const ev of pageViews) top.add(ev.urlId);
top.topK(10);                             // the 10 hottest URLs: [{ key, count, error }, ...] by count desc
top.estimate(someUrl);                    // its count (an upper bound); true count >= estimate - errorOf(someUrl)
top.heavyHitters(0.01);                   // every key seen in > 1% of the stream (a superset -- no true hitter missed)
```

`add` takes numeric safe-integer keys (hash your strings to integers first) and is 0 bytes/op amortized -- even the eviction path, which deletes a key from the internal map and re-files a counter, allocates nothing. It **never fails at capacity**: eviction *is* the algorithm. Size it directly with `new SpaceSaving(k)`, or by target error with `SpaceSaving.withError(epsilon)` (which picks `k = ceil(1/epsilon)`, so a monitored key's over-count is bounded by `epsilon * N`).

```js
// Distributed top-k: a summary per shard, merged (same capacity + seed).
const global = shards
    .map(rows => { const s = new SpaceSaving(1000); for (const r of rows) s.add(r.key); return s; })
    .reduce((acc, s) => acc.merge(s), new SpaceSaving(1000));
global.heavyHitters(0.005);               // global heavy hitters across every shard
```

<details>
<summary><b>Why the min-eviction rule gives a no-false-negatives guarantee (deep dive)</b></summary>

An unmonitored key can only ever have been seen fewer times than the current minimum counter `m` (if it had been seen more while monitored, it would not have been evicted below `m`). So when a new key arrives and evicts the min, giving it `count = m + 1` over-counts its true frequency by at most `m` -- which is why `error = m` brackets the truth, and why `m <= N/k` (the `k` counters sum to `N`, so their minimum is at most the average). Any key with true frequency above `N/k` therefore cannot stay evicted: it must be monitored. The min structure is an intrusive frequency-bucket forest (buckets sorted by count, each a list of counters -- the same shape as `@zakkster/lite-o1`'s `FreqO1`), so find-min and increment-to-the-next-bucket are O(1); the key->counter map is fixed open-addressing with backshift deletion. Both are preallocated once, so the hot path -- including eviction -- is 0 bytes/op. `topK` and `heavyHitters` sort and allocate a result array (cold, disclosed); `forEach` is alloc-free. There is deliberately **no `addHashed`**: a heavy-hitters sketch must keep each key's identity to return it, so there is no honest pre-hashed fast path. The witness gates 100% recall of the true hitters above `N/k`, the `[count - error, count]` bracket, and `error <= N/k` on a Zipfian stream every release.
</details>

## API reference

```js
new HyperLogLog(p = 14, seed?)   // p in [4, 18]; m = 2^p registers. Throws [lite-sketch] on a bad p BEFORE allocating.

hll.add(key) -> this             // HOT, O(1), 0 B/op. Hash a SAFE-INTEGER key (|key| <= 2^53-1) + record its register. Throws on a non-number / +-Infinity / non-integer / out-of-safe-range key.
hll.addHashed(hi, lo) -> this    // HOT, O(1), 0 B/op. Pre-hashed fast path: two uint32 lanes you hashed yourself.
hll.count() -> number            // COLD, O(m). Estimated distinct count (Ertl's improved estimator -- table-free, full-range).
hll.merge(other) -> this         // Register-wise max into this. Throws [lite-sketch] on a non-HLL or unequal m OR seed.
hll.clear() -> this              // Zero the registers; reuse the same allocation.
hll.p -> number                  // the precision p (getter)
hll.m -> number                  // register count, 2^p (getter)
hll.standardError -> number      // 1.04 / sqrt(m) -- the theoretical relative standard error (getter)
hll.seed -> number               // the uint32 hash seed (getter)
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

cms.add(key, count = 1) -> this          // HOT, O(d), 0 B/op. Hash a SAFE-INTEGER key (|key| <= 2^53-1) + increment the d cells. Throws on a non-number / +-Infinity / non-integer / out-of-safe-range key or bad count.
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
```

| epsilon | w = next pow2 >= e/epsilon | delta | d = ceil(ln 1/delta) | memory (d*w*4) |
|---------|----------------------------|-------|----------------------|----------------|
| 0.01    | 512                        | 0.01  | 5                    | ~10 KB         |
| 0.001   | 4096                       | 0.01  | 5                    | ~80 KB         |
| 0.001   | 4096                       | 0.001 | 7                    | ~112 KB        |
| 0.0001  | 32768                      | 0.001 | 7                    | ~896 KB        |

More columns `w` shrink the error `epsilon`; more rows `d` shrink the failure probability `delta` -- the two independent dials, at `d * w * 4` bytes.

```js
new DDSketch(alpha, options?)            // alpha in (0,1) = relative accuracy. options: { maxBins = 2048, range?: [min, max] }.
                                         //   Throws [lite-sketch] on a bad alpha/maxBins/range BEFORE allocating. range present = strict fixed-range.

dd.add(value, count = 1) -> this         // HOT, O(1), 0 B/op. Bucket a finite value (x=0 -> zero counter). Throws on x<0, non-finite,
                                         //   out-of-indexable-range, or a bad count -- a byte-identical no-op.
dd.addFrom(buf, i) -> this               // HOT, O(1), 0 B/op. Add buf[i] (count=1) read UNBOXED from a Float64Array -- the zero-box entry
                                         //   point for a FRACTIONAL value (add(fractionalDouble) boxes its argument ~16 B/call when not inlined).
                                         //   Same validation as add; throws on a bad buf / index or a value add would reject.
dd.quantile(q) -> number                 // COLD, O(bins). The q-quantile (q in [0,1]) within alpha relative error. NEVER throws (empty/bad q -> NaN).
dd.merge(other) -> this                  // Fold other in (collapsing as needed). Throws [lite-sketch] on a non-DDSketch or unequal alpha.
dd.clear() -> this                       // Zero the bins + all scalars; reuse the allocation.
dd.alpha -> number                       // the relative-accuracy knob (getter)
dd.count -> number                       // exact element count N (getter)
dd.sum -> number                         // exact sum of all added values (getter)
dd.min / dd.max -> number                // the EXACT min / max (not bucketed; NaN when empty) (getters)
dd.zeroCount -> number                   // exact count of zero values (getter)
dd.maxBins -> number                     // the bin capacity (getter)
dd.numBins -> number                     // the live (populated) bin count (getter)
dd.collapsed -> boolean                  // whether any smallest-value collapse has happened (getter)
dd.strict -> boolean                     // whether this is a STRICT fixed-range sketch (a range was given) (getter)
dd.minIndexable / dd.maxIndexable        // the EXACT x bounds add() accepts: finite minIndexable < x <= maxIndexable (plus 0). ~2.2e-308 / ~8.9e307 at alpha=0.01 (getters)
dd.rangeMin / dd.rangeMax                // STRICT mode: the configured range ends (NaN if not strict) (getters)
```

| alpha | gamma = (1+a)/(1-a) | guarantee                 | memory (maxBins=2048) |
|-------|---------------------|---------------------------|-----------------------|
| 0.02  | ~1.041              | every quantile within 2%  | ~16 KB (fixed)        |
| 0.01  | ~1.020              | every quantile within 1%  | ~16 KB (fixed)        |
| 0.005 | ~1.010              | every quantile within 0.5%| ~16 KB (fixed)        |

Smaller `alpha` -> finer buckets -> more bins used for a given value range (raise `maxBins` to avoid collapsing the smallest values); the guarantee holds at *every* quantile equally, and `min`/`max` are always exact.

```js
new SpaceSaving(capacity, options?)      // capacity = k monitored counters, integer in [1, 2^24]. options: { seed? }.
SpaceSaving.withError(epsilon, options?) // k = ceil(1/epsilon); a monitored key's over-count is then <= epsilon*N. epsilon in (0,1).

ss.add(key, count = 1) -> this           // HOT, O(1) amortized, 0 B/op. Increment / insert / evict-min. Throws on a non-safe-integer key or bad count.
ss.estimate(key) -> number               // HOT, O(1). Monitored count (an upper bound), or 0. NEVER throws.
ss.errorOf(key) -> number                // HOT, O(1). Over-count bound (true is in [estimate - errorOf, estimate]), or 0. NEVER throws.
ss.forEach(fn) -> void                   // Alloc-free walk (storage order): fn(key, count, error, ss).
ss.topK(n = size) -> Array<{key,count,error}>   // Top n by count DESC. COLD, allocates. NEVER throws.
ss.heavyHitters(threshold) -> Array<{key,count,error}>  // count > threshold*total -- a SUPERSET, no false negatives. COLD, allocates.
ss.merge(other) -> this                  // Union + keep top-k. Throws [lite-sketch] on a non-SpaceSaving or unequal capacity/seed.
ss.clear() -> this                       // Drop all monitored keys; reuse the pools.
ss.capacity / ss.size / ss.total         // k; monitored count (<= k); exact running sum N (getters)
ss.epsilon -> number                     // 1 / capacity -- the theoretical error fraction (getter)
ss.seed -> number                        // the uint32 hash seed (getter)
// NOTE: SpaceSaving has NO addHashed -- it stores key identities, so there is no pre-hashed fast path.

VERSION -> string                        // '1.1.2'
```

| capacity k | guaranteed to report | over-count bound | memory        |
|------------|----------------------|------------------|---------------|
| 100        | freq > N/100 (1%)    | <= N/100         | ~100 counters |
| 1000       | freq > N/1000 (0.1%) | <= N/1000        | ~1000 counters|
| 10000      | freq > N/1e4 (0.01%) | <= N/1e4         | ~1e4 counters |

A larger `k` catches rarer hitters and tightens the over-count -- at `k` fixed counters, regardless of how many distinct keys the stream carries.

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
| `p` / `m` / `standardError` / `seed` | **0** (O(1) getters) |
| `new HyperLogLog(p)`        | once, at construction (one `Uint8Array(2^p)`) |

CountMinSketch is the same discipline: `add` / `addHashed` / `estimate` are **0 B/op** (the murmur is inlined into int32 locals and the `d` chosen cell indices are staged in a pre-allocated `Int32Array(d)` scratch, so even conservative update's two passes allocate nothing); `merge` / `clear` are in-place; only the constructor allocates (one `Uint32Array(d * w)`). The torture gate proves all of it.

DDSketch too: `add` is **0 B/op** -- the log-scale key is a transient double (never stored to the heap), the bin array is a single `Float64Array(maxBins)` allocated once and never re-grown, and both window-extend and lowest-bucket-collapse shift counts *within* that fixed array (a `copyWithin`, no allocation). `quantile` / `merge` / `clear` are cold in-place walks. The torture gate proves `add` at 0 B/op even after collapse.

SpaceSaving is the hardest case and still **0 B/op** on `add` -- including the eviction path (delete the min key from the open-addressing map by backshift, reassign its counter, re-file it in the bucket forest to a new count) touches only preallocated typed-array pools + a free-list, never the heap. The torture gate measures `add` at 0 B/op at steady-state-full, where *every* op evicts. Only `topK` / `heavyHitters` / `merge` allocate (cold, disclosed).

**The hash (ADR 0001).** Zero-dep means the package ships its own hash, and accuracy proofs assume it is good. `lite-sketch` ships a two-lane 64-bit-quality non-crypto mix (`Math.imul`, no BigInt -- BigInt allocates), returned through module-scope lane slots so `add` allocates nothing. HLL reads both lanes for `rho`, so its bit-depth does not cap at high cardinality. The **avalanche property** -- a 1-bit input flip flips ~half the output bits -- is a shipped test.

**The accuracy witness.** The torture gate proves `add` at **0 B/op**; the accuracy witness proves the *number* is right: it drives the sketch on a stream with an exact `Set` oracle, measures the relative error across an N-sweep, and gates it against `~1.5 * 1.04/sqrt(m)` (p99 within ~3 sigma, error halving as `p += 2`), printing MEASURED vs THEORETICAL side by side. The `Set` foil's memory grows O(distinct) while HLL stays a fixed `m` bytes -- the space half of the co-headline.
</details>

## Design decisions worth knowing

- **Accuracy is a co-headline, stated honestly.** Every member states space AND error AND whether the error is one-sided or two-sided, statistical or hard. HLL's is a *statistical* two-sided `~1.04/sqrt(m)`; CountMinSketch's is a *one-sided* over-estimate bounded by `epsilon * N` with probability `1 - delta`; DDSketch's is a *hard per-query* relative bound `|v - v_true| <= alpha * v_true` -- three different guarantee shapes, each named for what it actually is.
- **Collapsing-lowest protects the tail (DDSketch).** When memory is tight the smallest-value buckets collapse, never the largest -- because p99, not p1, is what you page on. The degradation is disclosed (the smallest values may exceed `alpha`); strict fixed-range mode trades the unbounded range for a hard fail-closed door instead.
- **Eviction is the algorithm, not a failure (SpaceSaving).** Unlike the fixed-capacity structures in `@zakkster/lite-o1`, SpaceSaving never throws at capacity -- it evicts the minimum, and that eviction is exactly what yields the no-false-negatives guarantee. It reports a *superset* (every true hitter, maybe a few extra) because that is the honest shape of the guarantee; the exact-subset filter is one subtraction away.
- **Conservative update by default (CountMinSketch).** It cannot change the min-query answer, only tighten it, so it is a free accuracy win on skewed streams -- the default. The one cost is that it is not linearly mergeable, so plain mode stays available for exact map/reduce (an explicit `{ conservative: false }`).
- **Safe-integer key domain (fail closed on collisions).** `add` hashes a *safe integer* (`|key| <= 2^53 - 1`); strings/objects are the caller's to hash (or use `addHashed` with two lanes). The zero-GC law forbids retaining references. The hot body distinguishes the full magnitude -- the low 32-bit word, the high word, and the sign -- so the entire safe-integer range is accepted with no silent aliasing; every member (HyperLogLog, CountMinSketch, SpaceSaving) shares this domain. A non-integer, a `+-Infinity`, or an out-of-safe-range key would truncate or alias under the `>>> 0` step, so all three fail closed with a `[lite-sketch]` throw (a byte-identical no-op on the cold branch) rather than silently colliding.
- **Dense registers only.** A sparse representation is more accurate at tiny cardinality but allocates; it is deferred. The dense `Uint8Array` is the zero-GC reference.
- **Fail closed.** A bad `p` throws `[lite-sketch]` before the register array is allocated; `add` rejects a non-number / `+-Infinity` / non-integer / out-of-safe-range key; queries never throw. Null is not zero.
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
- **Not a key -> value store, and not enumerable.** CountMinSketch stores counts, not keys: there is no `forEach` / iterator, because the key set is not recoverable. It answers "how many times key `x`?", not "which keys?" -- for the top-k keys themselves, use SpaceSaving.
- **DDSketch is positive + zero only, and range-bounded.** A negative value throws (latencies/sizes/durations are non-negative -- a signed sketch is deferred); so do values outside the representable double range. Its `quantile` is relative-error approximate (use `min`/`max` for the exact extremes), and under collapsing the *smallest* values can exceed `alpha` (the tail stays within it).
- **SpaceSaving reports a superset, over-counts, and needs numeric keys.** `heavyHitters` never misses a true hitter but may include a few false positives (filter by `count - error` for the guaranteed subset); a monitored `count` is an upper bound, not exact. Keys are numeric safe integers -- hash strings to integers yourself. It has no `addHashed` (it must retain key identity).

## Ecosystem

Part of the `@zakkster/lite-*` suite of zero-GC, single-file, zero-dependency micro-libraries:

- **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** -- exact O(1) data structures that witness their constant.
- **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** -- approximate membership (Bloom / cuckoo / ...), measured vs theoretical FPR.
- **@zakkster/lite-sketch** -- approximate streaming summaries (this package).

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
