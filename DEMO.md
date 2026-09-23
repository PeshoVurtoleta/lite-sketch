# DEMO.md -- lite-sketch interactive demo blueprint

The build spec for lite-sketch's first interactive demo. This document is the
contract the coder builds `demo/index.html` against; the reviewer and qa gate the
build against the assertions here. It mirrors `../LiteO1/DEMO.md` verbatim in
spine (header / tabs / canvas stage + panel / 10Hz Truth Panel off a flat buffer)
and diverges only where the family story differs: lite-o1 proves a FLAT constant;
lite-sketch proves ACCURACY-vs-bound and SPACE-vs-exact. Section 9 marks exactly
what is package-agnostic template (inherited) versus lite-sketch-specific.

Repo-only. `demo/` is NOT added to package.json `files[]`; the npm tarball stays
7 files (the 6 `files[]` entries + package.json). Precedent: lite-o1, lite-filter,
lite-lru all ship demos repo-only. ASCII-only source per suite law (`->`, `<=`,
`x`, "us" for microseconds -- never Unicode, in code AND in the demo HTML text).

---

## 0. The two non-negotiables

lite-sketch makes TWO honest claims, so the demo has TWO load-bearing proofs:

1. **The hot path is zero-GC** (the lite-o1 discipline). Therefore the demo MUST
   ITSELF be zero-GC on every animation frame, or its own Truth Panel is a lie. A
   demo that allocates per frame while claiming its subject does not is the single
   worst outcome; the qa suite (Section 7) exists to make that impossible to ship
   silently. Corollary: the exact-oracle "vs" path is ALLOWED (indeed required) to
   allocate -- that is the contrast.
2. **The estimate is honest against the bound.** lite-sketch's identity is the
   ACCURACY WITNESS: measured error vs the paper's theoretical bound, next to the
   memory saved. So every accuracy and space number the demo displays MUST be
   re-derived live from the SHIPPED `Sketch.js` against a REAL exact oracle running
   in the same tab (a `Set` / `Map` / sorted `Float64Array`), never hardcoded and
   never faked. The witness runs in the browser exactly as `test/witness.mjs` runs
   headless. If the demo can ever draw the sketch inside its error band while the
   real error is outside it, the demo is a lie -- Section 7 gates against that.

---

## 1. The template it mirrors

Model exactly on `../LiteO1/demo/index.html` (itself modeled on the canonical
`../LiteSignal/demo/index.html`). Reuse the spine verbatim in shape:

- **Brand header**: mark + `@zakkster/lite-sketch` + live VERSION (read from a
  single constant, kept equal to the shipped `VERSION` -- Section 7 honesty test).
- **Tab nav** `<nav class="tabs">` with `<button data-tab="...">` and a
  `.scene-num` span (`01`..`04`).
