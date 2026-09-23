/**
 * @zakkster/lite-sketch -- SpaceSaving boundary + heavy-hitters guarantee suite (node:test).
 *
 * Proves the SpaceSaving contract:
 *   1. NO FALSE NEGATIVES (the defining guarantee): on a Zipfian stream (N >= 1e6), every
 *      key whose TRUE frequency (an exact Map oracle) exceeds N/k is monitored
 *      (estimate(key) > 0) AND appears in heavyHitters(1/k) -- 0 misses.
 *   2. INTERVAL BRACKETS TRUTH: for every monitored key, count-error <= trueCount <= count.
 *   3. ERROR BOUND: errorOf(key) <= N/k for every monitored key.
 *   4. EVICTION keeps size===capacity once full, and the evicted slot always held a true
 *      current-min counter (spot-checked against a full scan).
 *   5. topK returns the top-n keys DESC by count; defaults to size; clamps n > size.
 *   6. heavyHitters is a SUPERSET (no false negatives; false positives are allowed by design).
 *   7. MERGE: split a Zipfian stream across two same-(capacity,seed) shards -- the merged
 *      summary has no false negatives + the bracket holds over the WHOLE stream + total is
 *      exact; merge fails closed (byte-identical no-op) on a bad peer.
 *   8. ZERO IS A LEGAL KEY: add(0) tracks correctly and round-trips through eviction.
 *   9. FAIL-CLOSED no-op matrix: ctor / add / withError bad-argument matrix, byte-identical
 *      no-op; estimate/errorOf/topK/heavyHitters/forEach/getters NEVER throw; NO addHashed.
 *  10. CTOR + withError + getters + the generic boundary matrix (0, 1, N-1, N, N+1, empty,
 *      null, undefined, NaN, -0, duplicate dispose, dispose-during-iteration, re-entrant
 *      write, and an adversarial self-merge case).
 *
 * (The full accuracy witness is the orchestrator's test/witness.mjs; this is the boundary +
 * correctness proof.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceSaving, VERSION } from '../Sketch.js';

void VERSION; // VERSION-pin is asserted once, centrally, by the other suites; not duplicated here.

const liteSketch = (e) => e instanceof Error && /^\[lite-sketch]/.test(e.message);

// Deterministic PRNG (mulberry32-style) so no test ever flakes -- matches the convention in
// CountMinSketch.test.js / DDSketch.test.js.
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

/** Zipfian sample generator over ranks [0, nKeys) with exponent `skew` (harmonic-CDF binary search). */
function makeZipf(nKeys, skew, rng) {
    const harm = new Float64Array(nKeys);
    let sum = 0;
    for (let i = 1; i <= nKeys; i++) {
        sum += 1 / Math.pow(i, skew);
        harm[i - 1] = sum;
    }
    const total = sum;
    return function zipf() {
        const target = rng() * total;
        let lo = 0, hi = nKeys - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (harm[mid] < target) lo = mid + 1; else hi = mid;
        }
        return lo;
    };
}

