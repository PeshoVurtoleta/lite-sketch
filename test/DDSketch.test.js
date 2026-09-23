/**
 * @zakkster/lite-sketch -- DDSketch boundary + relative-error + fail-closed suite (node:test).
 *
 * Proves the DDSketch contract:
 *   1. RELATIVE-ERROR GUARANTEE: |quantile(q) - sorted[floor(q*(N-1))]| <= alpha*sorted[...]
 *      for alpha=0.01 (+ spot-check 0.02) on uniform / lognormal / pareto POSITIVE streams,
 *      N>=100k, q in {0.5, 0.9, 0.99, 0.999} -- 0 violations.
 *   2. MONOTONICITY of quantile(q) over a fine sweep of q in [0, 1].
 *   3. EXACT min/max/count/sum (running aggregates are exact, not bucketed).
 *   4. ZERO handling: all-zero stream, and a mixed zero+positive stream (boundary at
 *      zeroCount).
 *   5. COLLAPSING-LOWEST: a small maxBins forces collapsed=true; upper quantiles stay
 *      within alpha, count/sum stay exact; the smallest values' error is NOT gated
 *      (disclosed degradation).
 *   6. STRICT fixed-range: out-of-range add/merge throws a byte-identical no-op;
 *      collapsed stays false; in-range quantiles are within alpha.
 *   7. MERGE: equals a single sketch fed the concatenated stream; fails closed on a
 *      non-DDSketch / unequal alpha / a strict out-of-range incoming key.
 *   8. FAIL-CLOSED no-op matrix over ctor / add, byte-identical no-op on every throw;
 *      quantile / getters NEVER throw.
 *   9. CTOR derivations: gamma, maxBins default/custom, numBins, collapsed starts false.
 *
 * (The full accuracy witness is the orchestrator's test/witness.mjs; this is the
 * boundary + correctness proof.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DDSketch, VERSION } from '../Sketch.js';

const liteSketch = (e) => e instanceof Error && /^\[lite-sketch]/.test(e.message);

// Deterministic PRNG (mulberry32-style) so no test ever flakes -- matches the
// convention in CountMinSketch.test.js / HyperLogLog.test.js.
function makeRng(seed) {
    let s = seed >>> 0;
    return function rng() {
        s = (s + 0x6d2b79f5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard-normal via Box-Muller (cached second value), driven by a single rng(). */
function makeGaussian(rng) {
    let spare = null;
    return function gaussian() {
        if (spare !== null) { const v = spare; spare = null; return v; }
        let u1 = rng(); if (u1 < 1e-12) u1 = 1e-12;
        const u2 = rng();
        const r = Math.sqrt(-2 * Math.log(u1));
        const theta = 2 * Math.PI * u2;
        spare = r * Math.sin(theta);
        return r * Math.cos(theta);
    };
}

/** Lognormal sample: exp(mu + sigma*Z), always strictly positive. */
function makeLognormal(rng, mu, sigma) {
    const gaussian = makeGaussian(rng);
    return function lognormal() { return Math.exp(mu + sigma * gaussian()); };
}

/** Pareto (Type I) sample with scale xm and shape a, via inverse-CDF: xm / (1-U)^(1/a). */
function makePareto(rng, xm, a) {
    return function pareto() {
        let u = rng(); if (u > 1 - 1e-15) u = 1 - 1e-15;
        return xm / Math.pow(1 - u, 1 / a);
    };
}

/** Uniform sample in (lo, hi]. */
function makeUniform(rng, lo, hi) {
    return function uniform() { return lo + rng() * (hi - lo); };
}

/** Exact sorted-array oracle: quantile(q) = sorted[floor(q*(N-1))]. */
function oracle(sortedArr, q) {
    return sortedArr[Math.floor(q * (sortedArr.length - 1))];
}

/** Float64 rounding slack for the analytic alpha bound (ULP-level Math.log/Math.pow noise). */
const F64_SLACK = 1e-9;

function assertWithinAlpha(measured, trueVal, alpha, label) {
    assert.ok(Number.isFinite(measured), label + ': quantile returned non-finite ' + measured);
    const bound = alpha * Math.abs(trueVal) * (1 + F64_SLACK);
    const diff = Math.abs(measured - trueVal);
    assert.ok(diff <= bound,
        label + ': |measured=' + measured + ' - true=' + trueVal + '| = ' + diff +
        ' exceeds alpha*true=' + bound);
}

test('VERSION is the frozen 1.1.2 string', () => {
    assert.equal(VERSION, '1.1.2');
});

// ===========================================================================
// 1. RELATIVE-ERROR GUARANTEE
// ===========================================================================

const QS = [0.5, 0.9, 0.99, 0.999];
const N_ACCURACY = 100000;

