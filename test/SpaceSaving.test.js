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
import { SpaceSaving, mix64, hashHi, VERSION } from '../Sketch.js';

void VERSION; // VERSION-pin is asserted once, centrally, by the other suites; not duplicated here.

const liteSketch = (e) => e instanceof Error && /^\[lite-sketch]/.test(e.message);

// Cold test helper: the adjacent double below x, via a bit view (probe the exact edges).
function nextDown(x) {
    const f = new Float64Array([x]);
    const u = new BigUint64Array(f.buffer);
    u[0] -= 1n;
    return f[0];
}

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
    const badCounts = [0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, {},
        2 ** 32, 1e308, Number.MAX_SAFE_INTEGER];   // F15: count > 2^32-1 throws
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

test('withError rejects an unattainable epsilon (F16/S6); accepts the exact 2^-24 boundary', () => {
    // double-rounding preconditions: the boundary accepts at exactly 2^24, the N+1 needs 2^24+1.
    assert.equal(Math.ceil(1 / (2 ** -24)), 2 ** 24);
    assert.equal(Math.ceil(1 / nextDown(2 ** -24)), 2 ** 24 + 1);
    // rejects match the FACTORY's "capacity cap 16777216" wording (NOT the bare number, which the
    // ctor message "capacity must be an integer in [1, 16777216]" also contains), so a `k > SS_CAP_MAX + 1`
    // mutant that merely falls through to the ctor dies.
    const capMsg = (e) => liteSketch(e) && /capacity cap 16777216/.test(e.message);
    assert.throws(() => SpaceSaving.withError(1e-9), capMsg);                    // needs k > 2^24
    assert.throws(() => SpaceSaving.withError(5e-324), capMsg);                  // Infinity k
    assert.throws(() => SpaceSaving.withError(nextDown(2 ** -24)), capMsg);      // k === 2^24+1
    assert.equal(SpaceSaving.withError(2 ** -24).capacity, 1 << 24);            // exact boundary accepted
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
    // Extended beyond +-big: a sign-split key and its 2^32-shifted twin stay distinct too.
    const t = new SpaceSaving(16, { seed: 1 });
    const cases = [[-1, 11], [2 ** 32 + 1, 13], [-(2 ** 32 + 1), 17], [2 ** 40 + 7, 19], [-(2 ** 40 + 7), 23], [0, 29]];
    for (const [k, c] of cases) t.add(k, c);
    for (const [k, c] of cases) assert.equal(t.estimate(k), c, 'key ' + k + ' stays distinct at count ' + c);
    assert.equal(t.size, cases.length, 'every sign-split / shifted key is its own slot');
});

// ===========================================================================
// H2.3 gates (F15 count cap + total ceiling, F20 no-user-code throwers)
// ===========================================================================

const SS_MAX_SAFE = 9007199254740991;   // 2^53 - 1
// Fill the running total of a single monitored key to `target` via 2^32-1-capped adds.
function fillTotal(s, key, target) {
    const step = 4294967295;
    const n = Math.floor(target / step);
    for (let i = 0; i < n; i++) s.add(key, step);
    const rem = target - n * step;
    if (rem > 0) s.add(key, rem);
    assert.equal(s.total, target, 'fillTotal target');
}
function ssSnap(s) {
    return { size: s.size, total: s.total, key: Array.from(s._key), count: Array.from(s._count),
             error: Array.from(s._error) };
}
function ssUnchanged(before, s, label) {
    const a = ssSnap(s);
    assert.equal(a.size, before.size, label + ': size');
    assert.equal(a.total, before.total, label + ': total');
    assert.deepEqual(a.key, before.key, label + ': _key');
    assert.deepEqual(a.count, before.count, label + ': _count');
    assert.deepEqual(a.error, before.error, label + ': _error');
}

test('G-F15 (SS): count cap 2^32-1 + running-total ceiling 2^53-1, byte-identical reject', () => {
    const s = new SpaceSaving(8, { seed: 1 });
    assert.doesNotThrow(() => s.add(5, 4294967295));
    for (const bad of [2 ** 32, 1e308, SS_MAX_SAFE]) {
        const before = ssSnap(s);
        assert.throws(() => s.add(5, bad), (e) => liteSketch(e) && /\[1, 4294967295]/.test(e.message), 'count=' + bad);
        ssUnchanged(before, s, 'count=' + bad);
    }
    // insert + bump: a capacity-3 sketch filled to 2^53-1 on key 1 (slots still free).
    const a = new SpaceSaving(3, { seed: 1 });
    fillTotal(a, 1, SS_MAX_SAFE);
    for (const [fn, label] of [[() => a.add(1, 1), 'bump'], [() => a.add(2, 1), 'insert']]) {
        const before = ssSnap(a);
        assert.throws(fn, (e) => liteSketch(e) && /9007199254740991/.test(e.message), label);
        ssUnchanged(before, a, label);
    }
    // evict: a capacity-1 sketch filled to 2^53-1 (full), a new key would evict.
    const b = new SpaceSaving(1, { seed: 1 });
    fillTotal(b, 1, SS_MAX_SAFE);
    const beforeE = ssSnap(b);
    assert.throws(() => b.add(99, 1), (e) => liteSketch(e) && /9007199254740991/.test(e.message), 'evict');
    ssUnchanged(beforeE, b, 'evict');
});

test('G-F15 (SS): merge at total 2^53-6 rejects an other of 6, accepts an other of 5', () => {
    const base = new SpaceSaving(4, { seed: 1 });
    fillTotal(base, 1, SS_MAX_SAFE - 5);
    const other6 = new SpaceSaving(4, { seed: 1 }); other6.add(2, 6);
    const b6 = ssSnap(base);
    assert.throws(() => base.merge(other6), (e) => liteSketch(e) && /9007199254740991/.test(e.message));
    ssUnchanged(b6, base, 'merge total+1 reject');
    const other5 = new SpaceSaving(4, { seed: 1 }); other5.add(2, 5);
    assert.doesNotThrow(() => base.merge(other5));
    assert.equal(base.total, SS_MAX_SAFE);
});

test('G-F20 (SS): a rejected arg never runs caller code (tagged, calls===0, byte-identical)', () => {
    let calls = 0;
    let sRef;
    const H = () => ({ [Symbol.toPrimitive]() { calls++; if (sRef) sRef.add(1); return 1; },
                       toString() { calls++; if (sRef) sRef.add(1); return 'x'; },
                       valueOf() { calls++; if (sRef) sRef.add(1); return 1; } });
    const hostile = () => [Object.create(null), { toString() { calls++; throw new Error('boom'); } }, H(),
        Object.assign(function () {}, { toString() { calls++; return 'f'; } })];
    for (const h of hostile()) assert.throws(() => new SpaceSaving(h), liteSketch);
    for (const h of hostile()) assert.throws(() => new SpaceSaving(8, { seed: h }), liteSketch);
    for (const h of hostile()) assert.throws(() => SpaceSaving.withError(h), liteSketch);
    sRef = new SpaceSaving(8, { seed: 1 }); sRef.add(3);
    for (const h of hostile()) { const b = ssSnap(sRef); assert.throws(() => sRef.add(h), liteSketch); ssUnchanged(b, sRef, 'add key'); }
    for (const h of hostile()) { const b = ssSnap(sRef); assert.throws(() => sRef.add(3, h), liteSketch); ssUnchanged(b, sRef, 'add count'); }
    assert.equal(calls, 0, 'no hostile toString/valueOf/toPrimitive ran');
    let msg = '';
    try { new SpaceSaving(Object.create(null)); } catch (e) { msg = e.message; }
    assert.ok(/got \[object]$/.test(msg), 'null-proto message: ' + msg);
});

