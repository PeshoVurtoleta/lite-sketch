# lite-sketch -- roster roadmap (to 1.0.0: HyperLogLog -> CountMin -> DDSketch -> SpaceSaving)

Blueprint: `../LiteO1/ROADMAP.md` (milestone table, shared law, gate spec, per-member briefs)
and the `../LiteFilter` cadence (reference member + one per release, complete at 1.0.0). See
`RESEARCH.md` for the identity, the accuracy witness, the roster rationale, and the open
questions. ASCII-only (`->`, `<=`, `x`).

Status: pre-code. Settle the HASH (ADR 0001) before M1. Each milestone is a full pipeline
session (planner -> settle -> coder -> reviewer -> qa); user commits/publishes; /release gate
+ catalog card sync after, exactly as lite-o1.

## Milestones

| # | Member | Version | Headline (space, error) | Status |
|---|--------|---------|-------------------------|--------|
| **M0** | Package scaffold + the canonical HASH + accuracy-witness chassis | 0.1.0 (with M1) | zero-dep 64-bit mix, avalanche-tested; the witness/torture/bench harness | SHIPPED (ADR 0001) |
| **M1** | **HyperLogLog** (cardinality) | 0.1.0 | ~16 KB (p=14) -> ~0.8% std err; mergeable | SHIPPED (ADR 0002) |
| **M2** | **CountMinSketch** (frequency) | 0.2.0 | d x w Uint32 -> `epsilon=e/w` overestimate at `delta=e^-d`; conservative-update default | SHIPPED (ADR 0003) |
| **M3** | **DDSketch** (quantiles) | 0.3.0 | dense log-bins -> HARD relative error `<= alpha`; collapsing-lowest default + strict opt-in; positive+zero | SHIPPED (ADR 0004) |
| **M4** | **SpaceSaving** (heavy hitters / top-k) | 0.4.0 | k counters -> overestimate `<= min-counter`; no false negatives above N/k; dual ctor + merge | SHIPPED (ADR 0005) |
| -- | **1.0.0** -- API declared STABLE at four members | 1.0.0 | reference + 3, the lite-filter cadence | planned |
| M5+ | KMV/MinHash, CountSketch, HeavyKeeper, SlidingHLL | post-1.0 | one per release (RESEARCH.md Tier 2) | backlog |

## 0. Preflight -- new-package scaffold (do once, with M0/M1)

A NEW package, so M1 stands up what lite-o1 already has:
- `package.json` (`@zakkster/lite-sketch`, `type: module`, `sideEffects: false`, `files: [Sketch.js,
  Sketch.d.ts, llms.txt, CHANGELOG.md, README.md]`, node >= 18, MIT (c) Zahary Shinikchiev
  <shinikchiev@yahoo.com> -- NEVER "Karadjov"), zero deps.
- Single PascalCase main file `Sketch.js` (each member a class appended -- the lite-o1 byte-identical
  append discipline) + `Sketch.d.ts` + `llms.txt` + `README.md` (modeled on LiteSepforge/README.md
  blueprint, the suite standard) + `CHANGELOG.md`.
- `test/` (node:test only), `test/witness.mjs` (the ACCURACY witness), `test/torture.mjs`
  (lite-leak + lite-gc-profiler 0-B/op gate), `test/perf/PerfGate.test.mjs`, `benchmark/`.
- The canonical hash + its avalanche test land in M0 (part of the M1 session), gated before any member.
- `VERSION` const in `Sketch.js`, kept in sync with package.json + llms.txt (the three-site rule).

## 1. Shared law (every member)

- Zero runtime deps. `node:test` only. ASCII-only source (U+00D7 and U+00B5 excepted).
- Single PascalCase main file, pure APPEND per member (prior members byte-identical; only the header
  + VERSION change). `sideEffects: false`, tree-shakeable.
- Zero allocation on every hot path (`add` / `update` / `estimate` / `query`). Bytes in a hot body,
  not instructions. Flat TypedArray registers, no per-op objects/closures.
- Fail closed on every unverified state (bad size/param at construction throws `[lite-sketch]`
  typeof-first, BEFORE allocation); queries never throw; null is not zero.
- Accuracy is a CO-HEADLINE: every member states (space, error, one-sided-vs-two-sided,
  statistical-vs-hard) together, and the witness proves the paper's bound on real data.
- DESIGN-PARITY, never a dep: reuse lite-o1 / lite-filter idioms by copying the technique.

## 2. Design calls to settle FIRST (from RESEARCH.md section 8 + 11)

- **ADR 0001 -- the HASH** (blocks everything): ship one 64-bit non-crypto mix (fmix64/xxhash-style),
  avalanche-tested; ALSO accept a pre-hashed numeric value on the hot path; derive Count-Min's d rows
  by seeded salting from one base hash; per-instance seed. Numeric-key core + optional alloc-free
  string-bytes hasher.
- **Per-member**: HLL dense-only (sparse deferred) + p range + HLL++ bias correction; Count-Min
  conservative-update as default; DDSketch fixed dense bins + collapse policy + value range; SpaceSaving
  over a FreqO1-style intrusive min-forest (design-parity).
- Distinct classes (not one uniform surface) -- sketches answer different questions (RESEARCH.md Q2).

## 3. Gates -- what "proven" means (shared spec)