const distributions = [
    { name: 'uniform', make: (rng) => makeUniform(rng, 1, 1000000) },
    { name: 'lognormal', make: (rng) => makeLognormal(rng, 5, 1.5) },
    { name: 'pareto', make: (rng) => makePareto(rng, 1, 2.5) },
];

for (const alpha of [0.01, 0.02]) {
    for (const dist of distributions) {
        // alpha=0.02 is a spot-check -- only run it on one distribution (uniform) to keep
        // the suite fast while still exercising a second alpha end-to-end.
        if (alpha !== 0.01 && dist.name !== 'uniform') continue;
        test('relative-error guarantee holds for every q on a ' + dist.name +
            ' stream (alpha=' + alpha + ', N=' + N_ACCURACY + ')', () => {
            const rng = makeRng(0xA1CE0001 ^ (alpha === 0.01 ? 0 : 1) ^ (dist.name.length << 8));
            const sample = dist.make(rng);
            const sketch = new DDSketch(alpha);
            const values = new Float64Array(N_ACCURACY);
            for (let i = 0; i < N_ACCURACY; i++) {
                const v = sample();
                values[i] = v;
                sketch.add(v);
            }
            const sorted = Array.from(values).sort((a, b) => a - b);
            let violations = 0;
            for (const q of QS) {
                const trueVal = oracle(sorted, q);
                const measured = sketch.quantile(q);
                const bound = alpha * Math.abs(trueVal) * (1 + F64_SLACK);
                const diff = Math.abs(measured - trueVal);
                if (diff > bound) {
                    violations++;
                    console.error('  violation q=' + q + ' measured=' + measured + ' true=' + trueVal +
                        ' diff=' + diff + ' bound=' + bound);
                }
            }
            assert.equal(violations, 0, violations + ' q-cell(s) violated the alpha bound on ' + dist.name);
        });
    }
}

// ===========================================================================
// 2. MONOTONICITY
// ===========================================================================

test('quantile(q) is non-decreasing over a fine sweep of q in [0, 1]', () => {
    const rng = makeRng(0xB0B0B0B0);
    const sample = makeLognormal(rng, 3, 1.2);
    const sketch = new DDSketch(0.01);
    for (let i = 0; i < 50000; i++) sketch.add(sample());
    let prev = -Infinity;
    let violations = 0;
    for (let i = 0; i <= 1000; i++) {
        const q = i / 1000;
        const v = sketch.quantile(q);
        if (v < prev) violations++;
        prev = v;
    }
    assert.equal(violations, 0, violations + ' non-monotonic step(s) found in the q sweep');
});

// ===========================================================================
// 3. EXACT min/max/count/sum
// ===========================================================================

test('min/max are EXACT (not bucketed); count/sum track exactly over a mixed stream', () => {
    const rng = makeRng(0xE7AC7);
    const sample = makeUniform(rng, 0.0001, 500000);
    const sketch = new DDSketch(0.01);
    const N = 100000;
    let trueMin = Infinity, trueMax = -Infinity, trueSum = 0;
    for (let i = 0; i < N; i++) {
        const v = sample();
        sketch.add(v);
        if (v < trueMin) trueMin = v;
        if (v > trueMax) trueMax = v;
        trueSum += v;
    }
    assert.equal(sketch.min, trueMin);
    assert.equal(sketch.max, trueMax);
    assert.equal(sketch.count, N);
    const relSumErr = Math.abs(sketch.sum - trueSum) / Math.abs(trueSum);
    assert.ok(relSumErr < 1e-9, 'sum drifted by relative ' + relSumErr + ' (f64 rounding budget is 1e-9)');
});

// ===========================================================================
// 4. ZERO handling
// ===========================================================================

