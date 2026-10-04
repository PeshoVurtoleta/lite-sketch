# 0005 -- SpaceSaving: the heavy-hitters / top-k member (bucket-forest + open-addressing map, dual ctor, merge, no addHashed)

Status: accepted (v0.4.0)

## Context

SpaceSaving (Metwally, Agrawal & El Abbadi, "Efficient Computation of Frequent and
Top-k Elements in Data Streams", 2005) finds the most frequent items (heavy hitters
/ top-k) of an unbounded stream in a fixed `k` counters. It is lite-sketch's fourth
and FINAL member (M4), the TOP-K corner that completes the family: HyperLogLog
(count) -> CountMinSketch (frequency) -> DDSketch (quantiles) -> SpaceSaving (top-k).
A 1.0.0 milestone (no new member) then declares the four-member API stable.

The algorithm: monitor k `(key, count, error)` triples. `add(key)`: if the key is
monitored, increment it; if a slot is free (< k tracked), insert it at count 1,
error 0; if all k are full, EVICT the minimum-count key, reassign its slot to the
newcomer at `count = min + count` and `error = min` (the evicted min is the
newcomer's maximum possible over-count). It NEVER fails at capacity -- eviction IS
the algorithm. Guarantee: every element with true frequency > N/k is monitored (NO
false negatives); a monitored key's true count lies in `[count - error, count]`;
`error <= the current min counter <= N/k`.

## The settled calls (user-accepted 2026-09-23)

1. **Zero-GC substrate = a synthesis of the suite (design-parity, never a dep).**
   - The O(1) increment-and-find-min structure is an intrusive frequency-bucket
     forest -- the `@zakkster/lite-o1` `FreqO1` pattern: buckets sorted ascending by
     count in a doubly-linked list, each bucket owning a sibling list of counter
     slots at that count; `_minBucket` is the head. Increment moves a slot to the
     count+1 bucket (birth/reuse via a free-list); eviction pops the min bucket's
     head. All over `Int32Array` node/bucket pools + a free-list, 0-alloc.
   - The general-integer-key -> counter-slot map is fixed open addressing (the
     `CuckooMap` idiom) over `_mapKey` (Float64, keys exact to 2^53) + `_mapOcc`
     (Uint8, so 0 is a legal key -- "null is not zero") + `_mapSlot` (Int32), sized
     to `M = next pow2 >= 2k` (load <= 0.5). Deletion is Knuth BACKSHIFT (no
     tombstones), so the map never degrades under a long eviction stream.
   - Counts/errors are `Float64Array` (exact to 2^53 -- a hot key's count can exceed
     2^32). All pools are allocated ONCE at construction; every op -- including the
     eviction path (map backshift + forest re-file) -- is 0 B/op. It uses the shared
     two-lane hash (unlike DDSketch); the map home is `hash(storedKey) & mask`, one
     function for placement, probe, and backshift.

2. **Dual constructor (user chose "Both").** Primary `new SpaceSaving(capacity)`
   (capacity = k, the direct dial) + static `SpaceSaving.withError(epsilon)`
   deriving `k = ceil(1/epsilon)` and reporting the achieved `epsilon` (= 1/k, so a
   monitored key's over-count is bounded by `epsilon * N`). Mirrors
   `CountMinSketch.withAccuracy`.

3. **merge shipped in 0.4.0 (user chose "include now"), so all four members merge.**
   Standard Cormode/Hadjieleftheriou union: for the union of keys, merged count =
   `countA + countB`, where a key ABSENT from a summary is credited that summary's
   MIN counter (its unmonitored-mass upper bound; 0 if that summary is not yet full)
   and its error accrues that min too; then keep the k highest merged counts and
   rebuild the map + forest. Same-capacity-and-seed-or-throw. It is COLD with a
   bounded scratch allocation (disclosed); kept entries are re-attached in DESCENDING
   count order so each attach is an O(1) new-min splice (O(k) rebuild). The bracket
   guarantee survives merge (looser but still one-sided) -- the witness re-checks the
   bracket on the merged result, not just the shards.

4. **`heavyHitters` returns a SUPERSET (`count > threshold * total`).** SpaceSaving's
   defining property is NO false negatives (every true heavy hitter is reported), so
   the filter is the upper-bound `count`, not `count - error`. The returned set may
   include a few false positives; each entry carries `error`, so a caller recovers
   the guaranteed-frequent subset with `(count - error) > threshold * total`. (An
   earlier `count - error` filter -- the guaranteed subset -- was REJECTED in review
   for contradicting the no-false-negatives headline.)

5. **NO `addHashed`.** Unlike HyperLogLog / CountMinSketch, SpaceSaving must RETAIN
   each key's identity (to return it in topK/forEach and to re-probe it on eviction),
   so a "pre-hashed fast path" is a fiction -- `addHashed(hi, lo)` would be `add(hi)`
   with an ignored `lo`. It was implemented, then REMOVED in review as a misleading
   surface: an honest API omits the method a key-storing structure cannot deliver.

6. **Fail closed, but NEVER at capacity.** The ctor throws `[lite-sketch]`
   typeof-first on a bad capacity / seed / unknown option (did-you-mean) BEFORE any
   allocation (no half-built instance); `add` typeof-guards a safe-integer key and a
   positive-integer count (a rejected add is a byte-identical no-op); `merge` fails
   closed on incompatibility; queries never throw. Reaching capacity is NOT a failure
   -- eviction is the algorithm (the contrast to lite-o1's fixed-capacity members).

## Bugs caught in review/qa (fixed before ship)

- `heavyHitters` filtered `count - error` (the guaranteed SUBSET), contradicting the
  no-false-negatives headline -- changed to the `count` upper bound (superset).
- `addHashed` shipped as a misleading no-op-`lo` method -- removed.

## The accuracy contract (the honesty anchor)

The witness drives a Zipfian stream against an exact `Map` oracle across a capacity
sweep and GATES: recall of the true hitters above N/k is 100% (zero false negatives);
the bracket `count - error <= true <= count` holds for every monitored key; and
`error <= N/k`. Space is the co-headline: k counters (fixed) vs the exact Map's
O(distinct). The over-estimate is one-sided (a monitored key is never undercounted);
uniformity is statistical (the hash), not cryptographic.

## H2.3 amendment (2026-10-04) -- counting honesty (F15, F16, F20; S5, S6)

Validation only; `add` gains guard lines, the rest of the hot path is byte-identical.

1. **Count cap + running-total ceiling (F15, S5).** `count` is now `[1, 2^32-1]` (matching CMS); an
   `add` / `merge` that would push the exact running `total` past `2^53-1` throws tagged (a new cold
   `_badTotal`) as a byte-identical no-op across insert / bump / evict and merge. The `_badCount`
   message becomes "count must be an integer in [1, 4294967295]". SpaceSaving still "never
   undercounts a monitored key" -- that guarantee is unchanged.
2. **`withError` throws when unattainable (F16, S6).** The silent clamp of `k` to `2^24` is deleted;
   a request needing `k > 2^24` now throws tagged rather than quietly returning a weaker summary.
3. **Throwers run no caller code (F20).** Every cold message formats its rejected arg through the
   shared `_describe(x)` (typeof-first), so a null-proto object or a throwing / re-entrant
   `toString` can no longer escape the `[lite-sketch]` tag or mutate the summary during a rejection.

## H2.5 amendment (2026-10-04) -- argument-free hot path (F3; S1 home site)

Zero behavior change (bit-identical to the pre-H2.5 build (de7ecaf, which already carries F12) over
636,951 parity checks); the hot body stops boxing the key / count inside the library. The ":39-41 one
function" claim above is refined: the map home `hash(storedKey) & mask` is now realised as **one home
in THREE bit-identical, site-tested copies** -- `_hash` (the reference, used by estimate / errorOf /
merge placement and the tests), `add`'s inline mix, and `_homeAt` -- because routing a key / count
through a `number`-typed helper boxed a `HeapNumber` for values `>= 2^31`.

1. **The bump is inlined into `add`** (no `_bump(slot, delta)`): `add` reads
   `prevB = _bPrev[_cBucket[sl]]` BEFORE `_count[sl] += count` and `_detach`, then `_attach`. No
   count crosses a call.
2. **`_attach(slot, hint)` reads `_count[slot]` itself** (was `_attach(slot, val, hint)`). Every
   caller -- insert, the inlined bump, evict, merge rebuild -- writes `_count[slot]` first, so the
   value is never passed (and never boxed) as an argument.
3. **Eviction + backshift are argument-free.** `_mapDeleteKey(key)` is gone; eviction does
   `_mapDelete(_probeAt(_key, sl, _homeAt(_key, sl)))` and the backshift home is `_homeAt(_mapKey, j)`.
   `_homeAt(arr, i)` hand-inlines the HI-lane murmur (same neg / `Math.abs` / low-word / high-word
   split and the same `_m3round` / `_m3final` constants as `_hash`) and reads the key from the buffer,
   so it never boxes crossing a call. `_homeAt` serves the evicted-key delete probe and the backshift;
   the evict RE-PROBE reuses `add`'s own `home`. This IS the F2 "SS home" hand-inline site. `_probe` is
   unchanged (its `h & mask` is idempotent): EVERY production caller -- `add` (hot) and estimate /
   errorOf / merge (cold) -- passes the home `_hash(key) & _mask`; only the tests pass a raw `_hash`.
   A qa identity test pins `_homeAt(_key, sl) === (_hash(_key[sl]) & _mask)` for every slot.

## H2.6 amendment (2026-10-04) -- the addFrom family; three home copies -> two (F5)

Bit-identical output over the N9 parity sweep (full pools, merge, post-merge adds, negative keys).

1. **THREE home copies become TWO.** The H2.5 amendment carried the map home in three copies --
   `_hash`, `add`'s own inline mix, and `_homeAt`. `add` is now a typeof wrapper that stages key +
   count in `_buf` and calls `_addAt(_buf, 0)`, and `_addAt` takes the home from `_homeAt`, so `add`'s
   inline mix DISAPPEARS. Two copies remain: `_hash` (the reference, used by `merge` placement and the
   tests) and `_homeAt(arr, i)` (every hot site -- `_addAt`'s insert / bump / evict, `estimate`,
   `errorOf`, the evicted-key delete probe, and the backshift). The qa identity test still pins
   `_homeAt(_key, sl) === (_hash(_key[sl]) & _mask)` for every slot.
2. **`addFrom(buf, i)` + D1.** `_addAt` reads `buf[i]` three times (the range guard, `_homeAt`,
   `_probeAt`), so a `Proxy` over a `Float64Array`, or a `SharedArrayBuffer` view a worker mutates,
   could change the value between reads and store a key under another key's home. `addFrom` therefore
   COPIES `buf[i]`, `buf[i+1]` into `_buf` and runs `_addAt(_buf, 0)` on that snapshot (HyperLogLog /
   CountMinSketch read each slot once, so they do not copy). `estimate` / `errorOf` also route through
   `_buf`.
3. **Eviction re-probes from `_key`.** After `_key[sl] = key`, the newcomer is re-probed via
   `_probeAt(this._key, sl, home)` -- reading OUR stored copy, never the caller's buffer, so a caller
   buffer is read only before any write.

## Non-goals

No sliding-window / decay variant (a future member); no serialization format in the
zero-GC core. This CLOSES the roster at four members; 1.0.0 is a docs/version
milestone declaring the count / frequency / quantile / top-k API stable (the
lite-filter reference+3 cadence).