/** Drive a fresh Zipfian stream into a fresh SpaceSaving(k), tracked against an exact Map oracle. */
function driveZipfStream(k, { N = 1000000, nKeys = 2000, skew = 1.1, seed = 0xA5A5A5A5, ssSeed } = {}) {
    const rng = makeRng(seed);
    const zipf = makeZipf(nKeys, skew, rng);
    const ss = ssSeed === undefined ? new SpaceSaving(k) : new SpaceSaving(k, { seed: ssSeed });
    const truth = new Map();
    for (let i = 0; i < N; i++) {
        const key = zipf();
        ss.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    return { ss, truth, N };
}

// ===========================================================================
// 1. NO FALSE NEGATIVES -- the defining guarantee
// ===========================================================================

test('NO FALSE NEGATIVES: every key with true frequency > N/k is monitored (estimate>0), ' +
    'N>=1e6, exact Map oracle', () => {
    const k = 100;
    const { ss, truth, N } = driveZipfStream(k, { N: 1000000, nKeys: 2000, skew: 1.1, seed: 0xA5A5A5A5 });
    const cutoff = N / k;
    const trueHitters = [];
    for (const [key, trueCount] of truth) if (trueCount > cutoff) trueHitters.push(key);
    assert.ok(trueHitters.length > 0, 'test design: at least one true hitter must exist above N/k=' + cutoff);
    let misses = 0;
    for (const key of trueHitters) {
        if (!(ss.estimate(key) > 0)) {
            misses++;
            console.error('  MISS key=' + key + ' true=' + truth.get(key) + ' estimate=' + ss.estimate(key));
        }
    }
    assert.equal(misses, 0, misses + ' true hitter(s) out of ' + trueHitters.length + ' missed by estimate()');
});

test('NO FALSE NEGATIVES: every true hitter above N/k also appears in heavyHitters(1/k) (the superset)', () => {
    const k = 100;
    const { ss, truth, N } = driveZipfStream(k, { N: 1000000, nKeys: 2000, skew: 1.1, seed: 0xA5A5A5A5 });
    const cutoff = N / k;
    const trueHitters = [];
    for (const [key, trueCount] of truth) if (trueCount > cutoff) trueHitters.push(key);
    assert.ok(trueHitters.length > 0, 'test design: at least one true hitter must exist above N/k');
    const hh = ss.heavyHitters(1 / k);
    const hhKeys = new Set(hh.map((e) => e.key));
    let missing = 0;
    for (const key of trueHitters) {
        if (!hhKeys.has(key)) {
            missing++;
            console.error('  MISSING from heavyHitters: key=' + key + ' true=' + truth.get(key));
        }
    }
    assert.equal(missing, 0, missing + ' true hitter(s) missing from heavyHitters(1/k)');
});

// ===========================================================================
// 2. INTERVAL BRACKETS TRUTH
// ===========================================================================

test('INTERVAL BRACKETS TRUTH: count-error <= trueCount <= count for every monitored key', () => {
    const k = 80;
    const { ss, truth } = driveZipfStream(k, { N: 1000000, nKeys: 3000, skew: 1.1, seed: 0xB4B4B4B4 });
    let violations = 0;
    let checked = 0;
    ss.forEach((key, count, error) => {
        checked++;
        const trueCount = truth.get(key) || 0;
        if (!(count - error <= trueCount && trueCount <= count)) {
            violations++;
            console.error('  bracket violation key=' + key + ' count=' + count + ' error=' + error +
                ' true=' + trueCount);
        }
    });
    assert.ok(checked > 0, 'test design: the sketch must be full (checked=0 would be vacuous)');
    assert.equal(violations, 0, violations + ' / ' + checked + ' monitored key(s) violated the bracket');
});

// ===========================================================================
// 3. ERROR BOUND
// ===========================================================================

test('ERROR BOUND: errorOf(key) <= N/k for every monitored key', () => {
    const k = 80;
    const { ss, N } = driveZipfStream(k, { N: 1000000, nKeys: 3000, skew: 1.1, seed: 0xC3C3C3C3 });
    const bound = N / k;
    let violations = 0;
    let checked = 0;
    ss.forEach((key, count, error) => {
        checked++;
        if (error > bound) {
            violations++;
            console.error('  error bound violation key=' + key + ' error=' + error + ' bound=' + bound);
        }
    });
    assert.ok(checked > 0);
    assert.equal(violations, 0, violations + ' / ' + checked + ' monitored key(s) exceeded error<=N/k=' + bound);
});

// ===========================================================================
// 4. EVICTION keeps size === capacity; spot-check the evicted slot is a true min-holder
// ===========================================================================

test('EVICTION: size stays === capacity once full over a long distinct-key stream', () => {
    const k = 16;
    const ss = new SpaceSaving(k, { seed: 0xD00D });
    for (let i = 0; i < k; i++) ss.add(i);
    assert.equal(ss.size, k);
    for (let i = k; i < k * 20; i++) {
        ss.add(i); // every add is a brand-new distinct key -> forces eviction every time
        assert.equal(ss.size, k, 'size drifted from capacity at i=' + i);
    }
});

test('EVICTION spot-check: the next evicted key is a true current-min holder', () => {
    const k = 16;
    const ss = new SpaceSaving(k, { seed: 0xD00D });
    for (let i = 0; i < k; i++) ss.add(i);
    for (let i = k; i < k * 20; i++) ss.add(i);
    assert.equal(ss.size, k);
    // Full scan: the min monitored count, and every key currently holding it.
    let minVal = Infinity;
    const minHolders = [];
    ss.forEach((key, count) => {
        if (count < minVal) { minVal = count; minHolders.length = 0; minHolders.push(key); }
        else if (count === minVal) minHolders.push(key);
    });
    assert.ok(minHolders.length > 0);
    const freshKey = 999999; // not present among the prior i in [0, k*20)
    ss.add(freshKey);
    assert.equal(ss.size, k, 'size must stay at capacity after the spot-check add');
    assert.equal(ss.estimate(freshKey), minVal + 1, 'the fresh key must land at min+1');
    assert.equal(ss.errorOf(freshKey), minVal, 'the fresh key error must equal the evicted min');
    let survivors = 0;
    for (const key of minHolders) if (ss.estimate(key) > 0) survivors++;
    assert.equal(survivors, minHolders.length - 1,
        'exactly one prior min-count holder must have been evicted (survivors=' + survivors +
        '/' + minHolders.length + ')');
});

// ===========================================================================
// 5. topK
// ===========================================================================

test('topK: returns the top-n keys DESC by count on a skewed stream where the top-n are all > N/k', () => {
    const k = 200;
    const topKeys = [500, 501, 502, 503, 504];
    const topCounts = [50000, 40000, 30000, 20000, 10000]; // strictly decreasing
    const ss = new SpaceSaving(k, { seed: 0xE5E5 });
    for (let i = 0; i < topKeys.length; i++) ss.add(topKeys[i], topCounts[i]);
    const rng = makeRng(0xF00F);
    const N_TAIL = 200000;
    for (let i = 0; i < N_TAIL; i++) ss.add(1000 + ((rng() * 100000) | 0), 1);
    const total = topCounts.reduce((a, b) => a + b, 0) + N_TAIL;
    const cutoff = total / k;
    for (const c of topCounts) assert.ok(c > cutoff, 'test design: every top count must exceed N/k=' + cutoff);

    const top5 = ss.topK(5);
    assert.equal(top5.length, 5);
    assert.deepEqual(top5.map((e) => e.key), topKeys, 'topK(5) must return the 5 hot keys in DESC order');
    for (let i = 0; i + 1 < top5.length; i++) {
        assert.ok(top5[i].count >= top5[i + 1].count, 'topK must be sorted DESC by count');
    }
});

test('topK() defaults to size; topK(n > size) clamps to size; topK(0) returns []', () => {
    const ss = new SpaceSaving(10, { seed: 1 });
    for (let i = 0; i < 5; i++) ss.add(i, i + 1);
    assert.equal(ss.size, 5);
    const full = ss.topK();
    assert.equal(full.length, 5);
    const over = ss.topK(1000);
    assert.equal(over.length, 5);
    assert.deepEqual(ss.topK(0), []);
    // DESC order on the small, exact (no-eviction-yet) set.
    assert.deepEqual(full.map((e) => e.key), [4, 3, 2, 1, 0]);
});

// ===========================================================================
// 6. heavyHitters is a SUPERSET (no false negatives; false positives allowed)
// ===========================================================================

test('heavyHitters: every returned entry satisfies count > threshold*total, and every oracle ' +
    'key with true freq > threshold*N is present (superset, false positives allowed)', () => {
    const k = 120;
    const { ss, truth, N } = driveZipfStream(k, { N: 1000000, nKeys: 2500, skew: 1.05, seed: 0x7EA7EA });
    const threshold = 1 / k;
    const hh = ss.heavyHitters(threshold);
    const cut = threshold * ss.total;
    for (const e of hh) {
        assert.ok(e.count > cut, 'returned entry key=' + e.key + ' count=' + e.count + ' must exceed cut=' + cut);
    }
    const hhKeys = new Set(hh.map((e) => e.key));
    let missing = 0;
    for (const [key, trueCount] of truth) {
        if (trueCount > threshold * N && !hhKeys.has(key)) missing++;
    }
    assert.equal(missing, 0, missing + ' true heavy hitter(s) missing from the reported superset');
    // NOT asserting hh equals the exact heavy-hitter set: false positives are allowed by design.
});

test('heavyHitters is sorted DESCENDING by count', () => {
    const ss = new SpaceSaving(10, { seed: 2 });
    for (let i = 0; i < 10; i++) ss.add(i, (i + 1) * 7);
    const hh = ss.heavyHitters(0);
    for (let i = 0; i + 1 < hh.length; i++) assert.ok(hh[i].count >= hh[i + 1].count);
});

// ===========================================================================
// 7. MERGE
// ===========================================================================

test('MERGE: split a Zipfian stream across two same-(capacity,seed) shards; the merged summary ' +
    'has NO false negatives for true hitters > N/k over the WHOLE stream', () => {
    const k = 100, seed = 0x1234;
    const a = new SpaceSaving(k, { seed });
    const b = new SpaceSaving(k, { seed });
    const rng = makeRng(0xAAAA);
    const zipf = makeZipf(2000, 1.1, rng);
    const truth = new Map();
    const N = 1000000;
    for (let i = 0; i < N; i++) {
        const key = zipf();
        truth.set(key, (truth.get(key) || 0) + 1);
        (i % 2 === 0 ? a : b).add(key);
    }
    assert.equal(a.merge(b), a);
    assert.equal(a.total, N, 'merged total must equal N_whole exactly');
    const cutoff = N / k;
    const trueHitters = [];
    for (const [key, trueCount] of truth) if (trueCount > cutoff) trueHitters.push(key);
    assert.ok(trueHitters.length > 0);
    let misses = 0;
    for (const key of trueHitters) if (!(a.estimate(key) > 0)) misses++;
    assert.equal(misses, 0, misses + ' true hitter(s) missed after merge');
});

test('MERGE: the bracket count-error <= true <= count holds on the MERGED result ' +
    '(re-run over the WHOLE stream, not each shard)', () => {
    const k = 100, seed = 0x1234;
    const a = new SpaceSaving(k, { seed });
    const b = new SpaceSaving(k, { seed });
    const rng = makeRng(0xBBBB);
    const zipf = makeZipf(2000, 1.1, rng);
    const truth = new Map();
    const N = 1000000;
    for (let i = 0; i < N; i++) {
        const key = zipf();
        truth.set(key, (truth.get(key) || 0) + 1);
        (i % 2 === 0 ? a : b).add(key);
    }
    a.merge(b);
    let violations = 0;
    let checked = 0;
    a.forEach((key, count, error) => {
        checked++;
        const trueCount = truth.get(key) || 0;
        if (!(count - error <= trueCount && trueCount <= count)) {
            violations++;
            console.error('  merged bracket violation key=' + key + ' count=' + count + ' error=' + error +
                ' true=' + trueCount);
        }
    });
    assert.ok(checked > 0);
    assert.equal(violations, 0, violations + ' / ' + checked + ' merged key(s) violated the bracket');
});

test('merge fails closed on a non-SpaceSaving [lite-sketch], byte-identical no-op', () => {
    const a = new SpaceSaving(8, { seed: 1 });
    a.add(5, 3);
    for (const bad of [null, undefined, {}, 5, 'x', { _capacity: 8, _seed: 1 }]) {
        const beforeTotal = a.total, beforeSize = a.size;
        assert.throws(() => a.merge(bad), liteSketch, String(bad));
        assert.equal(a.total, beforeTotal);
        assert.equal(a.size, beforeSize);
        assert.equal(a.estimate(5), 3);
    }
});

test('merge fails closed on a capacity mismatch [lite-sketch], byte-identical no-op', () => {
    const a = new SpaceSaving(8, { seed: 1 });
    a.add(5, 3);
    const beforeTotal = a.total, beforeSize = a.size;
    assert.throws(() => a.merge(new SpaceSaving(9, { seed: 1 })), liteSketch);
    assert.equal(a.total, beforeTotal);
    assert.equal(a.size, beforeSize);
    assert.equal(a.estimate(5), 3);
});

test('merge fails closed on a seed mismatch [lite-sketch], byte-identical no-op', () => {
    const a = new SpaceSaving(8, { seed: 1 });
    a.add(5, 3);
    const beforeTotal = a.total, beforeSize = a.size;
    assert.throws(() => a.merge(new SpaceSaving(8, { seed: 2 })), liteSketch);
    assert.equal(a.total, beforeTotal);
    assert.equal(a.size, beforeSize);
    assert.equal(a.estimate(5), 3);
});

// ===========================================================================
// 8. ZERO IS A LEGAL KEY
// ===========================================================================

test('ZERO IS A LEGAL KEY: add(0) repeatedly tracks it like any other key', () => {
    const ss = new SpaceSaving(8, { seed: 1 });
    ss.add(0);
    ss.add(0);
    ss.add(0, 5);
    assert.equal(ss.estimate(0), 7);
    assert.equal(ss.errorOf(0), 0);
    assert.equal(ss.size, 1);
});

test('ZERO round-trips through eviction: filling past capacity with 0 as a hot key keeps 0 monitored', () => {
    const k = 16;
    const ss = new SpaceSaving(k, { seed: 3 });
    ss.add(0, 1000); // 0 is hot from the start
    for (let i = 1; i < k * 50; i++) ss.add(i, 1); // flood with cold distinct keys
    assert.ok(ss.estimate(0) >= 1000, '0 must survive the eviction flood, got ' + ss.estimate(0));
    assert.equal(ss.size, k);
});

// ===========================================================================
// 9. FAIL-CLOSED no-op matrix
// ===========================================================================

function snapshot(s) {
    return { size: s.size, total: s.total, capacity: s.capacity };
}
function assertUnchanged(before, s, label) {
    const after = snapshot(s);
    for (const key of Object.keys(before)) {
        assert.equal(after[key], before[key], label + ': ' + key + ' changed (' + before[key] + ' -> ' + after[key] + ')');
    }
}

test('add() rejects a bad key [lite-sketch]: NaN, Infinity, -Infinity, 1.5, 2^53+1, string, ' +
    'Symbol, BigInt, null, undefined -- byte-identical no-op', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    s.add(5); // seed real state so "unchanged" is non-trivial
    const badKeys = [
        NaN, Infinity, -Infinity, 1.5, 2 ** 53 + 1, '5', Symbol('x'), 5n, null, undefined, {}, [],
    ];
    for (const key of badKeys) {
        const before = snapshot(s);
        assert.throws(() => s.add(key), liteSketch, 'key=' + String(key));
        assertUnchanged(before, s, 'key=' + String(key));
    }
});