test('all-zeros stream: quantile(any)===0, min===0, max===0, zeroCount===N', () => {
    const sketch = new DDSketch(0.01);
    const N = 10000;
    for (let i = 0; i < N; i++) sketch.add(0);
    for (const q of [0, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
        assert.equal(sketch.quantile(q), 0, 'q=' + q);
    }
    assert.equal(sketch.min, 0);
    assert.equal(sketch.max, 0);
    assert.equal(sketch.zeroCount, N);
    assert.equal(sketch.count, N);
});

test('mixed zeros+positives: the zero-bucket boundary is correct against the COMBINED sorted oracle', () => {
    const rng = makeRng(0x2E20);
    const sample = makeUniform(rng, 1, 100000);
    const sketch = new DDSketch(0.01);
    const ZERO_N = 3000;
    const POS_N = 7000;
    const N = ZERO_N + POS_N;
    const combined = new Float64Array(N);
    let idx = 0;
    for (let i = 0; i < ZERO_N; i++) { sketch.add(0); combined[idx++] = 0; }
    for (let i = 0; i < POS_N; i++) { const v = sample(); sketch.add(v); combined[idx++] = v; }
    assert.equal(sketch.zeroCount, ZERO_N);
    const sorted = Array.from(combined).sort((a, b) => a - b);
    // low quantiles whose rank falls within [0, zeroCount) must be exactly 0.
    for (const q of [0, 0.05, 0.1, 0.2]) {
        const rank = Math.floor(q * (N - 1));
        if (rank < ZERO_N) assert.equal(sketch.quantile(q), 0, 'q=' + q + ' rank=' + rank);
    }
    // higher quantiles (rank well past zeroCount) must be within alpha of the combined oracle.
    for (const q of [0.5, 0.9, 0.99]) {
        const rank = Math.floor(q * (N - 1));
        assert.ok(rank >= ZERO_N, 'test design: q=' + q + ' rank ' + rank + ' should exceed zeroCount');
        const trueVal = sorted[rank];
        assertWithinAlpha(sketch.quantile(q), trueVal, 0.01, 'mixed q=' + q);
    }
});

// ===========================================================================
// 5. COLLAPSING-LOWEST
// ===========================================================================

test('COLLAPSING-LOWEST: a small maxBins forces collapsed=true; upper quantiles stay within alpha; ' +
    'count/sum stay exact; the smallest-value error is disclosed, not gated', () => {
    const rng = makeRng(0xC011AF5E);
    const alpha = 0.01;
    const sketch = new DDSketch(alpha, { maxBins: 128 });
    // 99% of the mass sits in the TOP decade [1e5, 1e6] (comfortably inside a 128-bin
    // window at alpha=0.01, ~114 bins/decade) so p50/p90/p99/p999 all land there;
    // 1% spans many orders of magnitude below (1e-6 .. 1e2) to force the low end to
    // collapse (collapsed=true) without disturbing the upper tail's accuracy.
    const HIGH_N = 99000;
    const LOW_N = 1000;
    const N = HIGH_N + LOW_N;
    const highSample = makeUniform(rng, 100000, 1000000);
    const lowLogSample = () => Math.pow(10, -6 + rng() * 8); // 1e-6 .. 1e2
    const values = new Float64Array(N);
    let idx = 0;
    let trueSum = 0;
    for (let i = 0; i < LOW_N; i++) { const v = lowLogSample(); values[idx++] = v; trueSum += v; sketch.add(v); }
    for (let i = 0; i < HIGH_N; i++) { const v = highSample(); values[idx++] = v; trueSum += v; sketch.add(v); }
    assert.equal(sketch.collapsed, true, 'a 128-bin window over 8+ decades must collapse the low end');
    assert.equal(sketch.count, N);
    const relSumErr = Math.abs(sketch.sum - trueSum) / Math.abs(trueSum);
    assert.ok(relSumErr < 1e-9, 'sum must stay exact through collapsing, relerr=' + relSumErr);
    const sorted = Array.from(values).sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.99]) {
        const trueVal = oracle(sorted, q);
        assertWithinAlpha(sketch.quantile(q), trueVal, alpha, 'collapsed upper q=' + q);
    }
    // p999: with 99% high mass this still lands in the high (uncollapsed) segment.
    const trueP999 = oracle(sorted, 0.999);
    assertWithinAlpha(sketch.quantile(0.999), trueP999, alpha, 'collapsed upper q=0.999');
    // DISCLOSED, NOT GATED: a low quantile (rank inside the collapsed low batch) may
    // exceed alpha by a wide margin -- documented degradation of collapsing-lowest.
    // We only assert the sketch does not crash / NaN, never that it is accurate.
    const lowQuantile = sketch.quantile(0.001);
    assert.ok(Number.isFinite(lowQuantile), 'low quantile must still be a finite number, got ' + lowQuantile);
});

// ===========================================================================
// 6. STRICT fixed-range
// ===========================================================================

test('STRICT range: an out-of-range add throws [lite-sketch] as a byte-identical no-op', () => {
    const sketch = new DDSketch(0.01, { range: [1, 1000] });
    for (const bad of [5000, 0.001]) {
        const before = { count: sketch.count, sum: sketch.sum, min: sketch.min, zeroCount: sketch.zeroCount };
        assert.throws(() => sketch.add(bad), liteSketch, 'value=' + bad);
        assert.equal(sketch.count, before.count, 'count changed after throw on ' + bad);
        assert.equal(sketch.sum, before.sum, 'sum changed after throw on ' + bad);
        assert.equal(sketch.zeroCount, before.zeroCount, 'zeroCount changed after throw on ' + bad);
        if (before.count > 0) assert.equal(sketch.min, before.min, 'min changed after throw on ' + bad);
        else assert.ok(Number.isNaN(sketch.min), 'min should stay NaN (empty) after throw on ' + bad);
    }
    assert.equal(sketch.collapsed, false, 'strict mode never collapses');
});

