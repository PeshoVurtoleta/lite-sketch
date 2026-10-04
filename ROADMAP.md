# lite-sketch -- roster roadmap (to 1.0.0: HyperLogLog -> CountMin -> DDSketch -> SpaceSaving)

Blueprint: `../LiteO1/ROADMAP.md` (milestone table, shared law, gate spec, per-member briefs)
and the `../LiteFilter` cadence (reference member + one per release, complete at 1.0.0). See
`RESEARCH.md` for the identity, the accuracy witness, the roster rationale, and the open
questions. ASCII-only (`->`, `<=`, `x`).

> **NEXT (2026-10-04): H2 -- v1.2.0** (section 7; audit record in RESEARCH.md section 13; S1-S7 SETTLED). The 1.1.2
> final sweep found allocation the gates admit:
> - HyperLogLog `add` sits in a Maglev deopt loop, at ~0.5 box/op even on small keys.
> - SpaceSaving passes keys and counts through helper arguments, up to ~8 boxes/op.
> - Chrome's 31-bit Smis box half of all hash words.
> - `maxScavenges: 64` / `SCAV_BOX = 48` admit 1.6-2.7 boxes/op.
> It also found 2 High fail-closed bugs: a DDSketch tiny-alpha constructor hang, and `merge` dropping
> `collapsed`. lite-hud M3 waits for this release.

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
| **H2** | **Zero-box PATH + `addFrom` family + fail-closed fixes** (final-sweep audit of 1.1.2, 2026-10-04) | 1.2.0 | HLL deopt-loop fix; SpaceSaving / CMS argument-free helpers; `addFrom(buf, i)` on HLL / CMS / SpaceSaving; DDSketch tiny-alpha hang + collapsed-merge fix; negative-key hash fix; calibrated gates incl. a Chrome lane. Unblocks lite-hud M3 | PLANNED (section 7) |
| -- | 1.2 additive (post-H1) | 1.2.0 | `SpaceSaving.topKInto` 0-alloc sorted top-k (now H2 F11); serialize/deserialize across all four members | serialize: backlog (section 6) |
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