test('add() accepts the safe-integer boundary 2^53-1 (and its negative) but rejects 2^53', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    assert.doesNotThrow(() => s.add(Number.MAX_SAFE_INTEGER));
    assert.doesNotThrow(() => s.add(-Number.MAX_SAFE_INTEGER));
    assert.equal(s.estimate(Number.MAX_SAFE_INTEGER), 1);
    const before = snapshot(s);
    assert.throws(() => s.add(2 ** 53), liteSketch);
    assertUnchanged(before, s, '2^53');
});

test('add() rejects a bad count [lite-sketch]: 0, -1, 1.5, NaN -- byte-identical no-op', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    s.add(5);
    // NOTE: `undefined` is NOT a bad count -- `add(key, count = 1)` has a default parameter,
    // so `add(5, undefined)` means count=1 (a valid no-op-safe add), it does not throw.
    const badCounts = [0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, {}];
    for (const count of badCounts) {
        const before = snapshot(s);
        assert.throws(() => s.add(5, count), liteSketch, 'count=' + String(count));
        assertUnchanged(before, s, 'count=' + String(count));
    }
    // and the default-parameter path is explicitly valid:
    assert.doesNotThrow(() => s.add(5, undefined));
});

test('ctor rejects a bad capacity [lite-sketch]: 0, 1.5, 2^24+1, NaN, string', () => {
    for (const capacity of [0, 1.5, (1 << 24) + 1, NaN, '8', -1, Infinity, null, undefined, {}]) {
        assert.throws(() => new SpaceSaving(capacity), liteSketch, 'capacity=' + String(capacity));
    }
});

