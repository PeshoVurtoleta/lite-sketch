# 0003 -- CountMinSketch: the frequency member (dense d x w matrix, conservative-update default, dual ctor)

Status: accepted (v0.2.0)

## Context

CountMinSketch (Cormode & Muthukrishnan 2005) estimates the FREQUENCY of a key in
an unbounded stream in fixed space: a `d x w` matrix of counters, each key mapped
to one column per row by an independent hash, `add` increments the d cells, and a
point query returns the MINIMUM of them. Because collisions only ever ADD, the min
is a one-sided over-estimate with the guarantee `f_hat - f_true <= epsilon * N` at
probability `>= 1 - delta`, where `w = ceil(e/epsilon)` and `d = ceil(ln(1/delta))`.
It is lite-sketch's second member (M2) and the frequency corner of the family,
pure-appended below HyperLogLog on the shipped two-lane hash (ADR 0001) and the
accuracy-witness / torture / perf chassis.

## The settled calls (user-accepted 2026-09-23)

1. **Dense `Uint32Array(d * w)` matrix, `w` a power of two.** A column is picked with
   a single `hash & (w - 1)` mask (the lite-o1 ring idiom -- no modulo). `d in [1, 32]`,
   `w` rounded UP to a power of two and capped at `2^25`. A hard `d * w <= 2^31` cap
   keeps every flat index `i*w + col` a SMI, so `counts[id]` never boxes a HeapNumber
   or deopts the hot path.

2. **Hot `add` / `addHashed` are 0 B/op** over the two-lane hash. The murmur is INLINED
   into int32 LOCALS exactly like `HyperLogLog.add` (it never writes the module lane
   slots, so a uint32 >= 2^31 lane never boxes), the base lane is `(hi ^ lo) | 0`, and
   the d row columns derive from it via `mix(base ^ i * ODD_CONST) & mask` (the standard
   cheap per-row salt, ADR 0001's `saltRow` scheme inlined so the intermediate stays
   int32). The d chosen flat indices are staged in a pre-allocated `Int32Array(d)`
   instance scratch, so even conservative update (two passes over the cells) allocates
   nothing. `estimate` / `estimateHashed` re-derive the columns and return the min.

3. **Conservative update (Estan-Varghese) is the DEFAULT.** Instead of `+count` on every
   row, raise each of the d cells only up to `min(cells) + count`. It never changes the
   min-query answer and provably tightens the over-estimate on skewed (Zipfian) streams
   -- the common case for frequency counting. `conservative: false` selects the classic
   plain-add matrix.
   - TRADE-OFF (disclosed): conservative update is NOT linearly mergeable. `merge` is
     element-wise saturating add, which is EXACT for plain sketches (merging two plain
     matrices equals one matrix over the concatenated stream) and a valid but LOOSER
     upper bound for conservative ones (still one-sided -- never undercounts). Callers who
     distribute-then-merge and need exactness use `conservative: false`.

4. **Dual constructor.** The primary `new CountMinSketch(d, w, options?)` takes the raw
   grid dims (the zero-GC power-of-two hot path); the static
   `CountMinSketch.withAccuracy(epsilon, delta, options?)` inverts the paper's bound
   (`w = ceil(e/epsilon)` rounded to a power of two, `d = ceil(ln(1/delta))`) and reports
   the ACHIEVED `epsilon` (= `e/w`) and `delta` (= `e^-d`) via getters. Both routes share
   one validation path (withAccuracy delegates to the ctor).
   - The width clamp runs BEFORE the power-of-two round-up: `cw <<= 1` is an int32 shift,
     so a `w > 2^30` (any `epsilon < ~2.53e-9`, still inside the validated `(0,1)` range)
     would overflow `cw` to 0 and spin forever. Clamping `w` to the cap first bounds the
     round-up. (Caught in review; regression-tested.)

