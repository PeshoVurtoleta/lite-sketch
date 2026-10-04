# Changelog

All notable changes to `@zakkster/lite-sketch` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Negative keys no longer collide with their `2^32`-shifted twins (F12).** The key's sign was
  folded into **bit 0** of the high word (`hiw ^ neg`), a magnitude bit, so `-k` aliased a real
  positive key: `add(-1); add(2**32+1)` counted **1** distinct (now **2**); 20000 distinct
  `(-i, 2^32+i)` pairs counted **10023** (now **~20000**); and `CountMinSketch.add(-7, 100)` made
  `estimate(2**32+7)` read **100** (now **0**). The sign now lives in **bit 31** of the high word
  (`hiw ^ (neg << 31)`), which is free because a safe integer's high word is `< 2^21`. The
  `mix64` / `hashHi` / `hashLo` lanes change for **NEGATIVE keys only** (including `-Infinity`);
  positive keys and `-0` stay **bit-identical**. `SpaceSaving` was already exact (keys are
  compared by value in the probe) but every `-k` / twin pair shared a home slot; they now probe
  to distinct homes.
- **`HyperLogLog` / `CountMinSketch` `add` and `CountMinSketch.estimate` no longer box the hash
  words for `|key| >= 2^31` (F2, Node part).** The key is split into int32 words (`lo = a | 0`,
  `hiw = (a / 2^32) | 0`) that stay Smis across `_m3round`, so the library adds **0** boxes. With
  all inlining disabled the no-inline lane drops from **49 scavenges at 1.6M ops** (`~2 boxes/op`;
  `-2^31` keys **73**) to **24** (`~1 box/op`, the caller's own argument box at the non-inlined call
  boundary), which stays until `addFrom` lands (1.2.0). The default-tier `-2^31` HLL lane drops from
  **48 to 24 or less** (0-3 when V8 inlines `add` into the caller). Positive-key output is
  bit-identical.
  The register suffix was computed as `(h << p) >>> 0`, a uint32 that is `>= 2^31` about
  half the time. Maglev assumed it was an int32, so that half deopted (`not int32`) and
  recompiled in a loop (hundreds of deopts per run), and the deopted tiers boxed every
  uint32 / double temporary -- about 0.5 box per op even on small keys (12-13 young-gen
  scavenges at 1.6M ops; Chrome ~14 B/op). The suffix is now `h << p` (a signed int32):
  `Math.clz32` reads the same 32 bits and `!== 0` has the same truth value, so the
  deopt loop is gone and `add` is 0 scavenges / 0 B/op for **Smi-range keys**
  (`|key| < 2^31` on Node, whose Smis are 32-bit; Chrome's Smis are 31-bit). A key
  `>= 2^31` still costs boxes from two separate causes, both fixed later in 1.2.0:
  the caller boxes the argument itself at a non-inlined call (~24 scavenges at 1.6M
  ops; only `addFrom` removes it), and the library boxes `lo = a >>> 0` into
  `_m3round` (the other ~25 of the 49 seen with no inlining; removed in 1.2.0 by the
  int32 word split below, which keeps `lo` / `hiw` as Smis across `_m3round` -- the
  murmur hand-inline itself is deferred to a later 1.2.0 step). Output is **bit-identical** --
  the `_reg[]` registers and `count()` match the prior release exactly at p = 4, 12, 18
  over 600k mixed (positive, negative, `> 2^32`) keys plus the `addHashed` lanes.
- **`DDSketch` constructor no longer hangs for a small `alpha`.** The max-key closed form
  added `ln((gamma+1)/2)` instead of subtracting `ln 2`, overshooting the key ceiling by
  about `0.3466/alpha`; a decrement loop then walked that back one key at a time -- ~2.4 ms at
  `alpha=1e-6`, 35 ms at `1e-7`, ~1 s at `2e-9`, and an unbounded hang at `<= 1e-10` (killed
  at 3 s). The correct closed form `K = floor((ln MAX_VALUE - ln 2) / ln gamma)` lands on the
  exact bound with 0 fix-up steps (bit-identical key bounds to the prior release at every
  alpha; the `1e-6` build drops from ~2.4 ms to a constant few microseconds). Both bound
  fix-ups are now bidirectional and capped at 4 steps, then throw `[lite-sketch]`.
- **`DDSketch.merge` now carries `collapsed`.** It never propagated `other._collapsed`, so a
  merged sketch claimed the hard `alpha` while holding already-folded low-end mass. Example: a
  16-bin shard over `[1, 1000]` merged into an empty sketch reported `collapsed === false` and
  `quantile(0) === 742.6` (true value 1); it now reports `collapsed === true` (bins/quantiles
  unchanged).
- **`DDSketch.minIndexable` / `maxIndexable` are now the EXACT acceptance edges.** They were
  `pow(gamma, K+-1)`, off by up to ~4e-13 relative, so a consumer pre-check against them could
  BOTH pass a value `add` then throws on AND reject a value `add` accepts: on HEAD, `add` threw
  on `nextUp(minIndexable)` -- a value above the documented floor -- at 2428 of 3000 alphas, and
  `add` accepted `nextUp(maxIndexable)` -- a value above the documented ceiling -- at 2465. The
  ctor now bisects add's own key expression over adjacent doubles: `minIndexable` is the
  EXCLUSIVE floor (last rejected double), `maxIndexable` the INCLUSIVE ceiling (last accepted
  double, always below `Number.MAX_VALUE`).
- **`CountMinSketch.estimate` no longer aliases an un-addable key (F13).** Its guard was only
  `typeof` + `NaN`, so a key `add` would reject was truncated under `>>> 0` and read a real key's
  cell: after `add(0, 50); add(1, 70)`, `estimate(Infinity)` and `estimate(2**64)` returned 50 and
  `estimate(1.5)` returned 70. `estimate` now applies `add`'s own guard and returns 0 for any
  non-integer / non-finite / out-of-safe-range key.
- **`CountMinSketch` saturation is now surfaced, not silent (F14).** `add(5, 2**32-1); add(5, 10)`
  returned estimate `4294967295` while `total` was `4294967305` -- a silent UNDERCOUNT that broke
  the "never undercounts" headline. A new sticky `saturated` getter is set on every clamp (cons,
  plain, merge) and carried by `merge`; the guarantee is now stated as "one-sided while
  `!saturated`".
- **Exact running aggregates no longer go silently inexact past `2^53-1` (F15).** All three counted
  members' running totals were effectively unbounded: `SpaceSaving.add(1, 1e308)` twice gave
  `total === Infinity` and `heavyHitters(0) === []`; `DDSketch.add(1, 2**60)` twice was accepted; and
  CountMinSketch's `total` passed `2^53` by repeated `add(k, 2**32-1)` (e.g. `9007207842578432` after
  `2^21 + 2` such adds), drifting into rounding then `Infinity`. Every `add` / `addHashed` (CMS) /
  `addFrom` (DD) / `merge` of CountMinSketch, DDSketch and SpaceSaving now rejects a running total
  past `2^53-1` tagged and byte-identically; a total of exactly `2^53-1` is still accepted.
