# lite-sketch Research Notes

Blueprint: modeled on `../LiteO1/RESEARCH.md` (the O(1) family) and the honesty
discipline of `../LiteFilter` (the approximate-membership family). Same spine:
identity, the analytical anchor, the benchmark, the roster, the honesty hook, the
sibling boundaries, a reference member, the central design call, the demo, the path,
the open questions. ASCII-only (`->`, `<=`, `x`, "approx" -- never Unicode).

Status: PROPOSED / user-approved 2026-09-22, greenlit 2026-09-23. Not yet coded.
This document + ROADMAP.md are the pre-code research pass, to be read and settled
before the first member session.

---

## 1. Core Identity

`@zakkster/lite-sketch` is a zero-GC, zero-runtime-dependency, single-file ESM family
of APPROXIMATE, sublinear-space streaming SUMMARIES -- one small structure per
statistical question you cannot afford to answer exactly over an unbounded stream:

- **How many DISTINCT items?** (cardinality) -- HyperLogLog.
- **How OFTEN did this key occur?** (frequency / point query) -- Count-Min Sketch.
- **What is the p50 / p99?** (quantiles) -- DDSketch.
- **Which few keys dominate?** (heavy hitters / top-k) -- Space-Saving.
- **How SIMILAR are two sets?** (Jaccard) / a second cardinality estimator -- KMV / MinHash.

Each member trades a small, DISCLOSED, provable error for a huge space win: a few KB
answers a question that an exact structure would need O(distinct keys) memory to answer.
Every hot op (`add` / `update` / `estimate` / `query`) is worst-case O(1) and allocates
ZERO bytes after construction, over flat TypedArray registers -- the lite-o1 zero-GC
discipline, carried into the approximate world.

### The honest unifying thread

The suite already has two honesty anchors that are the SAME idea in two domains:
- **lite-o1** witnesses its COMPLEXITY: a flat throughput (ops/ms) line vs a foil that
  curves away -- "the constant is real."
- **lite-filter** witnesses its ACCURACY: the measured false-positive rate on YOUR keys
  vs the paper's theoretical FPR formula -- "the error bound is real."

