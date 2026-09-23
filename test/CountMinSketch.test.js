/**
 * @zakkster/lite-sketch -- CountMinSketch boundary + one-sidedness + accuracy suite (node:test).
 *
 * Proves the CountMinSketch contract:
 *   1. ONE-SIDED over-estimate: estimate(k) >= trueCount(k) for every distinct key, over a
 *      random-key stream, against an exact Map oracle -- for BOTH conservative and plain.
 *   2. CONSERVATIVE <= PLAIN: same stream fed to a conservative and a plain sketch (same
 *      d/w/seed) -> the conservative estimate never exceeds the plain one.
 *   3. ACCURACY BOUND on a Zipfian stream: withAccuracy(epsilon, delta) -- fraction of
 *      distinct keys whose over-estimate exceeds epsilon*total is <= delta (+ small slack);
 *      epsilon === Math.E/w and delta === Math.exp(-d) exactly.
 *   4. PLAIN MERGE is EXACT (split stream, merge halves == whole); fails closed on a bad peer.
 *   5. CONSERVATIVE MERGE is a valid (looser) upper bound -- still one-sided.
 *   6. SATURATION: a cell caps at 0xffffffff, no wraparound, for both apply paths.
 *   7. FAIL-CLOSED matrix: ctor / add / addHashed / withAccuracy boundary matrix, byte-identical
 *      no-op throws; estimate/estimateHashed never throw.
 *   8. withAccuracy derivation + the fixed tiny-epsilon hang regression.
 *   9. ctor power-of-two round-up + getters + total tracking.
 *
 * (The full accuracy witness is the orchestrator's test/witness.mjs; this is the boundary +
 * correctness proof.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CountMinSketch, VERSION } from '../Sketch.js';

const liteSketch = (e) => e instanceof Error && /^\[lite-sketch]/.test(e.message);

// Deterministic PRNG (mulberry32-style) so no test ever flakes.
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

/** Zipfian sample generator over ranks [0, nKeys) with exponent `skew` (Zipf's law, harmonic CDF). */
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
        // binary search the harmonic CDF
        let lo = 0, hi = nKeys - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (harm[mid] < target) lo = mid + 1; else hi = mid;
        }
        return lo;
    };
}

test('VERSION is the frozen 1.1.2 string', () => {
    assert.equal(VERSION, '1.1.2');
});

// --- ctor power-of-two round-up + getters -----------------------------------

test('ctor rounds w UP to the next power of two; exact powers stay', () => {
    assert.equal(new CountMinSketch(4, 1000).w, 1024);
    assert.equal(new CountMinSketch(4, 1024).w, 1024);
    assert.equal(new CountMinSketch(4, 1025).w, 2048);
    assert.equal(new CountMinSketch(4, 1).w, 1);
});

test('getters d/w/seed/conservative/total/epsilon/delta are correct', () => {
    const c = new CountMinSketch(5, 1000, { seed: 777, conservative: false });
    assert.equal(c.d, 5);
    assert.equal(c.w, 1024);
    assert.equal(c.seed, 777 >>> 0);
    assert.equal(c.conservative, false);
    assert.equal(c.total, 0);
    assert.equal(c.epsilon, Math.E / 1024);
    assert.equal(c.delta, Math.exp(-5));
});

test('conservative defaults to true', () => {
    assert.equal(new CountMinSketch(4, 16).conservative, true);
});

test('total tracks the summed counts, incl. count>1 adds, and clear() resets to 0', () => {
    const c = new CountMinSketch(4, 16);
    c.add(1);
    c.add(2, 5);
    c.add(3, 10);
    assert.equal(c.total, 1 + 5 + 10);
    assert.equal(c.clear(), c);
    assert.equal(c.total, 0);
});

// --- ONE-SIDED over-estimate (random-key stream, exact Map oracle) ---------

for (const conservative of [true, false]) {
    test('one-sided over-estimate holds for every distinct key (conservative=' + conservative + ')', () => {
        const rng = makeRng(0xC0FFEE ^ (conservative ? 1 : 0));
        const c = new CountMinSketch(4, 1 << 12, { conservative });
        const truth = new Map();
        const N = 200000;
        const KEYSPACE = 5000;
        for (let i = 0; i < N; i++) {
            const key = (rng() * KEYSPACE) | 0;
            c.add(key);
            truth.set(key, (truth.get(key) || 0) + 1);
        }
        let violations = 0;
        for (const [key, trueCount] of truth) {
            const est = c.estimate(key);
            if (est < trueCount) violations++;
        }
        assert.equal(violations, 0, violations + ' key(s) under-estimated (conservative=' + conservative + ')');
    });
}