- **`withAccuracy` / `withError` no longer silently clamp to a weaker guarantee (F16).**
  `CountMinSketch.withAccuracy(1e-12, 0.01)` returned `epsilon` `8.1e-8` and
  `SpaceSaving.withError(1e-9)` returned `k = 2^24`, quietly giving back a sketch weaker than
  requested. An unattainable request (`w > 2^25`, `d > 32`, or `k > 2^24`) now throws `[lite-sketch]`.
- **Cold throwers no longer run caller code (F20).** All 35 `String(x)` call sites in throw paths
  were replaced by a shared, typeof-first `_describe(x)`: a null-proto object gave an UNTAGGED
  `TypeError`, a throwing `toString` replaced the tag, and a re-entrant `toString` mutated the
  receiver during a "byte-identical" rejection (`reg[0]` `0 -> 53`). A rejection is now tagged and
  byte-identical in all four members and every constructor, running no user code.

### Added

- **`DD_ALPHA_MIN`** -- a named export (`1e-6`), the smallest `alpha` the `DDSketch`
  constructor accepts (`DD_ALPHA_MIN <= alpha < 1`).
- **`CountMinSketch.saturated`** -- a sticky `boolean` getter (F14/S4), `true` once any counter
  clamped at `2^32-1`. While `false` the estimate is strictly one-sided; `merge` carries it from
  either side, and `clear()` resets it.
