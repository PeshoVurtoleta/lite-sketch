# 0002 -- HyperLogLog: the reference member (dense registers, two-lane rho, linear-counting + raw estimator)

Status: accepted (v0.1.0)

## Context

HyperLogLog (Flajolet et al. 2007) estimates the number of DISTINCT elements in
an unbounded stream in fixed space, with a standard error of `1.04/sqrt(m)` for
`m = 2^p` registers. It is lite-sketch's reference member: it stands up the
package, the shipped hash (ADR 0001), and the accuracy-witness / torture / perf /
benchmark chassis, and it defines what "shipped" means for the family.

## The settled calls (user-accepted 2026-09-23)

1. **Dense registers only.** `Uint8Array(m)`, `m = 2^p`, `p in [4, 18]`. A sparse
   representation (better at low cardinality) ALLOCATES and is deferred -- the
   zero-GC dense array is the reference.

2. **Hot `add` is 0 B/op** over the two-lane hash (ADR 0001): register index `j` =
   top `p` bits of the hi lane; `rho` = leading-zero count of the `(64 - p)`-bit
   suffix (hi's low `32 - p` bits, then lo) + 1; `reg[j] = max(reg[j], rho)`. One
   mix, one load/compare/store. A pre-hashed `addHashed(hi, lo)` skips the mix.

3. **`count()` is a cold O(m) co-headline, NOT per-add. It uses Ertl's IMPROVED
   estimator (Ertl 2017), a single TABLE-FREE formula accurate across the whole
   cardinality range** -- so there is NO range-switching and NO empirical bias tables.
   It builds the register multiplicity vector `C[0..q+1]` (`q = 64 - p`, reused
   `_hist`), folds it through the self-terminating `sigma` (empty-register / small-range)
   and `tau` (saturated-register / large-range) correction series, and returns
   `alpha_inf * m^2 / z` with `alpha_inf = 1/(2 ln 2)`. No classic `2^32` large-range
   correction -- the two-lane (>= 64-bit-quality) hash makes it unnecessary.
   - RATIONALE: the user chose "full HLL++ accuracy" for the reference member. The two
     honest ways to reach it are Google's HLL++ empirical bias TABLES (~6000 published
     constants) or **Ertl's table-free improved estimator**; Ertl was chosen. It
     delivers HLL++-grade accuracy across the mid-range (~[2.5m, 5m]) that biases a
     raw-estimate-plus-linear-counting scheme, WITHOUT shipping (or risking
     hand-reproducing -- i.e. FABRICATING) a large empirical table that would corrupt
     the very accuracy anchor this project sells. It is the modern standard (a variant
     is used by Apache DataSketches). The accuracy witness gates the FULL range,
     including the mid-range band, at `<= 1.5 * 1.04/sqrt(m)`.

4. **`merge` is register-wise max, equal-m-or-throw** (the BitSet
   same-capacity-or-throw discipline); a non-HLL or mismatched-`m` merge throws
   `[lite-sketch]`. `clear()` zeroes the registers. Getters: `p`, `m`,
   `standardError` (= `1.04/sqrt(m)`).

5. **Fail closed.** A bad `p` (non-int / < 4 / > 18 / NaN) throws `[lite-sketch]`
   typeof-first BEFORE the `Uint8Array` is allocated; `add` / `addHashed` typeof-
   guard their args (a Symbol / BigInt / NaN / non-number throws, byte-identical
   no-op); `count` / getters never throw.

## The accuracy contract (the honesty anchor)

The witness drives the sketch on a stream with an exact `Set` oracle, measures the
relative error, and GATES it against theory: RMS relative error `<= ~1.5 *
1.04/sqrt(m)` over an N-sweep, p99 within ~3 sigma, error roughly halving as
`p += 2`. Space is the co-headline: the exact `Set` foil's memory grows
O(distinct) while HLL stays a fixed `m` bytes. MEASURED vs THEORETICAL are printed
side by side (the lite-filter table shape).

## Non-goals

No sparse representation (deferred); no crypto hashing; no serialization format in
the zero-GC core. Count-Min / DDSketch / SpaceSaving are M2-M4.