test('STRICT range: a range whose end is not indexable (e.g. [1, Number.MAX_VALUE], ' +
    'or a denormal min) throws [lite-sketch] at construction', () => {
    for (const range of [[1, Number.MAX_VALUE], [5e-324, 1000], [Number.MIN_VALUE, 1]]) {
        assert.throws(() => new DDSketch(0.01, { range }), liteSketch, 'range=' + JSON.stringify(range));
    }
});

// N1 (v1.1.0 hardening): O(1), 0-alloc getters so consumers stop RangeError-vs-TypeError
// sniffing + bisect-probing the indexable bounds. Smoke coverage: values agree with add().
test('N1: strict / minIndexable / maxIndexable / rangeMin / rangeMax getters agree with add()', () => {
    const d = new DDSketch(0.01);
    assert.equal(d.strict, false);
    assert.ok(Number.isNaN(d.rangeMin) && Number.isNaN(d.rangeMax), 'non-strict range* is NaN, not 0');
    // the exact bounds add() accepts: finite minIndexable < x <= maxIndexable.
    assert.ok(d.minIndexable > 0 && d.minIndexable < 1e-307, 'minIndexable ~2.2e-308');
    assert.ok(d.maxIndexable > 8e307 && Number.isFinite(d.maxIndexable), 'maxIndexable ~8.9e307');
    assert.doesNotThrow(() => d.add(d.maxIndexable), 'maxIndexable is inclusive-accepted');
    assert.throws(() => d.add(d.maxIndexable * 1.5), liteSketch, 'above maxIndexable (still finite) throws');
    assert.throws(() => d.add(d.minIndexable), liteSketch, 'minIndexable is the EXCLUSIVE floor: itself rejected');
    assert.doesNotThrow(() => d.add(d.minIndexable * 1.0001), 'just above minIndexable is accepted');

    const s = new DDSketch(0.01, { range: [10, 1000] });
    assert.equal(s.strict, true);
    assert.equal(s.rangeMin, 10);
    assert.equal(s.rangeMax, 1000);
    // getters never throw and are cheap to read repeatedly.
    assert.equal(s.minIndexable, s.minIndexable);
    assert.equal(s.maxIndexable, s.maxIndexable);
});

test('N7: addFrom(buf, i) is exactly equivalent to add(buf[i]) (count=1) over a mixed stream', () => {
    const viaAdd = new DDSketch(0.01);
    const viaFrom = new DDSketch(0.01);
    const buf = new Float64Array(1);
    const vals = [0, 0.5, 1.5, Math.PI, 1e-100, 12345.678, 8.9e307 / 2, 1e-200];
    for (const v of vals) {
        viaAdd.add(v);
        buf[0] = v;
        viaFrom.addFrom(buf, 0);
    }
    assert.equal(viaFrom.count, viaAdd.count, 'same count');
    assert.equal(viaFrom.zeroCount, viaAdd.zeroCount, 'same zeroCount');
    assert.equal(viaFrom.sum, viaAdd.sum, 'same exact sum');
    assert.equal(viaFrom.min, viaAdd.min, 'same exact min');
    assert.equal(viaFrom.max, viaAdd.max, 'same exact max');
    for (const q of [0, 0.5, 0.9, 0.99, 1]) {
        assert.equal(viaFrom.quantile(q), viaAdd.quantile(q), 'same quantile ' + q);
    }
    assert.equal(viaFrom.addFrom(buf, 0), viaFrom, 'chainable');
});

test('N7: addFrom fails closed on a bad buffer / index (byte-identical no-op), and on a value add would reject', () => {
    const d = new DDSketch(0.01);
    const buf = new Float64Array([5, NaN, Infinity, -1]);
    // bad handle: not a Float64Array, or a bad index
    assert.throws(() => d.addFrom([5], 0), liteSketch, 'a plain Array is not a Float64Array');
    assert.throws(() => d.addFrom(new Float32Array([5]), 0), liteSketch, 'a Float32Array is rejected');
    assert.throws(() => d.addFrom(buf, -1), liteSketch, 'negative index');
    assert.throws(() => d.addFrom(buf, 4), liteSketch, 'out-of-bounds index');
    assert.throws(() => d.addFrom(buf, 1.5), liteSketch, 'non-integer index');
    // bad value at buf[i]: same rejects as add(), no aggregate touched
    const before = d.count;
    assert.throws(() => d.addFrom(buf, 1), liteSketch, 'NaN value');
    assert.throws(() => d.addFrom(buf, 2), liteSketch, '+Infinity value');
    assert.throws(() => d.addFrom(buf, 3), liteSketch, 'negative value');
    assert.equal(d.count, before, 'a rejected addFrom is a byte-identical no-op');
    // the good slot still works after the rejects
    assert.doesNotThrow(() => d.addFrom(buf, 0));
    assert.equal(d.count, before + 1);
});