5. **Counters saturate at `2^32 - 1`.** `add`, both update paths, and `merge` clamp instead
   of wrapping -- a wrap would silently corrupt the min-query monotonicity. `count` is a
   positive integer in `[1, 2^32-1]`.

6. **Fail closed.** The ctor throws `[lite-sketch]` typeof-first on a bad `d` / `w` / `seed`
   / `conservative` / unknown option (with a did-you-mean hint) BEFORE any allocation (no
   half-built instance escapes -- every field assignment follows every throw site); `add` /
   `addHashed` typeof-guard the key / lanes / count first (a Symbol / BigInt / NaN /
   non-uint32 lane / out-of-range count is a throw, byte-identical no-op); `estimate` /
   `estimateHashed` / getters / a valid `merge` never throw (a bad key estimates 0 -- an
   un-addable key has frequency 0). null is not zero.

7. **No enumeration surface.** Deliberately NO `forEach` / `[Symbol.iterator]`: a CMS has no
   recoverable key set (it stores counts, not keys), so an enumeration API would be a lie.

## The accuracy contract (the honesty anchor)

The witness drives the sketch on a Zipfian stream against an exact `Map` oracle, measures
the over-estimate `est - true` per distinct key, and GATES the fraction exceeding
`epsilon * N` at `<= delta` (with a small precautionary slack, since the bound is a
per-query Markov guarantee, not a simultaneous-concentration statement across every key of
one draw). It also gates one-sidedness (0 undercounts) and conservative <= plain, and prints
the space co-headline: `d * w * 4` bytes vs the exact `Map` whose memory grows O(distinct).
MEASURED vs THEORETICAL side by side (the lite-filter table shape).

## H2.3 amendment (2026-10-04) -- counting honesty (F13, F14, F15, F16, F20; S4, S5, S6, S7)

The hot bodies of `add` / `addHashed` / `estimate` / `_applyCons` / `_applyPlain` change only by
guard lines; no restructure.

1. **`estimate` guard widened to `add`'s (F13).** A key `add` would reject (non-integer /
   non-finite / `|key| > 2^53-1`) now estimates 0 instead of truncating under `>>> 0` and aliasing
   a real key (`estimate(Infinity)` / `(1.5)` / `(2**64)` no longer read a neighbour's count).
2. **One-sidedness is scoped to `!saturated` (F14, S4).** A sticky `saturated` getter is set on
   every `CMS_MAX_COUNT` clamp (cons, plain, merge), carried by `merge` from either side, and reset
   by `clear()`. While it is false the estimate never undercounts; once true a saturated key may
   read low. "NEVER undercounts" becomes "one-sided while `!saturated`".
3. **Running-total ceiling (F15, S5).** `count` stays `[1, 2^32-1]`; an `add` / `addHashed` /
   `merge` that would push `total` past `2^53-1` throws tagged (a new cold `_badTotal`) as a
   byte-identical no-op, so the exact aggregate never silently goes inexact.
4. **`withAccuracy` throws when unattainable (F16, S6).** The silent clamp of `w` to `2^25` and `d`
   to `32` is deleted; a request needing `w > 2^25` or `d > 32` now throws tagged. The clamp UP of
   `d` to `>= 1` stays (it only strengthens the guarantee).
5. **Cross-`conservative` merge is allowed and documented (S7).** `this` keeps its own flag; the
   result stays one-sided (exact only when both sides are plain).
6. **Throwers run no caller code (F20).** Every cold message now formats its rejected arg through a
   shared `_describe(x)` (typeof-first); a null-proto object / throwing / re-entrant `toString` can
   no longer escape the tag or mutate the receiver during a byte-identical rejection.

## Non-goals

No range / heavy-hitter queries (that is SpaceSaving, M4, and DDSketch, M3); no serialization
format in the zero-GC core; no automatic sizing beyond `withAccuracy`. DDSketch (quantiles) and
SpaceSaving (top-k) are M3-M4 to a stable 1.0.0.