- **`npm run lanes`** -- a child-process scavenge/deopt lane harness
  (`test/lanes.mjs` + `test/lanes/lane.mjs`), now part of `npm run verify`. One child
  per lane under `--max-semi-space-size=4` (default and no-inline) gates HyperLogLog
  `add` at `<= 2` scavenges, the `--trace-deopt` audit shape at `<= 3` `not int32`
  deopts, and a no-op teeth control at `>= 12`. `--lib <path>` runs the lanes against
  another build for a revert-check.

### Changed

- **`DDSketch` now throws `[lite-sketch]` for `alpha < 1e-6`** (the new `DD_ALPHA_MIN` floor).
  Such an alpha was accepted before -- slowly, and with an unbounded hang below about `1e-10`.
- **A STRICT `DDSketch` now throws `[lite-sketch]` when merging a COLLAPSED `other`.** Its
  low-end mass has already folded, so a fixed-range sketch cannot absorb it without breaking
  its range guarantee. The rejection is a byte-identical no-op.
- **DDSketch and SpaceSaving `count` > `2^32-1` now throws** (S5), matching CountMinSketch. A
  finite count above `2^32-1` was accepted before; the `_badCount` message of both is now
  "count must be an integer in [1, 4294967295]".
- **A running total past `2^53-1` now throws on `add` / `addFrom` / `merge` of all three counted
  members** (CountMinSketch, DDSketch, SpaceSaving) -- the exact aggregate was silently going
  inexact before (S5).
- **`CountMinSketch.withAccuracy` and `SpaceSaving.withError` now throw instead of clamping** when
  the request is unattainable (`w > 2^25`, `d > 32`, or `k > 2^24`) (S6). The clamp UP of `d` to
  `>= 1` stays, since it only strengthens the guarantee.
- **Non-primitive throw arguments now print `[object]` / `[function]`** (F20). A rejected arg that
  is an object or function is described structurally instead of coerced with `String(x)`, so no
  user `toString` / `valueOf` runs during a rejection; primitive messages are byte-identical.
- **A doubly-invalid `DDSketch.add` (negative value + over-cap count) now names the count** -- the
  count check runs before the negative-value check (but a non-finite value is still caught first, so
  `add(NaN, 2**32)` names the value).

## [1.1.2] - 2026-09-23

Packaging / README only -- NO source, API, or behavior change (`Sketch.js` byte-identical
apart from the `VERSION` string and its header comment).

### Changed

- **README badges expanded to the full suite set** -- npm version, sponsor, Zero-GC, bundle
  size, downloads, total downloads, tree-shakeable, TypeScript, dependencies, and license.

## [1.1.1] - 2026-09-23

Packaging metadata only -- NO source, API, or behavior change.

### Changed

- **`package.json` gains `repository`, `homepage`, `bugs`, and `funding`** (GitHub:
  `PeshoVurtoleta/lite-sketch`; sponsor link), matching the rest of the `@zakkster` suite --
  npm and GitHub now cross-link correctly and the sponsor button appears.
- **README badges** first brought in line with the suite (npm version, sponsor, Zero-GC,
  bundle size), replacing the older static badge row.

## [1.1.0] - 2026-09-23

Post-1.0 hardening (H1) -- the close-out of the 2026-09-23 zero-GC audit (verdict: the
zero-GC claim is honest; every hot and cold path measured 0 B/op). A MINOR release: it
ADDS new backward-compatible API (the `DDSketch.addFrom` method and five DDSketch getters),
so it is 1.1.0, not a patch. No member added and no API removed; the four-member roster is
unchanged. It also closes two fail-closed input holes and gives the accuracy witness teeth.

### Changed