// QA H2.3 boundary gap: self-merge (this === other) at the total ceiling, and the _badTotal
// message is a RangeError printing the current total and the rejected n.
test('QA H2.3 (SS): self-merge at the total ceiling; _badTotal prints current total + n', () => {
    const s = new SpaceSaving(4, { seed: 1 });
    fillTotal(s, 1, 2 ** 52 - 1);
    assert.equal(s.merge(s).total, 2 ** 53 - 2);
    const b = ssSnap(s);
    assert.throws(() => s.merge(s), (e) => e instanceof RangeError && liteSketch(e) &&
        e.message.includes('current total ' + (2 ** 53 - 2) + ' + ' + (2 ** 53 - 2)));
    ssUnchanged(b, s, 'self-merge total+1 reject');
    assert.throws(() => s.add(1, 2), (e) => e instanceof RangeError &&
        e.message.includes('current total ' + (2 ** 53 - 2) + ' + 2'));
    ssUnchanged(b, s, 'add total+1 reject');
});

// ===========================================================================
// G-F12 (SS hash sign bit): the map home function separates -k from its 2^32-twin.
// FAILs on HEAD (where _hash collided and every pair shared a home slot).
// ===========================================================================

test('G-F12 (SS): _hash separates (-(H*2^32+L), (H^1)*2^32+L) on all 1e4 pairs (HEAD: all equal)', () => {
    const s = new SpaceSaving(1024, { seed: 7 });
    const N = 10000;
    let diffs = 0, shared = 0;
    for (let i = 0; i < N; i++) {
        const H = (i % 1000) + 1;
        const L = (i * 2654435761) >>> 0;
        const k1 = -(H * 4294967296 + L);
        const k2 = (H ^ 1) * 4294967296 + L;
        if ((s._hash(k1) | 0) !== (s._hash(k2) | 0)) diffs++;
        if ((s._hash(k1) & s._mask) === (s._hash(k2) & s._mask)) shared++;
    }
    assert.equal(diffs, N, 'every pair must hash distinctly (HEAD: 0 -- all collide)');
    assert.ok(shared / N < 0.01, 'home-slot share must be < 1% (HEAD 100%), got ' + (100 * shared / N).toFixed(3) + '%');
});

test('G-F12 (SS site consistency): _hash(k) === (mix64(k, seed), hashHi() | 0) over mixed-sign keys', () => {
    // Passes on HEAD too -- proves the map home uses the SAME HI lane as mix64.
    const s = new SpaceSaving(64, { seed: 7 });
    let d = 0;
    for (const k of [-5, 2 ** 40 + 3, 7, -1, 2 ** 32 + 1, -(2 ** 33), -(2 ** 53 - 1), -(2 ** 32), 0, -0]) {
        mix64(k, s.seed);
        if (s._hash(k) !== (hashHi() | 0)) d++;
    }
    assert.equal(d, 0, 'SS _hash must equal mix64 HI lane for every key');
});

test('G-F12 (SS): add(-1); add(2**32+1) -- both estimate 1, homes differ, probe distance 0 (HEAD 1)', () => {
    const s = new SpaceSaving(1024, { seed: 7 });
    s.add(-1);
    s.add(2 ** 32 + 1);
    assert.equal(s.estimate(-1), 1);
    assert.equal(s.estimate(2 ** 32 + 1), 1);
    const mask = s._mask;
    const h1 = s._hash(-1), h2 = s._hash(2 ** 32 + 1);
    assert.notEqual(h1 & mask, h2 & mask, 'the two home slots must differ (HEAD: identical)');
    const idx = s._probe(2 ** 32 + 1, h2);
    assert.equal((idx - (h2 & mask)) & mask, 0, '2**32+1 lands on its own home (HEAD: pushed to distance 1)');
});

test('QA H2.4 (SS site consistency, boundary matrix): the add() inline hash and _hash agree -- ' +
    'every added key is found from its _hash home and estimates its exact count', () => {
    // Gap: the site test above checks _hash only; add() carries its OWN inline murmur, so a
    // drift between the two sites (add homes a key where estimate/_hash never probes) was
    // only indirectly covered. Capacity 64 > keys, so every count is exact.
    const KS = [0, 1, -1, -(2 ** 31 - 1), -(2 ** 31), -(2 ** 31) - 1, -(2 ** 32 - 1), -(2 ** 32),
        -(2 ** 32 + 1), 2 ** 31, 2 ** 32 - 1, -(2 ** 40 + 104729), -(2 ** 52), -(2 ** 53 - 2),
        -(2 ** 53 - 1), 2 ** 53 - 1, -((2 ** 21 - 1) * 4294967296)];
    const s = new SpaceSaving(64, { seed: 7 });
    let n = 0;
    for (const k of KS) s.add(k, ++n);
    s.add(-0, 100);                       // -0 is the SAME key as 0
    assert.equal(s.size, KS.length);
    let bad = '';
    n = 0;
    for (const k of KS) {
        n++;
        const want = k === 0 ? n + 100 : n;
        mix64(k, s.seed);
        const h = s._hash(k);
        if (h !== (hashHi() | 0)) bad += 'hash:' + k + ' ';
        const i = s._probe(k, h);
        if (s._mapOcc[i] !== 1) bad += 'home:' + k + ' ';
        if (s.estimate(k) !== want) bad += 'est:' + k + '=' + s.estimate(k) + ' ';
    }
    assert.equal(bad, '', 'site drift: ' + bad);
});

// ===========================================================================================
// H2.5 F3 -- argument-free SpaceSaving (inlined bump, _attach reads _count, _homeAt/_probeAt).
// Parity-type: the first two pass on HEAD too (behavior is byte-identical); the FAIL-on-HEAD
// teeth are test/lanes.mjs. The identity test is NEW-CODE ONLY (_homeAt/_probeAt do not exist
// on HEAD). The boundary matrix mirrors the :867 site-consistency set.
// ===========================================================================================
const H25_KS = [0, 1, -1, -(2 ** 31 - 1), -(2 ** 31), -(2 ** 31) - 1, -(2 ** 32 - 1), -(2 ** 32),
    -(2 ** 32 + 1), 2 ** 31, 2 ** 32 - 1, -(2 ** 40 + 104729), -(2 ** 52), -(2 ** 53 - 2),
    -(2 ** 53 - 1), 2 ** 53 - 1, -((2 ** 21 - 1) * 4294967296)];

// A mixed-sign, safe-integer key pool: the boundary matrix + a deterministic LCG spread, enough
// distinct keys (> capacity) to force continuous eviction + backshift at both capacities.
const H25_POOL = (() => {
    const pool = [...H25_KS];
    let x = 123456789;
    for (let i = 0; i < 300; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        pool.push((i & 1) ? -(x + (i & 7)) : (x + (i & 7)));
    }
    return pool;
})();

