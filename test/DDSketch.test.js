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
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { DDSketch, DD_ALPHA_MIN, VERSION } from '../Sketch.js';

// Cold test helpers (NOT hot-path code): the adjacent double above/below x, via a
// Float64Array / BigUint64Array bit view. Used to probe the exact acceptance edges.
function nextUp(x) {
    const f = new Float64Array([x]);
    const u = new BigUint64Array(f.buffer);
    u[0] += 1n;
    return f[0];
}
function nextDown(x) {
    const f = new Float64Array([x]);
    const u = new BigUint64Array(f.buffer);
    u[0] -= 1n;
    return f[0];
}

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
// Byte-identical snapshot incl. a bins copy (for the F15 total-guard no-op proof).
function ddSnap(s) {
    return { bins: Array.from(s._bins), count: s.count, sum: s.sum, min: s.min, max: s.max,
             zeroCount: s.zeroCount, collapsed: s.collapsed };
}
function ddUnchanged(before, s, label) {
    const a = ddSnap(s);
    assert.deepEqual(a.bins, before.bins, label + ': _bins changed');
    for (const k of ['count', 'sum', 'zeroCount', 'collapsed']) {
        assert.equal(a[k], before[k], label + ': ' + k + ' changed');
    }
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
        [5, 2 ** 32], [5, 1e308], [5, Number.MAX_SAFE_INTEGER],   // F15: count > 2^32-1 throws
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

test('boundary: add count caps at 2^32-1; a larger finite count throws byte-identically (F15/S5)', () => {
    const s = new DDSketch(0.01);
    assert.doesNotThrow(() => s.add(5, 4294967295));      // 2^32-1 accepted
    assert.equal(s.count, 4294967295);
    for (const bad of [2 ** 32, Number.MAX_SAFE_INTEGER]) {
        const before = ddSnap(s);
        assert.throws(() => s.add(5, bad), (e) => liteSketch(e) && /\[1, 4294967295]/.test(e.message), 'count=' + bad);
        ddUnchanged(before, s, 'count=' + bad);
    }
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

// ===========================================================================
// H2.2 -- F10 / F11 / F17 fail-closed fixes (S2, S3)
// ===========================================================================

// G1 (F10): the ctor must FAIL CLOSED on a small alpha instead of hanging. Each tiny
// alpha is built in a child with a 2000 ms timeout; a timeout is a FAIL (on HEAD the
// 1e-12 / 1e-10 children never return and the spawn is killed). The child exits 0 iff
// `new DDSketch(alpha)` threw a tagged [lite-sketch] RangeError.
test('G1 (F10): new DDSketch(alpha) throws tagged for alpha < DD_ALPHA_MIN within a 2000 ms child (no hang)', () => {
    const url = new URL('../Sketch.js', import.meta.url).href;
    const code =
        'const u=process.argv[1],a=Number(process.argv[2]);' +
        'import(u).then(m=>{try{new m.DDSketch(a);process.exit(2);}' +
        'catch(e){process.exit(e instanceof RangeError && /^\\[lite-sketch]/.test(e.message)?0:3);}})' +
        '.catch(()=>process.exit(4));';
    const alphas = [1e-17, 1e-12, 1e-10, 2e-9, 1e-7, nextDown(DD_ALPHA_MIN)];
    for (const a of alphas) {
        const res = spawnSync(process.execPath, ['--input-type=module', '-e', code, url, String(a)],
            { timeout: 2000, encoding: 'utf8' });
        assert.equal(res.signal, null, 'alpha=' + a + ' TIMED OUT (ctor hang) -- FAIL');
        assert.equal(res.status, 0,
            'alpha=' + a + ' did not throw a tagged RangeError (child exit ' + res.status + ')');
    }
    // In process: the constant, a fast build at the floor, and the old near-zero throws.
    assert.equal(DD_ALPHA_MIN, 1e-6, 'DD_ALPHA_MIN is exactly 1e-6');
    let best = Infinity;
    for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        new DDSketch(DD_ALPHA_MIN);
        const dt = performance.now() - t0;
        if (dt < best) best = dt;
    }
    assert.ok(best < 5, 'new DDSketch(DD_ALPHA_MIN) builds in < 5 ms (min of 5 runs: ' + best.toFixed(4) + ' ms)');
    for (const bad of [0, 1, NaN]) {
        assert.throws(() => new DDSketch(bad), liteSketch, 'alpha=' + String(bad) + ' still throws');
    }
});

// G2 (F11, S3): merge must CARRY `collapsed` and a strict `this` must REJECT a collapsed
// `other`. On HEAD the merged sketch claims collapsed=false while holding folded low-end
// mass, and a strict sketch silently absorbs a collapsed other.
test('G2 (F11): merge carries collapsed; a strict sketch rejects a collapsed other (byte-identical no-op)', () => {
    const alpha = 0.01;
    // The audit's shard example: a 16-bin shard over [1, 1000] collapses; merged into an
    // empty sketch it must report collapsed=true, with quantile(0) unchanged at 742.6.
    const shard = new DDSketch(alpha, { maxBins: 16 });
    for (let i = 1; i <= 1000; i++) shard.add(i);
    shard.add(1); shard.add(1); shard.add(1);
    assert.equal(shard.collapsed, true, 'the shard itself collapses');
    const merged = new DDSketch(alpha, { maxBins: 16 });
    merged.merge(shard);
    assert.equal(merged.collapsed, true, 'merge carries other._collapsed forward');
    assert.equal(Number(merged.quantile(0).toFixed(1)), 742.6, 'quantile(0) bins are unchanged (742.6)');

    // A collapsed other folded into a NON-EMPTY non-strict sketch -> collapsed; clear() resets.
    const target = new DDSketch(alpha, { maxBins: 16 });
    target.add(500); target.add(600);
    assert.equal(target.collapsed, false, 'two in-window values do not collapse');
    target.merge(shard);
    assert.equal(target.collapsed, true, 'absorbing collapsed mass makes the target collapsed');
    target.clear();
    assert.equal(target.collapsed, false, 'clear() resets collapsed');

    // A STRICT this rejects a collapsed other, tagged, as a byte-identical no-op.
    const strict = new DDSketch(alpha, { range: [1, 1000] });
    strict.add(5); strict.add(50); strict.add(500);
    const before = snapshot(strict);
    const binsBefore = Float64Array.from(strict._bins);
    assert.throws(() => strict.merge(shard), liteSketch, 'strict must reject a collapsed other');
    assertUnchanged(before, strict, 'strict merge of a collapsed other');
    assert.deepEqual(Float64Array.from(strict._bins), binsBefore, 'bins unchanged after a rejected strict merge');

    // A strict merge of a NON-collapsed in-range other still works.
    const inRange = new DDSketch(alpha); // non-strict, non-collapsed, same gamma
    inRange.add(10); inRange.add(100);
    const countBefore = strict.count;
    assert.doesNotThrow(() => strict.merge(inRange));
    assert.equal(strict.count, countBefore + 2, 'an in-range non-collapsed other merges normally');
});

// G3 (F17): the minIndexable / maxIndexable getters are the EXACT acceptance edges of
// add's own key expression. Over the prototype's 3000-alpha grid: add(min) is rejected,
// add(nextUp(min)) accepted, add(max) accepted, and add(nextUp(max)) rejected (max is always
// strictly below MAX_VALUE, whose representative would overflow). On HEAD thousands fail these.
test('G3 (F17): minIndexable / maxIndexable are the exact add() edges across a 3000-alpha sweep', () => {
    const N = 3000;
    let failMin = 0, failNextMin = 0, failMax = 0, failNextMax = 0;
    const accepts = (d, x) => { try { d.add(x); return true; } catch { return false; } };
    for (let t = 0; t < N; t++) {
        const alpha = t < 1500 ? 1e-6 * Math.pow(1e5, t / 1500) : 0.1 + (t - 1500) * (0.8999 / 1500);
        const d = new DDSketch(alpha);
        const min = d.minIndexable, max = d.maxIndexable;
        if (accepts(d, min)) failMin++;                 // EXCLUSIVE floor: itself rejected
        if (!accepts(d, nextUp(min))) failNextMin++;    // the next double up is accepted
        if (!accepts(d, max)) failMax++;                // INCLUSIVE ceiling: accepted
        if (accepts(d, nextUp(max))) failNextMax++;     // one past rejected (max is always < MAX_VALUE)
    }
    assert.equal(failMin, 0, 'add(minIndexable) must be rejected at every alpha');
    assert.equal(failNextMin, 0, 'add(nextUp(minIndexable)) must be accepted at every alpha');
    assert.equal(failMax, 0, 'add(maxIndexable) must be accepted at every alpha');
    assert.equal(failNextMax, 0, 'add(nextUp(maxIndexable)) must be rejected at every alpha');

    // A strict sketch resolves the SAME indexable getters (they do not depend on the range).
    // A narrow [1000, 2000] range stays under the 2^20-bin cap even at alpha=1e-6.
    for (const alpha of [1e-6, 0.01, 0.5]) {
        const ns = new DDSketch(alpha);
        const st = new DDSketch(alpha, { range: [1000, 2000] });
        assert.equal(st.minIndexable, ns.minIndexable, 'strict minIndexable equals non-strict at alpha=' + alpha);
        assert.equal(st.maxIndexable, ns.maxIndexable, 'strict maxIndexable equals non-strict at alpha=' + alpha);
    }
});

// ===========================================================================
// H2.2 qa -- boundary cases the spec implies (alpha floor/ceiling, add vs addFrom
// edge agreement, the collapsed-merge matrix). Pure and fast: no sweeps.
// ===========================================================================

// Full internal snapshot for a byte-identical check: public aggregates PLUS the bin
// array copy and the window geometry (_offset, _maxKeyPop, _binCount).
function deepSnapshot(s) {
    return {
        pub: snapshot(s),
        bins: Float64Array.from(s._bins),
        offset: s._offset,
        maxKeyPop: s._maxKeyPop,
        binCount: s._binCount,
    };
}
function assertDeepUnchanged(before, s, label) {
    assertUnchanged(before.pub, s, label);
    assert.deepEqual(Float64Array.from(s._bins), before.bins, label + ': _bins changed');
    assert.equal(s._offset, before.offset, label + ': _offset changed');
    assert.equal(s._maxKeyPop, before.maxKeyPop, label + ': _maxKeyPop changed');
    assert.equal(s._binCount, before.binCount, label + ': _binCount changed');
}
function collapsedShard(alpha) {
    const shard = new DDSketch(alpha, { maxBins: 16 });
    for (let i = 1; i <= 1000; i++) shard.add(i);
    assert.equal(shard.collapsed, true, 'fixture: the 16-bin shard collapses');
    return shard;
}
function fourEdges(d) {
    const accAdd = (x) => { try { d.add(x); return true; } catch { return false; } };
    const buf = new Float64Array(1);
    const accFrom = (x) => { buf[0] = x; try { d.addFrom(buf, 0); return true; } catch { return false; } };
    const min = d.minIndexable, max = d.maxIndexable;
    const xs = [min, nextUp(min), max, nextUp(max)];
    return { add: xs.map(accAdd), from: xs.map(accFrom) };
}
const EDGE_EXPECT = [false, true, true, false];  // min rejected, nextUp(min) accepted, max accepted, nextUp(max) rejected

test('H2.2 alpha floor: DD_ALPHA_MIN (N) builds, nextUp (N+1) builds, nextDown (N-1) throws naming [1e-6, 1)', () => {
    const d = new DDSketch(DD_ALPHA_MIN);
    assert.equal(d.collapsed, false);
    assert.equal(d.count, 0);
    assert.doesNotThrow(() => new DDSketch(nextUp(DD_ALPHA_MIN)), 'nextUp(DD_ALPHA_MIN) is inside the domain');
    const below = nextDown(DD_ALPHA_MIN);
    assert.ok(below < DD_ALPHA_MIN, 'fixture: nextDown is strictly below the floor');
    assert.throws(() => new DDSketch(below), (e) => liteSketch(e) && e instanceof RangeError && e.message.includes('[1e-6, 1)'),
        'nextDown(DD_ALPHA_MIN) throws a tagged RangeError whose message names the domain [1e-6, 1)');
    // The floor's four edges hold through BOTH entry points.
    const r = fourEdges(new DDSketch(DD_ALPHA_MIN));
    assert.deepEqual(r.add, EDGE_EXPECT, 'add edges at DD_ALPHA_MIN');
    assert.deepEqual(r.from, EDGE_EXPECT, 'addFrom edges at DD_ALPHA_MIN');
});

test('H2.2 alpha door matrix: -0, null, undefined, NaN, -DD_ALPHA_MIN, a string, a boxed Number all throw tagged', () => {
    const bad = [-0, null, undefined, NaN, -DD_ALPHA_MIN, String(DD_ALPHA_MIN), new Number(0.01), 1, nextUp(1), Infinity];
    for (const a of bad) {
        assert.throws(() => new DDSketch(a), (e) => liteSketch(e) && e instanceof RangeError,
            'alpha=' + String(a) + ' (' + typeof a + ') must throw a tagged RangeError');
    }
});

test('H2.2 alpha ceiling: alpha = 1 - 2^-30 and 1 - 2^-53 (the largest double below 1) build and hold all four edges', () => {
    for (const alpha of [1 - 2 ** -30, 1 - 2 ** -53]) {
        assert.ok(alpha < 1, 'fixture: alpha < 1');
        const d = new DDSketch(alpha);
        assert.ok(Number.isFinite(d.minIndexable) && d.minIndexable > 0, 'minIndexable finite positive at alpha=' + alpha);
        assert.ok(Number.isFinite(d.maxIndexable) && d.maxIndexable < Number.MAX_VALUE,
            'maxIndexable finite and below MAX_VALUE at alpha=' + alpha);
        assert.ok(d._minKeyIndexable < 0 && d._maxKeyIndexable > 0, 'key bounds straddle 0 at alpha=' + alpha);
        const r = fourEdges(d);
        assert.deepEqual(r.add, EDGE_EXPECT, 'add edges at alpha=' + alpha);
        assert.deepEqual(r.from, EDGE_EXPECT, 'addFrom edges at alpha=' + alpha);
        // The accepted values produce finite quantiles (the representative at both key bounds is finite).
        assert.ok(Number.isFinite(d.quantile(0)) && Number.isFinite(d.quantile(1)), 'quantiles finite at alpha=' + alpha);
    }
});

test('H2.2 addFrom agrees with add at all four indexable edges (same accept / reject) for several alphas', () => {
    for (const alpha of [nextUp(DD_ALPHA_MIN), 1e-4, 0.01, 0.05, 0.3, 0.9]) {
        const r = fourEdges(new DDSketch(alpha));
        assert.deepEqual(r.from, r.add, 'addFrom and add disagree at an edge, alpha=' + alpha);
        assert.deepEqual(r.add, EDGE_EXPECT, 'edges at alpha=' + alpha);
    }
});

test('H2.2 strict merge of a collapsed other leaves this byte-identical (bins, offset, maxKeyPop, binCount), twice', () => {
    const shard = collapsedShard(0.01);
    const shardBefore = deepSnapshot(shard);
    // Populated strict this.
    const strict = new DDSketch(0.01, { range: [1, 1000] });
    strict.add(5); strict.add(50); strict.add(500); strict.add(0);
    const before = deepSnapshot(strict);
    assert.throws(() => strict.merge(shard), liteSketch, 'strict rejects a collapsed other');
    assertDeepUnchanged(before, strict, 'first rejected strict merge');
    // Duplicate rejection: still a byte-identical no-op, and other is never touched.
    assert.throws(() => strict.merge(shard), liteSketch, 'strict rejects it again');
    assertDeepUnchanged(before, strict, 'second rejected strict merge');
    assertDeepUnchanged(shardBefore, shard, 'the rejected other');
    // EMPTY strict this (N=0) also rejects -- the check does not depend on this's contents.
    const empty = new DDSketch(0.01, { range: [1, 1000] });
    const eBefore = deepSnapshot(empty);
    assert.throws(() => empty.merge(shard), liteSketch, 'empty strict rejects a collapsed other');
    assertDeepUnchanged(eBefore, empty, 'empty strict');
    // After the shard is clear()ed (collapsed resets), the same strict sketch accepts it.
    shard.clear();
    shard.add(7);
    assert.doesNotThrow(() => strict.merge(shard), 'a cleared, refilled other is no longer collapsed');
    assert.equal(strict.count, before.pub.count + 1);
    assert.equal(strict.collapsed, false, 'strict never reports collapsed');
});

test('H2.2 self-merge (re-entrant: other === this) of a collapsed sketch stays collapsed with the mass doubled', () => {
    const shard = collapsedShard(0.01);
    const n = shard.count, sum = shard.sum;
    shard.merge(shard);
    assert.equal(shard.collapsed, true, 'self-merge keeps collapsed');
    assert.equal(shard.count, 2 * n, 'count doubles');
    assert.equal(shard.sum, 2 * sum, 'sum doubles');
    assert.equal(shard.min, 1);
    assert.equal(shard.max, 1000);
    // A strict sketch is never collapsed, so its self-merge is accepted (not the collapsed reject).
    const strict = new DDSketch(0.01, { range: [1, 1000] });
    strict.add(3); strict.add(30);
    assert.doesNotThrow(() => strict.merge(strict));
    assert.equal(strict.count, 4);
    assert.equal(strict.collapsed, false);
});

test('H2.2 an EMPTY non-strict sketch merged with a collapsed other becomes collapsed with equal quantiles', () => {
    const shard = collapsedShard(0.01);
    const qs = [0, 0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1];
    for (const opts of [undefined, { maxBins: 16 }]) {
        const e = new DDSketch(0.01, opts);
        assert.equal(e.collapsed, false);
        e.merge(shard);
        const label = opts ? 'maxBins 16' : 'default maxBins';
        assert.equal(e.collapsed, true, label + ': empty target becomes collapsed');
        assert.equal(e.count, shard.count, label + ': count');
        assert.equal(e.sum, shard.sum, label + ': sum');
        assert.equal(e.min, shard.min, label + ': min');
        assert.equal(e.max, shard.max, label + ': max');
        for (const q of qs) assert.equal(e.quantile(q), shard.quantile(q), label + ': quantile(' + q + ')');
    }
    // Merging an EMPTY non-collapsed other does not set collapsed (the carry is conditional).
    const t = new DDSketch(0.01);
    t.add(10);
    t.merge(new DDSketch(0.01));
    assert.equal(t.collapsed, false, 'an empty non-collapsed other does not set collapsed');
});

test('H2.2 ADVERSARIAL: a rejected merge never carries collapsed (gamma mismatch), and the strict-collapsed ' +
    'reject runs BEFORE the pre-scan (a real collapsed other with matching gamma still gets the tagged reject)', () => {
    // A collapsed other with a DIFFERENT alpha must throw without flipping this.collapsed:
    // the carry sits past every throw.
    const otherAlpha = collapsedShard(0.02);
    const t = new DDSketch(0.01);
    t.add(10); t.add(20);
    const before = deepSnapshot(t);
    assert.throws(() => t.merge(otherAlpha), liteSketch, 'gamma mismatch throws');
    assertDeepUnchanged(before, t, 'gamma-mismatch reject');
    assert.equal(t.collapsed, false, 'a rejected merge must not carry collapsed');
    // A REAL collapsed sketch with the SAME gamma (H2.7: the merge brand now rejects a
    // prototype forgery before the gamma/collapsed checks, so the reject must be exercised with a
    // genuine instance). It passes the brand, matches gamma, and is really collapsed: the
    // strict-collapsed check must fire BEFORE the strict pre-scan, with the tagged RangeError.
    // range [1, 100] (NOT [1, 1000]): the collapsed shard carries values 1..1000, so if the strict
    // pre-scan ran BEFORE the strict-collapsed check it would hit a value > 100 and throw the RANGE
    // error, not /collapsed/ -- the swap mutant then FAILs this assertion.
    const realCollapsed = collapsedShard(0.01);
    const strict = new DDSketch(0.01, { range: [1, 100] });
    strict.add(5);
    const sBefore = deepSnapshot(strict);
    assert.throws(() => strict.merge(realCollapsed), (e) => liteSketch(e) && e instanceof RangeError && /collapsed/.test(e.message),
        'the strict-collapsed reject precedes the pre-scan');
    assertDeepUnchanged(sBefore, strict, 'collapsed-into-strict reject is a byte-identical no-op');
    // null / undefined others are the existing non-instance reject (still tagged).
    for (const o of [null, undefined]) assert.throws(() => strict.merge(o), liteSketch, 'merge(' + o + ') throws tagged');
    assertDeepUnchanged(sBefore, strict, 'null / undefined merge');
});

// ===========================================================================
// H2.3 gates (F15 count cap + total ceiling, F20 no-user-code throwers)
// ===========================================================================

const DD_MAX_SAFE = 9007199254740991;   // 2^53 - 1

test('G-F15 (DD): count cap 2^32-1 + running-count ceiling 2^53-1, byte-identical reject', () => {
    // count cap: 2^32-1 accepted; 2^32, 1e308, MAX_SAFE throw with the [1, 4294967295] message.
    const s = new DDSketch(0.01);
    assert.doesNotThrow(() => s.add(5, 4294967295));
    for (const bad of [2 ** 32, 1e308, DD_MAX_SAFE]) {
        const before = ddSnap(s);
        assert.throws(() => s.add(7, bad), (e) => liteSketch(e) && /\[1, 4294967295]/.test(e.message), 'count=' + bad);
        ddUnchanged(before, s, 'count=' + bad);
    }
    // Fill count to exactly 2^53-1, then reject +1 at every entry point byte-identically.
    const f = new DDSketch(0.01);
    for (let i = 0; i < (1 << 21); i++) f.add(5, 4294967295);
    f.add(5, (1 << 21) - 1);
    assert.equal(f.count, DD_MAX_SAFE, 'count reaches exactly 2^53-1');
    const scratch = new Float64Array([3.5]);
    for (const fn of [() => f.add(5), () => f.add(0), () => f.addFrom(scratch, 0)]) {
        const before = ddSnap(f);
        assert.throws(fn, (e) => liteSketch(e) && /9007199254740991/.test(e.message));
        ddUnchanged(before, f, 'count+1 reject');
    }
    // A doubly-invalid add (negative value + over-cap count): the count check fires FIRST,
    // so the message names the count (precedence pinned).
    const d = new DDSketch(0.01);
    assert.throws(() => d.add(-5, 2 ** 40), (e) => liteSketch(e) && /\[1, 4294967295]/.test(e.message));
});

test('G-F15 (DD): merge at total 2^53-6 rejects an other of 6, accepts an other of 5', () => {
    const base = new DDSketch(0.01);
    for (let i = 0; i < (1 << 21); i++) base.add(5, 4294967295);
    base.add(5, (1 << 21) - 6);                   // count === 2^53 - 6
    assert.equal(base.count, DD_MAX_SAFE - 5);
    const other6 = new DDSketch(0.01); other6.add(5, 6);
    const b6 = ddSnap(base);
    assert.throws(() => base.merge(other6), (e) => liteSketch(e) && /9007199254740991/.test(e.message));
    ddUnchanged(b6, base, 'merge count+1 reject');
    const other5 = new DDSketch(0.01); other5.add(5, 5);
    assert.doesNotThrow(() => base.merge(other5));
    assert.equal(base.count, DD_MAX_SAFE);
});

test('G-F20 (DD): a rejected arg never runs caller code (tagged, calls===0, byte-identical)', () => {
    let calls = 0;
    let dRef;
    const H = () => ({ [Symbol.toPrimitive]() { calls++; if (dRef) dRef.add(1); return 1; },
                       toString() { calls++; if (dRef) dRef.add(1); return 'x'; },
                       valueOf() { calls++; if (dRef) dRef.add(1); return 1; } });
    const hostile = () => [Object.create(null), { toString() { calls++; throw new Error('boom'); } }, H(),
        Object.assign(function () {}, { toString() { calls++; return 'f'; } })];
    // ctor slots: alpha, {maxBins}, {range:H}, {range:[H,5]}, {range:[1,H]}
    for (const h of hostile()) assert.throws(() => new DDSketch(h), liteSketch);
    for (const h of hostile()) assert.throws(() => new DDSketch(0.01, { maxBins: h }), liteSketch);
    for (const h of hostile()) assert.throws(() => new DDSketch(0.01, { range: h }), liteSketch);
    for (const h of hostile()) assert.throws(() => new DDSketch(0.01, { range: [h, 5] }), liteSketch);
    for (const h of hostile()) assert.throws(() => new DDSketch(0.01, { range: [1, h] }), liteSketch);
    dRef = new DDSketch(0.01); dRef.add(2);
    for (const h of hostile()) { const b = ddSnap(dRef); assert.throws(() => dRef.add(h), liteSketch); ddUnchanged(b, dRef, 'add value'); }
    for (const h of hostile()) { const b = ddSnap(dRef); assert.throws(() => dRef.add(2, h), liteSketch); ddUnchanged(b, dRef, 'add count'); }
    for (const h of hostile()) { const b = ddSnap(dRef); assert.throws(() => dRef.addFrom(h, 0), liteSketch); ddUnchanged(b, dRef, 'addFrom buf'); }
    for (const h of hostile()) { const b = ddSnap(dRef); assert.throws(() => dRef.addFrom(new Float64Array([1]), h), liteSketch); ddUnchanged(b, dRef, 'addFrom i'); }
    assert.equal(calls, 0, 'no hostile toString/valueOf/toPrimitive ran');
    let msg = '';
    try { new DDSketch(Object.create(null)); } catch (e) { msg = e.message; }
    assert.ok(/got \[object]$/.test(msg), 'null-proto message: ' + msg);
});

// Pin: a non-finite value is rejected by _badValue (TypeError, "value must be finite..."), NOT by
// _badIndexable (RangeError) -- so a mutant weakening `!Number.isFinite(value)` to a NaN-only check
// (which would let Infinity flow into Math.log and hit the indexable guard) dies on type AND message.
// The message prefix is byte-identical to HEAD.
test('G-F20b (DD): non-finite add / addFrom hit _badValue (TypeError), not _badIndexable', () => {
    const s = new DDSketch(0.01);
    const valMsg = (e) => e instanceof TypeError && liteSketch(e) &&
        /DDSketch value must be finite, non-negative/.test(e.message);
    for (const v of [Infinity, -Infinity, NaN, '1']) {
        assert.throws(() => s.add(v), valMsg, 'add(' + String(v) + ')');
    }
    for (const v of [Infinity, -Infinity, NaN]) {
        assert.throws(() => s.addFrom(new Float64Array([v]), 0), valMsg, 'addFrom([' + v + '])');
    }
});

// QA H2.3 boundary gap: self-merge (this === other) at the count ceiling, and the _badTotal
// message is a RangeError printing the current count and the rejected n.
test('QA H2.3 (DD): self-merge at the count ceiling; _badTotal prints current count + n', () => {
    const s = new DDSketch(0.01);
    for (let i = 0; i < (1 << 20); i++) s.add(5, 4294967295);
    s.add(5, (1 << 20) - 1);
    assert.equal(s.count, 2 ** 52 - 1);
    assert.equal(s.merge(s).count, 2 ** 53 - 2);
    const b = ddSnap(s);
    assert.throws(() => s.merge(s), (e) => e instanceof RangeError && liteSketch(e) &&
        e.message.includes('current count ' + (2 ** 53 - 2) + ' + ' + (2 ** 53 - 2)));
    ddUnchanged(b, s, 'self-merge count+1 reject');
    assert.throws(() => s.add(5, 2), (e) => e instanceof RangeError &&
        e.message.includes('current count ' + (2 ** 53 - 2) + ' + 2'));
    ddUnchanged(b, s, 'add count+1 reject');
});

// ===========================================================================
// H2.7 G-F21 (merge brand), G-F18o (option bags, D2), G-F18z (-0 outputs), G-F8 (quantilesInto).
// The brand is a class-private #brand installed by the ctor; `#brand in other` is the FIRST
// statement of merge / _badMerge, before any read of `other`. The bag rule accepts only a
// root-prototype (any realm) or null-proto object with own DATA keys from the KNOWN set; values
// are OWN-read, so a polluted Object.prototype is ignored. See headrun/ for HEAD-failure evidence.
// ===========================================================================

function ddCountingProxy(real, counter) {
    return new Proxy(real, {
        get(t, k, r) { counter.n++; return Reflect.get(t, k, r); },
        has(t, k) { counter.n++; return Reflect.has(t, k); },
        getPrototypeOf(t) { counter.n++; return Reflect.getPrototypeOf(t); },
    });
}

test('G-F21 (DD): merge rejects a field-copy forgery + a Proxy over a real instance, TAGGED, 0 traps', () => {
    const base = new DDSketch(0.01);
    for (let i = 1; i <= 500; i++) base.add(i);
    const real = new DDSketch(0.01);
    for (let i = 1; i <= 500; i++) real.add(i + 1000);
    const snap = ddSnap(base);

    const forged = Object.assign(Object.create(DDSketch.prototype), real);
    assert.ok(forged instanceof DDSketch, 'the forgery passes instanceof');
    assert.throws(() => base.merge(forged), (e) => e instanceof TypeError && liteSketch(e), 'field-copy forgery');
    ddUnchanged(snap, base, 'field-copy reject');

    const counter = { n: 0 };
    const px = ddCountingProxy(real, counter);
    assert.ok(px instanceof DDSketch);
    counter.n = 0;
    assert.throws(() => base.merge(px), (e) => e instanceof TypeError && liteSketch(e), 'Proxy merge');
    assert.equal(counter.n, 0, 'the brand check ran NO proxy trap');
    ddUnchanged(snap, base, 'Proxy reject');
});

test('G-F21 (DD): a _gamma-only forgery leaves count / sum unchanged (HEAD merges it to NaN)', () => {
    const base = new DDSketch(0.01);
    for (let i = 1; i <= 100; i++) base.add(i);
    const cBefore = base.count, sBefore = base.sum;
    const gOnly = Object.create(DDSketch.prototype);
    gOnly._gamma = base._gamma;   // matches gamma; HEAD's instanceof+gamma check would pass
    assert.throws(() => base.merge(gOnly), (e) => e instanceof TypeError && liteSketch(e), 'gamma-only forgery');
    assert.equal(base.count, cBefore, 'count unchanged (not NaN)');
    assert.equal(base.sum, sBefore, 'sum unchanged (not NaN)');
    assert.ok(Number.isFinite(base.count) && Number.isFinite(base.sum), 'aggregates stay finite');
});

test('G-F21 (DD): merge(primitive / null / undefined) throws TAGGED; a subclass merges', () => {
    const base = new DDSketch(0.01);
    base.add(5);
    const snap = ddSnap(base);
    for (const o of [5, 0, 'x', true, Symbol('s'), null, undefined, NaN]) {
        assert.throws(() => base.merge(o), liteSketch, 'merge(' + String(o) + ')');
    }
    ddUnchanged(snap, base, 'primitive / null rejects');
    class SubDD extends DDSketch {}
    const sub = new SubDD(0.01);
    for (let i = 1; i <= 100; i++) sub.add(i + 2000);
    assert.doesNotThrow(() => base.merge(sub), 'a subclass carries the brand and merges');
});

test('G-F18o (DD): unknown-key bags throw _badOption; non-bags throw the plain-object TypeError', () => {
    const badOpt = (e) => e instanceof TypeError && /unknown option/.test(e.message) && liteSketch(e);
    const plain = (e) => e instanceof TypeError && /must be a plain object/.test(e.message) && liteSketch(e);
    for (const bag of [{ toString: 1 }, { constructor: 1 }, { hasOwnProperty: 1 }, JSON.parse('{"__proto__":1}'), { [Symbol('x')]: 1 }]) {
        assert.throws(() => new DDSketch(0.01, bag), badOpt, 'unknown-key bag');
    }
    let accCalls = 0;
    const accessorBag = {};
    Object.defineProperty(accessorBag, 'maxBins', { enumerable: true, configurable: true, get() { accCalls++; return 8; } });
    const { proxy, revoke } = Proxy.revocable({ maxBins: 8 }, {});
    revoke();
    const nonbags = [new Map(), new Date(), /x/, [], new (class {})(), Object.create({ maxBins: 8 }),
        accessorBag, proxy, new Proxy({}, { getPrototypeOf() { throw new Error('boom'); } })];
    for (const bag of nonbags) assert.throws(() => new DDSketch(0.01, bag), plain, 'non-bag');
    assert.equal(accCalls, 0, 'an accessor bag never runs its getter');
});

test('G-F18o (DD): a revoked-Proxy range throws _badRange; accepts literal / null-proto / cross-realm / non-enum bags; pollution ignored', () => {
    const badRange = (e) => e instanceof Error && /range must be \[min, max]/.test(e.message) && liteSketch(e);
    const { proxy, revoke } = Proxy.revocable([1, 1000], {});
    revoke();
    assert.throws(() => new DDSketch(0.01, { range: proxy }), badRange, 'revoked-Proxy range -> tagged _badRange');

    const neBag = {};
    Object.defineProperty(neBag, 'maxBins', { value: 16, enumerable: false });
    for (const bag of [{ maxBins: 16 }, { __proto__: null, maxBins: 16 }, runInNewContext('({ maxBins: 16 })'), neBag]) {
        assert.equal(new DDSketch(0.01, bag).maxBins, 16, 'bag maxBins applied');
    }
    assert.doesNotThrow(() => new DDSketch(0.01, Object.create(null)), 'Object.create(null) is a legal empty bag');

    const DEF = new DDSketch(0.01).maxBins;   // DD_MAX_BINS_DEFAULT
    const orig = Object.getOwnPropertyDescriptor(Object.prototype, 'maxBins');
    try {
        Object.prototype.maxBins = 8;
        assert.equal(new DDSketch(0.01, {}).maxBins, DEF, 'polluted maxBins ignored for {}');
        assert.equal(new DDSketch(0.01).maxBins, DEF, 'polluted maxBins ignored for no-options');
    } finally {
        if (orig) Object.defineProperty(Object.prototype, 'maxBins', orig); else delete Object.prototype.maxBins;
    }
});

test('G-F18o (DD): the strict range is read exactly once per index -- no TOCTOU re-read (F18)', () => {
    const badRange = (e) => e instanceof Error && /range must be \[min, max]/.test(e.message) && liteSketch(e);
    // A two-faced getter: index returns a valid number FIRST, then something else. The ctor must use
    // the VALIDATED value, reading each index exactly once -- a re-read for rangeMin/rangeMax would
    // store the second ("pwned") value or let a second-read throw escape untagged.
    let c0 = 0, c1 = 0, n0 = 0, n1 = 0;
    const tf = [];
    Object.defineProperty(tf, '0', { enumerable: true, configurable: true, get() { c0++; return n0++ === 0 ? 1 : 'pwned'; } });
    Object.defineProperty(tf, '1', { enumerable: true, configurable: true, get() { c1++; return n1++ === 0 ? 100 : 9e9; } });
    tf.length = 2;
    const d = new DDSketch(0.01, { range: tf });
    assert.equal(c0, 1, 'range[0] read exactly once');
    assert.equal(c1, 1, 'range[1] read exactly once');
    assert.ok(Object.is(d.rangeMin, 1) && Object.is(d.rangeMax, 100), 'the VALIDATED numbers are stored, never a re-read');
    // A getter that THROWS on the second read must NOT escape untagged (there is no second read).
    const tt = []; let s0 = 0;
    Object.defineProperty(tt, '0', { enumerable: true, configurable: true, get() { s0++; if (s0 > 1) throw new Error('second-read boom'); return 1; } });
    Object.defineProperty(tt, '1', { enumerable: true, configurable: true, value: 100 });
    tt.length = 2;
    assert.doesNotThrow(() => { const x = new DDSketch(0.01, { range: tt }); assert.equal(x.rangeMin, 1); },
        'a throw-on-second-read range never fires -- each index is read once');
    assert.equal(s0, 1, 'index 0 read exactly once (no untagged escape)');
    // Control: a getter range whose single read is INVALID still rejects tagged.
    const bad = []; Object.defineProperty(bad, '0', { enumerable: true, configurable: true, get() { return -1; } });
    Object.defineProperty(bad, '1', { enumerable: true, configurable: true, value: 100 });
    bad.length = 2;
    assert.throws(() => new DDSketch(0.01, { range: bad }), badRange, 'an invalid single read rejects tagged');
});

test('G-F18o (DD): a polluted Object.prototype.value cannot smuggle an accessor bag (own-value check)', () => {
    // The descriptor data-vs-accessor test reads its OWN `value` (not the prototype chain), so a
    // polluted `Object.prototype.value` (data or getter) cannot make an accessor bag look like a
    // data descriptor: the bag stays a non-bag and no getter runs.
    const plain = (e) => e instanceof TypeError && /must be a plain object/.test(e.message) && liteSketch(e);
    const DEF = new DDSketch(0.01).maxBins;
    let getterCalls = 0;
    const orig = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
    try {
        Object.prototype.value = 5;                       // (a) DATA pollution
        assert.throws(() => new DDSketch(0.01, { get maxBins() { getterCalls++; return 9; } }), plain,
            'accessor bag rejected with Object.prototype.value = 5 (pre-fix: accepted, maxBins 5)');
        delete Object.prototype.value;
        Object.defineProperty(Object.prototype, 'value', { configurable: true, get() { getterCalls++; return 3; } });   // (b) GETTER pollution
        assert.throws(() => new DDSketch(0.01, { get maxBins() { getterCalls++; return 9; } }), plain,
            'accessor bag rejected with an Object.prototype.value getter (pre-fix: ran user code)');
    } finally {
        if (orig) Object.defineProperty(Object.prototype, 'value', orig); else delete Object.prototype.value;
    }
    assert.equal(getterCalls, 0, 'neither the bag accessor nor the polluted-proto getter ever runs');
    assert.equal(new DDSketch(0.01).maxBins, DEF, 'default maxBins intact after cleanup');
});

test('G-F18z (DD): add(-0) reads +0 from min and max (stored -0 normalized at the getter)', () => {
    const d = new DDSketch(0.01);
    d.add(-0);
    assert.ok(Object.is(d.min, 0), 'min is +0, not -0');
    assert.ok(Object.is(d.max, 0), 'max is +0, not -0');
});

test('G-F8 (DD): quantilesInto matches quantile(q) bit-for-bit over q x sketch shapes', () => {
    const qlist = [0, -0, 1e-9, 0.25, 0.5, 0.9, 0.99, 0.999, 1, NaN, -1e-300, 1 + 2 ** -52, Infinity, -Infinity];
    const shapes = {
        empty: () => new DDSketch(0.01),
        zeros: () => { const d = new DDSketch(0.01); for (let i = 0; i < 50; i++) d.add(0); return d; },
        vals: () => { const d = new DDSketch(0.01); for (let i = 1; i <= 10000; i++) d.add(i * 0.5); return d; },
        strict: () => { const d = new DDSketch(0.01, { range: [1, 1000] }); for (let i = 1; i <= 500; i++) d.add(i); return d; },
        collapsed: () => collapsedShard(0.01),
        merged: () => { const a = new DDSketch(0.01), b = new DDSketch(0.01); for (let i = 1; i <= 500; i++) { a.add(i); b.add(i + 500); } a.merge(b); return a; },
    };
    for (const [name, make] of Object.entries(shapes)) {
        const d = make();
        const qs = Float64Array.from(qlist);
        const out = new Float64Array(qlist.length);
        const w = d.quantilesInto(qs, out);
        assert.equal(w, qlist.length, name + ': w == qs.length');
        for (let j = 0; j < qlist.length; j++) {
            const exp = d.quantile(qlist[j]);
            assert.ok(Object.is(out[j], exp), name + ': q=' + qlist[j] + ' expected ' + exp + ' got ' + out[j]);
        }
    }
});

test('G-F8 (DD): quantilesInto is in-place-safe (qs === out) and rejects non-F64 / partial overlap TAGGED', () => {
    const badQ = (e) => e instanceof TypeError && /needs two non-overlapping Float64Arrays/.test(e.message) && liteSketch(e);
    const d = new DDSketch(0.01);
    for (let i = 1; i <= 1000; i++) d.add(i);
    const expd = [d.quantile(0.5), d.quantile(0.9), d.quantile(0.99)];
    const a = Float64Array.from([0.5, 0.9, 0.99]);
    const w = d.quantilesInto(a, a);   // in-place: each index read before written
    assert.equal(w, 3);
    for (let j = 0; j < 3; j++) assert.ok(Object.is(a[j], expd[j]), 'in-place q[' + j + ']');

    const buf = new ArrayBuffer(4 * 8);
    const v1 = new Float64Array(buf, 0, 3);
    const v2 = new Float64Array(buf, 8, 3);   // partial overlap of distinct views
    assert.throws(() => d.quantilesInto(v1, v2), badQ, 'partial overlap');
    for (const bad of [new Float32Array(3), [0.5, 0.9, 0.99], null, undefined, { length: 3 }]) {
        assert.throws(() => d.quantilesInto(bad, new Float64Array(3)), badQ, 'bad qs');
        assert.throws(() => d.quantilesInto(new Float64Array(3), bad), badQ, 'bad out');
    }
});

test('G-F8 (DD): quantilesInto fails closed on SharedArrayBuffer aliasing (distinct SAB objects)', () => {
    if (typeof SharedArrayBuffer !== 'function') return;   // host without SAB
    const badQ = (e) => e instanceof TypeError && /needs two non-overlapping Float64Arrays/.test(e.message) && liteSketch(e);
    const d = new DDSketch(0.01);
    for (let i = 1; i <= 1000; i++) d.add(i);
    // Two DISTINCT SAB objects aliasing the same memory (structuredClone) -> reject, no write.
    const sab = new SharedArrayBuffer(8 * 8);
    let cl; try { cl = structuredClone(sab); } catch { cl = null; }
    if (cl !== null && cl !== sab) {
        const q = new Float64Array(sab, 0, 4); q.set([0.5, 0.9, 0.99, 0.999]);
        const out = new Float64Array(cl, 8, 4);
        const outBefore = Array.from(out);
        assert.throws(() => d.quantilesInto(q, out), badQ, 'cross-SAB alias rejected (fail closed)');
        assert.deepEqual(Array.from(out), outBefore, 'no write before the SAB-alias throw');
    }
    // Two distinct non-aliased SABs rejected (documented fail-closed cost).
    assert.throws(() => d.quantilesInto(
        new Float64Array(new SharedArrayBuffer(8 * 4), 0, 4),
        new Float64Array(new SharedArrayBuffer(8 * 4), 0, 4)), badQ, 'distinct non-aliased SABs rejected');
    // In-place on ONE SAB (qs === out) still works; disjoint views on one SAB work.
    const one = new SharedArrayBuffer(8 * 8);
    const io = new Float64Array(one, 0, 4); io.set([0.5, 0.9, 0.99, 0.999]);
    const exp = [d.quantile(0.5), d.quantile(0.9), d.quantile(0.99), d.quantile(0.999)];
    assert.equal(d.quantilesInto(io, io), 4, 'in-place on one SAB');
    for (let j = 0; j < 4; j++) assert.ok(Object.is(io[j], exp[j]), 'in-place SAB q[' + j + ']');
    const qs2 = new Float64Array(one, 0, 4); qs2.set([0.5, 0.9, 0.99, 0.999]);
    assert.doesNotThrow(() => d.quantilesInto(qs2, new Float64Array(one, 8 * 4, 4)), 'disjoint views on one SAB');
    // One SAB-backed arg + one plain arg: distinct objects, not both SAB -> accepted.
    const qsP = new Float64Array(new SharedArrayBuffer(8 * 4), 0, 4); qsP.set([0.5, 0.9, 0.99, 0.999]);
    assert.doesNotThrow(() => d.quantilesInto(qsP, new Float64Array(4)), 'one SAB + one plain accepted');
});

// ===========================================================================
// H2.7 qa boundary suite -- quantilesInto / -0 / option bags / merge brand edges
// ===========================================================================

const qaBadQ = (e) => e instanceof TypeError && /needs two non-overlapping Float64Arrays/.test(e.message) && liteSketch(e);
const qaDDPlain = (e) => e instanceof TypeError && /DDSketch options must be a plain object/.test(e.message) && liteSketch(e);
function qaDD() {
    const d = new DDSketch(0.01);
    for (let i = 1; i <= 100; i++) d.add(i);
    return d;
}

test('QA H2.7 (DD): quantilesInto empty qs / empty out return 0 and write nothing; a length mismatch writes min(lengths)', () => {
    const d = qaDD();
    const out = new Float64Array([7, 7, 7]);
    assert.ok(Object.is(d.quantilesInto(new Float64Array(0), out), 0));
    assert.deepEqual(Array.from(out), [7, 7, 7]);
    assert.ok(Object.is(d.quantilesInto(Float64Array.of(0.5, 0.9), new Float64Array(0)), 0));
    const short = new Float64Array([7]);
    assert.equal(d.quantilesInto(Float64Array.of(0.5, 0.9, 0.99), short), 1, 'qs longer than out');
    assert.ok(Object.is(short[0], d.quantile(0.5)));
    const long = new Float64Array([7, 7, 7, 7]);
    assert.equal(d.quantilesInto(Float64Array.of(0.25, 0.75), long), 2, 'out longer than qs');
    assert.deepEqual(Array.from(long), [d.quantile(0.25), d.quantile(0.75), 7, 7], 'nothing past m');
});

test('QA H2.7 (DD): quantilesInto q edge values (NaN, -0, +-0 subnormal, +-Infinity, 1 +- ulp, MAX_VALUE) equal quantile(q) bit-for-bit, never throw', () => {
    const qs = Float64Array.of(NaN, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, Infinity, -Infinity,
        1 - 2 ** -53, 1, 1 + 2 ** -52, Number.MAX_VALUE, -Number.MAX_VALUE, 0.5);
    for (const d of [new DDSketch(0.01), qaDD(), (() => { const z = new DDSketch(0.02); z.add(0); z.add(-0); return z; })()]) {
        const out = new Float64Array(qs.length).fill(-3);
        assert.equal(d.quantilesInto(qs, out), qs.length);
        for (let j = 0; j < qs.length; j++) {
            assert.ok(Object.is(out[j], d.quantile(qs[j])), 'q=' + qs[j] + ' got ' + out[j] + ' want ' + d.quantile(qs[j]));
        }
    }
});

test('QA H2.7 (DD): quantilesInto in place (qs === out) and an identical-range subarray are allowed; a shifted subarray rejects TAGGED, untouched', () => {
    const d = qaDD();
    const x = Float64Array.of(0.5, 0.99, 0.1);
    const want = [d.quantile(0.5), d.quantile(0.99), d.quantile(0.1)];
    assert.equal(d.quantilesInto(x, x), 3);
    assert.deepEqual(Array.from(x), want);
    const y = Float64Array.of(0.5, 0.99, 0.1);
    assert.equal(d.quantilesInto(y, y.subarray(0)), 3, 'a distinct view over the exact same bytes');
    assert.deepEqual(Array.from(y), want);
    const z = Float64Array.of(0.5, 0.99, 0.1);
    assert.throws(() => d.quantilesInto(z.subarray(0, 2), z.subarray(1)), qaBadQ, 'shift by one');
    assert.throws(() => d.quantilesInto(z.subarray(1), z.subarray(0, 2)), qaBadQ, 'shift by one, reversed');
    assert.deepEqual(Array.from(z), [0.5, 0.99, 0.1], 'no write before the reject');
    const buf = new ArrayBuffer(32);
    const a = new Float64Array(buf, 0, 2), b = new Float64Array(buf, 16, 2);
    a.set([0.5, 0.9]);
    assert.equal(d.quantilesInto(a, b), 2, 'touching views accepted');
    assert.deepEqual(Array.from(b), [d.quantile(0.5), d.quantile(0.9)]);
});

test('QA H2.7 (DD): quantilesInto detached / out-of-bounds views read length 0; a forged-tag Float32Array subclass and non-arrays reject with no user code', () => {
    const d = qaDD();
    const ab = new ArrayBuffer(32);
    const det = new Float64Array(ab);
    structuredClone(ab, { transfer: [ab] });
    const out = new Float64Array([4, 4]);
    assert.ok(Object.is(d.quantilesInto(det, out), 0));
    assert.ok(Object.is(d.quantilesInto(Float64Array.of(0.5), det), 0));
    assert.deepEqual(Array.from(out), [4, 4]);
    let rab = null;
    try { rab = new ArrayBuffer(32, { maxByteLength: 64 }); } catch { rab = null; }
    if (rab !== null && typeof rab.resize === 'function') {
        const fixed = new Float64Array(rab, 0, 4);
        const track = new Float64Array(rab);
        fixed.set([0.5, 0.9, 0.99, 0.999]);
        assert.equal(d.quantilesInto(track, track), 4, 'tracking in place');
        rab.resize(8);
        assert.equal(fixed.length, 0, 'out of bounds');
        assert.ok(Object.is(d.quantilesInto(fixed, out), 0));
        track[0] = 0.5;
        assert.equal(d.quantilesInto(track, out), 1, 'shrunk tracking view');
        assert.ok(Object.is(out[0], d.quantile(0.5)));
    }
    let calls = 0;
    class Fake extends Float32Array { get [Symbol.toStringTag]() { calls++; return 'Float64Array'; } get length() { calls++; return 2; } }
    const o2 = new Float64Array([4, 4]);
    for (const bad of [new Fake(2), [0.5], { length: 1, 0: 0.5 }, null, undefined, 0.5, new Proxy(new Float64Array(1), {})]) {
        assert.throws(() => d.quantilesInto(bad, o2), qaBadQ);
        assert.throws(() => d.quantilesInto(Float64Array.of(0.5), bad), qaBadQ);
    }
    assert.equal(calls, 0, 'no user getter ran');
    assert.deepEqual(Array.from(o2), [4, 4]);
});

test('QA H2.7 (DD): -0 only, -0 then +0, and +0 then -0 all read +0 from min / max / quantile(0) / quantilesInto', () => {
    const seqs = [[-0], [-0, 0], [0, -0], [-0, -0, 5]];
    for (const seq of seqs) {
        const d = new DDSketch(0.01);
        for (const v of seq) d.add(v);
        assert.ok(Object.is(d.min, 0), 'min ' + seq);
        if (seq.length < 3) assert.ok(Object.is(d.max, 0), 'max ' + seq);
        assert.ok(Object.is(d.quantile(0), 0));
        const o = new Float64Array(1);
        d.quantilesInto(Float64Array.of(-0), o);
        assert.ok(Object.is(o[0], 0), 'quantilesInto(-0)');
    }
});

test('QA H2.7 (DD): option bags -- frozen bag + frozen range accepted; Symbol / computed __proto__ / getter maxBins rejected TAGGED with no user code', () => {
    const d = new DDSketch(0.01, Object.freeze({ maxBins: 64, range: Object.freeze([1, 1000]) }));
    assert.equal(d.rangeMin, 1);
    assert.equal(d.rangeMax, 1000);
    assert.equal(new DDSketch(0.01, Object.seal({ maxBins: 8 }))._maxBins, 8, 'sealed');
    assert.throws(() => new DDSketch(0.01, { [Symbol('qa')]: 1 }), (e) => e instanceof TypeError && /unknown option "Symbol\(qa\)"/.test(e.message) && liteSketch(e));
    assert.throws(() => new DDSketch(0.01, { ['__proto__']: { maxBins: 8 } }), (e) => /unknown option "__proto__"/.test(e.message) && liteSketch(e));
    let g = 0;
    assert.throws(() => new DDSketch(0.01, { get maxBins() { g++; return 8; } }), qaDDPlain);
    // A bag whose prototype (null-proto) carries an own KNOWN key fails closed (would smuggle a
    // dropped option); getOwnPropertyDescriptor reads the descriptor, so the getter never runs.
    assert.throws(() => new DDSketch(0.01, Object.create(Object.defineProperty(Object.create(null), 'maxBins', { get() { g++; return 8; } }))),
        qaDDPlain, 'a prototype carrying a known key fails closed');
    assert.throws(() => new DDSketch(0.01, runInNewContext('Object.prototype.maxBins = 8; ({})')),
        qaDDPlain, 'cross-realm polluted Object.prototype rejected');
    assert.equal(g, 0, 'no getter ran');
});

test('QA H2.7 (DD): merge brand -- a second module instance is rejected TAGGED; an overriding subclass merges through super', async () => {
    const M2 = await import(new URL('../Sketch.js', import.meta.url).href + '?qa-second-instance-dd');
    const a = qaDD(), b = new M2.DDSketch(0.01);
    b.add(3);
    const before = ddSnap(a);
    assert.throws(() => a.merge(b), (e) => e instanceof TypeError && /merge expects a DDSketch/.test(e.message) && liteSketch(e));
    ddUnchanged(before, a, 'second-instance reject');
    let over = 0;
    class Sub extends DDSketch { merge(o) { over++; return super.merge(o); } }
    const x = new Sub(0.01);
    x.add(2);
    x.merge(qaDD());
    assert.equal(over, 1);
    assert.equal(x.count, 101);
    const y = qaDD();
    y.merge(x);
    assert.equal(y.count, 201);
});

test('QA H2.7 (DD): a polluted Object.prototype.range / maxBins (data AND getter) never reaches a literal bag -- the sketch stays non-strict, default bins', () => {
    const had = Object.prototype.hasOwnProperty.call(Object.prototype, 'range');
    let calls = 0;
    try {
        Object.prototype.range = [1, 2];
        const a = new DDSketch(0.01, {});
        assert.equal(a.strict, false, 'inherited data range ignored');
        assert.ok(Number.isNaN(a.rangeMin));
        a.add(1e6);   // outside [1, 2]: a strict sketch would throw
        assert.equal(a.count, 1);
        delete Object.prototype.range;
        Object.defineProperty(Object.prototype, 'range', { get() { calls++; return [1, 2]; }, configurable: true });
        Object.defineProperty(Object.prototype, 'maxBins', { get() { calls++; return 4; }, configurable: true });
        const b = new DDSketch(0.01, { maxBins: 64 });
        assert.equal(b.strict, false, 'inherited getter range ignored');
        assert.equal(b.maxBins, 64);
    } finally {
        delete Object.prototype.range;
        delete Object.prototype.maxBins;
        assert.equal(had, false);
    }
    assert.equal(calls, 0, 'no inherited getter ran');
});