lite-sketch is lite-filter's twin one axis over. Where lite-filter answers "is x in the
set?" with a bounded FALSE-POSITIVE RATE, lite-sketch answers "how many / how often /
which / what percentile?" with a bounded RELATIVE ERROR. So its analytical anchor is the
same shape as lite-filter's: **measured error vs the theoretical bound**, checked on a
real stream, plus the zero-GC 0-B/op proof lite-o1 pioneered. Two claims per member, both
witnessed: the space/accuracy contract (the paper's bound holds on your data) AND the
allocation contract (0 B/op on the hot path).

This is the gap in the family. lite-filter is FROZEN at membership (7 members, complete at
1.0.0). lite-o1 is EXACT O(1). Neither is the home for a cardinality/frequency/quantile
summary. lite-sketch is.

---

## 2. The Analytical Anchor: The Accuracy Witness (measured error vs theory)

### Why it belongs in the project

A sketch that only prints an estimate is a black box. The project's discipline is to make
the guarantee LEGIBLE: run the member on a real stream where the truth is known, and show
the measured error landing INSIDE the paper's bound -- and SHRINKING as you spend more
space. That is the lite-filter "measured vs theoretical FPR" move, generalized: every
sketch paper ships an error formula; the witness checks the formula on your data.

### The witness, precisely (`test/witness.mjs`)

For each member, over a sweep of stream sizes N (and, where relevant, space budgets):
1. Drive the sketch with a stream whose ground truth is computed exactly by a naive oracle
   (a real Set for distinct-count, a Map for frequency, a sorted array for quantiles).
2. Measure the member's error against the oracle:
   - HyperLogLog: relative cardinality error `|est - N| / N`.
   - Count-Min: the overestimate `est(k) - true(k)` (one-sided; never underestimates).
   - DDSketch: the relative quantile error `|q_est - q_true| / q_true`.
   - Space-Saving: recall of the true top-k + the bounded overestimate.
3. GATE it against the theoretical bound with an honest safety factor:
   - HLL standard error is `1.04 / sqrt(m)` (m = 2^p registers). Gate: the RMS relative
     error over the sweep stays `<= C * 1.04/sqrt(m)` for a small constant C (~1.5), and
     the p99 single-run error stays within ~3 sigma.
   - Count-Min additive error is `epsilon * ||f||_1` with `epsilon = e/w` at failure prob
     `delta = e^-d`. Gate: measured overestimate `<= epsilon * N` on all but a `delta`
     fraction of keys.
   - DDSketch relative accuracy is `alpha` by construction. Gate: EVERY quantile error
     `<= alpha` (it is a hard guarantee, not statistical -- a violation is a real bug).
4. Show error SHRINKING as space grows (p, w, alpha-bins up -> error down): the
   accuracy/space Pareto, the sketch analog of lite-o1's "flat as n grows" curve.

The foil (making the shape legible): the EXACT oracle itself. Its memory grows O(distinct
keys) while the sketch's is FIXED -- so the witness prints, alongside the error, the space
the exact answer would have cost (the oracle's live footprint) vs the sketch's constant KB.
The teaching image is "same answer, 1/1000th the memory, disclosed error."

### The zero-GC witness (`test/torture.mjs`)

Unchanged from lite-o1: `node --expose-gc test/torture.mjs` drives each member's hot ops in
a tight loop under @zakkster/lite-leak + @zakkster/lite-gc-profiler and asserts 0 B/op and
0 retained growth. A sketch that allocates per `add` is disqualified no matter how accurate.

---

## 3. The Benchmark Suite (the ecosystem MVP)

Fork the lite-o1 / lite-filter bench chassis. The measurement dimensions for a sketch family
differ from O(1)'s throughput matrix -- they are ACCURACY-first:

1. **Error vs space** -- measured error at each space budget (the headline curve).
2. **Error vs stream size N** -- does the bound hold as the stream grows / saturates?
3. **Error vs skew** -- uniform vs Zipfian keys (heavy hitters and Count-Min care a lot).
4. **Throughput** -- ops/ms of `add` and of `estimate` (must stay flat -- the O(1) claim).
5. **Space** -- bytes per member vs the exact oracle's footprint at the same N.
6. **Merge** -- error and cost of merging k partial sketches (the distributed/parallel win).
7. **0 B/op** -- the allocation dimension, shared with lite-o1.

The bench reports MEASURED vs THEORETICAL side by side (the lite-filter table shape), so a
reader sees the paper's promise met on their own data.

---

## 4. The Candidate Roster (all candidates)

### Tier 1 -- core roster (the members to ship, in order)

| Member | Question | Bound | Substrate | Notes |
|--------|----------|-------|-----------|-------|
| **HyperLogLog** | distinct count (cardinality) | ~1.04/sqrt(m) std err | `Uint8Array(m)` registers, m=2^p | The FLAGSHIP + reference member. Defines the accuracy witness. Dense registers (sparse rep deferred -- it allocates). HLL++ small-range bias correction. `add(hash)` / `count()` / `merge()`. |
| **CountMinSketch** | frequency / point query | `epsilon=e/w`, `delta=e^-d` | `Uint32Array(d*w)` counter matrix | One-sided (overestimate only). Conservative-update variant lowers error. `add(key,c)` / `estimate(key)` / `merge()`. The Count-Min is to lite-sketch what Bloom is to lite-filter -- the honest floor. |
| **DDSketch** | quantiles (p50/p90/p99) | relative error `<= alpha` (HARD) | fixed-range dense `Int32Array` log-buckets | Datadog's relative-error quantile sketch. Fixed value range for zero-GC (bounded bins, collapse the tail); unbounded-range is a disclosed trade. `add(value)` / `quantile(q)` / `merge()`. |
| **SpaceSaving** | heavy hitters / top-k | overestimate `<= min-counter` | k counters over a FreqO1-style bucket forest | Stream-Summary: on a full miss, evict the min, inherit its count+1. Deterministic-approximate. REUSES lite-o1 FreqO1 / BucketQueue intrusive-bucket idiom by DESIGN-PARITY (never a runtime dep). `add(key)` / `topK()` / `estimate(key)`. |

### Tier 2 -- strong candidates (next releases)

| Member | Question | Notes |
|--------|----------|-------|
| **KMV / MinHash** | 2nd cardinality estimator + set SIMILARITY (Jaccard) | k-minimum-values over a fixed `Float64Array(k)` bottom-k; MinHash gives Jaccard by matching-min fraction. Mergeable, good for set ops. |
| **CountSketch** | frequency with SIGNED estimates (L2 / unbiased) | Count-Min's unbiased cousin (median of signed counters); better for large-magnitude keys, supports subtraction. |
| **HeavyKeeper** | top-k, lower error on SKEWED streams | probabilistic exponential decay; a stronger heavy-hitter for Zipfian data than Space-Saving. |
| **ExponentialHistogram / SlidingHLL** | cardinality / counts over a SLIDING WINDOW | the streaming-window variant; pairs with lite-o1 WindowFold's exact windowing. |

### Tier 3 -- adjacent / evaluate

- **t-digest** (quantiles): the DDSketch alternative. Clustered-centroid; MORE accurate in the
  tails but its centroid merge is allocation-heavy and the accuracy is not a hard bound. Ship
  DDSketch first (hard relative-error bound + zero-GC dense bins); note t-digest as a trade.
- **Bloom / Cuckoo / XOR filters** -> NOT lite-sketch. Approximate MEMBERSHIP is `@zakkster/lite-filter`
  (complete at 1.0.0). The line is sharp: membership -> lite-filter; counting/ranking -> lite-sketch.

### The boundary -- what is explicitly OUT (and why)

- **Exact frequency / cardinality over a BOUNDED integer universe** -> lite-o1 (`FreqO1` is exact
  O(1) frequency; a dense `Uint32Array` histogram is exact). lite-sketch is for the UNBOUNDED /
  large key domain where exact is too big.
- **Approximate membership** -> lite-filter.
- **Caches / eviction** -> lite-lru.

### REJECTED / re-routed (recorded so they are not re-proposed)

- Bloom-family filters -> lite-filter (above).
- Reservoir sampling (Algorithm R) -> a lite-o1 candidate (exact uniform sample, worst-case O(1));
  NOT a sketch (it is exact, not an error-bounded summary). See lite-o1 RESEARCH.md deferred list.

---

## 5. The Approximation-Honesty Hook

The lite-o1 hook is amortized-honesty (a spike the witness must print). The lite-sketch hook is
ERROR-honesty: the disclosed bound is a CO-HEADLINE, never buried.

- Every member's headline is a PAIR: the space it costs AND the error it guarantees at that space.
  "16 KB, ~0.8% cardinality error" -- both numbers, always together (the SparseTable "O(1) query,
  O(n log n) build co-headline" discipline, applied to accuracy).
- One-sided vs two-sided error is stated: Count-Min NEVER underestimates (overestimate only);
  HLL is two-sided; DDSketch is a HARD relative bound; Space-Saving overestimates by `<= min`.
- Statistical vs guaranteed is stated: HLL's 1.04/sqrt(m) is a STANDARD ERROR (a distribution, gated
  at ~3 sigma), while DDSketch's alpha is a HARD per-query guarantee. The witness gates each in its
  own honest mode (statistical band vs hard ceiling).
- The hash is disclosed: accuracy assumes a good hash; the shipped hash's avalanche quality is a
  documented, tested property (see section 8), not an unstated assumption.

---

## 6. Boundaries with sibling packages (no duplication)

- **lite-filter** -- approximate MEMBERSHIP (Bloom / Cuckoo / Quotient / Xor / BinaryFuse, complete
  1.0.0). "Is x present?" with a false-positive rate. lite-sketch NEVER ships a membership filter.
- **lite-o1** -- EXACT O(1). `FreqO1` (exact bounded-universe frequency), a dense histogram (exact
  count), `RandomSet` (exact uniform sample). lite-sketch is the APPROXIMATE / unbounded-domain
  complement: Count-Min where FreqO1's universe is too large, HLL where an exact distinct-set is too big.
- **lite-lru** -- caches / eviction. Not a summary.
- **DESIGN-PARITY, never a dep** (the family law): Space-Saving reuses lite-o1's FreqO1 / BucketQueue
  intrusive-bucket min-forest IDIOM, and the shipped hash reuses lite-filter's key-mixing idiom, by
  copying the technique -- NEVER importing the package (zero runtime deps).

---

## 7. Reference Implementation: HyperLogLog (the headline member)

HyperLogLog is to lite-sketch what SparseSet is to lite-o1 and Bloom is to lite-filter: the reference
member that defines the substrate, the witness, and the honesty contract. It is the most-reached-for
sketch (distinct-count is everywhere: unique visitors, distinct IPs, cardinality in query planners).

- **Substrate**: `Uint8Array(m)`, m = 2^p registers (p in a fixed range, e.g. [4, 18]). One byte per
  register holds `rho` (position of the leftmost 1-bit, `<= 64 - p + 1 <= 61`, fits a byte).
- **add(hash)** (hot, O(1), 0 B/op): the top p bits of a 64-bit hash pick a register j; `rho` = the
  position of the leftmost 1-bit in the remaining bits; `reg[j] = max(reg[j], rho)`. One load, one
  compare, one store. No allocation.
- **count()** (O(m), a query not a per-item op): the HLL raw estimate is
  `alpha_m * m^2 / sum(2^-reg[j])`, with HLL++ bias correction in the small-cardinality range and the
  large-range correction near 2^64. O(m) is a disclosed co-headline (m is fixed, e.g. 16384), not a
  per-add cost.
- **merge(other)** (O(m)): register-wise max -- the mergeability that makes HLL distributable
  (the headline feature: partial sketches over shards combine losslessly).
- **clear()** (O(m) fill), getters `p` / `m` / `standardError`.
- **Fail closed**: a bad p at construction throws `[lite-sketch]` before allocation (typeof-first);
  `add` takes a NUMERIC hash (typeof-guarded); `count()` never throws.
- **Witness**: relative error over an N-sweep stays within ~3 sigma of `1.04/sqrt(m)`, and error
  halves as p grows by 2 (space x4 -> error /2), the accuracy/space curve.

The sparse representation (a low-cardinality space optimization) is DEFERRED: it stores a growable list
of encoded registers and thus allocates, which breaks 0 B/op. Ship DENSE HLL as the honest reference;
note the sparse trade in the ADR.

---

## 8. The Central Design Call: Hashing (the family's load-bearing decision)

A sketch is only as good as its hash -- accuracy proofs ASSUME uniform, independent hashing. Zero-dep
means the package must SHIP a hash; this is lite-sketch's equivalent of "which witness" for lite-o1.
The calls to settle at the first session (ADR 0001):

1. **Ship ONE canonical non-crypto hash** -- a well-mixed 64-bit finalizer (murmur3 fmix64 / xxhash-style
   avalanche) over an integer or byte key, with a tested avalanche property (a 1-bit input flip flips
   ~half the output bits). Members call it internally so accuracy is reproducible and self-contained.
2. **ALSO accept a pre-hashed value on the hot path** (the lite-filter `keys:'int'` fast path): a caller
   who already has a good 64-bit hash passes it directly, skipping the mix -- keeps the hot `add` at one
   store and lets the caller control hashing. Members document which they take.
3. **Independent hashes for Count-Min's d rows / MinHash's k**: derive from ONE base hash by seeded
   salting (`h_i = mix(h ^ (i * ODD_CONST))`), not d independent hash functions -- standard, cheap, and
   accuracy-preserving. The seed is per-instance (reproducibility; the RandomSet / AliasTable discipline).
4. **32- vs 64-bit**: ship a 64-bit mix; HLL needs the long hash for `rho`, Count-Min takes low bits mod w.
5. **String / object keys**: the zero-GC law forbids stored refs, but a hash may READ a string's bytes
   without retaining it. Decide: numeric-key-only core (caller hashes strings) vs a shipped string hasher
   that walks bytes alloc-free. Lean: numeric core + an optional alloc-free string-bytes hasher.

This one decision gates every member's accuracy claim -- settle it, test the avalanche, then build.

---

## 9. The Demo (later, in the style of lite-o1 / lite-filter)

A later session, once 2-3 members ship. The natural visualization: a live stream pouring in, the EXACT
oracle's memory bar climbing without bound while the sketch's stays a flat sliver, and the estimate
tracking the truth inside a shaded error band that narrows as you drag a "space" slider up. The
accuracy/space Pareto made kinetic -- the sketch analog of lite-o1's flat-line demo. Repo-only, zero-GC
frame path (same law as the lite-o1 demo).

---

## 10. Recommended Path

1. Settle the HASH (section 8, ADR 0001) FIRST -- it blocks every member.
2. **M1 HyperLogLog** (v0.1.0): the reference member; stand up the substrate, the accuracy witness, the
   torture gate, the benchmark chassis, the README blueprint. Defines what "shipped" means here.
3. **M2 CountMinSketch** (v0.2.0): the second axis (frequency), one-sided error, conservative-update.
4. **M3 DDSketch** (v0.3.0): quantiles, the HARD relative-error bound (a different witness mode).
5. **M4 SpaceSaving** (v0.4.0): heavy hitters; the FreqO1 idiom reuse.
6. **1.0.0** at four members (the lite-filter cadence: reference + 3), API declared stable. KMV / MinHash
   / CountSketch / HeavyKeeper follow post-1.0, one per release, like lite-o1's post-1.0 roster.

Each member is a full pipeline session (planner -> settle -> coder -> reviewer -> qa), user
commits/publishes, /release gate + card sync after -- identical to lite-o1.

---

## 11. Open Questions

1. **The hash** (section 8) -- the load-bearing one. Canonical mix + pre-hashed fast path; 64-bit; seeded
   row-salting; string handling. Settle at ADR 0001.
2. **One uniform surface or per-member classes?** lite-filter has a uniform `LiteFilter<K>`; lite-o1 has
   distinct classes. Sketches answer DIFFERENT questions (count vs frequency vs quantile vs top-k), so a
   single interface fits worse than lite-filter's (all membership). Lean: distinct classes (HyperLogLog,
   CountMinSketch, ...), a shared hash + witness harness -- the lite-o1 model.
3. **DDSketch value range**: fixed dense bins (zero-GC, bounded range) vs a growable bucket map
   (unbounded range, allocates). Lean: fixed-range dense bins as the zero-GC reference, unbounded noted.
4. **Merge across differently-sized sketches**: HLL merge needs equal m; Count-Min equal d,w. Fail closed
   on a shape mismatch (the BitSet same-capacity-or-throw discipline).
5. **Conservative-update Count-Min**: ship as the default, or as a variant flag? Lean: document both,
   ship conservative-update (strictly better accuracy, same space).
6. **Naming**: `HyperLogLog` vs `HLL`; `CountMinSketch` vs `CountMin`. Lean: full names (discoverable),
   as lite-o1 spells out `HierarchicalTimerWheel`.
7. **Package scope / name**: `@zakkster/lite-sketch`, folder `LiteSketch`. Confirm before the GitHub wire-up.