test('H2.5 F3 (SS evict/backshift vs an exact Map): invariants hold after EVERY op over 20k ' +
    'mixed-sign adds, counts {1, 2^30, 2^31+, 2^32-1}, capacity 7 and 64', () => {
    for (const cap of [7, 64]) {
        const s = new SpaceSaving(cap, { seed: 7 });
        const truth = new Map();
        let trueTotal = 0;
        for (let op = 0; op < 20000; op++) {
            const key = H25_POOL[(op * 7919) % H25_POOL.length];
            const count = [1, 2 ** 30, 2 ** 31 + (op & 7), 2 ** 32 - 1][op & 3];
            s.add(key, count);
            truth.set(key, (truth.get(key) || 0) + count);
            trueTotal += count;

            // (a) _mapOcc population === size -- also the SPIN WATCHDOG: a broken hash corrupts
            // the map so this diverges (and the array walk, unlike _probe, cannot spin).
            let occ = 0;
            for (let i = 0; i < s._mapOcc.length; i++) occ += s._mapOcc[i];
            assert.equal(occ, s.size, 'cap ' + cap + ' op ' + op + ': _mapOcc pop != size');

            // (b) every slot is found via _probe(key, _hash(key)); (c) bucket value == _count[sl].
            for (let sl = 0; sl < s.size; sl++) {
                const k = s._key[sl];
                const idx = s._probe(k, s._hash(k));
                assert.equal(s._mapOcc[idx], 1, 'cap ' + cap + ' op ' + op + ': slot ' + sl + ' not found');
                assert.equal(s._mapSlot[idx], sl, 'cap ' + cap + ' op ' + op + ': wrong slot mapping');
                assert.equal(s._bVal[s._cBucket[sl]], s._count[sl], 'cap ' + cap + ' op ' + op + ': bucket value drift');
            }

            // (c cont.) buckets ascend from _minBucket; siblings cover exactly `size` slots.
            let b = s._minBucket, prev = -Infinity, seen = 0;
            while (b >= 0) {
                assert.ok(s._bVal[b] > prev, 'cap ' + cap + ' op ' + op + ': buckets not ascending');
                prev = s._bVal[b];
                for (let sl = s._bHead[b]; sl >= 0; sl = s._cNext[sl]) {
                    assert.equal(s._cBucket[sl], b);
                    assert.equal(s._count[sl], s._bVal[b]);
                    seen++;
                }
                b = s._bNext[b];
            }
            assert.equal(seen, s.size, 'cap ' + cap + ' op ' + op + ': bucket forest lost a slot');

            // (d) total is exact; (e) the SpaceSaving bracket est - err <= true <= est.
            assert.equal(s.total, trueTotal, 'cap ' + cap + ' op ' + op + ': total drift');
            for (let sl = 0; sl < s.size; sl++) {
                const k = s._key[sl];
                const est = s.estimate(k), err = s.errorOf(k), tru = truth.get(k);
                assert.ok(est - err <= tru && tru <= est,
                    'cap ' + cap + ' op ' + op + ': bracket broke for ' + k + ' (' + (est - err) + ' <= ' + tru + ' <= ' + est + ')');
            }
        }
    }
});

test('H2.5 F3 (SS _attach ordering, pinned from HEAD): capacity 3, three equal 2^31 counts, ' +
    'a 4th key (eviction) then a bump -- the evicted key and topK/error literals are HEAD-exact', () => {
    const s = new SpaceSaving(3, { seed: 7 });
    s.add(10, 2 ** 31);
    s.add(20, 2 ** 31);
    s.add(30, 2 ** 31);
    s.add(40, 5);   // FULL -> evict the head of the min bucket (key 30, pinned from HEAD)
    s.add(40, 7);   // bump the newcomer
    // Literals cut from `git show HEAD:Sketch.js` BEFORE the edit (byte-identical behavior).
    assert.equal(s.size, 3);
    assert.equal(s.total, 6442450956);               // 3*2^31 + 5 + 7
    assert.equal(s.estimate(30), 0, 'key 30 was the evicted head of the min bucket');
    assert.equal(s.estimate(10), 2147483648);
    assert.equal(s.estimate(20), 2147483648);
    assert.equal(s.estimate(40), 2147483660);        // 5 + 7 bumped onto inherited min 2^31
    assert.equal(s.errorOf(40), 2147483648);         // inherited the evicted min (2^31)
    assert.equal(s.errorOf(10), 0);
    assert.deepEqual(s.topK(), [
        { key: 40, count: 2147483660, error: 2147483648 },
        { key: 10, count: 2147483648, error: 0 },
        { key: 20, count: 2147483648, error: 0 },
    ]);
});

test('H2.5 F3 (SS _homeAt/_probeAt identity, NEW-CODE ONLY): for every slot ' +
    '_homeAt(_key, sl) === (_hash(_key[sl]) & _mask) and _probeAt maps back to sl', () => {
    const s = new SpaceSaving(64, { seed: 7 });
    let n = 0;
    for (const k of H25_KS) s.add(k, ++n);
    s.add(-0, 100);
    assert.equal(s.size, H25_KS.length);
    let bad = '';
    for (let sl = 0; sl < s.size; sl++) {
        const k = s._key[sl];
        const home = s._homeAt(s._key, sl);
        if (home !== (s._hash(k) & s._mask)) bad += 'home:' + k + ' ';
        const idx = s._probeAt(s._key, sl, home);
        if (idx !== s._probe(k, s._hash(k))) bad += 'probeAt:' + k + ' ';
        if (s._mapSlot[idx] !== sl) bad += 'slot:' + k + ' ';
    }
    assert.equal(bad, '', 'home/probe identity drift: ' + bad);
});

