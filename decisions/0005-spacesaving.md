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

## Non-goals

No sliding-window / decay variant (a future member); no serialization format in the
zero-GC core. This CLOSES the roster at four members; 1.0.0 is a docs/version
milestone declaring the count / frequency / quantile / top-k API stable (the
lite-filter reference+3 cadence).