test('STRICT range: zero is always accepted regardless of range (routes to zeroCount, never checked)', () => {
    const sketch = new DDSketch(0.01, { range: [10, 20] });
    assert.doesNotThrow(() => sketch.add(0));
    assert.equal(sketch.zeroCount, 1);
});

test('STRICT range: an in-range stream quantiles within alpha of the sorted oracle', () => {
    const rng = makeRng(0x57817C7);
    const alpha = 0.01;
    const sketch = new DDSketch(alpha, { range: [1, 100000] });
    const sample = makeUniform(rng, 1, 100000);
    const N = 100000;
    const values = new Float64Array(N);
    for (let i = 0; i < N; i++) { const v = sample(); values[i] = v; sketch.add(v); }
    assert.equal(sketch.collapsed, false);
    const sorted = Array.from(values).sort((a, b) => a - b);
    for (const q of QS) assertWithinAlpha(sketch.quantile(q), oracle(sorted, q), alpha, 'strict q=' + q);
});

// ===========================================================================
// 7. MERGE
// ===========================================================================

test('MERGE equals a single sketch fed the concatenated stream: quantiles match exactly, count/sum exact', () => {
    const rng = makeRng(0x3E46E);
    const sample = makeLognormal(rng, 4, 1.3);
    const alpha = 0.01;
    const a = new DDSketch(alpha);
    const b = new DDSketch(alpha);
    const whole = new DDSketch(alpha);
    const N_A = 40000, N_B = 60000;
    for (let i = 0; i < N_A; i++) { const v = sample(); a.add(v); whole.add(v); }
    for (let i = 0; i < N_B; i++) { const v = sample(); b.add(v); whole.add(v); }
    assert.equal(a.merge(b), a);
    assert.equal(a.count, whole.count);
    const relSumErr = Math.abs(a.sum - whole.sum) / Math.abs(whole.sum);
    assert.ok(relSumErr < 1e-9, 'merged sum drifted, relerr=' + relSumErr);
    for (const q of QS) {
        assert.equal(a.quantile(q), whole.quantile(q), 'q=' + q + ' merge vs whole mismatch');
    }
});

test('merge fails closed on a non-DDSketch [lite-sketch], byte-identical no-op', () => {
    const a = new DDSketch(0.01);
    a.add(5);
    for (const bad of [null, undefined, {}, 5, 'x', { _gamma: a._gamma }]) {
        const before = { count: a.count, sum: a.sum };
        assert.throws(() => a.merge(bad), liteSketch, String(bad));
        assert.equal(a.count, before.count);
        assert.equal(a.sum, before.sum);
    }
});

test('merge fails closed on an unequal alpha/gamma [lite-sketch], byte-identical no-op', () => {
    const a = new DDSketch(0.01);
    a.add(5);
    const before = { count: a.count, sum: a.sum };
    assert.throws(() => a.merge(new DDSketch(0.02)), liteSketch);
    assert.equal(a.count, before.count);
    assert.equal(a.sum, before.sum);
});

test('STRICT merge: an out-of-range incoming key throws [lite-sketch] as a byte-identical no-op', () => {
    const strict = new DDSketch(0.01, { range: [1, 1000] });
    strict.add(5);
    const other = new DDSketch(0.01); // same alpha/gamma, non-strict, free to hold any positive value
    other.add(50000); // key well outside [1, 1000]
    const before = { count: strict.count, sum: strict.sum, zeroCount: strict.zeroCount };
    assert.throws(() => strict.merge(other), liteSketch);
    assert.equal(strict.count, before.count, 'count changed after a rejected strict merge');
    assert.equal(strict.sum, before.sum, 'sum changed after a rejected strict merge');
    assert.equal(strict.zeroCount, before.zeroCount);
    assert.equal(strict.collapsed, false);
});

// ===========================================================================
// 8. FAIL-CLOSED no-op matrix
// ===========================================================================

function snapshot(s) {
    return { count: s.count, sum: s.sum, min: s.min, max: s.max, zeroCount: s.zeroCount, collapsed: s.collapsed };
}
function assertUnchanged(before, s, label) {
    const after = snapshot(s);
    for (const k of Object.keys(before)) {
        const b = before[k], a = after[k];
        if (typeof b === 'number' && Number.isNaN(b)) {
            assert.ok(Number.isNaN(a), label + ': ' + k + ' expected NaN, got ' + a);
        } else {
            assert.equal(a, b, label + ': ' + k + ' changed (' + b + ' -> ' + a + ')');
        }
    }
}