// ===========================================================================================
// QA H2.5 -- boundary tests a mis-port of the inlined bump / _homeAt / _probeAt / _attach-reads-
// _count would fail. All but the last pass on HEAD too (parity-type); the last is NEW-CODE ONLY.
// ===========================================================================================
// Per-op SPIN WATCHDOG: add, then require _mapOcc population === size. A corrupted home / backshift
// leaks occupied map entries; this FAILs on the first leaked op, long before the load-0.5 table can
// fill and spin a probe loop (a synchronous spin cannot be stopped by --test-timeout).
function qa25Add(s, k, c) {
    s.add(k, c);
    let n = 0;
    for (let j = 0; j < s._mapOcc.length; j++) n += s._mapOcc[j];
    assert.equal(n, s.size, 'watchdog: _mapOcc population ' + n + ' != size ' + s.size + ' after add(' + k + ')');
}
// FULL observable + internal pool snapshot (map, bucket forest, free-list, scalars).
function qa25Pool(s) {
    return {
        size: s.size, total: s.total, minBucket: s._minBucket, bFreeTop: s._bFreeTop,
        key: Array.from(s._key), count: Array.from(s._count), error: Array.from(s._error),
        cNext: Array.from(s._cNext), cPrev: Array.from(s._cPrev), cBucket: Array.from(s._cBucket),
        bVal: Array.from(s._bVal), bNext: Array.from(s._bNext), bPrev: Array.from(s._bPrev),
        bHead: Array.from(s._bHead), bFree: Array.from(s._bFree),
        mapOcc: Array.from(s._mapOcc), mapKey: Array.from(s._mapKey), mapSlot: Array.from(s._mapSlot),
    };
}
// LIVE state only (what a fresh twin fed the same ops must reproduce exactly; clear() leaves the
// dead pool bytes behind by design, so they are excluded).
function qa25Live(s) {
    const slots = [];
    for (let sl = 0; sl < s.size; sl++) slots.push([s._key[sl], s._count[sl], s._error[sl], s._cBucket[sl]]);
    const map = [];
    for (let j = 0; j < s._mapOcc.length; j++) if (s._mapOcc[j] === 1) map.push([j, s._mapKey[j], s._mapSlot[j]]);
    const chain = [];
    for (let b = s._minBucket; b >= 0; b = s._bNext[b]) {
        const sib = [];
        for (let sl = s._bHead[b]; sl >= 0; sl = s._cNext[sl]) sib.push(sl);
        chain.push([b, s._bVal[b], sib]);
    }
    return { size: s.size, total: s.total, slots, map, chain, topK: s.topK() };
}
// Model-free structural invariants: map <-> slots bijection, Knuth probe-run invariant (no hole
// between an entry's home and its index), bucket chain ascending with consistent bPrev, every
// slot in exactly the bucket of its count. Returns '' or the first violation.
function qa25Check(s) {
    const M = s._mapOcc.length, mask = s._mask;
    let occ = 0;
    for (let j = 0; j < M; j++) {
        if (s._mapOcc[j] !== 1) continue;
        occ++;
        const sl = s._mapSlot[j], k = s._mapKey[j];
        if (sl < 0 || sl >= s.size || s._key[sl] !== k) return 'map[' + j + '] -> bad slot ' + sl;
        const home = s._hash(k) & mask;
        for (let t = home; t !== j; t = (t + 1) & mask) if (s._mapOcc[t] !== 1) return 'probe-run hole at ' + t + ' for map[' + j + ']';
    }
    if (occ !== s.size) return 'occ ' + occ + ' != size ' + s.size;
    for (let sl = 0; sl < s.size; sl++) {
        const idx = s._probe(s._key[sl], s._hash(s._key[sl]));
        if (s._mapOcc[idx] !== 1 || s._mapSlot[idx] !== sl) return 'slot ' + sl + ' not found';
    }
    let prevB = -1, prevV = -Infinity, seen = 0;
    for (let b = s._minBucket; b >= 0; b = s._bNext[b]) {
        if (s._bPrev[b] !== prevB) return 'bPrev[' + b + '] ' + s._bPrev[b] + ' != ' + prevB;
        if (!(s._bVal[b] > prevV)) return 'buckets not ascending at ' + b;
        if (s._bHead[b] < 0) return 'empty live bucket ' + b;
        let p = -1;
        for (let sl = s._bHead[b]; sl >= 0; sl = s._cNext[sl]) {
            if (s._cPrev[sl] !== p) return 'cPrev[' + sl + ']';
            if (s._cBucket[sl] !== b || s._count[sl] !== s._bVal[b]) return 'slot ' + sl + ' in wrong bucket';
            p = sl; seen++;
        }
        prevB = b; prevV = s._bVal[b];
    }
    if (seen !== s.size) return 'forest covers ' + seen + ' != size ' + s.size;
    if (s.size > 0 && s._bFreeTop + (function () { let n = 0; for (let b = s._minBucket; b >= 0; b = s._bNext[b]) n++; return n; })() !== s._capacity) {
        return 'bucket free-list leak: free ' + s._bFreeTop + ' + live != capacity';
    }
    return '';
}
// Group candidate keys by home for a given (capacity, seed); returns keys sharing `home`.
function qa25SameHome(s, home, n, start) {
    const out = [];
    for (let k = start; out.length < n; k++) {
        if ((s._hash(k) & s._mask) === home) out.push(k);
        const nk = -k;
        if (out.length < n && nk !== 0 && (s._hash(nk) & s._mask) === home) out.push(nk);
    }
    return out;
}

test('QA H2.5 (SS capacity 1 and 2, counts 2^32-1, total at the 2^53-1 ceiling): insert / bump / ' +
    'evict rejects are FULL-POOL byte-identical through the inlined bump; the exact-ceiling add lands', () => {
    for (const cap of [1, 2]) {
        const s = new SpaceSaving(cap, { seed: 3 });
        // reach 2^53-1 - 1000 with 2^32-1 steps on key 2^31 (a non-Smi key, non-Smi counts)
        fillTotal(s, 2 ** 31, SS_MAX_SAFE - 1000 - (cap === 2 ? 1 : 0));
        if (cap === 2) qa25Add(s, -(2 ** 32), 1);                 // second slot: count 1 (the min)
        assert.equal(qa25Check(s), '', 'cap ' + cap + ' pre');
        const room = SS_MAX_SAFE - s.total;                  // exactly 1000 left
        assert.equal(room, 1000);
        const cases = [
            [() => s.add(2 ** 31, room + 1), 'bump past ceiling by 1'],
            [() => s.add(2 ** 31, 4294967295), 'bump 2^32-1'],
            [() => s.add(7, room + 1), 'insert/evict past ceiling by 1'],
            [() => s.add(-(2 ** 53 - 1), 4294967295), 'evict 2^32-1, key -(2^53-1)'],
        ];
        if (cap === 2) cases.push([() => s.add(-(2 ** 32), 4294967295), 'bump the min slot 2^32-1']);
        for (const [fn, label] of cases) {
            const before = qa25Pool(s);
            assert.throws(fn, (e) => liteSketch(e) && /9007199254740991/.test(e.message) &&
                e.message.includes('current total ' + before.total + ' + '), 'cap ' + cap + ' ' + label);
            assert.deepEqual(qa25Pool(s), before, 'cap ' + cap + ' ' + label + ': pool changed on reject');
        }
        // the exact-ceiling add is ACCEPTED: an eviction on cap 1, a bump of the min on cap 2.
        const victim = cap === 1 ? 99 : -(2 ** 32);
        const prevEst = s.estimate(victim);
        const minC = s._bVal[s._minBucket];
        qa25Add(s, victim, room);
        assert.equal(s.total, SS_MAX_SAFE, 'cap ' + cap + ' total lands exactly on 2^53-1');
        assert.equal(s.estimate(victim), (cap === 1 ? minC : prevEst) + room, 'cap ' + cap + ' landed count');
        assert.equal(qa25Check(s), '', 'cap ' + cap + ' post');
        // and now EVERY add rejects, byte-identically (count 1 is the smallest legal count)
        for (const k of [victim, 2 ** 31, 12345]) {
            const before = qa25Pool(s);
            assert.throws(() => s.add(k, 1), liteSketch, 'cap ' + cap + ' at ceiling add(' + k + ', 1)');
            assert.deepEqual(qa25Pool(s), before, 'cap ' + cap + ' at ceiling: pool changed');
        }
    }
});

