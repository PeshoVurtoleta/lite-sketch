# lite-sketch -- roster roadmap (to 1.0.0: HyperLogLog -> CountMin -> DDSketch -> SpaceSaving)

Blueprint: `../LiteO1/ROADMAP.md` (milestone table, shared law, gate spec, per-member briefs)
and the `../LiteFilter` cadence (reference member + one per release, complete at 1.0.0). See
`RESEARCH.md` for the identity, the accuracy witness, the roster rationale, and the open
questions. ASCII-only (`->`, `<=`, `x`).

Status: COMPLETE at 1.0.0 -- the four-member API is STABLE (HyperLogLog -> CountMinSketch ->
DDSketch -> SpaceSaving). Each milestone was a full pipeline session (planner -> settle -> coder
-> reviewer -> qa); user commits/publishes; /release gate + catalog card sync after, exactly as
lite-o1. New work moves to post-1.0 members (below) and the sibling packages (lite-adaptive).

## Milestones

| # | Member | Version | Headline (space, error) | Status |
|---|--------|---------|-------------------------|--------|
| **M0** | Package scaffold + the canonical HASH + accuracy-witness chassis | 0.1.0 (with M1) | zero-dep 64-bit mix, avalanche-tested; the witness/torture/bench harness | SHIPPED (ADR 0001) |
| **M1** | **HyperLogLog** (cardinality) | 0.1.0 | ~16 KB (p=14) -> ~0.8% std err; mergeable | SHIPPED (ADR 0002) |
| **M2** | **CountMinSketch** (frequency) | 0.2.0 | d x w Uint32 -> `epsilon=e/w` overestimate at `delta=e^-d`; conservative-update default | SHIPPED (ADR 0003) |
| **M3** | **DDSketch** (quantiles) | 0.3.0 | dense log-bins -> HARD relative error `<= alpha`; collapsing-lowest default + strict opt-in; positive+zero | SHIPPED (ADR 0004) |
| **M4** | **SpaceSaving** (heavy hitters / top-k) | 0.4.0 | k counters -> overestimate `<= min-counter`; no false negatives above N/k; dual ctor + merge | SHIPPED (ADR 0005) |
| -- | **1.0.0** -- API declared STABLE at four members | 1.0.0 | reference + 3, the lite-filter cadence; pre-freeze fix: HyperLogLog seed-checked merge + seed getter (parity with CMS/SpaceSaving) | SHIPPED |
| **H1** | **Post-1.0 hardening: fail closed on the last edge + additive DDSketch surface** | 1.1.0 | HLL/CMS reject +-Infinity + non-integer keys; DDSketch `strict` / indexable-bound getters + `addFrom` zero-box entry (N7); per-member witness negative controls; scavenge-floor lane. MINOR (adds `addFrom` + 5 getters -- new backward-compatible API, not a patch) | BUILT & GREEN 2026-09-23 (F1/F2/N1/N4/N5/N6/N7; test 182/182, torture 0 B/op + N7 addFrom=0, witness + N4 controls ok, perf 9/9; trinity 1.1.0); awaiting publish |
| -- | 1.2 additive (post-H1) | 1.2.0 | `SpaceSaving.topKInto` 0-alloc sorted top-k; serialize/deserialize across all four members | backlog (section 6) |
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

## 6. Post-1.0 hardening -- H1 (1.1.0): the 2026-09-23 zero-GC audit close-out

Source: the read-only adversarial audit of 2026-09-23 (RESEARCH.md section 12). Verdict: the ZERO-GC
claim is HONEST -- every hot and cold path measured 0 B/op (9 torture-gated + 13 extra probes, incl.
DDSketch collapse/slide/merge, SpaceSaving weighted evict, HLL/CMS merge); the only allocators are the
three disclosed cold methods (`SpaceSaving.topK`, `heavyHitters`, `merge`). The FAIL-CLOSED claim has
two holes (F1, F2) and the surface has consumer gaps surfaced by lite-hud M2 (N1).

Entry state: 1.0.0, git clean, 175/0 tests, torture ok, witness ALL ok, perf 9/0 (mustFail trips),
pack 7 files 49.7 kB. Pipeline: planner -> settle -> coder -> reviewer -> qa -> /release 1.1.0 ->
/sync-card lite-sketch.

TASKS
1. F1 (S2) -- `HyperLogLog.add` (Sketch.js:297) and `CountMinSketch.add` (Sketch.js:605) reject
   +-Infinity with a `[lite-sketch]` throw (typeof-first, byte-identical no-op), matching DDSketch.
   The disjunct lives on the existing cold-throw branch; the hot body is unchanged.
2. F2 (S2) -- non-integer numeric keys in HLL/CMS `add` (Sketch.js:301, 612) are truncated by
   `>>> 0` and collide (1.0/1.5/1.9 -> count 1). SETTLE: throw on non-integer (lean; aligns with
   SpaceSaving `Number.isInteger`, fail closed) vs keep + document loudly on `add`/`addHashed`.
   The throw is behavior-changing for callers that relied on truncation: if taken, the CHANGELOG
   says so under Changed and the settle call records whether that still fits a patch (1.0.1) or
   needs 1.1.0.