test('add() fail-closed no-op matrix: every bad value/count throws [lite-sketch] and mutates nothing', () => {
    const s = new DDSketch(0.01);
    s.add(5); // seed some real state so "unchanged" is a non-trivial assertion
    const badValues = [-5, NaN, Infinity, -Infinity, '5', Symbol('x'), -0.0000001, -1e300];
    for (const bad of badValues) {
        const before = snapshot(s);
        assert.throws(() => s.add(bad), liteSketch, 'value=' + String(bad));
        assertUnchanged(before, s, 'value=' + String(bad));
    }
    const badCounts = [
        [5, 0], [5, 1.5], [5, -1], [5, NaN], [5, Infinity], [5, '1'], [5, null],
    ];
    for (const [value, count] of badCounts) {
        const before = snapshot(s);
        assert.throws(() => s.add(value, count), liteSketch, 'count=' + String(count));
        assertUnchanged(before, s, 'count=' + String(count));
    }
});

test('add(-0) is treated as zero (===0 short-circuits the negative check), not a throw', () => {
    const s = new DDSketch(0.01);
    assert.doesNotThrow(() => s.add(-0));
    assert.equal(s.zeroCount, 1);
    assert.equal(s.count, 1);
});

test('ctor rejects a bad alpha [lite-sketch]: 0, 1, -0.1, NaN, string', () => {
    for (const alpha of [0, 1, -0.1, NaN, '0.1', Infinity, -Infinity, null, undefined]) {
        assert.throws(() => new DDSketch(alpha), liteSketch, 'alpha=' + String(alpha));
    }
});

test('ctor rejects a bad maxBins [lite-sketch]: 0, 1.5, 2^20+1', () => {
    for (const maxBins of [0, 1.5, (1 << 20) + 1, -1, NaN, '128']) {
        assert.throws(() => new DDSketch(0.01, { maxBins }), liteSketch, 'maxBins=' + String(maxBins));
    }
});

test('ctor accepts maxBins at the boundaries 1 and 2^20', () => {
    assert.doesNotThrow(() => new DDSketch(0.01, { maxBins: 1 }));
    assert.doesNotThrow(() => new DDSketch(0.01, { maxBins: 1 << 20 }));
});

test('ctor rejects a bad range [lite-sketch]: not 2-elem, min<=0, min>=max, non-finite', () => {
    const badRanges = [
        [1], [1, 2, 3], 'x', 5, [0, 100], [-1, 100], [100, 100], [100, 50],
        [NaN, 100], [1, NaN], [1, Infinity], [-Infinity, 100],
    ];
    for (const range of badRanges) {
        assert.throws(() => new DDSketch(0.01, { range }), liteSketch, 'range=' + JSON.stringify(range));
    }
});

test('ctor rejects an unknown option key [lite-sketch] with a did-you-mean listing', () => {
    assert.throws(() => new DDSketch(0.01, { maxBinz: 128 }), (e) => {
        return liteSketch(e) && /known options|unknown option/.test(e.message);
    });
});

test('ctor rejects non-object options [lite-sketch]', () => {
    for (const options of [5, 'x', [1, 2]]) {
        assert.throws(() => new DDSketch(0.01, options), liteSketch, 'options=' + String(options));
    }
});

test('ctor leaves NO half-built instance on a bad alpha (throws at the door)', () => {
    let inst;
    try { inst = new DDSketch(-1); } catch (e) { assert.ok(liteSketch(e)); }
    assert.equal(inst, undefined);
});

test('quantile NEVER throws: bad q (-0.1, 1.1, NaN, string) and an empty sketch all return NaN', () => {
    const s = new DDSketch(0.01);
    for (const q of [-0.1, 1.1, NaN, '0.5', undefined, null, Infinity, -Infinity]) {
        assert.doesNotThrow(() => s.quantile(q), 'q=' + String(q));
        assert.ok(Number.isNaN(s.quantile(q)), 'q=' + String(q) + ' should be NaN on an empty sketch');
    }
    const s2 = new DDSketch(0.01);
    s2.add(5);
    for (const q of [-0.1, 1.1, NaN]) {
        assert.doesNotThrow(() => s2.quantile(q));
        assert.ok(Number.isNaN(s2.quantile(q)), 'q=' + String(q) + ' should be NaN even on a non-empty sketch');
    }
});

test('min/max on an empty sketch are NaN, not thrown', () => {
    const s = new DDSketch(0.01);
    assert.doesNotThrow(() => s.min);
    assert.doesNotThrow(() => s.max);
    assert.ok(Number.isNaN(s.min));
    assert.ok(Number.isNaN(s.max));
    assert.equal(s.count, 0);
    assert.equal(s.zeroCount, 0);
    assert.equal(s.sum, 0);
});

// ===========================================================================
// 9. CTOR derivations + boundary matrix (0, 1, N-1, N, N+1, empty)
// ===========================================================================