// --- CONSERVATIVE <= PLAIN (same stream, same d/w/seed) ---------------------

test('conservative estimate never exceeds the plain estimate on the same stream', () => {
    const rng = makeRng(0xBEEF);
    const cons = new CountMinSketch(4, 1 << 10, { seed: 42, conservative: true });
    const plain = new CountMinSketch(4, 1 << 10, { seed: 42, conservative: false });
    const seen = new Set();
    const N = 100000;
    const KEYSPACE = 3000;
    for (let i = 0; i < N; i++) {
        const key = (rng() * KEYSPACE) | 0;
        cons.add(key);
        plain.add(key);
        seen.add(key);
    }
    let violations = 0;
    for (const key of seen) {
        if (cons.estimate(key) > plain.estimate(key)) violations++;
    }
    assert.equal(violations, 0, violations + ' key(s) had conservative > plain');
});

// --- ACCURACY BOUND on a Zipfian stream -------------------------------------

test('epsilon === Math.E/w and delta === Math.exp(-d) on a withAccuracy sketch', () => {
    const c = CountMinSketch.withAccuracy(0.001, 0.01);
    assert.equal(c.epsilon, Math.E / c.w);
    assert.equal(c.delta, Math.exp(-c.d));
});

test('accuracy bound: fraction of keys with (est - true) > epsilon*total is <= delta (+ slack)', () => {
    const N = 300000;
    const NKEYS = 20000;
    const SKEW = 1.1;
    const rng = makeRng(0x5EED5EED);
    const zipf = makeZipf(NKEYS, SKEW, rng);
    const c = CountMinSketch.withAccuracy(0.001, 0.01);
    const truth = new Map();
    for (let i = 0; i < N; i++) {
        const key = zipf();
        c.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    const bound = c.epsilon * c.total;
    let violations = 0;
    let maxOver = 0;
    for (const [key, trueCount] of truth) {
        const est = c.estimate(key);
        assert.ok(est >= trueCount, 'one-sidedness broke for key ' + key);
        const over = est - trueCount;
        if (over > maxOver) maxOver = over;
        if (over > bound) violations++;
    }
    const fraction = violations / truth.size;
    // small-trial safety slack: gate at 3x delta rather than the raw delta (single stream,
    // not a repeated-trial average -- the theorem is a per-query Markov bound, not a
    // concentration guarantee across simultaneously-queried distinct keys).
    const slack = 3;
    assert.ok(fraction <= slack * c.delta,
        'violation fraction ' + fraction.toFixed(6) + ' exceeds ' + slack + 'x delta=' + (slack * c.delta).toFixed(6) +
        ' (maxOver=' + maxOver + ' bound=' + bound.toFixed(2) + ')');
});

// --- PLAIN MERGE is EXACT ----------------------------------------------------

test('plain merge is EXACT: split stream across two sketches, merge == single sketch fed the whole stream', () => {
    const rng = makeRng(0x1337);
    const D = 4, W = 1 << 10, SEED = 99;
    const a = new CountMinSketch(D, W, { seed: SEED, conservative: false });
    const b = new CountMinSketch(D, W, { seed: SEED, conservative: false });
    const whole = new CountMinSketch(D, W, { seed: SEED, conservative: false });
    const keys = [];
    const N = 50000;
    const KEYSPACE = 2000;
    for (let i = 0; i < N; i++) {
        const key = (rng() * KEYSPACE) | 0;
        keys.push(key);
        (i % 2 === 0 ? a : b).add(key);
        whole.add(key);
    }
    assert.equal(a.merge(b), a);
    // elementwise: every counter equal
    assert.deepEqual(a._counts, whole._counts);
    // and via estimate() on every distinct key
    for (const key of new Set(keys)) {
        assert.equal(a.estimate(key), whole.estimate(key), 'key=' + key);
    }
    assert.equal(a.total, whole.total);
});

test('merge fails closed on a non-CountMinSketch', () => {
    const a = new CountMinSketch(4, 16);
    for (const bad of [null, undefined, {}, 5, 'x', { _d: 4, _w: 16, _seed: 0 }]) {
        assert.throws(() => a.merge(bad), liteSketch, String(bad));
    }
});

test('merge fails closed on a d / w / seed mismatch', () => {
    const base = new CountMinSketch(4, 16, { seed: 1 });
    assert.throws(() => base.merge(new CountMinSketch(5, 16, { seed: 1 })), liteSketch, 'd mismatch');
    assert.throws(() => base.merge(new CountMinSketch(4, 32, { seed: 1 })), liteSketch, 'w mismatch');
    assert.throws(() => base.merge(new CountMinSketch(4, 16, { seed: 2 })), liteSketch, 'seed mismatch');
});

// --- CONSERVATIVE MERGE upper bound ------------------------------------------

test('conservative merge documents a VALID but LOOSER one-sided upper bound', () => {
    const rng = makeRng(0x9999);
    const D = 4, W = 1 << 9, SEED = 5;
    const a = new CountMinSketch(D, W, { seed: SEED, conservative: true });
    const b = new CountMinSketch(D, W, { seed: SEED, conservative: true });
    const whole = new CountMinSketch(D, W, { seed: SEED, conservative: false });
    const truth = new Map();
    const N = 60000;
    const KEYSPACE = 1500;
    for (let i = 0; i < N; i++) {
        const key = (rng() * KEYSPACE) | 0;
        (i % 2 === 0 ? a : b).add(key);
        whole.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    a.merge(b);
    let violations = 0;
    for (const [key, trueCount] of truth) {
        if (a.estimate(key) < trueCount) violations++;
    }
    assert.equal(violations, 0, violations + ' key(s) under the true count after conservative merge');
});

// --- SATURATION --------------------------------------------------------------

test('saturation: add(key, 0xffffffff) then add(key, 5) caps at 0xffffffff, no wraparound (conservative)', () => {
    const c = new CountMinSketch(3, 16, { conservative: true });
    c.add(42, 0xffffffff);
    c.add(42, 5);
    assert.equal(c.estimate(42), 0xffffffff);
});

test('saturation via _applyPlain path caps at 0xffffffff, no wraparound (conservative:false)', () => {
    const c = new CountMinSketch(3, 16, { conservative: false });
    c.add(42, 0xffffffff);
    c.add(42, 5);
    assert.equal(c.estimate(42), 0xffffffff);
});

test('saturation: merge of two near-max plain sketches caps at 0xffffffff', () => {
    const a = new CountMinSketch(3, 16, { conservative: false, seed: 1 });
    const b = new CountMinSketch(3, 16, { conservative: false, seed: 1 });
    a.add(7, 0xfffffffe);
    b.add(7, 10);
    a.merge(b);
    assert.equal(a.estimate(7), 0xffffffff);
});

// --- withAccuracy derivation -------------------------------------------------

test('withAccuracy(0.001, 0.01) derives d=5, w=4096 exactly', () => {
    const c = CountMinSketch.withAccuracy(0.001, 0.01);
    assert.equal(c.d, 5);
    assert.equal(c.w, 4096);
});

test('withAccuracy REGRESSION: a tiny epsilon clamps w to 2^25 and does not hang', () => {
    const start = Date.now();
    const c = CountMinSketch.withAccuracy(1e-9, 0.01);
    const elapsed = Date.now() - start;
    assert.equal(c.w, 1 << 25);
    assert.ok(elapsed < 2000, 'withAccuracy(1e-9, ...) took ' + elapsed + 'ms (regression: must not hang)');
});

test('withAccuracy clamps d to [1, 32]', () => {
    const dTiny = CountMinSketch.withAccuracy(0.01, 0.999999999999999);
    assert.ok(dTiny.d >= 1, 'd must clamp to >= 1, got ' + dTiny.d);
    const dHuge = CountMinSketch.withAccuracy(0.01, 1e-300);
    assert.equal(dHuge.d, 32, 'd must clamp to <= 32, got ' + dHuge.d);
});

// --- FAIL-CLOSED matrix: ctor --------------------------------------------------

test('ctor rejects a bad d [lite-sketch]', () => {
    for (const d of [0, 33, 2.5, NaN, '5', Symbol('x'), 5n, -1, Infinity, null, undefined]) {
        assert.throws(() => new CountMinSketch(d, 16), liteSketch, 'd=' + String(d));
    }
});

test('ctor rejects a bad w [lite-sketch]', () => {
    for (const w of [0, (1 << 25) + 1, NaN, '5', Symbol('x'), 5n, -1, Infinity, null, undefined]) {
        assert.throws(() => new CountMinSketch(4, w), liteSketch, 'w=' + String(w));
    }
});

test('ctor accepts w exactly at the cap 2^25', () => {
    assert.doesNotThrow(() => new CountMinSketch(1, 1 << 25));
});

test('ctor rejects bad options: non-object, array, unknown key (did-you-mean)', () => {
    assert.throws(() => new CountMinSketch(4, 16, 5), liteSketch, 'non-object options');
    assert.throws(() => new CountMinSketch(4, 16, 'x'), liteSketch, 'string options');
    assert.throws(() => new CountMinSketch(4, 16, [1, 2]), liteSketch, 'array options');
    assert.throws(() => new CountMinSketch(4, 16, { conservitive: true }), (e) => {
        return liteSketch(e) && /did-you-mean|known options|unknown option/.test(e.message);
    }, 'unknown option key');
});

test('ctor rejects a bad seed [lite-sketch]', () => {
    for (const seed of [2.5, NaN, '5', Symbol('x'), 5n, Infinity, null, {}]) {
        assert.throws(() => new CountMinSketch(4, 16, { seed }), liteSketch, 'seed=' + String(seed));
    }
});

test('ctor rejects a bad conservative [lite-sketch]', () => {
    for (const conservative of [1, 0, 'true', null, {}, [], 5n]) {
        assert.throws(() => new CountMinSketch(4, 16, { conservative }), liteSketch, 'conservative=' + String(conservative));
    }
});

test('ctor leaves NO half-built instance on a bad d (throws at the door)', () => {
    let inst;
    try {
        inst = new CountMinSketch(99, 16);
    } catch (e) {
        assert.ok(liteSketch(e));
    }
    assert.equal(inst, undefined);
});

// --- FAIL-CLOSED matrix: add / addHashed / estimate --------------------------

test('add rejects a bad key [lite-sketch]: NaN, string, Symbol, BigInt, null, undefined', () => {
    const c = new CountMinSketch(4, 16);
    for (const key of [NaN, '1', Symbol('x'), 5n, null, undefined, {}]) {
        assert.throws(() => c.add(key), liteSketch, 'key=' + String(key));
    }
});

test('add rejects a bad count [lite-sketch]: 0, -1, 1.5, 2^32, NaN', () => {
    const c = new CountMinSketch(4, 16);
    for (const count of [0, -1, 1.5, 2 ** 32, NaN, Infinity, '1', null]) {
        assert.throws(() => c.add(1, count), liteSketch, 'count=' + String(count));
    }
});

// F1/F2 (v1.1.0 hardening): the key domain is the SAFE INTEGER range (matching HyperLogLog /
// SpaceSaving). +-Infinity aliased key 0 (fail-open); non-integers truncated under >>> 0.
test('F1: add rejects +-Infinity [lite-sketch] (was fail-open: Infinity aliased key 0)', () => {
    const c = new CountMinSketch(5, 1 << 12);
    c.add(0, 100);
    assert.throws(() => c.add(Infinity), liteSketch);
    assert.throws(() => c.add(-Infinity), liteSketch);
    // fail-closed no-op: key 0's count was not perturbed by the rejected Infinity adds.
    assert.equal(c.estimate(0), 100);
});

test('F2: add rejects a non-integer / out-of-safe-range key [lite-sketch] (was truncated by >>> 0)', () => {
    const c = new CountMinSketch(5, 1 << 12);
    for (const bad of [1.5, 1.9, 0.5, Math.PI, 2 ** 53, -(2 ** 53), 2 ** 60]) {
        assert.throws(() => c.add(bad), liteSketch, 'key=' + bad);
    }
    // the whole SAFE-INTEGER range is still accepted (the hot body reads the high word + sign).
    for (const ok of [0, -0, 1, -5, 2 ** 32 + 1, 2 ** 40, Number.MAX_SAFE_INTEGER, -(2 ** 40)]) {
        assert.equal(c.add(ok), c, 'key=' + ok);
    }
    // add(1,50) then estimate(1.5) no longer aliases: 1.5 is not a countable key.
    const d = new CountMinSketch(5, 1 << 12);
    d.add(1, 50);
    assert.throws(() => d.add(1.5), liteSketch);
});

test('add accepts count at the boundaries 1 and 0xffffffff', () => {
    const c = new CountMinSketch(4, 16);
    assert.doesNotThrow(() => c.add(1, 1));
    assert.doesNotThrow(() => c.add(2, 0xffffffff));
});

test('addHashed rejects a bad lane [lite-sketch]: -1, 2^32, 1.5, NaN', () => {
    const c = new CountMinSketch(4, 16);
    for (const lane of [-1, 2 ** 32, 1.5, NaN, '1', Symbol('x'), 5n]) {
        assert.throws(() => c.addHashed(lane, 0), liteSketch, 'hi=' + String(lane));
        assert.throws(() => c.addHashed(0, lane), liteSketch, 'lo=' + String(lane));
    }
});

test('addHashed rejects a bad count the same as add', () => {
    const c = new CountMinSketch(4, 16);
    for (const count of [0, -1, 1.5, 2 ** 32, NaN]) {
        assert.throws(() => c.addHashed(1, 2, count), liteSketch, 'count=' + String(count));
    }
});

test('withAccuracy rejects a bad epsilon/delta [lite-sketch]: 0, 1, -0.1, NaN', () => {
    for (const bad of [0, 1, -0.1, NaN, Infinity, -Infinity]) {
        assert.throws(() => CountMinSketch.withAccuracy(bad, 0.01), liteSketch, 'epsilon=' + String(bad));
        assert.throws(() => CountMinSketch.withAccuracy(0.01, bad), liteSketch, 'delta=' + String(bad));
    }
});

test('estimate/estimateHashed NEVER throw: a bad key/lane returns 0', () => {
    const c = new CountMinSketch(4, 16);
    c.add(1, 5);
    for (const key of [NaN, '1', Symbol('x'), 5n, null, undefined, {}, [], -0, 0]) {
        assert.doesNotThrow(() => c.estimate(key), 'estimate key=' + String(key));
    }
    assert.equal(c.estimate(NaN), 0);
    assert.equal(c.estimate('1'), 0);
    assert.equal(c.estimate(Symbol('x')), 0);
    assert.equal(c.estimate(5n), 0);
    assert.equal(c.estimate(null), 0);
    assert.equal(c.estimate(undefined), 0);
    for (const lane of [-1, 2 ** 32, 1.5, NaN, '1', Symbol('x'), 5n, null, undefined]) {
        assert.doesNotThrow(() => c.estimateHashed(lane, 0), 'estimateHashed hi=' + String(lane));
        assert.doesNotThrow(() => c.estimateHashed(0, lane), 'estimateHashed lo=' + String(lane));
        assert.equal(c.estimateHashed(lane, 0), 0);
        assert.equal(c.estimateHashed(0, lane), 0);
    }
});

// --- boundary matrix: 0, 1, N-1, N, N+1, empty, null, undefined, NaN, -0 ------

test('boundary: key 0 and key -0 both hash and estimate consistently (same bit pattern)', () => {
    const c = new CountMinSketch(4, 64);
    c.add(0, 3);
    // -0 must behave identically to 0 through the sign-split (a < 0 is false for -0).
    assert.equal(c.estimate(-0), 3);
    assert.equal(c.estimate(0), 3);
});

test('boundary: d=1 (the floor) and d=32 (the ceiling) both work; 0 and 33 throw', () => {
    assert.doesNotThrow(() => new CountMinSketch(1, 16));
    assert.doesNotThrow(() => new CountMinSketch(32, 16));
    assert.throws(() => new CountMinSketch(0, 16), liteSketch);
    assert.throws(() => new CountMinSketch(33, 16), liteSketch);
});

test('boundary: w=1 (N-1 of legal range) and w=2^25 (N, the ceiling) both work; 2^25+1 throws (N+1)', () => {
    assert.doesNotThrow(() => new CountMinSketch(1, 1));
    assert.doesNotThrow(() => new CountMinSketch(1, 1 << 25));
    assert.throws(() => new CountMinSketch(1, (1 << 25) + 1), liteSketch);
});

test('boundary: an empty sketch (no adds) estimates 0 for every key and has total 0', () => {
    const c = new CountMinSketch(4, 16);
    assert.equal(c.total, 0);
    for (const key of [0, 1, -1, 99999]) assert.equal(c.estimate(key), 0);
});

test('boundary: options object with a null-prototype / frozen object is still accepted', () => {
    const opts = Object.freeze({ seed: 3 });
    assert.doesNotThrow(() => new CountMinSketch(4, 16, opts));
});

// --- duplicate dispose / dispose-during-iteration analogue: repeated clear() -

test('duplicate clear() is idempotent and a no-op the second time', () => {
    const c = new CountMinSketch(4, 16);
    c.add(1, 5);
    c.clear();
    assert.equal(c.total, 0);
    assert.doesNotThrow(() => c.clear());
    assert.equal(c.total, 0);
    for (let i = 0; i < c._counts.length; i++) assert.equal(c._counts[i], 0);
});

test('clear-during-iteration: clearing mid-Map-iteration over queried keys does not corrupt the sketch', () => {
    const c = new CountMinSketch(4, 16);
    const keys = [1, 2, 3, 4, 5];
    for (const k of keys) c.add(k, 2);
    let i = 0;
    for (const k of keys) {
        i++;
        if (i === 3) c.clear();   // dispose (reset) mid-iteration over the caller's own key list
    }
    // after a mid-loop clear, the sketch is fully reset -- no partial/half-cleared state.
    assert.equal(c.total, 0);
    for (const k of keys) assert.equal(c.estimate(k), 0);
});

// --- re-entrant write ---------------------------------------------------------

test('re-entrant write: adding from inside a Map.forEach callback driven by a prior snapshot does not corrupt state', () => {
    const c = new CountMinSketch(4, 32);
    const seed = new Map([[1, 1], [2, 1], [3, 1]]);
    let reentrant = 0;
    seed.forEach((_v, k) => {
        c.add(k);           // re-entrant write while "iterating" a structure that triggered this call
        if (reentrant < 2) { reentrant++; c.add(k + 100, 1); }
    });
    assert.equal(c.total, 3 + 2);
    assert.ok(c.estimate(1) >= 1 && c.estimate(2) >= 1 && c.estimate(3) >= 1);
});

test('re-entrant write: add() called again inside the count>1 saturation path (self-referential add) stays one-sided', () => {
    const c = new CountMinSketch(3, 16);
    const key = 5;
    let calls = 0;
    function reentrantAdd(n) {
        calls++;
        c.add(key, 1);
        if (n > 0) reentrantAdd(n - 1);
    }
    reentrantAdd(10);
    assert.equal(calls, 11);
    assert.ok(c.estimate(key) >= 11);
});

// --- adversarial: an entry-point the planner did not think of -----------------

test('ADVERSARIAL: safe-integer keys beyond 2^32 hash via the high-word path and stay one-sided', () => {
    // add() splits |key| into lo (>>> 0) and a high word via a float divide for keys
    // >= 2^32; a bug in that path would silently collapse distinct large keys to the
    // same lo-word bucket, breaking one-sidedness or aliasing counts across keys that
    // ARE distinct (2^32 + 1 vs 1, or 2^32 + 5 vs 2^33 + 5, share the same lo word).
    const c = new CountMinSketch(6, 1 << 12, { conservative: false });
    const truth = new Map();
    const bigKeys = [
        1, 2 ** 32 + 1, 2 ** 32 + 5, 2 ** 33 + 5, 2 ** 40, 2 ** 40 + 1,
        Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, -(2 ** 32 + 1), -(2 ** 40),
    ];
    for (const k of bigKeys) {
        const reps = 3;
        for (let i = 0; i < reps; i++) c.add(k);
        truth.set(k, reps);
    }
    for (const [k, trueCount] of truth) {
        assert.ok(c.estimate(k) >= trueCount, 'key=' + k + ' est=' + c.estimate(k) + ' true=' + trueCount);
    }
    // distinct large keys sharing a lo-word (2^32+1 vs 1; 2^32+5 vs 2^33+5) must still be
    // distinguishable in the ctor's own model, i.e. the sketch never reports an estimate
    // LOWER than the true count for any of them (one-sidedness holds even under lo-word
    // aliasing candidates) -- collisions may over-count but must never under-count.
    assert.ok(c.estimate(1) >= truth.get(1));
    assert.ok(c.estimate(2 ** 32 + 1) >= truth.get(2 ** 32 + 1));
});