test('ctor accepts capacity at the boundaries 1, N-1 (2^24-1), and N (2^24)', () => {
    assert.doesNotThrow(() => new SpaceSaving(1));
    // 2^24-1 / 2^24 are cheap to CONSTRUCT (typed arrays are lazily-committed, zero-fill is
    // O(k) but fast) -- we only check the ctor door + getters here, never touch/add at this
    // scale (that would commit ~1.4 GB of pages and is a memory-safety hazard in CI).
    const nMinus1 = new SpaceSaving((1 << 24) - 1);
    assert.equal(nMinus1.capacity, (1 << 24) - 1);
    const nCap = new SpaceSaving(1 << 24);
    assert.equal(nCap.capacity, 1 << 24);
});

test('ctor rejects an unknown option key [lite-sketch] with a did-you-mean listing', () => {
    assert.throws(() => new SpaceSaving(8, { seeed: 1 }), (e) => {
        return liteSketch(e) && /known options|unknown option/.test(e.message);
    });
});

test('ctor rejects a bad seed [lite-sketch]: 1.5, NaN, string, Symbol, BigInt', () => {
    for (const seed of [1.5, NaN, '1', Symbol('x'), 5n, Infinity, {}]) {
        assert.throws(() => new SpaceSaving(8, { seed }), liteSketch, 'seed=' + String(seed));
    }
});