### 3.1 The accuracy witness (`test/witness.mjs`)
Drive the member on a stream with a known exact oracle; measure error; GATE vs the theoretical bound:
- HLL: RMS relative error `<= C * 1.04/sqrt(m)` (C~1.5) over the N-sweep; p99 within ~3 sigma; error
  halves as p += 2. Foil: the exact Set, whose memory grows O(distinct) while HLL stays fixed.
- Count-Min: overestimate `<= epsilon * N` on `>= (1-delta)` of keys; never underestimates.
- DDSketch: EVERY quantile relative error `<= alpha` (hard -- a violation is a bug).
- SpaceSaving: recall of the true top-k = 1.0 above the frequency threshold; overestimate `<= min`.
Print MEASURED vs THEORETICAL side by side + the accuracy/space curve (the lite-filter table shape).

### 3.2 The torture gate (`test/torture.mjs`)
`node --expose-gc test/torture.mjs` (lite-leak + lite-gc-profiler): 0 B/op on `add`/`update`/`estimate`,
retained-growth 0, gc major 0 over the measured window. "ok" or it is not done.

### 3.3 The perf gate (`test/perf/PerfGate.test.mjs`)
`add`/`estimate` throughput flat (the O(1) claim) + a MUST-allocate control that the gate catches.

### 3.4 The benchmark matrix (`benchmark/`)
Error-vs-space, error-vs-N, error-vs-skew (uniform/Zipfian), throughput, space-vs-oracle, merge cost.
MEASURED vs THEORETICAL reported together.

### 3.5 The control (fail-path)
A bad construction param throws before allocation; a shape-mismatched merge throws; a member fed a
degenerate stream still honors its bound or discloses the corrected range (HLL small/large-range).

## 4. Session order

ADR 0001 (hash) -> M1 HyperLogLog (+ scaffold + witness/torture/bench chassis) -> M2 CountMinSketch
-> M3 DDSketch -> M4 SpaceSaving -> 1.0.0 (declare API stable) -> post-1.0 backlog one per release.
M1 is the heaviest (it builds the package); M2-M4 are appends onto a proven chassis.

## 5. The briefs

### M1 -- HyperLogLog (v0.1.0) -- the reference member
- PURPOSE: distinct-count over an unbounded stream in fixed space. `Uint8Array(m)`, m=2^p (p in [4,18]).
- HOT PATH: `add(hash)` = top p bits pick register j, rho = leftmost-1 position of the rest,
  `reg[j]=max(reg[j],rho)` -- one load/compare/store, 0 B/op.
- COLD: `count()` = `alpha_m * m^2 / sum(2^-reg[j])` + HLL++ small/large-range correction (O(m),
  disclosed co-headline, NOT per-add). `merge(other)` = register-wise max (equal-m-or-throw).
  `clear()`, getters `p`/`m`/`standardError`.
- FAIL CLOSED: bad p throws `[lite-sketch]` before alloc; `add` typeof-guards the hash; `count` never throws.
- WITNESS: relative error within ~3 sigma of `1.04/sqrt(m)`; error halves as p += 2.
- NON-GOALS: no sparse representation (allocates -- deferred); no crypto hashing.
- DONE WHEN: HLL + scaffold + accuracy witness + torture "ok" (0 B/op) + bench + README + ADR 0001 (hash)
  + ADR 0002 (HLL) + /release 0.1.0 clean.

### M2 -- CountMinSketch (v0.2.0)
- PURPOSE: frequency / point queries over unbounded keys. `Uint32Array(d*w)`; d rows salted from one hash.
- HOT: `add(key,c)` bumps one counter per row; `estimate(key)` = min over rows (one-sided overestimate).
  Conservative-update default (bump only the min row(s)). `merge()` = element-wise add (equal d,w-or-throw).
- WITNESS: overestimate `<= epsilon*N` on `>= (1-delta)` keys, never underestimates; error down as w up.
- NON-GOALS: no signed/median estimate (that is CountSketch, Tier 2).

### M3 -- DDSketch (v0.3.0)
- PURPOSE: quantiles with a HARD relative-error guarantee. Dense `Int32Array` log-buckets over a fixed
  value range; `gamma=(1+alpha)/(1-alpha)`, bucket = `ceil(log_gamma(value))`; collapse the lowest buckets
  when the bin budget is hit (bounded memory).
- HOT: `add(value)` = one bucket increment; `quantile(q)` = walk cumulative counts to the q-th (O(bins),
  disclosed). `merge()` = bucket-wise add.
- WITNESS: EVERY `quantile(q)` within relative error `alpha` (hard ceiling, not statistical).
- NON-GOALS: no unbounded value range in the zero-GC core (disclosed trade); t-digest deferred (Tier 3).

### M4 -- SpaceSaving (v0.4.0)
- PURPOSE: heavy hitters / top-k. k counters; on a full miss, evict the min, reassign the key, inherit
  count+1. Over a FreqO1 / BucketQueue-style intrusive bucket min-forest (O(1) min, DESIGN-PARITY reuse).
- HOT: `add(key)` (O(1) via the min-forest), `topK()` (O(k)), `estimate(key)`.
- WITNESS: recall of the true top-k = 1.0 above the threshold; overestimate `<= current min counter`.
- NON-GOALS: no decay (that is HeavyKeeper, Tier 2).
- After M4: declare 1.0.0, API stable; post-1.0 backlog (KMV/MinHash, CountSketch, HeavyKeeper, SlidingHLL).

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