- **`HyperLogLog.add` / `CountMinSketch.add` now reject a NON-INTEGER or out-of-safe-range
  key** (F2). Previously a non-integer key was truncated by `>>> 0` and distinct floats
  collided silently (`add(1.0)`, `add(1.5)`, `add(1.9)` all counted as one). The accepted
  domain is now every safe integer `|key| <= 2^53 - 1` -- exactly what the hot body
  distinguishes (low word + high word + sign) -- matching `SpaceSaving` and `DDSketch`. A
  non-integer key throws `[lite-sketch]` (typeof-first, byte-identical no-op). This is a
  behavior change for any caller that relied on the old truncation; the hot body is unchanged.

### Fixed

- **`HyperLogLog.add` / `CountMinSketch.add` now reject `+-Infinity`** (F1). Previously
  `Infinity` hashed identically to key `0` (fail-open: `add(0); add(Infinity); count()` was
  `1`). It now throws `[lite-sketch]` on the cold branch; `Number.isInteger` covers it. Hot
  body unchanged.
- **DDSketch low-indexable-bound documentation reconciled** (N5) to a single interval
  (`(~2.2e-308, ~8.9e307]` at alpha=0.01); `minIndexable` / `maxIndexable` are the exact
  runtime answer.

### Added

- **`DDSketch.addFrom(buf, i)`** (N7) -- the ZERO-BOX entry point for a FRACTIONAL hot-path
  value. Identical validation / throws / binning to `add(value)` (count = 1) but reads
  `buf[i]` UNBOXED from a caller-owned `Float64Array`: a fractional double passed as an
  argument to a non-inlined `add(value)` is boxed (~16 B HeapNumber/call), which `addFrom`
  avoids. Unblocks `@zakkster/lite-hud` M2 (per-channel p99 with a 0 B/op write path).
- **DDSketch getters `strict` / `minIndexable` / `maxIndexable` / `rangeMin` / `rangeMax`**
  (N1), O(1) 0-alloc, never throw -- the exact bounds `add` accepts, so a consumer stops
  sniffing `RangeError`-vs-`TypeError` and bisect-probing the bounds.
- **Per-member negative controls in the accuracy witness** (N4): a deliberately broken
  estimator per member (mis-sized HLL, under-counting CMS, biased-bucket DDSketch,
  heavy-key-dropping SpaceSaving) is proven to be REJECTED -- the honesty anchor has teeth.
- **A per-method scavenge lane in the torture gate** (N6), making the previously-disclosed
  transient-boxing floor visible and gated per hot method, plus an `addFrom` fractional lane
  proving it stays at the clean floor.

## [1.0.0] - 2026-09-23

The four-member API is declared STABLE. No new member; this is the semver-stability
milestone for the complete roster (HyperLogLog, CountMinSketch, DDSketch, SpaceSaving).
One pre-freeze correctness fix brought `HyperLogLog` into parity with the other hashing
members before the surface was locked.

### Changed

- **The public four-member surface is now stable under Semantic Versioning.** Constructors,
  static factories (`CountMinSketch.withAccuracy`, `SpaceSaving.withError`), hot methods
  (`add` / `addHashed` / `estimate` / `estimateHashed` / `quantile` / `merge` / `clear`),
  query methods (`count` / `topK` / `heavyHitters` / `errorOf` / `forEach`), and getters are
  frozen; breaking changes require a major bump.

### Fixed

- **`HyperLogLog.merge(other)` now fails closed on a seed mismatch**, matching `CountMinSketch`
  and `SpaceSaving`. Two HyperLogLogs built with different seeds hash the same key to different
  registers, so a register-wise-max merge produced a silently wrong union estimate; it now throws
  `[lite-sketch]` (`RangeError`) with both seeds, as a byte-identical no-op. Equal-m and equal-seed
  are both required. The `merge` hot/cold split is unchanged; the guard runs before any register read.

### Added

- **`HyperLogLog.seed` getter** (returns the effective `uint32` seed), completing seed-getter parity
  across the three hashing members (`CountMinSketch` and `SpaceSaving` already exposed it).

## [0.4.0] - 2026-09-23

The heavy-hitters member, pure-appended -- the roster is complete (four members).

### Added