test('QA H2.5 (SS evict when the evicted key and the newcomer share a home / probe run, incl. ' +
    'the wrap at index M-1): backshift then re-probe keeps every key findable', () => {
    for (const cap of [2, 3, 4]) {
        for (const seed of [0, 7, -1]) {
            const probe = new SpaceSaving(cap, { seed });
            const M = probe._mapOcc.length, mask = probe._mask;
            for (const home of [0, mask]) {                    // mask = the wrap-around home
                const run = qa25SameHome(probe, home, cap + 2, 2 ** 31 - 3);
                // every permutation-ish order: fill with the first cap keys at varied counts so the
                // min (the evictee) sits at the head, the middle and the tail of the probe run.
                for (let minPos = 0; minPos < cap; minPos++) {
                    const s = new SpaceSaving(cap, { seed });
                    for (let i = 0; i < cap; i++) qa25Add(s, run[i], i === minPos ? 1 : 2 ** 31 + i);
                    assert.equal(qa25Check(s), '', 'fill cap ' + cap + ' seed ' + seed + ' home ' + home);
                    const evictee = run[minPos];
                    const newcomer = run[cap];
                    qa25Add(s, newcomer, 2 ** 32 - 1);              // evicts `evictee` (count 1, the unique min)
                    const tag = 'cap ' + cap + ' seed ' + seed + ' home ' + home + ' minPos ' + minPos;
                    assert.equal(qa25Check(s), '', tag + ' after evict');
                    assert.equal(s.estimate(evictee), 0, tag + ' evictee gone');
                    assert.equal(s.estimate(newcomer), 1 + 2 ** 32 - 1, tag + ' newcomer = min + count');
                    assert.equal(s.errorOf(newcomer), 1, tag + ' newcomer error = evicted min');
                    for (let i = 0; i < cap; i++) if (i !== minPos) assert.equal(s.estimate(run[i]), 2 ** 31 + i, tag + ' survivor ' + i);
                    // second eviction in the same run (the evictee re-enters), then a bump of it
                    qa25Add(s, evictee, 3);
                    assert.equal(qa25Check(s), '', tag + ' re-enter');
                    qa25Add(s, evictee, 2 ** 31);
                    assert.equal(qa25Check(s), '', tag + ' bump re-entered');
                    assert.ok(s.estimate(evictee) > 2 ** 31, tag + ' re-entered key monitored');
                }
            }
            assert.ok(M >= 4);
        }
    }
});

test('QA H2.5 (SS clear() then reuse): the live state equals a fresh twin fed the same ops, stale ' +
    'pool bytes never alias a pre-clear key, and a duplicate clear() changes nothing', () => {
    for (const cap of [1, 2, 7]) {
        const s = new SpaceSaving(cap, { seed: 9 });
        const pre = [2 ** 31, -(2 ** 31), 2 ** 53 - 1, -(2 ** 53 - 1), 0, 4294967296, 5, 6, 7, 8];
        for (let i = 0; i < 40; i++) qa25Add(s, pre[i % pre.length], [1, 2 ** 30, 2 ** 31 + 1, 2 ** 32 - 1][i & 3]);
        s.clear();
        const c1 = qa25Pool(s);
        s.clear();
        assert.deepEqual(qa25Pool(s), c1, 'cap ' + cap + ': duplicate clear changed the pool');
        for (const k of pre) assert.equal(s.estimate(k), 0, 'cap ' + cap + ': stale key ' + k + ' still estimates');
        const twin = new SpaceSaving(cap, { seed: 9 });
        const post = [7, 2 ** 31, -3, 2 ** 31 + 1, 4294967296, -(2 ** 53 - 1), 11, 2 ** 31];
        for (let i = 0; i < 64; i++) {
            const k = post[(i * 5) % post.length], c = [2 ** 32 - 1, 1, 2 ** 31 + (i & 7), 2 ** 30][i & 3];
            qa25Add(s, k, c); qa25Add(twin, k, c);
            assert.equal(qa25Check(s), '', 'cap ' + cap + ' op ' + i);
            assert.deepEqual(qa25Live(s), qa25Live(twin), 'cap ' + cap + ' op ' + i + ': reused != fresh twin');
        }
    }
});

test('QA H2.5 (SS merge then bump / evict): the merge-rebuilt forest (bPrev hints) feeds the inlined ' +
    'bump correctly -- exact counts, invariants after every op, counts >= 2^31', () => {
    for (const cap of [1, 3, 16]) {
        const a = new SpaceSaving(cap, { seed: 4 }), b = new SpaceSaving(cap, { seed: 4 });
        for (let i = 0; i < 3 * cap + 5; i++) {
            qa25Add(a, i, 2 ** 31 + i);
            qa25Add(b, -(i + 1) * 4294967296 - i, [1, 2 ** 32 - 1][i & 1]);
            qa25Add(b, i, 2 ** 30);
        }
        a.merge(b);
        assert.equal(qa25Check(a), '', 'cap ' + cap + ' after merge');
        const keys = a.topK().map((e) => e.key);
        for (let r = 0; r < 4; r++) {
            for (const k of keys) {
                const est = a.estimate(k), err = a.errorOf(k);
                const minC = a._bVal[a._minBucket];
                const c = [1, 2 ** 31 + 3, 2 ** 32 - 1, 2 ** 30][(r + Math.abs(k)) & 3];
                const tot = a.total;
                qa25Add(a, k, c);
                const tag = 'cap ' + cap + ' r ' + r + ' add ' + k;
                assert.equal(qa25Check(a), '', tag);
                if (est !== 0) {                                // monitored -> inlined bump: exact
                    assert.equal(a.estimate(k), est + c, tag + ' exact bump');
                    assert.equal(a.errorOf(k), err, tag + ' bump keeps error');
                } else {                                        // evicted earlier -> evict path
                    assert.equal(a.estimate(k), minC + c, tag + ' evict = min + c');
                    assert.equal(a.errorOf(k), minC, tag + ' evict error = min');
                }
                assert.equal(a.total, tot + c, tag + ' total');
            }
            qa25Add(a, 1e9 + r, 2 ** 32 - 1);                       // evict on a merge-built forest
            assert.equal(qa25Check(a), '', 'cap ' + cap + ' r ' + r + ' evict');
            assert.ok(a.estimate(1e9 + r) >= 2 ** 32 - 1, 'cap ' + cap + ' newcomer monitored');
        }
    }
});

