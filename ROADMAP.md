# lite-sketch -- roster roadmap (to 1.0.0: HyperLogLog -> CountMin -> DDSketch -> SpaceSaving)

Blueprint: `../LiteO1/ROADMAP.md` (milestone table, shared law, gate spec, per-member briefs)
and the `../LiteFilter` cadence (reference member + one per release, complete at 1.0.0). See
`RESEARCH.md` for the identity, the accuracy witness, the roster rationale, and the open
questions. ASCII-only (`->`, `<=`, `x`).

> **NEXT (2026-10-05): `/release 1.2.0`** (maintainer). H2 (section 7) is BUILT & GREEN: H2.1-H2.7 are
> committed and H2.8 (7.9) is in the working tree. `npm run verify` (now with the headless-Chrome lane) and
> `npm run revert-check` (every new gate FAILs on 1.1.2) both pass. After the release, lite-hud M3
> (../LiteHud/ROADMAP.md 8.2) can re-run its boxing probe on 1.2.0; the 7.9 Result has the numbers.

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
| **H1** | **Post-1.0 hardening: fail closed on the last edge + additive DDSketch surface** | 1.1.0 | HLL/CMS reject +-Infinity + non-integer keys; DDSketch `strict` / indexable-bound getters + `addFrom` zero-box entry (N7); per-member witness negative controls; scavenge-floor lane. MINOR (adds `addFrom` + 5 getters -- new backward-compatible API, not a patch) | BUILT & GREEN 2026-09-23 (F1/F2/N1/N4/N5/N6/N7; test 182/182, torture 0 B/op + N7 addFrom=0, witness + N4 controls ok, perf 9/9; trinity 1.1.0); SHIPPED 1.1.0 (1.1.1-1.1.2 were packaging) |
| **H2** | **Zero-box PATH + `addFrom` family + fail-closed fixes** (final-sweep audit of 1.1.2, 2026-10-04) | 1.2.0 | HLL deopt-loop fix; SpaceSaving / CMS argument-free helpers; `addFrom(buf, i)` on HLL / CMS / SpaceSaving; DDSketch tiny-alpha hang + collapsed-merge fix; negative-key hash fix; calibrated gates incl. a Chrome lane. Unblocks lite-hud M3 | BUILT & GREEN 2026-10-05 (H2.1-H2.8, section 7); awaiting /release 1.2.0 |
| -- | 1.2 additive (post-H1) | 1.2.0 | `SpaceSaving.topKInto` 0-alloc sorted top-k (shipped in H2 as F7); serialize/deserialize across all four members | serialize: backlog (section 6) |
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

---

## 7. H2 -- v1.2.0: zero-box path + addFrom family + fail-closed fixes (final-sweep audit of 1.1.2, 2026-10-04)  [BUILT & GREEN, awaiting /release 1.2.0]

Baseline at audit (1a2673e): `npm test` 182/182, perf gate 9/9, torture `ok`. Two parallel read-only
audits covered (a) allocation + gate honesty and (b) fail-closed + correctness + doc truth. The
evidence is in RESEARCH.md section 13. Re-run independently by the orchestrator:
- HLL small keys 13 -> 0 with the one-line F1 fix, and identical `count()` at p = 4, 12, 18;
- the DDSketch(1e-10) hang (killed at 3 s);
- `merge` dropping `collapsed` (q0 742.6 vs 1);
- the negative-key collision (`add(-1); add(2**32+1)` counts 1).

Second independent reproduction (2026-10-04, Node 26.8.2 with 32-bit Smis confirmed by
`%IsSmi(2**31-1)`, headless Chrome 154). Method: one lane per child, `--max-semi-space-size=4`, scavenges
over 8N = 1.6M ops, default + `--max-inlined-bytecode-size=0`. EVERY F1-F19 finding reproduces. The
baseline holds: 182/182, perf 9/9, torture `ok` with HLL SCAV 4. Numbers (no-op baseline in brackets):
- F1: HLL small keys 12 -> 0 (default and no-inline). The p 4/12/18 parity holds (0 register diffs over
  600k mixed keys).
- F2: CMS `add` 2^31 keys 49 [24], -2^31 keys 73, `estimate` 49. Chrome no-inline small keys: HLL 77,
  CMS 126, SS 161 B/op [0.03]. Chrome default: HLL 14 -> 0 with F1 alone. SS stays ~6 B/op even inlined.
- F3: SS no-inline 2^31 keys 195 [24]. SS small keys with count 2^30 read 24 even when inlined.
- F10: 1e-6 3 ms, 1e-7 22 ms, 1e-8 211 ms, 2e-9 1.05 s; 1e-10 / 1e-12 / 1e-17 killed at 3 s.
- F12: 20000 distinct (-i, 2^32+i) count 10023. All 99,999 mix64 pairs collide on both lanes.
- F7 / F8: forEach 2592 B/call no-inline (k=64). merge 49-58 KB at k=64 and 584 KB at k=1024. These
  are by `total_allocated_bytes`, which reads higher than the audit's sampler, so the docs should state
  the gate's number, not either probe's.

Deltas the planner must carry (none changes a task's direction):
- **N5:** the deopt count depends on the driver. A single-instance tight loop shows only 4-5
  `not int32` deopts. The audit shape shows 1173 (default) / 1998 (no-inline), and 0 after F1. That
  shape is 3 instances at p 4/12/18, called through a closure, keys read from a Float64Array. N5 must
  use the audit shape.
- **F17 is two-sided:** across 3000 alphas, `add(minIndexable)` is also accepted 598 times and
  `add(maxIndexable)` rejected 526 times. F17's four-edge gate already covers this.
- **F15 is wider than DD / SS `add`:** the CMS `total` passes 2^53 by repeated `add(k, 2^32-1)`, and
  an SS `merge` of two 2^52 shards does too. The S5 total guard covers every `add`, `addFrom` and
  `merge` of all three counted members.
- **F19's collapse overclaim also hits p90:** 1001 x 147 then 999 log-spaced values in [1e3, 1e6] at
  maxBins 64 gives p50 282199 (true 147) and p90 282199 (true ~251600, 12%). The fix is to bound the
  claim by the collapsed mass, not to name p50.
- **F12 is a correctness bug in HLL / CMS only.** SpaceSaving compares stored keys exactly, so there it
  only costs a shared home slot (probe length). `mix64` is a public export, and its lanes change for
  negative keys. No test pins a negative-key vector.
- **F18:** `merge()` inside `forEach` revisits key 1 (`1,3,1`) when key 1 is the lowest count.
  `clear()` at the first entry visits 5 (4 ghosts).

The audit's prototype of F1-F5 (`Sketch.fix.js` in the session scratchpad) measured:
- every `addFrom` lane at 0 on Node (HLL 24 lanes, CMS 48, SS 48: 6 key classes x counts
  {1, 2^30} x fresh/warm x default/no-inline) and in Chrome 154;
- every `add` lane reduced to the caller's own argument box (<= 24 at 8N; 0 for Smi-range
  arguments);
- 182/182 tests and bit-identical output to HEAD on 600,113 keys (HLL p 4/12/18, CMS
  conservative + plain incl. addHashed, SS capacity 1/7/64/1000 + merge).

**Allocation fixes (F)**