test('ctor rejects non-object / array options [lite-sketch]', () => {
    for (const options of [5, 'x', [1, 2]]) {
        assert.throws(() => new SpaceSaving(8, options), liteSketch, 'options=' + String(options));
    }
});

test('ctor leaves NO half-built instance on a bad capacity (throws at the door)', () => {
    let inst;
    try { inst = new SpaceSaving(-1); } catch (e) { assert.ok(liteSketch(e)); }
    assert.equal(inst, undefined);
});

test('withError rejects a bad epsilon [lite-sketch]: 0, 1, -0.1, NaN', () => {
    for (const epsilon of [0, 1, -0.1, NaN, Infinity, -Infinity, '0.01']) {
        assert.throws(() => SpaceSaving.withError(epsilon), liteSketch, 'epsilon=' + String(epsilon));
    }
});

test('estimate/errorOf/topK/heavyHitters/forEach/getters NEVER throw: a bad key returns 0', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    s.add(5, 3);
    const badKeys = [NaN, Infinity, -Infinity, '1', Symbol('x'), 5n, null, undefined, {}, [], -0, 0];
    for (const key of badKeys) {
        assert.doesNotThrow(() => s.estimate(key), 'estimate key=' + String(key));
        assert.doesNotThrow(() => s.errorOf(key), 'errorOf key=' + String(key));
    }
    assert.equal(s.estimate(NaN), 0);
    assert.equal(s.estimate(Infinity), 0);
    assert.equal(s.errorOf(NaN), 0);
    assert.equal(s.errorOf('1'), 0);
    assert.doesNotThrow(() => s.topK(-5));
    assert.doesNotThrow(() => s.topK(NaN));
    assert.doesNotThrow(() => s.topK('x'));
    assert.doesNotThrow(() => s.heavyHitters(-1));
    assert.doesNotThrow(() => s.heavyHitters(NaN));
    assert.deepEqual(s.heavyHitters(-1), []);
    assert.deepEqual(s.heavyHitters(NaN), []);
    assert.doesNotThrow(() => s.forEach(() => {}));
    assert.doesNotThrow(() => s.capacity);
    assert.doesNotThrow(() => s.size);
    assert.doesNotThrow(() => s.total);
    assert.doesNotThrow(() => s.epsilon);
    assert.doesNotThrow(() => s.seed);
});