test('QA H2.5 (SS _homeAt/_probeAt over the MAP pool, NEW-CODE ONLY): for every occupied map index ' +
    'j (incl. j = M-1 and j = 0) _homeAt(_mapKey, j) === _hash & _mask and _probeAt(_mapKey, j, home) ' +
    '=== j; an absent key probes to an EMPTY index', () => {
    for (const cap of [1, 2, 64]) {
        const s = new SpaceSaving(cap, { seed: -7 });
        const mask = s._mask;
        // force the wrap: keys whose home is M-1, then fill
        const wrap = qa25SameHome(s, mask, Math.min(cap, 2), 2 ** 32 - 3);
        for (const k of wrap) qa25Add(s, k, 2 ** 31);
        for (let i = 0; s.size < cap && i < 4 * cap; i++) qa25Add(s, -(2 ** 31) - i * 65537, i + 1);
        let checked = 0, bad = '';
        for (let j = 0; j <= mask; j++) {
            if (s._mapOcc[j] !== 1) continue;
            checked++;
            const home = s._homeAt(s._mapKey, j);
            if (home !== (s._hash(s._mapKey[j]) & mask)) bad += 'home@' + j + ' ';
            if (s._probeAt(s._mapKey, j, home) !== j) bad += 'probeAt@' + j + ' ';
        }
        assert.equal(checked, cap, 'cap ' + cap + ': occupied entries');
        assert.equal(bad, '', 'cap ' + cap + ': ' + bad);
        // an absent key (stored in a scratch Float64Array) probes to an empty index
        const scratch = new Float64Array([2 ** 53 - 1, -0, 0]);
        for (let i = 0; i < scratch.length; i++) {
            const present = s.estimate(scratch[i]) !== 0;
            const idx = s._probeAt(scratch, i, s._homeAt(scratch, i));
            assert.equal(s._mapOcc[idx] === 1, present, 'cap ' + cap + ' scratch[' + i + ']');
            assert.equal(idx, s._probe(scratch[i], s._hash(scratch[i])), 'cap ' + cap + ' scratch[' + i + '] index');
        }
    }
});

// ===========================================================================
// H2.6 F5 + D1 -- addFrom (the zero-box entry point). Every add / addFrom below
// runs through the per-op _mapOcc population WATCHDOG (h26Watch): a hash-
// corrupting mis-port leaks a map entry and FAILs here, long before the load-0.5
// table can spin a probe loop. D1: addFrom snapshots buf[i], buf[i+1] into _buf,
// so a Proxy / shared view that changes value between reads cannot split a key
// from its home. (qa25Pool / qa25Check / qa25Live are defined above.)
// ===========================================================================
function h26Watch(s, where) {
    let n = 0;
    for (let j = 0; j < s._mapOcc.length; j++) n += s._mapOcc[j];
    assert.equal(n, s.size, 'watchdog: _mapOcc population ' + n + ' != size ' + s.size + ' after ' + where);
}

test('H2.6 (SS): add and addFrom build byte-identical pools over mixed-sign keys incl +-(2^53-1) and -0', () => {
    const keys = [0, -0, 1, -1, 7, 2 ** 30, 2 ** 31, -(2 ** 31), 2 ** 32 - 1, 2 ** 32 + 7, -(2 ** 32 + 7), 2 ** 53 - 1, -(2 ** 53 - 1)];
    for (const cap of [1, 7, 64]) {
        const a = new SpaceSaving(cap), b = new SpaceSaving(cap);
        const F = new Float64Array(3);
        let t = 0;
        for (let pass = 0; pass < 3; pass++) for (const k of keys) {   // passes force bumps + evictions
            const cn = (t++ & 1) ? 2 ** 30 + (t & 7) : 1 + (t & 3);
            a.add(k, cn); h26Watch(a, 'cap ' + cap + ' a.add');
            F[1] = k; F[2] = cn; b.addFrom(F, 1); h26Watch(b, 'cap ' + cap + ' b.addFrom');
        }
        assert.deepEqual(qa25Pool(b), qa25Pool(a), 'cap ' + cap + ': addFrom pool != add pool');
    }
});

test('H2.6 (SS): addFrom rejects a bad buffer / index (needs i and i+1 in range), byte-identical no-op', () => {
    const s = new SpaceSaving(8); s.add(5, 3); h26Watch(s, 'seed');
    const before = qa25Pool(s);
    const F = new Float64Array(2);
    for (const bad of [new Float32Array(2), new Int32Array(2), [1, 2], new DataView(new ArrayBuffer(16)), null, undefined, {}])
        assert.throws(() => s.addFrom(bad, 0), (e) => e instanceof TypeError && /\[lite-sketch\] SpaceSaving\.addFrom/.test(e.message), 'buf ' + String(bad));
    for (const i of [0.5, -1, NaN, Infinity, 1, 2])   // length 2 -> only i = 0 keeps i+1 in bounds
        assert.throws(() => s.addFrom(F, i), (e) => e instanceof TypeError && /SpaceSaving\.addFrom/.test(e.message), 'i ' + i);
    assert.deepEqual(qa25Pool(s), before, 'a bad addFrom mutated state');
});

test('H2.6 (SS): a key or count addFrom would reject throws add\'s exact error, byte-identical no-op', () => {
    const s = new SpaceSaving(8); s.add(9, 2); h26Watch(s, 'seed');
    const F = new Float64Array(2);
    for (const [k, cn] of [[1.5, 1], [2 ** 53, 1], [Infinity, 1], [NaN, 1], [1, 0], [1, 2 ** 32], [5, 1.5], [5, -1]]) {
        const before = qa25Pool(s);
        F[0] = k; F[1] = cn;
        let eAdd = null, eFrom = null;
        try { s.add(k, cn); } catch (e) { eAdd = e; }
        try { s.addFrom(F, 0); } catch (e) { eFrom = e; }
        assert.ok(eFrom, 'addFrom(' + k + ',' + cn + ') did not throw');
        assert.equal(eFrom.constructor, eAdd.constructor, k + ',' + cn + ' class');
        assert.equal(eFrom.message, eAdd.message, k + ',' + cn + ' message');
        assert.deepEqual(qa25Pool(s), before, 'reject ' + k + ',' + cn + ' mutated state');
    }
});

test('H2.6 (SS, D1 TEETH): addFrom with a Proxy whose get FLIPS the key between reads stays map-consistent on evict', () => {
    const s = new SpaceSaving(4);
    for (let k = 1; k <= 4; k++) { s.add(k * 1000, 1); h26Watch(s, 'fill ' + k); }   // full, distinct keys
    // A Proxy over a Float64Array (passes instanceof): slot 0 (the key) returns 5000 on the FIRST
    // read and 6000 after; slot 1 is the count. With D1 the key is snapshotted once, so _addAt's
    // guard / _homeAt / _probeAt all see 5000 and the map stays self-consistent. With D1 reverted,
    // _addAt re-reads slot 0 and splits the stored key (5000) from its home (6000) -> a violation.
    let reads = 0;
    const target = new Float64Array([5000, 1]);
    const px = new Proxy(target, { get(t, k) { return k === '0' ? (reads++ === 0 ? 5000 : 6000) : t[k]; } });
    s.addFrom(px, 0);
    h26Watch(s, 'proxy addFrom');   // D1 teeth: a leaked map entry trips here
    assert.equal(qa25Check(s), '', 'D1: a flipping Proxy violated the map/forest invariant');
    for (let sl = 0; sl < s.size; sl++) {
        const key = s._key[sl];
        const idx = s._probe(key, s._hash(key));
        assert.equal(s._mapSlot[idx], sl, 'D1: slot ' + sl + ' (key ' + key + ') not found by _probe(key, _hash(key))');
    }
});