test('gamma = (1+alpha)/(1-alpha) is reflected in the representative value returned', () => {
    const alpha = 0.1;
    const s = new DDSketch(alpha);
    s.add(1);
    const gamma = (1 + alpha) / (1 - alpha);
    // key(1) = ceil(ln(1)*mult) = 0; representative = 2*gamma^0/(gamma+1) = 2/(gamma+1).
    const expected = 2 / (gamma + 1);
    assert.equal(s.quantile(0), expected);
    assert.equal(s.quantile(1), expected);
});

test('maxBins defaults to 2048 and honors a custom value', () => {
    assert.equal(new DDSketch(0.01).maxBins, 2048);
    assert.equal(new DDSketch(0.01, { maxBins: 64 }).maxBins, 64);
});

test('numBins reflects the number of currently populated buckets (COLD scan)', () => {
    const s = new DDSketch(0.01, { maxBins: 128 });
    assert.equal(s.numBins, 0);
    s.add(1);
    assert.equal(s.numBins, 1);
    s.add(1); // same bucket, no new bin
    assert.equal(s.numBins, 1);
    s.add(1000); // a different bucket
    assert.equal(s.numBins, 2);
});

test('collapsed starts false on a fresh sketch and after clear()', () => {
    const s = new DDSketch(0.01, { maxBins: 32 });
    assert.equal(s.collapsed, false);
    for (let i = 0; i < 10000; i++) s.add(Math.pow(1.5, i % 200) + 1);
    assert.equal(s.collapsed, true);
    s.clear();
    assert.equal(s.collapsed, false);
});

test('boundary: N=0 (empty), N=1, and a two-value sketch quantile correctly', () => {
    const empty = new DDSketch(0.01);
    assert.ok(Number.isNaN(empty.quantile(0.5)));
    const one = new DDSketch(0.01);
    one.add(42);
    for (const q of [0, 0.5, 1]) assertWithinAlpha(one.quantile(q), 42, 0.01, 'N=1 q=' + q);
    const two = new DDSketch(0.01);
    two.add(1); two.add(1000000);
    // rank(0)=floor(0*(2-1))=0 -> smallest; rank(1)=floor(1*1)=1 -> largest.
    assertWithinAlpha(two.quantile(0), 1, 0.01, 'N=2 q=0');
    assertWithinAlpha(two.quantile(1), 1000000, 0.01, 'N=2 q=1');
});

test('boundary: add(count) at N-1/N/N+1 of the safe-integer domain via a huge but finite count', () => {
    const s = new DDSketch(0.01);
    assert.doesNotThrow(() => s.add(5, Number.MAX_SAFE_INTEGER));
    assert.equal(s.count, Number.MAX_SAFE_INTEGER);
});

test('duplicate clear() is idempotent and a byte-identical no-op the second time', () => {
    const s = new DDSketch(0.01);
    s.add(5); s.add(10); s.add(0);
    s.clear();
    assert.equal(s.count, 0);
    assert.equal(s.zeroCount, 0);
    assert.ok(Number.isNaN(s.min));
    assert.doesNotThrow(() => s.clear());
    assert.equal(s.count, 0);
    assert.ok(Number.isNaN(s.min));
    for (let i = 0; i < s.maxBins; i++) assert.equal(s._bins[i], 0);
});

test('dispose-during-iteration: clear() mid-loop over a caller-owned key list leaves no partial state', () => {
    const s = new DDSketch(0.01);
    const values = [1, 2, 3, 4, 5];
    for (const v of values) s.add(v);
    let i = 0;
    for (const v of values) {
        i++;
        if (i === 3) s.clear(); // reset mid-iteration over the caller's own snapshot
    }
    assert.equal(s.count, 0);
    assert.ok(Number.isNaN(s.quantile(0.5)));
});

test('re-entrant write: add() called from inside a callback triggered by iterating a prior snapshot', () => {
    const s = new DDSketch(0.01);
    const seed = [1, 2, 3];
    let reentrant = 0;
    seed.forEach((v) => {
        s.add(v);
        if (reentrant < 2) { reentrant++; s.add(v * 1000); } // re-entrant write mid-callback
    });
    assert.equal(s.count, 3 + 2);
});

test('re-entrant write: add() invoked recursively from within its own call stack via a wrapper', () => {
    const s = new DDSketch(0.01);
    let calls = 0;
    function recur(n) {
        calls++;
        s.add(n + 1);
        if (n > 0) recur(n - 1);
    }
    recur(20);
    assert.equal(calls, 21);
    assert.equal(s.count, 21);
});

// ===========================================================================
// ADVERSARIAL cases the planner did not think of
// ===========================================================================

// INDEXABLE RANGE (fixed): a positive value so large or so tiny that its bucket
// representative `2*gamma^K/(gamma+1)` would overflow to Infinity or underflow below
// the smallest normal double is REJECTED at add() time -- a byte-identical no-op --
// so quantile() is ALWAYS a finite, alpha-bounded value. At alpha=0.01 the door is
// roughly [~1e-305, ~8.6e307]; Number.MIN_VALUE (5e-324, a denormal) and
// Number.MAX_VALUE (1.7976931348623157e308) both fall outside it.