test('there is NO addHashed method on SpaceSaving (intentionally removed: it stores identities)', () => {
    const s = new SpaceSaving(8);
    assert.equal(typeof s.addHashed, 'undefined');
});

// ===========================================================================
// 10. CTOR + withError + getters
// ===========================================================================

test('ctor getters: capacity/epsilon are correct; withError derives k=ceil(1/epsilon)', () => {
    const s = new SpaceSaving(8);
    assert.equal(s.capacity, 8);
    assert.equal(s.epsilon, 1 / 8);
    const w = SpaceSaving.withError(0.01);
    assert.equal(w.capacity, 100);
    assert.equal(w.epsilon, 0.01);
});

test('withError clamps k to SS_CAP_MAX (2^24) for a tiny epsilon', () => {
    const w = SpaceSaving.withError(1e-9);
    assert.equal(w.capacity, 1 << 24);
});

test('size grows to capacity then stops; total tracks summed counts (incl. count>1 adds)', () => {
    const s = new SpaceSaving(4, { seed: 1 });
    assert.equal(s.size, 0);
    s.add(1); assert.equal(s.size, 1);
    s.add(2); assert.equal(s.size, 2);
    s.add(3, 5); assert.equal(s.size, 3);
    s.add(4, 2); assert.equal(s.size, 4);
    s.add(5); // capacity reached -> eviction, not growth
    assert.equal(s.size, 4);
    assert.equal(s.total, 1 + 1 + 5 + 2 + 1);
});

