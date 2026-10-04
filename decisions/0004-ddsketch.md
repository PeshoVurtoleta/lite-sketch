# 0004 -- DDSketch: the quantile member (log-scale bins, collapsing-lowest default + strict opt-in, positive+zero domain)

Status: accepted (v0.3.0)

## Context

DDSketch (Masson, Rim & Lee, "DDSketch: A Fast and Fully-Mergeable Quantile Sketch
with Relative-Error Guarantees", Datadog, VLDB 2019) estimates quantiles of an
unbounded stream in fixed space with a HARD per-query relative-error guarantee:
for any quantile q, the returned value v obeys `|v - v_true| <= alpha * v_true`.
It is lite-sketch's third member (M3) and the QUANTILE corner of the family. It is
also the honesty anchor's sharpest case: HyperLogLog's error is STATISTICAL
(1.04/sqrt(m)), CountMinSketch's is ADDITIVE (epsilon*N with probability 1-delta),
and DDSketch's is a WORST-CASE per-query RELATIVE bound. It is the first member that
does NOT use the two-lane hash (ADR 0001) -- it bins raw values on a log scale.

Mechanism: with `gamma = (1+alpha)/(1-alpha)`, a value x>0 lands in bucket
`key(x) = ceil(ln(x)/ln(gamma))`; every value in bucket i lies in
`(gamma^(i-1), gamma^i]`, so the representative `2*gamma^i/(gamma+1)` is within alpha
relative error of all of them. `add` is O(1) (one log + one bin increment);
`quantile(q)` is a cold O(bins) cumulative walk.

## The settled calls (user-accepted 2026-09-23)

1. **Bin store = BOTH strategies (user chose "Both").**
   - DEFAULT collapsing-lowest: a dense `Float64Array(maxBins)` (default 2048). Key K
     maps to physical index `K - _offset`; the array represents keys
     `[_offset, _offset + maxBins - 1]`. When a new bucket would exceed the budget, the
     SMALLEST-value buckets collapse into the floor bin (their counts summed into bin 0)
     -- unbounded value range, bounded memory, the guarantee PRESERVED for the UPPER
     quantiles (p50/p90/p99) and degraded only for the smallest values (a disclosed
     co-headline; `collapsed` reports whether it has happened). RATIONALE: for latency /
     size / duration streams the tail (p99) is what matters; collapsing-lowest never
     touches it. Collapsing-HIGHEST would degrade the tail -- rejected.
   - STRICT fixed-range OPT-IN: `new DDSketch(alpha, { range: [min, max] })` sizes the
     bins to exactly `[key(min), key(max)]`; a value outside the range THROWS
     `[lite-sketch]` (never collapses). For callers who know their range and want a hard
     fail-closed door instead of silent small-value degradation.

2. **Value domain = POSITIVE + ZERO.** x>0 is bucketed; x===0 increments a separate
   `_zeroCount`; x<0 THROWS `[lite-sketch]` (log is undefined for non-positives). No
   negative-mirror array -- deferred to a possible future full-real-line opt-in. Covers
   the canonical uses (latencies, sizes, durations, all >= 0) at half the memory.

3. **Zero-GC: the bin array is allocated ONCE at construction and NEVER re-grown.**
   "Extend" (a new bucket still within budget) moves the logical window (`_offset`);
   "collapse" shifts counts within the fixed array (a `copyWithin` + a floor-bin fold).
   Both are 0-alloc. The common `add` path (bucket already in the window) is O(1),
   0-alloc. The per-add `Math.log` is a transient double in an expression (never stored
   to a slot), so `add` is a true 0 B/op even after collapse (the torture gate proves it).

4. **Bin counts = `Float64Array`, NOT a saturating integer type.** A quantile needs an
   EXACT cumulative count to locate the target rank; saturating (as CountMinSketch does)
   would corrupt the walk. Float64 holds counts exactly to 2^53. `_count` (N), `_sum`,
   `_zeroCount`, `_min`, `_max` are instance number fields (0-B/op `+=`).

5. **`min` / `max` are EXACT; `quantile` is alpha-approximate.** The extremes are tracked
   exactly (not read from a bucket), a free and honest upgrade over the bucketed estimate.

6. **`alpha` IS the accuracy knob** -- no `withAccuracy` factory (contrast CountMinSketch,
   whose (d, w) needed inverting from (epsilon, delta)). `quantile(q)` uses the rank
   convention `rank = floor(q * (count - 1))` and returns the bucket representative
   `2 * gamma^K / (gamma + 1)` (or 0 if the rank falls in the zero bucket).

7. **Indexable-range fail-closed door (found in review/qa, fixed).** The bucket
   representative `2 * gamma^K / (gamma + 1)` overflows to `Infinity` for values in the top
   ~6% of the double range (>= ~8.6e307 at alpha=0.01) and underflows to 0 for values
   below the smallest NORMAL double -- either would break the "quantile is a finite,
   alpha-bounded value" contract. The ctor precomputes `_minKeyIndexable` /
   `_maxKeyIndexable` (verified by a cold construction-time loop, since the naive
   `Math.log(MAX_VALUE * c)` itself overflows) and `add` rejects any value whose key is out
   of that range fail-closed (a byte-identical no-op); a strict `range` with an un-indexable
   end throws at construction.

## The accuracy contract (the honesty anchor)

The witness drives uniform + lognormal + pareto POSITIVE streams against an exact
sorted-array oracle and GATES the measured relative error `|quantile(q) - sorted[floor(q*(N-1))]|
/ sorted[...]` at q in {0.5, 0.9, 0.99, 0.999} against `alpha` (a 1e-9 slack only for ULP-level
log/pow rounding at the exact analytic boundary -- never load-bearing; measured max was 0.97% vs
the 1% bound). Space is the co-headline: `maxBins * 8` bytes (fixed) vs the exact sorted array's
`8 * N` bytes. Uniformity is not a factor (no hashing); the only approximation is the log-bucket
width, bounded by alpha.

## H2.2 amendment (2026-10-04) -- fail-closed ctor + merge (F10, F11, F17; S2, S3)

The final-sweep audit of 1.1.2 found three cold DDSketch defects. The hot path (`add`,
`addFrom`, `_addKey`, `quantile`) is unchanged and byte-identical to the pre-H2.2 code; only
the ctor constants/math, `merge`, and one new cold thrower moved.

1. **`DD_ALPHA_MIN = 1e-6`, an exported constant; the ctor accepts `[1e-6, 1)` (S2, F10).**
   The pre-H2.2 max-key closed form added `ln((gamma+1)/2)` where it should have subtracted
   `ln 2`, overshooting `_maxKeyIndexable` by about `0.3466/alpha` keys. A decrement loop then
   walked that overshoot back ONE key at a time -- ~2.4 ms at alpha=1e-6, 35 ms at 1e-7, seconds
   by 2e-9, and an infinite hang once `K` passed `2^53` (the decrement is a float no-op there)
   or `gamma` rounded to 1 (K = Infinity). The fix is the correct closed form
   `K = floor((ln MAX_VALUE - ln 2) / ln gamma)` -- IDENTICAL to the old result at every alpha
   in the domain, with 0 fix-up steps over 3000 alphas (the 1e-6 build is O(1) now -- a constant
   few microseconds, down from ~2.4 ms).
   Both key fix-ups are now BIDIRECTIONAL and share one cap of 4 steps per bound; past the cap
   the ctor throws `[lite-sketch]` (lesson: a fix-up loop needs a cap). `alpha < DD_ALPHA_MIN`
   is rejected at the ctor door, before the bound math; the floor is 1e-6 because at the
   `2^20`-bin cap a single filled window spans only ~8x of value range there.

2. **Exact indexable edges (F17).** `minIndexable` / `maxIndexable` were `pow(gamma, K+-1)`,
   off by up to ~4e-13 relative -- so a consumer pre-check could pass a value `add` then threw
   on (or reject one it would accept). The ctor now BISECTS the exact acceptance edge of add's
   OWN key expression `ceil(log(x) * multiplier)` (same multiplier) over adjacent doubles: the
   lower edge is EXCLUSIVE (last rejected), the upper INCLUSIVE (last accepted). The upper edge
   is always strictly below `Number.MAX_VALUE`: `maxKeyIndexable` keeps `2*gamma^maxK/(gamma+1)`
   finite, so `gamma^maxK <= MAX_VALUE/2` and MAX_VALUE always maps above `maxKeyIndexable`. It
   converges in <= 25 steps; a broken bracket or an 80-step cap fails closed. Cold, plain doubles
   -- no BigInt, no array. Over a 3000-alpha sweep all four edges (add(min) rejected,
   add(nextUp(min)) accepted, add(max) accepted, add(nextUp(max)) rejected) hold with 0 failures.

3. **`merge` carries `collapsed`; strict rejects a collapsed other (S3, F11).** `merge` never
   propagated `other._collapsed`, so a merged sketch claimed the hard alpha while holding
   already-folded low-end mass (the shard example: a 16-bin shard over [1,1000] merged into an
   empty sketch read `collapsed=false`, `quantile(0)=742.6` vs a true 1). `merge` now sets
   `this._collapsed` from `other._collapsed` past every throw, and a STRICT `this` rejects a
   collapsed `other` outright (a new cold `_badMergeCollapsed()`), after the gamma check and
   before the strict pre-scan, as a byte-identical no-op -- its low-end mass has already folded,
   so the strict range guarantee cannot hold.

## H2.3 amendment (2026-10-04) -- counting honesty (F15, F20; S5)

Validation only; `add` / `addFrom` gain guard lines, the rest of the hot path is byte-identical.

1. **Count cap + running-count ceiling (F15, S5).** `count` is now `[1, 2^32-1]` (matching CMS); an
   `add` / `addFrom` / `merge` that would push the exact running `count` past `2^53-1` throws tagged
   (a new cold `_badTotal`) as a byte-identical no-op. The `_badCount` message becomes "count must
   be an integer in [1, 4294967295]". The count check precedes the negative-value check, so a
   doubly-invalid `add(-5, 2**40)` names the count; a non-finite value is still caught first (one
   `Number.isFinite` call now folds the old typeof/NaN/+-Infinity chain), so `add(NaN, 2**32)` names
   the value. `add` and `addFrom` fold the count-domain + total-ceiling guards into one cold branch
   so their hot bodies stay under the V8 inline-bytecode cap (`add` 448, `addFrom` 449 bytes).
2. **Throwers run no caller code (F20).** Every cold message (incl. both arms of `_badBuf`) formats
   its rejected arg through the shared `_describe(x)` (typeof-first), so a null-proto object or a
   throwing / re-entrant `toString` can no longer escape the `[lite-sketch]` tag or mutate state.

## Non-goals

No negative values (deferred); no rank-error mode (relative-error is the point); no top-k /
heavy-hitters (that is SpaceSaving, M4); no serialization format in the zero-GC core. SpaceSaving
(0.4.0) closes the roster at four members to a stable 1.0.0.