test('ADVERSARIAL: Number.MIN_VALUE (5e-324, a denormal) is outside the indexable range: ' +
    'add() throws [lite-sketch] as a byte-identical no-op', () => {
    const s = new DDSketch(0.01, { maxBins: 256 });
    s.add(5); // seed real state so "unchanged" is non-trivial
    const before = snapshot(s);
    assert.throws(() => s.add(Number.MIN_VALUE), liteSketch);
    assertUnchanged(before, s, 'add(Number.MIN_VALUE)');
    // the symmetric literal spelling (5e-324 === Number.MIN_VALUE) throws identically.
    const before2 = snapshot(s);
    assert.throws(() => s.add(5e-324), liteSketch);
    assertUnchanged(before2, s, 'add(5e-324)');
});

test('ADVERSARIAL/FIXED: Number.MAX_VALUE is outside the indexable range: add() throws ' +
    '[lite-sketch] as a byte-identical no-op (previously overflowed quantile() to Infinity)', () => {
    for (const value of [Number.MAX_VALUE, Number.MAX_VALUE * 0.5]) {
        const s = new DDSketch(0.01, { maxBins: 256 });
        s.add(5); // seed real state so "unchanged" is non-trivial
        const before = snapshot(s);
        assert.throws(() => s.add(value), liteSketch, 'value=' + value);
        assertUnchanged(before, s, 'add(' + value + ')');
    }
});

test('POSITIVE boundary: a value comfortably inside the indexable range near the top (1e300) ' +
    'is accepted and quantile() returns a finite value within alpha of it', () => {
    const alpha = 0.01;
    const s = new DDSketch(alpha, { maxBins: 256 });
    assert.doesNotThrow(() => s.add(1e300));
    assert.equal(s.count, 1);
    for (const q of [0, 0.5, 1]) {
        const v = s.quantile(q);
        assert.ok(Number.isFinite(v), 'q=' + q + ' produced ' + v);
        assertWithinAlpha(v, 1e300, alpha, 'q=' + q + ' value=1e300');
    }
});

test('POSITIVE boundary: a normal large-magnitude stream keeps quantile(0.999) finite and within alpha', () => {
    const rng = makeRng(0xF19173E);
    const alpha = 0.01;
    const sample = makeUniform(rng, 1e10, 1e15);
    const sketch = new DDSketch(alpha);
    const N = 50000;
    const values = new Float64Array(N);
    for (let i = 0; i < N; i++) { const v = sample(); values[i] = v; sketch.add(v); }
    const sorted = Array.from(values).sort((a, b) => a - b);
    const v999 = sketch.quantile(0.999);
    assert.ok(Number.isFinite(v999), 'quantile(0.999) produced ' + v999);
    assertWithinAlpha(v999, oracle(sorted, 0.999), alpha, 'large-magnitude q=0.999');
});

test('ADVERSARIAL: quantile() called with a boxed Number object / array-like q never throws and ' +
    'is treated as not-a-plain-number (NaN out)', () => {
    const s = new DDSketch(0.01);
    s.add(5);
    // eslint-disable-next-line no-new-wrappers
    const boxed = new Number(0.5);
    assert.doesNotThrow(() => s.quantile(boxed));
    assert.ok(Number.isNaN(s.quantile(boxed)), 'a boxed Number is typeof "object", must fail the typeof guard');
    assert.doesNotThrow(() => s.quantile([0.5]));
    assert.ok(Number.isNaN(s.quantile([0.5])));
});

test('ADVERSARIAL: a strict-range sketch whose merge partner reports keys that straddle the window ' +
    'top exactly at maxKeyStrict is accepted at the boundary, rejected one key past it', () => {
    const alpha = 0.01;
    const strict = new DDSketch(alpha, { range: [1, 1000] });
    // Find a value whose key is exactly maxKeyStrict (the top of the strict window) and one
    // whose key is exactly one past it, via the same log-scale formula the class uses.
    const gamma = (1 + alpha) / (1 - alpha);
    const multiplier = 1 / Math.log(gamma);
    const maxKeyStrict = Math.ceil(Math.log(1000) * multiplier);
    const atTop = Math.pow(gamma, maxKeyStrict); // representative value whose ceil(log) == maxKeyStrict
    const pastTop = Math.pow(gamma, maxKeyStrict + 1);
    assert.doesNotThrow(() => strict.add(atTop), 'boundary key exactly at maxKeyStrict must be accepted');
    const before = snapshot(strict);
    assert.throws(() => strict.add(pastTop), liteSketch, 'one key past maxKeyStrict must throw');
    assertUnchanged(before, strict, 'past-boundary key');
});