test('H2.6 (SS): _buf is per instance -- interleaved addFrom instances equal solo twins', () => {
    const x = new SpaceSaving(64), y = new SpaceSaving(64), xs = new SpaceSaving(64), ys = new SpaceSaving(64);
    const F = new Float64Array(2);
    for (let k = 0; k < 3000; k++) {
        F[0] = (k * 2654435761) % (2 ** 40); F[1] = 1 + (k & 7);
        x.addFrom(F, 0); h26Watch(x, 'x'); xs.addFrom(F, 0); h26Watch(xs, 'xs');
        F[0] = -((k * 40503) % (2 ** 35)); F[1] = 2 ** 30 + (k & 3);
        y.addFrom(F, 0); h26Watch(y, 'y'); ys.addFrom(F, 0); h26Watch(ys, 'ys');
    }
    assert.deepEqual(qa25Live(x), qa25Live(xs), 'interleaved x != solo');
    assert.deepEqual(qa25Live(y), qa25Live(ys), 'interleaved y != solo');
});

// ===========================================================================
// H2.6 TEETH -- exact HEAD (key,count) error literals (kills a count-first _badArgs
// mutant). add / addFrom run through the per-op _mapOcc watchdog above (h26Watch).
// ===========================================================================
test('H2.6 (SS TEETH): add / addFrom pin HEAD\'s exact (key,count) error class + message (kills a count-first _badArgs)', () => {
    const sym = Symbol('z');
    const LITS = [
        [NaN, 'x', 'TypeError', '[lite-sketch] SpaceSaving.add key must be a safe integer, got NaN'],
        ['1', NaN, 'TypeError', '[lite-sketch] SpaceSaving.add key must be a safe integer, got 1'],
        [1, '2', 'RangeError', '[lite-sketch] SpaceSaving count must be an integer in [1, 4294967295], got 2'],
        [1.5, sym, 'TypeError', '[lite-sketch] SpaceSaving.add key must be a safe integer, got 1.5'],
        [1, 2 ** 32, 'RangeError', '[lite-sketch] SpaceSaving count must be an integer in [1, 4294967295], got 4294967296'],
        [1, null, 'RangeError', '[lite-sketch] SpaceSaving count must be an integer in [1, 4294967295], got null'],
    ];
    const s = new SpaceSaving(8); s.add(3, 2); h26Watch(s, 'seed');
    const before = qa25Pool(s);
    const F = new Float64Array(2);
    for (const [k, cn, cls, msg] of LITS) {
        assert.throws(() => s.add(k, cn), (e) => e.constructor.name === cls && e.message === msg, 'add(' + String(k) + ',' + String(cn) + ')');
        if (typeof k === 'number' && typeof cn === 'number') { F[0] = k; F[1] = cn; assert.throws(() => s.addFrom(F, 0), (e) => e.constructor.name === cls && e.message === msg, 'addFrom(' + String(k) + ',' + String(cn) + ')'); }
    }
    assert.deepEqual(qa25Pool(s), before, 'teeth rejects mutated state');
});

// ===========================================================================
// QA H2.6 -- boundary matrix for addFrom / estimate / errorOf (SS). Every add /
// addFrom goes through the per-op _mapOcc watchdog (qa26Add / qa26From wrap
// h26Watch). Index 0 / 1 / N-2 / N-1 / N / N+1 / -0 / empty / null / undefined /
// NaN; byteOffset / SharedArrayBuffer / detached / shrunk views; the key x count
// matrix through addFrom == add; estimate / errorOf on an evicted key; forEach
// with an evicting addFrom inside the callback; duplicate clear(); interleaved
// instances; a Proxy that re-enters the same sketch while slot i is read.
// ===========================================================================
const qa26Err = (fn) => { try { fn(); return null; } catch (e) { return e.constructor.name + ': ' + e.message; } };
function qa26Add(s, k, c, where) { try { return s.add(k, c); } finally { h26Watch(s, where || 'add(' + k + ',' + c + ')'); } }
function qa26From(s, F, i, where) { try { return s.addFrom(F, i); } finally { h26Watch(s, where || 'addFrom(' + F[i] + ',' + F[i + 1] + ')'); } }

test('QA H2.6 (SS): addFrom index matrix 0 / 1 / N-2 accepted == add; N-1 / N / N+1 / empty / -1 / NaN / null / undefined rejected tagged, no-op', () => {
    const F = new Float64Array([2 ** 40 + 1, 3, 2 ** 31 + 7, 2 ** 31, 9]);
    const N = F.length;
    for (const i of [0, 1, N - 2, -0]) {
        const a = new SpaceSaving(4), b = new SpaceSaving(4);
        qa26Add(a, F[i], F[i + 1]); qa26From(b, F, i);
        assert.deepEqual(qa25Pool(b), qa25Pool(a), 'i ' + i);
    }
    const s = new SpaceSaving(4); qa26Add(s, 17, 4);
    const before = qa25Pool(s);
    for (const i of [N - 1, N, N + 1, -1, NaN, null, undefined, '0', 0.5, Infinity])
        assert.match(qa26Err(() => qa26From(s, F, i, 'i ' + String(i))), /^TypeError: \[lite-sketch\] SpaceSaving\.addFrom\(buf, i\)/, 'i ' + String(i));
    for (const len of [0, 1])
        assert.match(qa26Err(() => qa26From(s, new Float64Array(len), 0, 'len ' + len)), /^TypeError: \[lite-sketch\] SpaceSaving\.addFrom/, 'length ' + len);
    assert.deepEqual(qa25Pool(s), before, 'rejected index mutated state');
});

test('QA H2.6 (SS): addFrom over a byteOffset view and a SharedArrayBuffer view == add; detached / shrunk buffers reject, no-op', () => {
    const base = new Float64Array([0, 0, 0, -(2 ** 33) - 9, 2 ** 31 + 1]);
    const view = base.subarray(3);
    assert.equal(view.byteOffset, 24);
    const S = new Float64Array(new SharedArrayBuffer(16)); S[0] = -(2 ** 33) - 9; S[1] = 2 ** 31 + 1;
    const a = new SpaceSaving(2), b = new SpaceSaving(2), c = new SpaceSaving(2);
    qa26Add(a, -(2 ** 33) - 9, 2 ** 31 + 1); qa26From(b, view, view.length - 2); qa26From(c, S, 0);
    assert.deepEqual(qa25Pool(b), qa25Pool(a), 'view'); assert.deepEqual(qa25Pool(c), qa25Pool(a), 'SAB');
    assert.equal(b.estimate(-(2 ** 33) - 9), 2 ** 31 + 1);
    const before = qa25Pool(a);
    const D = new Float64Array([1, 1]); structuredClone(D.buffer, { transfer: [D.buffer] });
    assert.match(qa26Err(() => qa26From(a, D, 0, 'detached')), /^TypeError: \[lite-sketch\] SpaceSaving\.addFrom/, 'detached');
    const rab = new ArrayBuffer(32, { maxByteLength: 32 }); const R = new Float64Array(rab); R[2] = 5; R[3] = 1;
    rab.resize(24);
    assert.match(qa26Err(() => qa26From(a, R, 2, 'shrunk')), /^TypeError: \[lite-sketch\] SpaceSaving\.addFrom/, 'shrunk');
    assert.deepEqual(qa25Pool(a), before, 'detached / shrunk mutated state');
});