3. N1 (S3) -- DDSketch O(1), 0-alloc getters: `strict`, `minIndexable`, `maxIndexable` (the exact
   values `add` accepts for x > 0 at this alpha), and in strict mode `rangeMin` / `rangeMax`.
   Consumer: lite-hud M2 currently detects strict mode by RangeError-vs-TypeError sniffing and
   bisect-probes the bounds; these getters let it delete both (lite-hud follow-up, after 1.0.1 ships).
4. N4 (S3) -- per-member NEGATIVE CONTROL in `test/witness.mjs`: a deliberately broken estimator per
   member (mis-sized HLL, an under-counting CMS, a DDSketch returning a biased bucket, a SpaceSaving
   dropping a heavy key) must make the witness REJECT. Proves the honesty anchor has teeth.
5. N5 (nit) -- reconcile the DDSketch low indexable bound: Sketch.js:863 says ~1e-305, README:141
   says ~2.2e-308. State ONE interval (and point to the N1 getters as the exact answer).
6. N6 (S3) -- the perf gate allows `maxScavenges: 64` (test/perf/PerfGate.test.mjs:215-226, disclosed as
   a V8 uint32-lane boxing artifact). lite-hud M1 showed `measureAllocs` CANNOT see transient
   allocation, so the torture 0 B/op does not by itself cover that floor. Add a GcProfiler scavenge
   lane per hot method to torture (the lite-hud M1 pattern) and either drive the floor to 0 by
   isolating the caller-side boxed-arg lanes, or pin each lane's floor with a measured, written reason.

7. N7 (S2, consumer-blocking; added 2026-09-23 from the lite-hud M2 review) -- `DDSketch.addFrom(buf, i)`:
   identical to `add(value)` (same validation, same typeof-first throw, same byte-identical no-op on
   reject, count = 1) but reads `const value = buf[i]` from a caller-owned Float64Array. WHY: a
   fractional double passed as an ARGUMENT to a non-inlined `add(value)` is boxed by V8 (~16 B
   HeapNumber per call). The lite-hud reviewer measured it with the zgcSuite scaling lane at
   --max-semi-space-size=4 and fractional (performance.now()-like) values: paired SPAN minorLo=4 ->
   minorHi=36 (the probe below corrects the complete/LEVEL figures). The count scales with k, so this is a per-op allocation.
   Integer-valued inputs box as Smi and read 0, which is how SMI-only gates hide it. Inlining the
   caller's pre-check into write() did NOT remove it (paired 5 -> 36): the box sits at the peer
   boundary. With addFrom, the value crosses as (object, Smi) and is read unboxed inside. Validate
   `buf` typeof/instanceof Float64Array and `i` as an in-bounds integer on the cold throw branch.
   Optional: `addRange(buf, start, end)` for batch replay.
   GATE: a scaling lane that passes a value computed from a Float64Array (the lite-hud paired shape)
   through addFrom must show the SAME scaling as a no-add baseline (delta 0). The same lane through
   add(value) must show the box. That control proves the lane has teeth. Document in README/llms/d.ts that addFrom is the zero-box entry
   point for fractional hot-path values.
   STATUS: CONFIRMED by probe (below); still prove it with the real gate before shipping.
   PROBE RESULT (2026-09-23, scratchpad copies; zgcSuite N=200000 k=8, 4 MB semi-space, fractional
   t and values, full-suite order; minorLo -> minorHi):
     kind      analytics OFF   ON add()    ON addFrom()
     paired    4 -> 24         5 -> 43     4 -> 24
     complete  3 -> 24         3 -> 24     4 -> 24
     LEVEL     3 -> 24         3 -> 24     4 -> 24
   The OFF baseline (-> 24) is the caller passing fractional t/a into write(): V8 boxes that argument.
   It is caller-side and already exempt. Against that baseline, only PAIRED carried a real analytics box:
   the library-computed `t - tOpen` (43 vs 24). addFrom removes it exactly. Complete and LEVEL had no
   analytics delta, because add() reuses the caller's already-boxed argument. This CORRECTS the earlier
   review figure "complete/LEVEL 1 -> 12": that was the caller->write() box, not an analytics cost.
   GATE YARDSTICK: analytics-ON scaling == analytics-OFF scaling (delta 0) on fractional inputs.
   Literal 0 is unreachable for any fractional-input path. Integer inputs must still read 0.
   lite-hud M2 is BLOCKED on this + N1.

DEFERRED to 1.2.0 (additive minor, own session)
- N2 -- `SpaceSaving.topKInto(outKeys, outCounts, outErrors, n)`: sorted top-k into caller-owned
  typed arrays, 0 B/op (lite-hud M3 renders a per-frame hot-spots panel; `topK()` allocates).
- N3 -- `serialize()` / `static deserialize()` snapshot pair across all four members (the family
  sells mergeability; persistence today needs `_` privates).

GATES
- `npm test`: F1 regressions (HLL + CMS `add(+-Infinity)` throws, aggregates untouched), the F2
  settled behavior, N1 getter values vs a probe in both default and strict mode.
- torture: 0 B/op unchanged on all nine paths + the new scavenge lane (N6).
- witness: thresholds unchanged + the four negative controls REJECT (N4).
- perf: unchanged or tightened (N6); mustFail still trips.
- Version trinity in one commit (package.json / Sketch.js VERSION / llms.txt), CHANGELOG head, README
  + llms.txt + d.ts for the new getters and the F1/F2 behavior; pack still 7 files, demo/ test/ absent.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
