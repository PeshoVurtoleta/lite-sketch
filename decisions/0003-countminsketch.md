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

## H2.5 amendment (2026-10-04) -- argument-free update helpers (F4)

Zero behavior change (bit-identical to the pre-H2.5 build (de7ecaf, which already carries F12) over
636,951 parity checks). `_applyCons`
/ `_applyPlain` took `(base, count)`, so a non-constant `count >= 2^31` boxed a `HeapNumber`
crossing the call in the default tier (the remaining Node F4 box after H2.4's int32 hash words).

1. **Per-instance scratch, allocated once in the ctor:** `_base = new Int32Array(1)` and
   `_cnt = new Float64Array(1)`. `add` / `addHashed` write `_base[0] = h ^ g` (resp. `hi ^ lo`) and
   `_cnt[0] = count`, then call `_applyCons()` / `_applyPlain()` with **no arguments**; the helpers
   read `base` / `count` back from the slots. The double stays in the typed-array slot end to end.
2. **The per-row fmix is hand-inlined** (`x ^= x >>> 16; x = Math.imul(x, FMIX_C1); ...`), bit-
   identical to `_m3final((base ^ i*ODD_CONST) | 0)`, so the helpers stay monomorphic and under the
   460-byte inline cap (`add` 362 -> 378, `_applyCons` 222 -> 307, `_applyPlain` 150 -> 224).
3. **`estimate` / `estimateHashed` are byte-identical** (364 / 168 bytes unchanged); their per-row
   fmix inline is deferred to 1.2.0 through the F5 scratch (422 bytes would crowd the cap with H2.6's
   own bytes). An interleave parity test confirms `_base` / `_cnt` are PER-INSTANCE, not shared.

## H2.6 amendment (2026-10-04) -- the addFrom family + the F2 / estimate hand-inline (F5, F6)

Bit-identical output over the N9 parity sweep (incl. `estimate` across 1.5 / NaN / +-Inf / +-2^53 /
1e300); the H2.5 `estimate` per-row fmix deferral is resolved here.

1. **`add` -> wrapper + `_addAt`; `estimate` -> wrapper + `_estimateAt`.** `add(key, count)` rejects a
   non-number key OR count FIRST via a cold `_badArgs(key, count)` that replays HEAD `add`'s exact
   guard order (full key check, then count), so the thrown class + message are IDENTICAL to HEAD for
   every bad `(key, count)` pair; it then writes `key` / `count` into `_buf = Float64Array(2)` and
   defers to `_addAt(_buf, 0)` (`_base` / `_cnt` written only AFTER all three guards). The murmur is
   hand-inlined in `_addAt` (F2). `estimate` writes the key into `_buf[0]`, runs `_estimateAt(_buf,
   0)`, and returns `_buf[1]`: **D3** -- `_estimateAt` writes the d-cell minimum into `_buf[1]` rather
   than returning it, so a min `>= 2^31` never boxes on the non-inlined return. Its per-row fmix is now
   inlined.
2. **`addFrom(buf, i)`** reads `key = buf[i]`, `count = buf[i+1]` (needs `i+1` in bounds).
   **`addHashedFrom(buf, i)` is 3-slot** `[hi, lo, count]` -- i.e. `addHashed(hi, lo, count)` with
   every argument read unboxed, using `addHashed`'s count guard verbatim (D2). WHY 3 slots and not a
   fixed count of 1: a counted stream's count would otherwise have to cross the call as a boxed
   argument, re-introducing the box the entry point exists to remove; it is symmetric with CMS
   `addFrom(key, count)` and `addHashed(hi, lo, count)`. An `Int32Array` cannot carry a count `>=
   2^31`, so that cap is documented.

## H2.7 amendment (2026-10-05) -- plain-bag options (F18, D2) + the merge brand (F21)

Cold paths only; the hot bodies are byte-identical.

1. **Options are an own-property plain bag (F18, D2).** `CMS_KNOWN_OPTS` inherited `Object.prototype`,
   so the `key in CMS_KNOWN_OPTS` test accepted `{ toString: 1 }` / `{ constructor: 1 }`, and option
   values were read through the prototype chain (`new CountMinSketch(4, 64, Object.create({ seed: 5 }))`
   picked up `seed: 5`; `Object.create({ conservative: false })` the flag). The KNOWN set is now
   `Object.freeze({ __proto__: null, seed: true, conservative: true })` (same key order), and the ctor
   classifies the argument through the module helper `_optScan`: a valid bag is a non-null object whose
   prototype is `null`, is THIS realm's `Object.prototype` (its keys ignored, so a polluted
   `Object.prototype.seed` still yields the default), or is another root prototype
   (`Object.getPrototypeOf(p) === null`) that carries NO own KNOWN key -- otherwise an inherited option
   would be silently dropped, so it fails closed (a clean `vm` / iframe literal still passes; a
   cross-realm `Object.prototype` polluted with a known key is rejected). `Map` / `Date` / `RegExp` /
   arrays / class instances / `Object.create(proto)` are not bags. Every own key (`Reflect.ownKeys`, symbols and non-enumerable keys
   included) must be a string in the KNOWN set, and every own property must be a DATA descriptor -- an
   own accessor makes the object a non-bag, so no getter runs. Values are read with `_optOwn` (the own
   data descriptor, never `[[Get]]`). The scan + the own reads sit in ONE `try`; a revoked or
   throwing-trap `Proxy` is caught and rejected with the plain-object `[lite-sketch]` TypeError (not the
   untagged engine `IsArray` throw it used to). The value checks run AFTER the `try`, verbatim from the
   prior code, so a tagged `RangeError` / `TypeError` is never swallowed. No new message text.
2. **The merge brand (F21).** `merge` brand-checked with `instanceof`, which a field copy and a
   `new Proxy(real, {})` pass (a forged CMS previously threw an UNTAGGED TypeError on some paths). A
   private `#brand` field is installed by the ctor, and `merge` / `_badMerge` test `typeof other ===
   'object' && other !== null && #brand in other` first, before any read of `other` (closing the H2.3
   RISK that a forged `other` runs caller code through `this._total + other._total`). A forgery throws
   the tagged `[lite-sketch]` TypeError as a byte-identical no-op; subclasses still merge. The d / w /
   seed shape test follows, minus the dropped `instanceof`.

## Non-goals

No range / heavy-hitter queries (that is SpaceSaving, M4, and DDSketch, M3); no serialization
format in the zero-GC core; no automatic sizing beyond `withAccuracy`. DDSketch (quantiles) and
SpaceSaving (top-k) are M3-M4 to a stable 1.0.0.