test('clear() resets size/total to 0 and drops all monitored keys', () => {
    const s = new SpaceSaving(4, { seed: 1 });
    s.add(1); s.add(2); s.add(3, 5);
    assert.ok(s.size > 0 && s.total > 0);
    assert.equal(s.clear(), s);
    assert.equal(s.size, 0);
    assert.equal(s.total, 0);
    for (const k of [1, 2, 3]) assert.equal(s.estimate(k), 0);
});

// --- boundary matrix: 0, 1, empty, duplicate dispose, dispose-during-iteration, re-entrant ---

test('boundary: an empty sketch (no adds) estimates 0 for every key, size 0, total 0, ' +
    'topK()===[], heavyHitters(any)===[]', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    assert.equal(s.size, 0);
    assert.equal(s.total, 0);
    for (const key of [0, 1, -1, 99999]) assert.equal(s.estimate(key), 0);
    assert.deepEqual(s.topK(), []);
    assert.deepEqual(s.topK(5), []);
    assert.deepEqual(s.heavyHitters(0), []);
});

test('boundary: capacity=1 (the minimal summary) tracks exactly one key at a time, evicting on every new key', () => {
    const s = new SpaceSaving(1, { seed: 1 });
    s.add(1, 10);
    assert.equal(s.size, 1);
    assert.equal(s.estimate(1), 10);
    s.add(2, 1); // evicts 1 (the only, thus min, holder)
    assert.equal(s.size, 1);
    assert.equal(s.estimate(1), 0);
    assert.equal(s.estimate(2), 11); // min(10) + count(1)
    assert.equal(s.errorOf(2), 10);
});

test('boundary: key -0 behaves identically to key 0 (the sign bit never splits the slot)', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    s.add(-0, 3);
    assert.equal(s.estimate(0), 3);
    assert.equal(s.estimate(-0), 3);
    s.add(0, 2);
    assert.equal(s.estimate(0), 5);
    assert.equal(s.size, 1); // -0 and 0 are the SAME monitored slot
});