test('QA H2.6 (SS): addFrom key x count matrix == add (error class + message, or full pool), incl -0, +-(2^53-1), 2^53, NaN, counts 0 / 2^32-1 / 2^32 / 1.5', () => {
    const KEYS = [0, -0, 1, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 53, -(2 ** 53), NaN, Infinity, 1.5, 2 ** 31];
    const COUNTS = [0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 1.5, NaN, -1, -0, Infinity];
    const F = new Float64Array(2);
    for (const k of KEYS) for (const cn of COUNTS) {
        const a = new SpaceSaving(2), b = new SpaceSaving(2);
        qa26Add(a, 3, 2); qa26Add(a, 4, 1); qa26Add(b, 3, 2); qa26Add(b, 4, 1);   // full: an accepted add evicts
        const ea = qa26Err(() => qa26Add(a, k, cn));
        F[0] = k; F[1] = cn;
        const eb = qa26Err(() => qa26From(b, F, 0));
        const lab = '(' + k + ', ' + cn + ')';
        assert.equal(eb, ea, lab + ': addFrom outcome != add');
        assert.deepEqual(qa25Pool(b), qa25Pool(a), lab + ': pool');
        assert.equal(qa25Check(b), '', lab + ': invariant');
        assert.equal(b.estimate(k), a.estimate(k), lab + ': estimate');
        assert.equal(b.errorOf(k), a.errorOf(k), lab + ': errorOf');
    }
});

test('QA H2.6 (SS): estimate / errorOf on an EVICTED key read 0 / 0 (via _buf + _homeAt), and a re-admitted key carries the min as error', () => {
    const s = new SpaceSaving(3);
    const F = new Float64Array(2);
    for (const [k, c] of [[2 ** 40 + 1, 5], [-(2 ** 33), 7], [11, 9]]) { F[0] = k; F[1] = c; qa26From(s, F, 0); }
    F[0] = 2 ** 35 + 3; F[1] = 1; qa26From(s, F, 0);           // evicts the min (2^40+1, count 5)
    assert.equal(s.estimate(2 ** 40 + 1), 0, 'evicted estimate');
    assert.equal(s.errorOf(2 ** 40 + 1), 0, 'evicted errorOf');
    assert.equal(s.estimate(2 ** 35 + 3), 6, 'newcomer count = min + count');
    assert.equal(s.errorOf(2 ** 35 + 3), 5, 'newcomer error = min');
    F[0] = 2 ** 40 + 1; F[1] = 2 ** 31; qa26From(s, F, 0);     // re-admit: evicts the newcomer (6)
    assert.equal(s.estimate(2 ** 40 + 1), 2 ** 31 + 6);
    assert.equal(s.errorOf(2 ** 40 + 1), 6);
    assert.equal(s.estimate(2 ** 35 + 3), 0); assert.equal(s.errorOf(2 ** 35 + 3), 0);
    assert.equal(qa25Check(s), '');
    for (const k of [NaN, Infinity, -Infinity, 1.5, 2 ** 53, -0]) { assert.equal(s.estimate(k), 0, 'est ' + k); assert.equal(s.errorOf(k), 0, 'err ' + k); }
});

test('QA H2.6 (SS): forEach with an EVICTING addFrom inside the callback, then duplicate clear(), stays consistent', () => {
    const s = new SpaceSaving(8), t = new SpaceSaving(8);
    for (let k = 0; k < 8; k++) { qa26Add(s, 2 ** 32 + k, 1 + k); qa26Add(t, 2 ** 32 + k, 1 + k); }
    const F = new Float64Array(2);
    let visits = 0, n = 100;
    s.forEach(() => { visits++; F[0] = -(2 ** 34) - n; F[1] = 1; n++; qa26From(s, F, 0, 'forEach addFrom'); });
    assert.equal(visits, 8, 'forEach visits size-at-entry entries');
    for (let m = 100; m < n; m++) qa26Add(t, -(2 ** 34) - m, 1, 'twin');
    assert.deepEqual(qa25Live(s), qa25Live(t), 'a mid-iteration addFrom != the same adds after iteration');
    assert.equal(qa25Check(s), '');
    s.clear(); s.clear();
    assert.equal(s.size, 0); assert.equal(s.total, 0);
    const u = new SpaceSaving(8);
    F[0] = 2 ** 45 + 1; F[1] = 2 ** 31; qa26From(s, F, 0, 'after double clear'); qa26Add(u, 2 ** 45 + 1, 2 ** 31);
    assert.deepEqual(qa25Live(s), qa25Live(u), 'after a duplicate clear');
});

test('QA H2.6 (SS): interleaved add / addFrom / estimate / errorOf on two instances never cross-talk through _buf', () => {
    const x = new SpaceSaving(32), y = new SpaceSaving(32), xs = new SpaceSaving(32), ys = new SpaceSaving(32);
    const F = new Float64Array(2);
    for (let t = 0; t < 2000; t++) {
        const kx = (t * 2654435761) % (2 ** 40), ky = -((t * 40503) % 997) - 2 ** 33, cx = 1 + (t & 7), cy = 2 ** 30 + (t & 3);
        if (t & 1) qa26Add(x, kx, cx, 'x'); else { F[0] = kx; F[1] = cx; qa26From(x, F, 0, 'x'); }
        const ey = y.estimate(ky), ry = y.errorOf(ky);
        assert.equal(ey, ys.estimate(ky), 't ' + t + ' y.estimate'); assert.equal(ry, ys.errorOf(ky), 't ' + t + ' y.errorOf');
        F[0] = ky; F[1] = cy; qa26From(y, F, 0, 'y');
        assert.equal(x.estimate(kx), (qa26Add(xs, kx, cx, 'xs'), xs.estimate(kx)), 't ' + t + ' x.estimate');
        qa26Add(ys, ky, cy, 'ys');
    }
    assert.deepEqual(qa25Live(x), qa25Live(xs)); assert.deepEqual(qa25Live(y), qa25Live(ys));
});

test('QA H2.6 (SS): a Proxy that re-enters the same sketch while slot i (the key) is read still adds the caller (key, count)', () => {
    const a = new SpaceSaving(8), b = new SpaceSaving(8);
    qa26Add(a, 999, 2); qa26Add(a, 2 ** 33 + 1, 5);
    let fired = false;
    const px = new Proxy(new Float64Array([2 ** 33 + 1, 5]), {
        get(t, k) { if (k === '0' && !fired) { fired = true; b.add(999, 2); } return t[k]; },
    });
    qa26From(b, px, 0, 'proxy');
    assert.ok(fired);
    assert.deepEqual(qa25Live(b), qa25Live(a));
});

test('H2.6 (SS, D1 re-entry): a Proxy that re-enters add() while slot i+1 is read must not overwrite the caller key', () => {
    // qa finding: reading buf[i+1] through a Proxy that calls b.add(999, 2) re-entrantly used to
    // clobber _buf[0] mid-copy (est(111)=0, est(999)=7). Reading both slots into locals BEFORE the
    // _buf stores fixes it: the re-entrant add lands first, then our addFrom lands with key 111.
    const b = new SpaceSaving(8);
    let fired = false;
    const px = new Proxy(new Float64Array([111, 5]), {
        get(t, k) { if (k === '1' && !fired) { fired = true; b.add(999, 2); } return t[k]; },
    });
    b.addFrom(px, 0);
    h26Watch(b, 'reentry addFrom');   // per-op _mapOcc watchdog
    assert.deepEqual([b.estimate(111), b.estimate(999), b.total], [5, 2, 7]);
});
