# Changelog

All notable changes to `@zakkster/lite-sketch` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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