## 7. H2 -- v1.2.0: zero-box path + addFrom family + fail-closed fixes (final-sweep audit of 1.1.2, 2026-10-04)  [PLANNED]

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
| F2 | A3/A4 (H/M) the murmur helpers `_m3round` / `_m3final` (:75, :90) take and return int32 words. In Chrome (31-bit Smis) any word outside +-2^30 boxes, about half of all hash words: no-inline small keys count 1 gives HLL 77, CMS 113, SS 170 B/op. On Node, CMS `lo = a >>> 0` (:621/:715) into `_m3round` boxes for \|key\| >= 2^31 (49 vs 24 no-inline; the -2^31 class 73). | Hand-inline the murmur in every hot body (HLL/CMS/SS add, CMS estimate, SS home). Use `lo = a \| 0`, `hw = ((a / 2^32) \| 0) ^ neg` (with F12's sign fix), `M3_ADD = 0xe6546b64 \| 0`. Replace `Math.abs(key) > MAX` with two compares. | N3 (library delta <= 2) and N6 (Chrome) green. |
| F3 | A2 (H) SpaceSaving doubles crossing calls: `_mapDeleteKey(this._key[sl])` (:1572), `_hash(mkey[j])` per backshift step (:1815), `_attach(slot, val, hint)` (:1564/:1579/:1851), `_bump(slot, count)` (:1552), and `lo` -> `_m3round` (:1543/:1547). A per-key COUNT passing 2^31 boxes, which is exactly lite-hud's cumulative-microseconds case. No-inline 2^31 keys read 192 (~8 boxes/op, 125 B/op by sampler). | `_attach(slot, hint)` reads `_count[slot]` itself. `_homeAt(arr, i)` returns `h & mask` (always a Smi). `_probeAt(arr, i, home)` reads the key from the array. Eviction deletes via `_probeAt(_key, sl, _homeAt(_key, sl))`. Inline the bump path. | SS no-inline 2^31 keys 192 -> 24 (the caller box only). SS small keys with count 2^30: 24 -> 0. |
| F4 | A4 (M) CMS `_applyCons(base, ...)` / `_applyPlain(base, ...)` (:635-636) and per-row `_m3final` (:669/:693/:730) pass doubles. | `base` goes into an Int32Array(1) scratch and `count` into a Float64Array(2) scratch. The apply helpers take no arguments, and the per-row fmix is inlined. | CMS -2^31 keys 73 -> 24 and estimate no-inline 49 -> 24. |
| F5 | A5 (H for consumers) a key or count outside Smi range passed to `add(...)` is boxed by the CALLER at a non-inlined boundary (24 at 8N on Node, 12 B in Chrome). lite-hud's CMS key `channelIdx * 2^32 + tag` is >= 2^32 for every channel >= 1, so it ALWAYS boxes. | `add(key[, count])` validates, writes into a per-instance Float64Array scratch, and calls a shared `_addAt(buf, i)`. New `addFrom(buf, i)`: HLL reads key = buf[i]; CMS / SS read key = buf[i], count = buf[i+1]. Same validation and same throws (byte-identical no-op), like DDSketch.addFrom (1.1.0). CMS / SS `estimate` also go through the scratch. | N1: every addFrom lane <= 2 at 8N on Node (default + no-inline, fresh + warm, 6 key classes x counts {1, 2^30}). N6: 0 in Chrome. |
| F6 | A12 (L) the `addHashed` contract (uint32 lanes, :337/:649): any lane >= 2^31 boxes at the boundary (HLL addHashed 30, CMS 4). | `addHashedFrom(Uint32Array\|Int32Array, i)`, or accept int32 lanes. | An addHashedFrom lane at 0. |
| F7 | A9 (M) `SpaceSaving.forEach` passes key / count / error as callback arguments: 3130 B/call at k=64 (no-inline, 2^31 keys and counts). | `topKInto(outKeys, outCounts, outErrors, n)` (the old 1.2 backlog N2) or `snapshotInto`. Document `forEach`'s per-entry boxes. | A topKInto lane at 0. |
| F8 | A10 (M, doc) `SpaceSaving.merge` allocates fresh O(k) state per call (a Map, 2 objects per key, an array, 3 closures): 18.0 KB/call at k=64, 282.5 KB at k=1024. llms.txt:283 says "bounded cold scratch". A11 (L): HLL `count` (16.8 B/call default, 111 no-inline) and DD `quantile` (5 / 16 B) box their returns. | Fix the merge wording (or reuse a preallocated scratch). Document the returned-double boxes, and add `countInto` / `quantileInto` if a consumer needs a 0 B/op render. | The docs state the bytes, or the Into lanes are at 0. |
| F9 | A6 + A7 (H, harness) the perf gate's `maxScavenges: 64` (PerfGate.test.mjs:226) admits ~2.7 boxes/op, and its only mustFail allocates ~528 B/op. The torture `SCAV_BOX = 48` (torture.mjs:303) admits 1.6 boxes/op and pins F1 as "acceptable". The comments at torture.mjs:288-299 and PerfGate:215-225 misattribute the floor. torture.mjs:335-341 says the add-box teeth "live in lite-hud", but they reproduce here. | Lower `maxScavenges` 64 -> 2 and `SCAV_BOX` 48 -> 0. Add the N4 one-box mustFail. Fix the comments. | N4 trips. All lanes pass at the new thresholds after F1-F5/N7. |

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
| F18 | B-A9 / A10 / A11 (L) the option check uses `in` against a frozen object that inherits Object.prototype (:521, :906, :1446): `{constructor:1}` / `{toString:1}` are accepted, `{__proto__:{seed:5}}` sets the seed, and Map / Date are accepted as bags. `SpaceSaving.forEach` uses a stale loop bound under mutation (:1620-1624: `clear()` at the first entry visits 4 ghosts, `merge()` mid-walk visits key 1 twice). -0 is stored as-is (SS key, DD min). | Use own-property checks and read only own values. Use the live `_size` bound and document "no mutation in forEach". Normalize with `key + 0`. | `{toString:1}` throws in all three classes. `clear()` mid-walk visits 1 entry. `Object.is(topK()[0].key, 0)`. |
| F19 | D1-D4 (L) docs. README:137 overclaims "p50/p90/p99 within alpha" under collapse (probe: p50 6187 vs 147), and says strict throws by value when it really works by bucket key (`range [1,100]` accepts 0.99 and 101). The README:322-330 allocation table describes module-scope slots the code never writes, and omits `_hist` / `_idx`. The README Testing section has no count (182). RESEARCH.md:9 says "Not yet coded", ROADMAP H1 says "awaiting publish", and the lockfile version is 0.1.0. The unqualified "0 B/op" lines (README:30/64/100/167/188/213/215/272/275/318-334, llms.txt:32/42/65/70/299, Sketch.d.ts:68/141/147/306/315) need "0 library bytes/op; a non-Smi argument boxes at a non-inlined boundary; use addFrom". | Text fixes. | Grep: no unqualified 0 B/op line, and the count is stated. |
| F20 | Found by H2.1 qa, confirmed on HEAD (M): all 33 cold throwers build their message with `String(x)`, which runs caller code. Three consequences: (1) `add(Object.create(null))` on any member, and `new DDSketch(Object.create(null))`, throw an UNTAGGED `TypeError: Cannot convert object to primitive value`; (2) a `toString` that throws replaces the tagged error; (3) a `toString` that calls `h.addHashed(0,0)` changes the receiver during a rejection that must be byte-identical (reg[0] 0 -> 53, and the throw is still tagged). | One cold `_describe(x)` shared by every thrower: `typeof` first, primitives formatted directly (`String` is safe for number / string / boolean / bigint / symbol / undefined, plus null), and `'[object]'` / `'[function]'` for anything else, so no user code ever runs. Replace every `String(x)` in a throw path. | A null-proto object and a throwing / mutating `toString` give a TAGGED throw with byte-identical state in all four members and every ctor. Remove the `todo` in test/HyperLogLog.test.js (case 6) and make it a real test. |

**New gates (N)** (none exist today)

| id | gate | fails on 1.1.2 |
| --- | --- | --- |
| N1 | Float64Array-fed scaling lanes in a child process with `--max-semi-space-size=4`, default AND `--max-inlined-bytecode-size=0`. Each of the 4 addFrom x 6 key classes (small, 2^30+, 2^31+, 2^32-1, -2^31, 2^53-1) x counts {1, 2^30} x fresh/warm must read <= 2 at 8N. | HLL / CMS / SS (no addFrom). DD passes. |
| N2 | `add` lanes with Smi-range arguments (small and 2^30+ keys, counts 1 and 2^30), default + no-inline: <= 2. | HLL small 12-13; SS count 2^30 24 |
| N3 | Library-only delta: `add` with keys >= 2^31 minus a no-op baseline receiving the same arguments must be <= 2. | SS 192 vs 24, CMS 49/73 vs 24, HLL 72-104 vs 24 |
| N4 | A calibrated one-box mustFail (Float64Array -> fractional value -> ring store) must read >= 12 at 8N. It ships with `maxScavenges` 64 -> 2 and `SCAV_BOX` 48 -> 0. | HLL add-stream 6, HLL addHashed 30, SS evict 12 (harness, fixed by N7) |
| N5 | Deopt-loop gate: a `--trace-deopt` child shows <= 3 `add` deopts per lane. | HLL 416-461 |
| N6 | Headless Chrome lane (`--enable-precise-memory-info` + gc(), default and no-inline): addFrom 0, and `add` <= 12 B per non-Smi argument. Node cannot replace this lane: it never sees 31-bit-Smi boxes. | HLL 77, CMS 113, SS 170 B/op |
| N7 | Driver rule: drivers pass `add` only Smi-range values; full-range keys go only through `addFrom`. | the SS evict / HLL addHashed drivers pass `v >>> 0` |
| N8 | Query lanes: SS.forEach with entries >= 2^31 and a non-inlined callback; the Into APIs at 0. | forEach 3130 B/call |
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
| **H2.1** | F1 + the reusable child-process lane harness (N2-HLL, N5, a one-box control) + the HLL torture lane at 0 | 2 lines of HLL |
| H2.2 | F10, F11, F17 (S2, S3): the DDSketch ctor and merge fail-closed fixes | DDSketch ctor / merge |
| H2.3 | F13, F14, F15, F16 (S4, S5, S6) + F20: counting honesty (estimate guard, `saturated`, count cap, withX throws) and the `String(x)` thrower fix | validation only, no restructure |
| H2.4 | F2 + F12 (S1): the hand-inlined murmur + sign bit at all five sites, and the N9 parity harness | hash sites |
| H2.5 | F3 + F4: argument-free SpaceSaving and CMS helpers (N3) | SS / CMS internals |
| H2.6 | F5 + F6: the `addFrom` / `addHashedFrom` family, N1, N7 | public API (additive) |
| H2.7 | F7, F8, F18: `topKInto`, merge / query cost docs, option bags, forEach, -0, N8 | cold paths |
| H2.8 | F9 + N4 + N6 (Chrome lane), F19 docs, the 1.2.0 trinity, /release | gates + docs |

### 7.2 H2.1 spec -- F1 + the lane harness  [DONE 2026-10-04, awaiting maintainer commit]

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

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