- **`SpaceSaving` -- the heavy-hitters / top-k member: zero-GC frequent-item tracking over an
  unbounded stream in `k` fixed counters** (Metwally, Agrawal & El Abbadi, "Efficient Computation of
  Frequent and Top-k Elements in Data Streams"). `add(key, count = 1)` is amortized O(1), 0 B/op:
  increment a monitored key, insert a free slot, or -- when full -- EVICT the minimum-count key and
  reassign its slot to the newcomer at `count = min + count`, `error = min` (eviction IS the
  algorithm; it never fails at capacity). Guarantee: every element with true frequency > N/k is
  monitored (NO false negatives), a monitored key's true count lies in `[count - error, count]`, and
  `error <= N/k`. `estimate(key)` / `errorOf(key)` are O(1) (0 if not monitored, never throw);
  `topK(n)` and `heavyHitters(threshold)` return `{key, count, error}` entries sorted by count
  (COLD, allocate); `forEach` is alloc-free; `merge(other)` (same-capacity-and-seed) keeps the top-k.
  `SpaceSaving.withError(epsilon)` sizes `k = ceil(1/epsilon)`. Getters: `capacity` / `size` /
  `total` / `epsilon` (= 1/capacity) / `seed`. Uses the shared two-lane hash. See
  [`decisions/0005`](./decisions/0005-spacesaving.md).
- **The substrate synthesizes the suite** (by design-parity, never a runtime dep): an intrusive
  frequency-bucket forest (the `@zakkster/lite-o1` `FreqO1` pattern) gives O(1) increment + find-min;
  a fixed open-addressing key map with backshift deletion (the `CuckooMap` idiom) maps keys to
  counters. All pools are allocated once at construction -- the hot path, INCLUDING eviction (map
  backshift + forest re-file), is 0 B/op (torture-gated at steady-state-full where every op evicts).
- **`heavyHitters` returns a SUPERSET** (`count > threshold * total`): every true heavy hitter is
  included (no false negatives -- SpaceSaving's defining property), possibly with a few false
  positives. Each entry carries `error`, so `(count - error) > threshold * total` recovers the
  guaranteed-frequent subset. There is deliberately **no `addHashed`**: a heavy-hitters sketch must
  retain each key's identity, so there is no honest pre-hashed fast path.
- **Fail closed:** the ctor throws `[lite-sketch]` typeof-first on a bad `capacity` / `seed` /
  unknown option (did-you-mean) BEFORE any allocation; `add` typeof-guards a safe-integer key
  (0 is a legal key) and a positive-integer count (a rejected add is a byte-identical no-op);
  `merge` fails closed on a non-SpaceSaving or an unequal capacity/seed; queries never throw.
- **Chassis extended:** the accuracy witness gates 100% recall of true hitters above N/k (zero false
  negatives), the `[count - error, count]` bracket, and `error <= N/k` on a Zipfian stream vs an
  exact `Map` oracle; the torture gate proves `add` at 0 B/op including the eviction path; the perf
  gate adds a steady-state-full evict-every-op scenario.

### Changed

- `VERSION` -> `'0.4.0'` (three-site synced with `package.json` and `llms.txt`). `HyperLogLog`,
  `CountMinSketch`, `DDSketch`, and the shared hash are byte-identical -- SpaceSaving is a pure
  append. This completes the four-member roster; a `1.0.0` milestone will declare the API stable.

## [0.3.0] - 2026-09-23

The quantile member, pure-appended -- the family's first hard per-query bound.

### Added

- **`DDSketch` -- the quantile member: zero-GC relative-error quantiles over an unbounded stream in
  fixed space.** Log-scale bucketing (`gamma = (1+alpha)/(1-alpha)`; a value `x > 0` -> bucket
  `ceil(ln(x)/ln(gamma))`) over a dense `Float64Array` of bins. `add(value, count = 1)` is worst-case
  O(1), 0 B/op; `quantile(q)` is a cold O(bins) cumulative walk returning a value within a HARD
  per-query relative-error bound `|v - v_true| <= alpha * v_true` (the family's sharpest guarantee --
  not statistical like HyperLogLog, not additive like CountMinSketch). `merge(other)` is
  same-alpha-or-throw; `clear()` reuses the allocation. `alpha` is the accuracy knob directly (no
  `withAccuracy` needed). Getters: `alpha` / `count` / `sum` / `min` / `max` / `zeroCount` /
  `maxBins` / `numBins` / `collapsed`; `min` and `max` are EXACT (not bucketed) while `quantile` is
  alpha-approximate. Bin counts are `Float64Array` (exact to 2^53 -- no saturation, since a quantile
  needs an exact cumulative count). Does NOT use the two-lane hash (it bins raw values). See
  [`decisions/0004`](./decisions/0004-ddsketch.md).
- **Collapsing-lowest (default) + strict fixed-range (opt-in).** By default a bounded `maxBins`
  (2048) dense store collapses the SMALLEST-value buckets into the floor when the value range exceeds
  the budget -- unbounded value range, bounded memory, the relative-error guarantee PRESERVED for the
  upper quantiles (p50/p90/p99) and degraded only for the smallest values (`collapsed` reports it).
  The bin array is allocated once and NEVER re-grown: extend and collapse both shift counts within the
  fixed array (a `copyWithin`), so `add` stays 0 B/op even after collapse. A `{ range: [min, max] }`
  option is strict fixed-range fail-closed: a value outside the range throws instead of collapsing.
- **Fail closed:** the domain is positive + zero -- a negative value throws `[lite-sketch]`, and a
  value outside the representable double range (so a bucket representative can never overflow to
  `Infinity` or underflow to `0`) throws; the ctor throws typeof-first on a bad `alpha` / `maxBins` /
  `range` (incl. an un-indexable range end) BEFORE any allocation; every rejected `add` / `merge` is a
  byte-identical no-op; `quantile` / getters never throw (empty or a bad `q` -> `NaN`).
- **Chassis extended:** the accuracy witness now gates DDSketch's measured relative error at
  {p50, p90, p99, p999} against `alpha` on uniform / lognormal / pareto streams vs an exact
  sorted-array oracle; the torture gate proves `add` at 0 B/op; the perf gate adds the DDSketch
  add-stream scenario.

### Changed

- `VERSION` -> `'0.3.0'` (three-site synced with `package.json` and `llms.txt`). `HyperLogLog`,
  `CountMinSketch`, and the shared hash are byte-identical -- DDSketch is a pure append.

## [0.2.0] - 2026-09-23

The frequency member, pure-appended on the shipped hash + chassis.

### Added

- **`CountMinSketch` -- the frequency member: zero-GC point-query frequency estimation over an
  unbounded stream in fixed space.** A dense `Uint32Array(d * w)` counter matrix of `d` rows x `w`
  columns (`w` a power of two, so a column is a single `hash & (w - 1)` mask). `add(key, count = 1)`
  and `addHashed(hi, lo, count = 1)` are WORST-CASE O(d), 0 B/op (one hash + one increment per row);
  `estimate(key)` / `estimateHashed(hi, lo)` return the MINIMUM of the d cells -- the one-sided
  over-estimate, `f_hat >= f_true` with `f_hat - f_true <= epsilon * N` at probability `>= 1 - delta`,
  where `epsilon = e / w` and `delta = e^-d`. **Conservative update (Estan-Varghese) is the default**
  (raise the d cells only to `min(cells) + count` -- provably tightens the over-estimate on skewed
  streams without changing the min-query answer); `conservative: false` gives the classic plain-add
  matrix, which is linearly mergeable (plain `merge` is exact; a conservative merge is a valid but
  looser upper bound). Counters saturate at `2^32 - 1` (never wrap). `merge(other)` is element-wise
  saturating add, equal-`d`/`w`/`seed`-or-throw; `clear()` zeroes the matrix and the running total;
  getters `d` / `w` / `seed` / `conservative` / `total` / `epsilon` / `delta`.
- **`CountMinSketch.withAccuracy(epsilon, delta, options?)`** -- the paper's interface: derives
  `w = ceil(e/epsilon)` (rounded up to a power of two, clamped to the width cap) and
  `d = ceil(ln(1/delta))` (clamped to `[1, 32]`), then delegates all validation to the ctor.
- **Fail closed:** the ctor throws `[lite-sketch]` typeof-first on a bad `d` / `w` / `seed` /
  `conservative` / unknown option (with a did-you-mean hint) BEFORE any allocation; `add` /
  `addHashed` typeof-guard the key / lanes / count first (a Symbol / BigInt / NaN / non-uint32 lane /
  out-of-range count throws, byte-identical no-op); `estimate` / `estimateHashed` / getters / a valid
  `merge` never throw (a bad key estimates 0). A `d * w <= 2^31` cap keeps every flat index a SMI.
  See [`decisions/0003`](./decisions/0003-countminsketch.md).
- **Chassis extended:** the accuracy witness now also gates CountMinSketch (measured over-estimate vs
  the `epsilon * N` bound on a Zipfian stream against an exact `Map` oracle, plus conservative <=
  plain and the `d*w*4`-bytes-vs-`Map` space co-headline); the torture gate proves `add` (both modes),
  `addHashed`, and `estimate` at 0 B/op; the perf gate adds the CountMinSketch hot-path scenarios.

### Changed

- `VERSION` -> `'0.2.0'` (three-site synced with `package.json` and `llms.txt`). `HyperLogLog` and the
  shared hash are byte-identical -- CountMinSketch is a pure append.

## [0.1.0] - 2026-09-23

The first release: the package, the shipped hash, and the reference member.

### Added

- **`HyperLogLog` -- the reference member: zero-GC distinct-count (cardinality) over an unbounded
  stream in fixed space.** Dense `Uint8Array(m)` registers, `m = 2^p`, `p in [4, 18]`. `add(key)` is
  WORST-CASE O(1), 0 B/op (one hash + one register load/compare/store); `addHashed(hi, lo)` is the
  pre-hashed fast path (skips the mix). `count()` is a cold O(m) estimator (a disclosed co-headline,
  NOT per-add): Ertl's improved estimator (2017) -- a single table-free formula
  (`alpha_inf * m^2 / z`, folding the register multiplicity vector through the self-terminating sigma /
  tau corrections) accurate across the whole cardinality range, with NO range-switching and NO HLL++
  empirical bias tables.
  `merge(other)` is register-wise max, equal-m-or-throw; `clear()` zeroes the registers; getters `p` /
  `m` / `standardError` (= `1.04/sqrt(m)`). Dense-only (sparse deferred), no crypto hashing. Fail
  closed: a bad `p` throws `[lite-sketch]` typeof-first BEFORE the register array is allocated; `add`
  typeof-guards the key; `count` / getters never throw. See
  [`decisions/0002`](./decisions/0002-hyperloglog.md).
- **The canonical hash (ADR 0001): a two-uint32-lane 64-bit-quality non-crypto mix** via `Math.imul`
  (no BigInt -- it allocates), returned through module-scope lane slots so the hot path allocates
  nothing. HLL reads both lanes for `rho` (full bit-depth at any `p`); a pre-hashed fast path, seeded
  row-salting for future multi-row members, and an optional alloc-free `hashString` byte-walker. The
  avalanche property (a 1-bit input flip flips ~half the output bits) is a shipped gate. See
  [`decisions/0001`](./decisions/0001-hash.md).
- **The chassis** the whole family inherits: `test/witness.mjs` (the ACCURACY witness -- measured
  relative error vs the theoretical `1.04/sqrt(m)` bound, with the exact-`Set` foil whose memory grows
  O(distinct) while HLL stays fixed), `test/torture.mjs` (lite-leak + lite-gc-profiler 0-B/op gate on
  `add`), `test/perf/PerfGate.test.mjs` (flat-throughput + a must-allocate teeth control),
  `test/Hash.test.js` (avalanche + determinism), and `benchmark/` (error-vs-space / error-vs-N /
  throughput, measured vs theoretical).
- **Package scaffold**: `@zakkster/lite-sketch`, single PascalCase `Sketch.js` (pure-append per future
  member) + `Sketch.d.ts` + `llms.txt` + `README.md` + `CHANGELOG.md`; `type: module`,
  `sideEffects: false`, zero runtime deps, node >= 18. `VERSION` const three-site-synced with
  `package.json` and `llms.txt`.