| id | finding | task | falsifiable gate |
| --- | --- | --- | --- |
| F1 | A1 (H) HLL `hiSuf = (h << p) >>> 0` (Sketch.js:320 `add`, :341 `addHashed`). Maglev assumes int32; hiSuf >= 2^31 deopts ("not int32") and recompiles: 416-461 deopts per run in the audit's driver. The deopted tiers box every uint32 / double temporary (incl. `Math.abs(key)` :301). ~0.5 box/op on SMALL keys (12-13 scavenges at 8N in all modes; Chrome 9 B/op). This IS the torture "pinned floor" (torture.mjs:292), whose stated cause is wrong. | `h << p` (clz32 reads the same bits). | HLL small-key lane 12-13 -> 0 (orchestrator re-measured 13 -> 0). The N5 deopt gate shows <= 3. Torture HLL SCAV 4 -> 0. |
| F2 | A3/A4 (H/M) the murmur helpers `_m3round` / `_m3final` (:75, :90) take and return int32 words. In Chrome (31-bit Smis) any word outside +-2^30 boxes, about half of all hash words: no-inline small keys count 1 gives HLL 77, CMS 113, SS 170 B/op. On Node, CMS `lo = a >>> 0` (:621/:715) into `_m3round` boxes for \|key\| >= 2^31 (49 vs 24 no-inline; the -2^31 class 73). | Hand-inline the murmur in every hot body (HLL/CMS/SS add, CMS estimate, SS home). Use `lo = a \| 0`, `hw = ((a / 2^32) \| 0) ^ neg` (with F12's sign fix), `M3_ADD = 0xe6546b64 \| 0`. Replace `Math.abs(key) > MAX` with two compares. H2.4 planner delta: the Node part (int32 words + a `Math.abs` sign split) ships in H2.4; the hand-inline and the two compares move into H2.6's `_addAt`, because hand-inlining into `add` pushes it past V8's 460-byte inline cap (Node default non-Smi keys 0-1 -> 24; see 7.5). | N3 (library delta <= 2) and N6 (Chrome) green. |
| F3 | A2 (H) SpaceSaving doubles crossing calls: `_mapDeleteKey(this._key[sl])` (:1572), `_hash(mkey[j])` per backshift step (:1815), `_attach(slot, val, hint)` (:1564/:1579/:1851), `_bump(slot, count)` (:1552), and `lo` -> `_m3round` (:1543/:1547). A per-key COUNT passing 2^31 boxes, which is exactly lite-hud's cumulative-microseconds case. No-inline 2^31 keys read 192 (~8 boxes/op, 125 B/op by sampler). | `_attach(slot, hint)` reads `_count[slot]` itself. `_homeAt(arr, i)` returns `h & mask` (always a Smi). `_probeAt(arr, i, home)` reads the key from the array. Eviction deletes via `_probeAt(_key, sl, _homeAt(_key, sl))`. Inline the bump path. | SS no-inline 2^31 keys 192 -> 24 (the caller box only). SS small keys with count 2^30: 24 -> 0. H2.5 delta (done): on HEAD after H2.4 the no-inline 2^31 lane reads 98-99 (the 192 was the pre-H2.4 1.1.2 number), nc 49, df 25; the tree reads 24-25 / 0. `_homeAt` IS F2's "SS home" hand-inline, done here. |
| F4 | A4 (M) CMS `_applyCons(base, ...)` / `_applyPlain(base, ...)` (:635-636) and per-row `_m3final` (:669/:693/:730) pass doubles. | `base` goes into an Int32Array(1) scratch and `count` into a Float64Array(1) scratch. The apply helpers take no arguments, and the per-row fmix is inlined. | CMS -2^31 keys 73 -> 24 and estimate no-inline 49 -> 24. H2.5 delta (done): the keys gate was already met by H2.4's int32 hash words; the remaining Node box was a VARIABLE count >= 2^31 crossing `_applyCons` / `_applyPlain` in df (24-25 -> 0-1, cons + plain). The `estimate` per-row fmix inline moves to H2.6 (364 -> 422 would crowd the 460 cap); the count scratch is `Float64Array(1)`. |
| F5 | A5 (H for consumers) a key or count outside Smi range passed to `add(...)` is boxed by the CALLER at a non-inlined boundary (24 at 8N on Node, 12 B in Chrome). lite-hud's CMS key `channelIdx * 2^32 + tag` is >= 2^32 for every channel >= 1, so it ALWAYS boxes. | `add(key[, count])` validates, writes into a per-instance Float64Array scratch, and calls a shared `_addAt(buf, i)`. New `addFrom(buf, i)`: HLL reads key = buf[i]; CMS / SS read key = buf[i], count = buf[i+1]. Same validation and same throws (byte-identical no-op), like DDSketch.addFrom (1.1.0). CMS / SS `estimate` also go through the scratch. | N1: every addFrom lane <= 2 at 8N on Node (default + no-inline, fresh + warm, 6 key classes x counts {1, 2^30}). N6: 0 in Chrome. H2.6 delta (q1 pre-measured, pending qa): shipped as `_addAt` x3 + `addFrom` x3 + CMS `_estimateAt` (D3); addFrom 0-2 at 1.6M ops (N1 gate <= 2), SS add non-Smi 25 -> 1, CMS constant count 2^32-1 24 -> 1 at the cap120 lane (0-1 in the default tier), Chrome ni add 60-72 -> 0. |
| F6 | A12 (L) the `addHashed` contract (uint32 lanes, :337/:649): any lane >= 2^31 boxes at the boundary (HLL addHashed 30, CMS 4). | `addHashedFrom(Uint32Array\|Int32Array, i)`, or accept int32 lanes. | An addHashedFrom lane at 0. H2.6 delta (q1 pre-measured, pending qa): shipped `addHashedFrom` on HLL (2-slot [hi, lo]) and CMS (3-slot [hi, lo, count], D2; an Int32Array caps count at 2^31-1); AHF lanes 0-2 at 1.6M ops (gate <= 2). |
| F7 | A9 (M) `SpaceSaving.forEach` passes key / count / error as callback arguments: 3130 B/call at k=64 (no-inline, 2^31 keys and counts). | `topKInto(outKeys, outCounts, outErrors, n)` (the old 1.2 backlog N2) or `snapshotInto`. Document `forEach`'s per-entry boxes. | A topKInto lane at 0. H2.7 delta (done): shipped `SpaceSaving.topKInto(outKeys, outCounts, outErrors, n?)` (D4) -- an in-place bounded min-heap of slot ids in `outKeys`, EXACTLY `topK(n)`'s order (count DESC, ties by ascending slot), 0 alloc; the `ni/ss.topKInto.n16\|n64/big` N8 lanes read 0 scavenges (gate <= 2), and the `FE-CTRL[ni/ss.forEach/big]` control stays the documented 73. `forEach`'s ~49 B/entry (non-Smi, non-inlined fn) is documented in d.ts / llms / README. |
| F8 | A10 (M, doc) `SpaceSaving.merge` allocates fresh O(k) state per call (a Map, 2 objects per key, an array, 3 closures): 18.0 KB/call at k=64, 282.5 KB at k=1024. llms.txt:283 says "bounded cold scratch". A11 (L): HLL `count` (16.8 B/call default, 111 no-inline) and DD `quantile` (5 / 16 B) box their returns. | Fix the merge wording (or reuse a preallocated scratch). Document the returned-double boxes, and add `countInto` / `quantileInto` if a consumer needs a 0 B/op render. | The docs state the bytes, or the Into lanes are at 0. H2.7 delta (done): shipped `DDSketch.quantilesInto(qs, out)` (D5) -- `quantile`'s walk duplicated per q, read / write via the Float64Arrays so no double crosses a call; the `ni/dd.quantilesInto.q4` N8 lane reads 0 scavenges (gate <= 2) against the `Q-CTRL[ni/dd.quantile]` control of 24. No `countInto` / `estimateInto` (HLL count is a Smi; both return boxes are docs only). The merge / topK / heavyHitters bytes (~300 / ~160 / ~135 B/entry, approx per alloc.mjs) and the quantile / estimate 16 B return box are stated in d.ts / llms / README; the llms "bounded cold scratch" wording now carries the ~300 B/entry figure. |
| F9 | A6 + A7 (H, harness) the perf gate's `maxScavenges: 64` (PerfGate.test.mjs:226) admits ~2.7 boxes/op, and its only mustFail allocates ~528 B/op. The torture `SCAV_BOX = 48` (torture.mjs:303) admits 1.6 boxes/op and pins F1 as "acceptable". The comments at torture.mjs:288-299 and PerfGate:215-225 misattribute the floor. torture.mjs:335-341 says the add-box teeth "live in lite-hud", but they reproduce here. | Lower `maxScavenges` 64 -> 2 and `SCAV_BOX` 48 -> 0. Add the N4 one-box mustFail. Fix the comments. | N4 trips. All lanes pass at the new thresholds after F1-F5/N7. H2.8 delta (done): `maxScavenges` 64 -> 2 and `SCAV_BOX` deleted (scAh / scCh at SCAV_CLEAN 0); comments state the true causes (7.9 D3). |

**Fail-closed + correctness fixes (F)**

| id | finding | task | falsifiable gate |
| --- | --- | --- | --- |
| F10 | B-A1 (H) the DDSketch constructor HANGS for small alpha (:893, :935-937). The `maxKeyIndexable--` fix-up loop runs about 0.3466/alpha times because the closed form ignores the `2*pow` overflow. Below ~4e-14, K > 2^53 and `K--` is a no-op, so the loop never ends. Below ~1.1e-16, gamma rounds to 1 and K is Infinity. Times: 1e-7 35 ms, 1e-8 574 ms, 2e-9 2.2 s, and <= 1e-10 never returns (re-run: killed at 3 s). | Compute maxKey from `ln(MAX_VALUE) - ln 2`, cap the fix-up at 4 iterations then throw, and throw tagged when gamma <= 1, the multiplier is non-finite, or alpha < ALPHA_MIN (S2). | In a child with a 2 s timeout, `new DDSketch(1e-17)` and `(1e-12)` throw `[lite-sketch]`, and `(1e-6)` builds in < 5 ms. |
| F11 | B-A2 (H) `DDSketch.merge` (:1272-1287) never carries `other._collapsed`, so the merged sketch claims the hard alpha while holding collapsed mass. Strict sketches also accept a collapsed `other`. Shard (maxBins 16): add 1000, then add 1 three times, merge into an empty sketch: `collapsed=false`, `quantile(0)` = 742.6 vs a true 1 (re-run). | After the strict pre-scan, `if (other._collapsed) this._collapsed = true;`. A strict `this` rejects a collapsed `other` (S3). | The shard example gives `collapsed === true`. A strict merge of a collapsed other throws tagged. |
| F12 | B-A3 (M) negative keys collide: `neg` is XORed into bit 0 of the high word, so `-(H*2^32+L)` hashes like `((H^1)*2^32+L)`. This contradicts README:347, CHANGELOG 1.1.0, llms.txt:96/146 and the jsdoc at 286/600. HLL: `add(-1); add(2**32+1)` counts 1 (re-run). 20000 distinct keys count 10023. CMS: `add(-7,100)` gives `estimate(2**32+7)` = 100. Sites: mix64, HLL add, CMS add / estimate, SS add / `_hash` (:110-117, 302-316, 618-633, 712-725, 1540-1549, 1763-1774). test/SpaceSaving.test.js:685 only tests +-MAX_SAFE. | Use `hiw ^ (neg << 31)` at all five sites (hiw < 2^21, so bit 31 is free). It lands together with F2's hand-inlined murmur. | HLL `add(-1); add(2**32+1)` gives `count()===2`. Over 1e5 pairs (-(H*2^32+L), (H^1)*2^32+L), the mix64 lanes differ for every pair. |
| F13 | B-A4 (M) the F1/F2 fix from 1.1.0 covers `add` but not `CountMinSketch.estimate` (:711). An un-addable key aliases a real key: after `add(0,50); add(1,70)`, `estimate(Infinity)` = 50, `(1.5)` = 70, `(2**64)` = 50. The comment at test/CountMinSketch.test.js:386 claims otherwise with no assertion. | Mirror the add guard (`!Number.isInteger(key) \|\| \|key\| > MAX_SAFE` returns 0). | Those estimates all return 0. Add the missing `estimate(1.5) === 0` assertion. |
| F14 | B-A5 (M) CMS saturation silently UNDERCOUNTS (:676-677, :695-696, :773-774): `add(5, 2**32-1); add(5, 10)` gives estimate 4294967295 while total is 4294967305. This breaks "NEVER undercounts" (README:92/120, llms:175/292, ADR 0003). For lite-hud that is ~71 min of microseconds on one key. | A sticky `saturated` getter set on the clamp branches (S4). The docs say "one-sided while `!saturated`". Update the d.ts. | `saturated === true` after that sequence, false on a fresh sketch. |
| F15 | B-A6 (M) `count` is unbounded in DDSketch (:1060) and SpaceSaving (:1536), while CMS caps at 2^32-1. The "exact" running aggregates go inexact past 2^53, then Infinity, and `heavyHitters` then drops the heaviest key (`add(1,1e308)` twice gives total Infinity and `heavyHitters(0)` returns []). | Reject count > 2^32-1 and any add that would push total past MAX_SAFE, tagged and byte-identical (S5). | `add(1,1e308)` throws with an unchanged snapshot. `add(1, 2**32-1)` is accepted. |
| F16 | B-A7 (M) `withAccuracy` / `withError` silently clamp to a weaker guarantee (:570-576, :1513): `withAccuracy(1e-12,1e-20)` returns epsilon 8.1e-8, and `withError(1e-9)` returns capacity 2^24 / epsilon 5.96e-8. README:167/270 and llms.txt:71 say "k = ceil(1/epsilon)". | Throw when the request is unattainable (w > 2^25, d > 32, k > 2^24) (S6). | `withAccuracy(1e-12,0.01)` and `withError(1e-9)` throw. `withError(2**-24)` succeeds. |
| F17 | B-A8 (L) `minIndexable` / `maxIndexable` (:976-977) are not the EXACT accepted bounds (off by ulps, up to ~4e-13 relative). Across 3000 alphas, 2428 reject `nextUp(min)` and 2465 accept `nextUp(max)`. A consumer pre-check (lite-hud M2's band) can pass a value that `add` throws on. | Find the exact acceptance edges in the ctor with a bit-level search using `add`'s own key expression. | Over a 3000-alpha sweep: add(nextUp(min)) accepted, add(min) rejected, add(max) accepted, add(nextUp(max)) rejected. |
| F18 | B-A9 / A10 / A11 (L) the option check uses `in` against a frozen object that inherits Object.prototype (:521, :906, :1446): `{constructor:1}` / `{toString:1}` are accepted, `{__proto__:{seed:5}}` sets the seed, and Map / Date are accepted as bags. `SpaceSaving.forEach` uses a stale loop bound under mutation (:1620-1624: `clear()` at the first entry visits 4 ghosts, `merge()` mid-walk visits key 1 twice). -0 is stored as-is (SS key, DD min). | Use own-property checks and read only own values. Use the live `_size` bound and document "no mutation in forEach". Normalize with `key + 0`. | `{toString:1}` throws in all three classes. `clear()` mid-walk visits 1 entry. `Object.is(topK()[0].key, 0)`. H2.7 delta (done): shipped the plain-bag rule (D2) via `_optScan` / `_optOwn` + null-proto KNOWN sets -- own string DATA keys only, no inherited read, no getter run, a revoked / throwing-trap Proxy (bag or DD `range`) rejected tagged; `forEach`'s live `this._size` bound (no ghosts; `clear()` in the first callback now visits 1); and `+ 0` at the OUTPUTS (SS forEach / topK / heavyHitters / topKInto, DD min / max getters). Docs updated in d.ts / llms / README / ADR 0003-0005; CHANGELOG Fixed + Changed. |
| F19 | D1-D4 (L) docs. README:137 overclaims "p50/p90/p99 within alpha" under collapse (probe: p50 6187 vs 147), and says strict throws by value when it really works by bucket key (`range [1,100]` accepts 0.99 and 101). The README:322-330 allocation table describes module-scope slots the code never writes, and omits `_hist` / `_idx`. The README Testing section has no count (182). RESEARCH.md:9 says "Not yet coded", ROADMAP H1 says "awaiting publish", and the lockfile version is 0.1.0. The unqualified "0 B/op" lines (README:30/64/100/167/188/213/215/272/275/318-334, llms.txt:32/42/65/70/299, Sketch.d.ts:68/141/147/306/315) need "0 library bytes/op; a non-Smi argument boxes at a non-inlined boundary; use addFrom". | Text fixes. | Grep: no unqualified 0 B/op line, and the count is stated. H2.8 delta (done): "0 library B/op" (7.9 D7), collapse bounded by folded mass + strict by bucket key (D8), allocation table, README test count; gated by test/docs.test.js. RESEARCH.md:9 was already fixed; the lockfile item is moot (package-lock.json is gitignored). |
| F20 | Found by H2.1 qa, confirmed on HEAD (M): all 33 cold throwers build their message with `String(x)`, which runs caller code. Three consequences: (1) `add(Object.create(null))` on any member, and `new DDSketch(Object.create(null))`, throw an UNTAGGED `TypeError: Cannot convert object to primitive value`; (2) a `toString` that throws replaces the tagged error; (3) a `toString` that calls `h.addHashed(0,0)` changes the receiver during a rejection that must be byte-identical (reg[0] 0 -> 53, and the throw is still tagged). | One cold `_describe(x)` shared by every thrower: `typeof` first, primitives formatted directly (`String` is safe for number / string / boolean / bigint / symbol / undefined, plus null), and `'[object]'` / `'[function]'` for anything else, so no user code ever runs. Replace every `String(x)` in a throw path. | A null-proto object and a throwing / mutating `toString` give a TAGGED throw with byte-identical state in all four members and every ctor. Remove the `todo` in test/HyperLogLog.test.js (case 6) and make it a real test. |
| F21 | Found by H2.2 qa, confirmed (L): every `merge` brand-checks with `instanceof`, which a forged `Object.create(X.prototype)` passes. DDSketch: a forged other with a matching `_gamma` merges silently and leaves `count` / `sum` = NaN on strict and non-strict sketches. CMS: a forged other throws an UNTAGGED TypeError. Present in 1.1.2. | A real brand check in every `merge`: a private-field brand (`#brand in other`) or a module-scope WeakSet filled by the ctor, so a forgery throws through the tagged `_badMerge` before any read. | A forged prototype instance throws a tagged error with byte-identical state in all four members. H2.7 delta (done): shipped a class-private `#brand` on all four members (D1); `merge` and `_badMerge` test `typeof other === 'object' && other !== null && #brand in other` as the FIRST statement, before any read of `other`. A field copy and a `new Proxy(real, {})` now throw the tagged TypeError (a bare forgery gets the TypeError, not the shape RangeError -- CHANGELOG Changed); the DD `_gamma`-only NaN merge is closed; subclasses still merge. Docs in d.ts / llms / README / ADR 0002-0005; CHANGELOG Fixed + Changed. |

**New gates (N)** (none exist today)

| id | gate | fails on 1.1.2 |
| --- | --- | --- |
| N1 | Float64Array-fed scaling lanes in a child process with `--max-semi-space-size=4`, default AND `--max-inlined-bytecode-size=0`. Each of the 4 addFrom x 6 key classes (small, 2^30+, 2^31+, 2^32-1, -2^31, 2^53-1) x counts {1, 2^30} x fresh/warm must read <= 2 at 8N. | HLL / CMS / SS (no addFrom). DD passes. H2.6 delta (pending qa): the gate ships (240 addFrom lanes + AHF + N1e); q1 pre-measured min 0-2 (gate <= 2); FAILs `=ABSENT` on HEAD via `--lib`. |
| N2 | `add` lanes with Smi-range arguments (small and 2^30+ keys, counts 1 and 2^30), default + no-inline: <= 2. | HLL small 12-13; SS count 2^30 24 |
| N3 | Library-only delta: `add` with keys >= 2^31 minus a no-op baseline receiving the same arguments must be <= 2. | SS 192 vs 24, CMS 49/73 vs 24, HLL 72-104 vs 24 |
| N4 | A calibrated one-box mustFail (Float64Array -> fractional value -> ring store) must read >= 12 at 8N. It ships with `maxScavenges` 64 -> 2 and `SCAV_BOX` 48 -> 0. | HLL add-stream 6, HLL addHashed 30, SS evict 12 (harness, fixed by N7) -- H2.8 delta (done): one box per op in three homes -- PerfGate `oneBoxCtl` (trips at 2, not at 64), torture SCAV-CTRL (30), lanes `N4-CTRL[df/ring]` >= 8 (24); ">= 12 at 8N" became "trips at 2; lanes min >= 8" (the perf low mode is exactly 12). |
| N5 | Deopt-loop gate: a `--trace-deopt` child shows <= 3 `add` deopts per lane. | HLL 416-461 |
| N6 | Headless Chrome lane (`--enable-precise-memory-info` + gc(), default and no-inline): addFrom 0, and `add` <= 12 B per non-Smi argument. Node cannot replace this lane: it never sees 31-bit-Smi boxes. | HLL 77, CMS 113, SS 170 B/op -- H2.8 delta (done): `npm run chrome` (test/chrome/, last in verify, fails closed UNVERIFIED without Chrome); add limits use k = fresh per-op non-Smi boxes per mode. |
| N7 | Driver rule: drivers pass `add` only Smi-range values; full-range keys go only through `addFrom`. | the SS evict / HLL addHashed drivers pass `v >>> 0` -- H2.6 delta (pending qa): torture `ahStep` / `chStep` and PerfGate `addHashedStream` move to `addHashedFrom`, and the PerfGate SS evict driver to `addFrom`; the F9 thresholds stay untouched (H2.8). |
| N8 | Query lanes: SS.forEach with entries >= 2^31 and a non-inlined callback; the Into APIs at 0. | forEach 3130 B/call -- H2.7 delta (done): the `query` lane type ships; `N8[df\|ni/ss.topKInto.n16\|n64/big]` and `N8[df\|ni/dd.quantilesInto.q4]` read 0 (gate <= 2), the `ss.forEach/small` regression guard 0 (gate <= 2), and the controls `Q-CTRL[ni/dd.quantile]` 24 and `FE-CTRL[ni/ss.forEach/big]` 73 (gate >= 12); the 6 Into gates FAIL `=ABSENT` on HEAD via `--lib`. |
| N9 | Parity against `git show HEAD:Sketch.js` (the audit's `parity.mjs` shape): bit-identical estimates across all members, edges, and merges. | n/a (new) |

**Settle calls -- SETTLED 2026-10-04** (binding for every H2 agent, decided after the second
reproduction above):
- **S1** versioning of the F12 hash change (negative keys only). SETTLED: it is a PATCH-class fix
  (the docs already promise distinct negative keys, and there is no serialized format to break). It
  ships INSIDE 1.2.0 (MINOR, because `addFrom` is added), under Fixed with the old/new example
  (`add(-1); add(2**32+1)` counted 1, now 2). No separate 1.1.3: F12 edits the same five murmur sites
  F2 hand-inlines, and splitting them means editing those sites twice for one consumer (lite-hud M3)
  that waits for 1.2.0 anyway. The CHANGELOG says that `mix64` / `hashHi` / `hashLo` lanes change for
  negative keys only, and that positive keys stay bit-identical (`neg << 31` is 0). N9 parity
  asserts both halves. A 1.1.3 is cut only if a consumer needs F12 alone before 1.2.0.
- **S2** ALPHA_MIN for F10. SETTLED: 1e-6, documented, exported as a constant. At the 2^20-bin cap it
  spans only ~8x of value range, and 1.1.2 already builds it in 3 ms. Anything smaller throws tagged
  at the ctor door before the indexable-bound math runs.
- **S3** strict `merge` with a collapsed `other` (F11). SETTLED: reject it, tagged and byte-identical,
  before any write (in the strict pre-scan). A non-strict `this` accepts it and becomes `collapsed`.
- **S4** surfacing CMS saturation (F14). SETTLED: a sticky `saturated` getter, never a hot-path throw.
  It is set on all three clamp branches (cons, plain, merge), carried by `merge` (`other.saturated`
  makes `this` saturated, lesson 7), and reset only by `clear()`. The docs say "one-sided while
  `!saturated`".
- **S5** the count cap (F15). SETTLED: count <= 2^32-1 per call on DDSketch and SpaceSaving (matches
  CMS), plus a MAX_SAFE guard on the running total. The guard covers every `add` / `addFrom` /
  `merge` of CMS, DDSketch and SpaceSaving, since all three reproduce past 2^53. Every rejection is
  tagged and byte-identical. Rejecting a finite count > 2^32-1 that 1.1.2 accepted goes under Changed
  in the CHANGELOG.
- **S6** unattainable `withAccuracy` / `withError` (F16). SETTLED: throw tagged when the request needs
  w > 2^25, d > 32 or k > 2^24. The silent clamp UP (d < 1 -> 1) stays, because it only strengthens
  the guarantee.
- **S7** CMS `merge` across the `conservative` flag. SETTLED: allow it and document it. `this` keeps
  its own flag. The result stays one-sided (the sum of two upper bounds is an upper bound; 0
  undercounts probed), but it is exact only when both sides are plain.

**Checked clean (no task):**
- Byte-identical state after 100+ rejection classes. Queries never throw (Symbol, BigInt, null,
  strings, boxed numbers). An empty DDSketch quantile / min / max reads NaN, not 0.
- HLL within 3 sigma for p >= 8, N 1..1e6, on u32, negative and high-word families.
- CMS 0 undercounts and 0 over-epsilon across ~44k high-bit keys (conservative + plain). The
  lite-hud key shape `ch*2^32 + tag` gives exact estimates, and keys near 2^53 are distinct.
- SpaceSaving vs an exact Map: 400 trials, 20k pairwise merges, 5k chained shard reductions, with 0
  bracket violations, 0 false negatives, and 0 error above N/k. Self-merge, merge after clear and
  capacity 1 are correct.
- DDSketch relative error <= alpha in strict mode and via addFrom.
- Extreme sizes construct without a fatal error (CMS 32 x 2^25, SS 2^24, DD 2^20 bins, HLL p=18);
  p=19, d=64 and w=2^25+1 throw tagged.
- The d.ts matches the runtime exactly. `DDSketch.addFrom` is 0 in every Node and Chrome lane. HLL /
  CMS / DD merge + clear are 0.

**Exit:**
- F1-F19 + N1-N9 green.
- N1-N5 FAIL on 1.1.2, and N4 trips.
- The N9 parity holds except the documented F12 sign change.
- lite-hud M3's 8.2 probe re-run on 1.2.0 reads <= 2 on every addFrom lane, incl. no-inline and
  Chrome.

### 7.1 Session split (short, single-concern sessions; each is planner -> coder -> reviewer -> qa)

Each session leaves a green `npm run verify`, adds gates that FAIL on the code before it, and ends in
the working tree for the maintainer to commit. The version stays 1.1.2 and CHANGELOG `[Unreleased]`
grows until H2.8, which owns the 1.2.0 trinity. The order follows the dependencies:
- validation lands before the add-path restructure that has to carry it;
- the hash rewrite lands before the helpers that consume it;
- the threshold calibration comes last, once every lane can pass it.

| session | scope | main file surface |
| --- | --- | --- |
| H2.1 (done) | F1 + the reusable child-process lane harness (N2-HLL, N5, a one-box control) + the HLL torture lane at 0 | 2 lines of HLL |
| H2.2 (done) | F10, F11, F17 (S2, S3): the DDSketch ctor and merge fail-closed fixes | DDSketch ctor / merge |
| H2.3 (done) | F13, F14, F15, F16 (S4, S5, S6) + F20: counting honesty (estimate guard, `saturated`, count cap, withX throws) and the `String(x)` thrower fix | validation only, no restructure |
| H2.4 (done) | F12 (S1) + the F2 Node part (int32 hash words, `Math.abs` sign split) at all six sites, N9 parity, N3 lanes. The F2 hand-inline moved to H2.6 (7.5 planner delta) | hash sites |
| H2.5 (done) | F3 + F4: argument-free SpaceSaving and CMS helpers, N3 count lanes. SS home's F2 hand-inline landed here (`_homeAt`) | SS / CMS internals |
| H2.6 (done) | F5 + F6: the `addFrom` / `addHashedFrom` family, N1, N7, plus the F2 murmur hand-inline inside `_addAt` (moved from H2.4) and the CMS `estimate` per-row fmix inline (moved from H2.5) | public API (additive) |
| H2.7 (done) | F7, F8, F18, F21: `topKInto` + `quantilesInto`, merge / query cost docs, option bags, forEach, -0, the merge brand check, N8 | cold paths |
| H2.8 (done) | F9 + N4 + N6 (Chrome lane), F19 docs, the 1.2.0 trinity, /release | gates + docs |

### 7.2 H2.1 spec -- F1 + the lane harness  [DONE, committed 980e4fe]

Result: reviewer REJECTED once, then APPROVED. The first rejection found that N5 could pass vacuously
(no positive control) and that the CHANGELOG overclaimed for keys >= 2^31. qa found a1-a7 PASS:
- lanes all 0, CTRL 24, N5 control live (35-52 df / 1056-1258 ni);
- the revert-check on HEAD FAILs with N2 11-13 and N5 514-586 df / 897-990 ni;
- torture HLL add 0, and FAIL (4) with T1 reverted;
- parity 0 diffs;
- verify green with 188 tests (187 pass, 1 todo = F20).
Removing `--trace-deopt` gives N5 VACUOUS -> FAIL. The control floor is 1, since one attributed
bailout proves the trace is live. Carry-over: N6 (H2.8) must measure Chrome after F1. The CHANGELOG's
"~14 B/op" is the pre-F1 Chrome reading.

Why first: it is the smallest code change with the largest measured effect: HLL small keys go
12 -> 0, the deopts 1173 -> 0, and Chrome HLL 14 -> 0 B/op. It also builds the measuring instrument
H2.4-H2.8 reuse. Pre-measured on an F1-patched copy: torture HLL add 4 -> 0 (3 runs) and addHashed
unchanged at 7 (that is caller-side, F6). Tests 182/182. The p 4/12/18 registers are bit-identical
to 1a2673e.

Out of scope (later sessions, do not touch): `SCAV_BOX` / `maxScavenges` values (H2.8), the addHashed
lanes (H2.6), the murmur helpers and the sign fix (H2.4), any other member.

**Tasks**
- **T1 (coder, Sketch.js):** `const hiSuf = (h << p) >>> 0;` -> `h << p` at :320 (`add`) and
  `(hi << p) >>> 0` -> `hi << p` at :341 (`addHashed`). `Math.clz32` reads the same 32 bits, and
  `hiSuf !== 0` has the same truth value. Update the HASH_HI doc comment (:52-58), which cites
  `(x << p) >>> 0`. Nothing else in Sketch.js changes.
- **T2 (coder, new `test/lanes.mjs` + `test/lanes/lane.mjs`):** a parent that spawns ONE child per
  lane with `--expose-gc --max-semi-space-size=4`, in two modes: default and
  `--max-inlined-bytecode-size=0`.
  - Measurement: each child counts minor GCs (PerformanceObserver `gc`, kind minor) over 8N = 1.6M
    ops, after a `gc()`. Keys come from a prefilled Float64Array (65536 entries).
  - `--lib <path>`: run the lanes against another module, for the revert-check.
  - Prints one GATE line and exits 1 on any FAIL.
  - Lanes in H2.1:
    - **N2-HLL:** `add` with key classes small and 2^30+ x fresh/warm x both modes = 8 lanes, each
      <= 2.
    - **N5:** a `--trace-deopt` child in the audit shape: 3 instances at p 4/12/18, called through a
      closure, Float64Array keys in [0, 2^31), 1.6M ops each. It counts `not int32` deopts of `add`,
      gated <= 3. The single-instance loop shows only 4-5, so it is NOT the gate.
    - **CTRL (teeth):** a no-op `add(k)` fed 2^31+ keys in no-inline mode must read >= 12. This
      proves the lane can see one 16 B box per op (measured 24). It is the local precursor of N4.
  - npm script `lanes`, appended to `verify`.
- **T3 (coder, test/torture.mjs):** move `scAdd` (HLL add) from `SCAV_BOX` to `SCAV_CLEAN` in
  `scavOk`. Rewrite the :283-299 comment: the HLL floor was a Maglev deopt loop on `>>> 0`, fixed in
  H2.1, and only the addHashed lanes (caller-boxed uint32 args, F6) still sit on `SCAV_BOX`. Fix the
  PerfGate.test.mjs:215-225 comment the same way (the value 64 stays until H2.8).
- **T4 (coder, new `test/parity.mjs`):** a reusable parity runner, `node test/parity.mjs [ref]`
  (default HEAD).
  - It loads `git show <ref>:Sketch.js` from a temp file and runs the same streams through old and
    new.
  - H2.1 compares HLL registers + `count()` at p 4/12/18 over 600k mixed keys (positive, negative,
    > 2^32) plus `addHashed` lanes.
  - H2.4 extends it into the full N9. It is a pre-commit check, NOT in `verify` (it is vacuous once
    the maintainer commits).
- **T5 (coder, CHANGELOG):** `[Unreleased]` / Fixed: HyperLogLog add / addHashed no longer
  deopt-loop on register suffixes >= 2^31 (~0.5 box/op on small keys -> 0). Output is bit-identical.

**Assertions (qa proves each; a1-a3 also run against `git show HEAD:Sketch.js` via `--lib`)**
- a1: all 8 N2-HLL lanes <= 2 on the new code, and >= 10 on HEAD (12 measured).
- a2: N5 <= 3 on the new code (0 measured), and >= 100 on HEAD (1173 measured).
- a3: CTRL >= 12 on both.
- a4: torture `ok` with HLL add = 0 under `SCAV_CLEAN`. With T1 reverted, torture prints FAIL (HEAD
  reads 4).
- a5: `node test/parity.mjs` shows 0 register diffs and identical `count()` at p 4/12/18.
- a6: `npm test` 182/182 (plus any new tests), perf 9/9, `test:types`, `witness` unchanged, and
  `npm run verify` green.
- a7: `git diff Sketch.js` touches only :320, :341 and the HASH_HI comment. ASCII-only, no new deps,
  pack still 7 files.

Reviewer focus:
- whether `h << p` changes any branch (it must not: clz32 and `!== 0` are sign-agnostic);
- lane flakiness: a1 / a3 margins across 3 runs;
- whether CTRL really runs no-inline;
- whether the lanes read keys from the Float64Array rather than from a closure int.

### 7.3 H2.2 spec -- DDSketch fail-closed: F10 + F11 + F17 (S2, S3)  [DONE, committed 26b6eb3]

Result: the coder hit its turn limit once. The reviewer REJECTED once, for doc truth only: the stale
jsdoc domain and the inverted F17 direction in the CHANGELOG. It then APPROVED. qa found b1-b7 PASS:
- G1 children 35-52 ms on the new code. On HEAD, 1e-17 / 1e-12 / 1e-10 are SIGTERMed at 2 s.
- G3 0 edge failures. HEAD fails 508 / 2490 / 583 / 2417 on qa's grid.
- The ctor at 1e-6 takes 0.0015-0.0018 ms (HEAD 2.36 ms).
- The hot methods are byte-identical.
- 199 tests (198 pass, 1 todo = F20).
Beyond the spec:
- **The `maxIndexable === MAX_VALUE` branch was removed as provably dead.** Since
  `2*gamma^maxK/(gamma+1)` is finite, gamma^maxK <= MAX/2.
- **The orchestrator fixed a pre-existing torture phase 2c flaw.** The baseline was read BEFORE the
  ~310 KB reuse banks were built, so the gate passed only when older garbage was freed inside the
  window, and FAILed under `npm run verify` (abGrowth=317648 = the banks exactly). Now:
  - the banks are built first;
  - `gc(); sleep(50)` x2 runs before both reads;
  - the banks are kept live via SINK;
  - abGrowth reads 0 on every run;
  - per-clear() re-allocating mutants FAIL for all four members (HLL 3276800, CMS 39321600,
    DD 3276800, SS 409600).
Environment note: the perf gate's own DETECTOR self-check flakes ("negative control forced 12
scavenges") on HEAD and the tree alike while an unrelated 10-job soak benchmark loads the machine
(load avg 12-20). Re-run `npm run verify` on a quiet machine before committing.
New finding: F21 (the forged-prototype merge), assigned to H2.7.

Why now: these are the two High fail-closed bugs plus the bound lite-hud M2 pre-checks against.
They are all cold DDSketch code (ctor + merge), so the hot path does not move. They are
independent of the hash work in H2.4-H2.6.

Pre-measured on a scratchpad prototype (`h22proto.mjs`) over 3000 alphas (1e-6..0.1 log-spaced,
0.1..0.9999 linear):
- **F10:** the closed form `K = floor((ln MAX_VALUE - ln 2) / ln gamma)` gives `_maxKeyIndexable`
  IDENTICAL to HEAD at every alpha, with 0 fix-up iterations. The cost at 1e-6 goes 3 ms -> 0.0001 ms.
  The old form added `ln((gamma+1)/2)` instead of subtracting `ln 2`. That overshoots by about
  0.3466/alpha keys, which the decrement loop then walked back one at a time.
- **F17:** bisection over doubles finds all four exact edges in <= 25 steps, with 0 failures.

Out of scope (do not touch):
- `add` / `addFrom` / `_addKey` / `quantile` (the hot path stays byte-identical);
- the option `in` check (F18, H2.7) and `String(x)` in throwers (F20, H2.3);
- the DD count cap (F15, H2.3);
- the README:137 collapse wording (F19, H2.8);
- every other member.

**Tasks**
- **T1 (coder, Sketch.js, F10 + S2):** add `export const DD_ALPHA_MIN = 1e-6;` next to the DD
  constants, with jsdoc. At 2^20 bins it spans only ~8x of value range, which is why it is the floor.
  - The ctor door accepts `DD_ALPHA_MIN <= alpha < 1`. It keeps the typeof-first guard, so a
    non-number is still rejected first. The RangeError message names the domain
    `[1e-6, 1)` (format it from the constant).
  - Replace the max-key closed form with `Math.floor((Math.log(Number.MAX_VALUE) - Math.LN2) / lnGamma)`.
  - Make both fix-ups bidirectional, using the SAME expression `2 * Math.pow(gamma, K) / (gamma + 1)`
    that `quantile` uses. Step down while it is not finite, and step up while K+1 is still finite.
    For the min key: step up while the value < MIN_NORMAL, and step down while K-1 is still >= it.
  - Share ONE iteration cap of 4 per bound. Past the cap, throw a tagged RangeError (lesson 8: a
    fix-up loop needs a cap).
  - Keep the defensive tagged throws for `!(gamma > 1)` and a non-finite multiplier / lnGamma. They
    are unreachable inside the domain, so they are not gated.
- **T2 (coder, Sketch.js, F17):** after the key bounds, compute `_minIndexable` / `_maxIndexable` as
  the EXACT acceptance edges of add's own key expression, `Math.ceil(Math.log(x) * this._multiplier)`,
  using the same `multiplier` value.
  - Min edge: bisect between `pow(gamma, minK-1) * (1 - 1e-9)` and `* (1 + 1e-9)` down to the
    adjacent pair (lo rejected, hi accepted). `_minIndexable = lo`, the EXCLUSIVE floor.
  - Max edge: if `MAX_VALUE` is accepted, then `_maxIndexable = MAX_VALUE`. Otherwise bisect around
    `pow(gamma, maxK)` the same way, and `_maxIndexable` = the last accepted double (INCLUSIVE).
  - Verify the bracket before bisecting, and cap at 80 steps. A broken bracket or an exceeded cap
    throws tagged.
  - Cold, 0 extra allocation (plain doubles; no BigInt, no arrays).
  - Fix the ctor comment that claims "exact bounds", so that it is now true and says how.
- **T3 (coder, Sketch.js, F11 + S3):** in `merge`, after the gamma check and BEFORE the strict
  pre-scan, reject a collapsed other: `if (this._strict && other._collapsed)` throws via a new cold
  `_badMergeCollapsed()`. That is a tagged RangeError saying a strict sketch cannot absorb a
  collapsed sketch's low-end mass. Every rejection stays byte-identical.
  - Past every throw: `if (other._collapsed) this._collapsed = true;`.
  - Update the merge jsdoc: it carries `collapsed`, and strict rejects a collapsed other.
- **T4 (coder, tests in test/DDSketch.test.js, existing style):**
  - **G1 (F10):** a child (`spawnSync` with a 2000 ms timeout per alpha) that constructs at
    1e-17, 1e-12, 1e-10, 2e-9, 1e-7 and `nextDown(1e-6)`. Each must throw a tagged RangeError, and a
    timeout is a FAIL. In process: `DD_ALPHA_MIN === 1e-6`, `new DDSketch(DD_ALPHA_MIN)` builds in
    < 5 ms (take the min of 5 runs), and 0, 1 and NaN still throw.
  - **G2 (F11):** the shard example gives `collapsed === true` and `quantile(0)` unchanged at 742.6.
    A collapsed other into a non-empty non-strict sketch gives collapsed, and `clear()` resets it.
    A strict merge of a collapsed other throws tagged, with a byte-identical snapshot (bins copy +
    count / sum / min / max / zeroCount / collapsed). A strict merge of a non-collapsed in-range
    other still works.
  - **G3 (F17):** the 3000-alpha sweep (the prototype's alpha grid) checks the four edges:
    `add(min)` rejected, `add(nextUp(min))` accepted, `add(max)` accepted, and `add(nextUp(max))`
    rejected unless max === MAX_VALUE. Also check a strict sketch at 3 alphas (same getters).
    `nextUp` is a cold test helper (Float64Array / BigUint64Array view).
  - The existing N1 getter test stays green unchanged.
- **T5 (coder, test/parity.mjs):** add a DDSketch section run against the same ref.
  - Over >= 300 alphas in [1e-6, 0.9999], `_maxKeyIndexable` / `_minKeyIndexable` must be IDENTICAL.
  - Run value streams through non-strict (default and maxBins 64, which collapses), strict, and
    merges of NON-collapsed others: bins, count / sum / min / max / zeroCount / collapsed, and
    quantiles on a q grid must be identical.
  - Documented, allowed differences, which it prints but does not fail on:
    - the minIndexable / maxIndexable getters (F17). For these, assert the new getters pass the
      four-edge check instead.
    - `collapsed` after merging a collapsed other into a non-strict sketch (F11). Bins and quantiles
      there must still be identical.
- **T6 (coder, docs):**
  - Change alpha in (0,1) to `[1e-6, 1)` in Sketch.d.ts (:183, plus a `DD_ALPHA_MIN` export), in
    llms.txt :183 (and the API list), in README :236 (plus the constants table), and in
    decisions/0004-ddsketch.md (a dated H2.2 note covering ALPHA_MIN, collapsed-merge and the exact
    edges).
  - Merge docs: it carries `collapsed`, and strict rejects a collapsed other.
  - CHANGELOG `[Unreleased]`:
    - **Fixed:** the ctor hang (with the times), merge dropping `collapsed` (the shard example), and
      the inexact indexable getters (the counts).
    - **Added:** `DD_ALPHA_MIN`.
    - **Changed:** alpha < 1e-6 now throws (it was accepted before, slowly, and hung below about
      1e-10). A strict merge of a collapsed other now throws.

**Assertions (qa proves each; b1, b3, b4 also run against `git show HEAD:Sketch.js`)**
- b1: G1 passes on the new code. On HEAD the 1e-12 / 1e-10 children time out, so the test FAILs.
- b2: T5 parity: keys identical at every alpha, and all streams and merges identical except the two
  documented differences.
- b3: G2 passes on the new code and FAILs on HEAD (collapsed false; the strict merge is accepted).
- b4: G3 shows 0 edge failures on the new code. On HEAD there are thousands (2402 / 598 / 526 / 2472
  measured).
- b5: the ctor at 1e-6 takes < 5 ms. The ctor at 0.01 is not slower than HEAD by more than 0.05 ms
  per call (median over 1000).
- b6: `npm run verify` green: tests 188 + new, torture / lanes / perf / witness unchanged.
- b7: the Sketch.js diff touches only the DD constants, the ctor, merge and one new thrower. The
  hot-path methods are byte-identical to HEAD (diff them). ASCII-only, no deps, pack 7 files.

Reviewer focus:
- Is the bisection predicate EXACTLY add's (`ceil(log(x) * this._multiplier)`, same multiplier)?
- Are the exclusive / inclusive conventions right?
- Is the max = MAX_VALUE branch right?
- Can the strict-collapsed check ever let a partial write through (ordering vs the pre-scan)?
- Do the caps throw rather than silently clamp?
- Can G1 flake on a slow machine? (5 ms vs 0.0001 ms; the 2 s child timeout.)

### 7.4 H2.3 spec -- counting honesty: F13 + F14 + F15 + F16 (S4, S5, S6) + F20  [DONE, committed e805ac8]

Result: the reviewer REJECTED twice, then APPROVED; qa found c1-c8 PASS.
- **Rejection 1 (HIGH, an orchestrator miss):** the new guards pushed DD `add` from 445 to 483
  bytecode bytes and `addFrom` from 435 to 465. Both crossed V8's 460-byte inline cap, so a fractional
  `dd.add(x)` boxed its argument: N7 `add(value)` went 0 -> 15. Torture still printed `ok` because
  that lane was print-only. The spec's "no torture change needed" was wrong; the prototype had already
  shown the 15.
  - Fix: `!Number.isFinite(value)`, plus the count cap and total guard folded into one branch with a
    cold `_badCount` dispatch. Now add is 448 bytes and addFrom 449; messages and rejections unchanged.
  - New gate: torture gates N7 `add(value)` <= 2 (SCAV_ADD_INLINE). It FAILs at 15 on the 483-byte
    shape and under `--max-inlined-bytecode-size=440`.
  - The bytecode of every changed hot method was measured; none crossed 460. SS.add was already over
    460 on HEAD (680 -> 721).
  - The same round fixed a stale d.ts "always" line, asserted the F16 rounding preconditions, and
    added a checked parity DOC-DIFF line.
- **Rejection 2 (LOW, gate teeth):** `/33554432/` and `/16777216/` also matched the constructor's own
  messages, so the withX off-by-one mutants survived. They now match `/width cap/` / `/capacity
  cap/`. A new DD G-F20b pins the non-finite `_badValue` path.
- **qa added 4 cases:** the CMS merge total guard runs before the saturated carry (a mutant otherwise
  survived), a self-merge at the 2^53-1 ceiling for all three members, the `_badTotal` text, and the
  read-only `saturated`.
- **Numbers:** 217 tests (0 todo). On HEAD, 24 of the planner tests fail. Torture is `ok` x5 with N7
  add(value) = 0. Perf 9/9, lanes ok, witness byte-identical to HEAD. Parity: HLL / DD / CMS / SS /
  messages identical, DOC-DIFF 7/7. The hot-set diff is exactly the 8 methods; HLL hot bytecode is
  identical (338/171).
- **Watch:** DD add / addFrom sit at 448 / 449 vs 460. N7 guards `add`; `addFrom` losing inlining
  costs only call overhead, not boxing. Re-measure if H2.5 / H2.6 grow either body.

Why now: every finding here is validation or disclosure, with no restructure. It has to land before
H2.5/H2.6 restructure the add paths that will carry it. F14 and F15 break the headline claims
("NEVER undercounts", "exact running aggregates"). F20 breaks the tag law in all four members. The
hash sites do not move (F2/F12 are H2.4).

Pre-measured (HEAD 26b6eb3, Node 26.8.2):
- **F13:** on CMS(4,1024), after `add(0,50); add(1,70)`: `estimate(Infinity)` = 50, `(1.5)` = 70,
  `(2**64)` = 50 (Infinity and 2^64 alias key 0; 1.5 aliases key 1).
- **F14:** `add(5,2**32-1); add(5,10)` gives estimate 4294967295 and total 4294967305, on both the
  cons and plain paths.
- **F15:** SS `add(1,1e308)` x2 gives total Infinity and `heavyHitters(0)` returns []. DD
  `add(1,2**60)` x2 is accepted. CMS 2^21+2 adds of (1, 2^32-1) give total 9007207842578432.
- **F16:** `withAccuracy(1e-12,0.01)` gives epsilon 8.1e-8, `(0.01,1e-20)` gives d=32, and
  `withError(1e-9)` gives k=2^24.
- **F20:** `Object.create(null)` gives an untagged TypeError, a throwing toString replaces the tag,
  and a re-entrant toString mutates reg[0]. 35 `String(` call sites on 34 lines (H2.2 added two).
- **Prototype** (the T2-T4 hot guards on a copy of HEAD): torture `ok` with 0 B/op on all 9 lanes and
  SCAV 0 on every clean lane, perf 9/9, lanes ok. Tests 197 pass / 1 fail: DDSketch.test.js:625,
  which pins the old behavior that S5 changes.
- **Boundary doubles (verified by the orchestrator):** `ceil(e/(e/2^25))` = 2^25 and
  `ceil(e/nextDown(e/2^25))` = 2^25+1; `ceil(ln(1/exp(-31.5)))` = 32, `exp(-32.5)` gives 33;
  `ceil(1/2^-24)` = 2^24 and `ceil(1/nextDown(2^-24))` = 2^24+1; `e/5e-324` = Infinity.
- **Exactness:** `total + count > 2^53-1` is exact for total <= 2^53-1 and count <= 2^53-1, because
  rounding is monotonic and 2^53 is representable. This also covers the merge guards.

Hot body vs cold path. Exactly 8 hot methods change bytes:
- CMS `add` / `addHashed` (+1 total-guard line each), `estimate` (guard widened to add's),
  `_applyCons` / `_applyPlain` (the clamp branch gains `this._saturated = true`);
- DD `add` (count cap + total guard), `addFrom` (total guard);
- SS `add` (count cap + total guard).

Every other hot method stays byte-identical (HLL add / addHashed, CMS estimateHashed, DD _addKey /
quantile, SS estimate / _hash / _probe / _bump / _attach / _detach / _mapDelete). Each new hot value
(`this._total + count`, `this._count + count`) is a register temp compared in place; the only new call
is the cold `_badTotal` on the reject path; `_saturated` stores a boolean constant. No torture change
is needed.

Out of scope (do not touch):
- the murmur and sign bit (H2.4); helper arguments (H2.5); addFrom / addHashedFrom (H2.6);
- option bags, forEach, -0 and the merge brand check (F18/F21, H2.7), including `Array.isArray` on a
  revoked Proxy (CMS / DD / SS option checks) and `instanceof` running a Proxy trap in DD addFrom;
- thresholds (F9, H2.8) and the README:137 collapse wording (F19);
- SS `estimate` (it compares keys exactly, so it has no F13 alias). SS "never undercounts a monitored
  key" (llms ~:302, ADR 0005:93) stays true and is not edited.

**Tasks**
- **T1 (coder, Sketch.js, F20):** one module-scope cold `function _describe(x)` after `saltRow`.
  - `typeof` first. A string returns itself. `object` returns `x === null ? 'null' : '[object]'`.
    `function` returns `'[function]'`. Anything else returns `String(x)` (number / boolean /
    undefined / bigint / symbol run no user code).
  - It never reads a property, never calls `Array.isArray`, never touches x beyond `typeof` / `===`.
  - Replace all 35 `String(` call sites with it (HLL 4, CMS 11, DD 13 incl. both in `_badBuf`, SS 7).
    Fix the comments that cite String (:404, :790, :1535, :2013). Exactly one `String(` call survives,
    inside `_describe` (`hashString(` matches a naive grep).
  - For every primitive argument the message text stays byte-identical to HEAD.
- **T2 (coder, Sketch.js, F13):** CMS `estimate`'s guard becomes add's own: `typeof key !== 'number'
  || key !== key || !Number.isInteger(key) || Math.abs(key) > 9007199254740991` returns 0. Jsdoc: a
  key `add` would reject estimates 0.
- **T3 (coder, Sketch.js, F14 + S4):**
  - Ctor: `this._saturated = false;` is the LAST field, after `_total`.
  - `_applyCons`: `if (target > CMS_MAX_COUNT) { target = CMS_MAX_COUNT; this._saturated = true; }`.
    `_applyPlain` gets the same on `v`. An exact 2^32-1 does not set it.
  - `merge`: `let sat = other._saturated;`, each clamp sets `sat = true`, and after the loop
    `if (sat) this._saturated = true;`. `clear()` resets it.
  - `get saturated()` (O(1)) after `total`, jsdoc: sticky; while false, estimate is one-sided.
  - Class jsdoc: "NEVER undercounts" becomes "one-sided while `!saturated`".
- **T4 (coder, Sketch.js, F15 + S5):** literals stay in the hot bodies, as with `9007199254740991`.
  - CMS `add` / `addHashed`: `if (this._total + count > 9007199254740991) return this._badTotal(count);`
    right after the count check, before the hash.
  - DD `add`: the count check gains `|| count > 4294967295`, then
    `if (this._count + count > 9007199254740991) return this._badTotal(count);` BEFORE the
    `value < 0` line, so before the zero-branch write.
  - DD `addFrom`: `if (this._count + 1 > 9007199254740991) return this._badTotal(1);` after the
    NaN/Infinity check.
  - SS `add`: count cap + total guard after the count check, before the hash.
  - Merges, all before the first write: CMS after the brand/shape check (`this._total +
    other._total`); DD after the strict pre-scan, before the "Past every throw" line (`this._count +
    other._count`); SS right after the brand check, before `minThis` and the Map build.
  - A new cold `_badTotal(n)` per class: a tagged RangeError naming 2^53-1, printing the current total
    (DD: count) and `_describe(n)`.
  - DD / SS `_badCount` messages become "count must be an integer in [1, 4294967295]", like CMS.
  - Update the add / merge jsdocs of all three classes.
- **T5 (coder, Sketch.js, F16 + S6):**
  - `withAccuracy`, after the domain checks: `w = Math.ceil(Math.E / epsilon)`; if `w > CMS_W_MAX`
    throw a tagged RangeError naming epsilon and 33554432 (2^25). Then `d = Math.ceil(Math.log(1 /
    delta))`; if `d > CMS_D_MAX` throw a tagged RangeError naming delta and 32. Both throws come BEFORE
    the round-up loop; Infinity from a denormal also throws.
  - Delete the w clamp, its comment and the d > 32 clamp. Keep `if (d < 1) d = 1`.
  - `withError`: `k = Math.ceil(1 / epsilon)`; if `k > SS_CAP_MAX` throw tagged, naming epsilon and
    16777216. Fix both jsdocs.
- **T6 (coder, tests, existing per-member files and style; each new gate FAILs on HEAD):**
  - **G-F13 (CMS):** the pre-measured sequence on cons + plain. `estimate` of Infinity, -Infinity,
    1.5, 2**64, 2**53 and -(2**53) is 0; keys 0 / 1 still read 50 / 70.
  - **G-F14 (CMS):** fresh false; after `add(5,2**32-1)` false; after `add(5,10)` true (cons and
    plain). A merge clamp sets it; a saturated other carries it into an empty `this`. Sticky after more
    adds; `clear()` gives false.
  - **G-F15:**
    - DD and SS count cap: `add(k,2**32-1)` accepted; `2**32`, `1e308` and MAX_SAFE throw tagged with
      a byte-identical snapshot, and the message contains `[1, 4294967295]`.
    - Total N/N+1, one fill per member: 2^21 adds of (k, 2^32-1) then `add(k, 2**21-1)` give total
      === 2^53-1 (accepted). Then each entry point throws tagged with a byte-identical snapshot: CMS add
      + addHashed; DD add(v), add(0), addFrom; SS insert / bump / evict.
    - Merge (CMS / DD / SS): `this` at total 2^53-6 rejects an other of total 6 byte-identically and
      accepts an other of total 5 (result 2^53-1).
  - **G-F16:** each boundary first asserts its own double-rounding precondition.
    - CMS rejects: `withAccuracy(1e-12,.01)` and `(1e-9,.01)` (< 2000 ms); `(5e-324,.01)`;
      `(nextDown(Math.E/2**25),.5)`; `(.01,1e-20)`, `(.01,1e-300)`, `(.01,Math.exp(-32.5))`,
      `(.01,5e-324)`.
    - CMS accepts: `(Math.E/2**25,.5)` gives w === 2**25; `(.01,Math.exp(-31.5))` gives d === 32;
      `(.01,0.999999999999999)` gives d === 1.
    - SS rejects `withError(1e-9)`, `(5e-324)`, `(nextDown(2**-24))`; accepts `withError(2**-24)`
      with capacity 2**24.
  - **G-F20 (all 4 files):** hostile args, each with a `calls` counter: (a) `Object.create(null)`;
    (b) toString / valueOf that throw `boom`; (c) toPrimitive / toString / valueOf that mutate the
    receiver AND a second instance; (d) a function with a mutating toString. Slots:
    - HLL: ctor p, seed; add; addHashed hi, lo.
    - CMS: ctor d, w, `{seed}`, `{conservative}`; withAccuracy eps, delta; add key, count; addHashed
      hi, lo, count.
    - DD: ctor alpha, `{maxBins}`, `{range: H}`, `{range:[H,5]}`, `{range:[1,H]}`; add value, count;
      addFrom buf, i.
    - SS: ctor capacity, `{seed}`; withError; add key, count.
    - Each throw is tagged, both snapshots byte-identical, `calls === 0`, and one null-proto message
      per class ends in `got [object]`.
  - **G-S7 (CMS, a pin, not a behavior change):** merges cons<-plain and plain<-cons (d=4, w=64, 5000
    adds over 500 keys) are accepted, `this.conservative` is unchanged, 0 undercounts vs an exact Map,
    and `saturated` is false. It passes on HEAD by design; its teeth are a mutant that rejects the
    merge or flips the flag.
  - **Existing tests that change (rewrite, never delete):**
    - DDSketch.test.js:625 (accepted `add(5, MAX_SAFE)`): 2^32-1 accepted; 2^32 and MAX_SAFE throw
      byte-identically.
    - CountMinSketch.test.js:286 (asserted the clamp to 2^25): throws tagged in < 2000 ms, keeping the
      no-hang regression.
    - CountMinSketch.test.js:294: `dTiny.d === 1` stays; 1e-300 now throws.
    - SpaceSaving.test.js:535: 1e-9 throws; 2**-24 gives 2^24.
    - HyperLogLog.test.js:580-593: drop `todo`, fix the comment, make it the HLL G-F20.
    - CountMinSketch.test.js:386: add the missing `assert.equal(d.estimate(1.5), 0)`.
    - CountMinSketch.test.js:255/262/269: add `saturated` false-before / true-after.
    - SpaceSaving.test.js:433 and the DD bad-count matrix gain `2**32`, `1e308` and MAX_SAFE.
    - Header comments: CMS items 6/8, and SS. No existing test asserts on array or object message
      text, so `'[object]'` touches no other test.
- **T7 (coder, test/parity.mjs, H2.3 section, against the same ref):**
  - CMS: cons + plain at (4,1024) and (5,4096); seeded integer-key streams (small / negative /
    > 2^32 / near-MAX_SAFE classes), counts in [1, 2^32-1] with total < 2^53, plus addHashed lanes.
    Identical: `_counts`, `total`, `estimate` on every added key + 10k random integers, and merges
    plain<-plain, cons<-plain, plain<-cons.
  - DD: non-strict / maxBins 64 / strict, counts <= 2^32-1, through `ddSnap`: identical.
  - SS: capacity 1/7/64/1000 with evictions + merge: `_key` / `_count` / `_error` [0, size), total
    and `topK()` identical.
  - Messages: for primitive bad args (numbers, strings, booleans, undefined, null, Symbol, BigInt) at
    every thrower, new message === ref message, except DD/SS `_badCount`.
  - Documented diffs (printed; each checked new-side only): estimate of non-integer / non-finite /
    > MAX_SAFE keys is now 0; counts > 2^32-1 and totals > 2^53-1 rejected (tagged + byte-identical);
    `saturated` is new; withX unattainable inputs throw; non-primitive messages print `[object]`;
    a doubly-invalid DD add (negative value + over-cap count) now names the count.
- **T8 (coder, docs, never VERSION):**
  - Sketch.d.ts: "one-sided while `!saturated`" + the S7 note; withAccuracy throws when w > 2^25 or
    d > 32; CMS count domain, total guard, `saturated` carried by merge, cross-flag merge allowed; new
    `readonly saturated: boolean`; clear resets it; DD count [1, 2^32-1] + total guard; withError
    throws; SS add domain and merge doc. test/types gets `const sat: boolean = cms.saturated` plus a
    `@ts-expect-error` write.
  - llms.txt: every CMS "never undercounts" line, a `saturated` line, the withX lines, the DD count
    domain (:211 `[1, 2^53)` becomes `[1, 2^32-1]`), the SS count domain, the total guard.
  - README: :92 / :120 ("can never undercount"), the S7 note, withX, rejected-key estimates 0,
    `cms.saturated`, the DD / SS count domain; grep long lines for `undercount|clamp|one-sided`.
  - ADRs: 0003 a dated H2.3 note (item 3 "while `!saturated`" + S7; item 4's clamp replaced by the
    S6 throw; item 5 gains `saturated` + the total guard); 0004 and 0005: the S5 cap and the S6 throw.
  - CHANGELOG `[Unreleased]`: **Fixed** F13, F14, F15, F16, F20 (each with its HEAD example);
    **Added** `CountMinSketch.saturated`; **Changed** DD/SS count > 2^32-1 throws, totals past 2^53-1
    throw on add / addFrom / merge of all three counted members, withAccuracy / withError throw
    instead of clamping, non-primitive args print `[object]` / `[function]`, the DD/SS count message
    text, and the doubly-invalid precedence.

**Assertions (qa proves each; c1-c5 also run against `git show HEAD:Sketch.js` with the tests copied
to the scratchpad and the import repointed, and must FAIL there)**
- c1: G-F13 passes. On HEAD it reads 50 / 70 / 50 and FAILs.
- c2: G-F14 passes. On HEAD `saturated` is undefined and it FAILs.
- c3: G-F15 passes, with total === 9007199254740991 accepted and +1 rejected at every entry point and
  every merge. On HEAD all are accepted and it FAILs.
- c4: G-F16 passes, each reject in < 2000 ms. On HEAD the clamped instances return and it FAILs.
- c5: G-F20 passes with `calls === 0` in all four members and every slot. On HEAD the throws are
  untagged / `boom`, calls > 0, and it FAILs. `grep -nE '(^|[^A-Za-z_])String\(' Sketch.js` prints
  exactly 1 line.
- c6: `node test/parity.mjs` shows HLL ok, DD ok, and H2.3 at 0 diffs on accepted streams, with
  primitive-message parity. Only the documented diffs are printed.
- c7: torture `ok`, unchanged, over 3 runs: 9 measureAllocs lanes at 0 B/op; SCAV_CLEAN lanes and
  the N7 addFrom lane = 0; phase 2b maxMajor 0; trackers return to 0; abGrowth <= 0. Perf 9/9 and
  `npm run lanes` ok.
- c8: the hot-set byte diff vs HEAD is exactly the 8 methods above (HLL byte-identical except its 4
  throwers). ASCII-only, no deps, pack 7 files, VERSION '1.1.2'. `npm run verify` green with 199 +
  new tests and 0 todo; witness unchanged.

Reviewer focus:
- Does every guard precede EVERY write (the DD zero branch, all three SS paths, each merge)?
- Is `_saturated` initialized last and set only on a real clamp?
- Does `_describe` touch x beyond `typeof` / `===`? Does any implicit `'' + x` of a caller value
  remain in a throw path?
- Is each boundary precondition asserted rather than assumed?

RISK: a forged `other` (F21) can still run caller code through `this._total + other._total` in the
new merge guards. That class is pre-existing and owned by H2.7.

### 7.5 H2.4 spec -- hash sign bit (F12, S1) + int32 hash words (F2, Node part) + N9 parity + N3 lanes  [DONE, committed de7ecaf]

Result: the reviewer REJECTED once, then APPROVED; qa found d1-d7 PASS.
- **Rejection (HIGH, gate robustness):** the single-window default-mode (df) lanes FAILed 3/3 runs
  under machine load (load average ~10 on 12 cores: reads of 3-4 against <= 2). A single window
  includes the caller's tier-up, and starved background compilation stretches it.
  - Fix: every gated lane and its Noop baseline run 3 reps as separate children, every rep is
    printed, and the gate is on the MIN. Tier-up noise only adds scavenges, while a real library box
    shows in all 3 reps: HEAD and a Math.abs-revert mutant read 25/25/25 and 49/50/49.
  - The cms / cmsest df lanes read 0-2 on HEAD too, so they are labelled regression guards; the
    ni / nc deltas are their teeth.
  - CHANGELOG units were fixed (scavenges at 1.6M ops, not "per-op").
- **qa additions:**
  - two-word negative classes in the parity oracle; a two-word-only mutant was invisible to the
    old one-word oracle;
  - a CMS estimate site check (the old site test passed with only estimate mutated);
  - a per-key fresh-instance HLL site check;
  - an SS add-vs-`_hash` home check;
  - boundary injectivity and bit-flip-twin hash tests.
- **Numbers:**
  - 236 tests (0 todo).
  - ni / nc library deltas 0 (one 1) in every run; NC-CTRL 24.
  - df min-of-3 0-1, and hll/n31 1-3 against its live limit of 26.
  - `--lib HEAD` FAILs 19 gates.
  - Parity: identity sections at 0 diffs, DOC-DIFF F12 11/11, H2.3 7/7.
  - Torture ok x4, perf 9/9, witness byte-identical (sha1 2ed81a8b).
  - Bytecode: HLL add 338->335, CMS add 365->362, estimate 368->364, SS add 721->714,
    `_hash` 115->109, mix64 158->164; the helpers are unchanged.
  - `npm run lanes` takes +7 s (4 jobs) / 29 s serial.
- **Known harness gaps (recorded, not fixed):**
  - parity.mjs has no watchdog: a broken SS hash makes its SS identity section spin forever instead
    of FAILing. The unit tests do kill both SS mutants.
  - df/hll/n31 bites HEAD only narrowly (HEAD min 27 vs limit 26). The ni / nc lanes carry that site.
  - About 10% of single df reps land in the high mode (24-26), so a 3/3-high lane is a ~1% false-FAIL
    risk per run. If a lane ever reads high 3/3, classify each rep with `--trace-turbo-inlining`;
    never raise the limit.

Why now: F12 is a live correctness bug in HLL / CMS. Today `add(-1); add(2**32+1)` counts 1, while the
docs already promise distinct negative keys (README:349, llms:103/154, d.ts:68/149, jsdoc :307/:639).
The hash words must settle before H2.5's helpers and H2.6's `_addAt` consume them. The Node part of
F2 is the smallest shape that removes every library box at the hash sites while keeping `add`
inlinable.

Pre-measured (HEAD e805ac8, Node 26.8.2, Chrome 154; prototypes and numbers in the session scratchpad
`h24/facts.md`; the chosen prototype is v1a):
- **F12:**
  - HEAD: the pair counts 1; 20000 distinct (-i, 2^32+i) count 10023; CMS `add(-7,100)` gives
    `estimate(2**32+7)` = 100.
  - v1a: 2 / 20009 / 0.
  - Positive keys: 0 diffs over 300k keys in 6 classes (HLL p 4/12/18, CMS cons+plain, SS cap
    1/7/64/1000, mix64 lanes).
- **Scavenges at 8N.** Noop baseline: df 0, ni 24, nc 24.
  - nc means a never-optimized caller, so `add` is compiled standalone with its helpers inlined:
    the "big consumer frame" case.

  | method | HEAD ni b31/n31/safe | HEAD nc | HEAD df n31 | v1a |
  | --- | --- | --- | --- | --- |
  | HLL add | 49/73/49 | 25/50/25 | 48 | ni 24, nc 24, df <= 1 (n31: 24) |
  | CMS add | 49/73/49 | 25/49/25 | 1 | ni 24, nc 24, df 0 |
  | CMS estimate | 49/73/49 | 25/49/25 | 2 | ni 24, nc 24, df 1 |

  - The v1a HLL df n31 = 24 is the caller's own box. Under the 920-byte cumulative budget, `add` is
    not inlined into the lane loop: HLL add 335 + four `_m3round` at 109 + two `_m3final` at 71 is
    about 913. With the budget raised to 4000 it reads 2 (HEAD 5).
  - SS add on v1a: 49 / 99 / 49 (F3, H2.5).
- **Bytecode (HEAD -> v1a):** HLL add 338 -> 335, CMS add 365 -> 362, CMS estimate 368 -> 364,
  SS add 721 -> 714 (never inlined), mix64 158 -> 164, `_m3round` 109, `_m3final` 71. DD add (448)
  is untouched.
  - Correction to facts.md: the helpers are NOT under V8's 27-byte small-function size. They inline
    under the 460 cap and spend the cumulative budget.
- **Chrome:**
  - default and nc: v1a == HEAD.
  - ni: HEAD HLL 60 / CMS 126 / SS 161 B/op; v1a the same for small / b30 keys and +12 for negative
    keys, because `neg << 31` crosses the non-inlined `_m3round` as a non-Smi.
- **Rejected variants:**
  - v2a (full hand-inline into `add`): over 460 bytes, so add is no longer inlined and Node df
    non-Smi keys go 0-1 -> 24.
  - v1L (one `_mixLane` helper): Chrome default SS add 6 -> 18 B/op and CMS estimate 0 -> 6
    (measured, cause unconfirmed).
  - v1 without `Math.abs`: n31 stays 49 in ni / nc. The old `let a = key; if (a < 0) a = -a;` makes
    `a` a phi of the tagged parameter and a float64, which boxes.

Planner delta (recorded in the 7.1 table and on the F2 row; S1 is untouched):
- H2.4 = F12 + the F2 Node part (int32 words + the `Math.abs` sign split).
- The F2 hand-inline of the murmur and the two-compare guard move to H2.6, inside F5's
  `_addAt(buf, i)`. Its arguments are an object and a Smi, so it never needs to be inlined.
- N6 stays with H2.8. Chrome no-inline is recorded, not gated, until H2.6 / H2.8.
- Note: F12 has six code sites (SS add and SS `_hash` are separate), not five. Only S1's "editing
  the sites twice" rationale is affected, not its outcome.

Hot body vs cold path. Exactly 6 hot methods change bytes: `mix64` (sign only), HLL `add`, CMS `add`,
CMS `estimate`, SS `add`, SS `_hash`.
- At the 5 member sites:
  - `const neg = key < 0 ? 1 : 0; const a = Math.abs(key); const lo = a | 0;`
  - `const hiw = a < 4294967296 ? 0 : ((a / 4294967296) | 0);`
  - the second round takes `hiw ^ (neg << 31)`.
- The guard line stays verbatim: typeof first, and `Math.abs(key) > 9007199254740991` stays inside
  the short-circuit chain. Hoisting `a` above it would run `Math.abs` on a non-number, an F20
  regression. Every throw site and message is unchanged.
- Zero-box: `lo`, `hiw`, `neg` and the xor word are int32 (a Smi on Node) when they cross
  `_m3round`. `a` is a float64 local that never crosses a call.
- mix64 keeps its own word math (`>>> 0`, `(a-lo)/2^32`) because it accepts non-integers.
- Positive parity proof:
  - `_m3round` starts with `Math.imul(k, C1)`, which is ToInt32, so `a | 0` and `a >>> 0` feed the
    same bits;
  - for a <= 2^53-1, a/2^32 < 2^21, so truncating equals flooring;
  - `neg << 31` is 0 for every non-negative key, and -0 takes neg 0 on both builds.

Out of scope:
- the murmur hand-inline and the two-compare guard (H2.6);
- F3 / F4 helper arguments and the per-row `_m3final` (H2.5);
- addFrom / addHashedFrom (H2.6);
- N6 / Chrome gates and thresholds (H2.8);
- any count or validation semantics;
- the DD hot path;
- torture / perf thresholds.

**Tasks**
- **T1 (coder, Sketch.js):** apply the site shape above at the 5 member sites:
  - HLL add :320-336;
  - CMS add :653-673;
  - CMS estimate :754-768;
  - SS add :1725-1740;
  - SS `_hash` :1958-1970.

  The guards stay byte-identical, and `_m3round` / `_m3final` are unchanged.
- **T2 (coder, Sketch.js `mix64`):** `hi ^ neg` -> `hi ^ (neg << 31)` at :119 and :125, with nothing
  else in the body changed. Jsdoc: the sign is bit 31 of the high word, which is free because a safe
  integer's high word is < 2^21.
- **T3 (coder, test/lanes.mjs + test/lanes/lane.mjs, N3):**
  - **lane.mjs:**
    - `fillKeys` gains u32 = 2^32-1-65536+i, n31 = -(2^31)-65536+i, safe = 2^53-1-65536+i.
    - New kinds:
      - `cms`: `add(K[i&MASK], 1)` on CMS(5,16384) cons;
      - `cmsest`: `sink += c.estimate(K[i&MASK]) > 0 ? 1 : 0`;
      - `ss`: `add(K[i&MASK], 1)` on SS(1024).
    - Flag `--nc`: dynamically import a new `test/lanes/natives.mjs`
      (`export function neverOpt(f) { %NeverOptimizeFunction(f); }`) only in nc mode, and call
      `neverOpt(step)` before warm-up. The df / ni children run without `--allow-natives-syntax`,
      so the `%` call cannot live in lane.mjs.
  - **lanes.mjs:** after the untouched N2 / N5 / CTRL block, run the N3 jobs through an execFile pool
    of 4 (`N3_JOBS` env, default 4; 1 = serial). Results are keyed and gated in a fixed order.
    - Jobs, fresh only (56 children; the df lanes run R=3 children each, see the review amendment):
      - {hll, cms, cmsest} x {b31, u32, n31, safe} x {df, ni, nc};
      - Noop x 4 key classes x {ni, nc};
      - ss x 4 key classes x 3 modes.
    - Gates:
      - `N3[ni|nc/kind/kc] = lane - noop(same mode, kc) <= 2` (24 lanes).
      - `N3[df/kind/kc] <= 2` (11 lanes). Review amendment: gated on the MIN of 3 children, every value
        printed. A single fresh window includes the caller's tier-up, which starved background compilation
        stretches under load (3/3 runs FAILed at 3-4). Lanes that read 1-2 on HEAD are labelled regression
        guards; the ni / nc deltas are the teeth for those sites.
      - `N3[df/hll/n31] <= noop(ni,n31) + 2`, taken from the LIVE Noop lane. Its comment: under the
        default cumulative budget, the caller boxes its own read, and the library adds 0. HEAD's 48
        (caller + library) FAILs. Tighten to <= 2 when addFrom lands.
      - `NC-CTRL[noop/kc] >= 12` (4 lanes). A never-optimize that silently fails reads 0 and trips it.
    - Print-only:
      - `noop-ni[kc]`;
      - `SS[mode/kc]=v (print-only: F3, gated in H2.5)`.
- **T4 (coder, tests in the existing per-member files; each G-F12 FAILs on HEAD):**
  - **Hash G-F12:**
    - over 1e5 pairs (-(H*2^32+L), (H^1)*2^32+L), both lanes differ for every pair;
    - `mix64(-0,s)` equals `mix64(0,s)`;
    - golden positive vectors, cut from `git show HEAD:Sketch.js` BEFORE the edit, are pinned as
      literals: k in {0, 1, 2^31, 2^32-1, 2^32, 2^32+1, 2^53-1, 1.5}, at two seeds;
    - negative vectors (-1, -(2^31), -(2^32+1), -(2^53-1)) are pinned from the new code.
  - **Site consistency (passes on HEAD too; catches a missed site):** for mixed-sign keys:
    - HLL `add(k)` and `addHashed(hashHi(), hashLo())` after `mix64(k, seed)` give identical `_reg`;
    - CMS `add(k,c)` and `addHashed(...)` give identical `_counts`;
    - SS `_hash(k) === (mix64(k, seed), hashHi() | 0)`.
  - **HLL G-F12:** `add(-1); add(2**32+1)` gives `count() === 2`. 10000 pairs (-i, 2^32+i) at p=14
    give |count - 20000| <= 488 (3 sigma).
  - **CMS G-F12 (cons + plain, (4,1024)):** `add(-7,100)` gives `estimate(2**32+7) === 0` and
    `estimate(-7) === 100`.
  - **SS G-F12:**
    - `_hash` differs on all 1e4 pairs (HEAD: all equal);
    - the home-slot share at capacity 1024 is < 1% (HEAD 100%);
    - `add(-1); add(2**32+1)`: both estimate 1, their homes differ, and 2**32+1's probe distance is 0
      (HEAD 1).
    - Extend SpaceSaving.test.js:703 beyond +-big.
- **T5 (coder, test/parity.mjs, the N9 section):**
  - Re-key the identity sections so they stay identical:
    - H2.1 HLL: the `-(i*7919)` class moves to a separate negative instance;
    - CMS: `keyClass` r===1 becomes b31 / u32, and the random estimate ints become [0, 2e6);
    - HLL / CMS / SS cover small, b31, u32, exactly 2^32, > 2^32, near MAX_SAFE and 2^53-1, plus
      merges;
    - mix64 / hashHi / hashLo over non-negative ints, fractions, +Infinity, NaN and -0;
    - hashString and saltRow;
    - SS mixed-sign streams: the observable snapshot (`ssSnapP`, merge) stays identical, because slots
      and buckets are hash-independent. Print the count of differing `_mapOcc` positions.
  - DOC-DIFF F12 (checked on the new side, ref printed):
    - pairs that differ on both lanes: 1e5/1e5 (ref: all collide);
    - every negative int key's (hi,lo) differs from ref;
    - HLL pair count 2 (ref 1);
    - CMS `estimate(2**32+7)` 0 (ref 100);
    - the negative-instance HLL / CMS state differs from ref.
  - The H2.3 DOC-DIFF stays 7/7.
- **T6 (coder, docs, never VERSION):**
  - CHANGELOG `[Unreleased]` **Fixed**:
    - F12: old/new pair count 1 -> 2, 20000 pairs 10023 -> ~20000, CMS 100 -> 0. The sign is bit 31
      of the high word. `mix64` / `hashHi` / `hashLo` lanes change for NEGATIVE keys only (incl.
      -Infinity); positive keys and -0 stay bit-identical. SS was exact but shared home slots.
    - F2-Node: HLL / CMS add and CMS estimate no longer box the hash words for |key| >= 2^31.
      No-inline 49 (-2^31 keys: 73) -> 24, which is the caller's argument box and remains until
      addFrom (1.2.0). Default -2^31 HLL 48 -> 24.
    - Amend the H2.1 entry if it claims "hand-inlining".
  - **Changed:** none.
  - Wording:
    - "truncate/alias under `>>> 0`" becomes "under the 32-bit word split" in jsdoc :309 / :641,
      llms :108 / :163 and README :349;
    - the d.ts mix64 @param says integers with |key| <= 2^53 hash with their sign, and the lanes
      changed for negative keys in 1.2.0.
  - ADR 0001: a dated H2.4 amendment covering:
    - the encoding `(a|0, hiw ^ (neg<<31))`;
    - the old bit-0 collision;
    - S1;
    - the hand-inline deferred to H2.6, with the measured reason.

**Assertions (qa; d1-d3 also run against `git show HEAD:Sketch.js` via `--lib` or the tests copied with
the import repointed, and must FAIL there)**
- d1: all 24 N3 ni / nc deltas are <= 2 (0 expected), and NC-CTRL >= 12. On HEAD the ni deltas are
  25 / 49 / 25 / 25 and nc n31 is 25-26, so it FAILs. N2 / N5 / CTRL are unchanged.
- d2: N3 df min-of-3 <= 2 on 11 lanes, and hll/n31's min sits under its live limit (Noop ni + 2). It
  reads 2-3 when V8 inlines `add` into the caller and 24 when it does not. HEAD's 48-50 FAILs. Stable
  over 3 loaded `N3_JOBS=4` runs.
- d3: every G-F12 passes on the tree and FAILs on HEAD. The site-consistency tests pass on both.
- d4: `node test/parity.mjs`: every identity section at 0 diffs, DOC-DIFF F12 all yes, H2.3 still 7/7.
- d5 (bytecode, HEAD -> tree): HLL add, CMS add and CMS estimate each stay <= their HEAD size (and
  <= 460). SS add is recorded. `_m3round` / `_m3final` are unchanged. The hot-set diff is exactly the
  6 methods.
- d6: torture `ok` x3, unchanged:
  - 9 lanes at 0 B/op;
  - SCAV_CLEAN lanes 0, and N7 DD add(value) <= 2;
  - maxMajor 0;
  - trackers return to 0.
- d7: perf 9/9, witness byte-identical, and `npm run verify` green with 217 + new tests and 0 todo.
  `npm run lanes` grows by <= 15 s. ASCII-only, pack 7 files, VERSION '1.1.2'.

Reviewer focus:
- Is the guard byte-identical and typeof-first at all 5 member sites?
- Does any site still read `hiw ^ neg`?
- Do mix64's positive non-integer lanes stay unchanged?
- Is the hll/n31 df limit taken from the live Noop lane?
- Are NC liveness and the d1 / d2 margins stable over 3 runs with `N3_JOBS=1` and `=4`?
- Does any changed hot method grow past its HEAD bytecode size?

RISK: Chrome no-inline negative keys read +12 B/op, which is recorded and not gated. The H2.6
hand-inline in `_addAt` removes it. Chrome default is unchanged.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

### 7.6 H2.5 spec -- argument-free SpaceSaving + CMS helpers (F3, F4) + N3 count lanes  [DONE, committed b4e378f]

Result: the reviewer REJECTED once (doc truth only), then APPROVED; qa found e1-e7 PASS.
- **Rejection (doc truth):** the `_hash` / `_probe` / class jsdoc and ADR 0005 described one home in
  two copies with the cold callers passing a raw `_hash`. There are three bit-identical copies
  (`_hash`, the `add` inline, `_homeAt`), and every production caller passes the home. CHANGELOG /
  ADR "bit-identical to the prior release" became "to the pre-H2.5 build (de7ecaf, which already
  carries F12)": 1.1.2 is pre-F12.
- **Orchestrator fix (parity):** the H2.4 F12 block assumed a pre-F12 ref, so it FAILed against the
  default ref once de7ecaf landed. It now picks by the ref's own behavior: all 1e5 pairs collide ->
  DOC-DIFF, all separate -> negative-key IDENTITY, partial -> FAIL. The H2.5 section runs mixed-sign
  keys against an F12 ref and non-negative keys against a pre-F12 ref, and qa asserts its one-pair
  probe agrees with the 1e5-pair verdict. `parity.mjs` and `parity.mjs e805ac8` both exit 0.
- **Numbers (min of 3, scavenges at 1.6M ops):**
  - G1 SS add ni / nc deltas 0-1 (HEAD 73-75 / 25). G2 SS df 24-25 vs a live limit of 26 (HEAD 49).
  - G3 SS count 2^30 small 0 / 0 (HEAD 24). G4 SS bump with a variable count 2^31 1 / 0 (HEAD 25).
  - G5 CMS cons / plain variable count 2^31 df 0 / 0 (HEAD 24). CV-CTRL 24.
  - `--lib HEAD` FAILs exactly the 18 new gates; every H2.4 gate holds on both builds. Stable over
    3 runs at N3_JOBS=4 and 1 at N3_JOBS=1.
  - The six single-site revert mutants FAIL 10 / 4 / 2 / 2 / 1 / 1 gates.
  - 251 tests (0 todo). Parity H2.5 section 636,951 checks, 0 diffs. Torture ok x3, perf 9/9, witness
    sha1 2ed81a8b on tree and HEAD. Bytecode as pre-measured; CMS estimate / estimateHashed and SS
    `_probe` / `_hash` source byte-identical.
- **Known gaps (recorded, not fixed):**
  - Synchronous-spin risk: a hash-corrupting SS mutant makes a test without a per-op `_mapOcc`
    watchdog spin forever (`--test-timeout` cannot interrupt it). Every H2.5 test is watchdogged; the
    older SS tests are not audited.
  - Reading `prevB` before `_detach` in the bump is defensive, not observable (`_detach` never
    rewrites a freed bucket's `_bPrev`), so no gate pins that order.
  - G2's margin is 1-2 over the caller-box floor (24-25 vs 26), and min-of-3 can hide one real box in
    a single lane (mutant m1, nc/safe read 25/49/49 -> 25). The ni lanes carry those sites.
  - CMS add df with a CONSTANT count 2^32-1 on b31/n31/safe keys still reads 9-13 (HEAD too), for
    H2.6 / H2.8.

Why now:
- F3 is lite-hud's case. Once a per-key count passes 2^31 (cumulative microseconds), SS `add` boxes
  inside the library on every bump and every eviction. No-inline lanes with keys >= 2^31 read 98-99,
  which is 4x the caller's own box.
- H2.6's `_addAt(buf, i)` / `addFrom` will call these helpers. If a key or count read from a
  Float64Array crosses `_attach` / `_applyCons` as an argument, it boxes, and N1 (<= 2) cannot pass.
  Making the helpers argument-free first means H2.6 only has to change the entry point.

Pre-measured (HEAD de7ecaf, Node 26.8.2, Chrome 154). Prototypes and numbers are in the session
scratchpad `h25/facts.md`; the chosen prototype is p3. Scavenges at 8N, min of 3; the Noop floor is in
brackets.

| lane | HEAD | p3 |
| --- | --- | --- |
| SS add c1, b31/n31/safe, ni [24] | 98-99 | 24-25 |
| SS add c1, non-Smi, nc [24] | 49-50 | 24-25 |
| SS add c1, non-Smi, df [noop ni 24] | 25-96 | 24-25 |
| SS add c2^30 small, ni / df [0] | 24 / 24 | 0 / 0 |
| SS hitv c2^31v, ni, small / b31 [24 / 49] | 49 / 74 | 25 / 49 |
| CMS cons / plain addv c2^31v, df [0] | 24-25 | 0-1 |
| CMS add c1 / c2^30 / est, ni / nc | floor | floor (H2.4) |

- **Parity:** p3 vs HEAD shows 0 diffs over 508,200 checks (CMS cons + plain; SS capacity
  1/7/64/1000; merges; counts >= 2^31).
- **Bytecode (HEAD -> p3):**
  - CMS: `add` 362 -> 378, `addHashed` 201 -> 217, `_applyCons` 222 -> 307, `_applyPlain` 150 -> 224.
    `estimate` 364 and `estimateHashed` 168 are unchanged.
  - SS: `add` 714 -> 790 (never inlined either way), `_attach` 274 -> 285, `_mapDelete` 165 -> 154,
    `merge` 804 -> 773.
  - New: `_homeAt` 359 (its arguments are an object and a Smi, so it never needs inlining) and
    `_probeAt` 76.
  - `_probe` stays 71: with the refinement below it is byte-identical to HEAD.
- **Chrome (recorded, not gated):**
  - df: CMS add c30 b30/neg 6 -> 0 B/op; SS add c1 6 -> 0.1; SS add c30 18 -> 0.
  - ni: SS add 161/173 -> 36; CMS add 126 -> 60 (the rest is add's own `_m3round` / `_m3final`
    calls, which H2.6 removes).
- **Rejected:** p1's helper-call `_homeAt` (Chrome ni SS add 143 vs 36 B/op). p1's estimate fmix
  inline (364 -> 422) is deferred to H2.6: 422 plus H2.6's own bytes would crowd the 460 cap.
- **HEAD observations, not changed by p3 and out of scope:**
  - CMS est df on non-Smi keys is bimodal per rep (1 or 24): the caller's box when `estimate` is not
    inlined under the 920 cumulative budget. The min-of-3 rule absorbs it.
  - CMS add df with a CONSTANT count of 2^32-1 and b31/n31/safe keys reads 9-13 on HEAD, p1 and p3
    alike (warm too; count 2^31 reads 0-1). This is outside the N2/N3 count domain {1, 2^30}.
    Candidate for H2.6 or H2.8.

Hot body vs cold path:
- **Hot bytes change in:** CMS `add`, `addHashed`, `_applyCons`, `_applyPlain`; SS `add`, `estimate`,
  `errorOf`, `_attach`, `_mapDelete`. New: `_homeAt`, `_probeAt`. Removed: `_bump`, `_mapDeleteKey`.
- **Byte-identical:** CMS `estimate` / `estimateHashed`, SS `_hash` and `_probe` (code). Every guard
  line and every throw stays byte-identical; the diff starts below the `_badTotal` line.
- **Cold path:** the CMS ctor gains `_base` Int32Array(1) and `_cnt` Float64Array(1) (allocated at
  construction only). SS `merge` changes only its `_attach` / `_probe` call forms.
- **Zero-box:**
  - CMS: `base` lives in an Int32Array slot and `count` in a Float64Array slot. The helpers take no
    arguments and return `this`.
  - SS: every helper argument and return is a Smi or an object; `_homeAt` returns `h & _mask`, which
    is a Smi in Chrome too.
  - The one double still crossing in SS `add` is `_probe(key, home)`. That is the caller's own tagged
    argument passed on, with no new box (p3 ni b31 = Noop floor).

Out of scope:
- CMS / SS estimate rework, including the per-row fmix inline in `estimate` (H2.6, through the F5
  scratch).
- The HLL/CMS `add` murmur hand-inline and the two-compare guard (H2.6 `_addAt`). Note: SS home's F2
  site is done here, in `_homeAt`. H2.6's `_addAt` must probe with `_probeAt(buf, i, home)`, because a
  key read from a buffer would box crossing `_probe`.
- `_cnt` vs F4's "Float64Array(2)": H2.6 may fold `_cnt` into F5's key/count scratch.
- N6 / Chrome gates, torture and perf thresholds (F9), and the F19 doc sweep (all H2.8).
- Any semantics change.

**Tasks**
- **T1 (coder, Sketch.js CMS):**
  - ctor :566-568: add `_base` / `_cnt` after `_idx`. Keep `_idx`'s "per-row flat-index scratch"
    comment on `_idx` (p3 moved it onto `_cnt`).
  - `add` :676-678 and `addHashed` :697-699: write `this._base[0] = h ^ g` (resp. `hi ^ lo`) and
    `this._cnt[0] = count`, then call `_applyCons()` / `_applyPlain()` with no arguments.
  - `_applyCons` :708 / `_applyPlain` :733: read `const base = this._base[0], count = this._cnt[0];`
    and hand-inline the per-row fmix exactly as in p3. It must be bit-identical to
    `_m3final((base ^ Math.imul(i, ODD_CONST)) | 0)`.
  - Jsdoc: say why the helpers are argument-free.
- **T2 (coder, Sketch.js SS), p3 text with ONE refinement:**
  - `add` :1741-1776:
    - compute `const home = h & this._mask;` and call `_probe(key, home)`;
    - inline the bump: read `prevB = _bPrev[_cBucket[sl]]` BEFORE `_count[sl] += count` and
      `_detach`, as HEAD's `_bump` did;
    - insert: `_attach(sl, -1)`;
    - evict: `_mapDelete(_probeAt(_key, sl, _homeAt(_key, sl)))`, then `_attach(sl, prevB)`, then
      re-probe with `_probe(key, home)`.
  - `estimate` :1785, `errorOf` :1798 and `merge` :1924: call `_probe(key, this._hash(key) & this._mask)`.
  - Refinement: `_probe` :1977 keeps `let i = h & mask` (idempotent on a home), so the tests at
    SpaceSaving.test.js:858/:883 that pass a raw `_hash` run unmodified. Only its jsdoc changes
    ("a `_hash` or a home").
  - New `_homeAt(arr, i)`: HI-lane murmur hand-inlined, with the same neg / `Math.abs` / lo / hiw
    split as `_hash`.
  - New `_probeAt(arr, i, home)`.
  - `_mapDelete` :2008: use `_homeAt(mkey, j)`.
  - `_attach(slot, hint)` reads `const val = this._count[slot];`.
  - Delete `_bump` and `_mapDeleteKey` together with their jsdoc. p3 leaves an orphaned `_bump`
    jsdoc, puts `_mapDeleteKey`'s jsdoc on `_homeAt`, and `_attach` still documents `@param val`.
  - Class jsdoc :1569: the canonical home is `_hash & _mask`, with two bit-identical, site-tested
    copies (the add inline and `_homeAt`).
- **T3 (coder, test/lanes/lane.mjs + test/lanes.mjs, N3 count lanes):**
  - **lane.mjs:**
    - flags `--count C` (a constant closure count, default 1), `--countv C` (count read from a
      Float64Array, `CS[i] = C + (i & 7)`) and `--hit` (key index `i & 511` on SS(1024), so every op
      is a bump);
    - new kind `cmsp` (CMS(5,16384) plain);
    - `Noop.add(k, c)` reads both arguments, and every counted kind passes the Noop the same count
      expression;
    - the step closure is chosen at setup and never branches on the mode. The H2.4 lanes are
      unchanged (count 1 is a Smi).
  - **lanes.mjs gates.** Every gated lane and its Noop run 3 reps; every rep is printed; the gate is on
    the MIN. Never raise a limit.
    - G1 `N3[ni|nc/ss/kc]` (kc in b31/u32/n31/safe): lane - noop(same mode, kc) <= 2. 8 gates, teeth;
      the existing Noop lanes are reused.
    - G2 `N3[df/ss/kc]`: min <= the LIVE vmin(noop/kc/ni) + 2. 4 regression guards: SS add is > 460
      bytes, so the df floor is the caller's box.
    - G3 `N3c[ni|df/ss.c30/small]`: min <= 2 (every argument is a Smi). 2 gates, teeth.
    - G4 `N3c[ni/ss.hitv31/small|b31]`: lane - noop.hitv31(ni, kc) <= 2. 2 gates, teeth.
    - G5 `N3c[df/cms.v31/small]` and `N3c[df/cmsp.v31/small]`: min <= 2. 2 gates, teeth.
    - `CV-CTRL[noop.hitv31/small] >= 12`: proves the variable count really crosses as a non-Smi.
    - Drop the SS print-only line.
  - **Cost:** +48 children (144 -> 192). Expected about +3-4 s at N3_JOBS=4 and about +10-12 s serial.
- **T4 (coder, tests; these pass on HEAD too because they are parity-type, and the FAIL-on-HEAD teeth
  are the lanes):**
  - SpaceSaving.test.js, evict/backshift vs an exact Map:
    - capacity 7 and 64, 20k ops over mixed-sign keys incl. the boundary matrix at :867;
    - counts from {1, 2^30, 2^31+(i&7), 2^32-1};
    - after EVERY op:
      - the `_mapOcc` population === `size`, which also acts as the spin watchdog;
      - every slot is found via `_probe(key, _hash(key))`;
      - `_bVal[_cBucket[sl]] === _count[sl]`, with buckets ascending from `_minBucket`;
      - `total` is exact;
      - est - err <= true <= est.
  - `_attach` ordering: on capacity 3, three equal counts of 2^31, then a 4th key and a bump. Pin the
    evicted key and the topK / error literals, cut from `git show HEAD:Sketch.js` BEFORE the edit.
  - A `_homeAt` / `_probeAt` identity test, new-code only: for every slot,
    `_homeAt(_key, sl) === (_hash(_key[sl]) & _mask)`, and `_probeAt` maps back to `sl`.
  - CountMinSketch.test.js, cons + plain at (7,64):
    - one `add(k, 2**31+5)` fills exactly the d cells whose columns an in-test reference fmix32
      computes (same for `addHashed`);
    - then `add(k, 2**31)` gives estimate 2^32-1 and `saturated === true`;
    - two interleaved instances agree with solo-built twins.
- **T5 (coder, test/parity.mjs):** a new "H2.5 F3/F4 identity" section, compared with HEAD.
  - CMS (1,1) (4,1024) (7,64), cons + plain:
    - add / addHashed with counts {1, 2^30, 2^31+j, 2^32-1} over the posKey classes plus negatives
      (HEAD already has F12);
    - compare `_counts`, total, saturated, estimate / estimateHashed and merges incl. a saturated other.
  - SS capacity 1/7/64/1000 with evictions, merge and post-merge adds:
    - compare the FULL pools: key / count / error, `_mapOcc` / `_mapKey` / `_mapSlot`, every bucket
      and free-list array, `_minBucket`, `_bFreeTop`, plus topK / estimate / errorOf;
    - a tree-side per-op `_mapOcc` population check FAILs before the table can fill and spin. This
      closes the H2.4 watchdog gap for this section.
- **T6 (coder, docs; never VERSION):**
  - CHANGELOG `[Unreleased]` **Fixed**, with the qa min-of-3 numbers in "scavenges at 1.6M ops":
    - F3: SS add no-inline with keys >= 2^31 goes 98-99 -> 24 (the caller's argument box; 1.1.2 read
      195). Small keys with count 2^30 go 24 -> 0 (default and no-inline). A variable count >= 2^31
      goes 49 -> 25 (the caller's count box). Default-tier non-Smi keys stay at the caller's box until
      addFrom lands. State is bit-identical.
    - F4: CMS add / addHashed default tier with a variable count >= 2^31 goes 24-25 -> 0-1 (cons and
      plain). Estimate is unchanged (H2.6). State is bit-identical.
  - ADR 0005: a dated H2.5 amendment. The ":39-41 one function" claim now reads as one home in two
    bit-identical, site-tested copies; it also covers the inlined bump and `_attach` reading `_count`.
  - ADR 0003: a dated H2.5 amendment covering the `_base` / `_cnt` scratch, argument-free helpers, and
    the per-row fmix inlined, with estimate deferred.
  - README / llms / d.ts: no change. Checked: they name no private helper and make no SS / CMS
    internal-box claim.
  - ROADMAP:
    - F3 row delta: HEAD after H2.4 reads 98-99, and `_homeAt` IS F2's "SS home" hand-inline, done
      here.
    - F4 row delta: its gate was met by H2.4's int32 words. The remaining Node box was a variable count
      crossing `_applyCons` in df. The estimate fmix inline moves to H2.6, and the scratch is
      Float64Array(1).
    - The 7.1 H2.6 row gains "estimate per-row fmix inline".
    - H2.5 is marked done with a Result block after qa.

**Assertions (qa; e1-e3 and e6 also run against `git show HEAD:Sketch.js` via `--lib` or a repointed
copy, and must FAIL there)**
- e1: G1 deltas <= 2 (0-1 expected). HEAD shows ni 74-75 and nc 25-26, so it FAILs.
- e2: G3 <= 2 (0 expected; HEAD 24). G4 deltas <= 2 (0-1; HEAD 25). G5 <= 2 (0-1; HEAD 24-25).
  CV-CTRL >= 12 (24) on both builds. G2 min <= the live limit (24-25 vs 26).
- e3: `--lib HEAD` FAILs >= 14 new gates. Every H2.4 gate and NC-CTRL still passes on both builds.
  Stable over 3 runs at `N3_JOBS=1` and `=4`.
- e4: `node test/parity.mjs`: every existing section at 0 diffs; the H2.5 section at 0 diffs over
  >= 500,000 checks; the watchdog is silent. The new unit tests pass on the tree and on HEAD (except the
  identity test, which is new-code only).
- e5: bytecode. CMS `add` <= 460 (378 expected) and the CMS helpers <= 460. `estimate` 364 /
  `estimateHashed` 168 and their source are byte-identical, and `_probe` / `_hash` code is
  byte-identical. `_bump` and `_mapDeleteKey` are absent.
- e6: 6 single-site revert mutants each FAIL at least one new gate:
  - evict passes `_key[sl]` as an argument -> G1;
  - backshift goes back to `_hash(mkey[j])` -> G1;
  - `_attach(val)` at the evict site -> G3;
  - `_attach(val)` at the bump site -> G4;
  - `_applyCons(base, count)` -> G5 cms;
  - `_applyPlain(base, count)` -> G5 cmsp.
- e7: torture `ok` x3, unchanged:
  - 9 lanes at 0 B/op;
  - SCAV_CLEAN lanes 0;
  - `maxMajor` 0, `maxPauseMs` 4;
  - `tracker.size()` returns to 0 over the HLL/CMS/DD/SS build-fill-clear cycles;
  - N7 DD <= 2.

  Also: perf 9/9, witness byte-identical (sha1 2ed81a8b), `npm run verify` green with 236 + new tests
  and 0 todo, ASCII-only, pack 7 files, VERSION '1.1.2'.

Reviewer focus:
- Is every guard and throw byte-identical?
- Does every `_attach` caller write `_count[slot]` first?
- Is the bump's `prevB` read before `_detach`?
- Do `_homeAt`'s constants match `_m3round` / `_m3final` (0xe6546b64, rotl 15/13, `^ 8`)?
- Is `_probe` unchanged?
- Is there any orphaned or stale jsdoc?
- Are all df limits min-of-3, with G2 taken from the LIVE Noop and no limit raised?

RISK: the G2 / G4 margins are +1-2 over the caller-box floor, so a 3/3-high rep set false-FAILs about
1% of runs. If that happens, classify the reps with `--trace-turbo-inlining`; never raise the limit.

### 7.7 H2.6 spec -- the addFrom / addHashedFrom family (F5, F6) + the F2 hand-inline in _addAt + N1 + N7  [DONE, committed e7c70f7]

Result: the reviewer REJECTED once (6 blockers), APPROVED after the fixes, and APPROVED a post-qa fix;
qa found f1-f3 and f5-f7 PASS. The f4 and f8 "FAILs" are unmeasurable figures, not gate failures (below).
- **Rejection:**
  - **Gate without teeth:** a `_badArgs` checking the count first passed every test. TEETH tests now
    pin HEAD's exact class + message for six (key, count) pairs in CMS and SS, plus HLL bad keys.
  - **Fail-open addHashedFrom:** a Proxy over a Uint32Array, or a subclass overriding `length`, fed
    undefined / NaN / 2^40 / -1.5 lanes that were coerced to int32 and written. Each lane is now read
    once and rejected through addHashed's `_badLane` unless uint32 or int32, before any write (bytecode
    277 / 306; f6's bound relaxed to < 460 by the orchestrator).
  - **Mislabelled lane:** the CMS constant 2^32-1 lane ran under `--max-inlined-bytecode-size=120`;
    it is now `N3c[cap120/...]`, F5 wrapper-size teeth (HEAD 24, tree 1; 0-1 on both builds in the
    default tier). An F2 revert (CMS `_addAt` back on the helpers) is NOT gated in Node; F2's win is
    Chrome no-inline B/op.
  - **Doc truth:** CHANGELOG numbers now cite the shipped gates; the N1e and hll/n31 comments and ADR
    0001's "every copy" claim are corrected.
- **Post-qa fix (reviewed):** SS `addFrom` (D1) wrote `_buf[0]` before reading `buf[i+1]`, so a Proxy
  re-entering `add` on the same sketch replaced the key (est 0 vs 5). Both slots are now read into
  locals before the scratch write (SS addFrom 110 bytes); a regression test fails on the old form.
- **Numbers (scavenges at 1.6M ops, min of 3 where gated):**
  - N1: all 240 addFrom lanes <= 2 on rep 1 in 5 runs (histogram ~{0:185, 1:50, 2:3}); AHF 0 (8/8);
    AH-CTRL 49; N1e 0.
  - Tightened / new teeth: G2 SS add df non-Smi 1 (HEAD 24-25); cap120 cmax 1 (HEAD 24); hll/n31 df 1
    (HEAD 2-24).
  - `--lib HEAD` FAILs 256 gates (248 ABSENT + 4 G2 + 3 cmax + 1 hll/n31), exit 1, no unhandled
    rejection. Every H2.1-H2.5 gate holds. Stable over 3 runs at N3_JOBS=4 and 1 at N3_JOBS=1.
  - Each of the 6 f7 mutants FAILs a gate or test; so do the count-first `_badArgs`, the fail-open
    lane and the two-store addFrom mutants.
  - 301 tests (0 todo). Parity: the H2.6 section reports 732,028 checks with 0 diffs, against HEAD
    and against e805ac8. Torture ok x4 (scAh / scCh now 0 through addHashedFrom), perf 9/9, witness sha1
    2ed81a8b on tree and HEAD.
  - Bytecode: add 44 / 74 / 74; CMS estimate 40; addFrom 65 / 71 / 110; addHashedFrom 277 / 306;
    `_addAt` 624-751 and `_estimateAt` 883 (never inlined, (object, Smi) arguments). Byte-identical vs
    HEAD: addHashed, estimateHashed, merges, the apply helpers, the murmur helpers, SS map helpers.
  - `npm run lanes` 26-27 s at N3_JOBS=4, 94 s serial.
- **Known gaps (recorded, not fixed):**
  - f4: the committed parity runner stops at the first diff, so the M3_ADD+1 mutant's diff count
    (93,099) is measured only by the scratch `h26/par.mjs`; the runner does FAIL it.
  - f8: PerfGate prints pass / fail only, so the two new driver reads are not recorded; torture's
    scAh / scCh measure the same addHashedFrom path at 0.
  - The add-message TEETH tests also call addFrom, so they FAIL on HEAD for a second reason; the
    literals were checked against HEAD by hand and by the reviewer.
  - Bytecode sizes and the byte-identical list are checked in scratch only (no committed gate); the
    cap120 lane is the only committed wrapper-size guard.
  - The SS hit-ring fresh-window transient (2-3 in df, first 200k ops) stays ungated.

Why now:
- F5 is lite-hud's case. Its CMS key `ch*2^32 + tag` is a non-Smi on every channel >= 1, and its count
  passes 2^31. Today both are boxed by the caller at any non-inlined `add`. H2.5 made every helper
  argument-free, so the only remaining step is the entry point.
- The H2.4 deferral (F2 hand-inline) and the H2.5 deferral (CMS `estimate` per-row fmix) both resolve
  inside `_addAt` / `_estimateAt`. Their arguments are (object, Smi), so it does not matter that they
  are > 460 bytes and never inlined.

Pre-measured (HEAD b4e378f, Node 26.8.2, Chrome 154). The prototypes are in scratchpad `h26/`
(`facts.md`); the chosen one is q1 (orchestrator DECISION). Scavenges at 8N, min of 3; the floor is in
brackets.

| lane | HEAD | q1 |
| --- | --- | --- |
| addFrom HLL / CMS / CMSp / SS, 6 kc, counts, fresh+warm, df + ni [0] | absent | 0-1 / 0-1 / 0-1 / 0-2 |
| addFrom nc [driver's own read box 24 / 49] | absent | 24-25 / 49-50 |
| SS add c1 non-Smi, df [noop ni 24] | 25 | 1 |
| SS add variable c2^31, df | 25-49 | 1-2 |
| HLL add n31, df | 2 | 0-1 |
| CMS estimate non-Smi keys, df | 1 or 24 (bimodal) | 0 |
| CMS add constant c2^32-1, small/b31/n31/safe, df | 0/9/9/9 | 0/1/1/1 |
| every add, ni / nc, non-Smi | caller floor | caller floor (delta 0-1) |

- **Chrome ni B/op:** HLL add 60-72 -> 0, CMS add c30 60-72 -> 0, CMS est 120-132 -> 0, SS add c30
  36-48 -> 0.2, every addFrom 0. N6's targets already hold; the gate stays H2.8.
- **ns/op df:** HLL add 4.7-6.7 -> 6.2-7.3 (one real call; accepted). CMS add 47 -> 49, CMS est
  24 -> 25, SS add 95 -> 92, SS est 16 -> 18. No README / llms / CHANGELOG line cites ns/op, and there is
  no `benchmark/` dir.
- **Parity:** q1 vs HEAD shows 0 diffs over 350,841 checks, incl. negative keys. The `M3_ADD+1` mutant
  gives 93,099 diffs. Error identity holds for 15 bad keys x 13 counts x 2 members + 12 bad counts.
- **Bytecode (HEAD -> q1):**
  - `add`: HLL 335 -> 44 (+ `_addAt` 624), CMS 378 -> 74 (+ 719), SS 790 -> 74 (+ 751).
  - CMS `estimate` 364 -> 35 (+ `_estimateAt` 853). SS `estimate` 88 -> 103.
  - New: `addFrom` 65 / 71, `addHashedFrom` 197 / 204.
- **Known transient (not gated):** SS add / addFrom on a 512-key HIT ring with a variable count >= 2^31
  reads 2-3 in df, all of it in the first 200k ops (tier-up of the 751-byte `_addAt`). Steady state is
  0, there is no deopt loop, and `--no-maglev` reads the same. No N1 lane uses the hit ring, and G4 is
  ni-only.

Planner deltas to q1 (accepted by the orchestrator):
- **D1 (fail-closed):** SS `_addAt` reads `buf[i]` three times (the guard, `_homeAt`, `_probeAt`). A
  `Proxy` over a Float64Array, or a SharedArrayBuffer view a worker writes, passes `instanceof` and can
  change value between reads, storing a key under another key's home. Fix: SS `addFrom` copies
  `buf[i]`, `buf[i+1]` into `this._buf` and calls `_addAt(this._buf, 0)`. HLL / CMS read each slot once.
- **D2 (guard parity):** CMS `addHashedFrom` uses addHashed's count guard verbatim
  (`!Number.isInteger(count) || count < 1 || count > CMS_MAX_COUNT`).
- **D3 (zero-box):** `_estimateAt` writes `mn` into `this._buf[1]` and returns nothing; `estimate`
  returns `b[1]`. Otherwise a cell min >= 2^31 boxes on the non-inlined return in df.
- **CMS addHashedFrom shape:** 3 slots `[hi, lo, count]`, i.e. `addHashed(hi, lo, count)` with every
  argument read unboxed; a fixed count of 1 would push a counted stream's count back across a call. An
  Int32Array caps count at 2^31-1 (documented).

Hot body vs cold path:
- **Hot bytes change in:**
  - `add` on HLL / CMS / SS becomes a typeof-only wrapper that writes `_buf` and calls `_addAt(buf, 0)`.
  - New `_addAt` x3: numeric guards with the two-compare range check, then the murmur hand-inlined
    (k1 / k2 computed once and folded into both lanes, `M3_ADD`), then the member's update.
  - CMS `estimate` becomes a wrapper plus `_estimateAt` (per-row fmix inlined).
  - SS `estimate` / `errorOf` go through `_buf` + `_homeAt` / `_probeAt`; SS evict re-probes with
    `_probeAt(this._key, sl, home)`.
  - New: `addFrom` x3 and `addHashedFrom` (HLL, CMS).
- **Byte-identical:** `addHashed` x2, `estimateHashed`, every `merge`, `_applyCons` / `_applyPlain`;
  `mix64` / `_m3round` / `_m3final` / `hashString` / `saltRow`; SS `_hash` / `_probe` / `_homeAt` /
  `_probeAt` / `_mapDelete` / `_attach` / `_detach`; every existing throw message.
- **Cold path:** the ctor gains `_buf` (HLL Float64Array(1), CMS / SS Float64Array(2)); module const
  `M3_ADD`; cold throwers `_badArgs` (CMS / SS; replays HEAD's guard order), `_badBuf` x3 and
  `_badHashBuf` x2 (DDSketch `_badBuf`'s shape and wording).
- **Zero-box:** the wrappers (<= 74 bytes) inline into the caller, so key and count land in `_buf`
  unboxed. `_addAt` / `_estimateAt` take (object, Smi) and return `this` / nothing (D3). In ni / nc the
  caller still boxes its own non-Smi argument to `add`; that is what addFrom exists for.

Out of scope: N6, the F9 thresholds (`SCAV_BOX` 48, `maxScavenges` 64), F19's sweep of existing
"0 B/op" lines, the Sketch.js header :8 (all H2.8). Returned-double boxes in ni and the Into APIs (F8,
H2.7). An `estimateFrom`. SS addHashed(From). demo/ drivers. Any semantics change.

**Tasks**
- **T1 (coder, Sketch.js HLL):** `M3_ADD` after `ODD_CONST`; ctor `_buf` after `_hist`; `add` becomes the
  q1 wrapper; add `addFrom`, `_addAt`, `addHashedFrom` (`buf[i] | 0`, `buf[i+1] | 0`, needs
  `i + 1 < length`); `_badBuf` / `_badHashBuf` before `_badKey`. Jsdoc: `addFrom` gets a full
  DDSketch.addFrom-style block; add's "murmur INLINED into int32 locals" text moves onto `_addAt`; the
  class jsdoc names addFrom / addHashedFrom.
- **T2 (coder, Sketch.js CMS):** ctor `_buf` after `_cnt`; `add` becomes the wrapper plus `_badArgs`
  (replays HEAD add's guards exactly); `addFrom` (`i + 1 < length`) and `_addAt` (`_base` / `_cnt`
  written only after all three guards); `addHashedFrom` 3-slot with D2; `estimate` becomes the wrapper
  plus `_estimateAt` with D3; throwers; jsdoc as T1.
- **T3 (coder, Sketch.js SS):** ctor `_buf` after `_mapSlot`; `add` wrapper plus `_badArgs`; `addFrom`
  with D1; `_addAt` from q1 (the evict re-probe comes AFTER `_key[sl] = key`); `estimate` / `errorOf`
  via `_buf`; `_badBuf`. Class jsdoc: THREE home copies become TWO (`_hash` serves merge placement and
  the tests; `_homeAt` serves every hot site incl. estimate / errorOf).
- **T4 (coder, test/lanes/lane.mjs + test/lanes.mjs):**
  - lane.mjs: `--from` (`F[0] = K[i & MASK]`, `F[1] = CS ? CS[..] : CNT`, then `addFrom(F, 0)`);
    `--hfrom` (a prefilled Uint32Array of stride 2 / 3, `hi = 2^31 + j`, `lo = (hi ^ 0x5bd1e995) >>> 0`,
    then `addHashedFrom(U, j * stride)`; CMS count slot 1); `--prefill C` (cmsest: every key added with
    count C first); a missing method prints `{"absent": name}` and exits 0.
  - lanes.mjs: `scavJob` carries `warm`. ABSENT resolves to a FAIL gate valued `ABSENT`, never a crash,
    never rerun.
  - **N1** `N1[mode/member.cnt/kc/warm]`: HLL (24), CMS / CMSp / SS x {c1, c30, v31} (72 each), over
    6 kc x fresh/warm x {df, ni}, <= 2. Rep 1; any lane > 2 is rerun up to 3 and gated on the min. nc is
    NOT gated: the never-optimized caller boxes its own `K[..]` / `CS[..]` reads (the driver's box).
  - **AHF** `[mode/hll|cms/warm]` <= 2 (8 lanes). AH-CTRL: a Noop `addHashed(U[j], U[j+1])` in ni must
    read >= 12 (3 reps).
  - **Tighten (never loosen):** G2 `N3[df/ss/kc]` from live noop + 2 to `<= 2`; `N3[df/hll/n31]` to `<= 2`.
  - **New:** `N3c[cap120/cms.cmax/b31|n31|safe]` (constant count 2^32-1, under
    `--max-inlined-bytecode-size=120`) <= 2 -- F5 wrapper-size teeth (HEAD 24 -> tree 1); the F2 murmur
    revert is NOT gated in Node (the default tier reads 0-1 on both builds). And
    `N1e[df/cmsest.c31/small|b31]` (prefill 2^31) <= 2, whose teeth is the D3 revert only (HEAD passes
    it). Both min-of-3.
  - Cost: 248 rep-1 + 18 three-rep children = 266, about +20-25 s at N3_JOBS=4 and +80-90 s serial; qa
    records the real figure.
- **T5 (coder, N7 drivers; thresholds untouched):** torture.mjs `ahStep` (:116-121) and `chStep`
  (:162-167): `x = (x + 0x9e3779b1) | 0` into a Uint32Array(2) / (3) (count 1), then `addHashedFrom`,
  same uint32 bits as HEAD. PerfGate `addHashedStream` (:60-67): the same. PerfGate :183
  `ss.add(v >>> 0)` becomes `KB[0] = v >>> 0; ss.addFrom(KB, 0)` (`KB[1] = 1` in setup). Fix only the
  comment lines that describe these drivers (torture :304-308, PerfGate :218-221).
- **T6 (coder, tests; SS adds and addFroms go through a per-op `_mapOcc` watchdog):**
  - Per member, `addFrom` rejects with TypeError, the exact literal message and a byte-identical
    snapshot: Float32Array / Int32Array / Array / DataView / null; i = 0.5 / -1 / NaN / Infinity /
    length; i = length - 1 for 2-slot buffers. Value rejects through `addFrom` give `add`'s error and a
    no-op.
  - `addHashedFrom` rejects with the same matrix: Float64Array; i = length - 1 (HLL) / length - 2
    (CMS); count 0 / Int32 -1 / Proxy NaN -> `_badCount`; a total overflow -> `_badTotal`.
  - Twins built via add vs addFrom over mixed-sign keys (incl. +-2^53-1 and -0) are equal. U32 and I32
    `addHashedFrom` equal `addHashed`.
  - HEAD add error literals cut from `git show HEAD:Sketch.js` BEFORE the edit (e.g. `add(NaN,'x')`,
    `add('1',NaN)`, `add(1,'2')`, `add(1.5,Symbol())`, `add(1,2**32)`, `add(1,null)`).
  - `_buf` is per instance, and interleaved instances equal solo twins.
  - SS evict with a Proxy whose `get` flips the key after the first read: every slot is found by
    `_probe(k, _hash(k))`. It must FAIL with D1 reverted.
  - test/types: the new signatures, plus `@ts-expect-error` for a Float32Array to `addFrom` and a
    Float64Array to `addHashedFrom`.
- **T7 (coder, test/parity.mjs), new "H2.6 F5/F6" section:** tree `add` / `addFrom` / CMS `estimate`
  vs ref `add` / `estimate` for HLL p 4/12/18, CMS cons + plain, full SS pools; `addHashedFrom` (U32 +
  I32) vs ref `addHashed`; error identity + a no-op snapshot after every reject. Ref-aware: negative keys
  only when `refHasF12`; error identity only when the ref throws TAGGED on `add(Object.create(null))`,
  else print SKIP; also compare against the ref's own `addFrom` when it has one.
- **T8 (coder, docs; never VERSION):**
  - d.ts: HLL / CMS / SS `addFrom` and HLL / CMS `addHashedFrom`, worded like DD.addFrom's zero-box text:
    "0 library B/op; `add` boxes a non-Smi argument (~16 B) at a non-inlined call"; the CMS Int32 count
    cap.
  - README: API reference lines after each add / addHashed (the SS NOTE stays); two allocation-table
    rows; the quick note "addFrom for keys >= 2^31 on a hot path".
  - llms.txt: the header, the HLL / CMS sections and the SS block.
  - CHANGELOG `[Unreleased]`: **Added** the 5 methods with N1 numbers; **Fixed** (F5 + F2 complete) the
    df and Chrome deltas above and CMS cmax 9 -> 1, state bit-identical to b4e378f; **Changed** HLL add
    +~1.5 ns/op.
  - Dated H2.6 amendments: ADR 0001 (the deferral is resolved; the copies list), ADR 0002 (wrapper +
    `_addAt`), ADR 0003 (`_badArgs`, `_estimateAt` + D3, 3-slot + why), ADR 0005 (three copies -> two,
    re-probe from `_key`, D1).
  - ROADMAP: the F5 / F6 / N1 / N7 row deltas and the 7.1 row. The orchestrator writes the Result block
    after qa.

**Assertions (qa; f1-f3 and f5 also run against `git show HEAD:Sketch.js` via `--lib` and must FAIL
there)**
- f1: all 240 N1 lanes min <= 2, every rep printed. `--lib HEAD`: all 248 N1 + AHF gates `=ABSENT`
  FAIL, exit 1, GATE line printed, no unhandled rejection.
- f2: AHF <= 2 (0 expected). AH-CTRL >= 12 on both builds. N1e <= 2 (0 expected); q1's
  `return this._estimateAt(b, 0)` FAILs it.
- f3: G2 <= 2 (tree 1, HEAD 24-25 FAIL x4); cmax <= 2 at cap120 (tree 1, HEAD 24 FAIL x3); hll/n31 <= 2
  (tree 0-1). Every other H2.1-H2.5 gate unchanged and green on both builds. Stable over 3 runs at
  N3_JOBS=4 and 1 at N3_JOBS=1.
- f4: `node test/parity.mjs`: H2.6 section 0 diffs over >= 350,000 checks; error identity all
  identical; state byte-identical after every reject. `parity.mjs e805ac8` exits 0. The M3_ADD+1 mutant
  shows >= 90,000 diffs.
- f5: `npm test` = 251 + new, 0 todo. On HEAD every addFrom / addHashedFrom test FAILs and the
  add-literal tests pass. The watchdog never trips.
- f6 (bytecode): wrappers 44 / 74 / 74; CMS est <= 50; addFrom <= 110 (SS 104 with D1's copy);
  addHashedFrom < 460 (the orchestrator relaxed this bound for the lane validation); all < 460.
  `_addAt` / `_estimateAt` > 460, accepted (object, Smi). The byte-identical list holds against HEAD.
- f7: each mutant FAILs >= 1 new gate or test: `_badArgs` checks the count first; addFrom via
  `this.add(buf[i], buf[i+1])` (N1 ni); HEAD's SS add body restored (G2); addHashedFrom via
  `addHashed(... >>> 0)` (AHF ni); D1 reverted (the Proxy test); D3 reverted (N1e).
- f8: torture `ok` x3 (9 lanes at 0 B/op; SCAV_CLEAN 0; scAh / scCh 0 with the limit 48 unchanged;
  maxMajor 0, maxPauseMs 4; `tracker.size()` back to 0 over the build-fill-clear cycles incl. `_buf`;
  arrayBuffers delta <= 0; N7 DD <= 2). Perf 9/9 (64 unchanged; record the two new reads), witness sha1
  2ed81a8b, test:types green, ASCII-only, pack 7 files, VERSION '1.1.2'.

Reviewer focus:
- Is every reject's class and message HEAD's? Is `count = 1` defaulted in the wrapper?
- Are `_buf` / `_base` / `_cnt` written only after validation (`_buf` before is fine: it is scratch)?
- Do the inlined murmur's constants equal `_m3round` / `_m3final` (M3_ADD low bits, rotl 15/13, `^ 8`,
  k1 from `a | 0`, k2 from `hiw ^ (neg << 31)`)?
- Does any double cross a non-inlined hot call or return?
- Stale jsdoc: add's "inlined murmur" text, the SS "THREE copies" text, estimate's `_hash` text.
- Is any limit raised?

RISK: the N1 SS lanes read 0-2 against <= 2. If all three reps read 3, classify them with chunk.mjs /
`--trace-turbo-inlining` (fresh-window tier-up); never raise the limit.

### 7.8 H2.7 spec -- topKInto + quantilesInto (F7, F8), option bags / forEach / -0 (F18), the merge brand (F21) + N8  [DONE, committed 5fecd6e]

Result: the reviewer REJECTED twice, APPROVED, then APPROVED a post-qa fix; qa found g1-g8 PASS.
- **Rejection 1:**
  - `'value' in d` read a polluted `Object.prototype.value`, so an accessor bag was accepted with the inherited
    value (and a getter on it ran). Now an own check (`_hasOwn`, cached).
  - `_f64Clash` compared buffer objects, so two SharedArrayBuffer objects aliasing one memory
    (`structuredClone(sab)`) passed and the Into calls wrote garbage. Two DIFFERENT SAB objects now fail closed
    (aliasing cannot be verified); detection is a cached `ArrayBuffer.prototype.byteLength` getter that throws
    only on a SAB.
  - The new module helpers renumbered module-context slot operands in 6 hot methods (opcodes and lengths
    unchanged). They now live after the last class; every hot method is operand-identical to HEAD.
- **Rejection 2:** the SAB probe always ran on the first buffer, so an ACCEPTED SAB-first mixed call threw
  internally (~888 / ~1776 B/call). The plain buffer is probed first (the prototype picks only the order).
  Torture `SAB-first` scavenge lanes gate it (pre-fix 1733 / 1713, now 0).
- **Post-qa fixes (reviewed):** the DD ctor re-read `range[0]` / `range[1]` outside the try after validating
  them (a two-faced getter stored 'pwned'; pre-existing in HEAD) -- each index is now read once. A root
  prototype carrying a KNOWN key (`Object.create({__proto__:null, seed:5})`, a polluted cross-realm
  Object.prototype) is rejected instead of silently dropping the value; this realm's Object.prototype keys
  stay ignored.
- **Numbers:**
  - N8: topKInto n16 / n64 big and quantilesInto q4, df + ni, min 0 [0,0,0]; forEach small 0; Q-CTRL 24;
    FE-CTRL 73. `--lib HEAD` FAILs exactly the 6 Into gates (ABSENT), exit 1. Lanes 50 s at N3_JOBS=4.
  - Torture ok x3: scTk / scQs / SAB-first 0 B/op and 0 scavenges, major 0, maxMs 0.00, trackers 0.
  - 358 tests (0 todo); perf 9/9; witness sha1 2ed81a8b; parity exit 0 vs HEAD and e805ac8 (H2.7 section
    identical, 15 DOC-DIFF checks yes). DD add / addFrom 448 / 449; only cold methods differ (withAccuracy /
    withError by one class-context slot from `#brand`, waived).
  - qa mutants: 40 / 44 killed; the 3 `>=` heap-comparator survivors are equivalent (they compare two distinct
    slots). qa's polluted `Object.prototype.range` test closed a real gap (`options.range` survived before).
- **Known gaps (recorded, not fixed):**
  - The operand-level bytecode identity, the `--lib HEAD` lane revert check and the mutant matrix are scratch
    runs (`h27/review27/bcdiff.mjs`, `h27/qa27/`), not committed gates.
  - topKInto rejects two zero-length views at the same offset of one buffer (fails closed; harmless).
  - A bag whose PROTOTYPE is a Proxy runs the caller's own traps inside the try (accepted, own values only).

Why now:
- lite-hud M3 renders an SS top-N every frame. Its keys are >= 2^32 and its counts pass 2^31. `topK()` allocates
  ~160 B/entry, and `forEach` boxes 3 doubles per entry in any non-inlined callback, so M3 has no 0-alloc render.
- M2 already calls `quantile(0.5)` / `quantile(0.99)` every frame (Hud.js:1529-1530) at 16 B each. That meets
  F8's own condition for an Into API.
- F18 / F21 are the last fail-open doors: option bags, the `instanceof` brand, and H2.3's RISK.
- Everything here is cold. The hot bodies tuned in H2.4-H2.6 do not move.

Pre-measured (HEAD e7c70f7, Node 26.8.2; scratchpad `h27/facts.md`, `repro.mjs`, `alloc.mjs`, `ql.mjs`):
- **F18 bags:** CMS / DD / SS accept `{toString:1}`, `{constructor:1}`, `{hasOwnProperty:1}`, JSON
  `{"__proto__":1}`, Map, Date and /x/. Inherited values are read: `Object.create({seed:5})` gives seed 5
  (CMS, SS), and `{conservative:false}` (CMS) and `{maxBins:8}` (DD) apply the same way. A revoked Proxy bag
  throws the engine's untagged IsArray TypeError.
- **F18 forEach:** `clear()` in the first callback visits 5 entries (4 ghosts). A mid-walk `merge` visits 1,3,2.
- **F18 -0:**
  - SS `add(-0)` returns -0 from topK / forEach / heavyHitters.
  - DD `add(-0)` reads -0 from min / max; quantile(0) already reads +0.
  - SS lookups already treat -0 === 0, and merge's Map already normalizes.
- **F21:**
  - A bare `Object.create(X.prototype)` throws a tagged RangeError (shape mismatch) in all four.
  - A field-copy forgery merges silently in all four.
  - A DD forgery carrying only `_gamma` leaves count / sum NaN.
  - `new Proxy(real, {})` passes `instanceof` and merges.
  - All four `_badMerge` also branch on `instanceof`, which runs a Proxy trap.
- **Bytes per call** (alloc.mjs, k = 64 / 1024):

  | call | k = 64 | k = 1024 |
  | --- | --- | --- |
  | `topK()` | ~10-11 KB | ~166 KB (~160 B/entry) |
  | `topK(10)` | ~4-5 KB | ~40 KB |
  | `heavyHitters(0)` | ~9-10 KB | ~137 KB |
  | SS merge | ~19-29 KB | ~280-317 KB (~300 B/entry) |

  - forEach: 0 for Smi entries; ~49 B/entry for entries >= 2^31 in a never-optimized callback.
  - HLL / CMS / DD merge and clear: 0.
- **Query lanes** (scavenges at 1.6M units, df / ni):
  - hll.count: 0 / 0 (a Smi below 2^31 at realistic cardinality).
  - dd.q50: 24 / 24 (every call boxes its return).
  - ss.est with count >= 2^31: 0 / 49.
  - ss.forEach: small 0 / 0, big 0 / 73.

Planner decisions:
- **D1 (F21 brand):** a class-private `#brand;` field in each class, tested with
  `typeof other !== 'object' || other === null || !(#brand in other)`.
  - `#x in o` runs no user code. It is false for a Proxy (private names are not forwarded), O(1), and adds no
    module state.
  - A module WeakSet was rejected: it adds ephemeron work to every major GC (the maxMajor / maxPauseMs budget).
  - Subclasses pass, because `super()` installs the brand. Engines are node >= 18, and `#x in` needs 16.4.
  - The typeof / null guard is required: `#b in 5` throws an untagged TypeError.
- **D2 (F18 bags):**
  - A bag is a non-null object whose prototype `p` is `null`, is this realm's `Object.prototype`, or has
    `Object.getPrototypeOf(p) === null` AND carries no own KNOWN key (a prototype other than this realm's
    `Object.prototype` must carry no own KNOWN key; a cross-realm `Object.prototype` polluted with a known key is
    rejected). That covers a clean Object.prototype of ANY realm (vm / iframe stay legal) and null-proto bags.
    Map / Date / RegExp / arrays / class instances / `Object.create(proto)` are not bags.
  - Every own key (`Reflect.ownKeys`: symbols and non-enumerable keys included) must be in a null-proto KNOWN
    set.
  - Values are read only as own data descriptors. An own accessor makes the object not a bag, so no getter
    runs.
  - Every step that can hit a Proxy trap sits in one try. Any throw there (a revoked Proxy, a throwing trap)
    becomes the tagged plain-object TypeError.
  - No new message text: rejections reuse HEAD's plain-object / `_badOption` / `_badRange` texts. The KNOWN
    key order is kept, so "known options: ..." is byte-identical.
- **D3 (addFrom Proxy point):** documented, NOT changed. A trap-free buffer check costs bytes in 7 hot entries,
  and DD addFrom is at 449 of the 460 cap. Every Proxy `instanceof` admits runs `get` traps on `buf[i]` anyway,
  and H2.6's D1 already reads each slot once.
- **D4 (F7):** `topKInto(outKeys, outCounts, outErrors, n?) -> number written`.
  - Algorithm: an in-place bounded heap of slot ids in `outKeys`. O(size log w), 0 alloc.
  - The oracle is EXACTLY `topK(n)`: count DESC, ties by ascending slot. A selection scan was rejected:
    O(n*size) would hang at n = size = 2^16.
  - Bad outs throw tagged, like addFrom: a wrong array type would silently truncate a key >= 2^32. A bad n never
    throws, like topK.
  - `w = min(n, size, three lengths)` is returned, not thrown.
- **D5 (F8):** `quantilesInto(qs, out) -> number written`. Each q is read from a Float64Array and each value is
  written to one, so neither crosses a call. One call serves p50/p90/p99/p999.
  - `quantile` stays byte-identical. The walk is duplicated and the oracle gates it, because a shared helper
    would return a double across a call.
  - No `countInto`: hll.count reads 0 / 0. No `estimateInto`. Both return boxes become docs only.
- **D6 (F18 -0):** normalized with `+ 0` at the OUTPUTS only: SS forEach / topK / heavyHitters / topKInto, and the
  DD min / max getters. Storage is untouched, so no hot byte changes.
- **D7 (F18 forEach):** the loop bound is the live `this._size`. Docs say "do not mutate the sketch inside fn":
  there are no ghosts, but entries may be skipped or revisited.

Hot body vs cold path:
- **0 hot bytes change.** These are byte-identical to HEAD (scratch `--print-bytecode` diff):
  - every add / addFrom / addHashed(From) / `_addAt`;
  - estimate / estimateHashed / errorOf / `_estimateAt`;
  - DD add (448) / addFrom (449) / `_addKey` / quantile;
  - all SS map / forest helpers and the murmur helpers.
- **Cold changes:**
  - the three option blocks, plus DD range reads;
  - 4 merges and 4 `_badMerge`;
  - topK / heavyHitters (`+ 0`), the DD min / max getters, forEach (bound and `+ 0`);
  - the new topKInto and quantilesInto;
  - module helpers `_optScan` / `_optOwn` / `_f64Len` / `_f64Clash` and the cached TypedArray getters.
- **Zero-box:**
  - topKInto takes (objects, Smi) and returns a Smi. Slot ids are read `| 0`. Counts are compared in locals.
    The sifts are inline loops with no helper call.
  - quantilesInto reads q from `qs` and writes `out`; `Math.pow` is a builtin.
  - forEach still passes doubles to fn. That is the documented cost.

Out of scope: F9 thresholds, N4, N6 (Chrome), the F19 "0 B/op" sweep, the 1.2.0 trinity (all H2.8).
- A preallocated SS merge scratch: F8 is settled by wording.
- The topK / heavyHitters algorithms (only `+ 0` changes there).
- The addFrom `instanceof` point (D3). The lite-hud adoption.

**Tasks** (T1-T5 edit Sketch.js in order by one coder; T6-T8 come after; T9 is last)
- **T1 (coder, Sketch.js, F21):**
  - Add `#brand;` as the first member of HyperLogLog / CountMinSketch / DDSketch / SpaceSaving.
  - In each `merge`, the brand predicate (D1) is the first statement, before ANY read of `other`, and returns
    `this._badMerge(other)`. Then HEAD's shape test, minus `instanceof`, in HEAD order.
  - In each `_badMerge`, the same predicate replaces `instanceof`. The texts stay byte-identical.
  - Merge jsdoc x4: brand-checked; a Proxy over an instance or a field copy is not an X.
- **T2 (coder, Sketch.js, F18 bags, D2):**
  - KNOWN sets become `Object.freeze({ __proto__: null, ... })`, with the same key order.
  - Cold `_optScan(o, known)` returns null for a valid bag, a module sentinel for a non-bag, or the first unknown
    own key.
  - `_optOwn(o, k)` returns the own data value, or undefined.
  - Ctor flow:
    - `typeof !== 'object' || null` -> HEAD's TypeError, unchanged;
    - `try { scan; own reads } catch { non-bag }`;
    - a non-bag -> the plain-object TypeError;
    - an unknown key -> `this._badOption(key)`;
    - value checks AFTER the try, verbatim from HEAD.
  - DD: `Array.isArray(range)`, `.length`, `[0]` and `[1]` read inside a try whose catch calls `_badRange(range)`.
- **T3 (coder, Sketch.js, F18 forEach + -0, D6 / D7):**
  - forEach: `for (let i = 0; i < this._size; i++) fn(keys[i] + 0, counts[i], errors[i], this)`. The arrays stay
    hoisted (never reallocated).
  - `key: this._key[x] + 0` in topK and heavyHitters.
  - DD getters: `this._min + 0` / `this._max + 0`.
  - forEach jsdoc: live bound, no mutation, ~49 B/entry for non-Smi entries in a non-inlined fn; use topKInto.
- **T4 (coder, Sketch.js, F7):**
  - Module scope: cache the `Symbol.toStringTag` / `length` / `buffer` / `byteOffset` getters of
    `Object.getPrototypeOf(Float64Array.prototype)`. These run no Proxy trap and no subclass override.
  - `_f64Len(x)` is the length, or -1 unless a real Float64Array.
  - `_f64Clash(a, b, sameOk)` is true when a and b share a buffer and their byte ranges intersect. Equal offsets
    are allowed only if `sameOk`.
  - Validation: any length -1, or any clashing pair (sameOk false), calls `_badOut(a, b, c)` before any write.
    `_badOut` is a TypeError: `'[lite-sketch] SpaceSaving.topKInto(outKeys, outCounts, outErrors, n) needs three
    non-overlapping Float64Arrays, got ' + _describe x3`.
  - n follows topK's rule. `w = min(n, size, la, lb, lc)`.
  - Heap: a min-heap whose root is the worst kept entry, where `worse(a,b) = c[a] < c[b] || (c[a] === c[b] &&
    a > b)`.
    - Walk slots 0..size-1, filling the heap, then replace the root and sift whenever a slot beats it.
    - An in-place heapsort to best-first.
    - Then for j < w: `sl = outKeys[j] | 0`; write `key + 0`, count and error.
  - Returns w.
- **T5 (coder, Sketch.js, F8):** `quantilesInto(qs, out)`.
  - `_f64Len` x2 and `_f64Clash(qs, out, true)`, so in-place `qs === out` works. A failure calls
    `_badQuantiles(qs, out)` (new tagged TypeError text) before any write.
  - `m = min(lengths)`. For j < m, run quantile's body verbatim, with each `return X` becoming `out[j] = X`.
  - Returns m and never throws on q values.
- **T6 (coder, test/lanes/lane.mjs + test/lanes.mjs, N8):**
  - A new laneType `query`:
    - fixture SS(64) with 256 adds: big = key 2^31+(i%128), count 2^31+i; small = i%128, 1+i;
    - DD(0.01) with 1e4 values;
    - units = entries scanned (topKInto / forEach) or quantiles (qs = [.5, .9, .99, .999]);
    - 1.6M units per lane; a missing method prints `{"absent":...}`.
  - Gates, each min-of-3 with every rep printed:

    | gate | limit |
    | --- | --- |
    | `N8[df\|ni/ss.topKInto.n16\|n64/big]` | <= 2 (4 gates) |
    | `N8[df\|ni/dd.quantilesInto.q4]` | <= 2 (2 gates) |
    | `N8[df\|ni/ss.forEach/small]` | <= 2 (regression guard, HEAD 0) |
    | `Q-CTRL[ni/dd.quantile]` | >= 12 (24) |
    | `FE-CTRL[ni/ss.forEach/big]` | >= 12 (73; the documented forEach cost) |

  - That is 30 children, about +5-8 s at N3_JOBS=4 (qa records it).
- **T7 (coder, tests, per-member files; HEAD literals cut from `git show HEAD:Sketch.js` BEFORE the edit):**
  - **G-F21 (x4):**
    - a field-copy forgery (`Object.assign(Object.create(X.prototype), real)`) and `new Proxy(real, traps)` both
      give a TypeError with HEAD's text, a byte-identical snapshot, and trap calls === 0;
    - a DD `_gamma`-only forgery leaves count / sum unchanged;
    - `merge(5|null|undefined)` throws tagged (kills a dropped typeof guard);
    - `class Sub extends X` merges.
    - Old tests that used a bare forgery to reach the RangeError switch to a real mismatched instance (rewrite,
      never delete).
  - **G-F18o (CMS / DD / SS, + withAccuracy / withError):**
    - `{toString:1}`, `{constructor:1}`, `{hasOwnProperty:1}`, JSON `__proto__` and `{[Symbol('x')]:1}` throw
      `_badOption`.
    - Map / Date / /x/ / [] / class instance / `Object.create({seed:5})` / an accessor bag (calls === 0) /
      a revoked Proxy / a throwing-trap Proxy throw the HEAD plain-object text.
    - DD range given as a revoked Proxy throws `_badRange`.
    - Accepted: a literal, `{__proto__:null, seed:7}`, `vm.runInNewContext('({seed:7})')`, and a non-enumerable
      own seed.
    - With `Object.prototype.seed/conservative/maxBins` polluted (try/finally), the defaults hold.
  - **G-F18f:** `clear()` in the first callback visits 1 entry.
  - **G-F18z:** `Object.is(v, 0)` at SS forEach / topK / heavyHitters / topKInto and DD min / max after `add(-0)`.
  - **G-F7:**
    - Object.is equality with `topK(n)` over capacity 1/7/64/1000 and streams Zipf / all-equal / evicting, for
      n in {0,1,3,size-1,size,size+5,undefined,-1,2.5};
    - the return value equals w; short outs write their length;
    - Float32Array / Array / Int32Array / `Proxy(F64)` (0 trap calls) / aliased / overlapping views throw with
      the outs unchanged;
    - disjoint views over one buffer are accepted, and so is a subclass with a `length` getter (0 getter calls);
    - the sketch snapshot is unchanged.
  - **G-F8:**
    - Object.is equality with `quantile(q)` for q in {0, -0, 1e-9, .25, .5, .9, .99, .999, 1, NaN, -1e-300,
      1+2^-52, +-Infinity};
    - sketches: empty, zeros-only, 1e4 values, strict, maxBins 16 collapsed, merged;
    - in-place works; an overlap throws.
  - test/types: the two signatures, plus `@ts-expect-error` for a Float32Array out and a `number[]` qs.
- **T8 (coder, test/torture.mjs, test/parity.mjs):**
  - torture: measureAllocs lanes `scTk` (topKInto big n16) and `scQs` (quantilesInto q4) at 0 B/op, in
    SCAV_CLEAN.
  - parity: an "H2.7" section.
    - Identity: valid bags build the same state; outputs without -0 are identical; quantile is identical.
    - Oracles: topKInto == ref `topK(n)`; quantilesInto == ref `quantile` per q.
    - Checked DOC-DIFF, new side: -0 outputs (6 sites); forEach under clear (5 -> 1); bag rejections; polluted
      seed; forgery merges; revoked Proxy tagged.
- **T9 (coder, docs; never VERSION):**
  - Sketch.d.ts: the two methods; the bag rule; merge brand; forEach live bound and boxes; topK / heavyHitters /
    SS merge bytes; the quantile / SS-CMS estimate return box (16 B in a non-inlined call); HLL count as a Smi
    below 2^31; the addFrom Proxy note (D3).
  - llms.txt: :86-87, :272, :340-349 ("bounded cold scratch" becomes ~300 B/entry), and the bag / merge lines.
  - README: the API lines, :281-283 and :343, the allocation table rows, the quantile note.
  - ADRs, each with a dated H2.7 amendment:
    - 0002-0005: the brand;
    - 0003-0005: the bag rule;
    - 0004: quantilesInto and -0;
    - 0005: topKInto's heap and tie order, forEach, -0, merge bytes;
    - 0001: D3.
  - Every byte figure cites a gate, or alloc.mjs as "approx".
  - CHANGELOG `[Unreleased]`:
    - **Added:** topKInto and quantilesInto, with the N8 numbers.
    - **Fixed:** F18 (the examples above, ghosts 5 -> 1, -0) and F21 (DD NaN, field-copy, revoked Proxy
      untagged -> tagged).
    - **Changed:** non-root-prototype / accessor / symbol-key bags rejected; Proxy-wrapped instances rejected by
      merge; a bare forgery now gets the TypeError instead of the RangeError; -0 outputs read +0.
  - ROADMAP: the F7 / F8 / F18 / F21 / N8 row deltas and the 7.1 row.

**Assertions (qa; g1-g4 and g6 also run against `git show HEAD:Sketch.js`, tests copied to the scratchpad, and
must FAIL there)**
- g1: G-F21 passes x4. On HEAD the forgeries merge, DD count is NaN, and Proxy trap calls are > 0.
- g2: G-F18o passes. On HEAD `{toString:1}` is accepted, the inherited seed is 5, and the revoked Proxy throws
  untagged.
- g3: G-F18f visits 1 (HEAD 5). G-F18z gives +0 at all 6 sites (HEAD -0).
- g4: G-F7 / G-F8 oracles show 0 diffs; every reject is tagged with the outs unchanged. On HEAD both methods are
  absent and the tests FAIL.
- g5: `node test/parity.mjs`: every prior section shows 0 diffs, and the H2.7 identity and oracles show 0 diffs.
  The DOC-DIFF H2.7 checks all pass. The hot-method bytecode is byte-identical, with DD add / addFrom at
  448 / 449.
- g6: `npm run lanes`: every N8 Into gate min <= 2 (0 expected); forEach small <= 2; Q-CTRL >= 12; FE-CTRL >= 12.
  `--lib HEAD` FAILs exactly the 6 Into gates as ABSENT, with exit 1 and both CTRLs live. All H2.1-H2.6 gates
  are unchanged.
- g7 (GC budget): torture `ok` x3.
  - scTk / scQs at 0 B/op, SCAV_CLEAN 0.
  - maxMajor 0, maxPauseMs <= 4.
  - `tracker.size()` back to 0 over the build-fill-clear cycles (incl. branded instances and rejected merges).
  - arrayBuffers delta <= 0.
  - Perf 9/9, witness sha1 2ed81a8b, test:types green.
  - ASCII-only, pack 7 files, VERSION '1.1.2'.
  - `npm run verify` green with 301 + new tests, 0 todo.
- g8 (teeth): each mutant FAILs >= 1 gate or test:
  - `instanceof` brand (G-F21);
  - a dropped typeof guard (G-F21 primitives);
  - an Object.prototype KNOWN set, or `options.seed` reads (G-F18o);
  - `p === Object.prototype` (the vm case);
  - a dropped try (revoked Proxy);
  - a hoisted forEach bound (G-F18f);
  - each dropped `+ 0` (G-F18z);
  - the tie comparator `a < b` / `>=` (G-F7);
  - `instanceof` out checks (the Proxy trap count);
  - a dropped `_f64Clash` (overlap);
  - `Math.round` in quantilesInto (G-F8);
  - `qs.slice()` (N8 / scQs).

Reviewer focus:
- Does the brand precede EVERY read of `other` in all 4 merges and `_badMerge`?
- Can the try swallow a tagged value-check error? It must not: the checks run after it.
- Do non-Proxy bags run any user code (a getter, toString)?
- Is the heap's order exactly topK's? Does it write before validating?
- Is quantilesInto's walk line-for-line quantile's?
- Did any hot method's bytecode move?
- Is any limit raised?

RISK: D2 rejects option bags built on a custom prototype (`Object.create(defaults)`) that 1.1.2 accepted. That is
intended, under CHANGELOG Changed. Orchestrator grep (2026-10-05): no suite consumer (LiteHud included) passes a
custom-prototype bag; every in-repo call site passes a literal.

### 7.9 H2.8 spec -- calibrated gates (F9 + N4), the Chrome lane (N6), doc truth (F19), release readiness  [DONE 2026-10-05, awaiting maintainer commit + /release 1.2.0]

Result: the reviewer REJECTED twice, then APPROVED; qa found h1-h7 PASS. No Sketch.js code byte changed (a
comment-stripping diff is identical; parity 0 diffs vs HEAD; witness sha1 2ed81a8b).
- **Rejection 1 (6 blockers):**
  - revert.mjs only checked "exit 1 + ABSENT" for the lanes and chrome families, so dead N2 / N3 / N5 gates or a
    dead Chrome add limit would have passed; parity read only the N9 line.
  - The docs gate's lockfile rule threw on a fresh clone (package-lock.json is gitignored) and was tautological
    after `npm install`: D9 DROPPED, rule removed.
  - The qualifier regex took English "from" / "into" / "network" as qualifiers; the revert-check docs named a
    docs family that does not exist and the wrong runtime.
  - Nits taken: Chrome add limits now use k = FRESH per-op non-Smi boxes per mode (every limit lowered: df add
    lanes 0.5, ni c30 b30 12.5 was 24.5); v31 now accumulates; NaN / negative windows are discarded and a lane
    with no valid window FAILs; REF is validated before `git show`.
- **Rejection 2:** revert.mjs still dropped missing named gates, did not pin family counts, accepted a VACUOUS
  N5 and an INVALID Chrome lane as the expected FAIL. Now: exact counts, N5 must read > 3 and not VACUOUS, each
  Chrome mustFail must print a min strictly above its limit.
- **Parity vs 1.1.2:** parity.mjs legitimately exits 1 against 1a2673e. Three sections differ by documented
  behavior changes and are allowlisted, each matched on its diff tag: H2.5 F3/F4 (CMS 1x1 `saturated`, H2.3
  F14), the messages section (the DD alpha range `[1e-6, 1)`, H2.2 S2), and H2.6 F5/F6 (CMS 4x1024 total /
  saturated, H2.3 F14/F15). Every other section must read ok, and N9 hash identity 0 diffs.
- **Numbers:**
  - Perf 10/10 x3: every scenario 0 at N and 8N; mustFailAlloc 53 / 427; oneBoxCtl 1/12-25 (trips at 2); with
    `maxScavenges: 64` the suite FAILs (oneBoxCtl not caught).
  - Torture ok x4: all 13 measureAllocs lanes 0 B/op, scAh / scCh 0 at SCAV_CLEAN, SCAV-CTRL 30 (a Smi-only
    control reads 0 -> VACUOUS FAIL), major 0, maxMs 0.00.
  - Lanes exit 0 (46 s): N4-CTRL[df/ring] 24 / 24 / 24; no H2.1-H2.7 gate or limit changed.
  - Chrome (154, 38 s, 98 lanes): addFrom / AHF <= 0.03, Into 0.00, k=0 add 0.00, k=1 add 12.00 (limit 12.5),
    CTRL 12.00 / 12.00. `--lib` 1.1.2: exit 1, fail 87, absent 58, HLL add small df 9.01, SS add c30 ni
    172.39 / 267.52. No Chrome, a bogus binary, an import-throwing / syntax-error lib -> UNVERIFIED exit 1; no
    precise memory -> CTRL 0.00 FAIL.
  - 366 tests (0 todo); `npm run verify` exit 0 in 193 s; pack 7 files; VERSION '1.1.2'.
- **Exit evidence -- `npm run revert-check` vs 1a2673e (1.1.2), exit 0 in 39 s:**

  | family | observed on 1.1.2 | verdict |
  | --- | --- | --- |
  | lanes --lib | exit 1; 254 ABSENT (240 N1, 8 AHF, 6 Into); 36 FAIL (N2-HLL 8, N5 2 [df 1296, ni 2267], N3[ni] 16, N3[nc/hll] 4, N3[nc/ss] 4, N3[nc/*/n31] 2); N4-CTRL 24; every CTRL intact | PASS |
  | chrome --lib | exit 1; 5 named add lanes FAIL with min above the limit; 14 named from / AHF / Into ABSENT; CTRL PASS | PASS |
  | perf (64 -> 2) | edited exit 1, unedited exit 0 | PASS |
  | torture (48 -> 0) | edited exit 1, unedited exit 0 | PASS |
  | parity | N9 0 diffs; 3 allowlisted sections differ on their tags; no other FAIL | PASS |

  `--ref 5fecd6e` (H2.7, green) exits 1 (FAIL 1/5) in 300 s. So "N1-N5 FAIL on 1.1.2, and N4 trips" holds, and
  N3[nc/{cms,cmsest}/{b31,u32,safe}] read 0-1 on 1.1.2 and are not asserted.
- **lite-hud (D10, not edited here):** its 8.2 probe shape on the tree's addFrom reads 0 -> 0 on every lane, df
  and ni (1.1.2 add: SS 18 / 67 / 215, HLL 10-13 / 64, CMS 24 / 49), and the Chrome `hud` key-class lanes
  (ch*2^32 + tag) read <= 0.03 B/op. Forward to a lite-hud session (LiteHud/ROADMAP.md 8.2).
- **For `/release 1.2.0`:** content rewrites (not number swaps) at Sketch.js:9 ("v1.1.2 ships ... 1.1.1-1.1.2 =
  packaging metadata only"), RESEARCH.md:9 ("SHIPPED (1.0.0 -> 1.1.2)") and llms.txt:17 ("v1.1.2 ships the
  STABLE FOUR-member API"). Number swaps: package.json, Sketch.js VERSION, llms.txt:3 / :105, README:293, and
  the four "frozen 1.1.2 string" VERSION tests. Do NOT swap the deliberate 1.1.2-baseline mentions (README:375,
  llms.txt:465 / :470, RESEARCH.md:10 / :355 / :358, ADR 0004:87, test/lanes.mjs:117, test/HyperLogLog.test.js
  :443, ROADMAP). package-lock.json is gitignored, so `git grep` will not list it.
- **Known gaps (recorded, not fixed):**
  - revert.mjs's parity row prints fixed text ("3 allowlisted diffs on tag") even when those sections read ok,
    and an allowlisted section stops at its first diff, so a later divergence inside it is hidden.
  - A Chrome page fault other than an import error (a missing class, a throwing step) fails closed only after
    the 120 s launch timeout.
  - Chrome gates the min of 3 windows, so one outlier window passes (seen once: df SS addFrom c30 hud
    [13.52, 0.00, 0.00]).
  - test:perf pins only `--max-semi-space-size=4`; with `--min-semi-space-size=4` too, oneBoxCtl reads 6 at 8N
    (the likely cause of the 12 / 25 bimodality). It trips at 2 either way.
  - A VACUOUS torture control also prints "scavenge floor exceeded" with every value at 0.
  - The docs gate does not catch "0 bytes per op" / "zero B/op", treats "library" anywhere on a line as a
    qualifier, does not scan the CHANGELOG, and checks only the FORMAT of the README test count.
  - The comment-only Sketch.js check, the operand-level bytecode identity and the mutant matrices are scratch
    runs (h28/qa28, h27/review27), not committed gates.

Why now:
- This is the last H2 session. The 7.1 order puts limit-lowering last, once every lane can pass. Today every perf
  scenario and both former SCAV_BOX lanes read 0, so the limits of 64 / 48 only hide a regression.
- N6 exists only in scratch. Exit says "incl. Chrome", and no committed gate covers that.
- The docs still make unqualified "0 B/op" claims, which a non-Smi argument breaks.
- The docs still promise p50/p90/p99 within alpha under collapse.
- CLAUDE.md says "Before /release, revert-check the new gates". So far only per-session scratch runs have done that.

Pre-measured (HEAD 5fecd6e, Node 26.8.2, Chrome 154; scratchpad `h28/facts.md`, perfrun / perf2 / probe82 / chrome/):
- **F9:**
  - Every perf scenario reads 0 scavenges at N and 8N (2 runs). mustFailAlloc reads 53 / 427.
  - perf2 (maxScavenges 2 + the N4 prototype) passes 7/7, three times.
  - Torture scAh / scCh read 0.
- **N4 prototype:** `ring[i & 63] = F[i & 1023] * 1.5`, with `ring = new Array(64).fill(null)`. That is
  PACKED_ELEMENTS, so each store is one 16 B HeapNumber. At 8N it reads 25 / 12 / 12: bimodal, cause not
  attributed. It trips 2 on every run.
- **N6, B/op (1.1.2 -> tree):**
  - df: HLL add 17.8 / 9.0 / 9.0 -> 0.02-0.03; CMS add c30 6.0 -> 0; SS add c30 18.1 -> 0.25-0.27; addFrom 0.04.
  - ni: HLL add ~77 -> 0-0.03; CMS add c30 ~126 -> 0-0.04; CMS est ~120 -> 0-0.02; SS add c30 ~173 -> 0.18-0.21;
    addFrom 0-0.04.
  - nc: the tree reads 12.0 on every lane. The never-optimized caller boxes its own read, so this is a driver
    floor.
  - The scratch key classes small / b30 / neg are all Smi in Chrome except one key. The committed lane adds real
    non-Smi classes.
- **lite-hud 8.2 probe (probe82):** the tree's addFrom reads 0 -> 0 on every lane, df and ni. 1.1.2 add reads up
  to 67 df / 215 ni.
- **F19:**
  - RESEARCH.md:9 already reads "SHIPPED (1.0.0 -> 1.1.2)", so that F19 item is stale.
  - The lockfile top-level and `packages[""]` versions are both 0.1.0.
  - The README states no test count; the actual count is 358.

Planner decisions:
- **D1 (F9):**
  - PerfGate `maxScavenges` goes 64 -> 2. That is the lanes' `<= 2` convention; every scenario reads 0.
  - Torture `SCAV_BOX` is DELETED, and scAh / scCh join the SCAV_CLEAN (0) conjunction. That is 48 -> 0 with no
    dead constant left behind.
  - Nothing is raised. maxOldGen 0, maxArrayBuffersKB 0, grows 0 and SCAV_ADD_INLINE 2 stay as they are.
- **D2 (N4): one box per op, in three homes.**
  - **PerfGate mustFail `oneBoxCtl`** (the perf2 shape, verbatim). This is the tooth that binds the threshold: at
    the old 64 it does NOT trip (12-25 < 64), so putting 64 back turns the suite red.
  - **Lanes `N4-CTRL[df/ring]`:** a new laneType `ring` with the same shape, df mode, gated min of 3 >= 8. That is
    2/3 of the low mode and 4x the gate. It records the number PerfGate cannot print (H2.6 gap f8). It is
    library-independent, so it passes under `--lib`.
  - **Torture `SCAV-CTRL`:** `scavLane` on a one-box step must read >= 1, i.e. it must trip SCAV_CLEAN. A reading
    of 0 prints VACUOUS and FAILs. If qa sees < 2 in any of 5 runs, the step stores two boxes and the comment says
    so.
  - The roadmap's ">= 12" becomes "trips at 2; lanes min >= 8", because the low mode is exactly 12.
- **D3 (comments):** every "floor" comment must state the true causes, both of them fixed:
  - (1) H2.1 F1: the Maglev deopt loop on `(h << p) >>> 0`.
  - (2) H2.6 F5 / F6 + N7: the DRIVER passed keys and uint32 lanes >= 2^31 as arguments to non-inlined add /
    addHashed (the caller's own box).
  - Sites:
    - PerfGate :4-7 and :219-231.
    - torture :356-385, :388, :481 and :525-527.
    - torture :426-427, which says the add-box teeth live in lite-hud. They reproduce here: CTRL 24, N3, N1, N6.
    - lanes.mjs :18-19 ("the local precursor of N4").
- **D4 (N6 harness):** `test/chrome/run.mjs` + `test/chrome/page.html`, run by `npm run chrome`, appended LAST to
  `verify`.
  - **Finding Chrome:** `CHROME_BIN`, else `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, else
    `google-chrome` / `chromium` on PATH.
  - **Fail closed:** absent, unlaunchable, a timeout (120 s per launch), no `gc`, or no precise memory each print
    `GATE chrome: UNVERIFIED (<reason>)` and exit 1. There is no skip env var.
  - **Launch flags:** `--headless=new --disable-gpu --no-first-run --no-default-browser-check`;
    `--user-data-dir=<mkdtemp in os.tmpdir()>`, removed afterwards; `--enable-precise-memory-info`;
    `--js-flags=--expose-gc --min-semi-space-size=64 --max-semi-space-size=64 [--max-inlined-bytecode-size=0]`.
  - **Server:** binds 127.0.0.1:0. `/lib.js` serves `--lib <path>`, or the repo's Sketch.js. The page POSTs its
    results back.
  - **Modes:** df and ni. nc is not gated: the tree reads 12.0 on every lane, including addFrom, and that box is the
    driver's. The harness header documents this.
  - **Measure:** each lane warms 3 x 200k, then runs 3 windows of 200k. Each window is `gc(); gc();` then the
    `usedJSHeapSize` delta divided by units. Gate on the MIN of the 3; print every window. A missing method is
    ABSENT, which FAILs.
  - **Key classes** (Chrome Smis are 31-bit): small `i`; b30 `2^30 + i`; n31 `-(2^31) - i`; safe `2^53 - 1 - i`;
    hud `ch*2^32 + tag`.
  - **Counts:** c1; c30 = 2^30; v31 = `(a*1000 + 0.5) | 0`, accumulating past 2^31 (probe82's microseconds).
  - **Lanes:** 49 per mode, each run in df and ni.

    | lane | limit |
    | --- | --- |
    | HLL addFrom x 5 kc; CMS / SS addFrom x 5 kc x {c30, v31}; HLL / CMS addHashedFrom (lanes >= 2^31); DD addFrom (fractional) | <= 0.5 B/op |
    | add: HLL {small, b30, n31, safe}; CMS / SS {c1, c30} x {small, b30}; CMS / SS estimate {small, b30}; DD add {int, frac} | <= 12*k + 0.5 B/op (k = the lane's non-Smi args in Chrome) |
    | `ss.topKInto` n16 big, `dd.quantilesInto` q4 | <= 1 B/call |
    | `CTRL[df\|ni/box]`: one fresh HeapNumber into a PACKED ring per op | >= 8 B/op (nominal 12, a pointer-compressed HeapNumber) |

  - **Budget:** <= 60 s wall; qa records it. The harness prints one GATE line and exits 1 on any FAIL / ABSENT /
    UNVERIFIED.
- **D5 (release revert-check):** `test/revert.mjs`, run by `npm run revert-check`. It is NOT in verify, because it
  expects FAILs and takes ~3 min.
  - **Inputs:** `--ref <sha>`, default `1a2673e` (1.1.2).
  - **Git:** `git show <ref>:<file>` only. All writes go to a mkdtemp under `os.tmpdir()`, with `node_modules`
    symlinked in. It never writes the tree.
  - **Expectations per family:**
    - **lanes `--lib`:** exit 1.
      - FAIL: every N1 / AHF / N8-Into gate (ABSENT), N2-HLL, N5 df + ni, N3 ni / nc.
      - PASS: every CTRL / NC-CTRL / CV-CTRL / AH-CTRL / Q-CTRL / FE-CTRL / N4-CTRL.
    - **chrome `--lib`:** exit 1.
      - ABSENT: HLL / CMS / SS addFrom, AHF, Into.
      - FAIL: HLL add df small; CMS / SS add c30 ni.
      - PASS: CTRL.
    - **perf (the F9 teeth):** take the ref's PerfGate.test.mjs and replace `maxScavenges: 64` with `2`. Assert
      exactly one replacement.
      - Run against the ref's Sketch.js, it FAILs HLL add-stream / addHashed / SS evict (audit readings 6 / 30 / 12).
      - Unedited, it PASSes. So the FAIL comes from the threshold, not the harness.
    - **torture:** take the ref's torture.mjs and replace `SCAV_BOX = 48` with `0`. Assert exactly one replacement.
      - It FAILs (HLL add reads 4; the addHashed lanes read > 0).
      - Unedited, it PASSes.
    - **parity:** `test/parity.mjs` against the ref, the way H2.7 ran it against e805ac8. The identity sections show
      0 diffs; only the checked DOC-DIFF classes (F12 ...) differ.
  - **Output:** prints `family | expected | observed | verdict`, and exits 0 only if every expectation holds.
  - **Must-fail control:** `--ref 5fecd6e` (H2.7, whose gates are green) must exit 1.
- **D6 (scratch -> committed):**
  - Promote the `--lib` revert-check, as D5.
  - Do NOT promote the operand-level bytecode identity (`bcdiff.mjs`) or the mutant matrix:
    - H2.8 changes no code byte, and a comment-only-diff check proves that more strongly than a bytecode diff.
    - `--print-bytecode` parsing is fragile across Node versions.
    - Inline status already has behavioral guards: SCAV_ADD_INLINE and N3c cap120.
  - Both are recorded as a known gap.
- **D7 (F19 wording):** the term is "0 library B/op".
  - It is defined once per doc: README :64 and :327, the llms.txt Exports head, and the d.ts header.
  - Definition: "the library allocates nothing; a non-Smi argument (a key or count >= 2^31 on Node, >= 2^30 in
    Chrome, or a fractional DDSketch value) boxes ~16 B (12 B in Chrome) at a call V8 does not inline -- the
    addFrom / addHashedFrom family reads it unboxed".
  - Per-method lines say "0 library B/op". The addFrom and Into lines keep "0 B/op".
- **D8 (collapse / strict):** bound the collapse claim by the collapsed mass, not by q.
  - Collapse: "Once `collapsed`, a quantile is within alpha only if its rank lies above the mass folded into the
    floor bucket; below that it reads the floor representative. Which q survive depends on the value span vs
    `maxBins` (the window spans ~gamma^maxBins), not on q. Probe: 1001 x 147 then 999 log-spaced values in
    [1e3, 1e6] at maxBins 64 -> p50 and p90 both read 282199 (true 147 / ~251600)."
  - Strict: "rejects a value whose BUCKET KEY falls outside the range's key span; at alpha 0.01, `range: [1, 100]`
    accepts 0.99 and 101 (they share the edge buckets)". Hand-checked: key(0.99) = key(1) = 0, and
    key(101) = key(100) = 231.
- **D9 (lockfile) -- DROPPED during review:** package-lock.json is gitignored and untracked, so a docs-gate rule
  on it threw on a fresh clone and was tautological after `npm install`. The original text: set package-lock's top-level and `packages[""]` `version` from 0.1.0 to 1.1.2.
  - This is a SYNC to the current version, not a bump. It lets /release's `git grep 1.1.2` find the lockfile and
    move it with the trinity.
  - VERSION, package.json and the llms version stay 1.1.2.
- **D10 (lite-hud):** H2.8 does NOT touch ../LiteHud.
  - The probe82 result and the N6 `hud` lanes go into this 7.9 Result.
  - The orchestrator forwards them to a lite-hud session (LiteHud/ROADMAP 8.2, :417-453).

Hot body vs cold path:
- 0 hot bytes change, and no cold code changes either.
- Sketch.js changes are COMMENTS only:
  - the header :2-8 (the "v1.1.2" version token stays for /release);
  - the "HOT, 0 B/op" jsdoc on add / addHashed / estimate / estimateHashed / errorOf, DD add, and the DD indexable
    getters (:254 :312 :399 :589 :758 :846 :963 :1020 :1187 :1460 :1466 :1475 :1482 :1925 :2077 :2195 :2209).
- The addFrom / Into / `@private` comments stay.
- If a doc claim can only be made true by changing code, the coder STOPS and reports. None is expected.

Zero-box: no hot path is touched. The new controls box on purpose and live only in harness files.

Parity:
- `git diff HEAD -- Sketch.js` touches only lines inside `/** */` or `//` comments; qa checks this mechanically.
- parity.mjs shows 0 diffs vs HEAD.
- witness sha1 stays 2ed81a8b.

Teeth:
- Every new or lowered gate FAILs on 1.1.2 (D5), or carries a live control: N4 in 3 homes, plus the chrome CTRL.
- The docs gate FAILs on HEAD's docs.

Doc sites: README, llms.txt, Sketch.d.ts, ADR 0001 / 0004 amendments, CHANGELOG [Unreleased], RESEARCH.md, ROADMAP.
Never VERSION.

Out of scope:
- The version trinity, the CHANGELOG head rename and pack (all /release).
- ../LiteHud.
- Any Sketch.js code.
- Promoting bcdiff or the mutant matrix.
- Gating Chrome nc.
- serialize.

**Tasks** (coder A runs T1 -> T2 -> T3. Coder B runs T4 -> T5; both edit package.json, so B does them in order.
Coder C runs T6 -> T7 in parallel with A / B. T8 comes last, after qa's numbers.)
- **T1 (A, test/perf/PerfGate.test.mjs):**
  - Set `maxScavenges: 2`.
  - Add `oneBoxCtl` to `mustFail`.
  - Rewrite the comments at :4-7 and :219-231 (D3).
- **T2 (A, test/torture.mjs):**
  - Delete SCAV_BOX and move scAh / scCh into the SCAV_CLEAN conjunction.
  - Add `ctlStep` + `scCtl` with a VACUOUS line, plus the SCAV print and `!ok` diagnostics.
  - Rewrite the comments (D3).
- **T3 (A, test/lanes/lane.mjs + test/lanes.mjs):**
  - Add laneType `ring` and the gate `N4-CTRL[df/ring]` (min of 3 >= 8).
  - The header :8-27 lists N4.
- **T4 (B, test/chrome/run.mjs + page.html; package.json `chrome` + verify):** D4. The header documents the modes,
  the nc exclusion, the flags and `CHROME_BIN`. ASCII-only.
- **T5 (B, test/revert.mjs; package.json `revert-check`):** D5. Families run sequentially; no unhandled rejection.
- **T6 (C, docs, D7 / D8; re-grep every line first):**
  - **README**, lines to edit: :30 :64 :100 :137 (also collapse + strict) :150 :167 :180 :188 :189 :215 :216 :219
    :220 :244 :278 :327 :341 :343 :345 :351 :357 :371.
  - **README allocation table:**
    - :331 `add(key)`: the key goes into the `_buf` Float64Array(1) scratch; `_addAt` hand-inlines the murmur into
      int32 locals; no module slot is written.
    - :332 `addHashed`: "0 library; a lane >= 2^31 boxes at a non-inlined call -> addHashedFrom".
    - :335 `count()`: add "+ the preallocated `_hist` Int32Array(q+2)".
    - :339 ctor: `Uint8Array(2^p)` + `_hist` + `_buf`.
    - :341: the CMS constructor allocates `Uint32Array(d*w)` + `_idx` Int32Array(d) + `_base` Int32Array(1) + `_cnt`
      Float64Array(1) + `_buf` Float64Array(2).
    - :349: the module lane slots belong to `mix64` / `hashHi` / `hashLo` only.
  - **README Testing (:365-373):** state "<N> tests", taken from the `npm test` summary. List the full lane set,
    chrome, revert-check and parity.
  - **llms.txt:** :32 :45 :65 :70-71 :81 :114 :186 :280 :372 :435 :446.
  - **Sketch.d.ts:**
    - "0 B/op" lines: :50 :70 :73 :115 :168 :171 :180 :183 :270 :273 :282 :387.
    - Collapse / strict lines: :208 :225-226 :264-268 :310.
  - **Sketch.js:** the comments listed under "Hot body vs cold path".
  - **ADRs:** a dated H2.8 amendment in 0001 / 0004, and in any other ADR that repeats the claims (grep `0 B/op`,
    `p50/p90/p99`, `module-scope`).
  - **RESEARCH.md :11-12:** past tense.
  - **Lockfile:** D9.
- **T6g (C, test/docs.test.js, part of `npm test`).** It scans README / llms.txt / Sketch.d.ts / Sketch.js and
  asserts:
  - every line matching `/\b0 (?:B|bytes)\/op\b|\*\*0 bytes\*\*/i` also contains `library`, `From`, `Into`,
    `unboxed` or `net`;
  - no line matches `/tail-accurate p50|\(p50\/p90\/p99 -- the ones you page on\)/`;
  - the README Testing section matches `/\b\d{3} tests\b/`;
  - the lockfile's `version` and `packages[""].version` equal package.json's `version`.
- **T7 (C, CHANGELOG [Unreleased]):**
  - Reorder the sections to Added / Changed / Fixed.
  - Split F1 out of the F2 bullet (:112-127) into its own Fixed bullet.
  - Rewrite the in-progress phrases at :83 :92 :108-109 :120-125 ("fixed later in 1.2.0", "deferred to a later
    1.2.0 step", "until addFrom lands (1.2.0)") to the final state.
  - **Added:**
    - Refresh the `npm run lanes` entry (:223-228) to the full gate set.
    - Add `npm run chrome`, with the N6 numbers, and `npm run revert-check`.
    - Make the Chrome claims cite N6.
  - **Changed:**
    - F9: 64 -> 2, SCAV_BOX removed, the N4 control reads 12-25.
    - The "0 library B/op" wording.
    - verify now needs a local Chrome.
  - **Fixed (docs):** the collapse / p90 overclaim, strict-by-bucket-key, the allocation table, the lockfile.
  - Every number cites a gate. Add no version heading.
- **T8 (orchestrator / C, ROADMAP):**
  - :8-15, the NEXT block.
  - :32 H1 -> SHIPPED (1.1.0; 1.1.1-1.1.2 were packaging).
  - :33 H2 -> "BUILT & GREEN, awaiting /release 1.2.0".
  - :34 "(now H2 F11)" -> F7.
  - The section 7 heading, the F9 / F19 / N4 / N6 row deltas and the 7.1 row.
  - The 7.9 Result: the D5 table, the Exit evidence, and the D10 note.

**Assertions (qa; 3 runs unless stated)**
- **h1 (F9 / N4, perf):** `npm run test:perf` passes 10/10 (the old 9/9 + oneBoxCtl).
  - Every scenario reads <= 2 (0 expected), and oneBoxCtl trips.
  - Mutant: with `maxScavenges` back at 64, the suite FAILs because oneBoxCtl no longer trips.
- **h2 (torture, GC budget + retention):** `npm run torture` prints `ok` on all 3 runs.
  - HLL / CMS addHashedFrom read 0 at clean 0. SCAV-CTRL reads >= 1; record the value.
  - gc major 0; maxMs <= 4.00.
  - `tracker.size()` returns to 0 over every build-fill-clear cycle (leak=size 0/0).
  - abGrowth <= 0; every measureAllocs lane reads 0 B/op.
  - Mutant: a Smi-only ctlStep gives VACUOUS -> FAIL.
- **h3 (lanes):** `npm run lanes` exits 0. N4-CTRL[df/ring] min >= 8; record the reps. Every H2.1-H2.7 gate is
  unchanged.
- **h4 (N6):** `npm run chrome` exits 0 in <= 60 s.
  - addFrom / AHF min <= 0.5 B/op; Into <= 1 B/call; add <= 12k + 0.5; CTRL df / ni >= 8.
  - `--lib` on a 1.1.2 copy exits 1, with ABSENT gates, HLL add small df >= 9, and SS add c30 ni >= 100.
  - `CHROME_BIN=/nonexistent`, with no Chrome on PATH, prints UNVERIFIED and exits 1.
  - Without `--enable-precise-memory-info`, CTRL < 8 -> FAIL.
- **h5 (revert):** `npm run revert-check` exits 0. Its table goes into the 7.9 Result as the Exit evidence: "N1-N5
  FAIL on 1.1.2, N4 trips". With `--ref 5fecd6e` it exits 1.
- **h6 (docs / parity):**
  - docs.test.js passes on the tree.
  - Over HEAD's README / llms / d.ts / Sketch.js / lockfile it FAILs: >= 30 unqualified lines, and the lockfile at
    0.1.0.
  - The Sketch.js diff is comment-only; parity exits 0 with 0 diffs; witness sha1 2ed81a8b.
  - ASCII-only; no stray tool-call tags.
- **h7:** `npm run verify` is green.
  - 358 + the docs tests, 0 todo; the README count equals the `npm test` summary.
  - test:types green; VERSION '1.1.2'; pack 7 files.

Reviewer focus:
- Is any limit raised? The only changes are 64 -> 2 and 48 -> gone.
- Can any control pass vacuously: a dead `gc`, no precise memory, a Smi store?
- Can an absent Chrome ever print ok?
- Does revert.mjs use only `git show`, and write only under os.tmpdir()?
- Does every doc number cite a gate?
- Is the Sketch.js diff comment-only?
- Is any in-progress narrative left in the CHANGELOG?

RISK: `verify` now needs a local Chrome. It fails closed (UNVERIFIED) without one, and a Chrome auto-update can move
the B/op numbers. Both are intended (fail closed); the /release machine has Chrome 154. `/release 1.2.0` must also
rewrite two content sites, not just swap a number: Sketch.js:8 ("v1.1.2 ships ...") and RESEARCH.md:9
("(1.0.0 -> 1.1.2)").
