# Changelog

All notable changes to `@zakkster/lite-sketch` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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