test('duplicate clear() is idempotent and a byte-identical no-op the second time', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    s.add(1); s.add(2); s.add(3);
    s.clear();
    assert.equal(s.size, 0);
    assert.equal(s.total, 0);
    assert.doesNotThrow(() => s.clear());
    assert.equal(s.size, 0);
    assert.equal(s.total, 0);
    // clear() is usable again afterward -- no residual half-cleared internal state.
    s.add(9, 4);
    assert.equal(s.estimate(9), 4);
});

test('dispose-during-iteration: clear() called mid-forEach leaves no partial state', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    for (let i = 0; i < 8; i++) s.add(i, 1);
    let seen = 0;
    assert.doesNotThrow(() => {
        s.forEach((key, count, error, ss) => {
            seen++;
            if (seen === 3) ss.clear(); // reset mid-iteration
        });
    });
    assert.equal(seen, 8, 'forEach iterates the size captured at call start, not re-checked per-step');
    assert.equal(s.size, 0);
    assert.equal(s.total, 0);
    for (let i = 0; i < 8; i++) assert.equal(s.estimate(i), 0);
});

test('re-entrant write: add() called from inside a forEach callback does not corrupt state', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    for (let i = 0; i < 8; i++) s.add(i, 1);
    let reentrant = 0;
    let seen = 0;
    assert.doesNotThrow(() => {
        s.forEach((key, count, error, ss) => {
            seen++;
            if (reentrant < 2) { reentrant++; ss.add(1000 + reentrant, 1); } // re-entrant write mid-callback
        });
    });
    assert.equal(seen, 8);
    assert.equal(s.size, 8, 'capacity must be respected even under re-entrant writes');
    assert.equal(s.total, 8 + 2);
});

test('re-entrant write: add() invoked recursively from within its own call stack via a wrapper', () => {
    const s = new SpaceSaving(32, { seed: 1 });
    let calls = 0;
    function recur(n) {
        calls++;
        s.add(n + 1, 1);
        if (n > 0) recur(n - 1);
    }
    recur(20);
    assert.equal(calls, 21);
    assert.equal(s.total, 21);
    assert.equal(s.size, 21);
});

// ===========================================================================
// ADVERSARIAL: an entry point the planner did not think of
// ===========================================================================

test('ADVERSARIAL: self-merge (ss.merge(ss)) doubles every monitored count/error and the ' +
    'running total, while size stays === capacity (the union-with-self case)', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    for (let i = 0; i < 20; i++) s.add(i % 10, 1); // fill + force some eviction/bracket state
    const before = [];
    s.forEach((key, count, error) => before.push({ key, count, error }));
    const totalBefore = s.total;
    const sizeBefore = s.size;
    assert.equal(s.merge(s), s);
    assert.equal(s.size, sizeBefore, 'self-merge must not change size');
    assert.equal(s.total, totalBefore * 2, 'self-merge must double the total');
    const beforeMap = new Map(before.map((e) => [e.key, e]));
    let checked = 0;
    s.forEach((key, count, error) => {
        const b = beforeMap.get(key);
        assert.ok(b, 'self-merge must not introduce a new key: ' + key);
        assert.equal(count, b.count * 2, 'key=' + key + ' count must double');
        assert.equal(error, b.error * 2, 'key=' + key + ' error must double');
        checked++;
    });
    assert.equal(checked, sizeBefore);
});

test('ADVERSARIAL: a key exactly at the safe-integer ceiling used as BOTH a positive and its ' +
    'negation stays distinguishable (no sign-collision through the hash split)', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    const big = Number.MAX_SAFE_INTEGER;
    s.add(big, 3);
    s.add(-big, 5);
    assert.equal(s.estimate(big), 3);
    assert.equal(s.estimate(-big), 5);
    assert.equal(s.size, 2);
});