- **Scenes** `<section class="scene" data-scene="...">`, one active at a time, each
  = a `<canvas>` stage (the hot SoA render of the sketch's memory) + an
  `<aside class="panel">` with a `.panel-head` ("scene 0X - name"), action buttons,
  topology sliders, and the live metric readouts.
- **Canvas** = brute-force high-DPI hot loop at 60Hz (rAF), streaming items into
  the sketch and redrawing its state. **SVG/DOM Truth Panel** = declarative,
  updated at ~10Hz off a shared flat buffer, decoupled from the canvas loop.
- Copy the canonical's self-imposed discipline: a built-once color-string cache
  (styling allocates only during warmup, never per frame), a reused scratch
  `Float64Array` for per-frame math, no per-tick allocating `setInterval`.

What we DIVERGE on: lite-o1 is a data-structure-family story; ours is an
approximate-summary-family story. The spine is identical; the scenes (Section 3)
and the Truth Panel's family signal (Section 4, item 4) are ours.

---

## 2. Roster -> scene map (all 4 shipped members demoed)

One scene per member. Each scene streams a pre-generated item stream (a reused
`Uint32Array`/`Float64Array`, no per-frame RNG alloc) into BOTH the sketch and a
live exact oracle, and shows: the sketch's memory as a canvas render, the live
estimate vs the oracle's exact answer, the measured error inside (or outside) the
theoretical bound band, and the SPACE gap (sketch fixed vs oracle growing).

| Scene | Member | Question | Canvas render | Oracle foil | Bound band | Space co-headline |
|-------|--------|----------|---------------|-------------|------------|-------------------|
| 01 | **HyperLogLog** | how many distinct? | dense Uint8 register bank (heat grid) | exact `Set` | +/- 1.04/sqrt(m) std err | 16 KB (p=14) fixed vs Set O(distinct) |
| 02 | **CountMinSketch** | how many times key x? | d x w Uint32 counter matrix (heat grid) | exact `Map` | one-sided `f_hat - f_true <= eps*N` | d*w*4 B fixed vs Map O(distinct) |
| 03 | **DDSketch** | p50 / p90 / p99? | log-scale bins (histogram) | exact sorted `Float64Array` | HARD `abs(v - v_true) <= alpha*v_true` | maxBins*8 B fixed vs sorted array O(N) |
| 04 | **SpaceSaving** | which few keys dominate? | k monitored counters (live top-k leaderboard) | exact `Map` | recall 100% > N/k; `[count-error, count]` | k counters fixed vs Map O(distinct) |

---

## 3. Per-scene specification

### Scene 01 -- HyperLogLog (cardinality)
- A key stream flies in; the dense `Uint8Array(m)` register bank is a heat grid
  (register value -> color). Each `add` lights the touched register; the max-rho
  update is the visible event. Live `count()` estimate ticks against an exact
  `Set` oracle drawn beside it.
- **Accuracy readout**: measured relative error `|est - true| / true` plotted as a
  cursor inside the +/- `1.04/sqrt(m)` std-err band; it should stay inside as N
  grows (the honesty signal -- a two-sided STATISTICAL bound, so label it "std
  err", not a hard cap).
- **Merge**: an action button splits the stream into two shards, each its own HLL,
  then `merge()` (register-wise max) -- show the union count matches the single-HLL
  count. A second button attempts a DIFFERENT-seed merge and flashes the new
  fail-closed throw (the 1.0.0 seed check).
- Sliders: precision `p` (register count m = 2^p, memory readout updates) and
  stream cardinality.

### Scene 02 -- CountMinSketch (frequency)
- A Zipfian key stream; the `Uint32Array(d*w)` matrix is a d-row x w-col heat grid.
  `add(key)` lights one cell per row; `estimate(key)` lights the d probed cells and
  marks the MIN-of-d (the returned over-estimate). Estimate vs an exact `Map`.
- **Bound band**: the one-sided `f_hat >= f_true`, `f_hat - f_true <= eps*N` gap;
  draw the true count and the estimate as two bars, the shaded gap must never
  exceed `eps*N`.
- **Conservative vs plain toggle**: same stream, two matrices; show conservative
  update tightening the over-estimate on the skewed stream (a smaller gap), and the
  note that conservative is not linearly mergeable.
- Sliders: `withAccuracy(eps, delta)` (drives d, w, memory) or raw d/w.

### Scene 03 -- DDSketch (quantiles / p99)
- A latency stream (lognormal or pareto, pre-generated); the log-scale
  `Float64Array` bins are a live histogram. `add(value)` increments one bin. Live
  p50 / p90 / p99 markers vs an exact sorted-`Float64Array` oracle (capped N, see
  Section 10) -- the p99 marker is the headline.
- **Bound band**: the HARD per-query relative error `|v - v_true| <= alpha*v_true`;
  draw each reported quantile's error as a fraction of `alpha` -- it must stay
  `<= 1.0` (this is the family's sharpest bound, so it is a real cap, not a std err).
- **Collapsing-lowest**: when the bins fill, animate the smallest-value collapse and
  the `collapsed` flag; note min/max stay EXACT while quantiles are alpha-approximate.
- Slider: `alpha` (drives gamma, bin count, memory, and the band width).

### Scene 04 -- SpaceSaving (heavy hitters / top-k)
- A Zipfian stream; the k monitored counters are a live top-k leaderboard.
  `add(key)` animates the intrusive count-bucket forest: an increment bumps a key up
  its bucket; at capacity, the min-count key is EVICTED and its slot reassigned to
  the newcomer at `count = min + count`, `error = min` (eviction IS the algorithm --
  show it never fails). `topK` / `heavyHitters` vs an exact `Map` oracle.
- **Bound band**: the headline is RECALL -- every true hitter above N/k is in the
  monitored set (100%, no false negatives); draw the `[count - error, count]`
  bracket on each leaderboard row and show the true count lands inside it, with
  `error <= N/k`.
- Slider: capacity `k` (drives memory and the N/k threshold line).

### Contrast (a cross-scene footer line)
Four questions, four fixed-memory sketches, one theme: each trades a bounded,
witnessed error for O(1) space where the exact oracle grows without bound.

---

## 4. The Truth Panel -- the two proofs

Stacked readouts, always visible, updated at ~10Hz from a shared flat buffer (NOT
rebuilt per frame). Items 1-3 are the package-agnostic zero-GC proof (inherited
from lite-o1 verbatim); item 4 is the lite-sketch family witness.

1. **PRIMARY -- jank detector (cross-browser, visceral).** Track dt between rAF
   frames; render a rolling bar strip; flash a bar RED past ~16.7ms. GC pauses ARE
   dropped frames -- visible in every browser with no privileged API. The sketch
   path stays green; the exact-oracle toggle goes red under load.
2. **PRIMARY -- owned allocation counter (provable, not sampled).** A counter we
   increment ourselves. The exact-oracle "vs" path literally grows a `Set`/`Map`/
   sorted array per distinct item and bumps the counter; the sketch path's counter
   is provably pinned at 0 after warmup. The honest headline: "sketch allocations
   since warmup: 0".
3. **SECONDARY -- retained heap (labeled Chromium-only, coarse).**
   `(performance.memory && performance.memory.usedJSHeapSize) || 0`, exactly as the
   canonical does. Quantized, lazily updated, gated behind `crossOriginIsolated`;
   shown only as a labeled secondary overlay, never the primary claim.
4. **FAMILY WITNESS (lite-sketch-specific, the star).** Two live signals, both
   re-derived from the shipped `Sketch.js` against the in-tab exact oracle:
   - **Accuracy vs bound**: the measured error as a fraction of the member's
     theoretical bound (Section 3), drawn as a cursor inside a band that must
     contain it. This is lite-sketch's equivalent of lite-o1's flat ops/ms line.
   - **Space vs exact**: two lines -- the sketch's FIXED bytes (flat) vs the exact
     oracle's bytes climbing O(N)/O(distinct). The gap is the whole point; label
     both in KB with the live N.

**The reveal** (per-scene "vs exact" toggle): the exact-oracle line climbs + jank
bars go red + alloc counter races; the sketch line stays dead flat, jank green,
counter pinned at 0, and its error stays inside the band. Fixed memory + bounded
error + zero GC, all at once.

---

## 5. Layout & interaction

- Header (brand + version) / tab nav / active scene (canvas + panel) / footer with
  a one-line "how to read this" and the secondary-metric caveat.
- Panel per scene: 2-4 action buttons, 1-3 topology sliders, the Truth Panel block,
  a sketch/exact toggle.
- High-DPI canvas sized once on load and on resize (resize is the ONLY place canvas
  buffers reallocate; never per frame).
- Keyboard: number keys 1-4 switch scenes; space pauses the active rAF loop.

---

## 6. Demo-side zero-GC guardrails (MUST hold; qa-gated)

Verbatim from lite-o1 Section 6 -- the sketch `add`/`estimate`/`quantile` call is
the hot path; the exact oracle is the allowed-to-allocate contrast.

1. Pre-allocate all canvas/scratch buffers AND the pre-generated item stream at
   warmup. The ONLY reallocation is on an explicit resize or a user topology change
   (a new p / alpha / k rebuilds the sketch), never inside rAF.
2. No `ctx.save()`/`ctx.restore()` inside the rAF loop (they allocate state).
3. No object/array literals, no closures, no allocating `Array.prototype` methods
   (`map`/`filter`/`slice`/spread) inside the hot draw path. (`topK`/`heavyHitters`
   ALLOCATE by contract -- call them on the 10Hz tick, never per frame.)
4. One reused scratch `Float64Array` for per-frame math; index into it.
5. No string concatenation in the hot draw path: pre-format static labels once;
   update SVG/DOM text at 10Hz from the shared flat buffer, not per frame.
6. Any graph/forest walk (the SpaceSaving bucket forest) uses an integer epoch
   marker, no visited Set/array allocated.
7. Any timer that fires must not allocate per tick.
8. ASCII-only source.

---

## 7. Honesty proof -- `demo/Demo.test.mjs` (node:test)

Precedent: lite-o1 and lite-filter ship a real `demo/Demo.test.mjs` run in CI that
proves the demo's visualized data matches the SHIPPED library and is non-vacuous
(mutation-bitten). Do the same:

- **Faithfulness**: every value the demo displays as a library result is re-derived
  from the ACTUAL imported classes (`import { HyperLogLog, CountMinSketch, DDSketch,
  SpaceSaving, VERSION } from '../Sketch.js'`), not hardcoded. Assert the demo's
  estimate/quantile/topK equal the library's on the same stream.
- **Witness faithfulness (lite-sketch-specific)**: on a fixed seeded stream, assert
  the demo's displayed measured error equals the error computed directly from
  `Sketch.js` vs the exact oracle, AND that it satisfies the member's bound at the
  demo's default topology (reuse the thresholds from `test/witness.mjs`: HLL within
  a std-err multiple, CMS gap `<= eps*N`, DDSketch within alpha, SpaceSaving 100%
  recall + bracket). This is what stops a pretty-but-lying band.
- **Version trinity extension**: the demo's displayed VERSION constant must equal
  `require('../package.json').version` AND the exported `VERSION` from `Sketch.js`.
  A string compare. (Stops a stale demo version slipping a /release.)
- **Zero-alloc gate of the demo's hot kernels**: extract the per-frame math kernels
  (stream-step + sketch add + render-prep) into testable functions and gate them at
  0 B/op with the lite-leak + lite-gc-profiler approach, mirroring `test/torture.mjs`.
  If a kernel cannot be proven 0 B/op headless, it does not belong in the rAF loop.
- **Non-vacuous**: each faithfulness assertion must FAIL under an injected mutation
  (qa's job), exactly as the library suites are proven.

`demo/serve.mjs` provides `npm run demo:serve` (a static file server, no deps) so
the user can open the demo locally; `npm run demo` headless-runs the honesty render
/ witness. Wire both as scripts; add NOTHING to `files[]`.

---

## 8. Packaging & pipeline

- **Files** (all repo-only) -- the SETTLED family structure, identical to
  `../LiteO1/demo/` and `../LiteLogN/demo/`, four files:
  - `demo/index.html` -- the page; imports `kernels.mjs` as a module.
  - `demo/kernels.mjs` -- the extracted hot math (stream-step + sketch add +
    render-prep). REQUIRED, not optional: it is the importable surface the 0-B/op
    gate and `Demo.test.mjs` test directly (Section 7). If a kernel cannot be proven
    0 B/op headless here, it does not belong in the rAF loop.
  - `demo/Demo.test.mjs` -- the honesty suite.
  - `demo/serve.mjs` -- the static file server (no deps).
- **package.json**: add the two scripts EXACTLY as the siblings spell them --
  `"demo": "node --expose-gc --test demo/Demo.test.mjs"` and
  `"demo:serve": "node demo/serve.mjs"`. `files[]` UNCHANGED (6 entries);
  `npm pack --dry-run` must still show exactly 7 files (the 6 + package.json)
  with `demo/` absent. `Sketch.js` is NOT touched by this session (the demo imports
  it, read-only); VERSION stays 1.0.0. While here, FIX the dangling `bench` script
  (it points at a non-existent `benchmark/Bench.mjs`) -- either restore the
  benchmark or drop the script; do not leave a broken npm script in a 1.0.0 package.
- **Pipeline**: this DEMO.md is the planner-equivalent spec. Then coder builds ->
  reviewer audits the diff for per-frame allocation AND fail-open metric lies (a
  band that can't be exceeded, a hardcoded error) -> qa writes Demo.test.mjs
  (faithfulness + witness-faithfulness + version-trinity + 0-B/op kernel gate +
  non-vacuous). Reviewer REJECTED goes back to coder. USER commits/publishes; the
  assistant never does.

---

## 9. Sibling-demo foundation (lite-adaptive)

This demo is built as a TEMPLATE, not a one-off. The following is package-agnostic
and copies wholesale into `../LiteAdaptive/DEMO.md`, swapping only the roster/scenes
and the witness flavor:

- Section 1 spine (header / tabs / canvas stage + panel / 10Hz Truth Panel off a
  flat buffer) -- unchanged.
- Section 4 Truth Panel items 1-3 (jank detector + owned-allocation counter PRIMARY;
  `usedJSHeapSize` SECONDARY, labeled) -- unchanged across siblings.
- Section 6 zero-GC guardrails -- unchanged, verbatim.
- Section 7 honesty proof (faithfulness + version-trinity + 0-B/op kernel gate +
  non-vacuous) -- unchanged in shape.
- Section 8 packaging (repo-only, `demo`/`demo:serve` scripts, pack count unchanged)
  -- unchanged.

**Package-SPECIFIC** (each sibling rewrites): the roster->scene map (Sections 2-3)
and the Truth Panel's item-4 WITNESS overlay. lite-sketch shows ACCURACY-vs-bound +
SPACE-vs-exact (cumulative). lite-adaptive will show the WINDOWED/DECAYED accuracy
witness + the CHANGE-RESPONSE overlay (detection latency vs an injected changepoint)
against an O(W) exact-window foil. Building lite-sketch's demo first means the
recency sibling inherits a proven, honest chassis instead of reinventing it.

---

## 10. Design calls to settle before coder (for the user)

1. **Scope of the first build**: all 4 scenes in one pass, or a vertical slice
   first (Scene 01 HyperLogLog fully polished + the shared chassis + Truth Panel +
   Demo.test), then scenes 02-04 in follow-ups? RECOMMENDATION: vertical slice
   first -- it de-risks the chassis and the honesty proof, and it is the exact part
   the lite-adaptive sibling inherits, so it is worth getting right before breadth.
2. **File structure**: SETTLED -- match lite-o1 and lite-logn exactly, the four-file
   `demo/` split (index.html + kernels.mjs + Demo.test.mjs + serve.mjs), index.html
   importing kernels.mjs. Not an open call; it is the family convention, and the
   importable kernels are what the 0-B/op honesty gate needs anyway.
3. **Visual identity**: inherit the lite-o1 / canonical LiteSignal palette and
   typography, swap only the accent color, so the family reads as one? RECOMMENDATION:
   inherit the chassis, pick a lite-sketch accent distinct from lite-o1's.
4. **The exact-oracle N cap (lite-sketch-specific)**: the DDSketch sorted-array
   oracle and the Set/Map oracles grow without bound and will OOM a browser tab at
   high N. RECOMMENDATION: cap the oracle at a stated N (e.g. 1e6) and label it --
   "exact oracle capped at N to keep the tab alive; the sketch would keep going in
   the same fixed memory" -- which is itself the space argument made visible.
5. **Stream generation**: one reused pre-generated seeded stream buffer per scene
   (Zipfian for CMS/SpaceSaving, lognormal/pareto for DDSketch, uniform keys for
   HLL), replayable, no per-frame RNG alloc. RECOMMENDATION: yes -- pre-generate at
   warmup / on a topology change, exactly as the guardrails require.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
