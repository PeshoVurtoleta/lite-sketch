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
import { CountMinSketch, mix64, hashHi, hashLo, VERSION } from '../Sketch.js';

const liteSketch = (e) => e instanceof Error && /^\[lite-sketch]/.test(e.message);

// Cold test helpers: the adjacent double below x, via a bit view (probe the exact edges).
function nextDown(x) {
    const f = new Float64Array([x]);
    const u = new BigUint64Array(f.buffer);
    u[0] -= 1n;
    return f[0];
}

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
    assert.equal(c.saturated, false);              // F14: fresh sketch is not saturated
    c.add(42, 0xffffffff);
    assert.equal(c.saturated, false);              // an exact 2^32-1 counter has NOT clamped
    c.add(42, 5);
    assert.equal(c.estimate(42), 0xffffffff);
    assert.equal(c.saturated, true);               // the clamp set the sticky flag
});

test('saturation via _applyPlain path caps at 0xffffffff, no wraparound (conservative:false)', () => {
    const c = new CountMinSketch(3, 16, { conservative: false });
    assert.equal(c.saturated, false);
    c.add(42, 0xffffffff);
    assert.equal(c.saturated, false);
    c.add(42, 5);
    assert.equal(c.estimate(42), 0xffffffff);
    assert.equal(c.saturated, true);
});

test('saturation: merge of two near-max plain sketches caps at 0xffffffff', () => {
    const a = new CountMinSketch(3, 16, { conservative: false, seed: 1 });
    const b = new CountMinSketch(3, 16, { conservative: false, seed: 1 });
    a.add(7, 0xfffffffe);
    b.add(7, 10);
    assert.equal(a.saturated, false);
    a.merge(b);
    assert.equal(a.estimate(7), 0xffffffff);
    assert.equal(a.saturated, true);               // the merge clamp set it
});

// --- withAccuracy derivation -------------------------------------------------

test('withAccuracy(0.001, 0.01) derives d=5, w=4096 exactly', () => {
    const c = CountMinSketch.withAccuracy(0.001, 0.01);
    assert.equal(c.d, 5);
    assert.equal(c.w, 4096);
});

test('withAccuracy REGRESSION: an unattainable epsilon throws tagged (F16/S6) without hanging', () => {
    // F16/S6: a w > 2^25 request is now rejected, not clamped. The no-hang regression still
    // holds -- the throw is immediate (the int32 round-up loop is never reached).
    const start = Date.now();
    assert.throws(() => CountMinSketch.withAccuracy(1e-9, 0.01), liteSketch);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, 'withAccuracy(1e-9, ...) took ' + elapsed + 'ms (regression: must not hang)');
});

test('withAccuracy clamps d UP to >= 1 but throws when d > 32 (F16/S6)', () => {
    const dTiny = CountMinSketch.withAccuracy(0.01, 0.999999999999999);
    assert.equal(dTiny.d, 1, 'd clamps UP to >= 1 (only strengthens), got ' + dTiny.d);
    assert.throws(() => CountMinSketch.withAccuracy(0.01, 1e-300), liteSketch);  // needs d > 32
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
    assert.equal(d.estimate(1.5), 0);              // F13: a key add would reject estimates 0, never aliases
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

// ===========================================================================
// H2.3 gates (F13, F14, F15, F16, F20, S7)
// ===========================================================================

const MAX_SAFE = 9007199254740991;   // 2^53 - 1
function cmsSnap(c) {
    return { counts: Array.from(c._counts), total: c.total, saturated: c.saturated };
}
function cmsUnchanged(before, c, label) {
    const a = cmsSnap(c);
    assert.deepEqual(a.counts, before.counts, label + ': _counts changed');
    assert.equal(a.total, before.total, label + ': total changed');
    assert.equal(a.saturated, before.saturated, label + ': saturated changed');
}

// G-F13: an un-addable key estimates 0, never aliases a real key (cons + plain).
for (const conservative of [true, false]) {
    test('G-F13 (' + (conservative ? 'cons' : 'plain') + '): a key add would reject estimates 0, never aliases', () => {
        const c = new CountMinSketch(4, 1024, { conservative });
        c.add(0, 50);
        c.add(1, 70);
        for (const bad of [Infinity, -Infinity, 1.5, 2 ** 64, 2 ** 53, -(2 ** 53), NaN]) {
            assert.equal(c.estimate(bad), 0, 'estimate(' + bad + ')');
        }
        assert.equal(c.estimate(0), 50);
        assert.equal(c.estimate(1), 70);
    });
}

// G-F14: the sticky `saturated` getter (F14/S4).
test('G-F14: saturated is sticky, set on a clamp, carried by merge, reset by clear', () => {
    for (const conservative of [true, false]) {
        const c = new CountMinSketch(3, 16, { conservative });
        assert.equal(c.saturated, false, 'fresh');
        c.add(5, 0xffffffff);
        assert.equal(c.saturated, false, 'exact 2^32-1 does not clamp');
        c.add(5, 10);
        assert.equal(c.saturated, true, 'clamp sets it (' + (conservative ? 'cons' : 'plain') + ')');
        c.add(6, 1);
        assert.equal(c.saturated, true, 'sticky after more adds');
        c.clear();
        assert.equal(c.saturated, false, 'clear resets it');
    }
    // a saturated other carries it into a fresh (empty) this
    const src = new CountMinSketch(3, 16, { conservative: false, seed: 9 });
    src.add(7, 0xffffffff);
    src.add(7, 1);
    assert.equal(src.saturated, true);
    const dst = new CountMinSketch(3, 16, { conservative: false, seed: 9 });
    assert.equal(dst.saturated, false);
    dst.merge(src);
    assert.equal(dst.saturated, true, 'merge carries other.saturated into an empty this');
});

// G-F15 (CMS): the total guard at 2^53-1 (F15/S5).
test('G-F15 (CMS): count cap + running-total ceiling 2^53-1, byte-identical reject', () => {
    const c = new CountMinSketch(4, 64);
    assert.doesNotThrow(() => c.add(1, 0xffffffff));        // 2^32-1 count accepted
    for (const bad of [2 ** 32, 1e308, MAX_SAFE]) {
        const before = cmsSnap(c);
        assert.throws(() => c.add(1, bad), (e) => liteSketch(e) && /\[1, 4294967295]/.test(e.message), 'count=' + bad);
        cmsUnchanged(before, c, 'count=' + bad);
    }
    // Fill to total === 2^53-1 exactly via 2^21 adds of (k, 2^32-1), then add(k, 2^21-1).
    const f = new CountMinSketch(4, 64, { conservative: false });
    for (let i = 0; i < (1 << 21); i++) f.add(1, 0xffffffff);
    f.add(1, (1 << 21) - 1);
    assert.equal(f.total, MAX_SAFE, 'total reaches exactly 2^53-1');
    // Every entry point now rejects +1 byte-identically.
    for (const fn of [() => f.add(2, 1), () => f.addHashed(1, 2, 1)]) {
        const before = cmsSnap(f);
        assert.throws(fn, (e) => liteSketch(e) && /9007199254740991/.test(e.message));
        cmsUnchanged(before, f, 'total+1 reject');
    }
    // merge: this at total 2^53-6 rejects an other of total 6, accepts an other of total 5.
    // (a single count caps at 2^32-1, so build the big total via the same 2^21 fill.)
    const base = new CountMinSketch(4, 64, { conservative: false });
    for (let i = 0; i < (1 << 21); i++) base.add(1, 0xffffffff);
    base.add(1, (1 << 21) - 6);                    // total === 2^53 - 6 === MAX_SAFE - 5
    assert.equal(base.total, MAX_SAFE - 5);
    const other6 = new CountMinSketch(4, 64, { conservative: false });
    other6.add(2, 6);
    const b6 = cmsSnap(base);
    assert.throws(() => base.merge(other6), (e) => liteSketch(e) && /9007199254740991/.test(e.message));
    cmsUnchanged(b6, base, 'merge total+1 reject');
    const other5 = new CountMinSketch(4, 64, { conservative: false });
    other5.add(2, 5);
    assert.doesNotThrow(() => base.merge(other5));
    assert.equal(base.total, MAX_SAFE, 'merge to exactly 2^53-1 accepted');
});

// G-F16 (CMS): unattainable withAccuracy throws, attainable boundaries accept (F16/S6).
test('G-F16 (CMS): withAccuracy rejects unattainable requests, accepts the exact boundary', () => {
    // double-rounding preconditions (orchestrator-verified).
    assert.equal(Math.ceil(Math.E / (Math.E / 2 ** 25)), 2 ** 25);
    assert.equal(Math.ceil(Math.E / nextDown(Math.E / 2 ** 25)), 2 ** 25 + 1);
    assert.equal(Math.ceil(Math.log(1 / Math.exp(-31.5))), 32);
    assert.equal(Math.ceil(Math.log(1 / Math.exp(-32.5))), 33);
    // width rejects match the FACTORY's "width cap 33554432" wording (NOT the bare number, which the
    // ctor message "w must be an integer in [1, 33554432]" also contains), so a `w > CMS_W_MAX + 1`
    // mutant that merely falls through to the ctor dies -- the N+1 boundary `nextDown(E/2^25)` needs w === 2^25+1.
    const widthMsg = (e) => liteSketch(e) && /width cap 33554432/.test(e.message);
    for (const [eps, delta] of [[1e-12, 0.01], [1e-9, 0.01], [5e-324, 0.01],
        [nextDown(Math.E / 2 ** 25), 0.5]]) {
        const start = Date.now();
        assert.throws(() => CountMinSketch.withAccuracy(eps, delta), widthMsg, 'eps=' + eps);
        assert.ok(Date.now() - start < 2000);
    }
    // depth rejects match the DEPTH-cap message (/depth cap 32/) so a `d > CMS_D_MAX + 1`
    // mutant dies -- the N+1 boundary exp(-32.5) needs d === 33.
    const depthMsg = (e) => liteSketch(e) && /depth cap 32/.test(e.message);
    for (const delta of [1e-20, 1e-300, Math.exp(-32.5), 5e-324]) {
        assert.throws(() => CountMinSketch.withAccuracy(0.01, delta), depthMsg, 'delta=' + delta);
    }
    // accepts the exact boundary
    assert.equal(CountMinSketch.withAccuracy(Math.E / 2 ** 25, 0.5).w, 2 ** 25);
    assert.equal(CountMinSketch.withAccuracy(0.01, Math.exp(-31.5)).d, 32);
    assert.equal(CountMinSketch.withAccuracy(0.01, 0.999999999999999).d, 1);
});

// G-S7: a cross-flag merge is allowed, keeps this's flag, stays one-sided (pin, not a change).
test('G-S7 (CMS): cross-conservative merge is accepted, keeps this.conservative, 0 undercounts', () => {
    const rng = makeRng(7);
    for (const [thisCons, otherCons] of [[true, false], [false, true]]) {
        const a = new CountMinSketch(4, 64, { conservative: thisCons, seed: 3 });
        const b = new CountMinSketch(4, 64, { conservative: otherCons, seed: 3 });
        const truth = new Map();
        for (let i = 0; i < 5000; i++) {
            const key = (rng() * 500) | 0;
            const dst = (i & 1) ? b : a;
            dst.add(key);
            truth.set(key, (truth.get(key) || 0) + 1);
        }
        assert.doesNotThrow(() => a.merge(b));
        assert.equal(a.conservative, thisCons, 'this keeps its own flag');
        assert.equal(a.saturated, false);
        for (const [k, t] of truth) assert.ok(a.estimate(k) >= t, 'undercount key=' + k);
    }
});

// G-F20 (CMS): hostile args run NO user code; throws are tagged + byte-identical.
test('G-F20 (CMS): a rejected arg never runs caller code (tagged, calls===0, byte-identical)', () => {
    let calls = 0;
    const hostile = () => [
        Object.create(null),
        { toString() { calls++; throw new Error('boom'); } },
        { [Symbol.toPrimitive]() { calls++; cRef.add(0, 0); return 1; },
          toString() { calls++; cRef.add(0, 0); return 'x'; },
          valueOf() { calls++; cRef.add(0, 0); return 1; } },
        Object.assign(function () {}, { toString() { calls++; cRef.add(0, 0); return 'f'; } }),
    ];
    let cRef;
    // ctor slots
    for (const h of hostile()) { assert.throws(() => new CountMinSketch(h, 16), liteSketch); }
    for (const h of hostile()) { assert.throws(() => new CountMinSketch(4, h), liteSketch); }
    for (const h of hostile()) { assert.throws(() => new CountMinSketch(4, 16, { seed: h }), liteSketch); }
    for (const h of hostile()) { assert.throws(() => new CountMinSketch(4, 16, { conservative: h }), liteSketch); }
    for (const h of hostile()) { assert.throws(() => CountMinSketch.withAccuracy(h, 0.01), liteSketch); }
    for (const h of hostile()) { assert.throws(() => CountMinSketch.withAccuracy(0.01, h), liteSketch); }
    cRef = new CountMinSketch(4, 16, { seed: 1 });
    for (const h of hostile()) { const b = cmsSnap(cRef); assert.throws(() => cRef.add(h, 1), liteSketch); cmsUnchanged(b, cRef, 'add key'); }
    for (const h of hostile()) { const b = cmsSnap(cRef); assert.throws(() => cRef.add(5, h), liteSketch); cmsUnchanged(b, cRef, 'add count'); }
    for (const h of hostile()) { const b = cmsSnap(cRef); assert.throws(() => cRef.addHashed(h, 0, 1), liteSketch); cmsUnchanged(b, cRef, 'addHashed hi'); }
    for (const h of hostile()) { const b = cmsSnap(cRef); assert.throws(() => cRef.addHashed(0, h, 1), liteSketch); cmsUnchanged(b, cRef, 'addHashed lo'); }
    for (const h of hostile()) { const b = cmsSnap(cRef); assert.throws(() => cRef.addHashed(0, 0, h), liteSketch); cmsUnchanged(b, cRef, 'addHashed count'); }
    assert.equal(calls, 0, 'no hostile toString/valueOf/toPrimitive ran');
    // a null-proto object message ends in `got [object]`
    let msg = '';
    try { new CountMinSketch(Object.create(null), 16); } catch (e) { msg = e.message; }
    assert.ok(/got \[object]$/.test(msg), 'null-proto message: ' + msg);
});

// ---------------------------------------------------------------------------
// QA H2.3 boundary gaps (not in the planner's G-list):
//  (a) the merge total guard precedes the `saturated` carry: a saturated other that would
//      overflow the total leaves this.saturated false (a carry-before-guard mutant dies);
//  (b) self-merge (this === other) at the ceiling: 2^52-1 doubles to 2^53-2, then rejects;
//  (c) the _badTotal message is a RangeError printing the current total and the rejected n;
//  (d) `saturated` is getter-only at runtime; the estimate guard accepts -(2^53-1) (N).
// ---------------------------------------------------------------------------
test('QA H2.3 (CMS): merge total guard precedes the saturated carry; self-merge at the ceiling', () => {
    const o = new CountMinSketch(4, 64, { conservative: false });
    for (let i = 0; i < (1 << 21); i++) o.add(1, 0xffffffff);
    o.add(1, (1 << 21) - 6);
    assert.equal(o.total, MAX_SAFE - 5);
    assert.equal(o.saturated, true, 'precondition: other is saturated');
    const t = new CountMinSketch(4, 64, { conservative: false });
    t.add(2, 6);
    const bt = cmsSnap(t);
    assert.equal(bt.saturated, false);
    let msg = '';
    assert.throws(() => t.merge(o), (e) => { msg = e.message; return e instanceof RangeError && liteSketch(e); });
    cmsUnchanged(bt, t, 'saturated other, total+1 reject');
    assert.ok(msg.includes('current total 6 + ' + (MAX_SAFE - 5)), '_badTotal prints current total + n: ' + msg);
    // self-merge: 2^52-1 -> 2^53-2 accepted, then 2^53-2 doubled rejects with no write.
    const s = new CountMinSketch(4, 64, { conservative: false });
    for (let i = 0; i < (1 << 20); i++) s.add(1, 0xffffffff);
    s.add(1, (1 << 20) - 1);
    assert.equal(s.total, 2 ** 52 - 1);
    assert.equal(s.merge(s).total, 2 ** 53 - 2);
    const bs = cmsSnap(s);
    assert.throws(() => s.merge(s), (e) => e instanceof RangeError && liteSketch(e) && /9007199254740991/.test(e.message));
    cmsUnchanged(bs, s, 'self-merge total+1 reject');
    // add-path message prints the current total and the rejected count.
    assert.throws(() => s.add(3, 2), (e) => e instanceof RangeError &&
        e.message.includes('current total ' + (2 ** 53 - 2) + ' + 2'));
});

test('QA H2.3 (CMS): saturated is getter-only; estimate accepts the -(2^53-1) boundary key', () => {
    const c = new CountMinSketch(4, 1024);
    assert.throws(() => { c.saturated = true; }, TypeError);
    assert.equal(c.saturated, false);
    c.add(-MAX_SAFE, 4);
    c.add(MAX_SAFE, 3);
    assert.ok(c.estimate(-MAX_SAFE) >= 4, 'N: -(2^53-1) is addable so it estimates');
    assert.ok(c.estimate(MAX_SAFE) >= 3);
    assert.equal(c.estimate(-(MAX_SAFE + 2)), 0, 'N+1 (2^53 rounded) estimates 0');
});

// ===========================================================================
// G-F12 (CMS hash sign bit): a negative key never aliases its 2^32-shifted twin.
// FAILs on HEAD (where add(-7,100) made estimate(2**32+7) read 100).
// ===========================================================================

for (const conservative of [false, true]) {
    test('G-F12 (CMS ' + (conservative ? 'cons' : 'plain') + ' 4x1024): add(-7,100) ' +
        'does not alias 2**32+7, and estimate(-7) is exact', () => {
        const c = new CountMinSketch(4, 1024, { conservative, seed: 7 });
        c.add(-7, 100);
        assert.equal(c.estimate(2 ** 32 + 7), 0, '2**32+7 must not collide with -7 (HEAD: 100)');
        assert.equal(c.estimate(-7), 100, '-7 estimates its own exact count');
    });
}

test('G-F12 (CMS site consistency): add(k,c) == addHashed(mix64(k, seed), c) over mixed-sign keys', () => {
    // Passes on HEAD too -- proves the add site uses the SAME hash as mix64.
    const a = new CountMinSketch(4, 1024, { seed: 7 }), b = new CountMinSketch(4, 1024, { seed: 7 });
    for (const k of [-5, 2 ** 40 + 3, 7, -1, 2 ** 32 + 1, -(2 ** 53 - 1), -(2 ** 32), 0, -0]) {
        a.add(k, 3);
        mix64(k, a.seed);
        b.addHashed(hashHi(), hashLo(), 3);
    }
    let d = 0;
    for (let i = 0; i < a._counts.length; i++) if (a._counts[i] !== b._counts[i]) d++;
    assert.equal(d, 0, 'CMS add and addHashed(mix64) must set identical counts');
});

for (const conservative of [false, true]) {
    test('QA H2.4 (CMS ' + (conservative ? 'cons' : 'plain') + ' site consistency, boundary matrix): ' +
        'add AND estimate both hash exactly as mix64 (estimate == estimateHashed per key)', () => {
        // Gap: the existing site test covers add only; the estimate site (its own inline
        // murmur) had no direct consistency check, and no |k| in [2^31, 2^32) negative.
        const KS = [0, -0, 1, -1, -(2 ** 31 - 1), -(2 ** 31), -(2 ** 31) - 1, -(2 ** 32 - 1), -(2 ** 32),
            -(2 ** 32 + 1), 2 ** 31, 2 ** 32 - 1, -(2 ** 40 + 104729), -(2 ** 52), -(2 ** 53 - 2),
            -(2 ** 53 - 1), 2 ** 53 - 1, -((2 ** 21 - 1) * 4294967296)];
        const a = new CountMinSketch(4, 256, { conservative, seed: 7 });
        const b = new CountMinSketch(4, 256, { conservative, seed: 7 });
        let n = 0;
        for (const k of KS) {
            n++;
            a.add(k, n);
            mix64(k, a.seed);
            b.addHashed(hashHi(), hashLo(), n);
        }
        let d = 0;
        for (let i = 0; i < a._counts.length; i++) if (a._counts[i] !== b._counts[i]) d++;
        assert.equal(d, 0, 'add vs addHashed(mix64) counts');
        let bad = '';
        // probe every added key AND unseen twins (-(k) for positives, +|k| for negatives).
        for (const k0 of KS) {
            for (const k of [k0, -k0, k0 - 1]) {
                if (Math.abs(k) > 9007199254740991) continue;
                mix64(k, a.seed);
                if (a.estimate(k) !== a.estimateHashed(hashHi(), hashLo())) bad += k + ' ';
            }
        }
        assert.equal(bad, '', 'estimate != estimateHashed(mix64) for: ' + bad);
    });
}

// ===========================================================================================
// H2.5 F4 -- argument-free CMS helpers (_applyCons/_applyPlain read _base/_cnt; per-row fmix
// hand-inlined). Parity-type: passes on HEAD too (behavior byte-identical). The FAIL-on-HEAD
// teeth are test/lanes.mjs. The interleave test also proves _base/_cnt are PER-INSTANCE.
// ===========================================================================================
const H25_ODD = 0x9e3779b1 | 0, H25_FC1 = 0x85ebca6b | 0, H25_FC2 = 0xc2b2ae35 | 0;
function h25fmix32(h) {
    h = h ^ (h >>> 16); h = Math.imul(h, H25_FC1); h = h ^ (h >>> 13); h = Math.imul(h, H25_FC2); h = h ^ (h >>> 16);
    return h;
}
// The d columns a key with lanes (hi, lo) fills: base = (hi ^ lo)|0, col_i = fmix(base ^ i*ODD) & (w-1).
function h25cols(hi, lo, d, w) {
    const base = (hi ^ lo) | 0;
    const cols = [];
    for (let i = 0; i < d; i++) cols.push(h25fmix32((base ^ Math.imul(i, H25_ODD)) | 0) & (w - 1));
    return cols;
}
function h25cmsEqual(a, b, keys, label) {
    let d = 0;
    for (let i = 0; i < a._counts.length; i++) if (a._counts[i] !== b._counts[i]) d++;
    assert.equal(d, 0, label + ': _counts drift');
    assert.equal(a.total, b.total, label + ': total');
    assert.equal(a.saturated, b.saturated, label + ': saturated');
    for (const k of keys) assert.equal(a.estimate(k), b.estimate(k), label + ': estimate(' + k + ')');
}

test('H2.5 F4 (CMS add fills exactly the reference fmix32 columns): add(k, 2^31+5) at (7,64), ' +
    'cons + plain, then add(k, 2^31) saturates to 2^32-1', () => {
    for (const conservative of [true, false]) {
        const s = new CountMinSketch(7, 64, { conservative });
        const k = 12345;
        mix64(k, s.seed);
        const cols = h25cols(hashHi(), hashLo(), 7, 64);
        s.add(k, 2 ** 31 + 5);
        for (let i = 0; i < 7; i++) {
            assert.equal(s._counts[i * 64 + cols[i]], 2 ** 31 + 5, 'cons=' + conservative + ' row ' + i + ' cell');
        }
        let nz = 0;
        for (let j = 0; j < s._counts.length; j++) if (s._counts[j] !== 0) nz++;
        assert.equal(nz, 7, 'cons=' + conservative + ': exactly d cells set');
        assert.equal(s.estimate(k), 2 ** 31 + 5, 'cons=' + conservative + ': estimate pre-saturate');
        assert.equal(s.saturated, false);
        s.add(k, 2 ** 31);                                   // pushes every cell past 2^32-1
        assert.equal(s.estimate(k), 2 ** 32 - 1, 'cons=' + conservative + ': estimate saturated');
        assert.equal(s.saturated, true, 'cons=' + conservative + ': saturated flag');
    }
});

test('H2.5 F4 (CMS addHashed fills exactly the reference fmix32 columns): addHashed(hi,lo,2^31+5) ' +
    'at (7,64), cons + plain, then addHashed(hi,lo,2^31) saturates', () => {
    for (const conservative of [true, false]) {
        const s = new CountMinSketch(7, 64, { conservative });
        const hi = 0xdeadbeef, lo = 0x12345678;
        const cols = h25cols(hi, lo, 7, 64);
        s.addHashed(hi, lo, 2 ** 31 + 5);
        for (let i = 0; i < 7; i++) {
            assert.equal(s._counts[i * 64 + cols[i]], 2 ** 31 + 5, 'cons=' + conservative + ' row ' + i + ' cell');
        }
        let nz = 0;
        for (let j = 0; j < s._counts.length; j++) if (s._counts[j] !== 0) nz++;
        assert.equal(nz, 7, 'cons=' + conservative + ': exactly d cells set');
        assert.equal(s.estimateHashed(hi, lo), 2 ** 31 + 5, 'cons=' + conservative + ': estimate pre-saturate');
        assert.equal(s.saturated, false);
        s.addHashed(hi, lo, 2 ** 31);
        assert.equal(s.estimateHashed(hi, lo), 2 ** 32 - 1, 'cons=' + conservative + ': estimate saturated');
        assert.equal(s.saturated, true, 'cons=' + conservative + ': saturated flag');
    }
});

test('H2.5 F4 (CMS interleaved instances == solo twins): _base/_cnt are PER-INSTANCE, so ' +
    'time-interleaving two sketches gives the same state as building each alone', () => {
    for (const conservative of [true, false]) {
        const a = new CountMinSketch(7, 64, { conservative });
        const b = new CountMinSketch(7, 64, { conservative });
        const aSolo = new CountMinSketch(7, 64, { conservative });
        const bSolo = new CountMinSketch(7, 64, { conservative });
        // mix of add (hashed-internally) and addHashed, counts incl. >= 2^31.
        const aOps = [['k', 11, 2 ** 31 + 1], ['k', 22, 2 ** 30], ['k', 11, 3], ['h', 7, 9, 2 ** 32 - 1]];
        const bOps = [['k', 44, 2 ** 31 + 7], ['h', 3, 5, 5], ['k', 55, 2 ** 31], ['k', 11, 2 ** 30]];
        const apply = (s, op) => (op[0] === 'k' ? s.add(op[1], op[2]) : s.addHashed(op[1], op[2], op[3]));
        const n = Math.max(aOps.length, bOps.length);
        for (let i = 0; i < n; i++) {
            if (i < aOps.length) { apply(a, aOps[i]); apply(aSolo, aOps[i]); }
            if (i < bOps.length) { apply(b, bOps[i]); apply(bSolo, bOps[i]); }
        }
        h25cmsEqual(a, aSolo, [11, 22, 44, 55], 'cons=' + conservative + ' a');
        h25cmsEqual(b, bSolo, [11, 22, 44, 55], 'cons=' + conservative + ' b');
    }
});

// ===========================================================================================
// QA H2.5 -- boundary tests a mis-port of the argument-free helpers / inlined per-row fmix would
// fail. All but the last pass on HEAD too (parity-type); the last is NEW-CODE ONLY (_base/_cnt).
// ===========================================================================================
test('QA H2.5 (CMS d=1/w=1, d=32, count 2^32-1 via addHashed): every row fills exactly the reference ' +
    'column at 2^32-1 WITHOUT saturating; one more unit clamps and sets saturated (cons + plain)', () => {
    // lanes chosen for adversarial bases: hi^lo = 0, = int32 min (-2^31), = -1, and a generic pair
    const lanes = [[0x12345678, 0x12345678], [0x80000000, 0], [0xffffffff, 0], [0, 0xffffffff], [0xdeadbeef, 0x0badf00d]];
    for (const [d, w] of [[1, 1], [32, 1], [32, 1024], [1, 4096]]) {
        for (const conservative of [true, false]) {
            for (const [hi, lo] of lanes) {
                const tag = 'd=' + d + ' w=' + w + ' cons=' + conservative + ' lanes=' + hi + ',' + lo;
                const s = new CountMinSketch(d, w, { conservative });
                const cols = h25cols(hi, lo, d, w);
                s.addHashed(hi, lo, 4294967295);
                let nz = 0;
                for (let j = 0; j < s._counts.length; j++) if (s._counts[j] !== 0) nz++;
                assert.equal(nz, d, tag + ': exactly d cells');
                for (let i = 0; i < d; i++) assert.equal(s._counts[i * w + cols[i]], 4294967295, tag + ' row ' + i);
                assert.equal(s.saturated, false, tag + ': 2^32-1 exactly is NOT a clamp');
                assert.equal(s.estimateHashed(hi, lo), 4294967295, tag);
                s.addHashed(hi, lo, 1);
                assert.equal(s.saturated, true, tag + ': the next unit clamps');
                assert.equal(s.estimateHashed(hi, lo), 4294967295, tag + ': clamped');
                assert.equal(s.total, 4294967296, tag + ': total stays exact past the cell clamp');
            }
        }
    }
});

test('QA H2.5 (CMS rejected add/addHashed between valid adds): the reject leaves _counts / total / ' +
    'saturated byte-identical, and the NEXT valid add is unaffected by the reject (== a twin that never ' +
    'saw it) -- counts differ op-to-op so a stale count / base would show', () => {
    for (const conservative of [true, false]) {
        const s = new CountMinSketch(7, 64, { conservative });
        const twin = new CountMinSketch(7, 64, { conservative });
        const ops = [
            ['k', 2 ** 31, 2 ** 31 + 5], ['h', 0x80000000, 1, 3], ['k', -(2 ** 53 - 1), 1],
            ['k', 9, 2 ** 32 - 1], ['h', 5, 6, 2 ** 30], ['k', 2 ** 31, 7],
        ];
        const rejects = [
            () => s.add(123456789, 0), () => s.add(123456789, 2 ** 32), () => s.add(1.5, 99),
            () => s.add(2 ** 53, 99), () => s.add(NaN, 99), () => s.addHashed(2 ** 32, 1, 99),
            () => s.addHashed(1, -1, 99), () => s.addHashed(1, 1, 2 ** 31 + 0.5),
        ];
        const apply = (x, op) => (op[0] === 'k' ? x.add(op[1], op[2]) : x.addHashed(op[1], op[2], op[3]));
        for (let i = 0; i < ops.length; i++) {
            for (const bad of rejects) {
                const before = cmsSnap(s);
                assert.throws(bad, liteSketch, 'cons=' + conservative + ' op ' + i);
                cmsUnchanged(before, s, 'cons=' + conservative + ' op ' + i);
            }
            apply(s, ops[i]); apply(twin, ops[i]);
            assert.deepEqual(Array.from(s._counts), Array.from(twin._counts), 'cons=' + conservative + ' op ' + i + ': stale scratch');
            assert.equal(s.total, twin.total);
            assert.equal(s.saturated, twin.saturated);
        }
        // total-ceiling reject: push total to 2^53-1 - 2 on a scratch twin pair via merge doubling
        const a = new CountMinSketch(2, 4, { conservative: false });
        a.addHashed(1, 2, 4294967295);
        for (let r = 0; r < 21; r++) a.merge(a);              // total = (2^32-1) * 2^21 < 2^53-1
        const room = MAX_SAFE - a.total;
        const before = cmsSnap(a);
        assert.throws(() => a.add(77, Math.min(room + 1, 4294967295)), (e) => liteSketch(e) && /9007199254740991/.test(e.message));
        cmsUnchanged(before, a, 'total-ceiling reject');
    }
});

test('QA H2.5 (CMS plain merge then add with counts >= 2^31): merge(a, b) then add == one sketch fed ' +
    'the whole stream (plain merge is exact; the scratch is not touched by merge)', () => {
    const a = new CountMinSketch(5, 128, { conservative: false });
    const b = new CountMinSketch(5, 128, { conservative: false });
    const all = new CountMinSketch(5, 128, { conservative: false });
    for (let i = 0; i < 300; i++) {
        const k = (i & 1) ? -(2 ** 31) - i : 2 ** 32 + i, c = [1, 2 ** 31 + (i & 7), 2 ** 30][i % 3];
        ((i & 2) ? a : b).add(k, c); all.add(k, c);
    }
    a.merge(b);
    for (let i = 0; i < 50; i++) { a.add(2 ** 31 + i, 2 ** 31 + 1); all.add(2 ** 31 + i, 2 ** 31 + 1); }
    a.addHashed(0xffffffff, 1, 2 ** 31); all.addHashed(0xffffffff, 1, 2 ** 31);
    assert.deepEqual(Array.from(a._counts), Array.from(all._counts));
    assert.equal(a.total, all.total);
    assert.equal(a.saturated, all.saturated);
});

test('QA H2.5 (CMS _base/_cnt scratch, NEW-CODE ONLY): per-instance Int32Array(1) / Float64Array(1); ' +
    'a rejected add never writes them; a valid add leaves exactly (hi^lo)|0 and the count', () => {
    for (const conservative of [true, false]) {
        const s = new CountMinSketch(4, 1024, { conservative });
        const t = new CountMinSketch(4, 1024, { conservative });
        assert.ok(s._base instanceof Int32Array && s._base.length === 1);
        assert.ok(s._cnt instanceof Float64Array && s._cnt.length === 1);
        assert.notEqual(s._base, t._base);
        assert.notEqual(s._cnt, t._cnt);
        s.addHashed(0x80000000, 0, 2 ** 32 - 1);
        assert.equal(s._base[0], -2147483648);
        assert.equal(s._cnt[0], 4294967295);
        assert.equal(t._cnt[0], 0, 'twin scratch untouched');
        for (const bad of [() => s.add(5, 0), () => s.add(0.5, 3), () => s.addHashed(1, 2, 2 ** 32), () => s.addHashed(-1, 2, 3)]) {
            assert.throws(bad, liteSketch);
            assert.equal(s._base[0], -2147483648, 'cons=' + conservative + ': reject wrote _base');
            assert.equal(s._cnt[0], 4294967295, 'cons=' + conservative + ': reject wrote _cnt');
        }
        mix64(-7, s.seed);
        const hi = hashHi(), lo = hashLo();
        s.add(-7, 2 ** 31 + 9);
        assert.equal(s._base[0], (hi ^ lo) | 0, 'cons=' + conservative + ': add base == (hi^lo)|0 of mix64');
        assert.equal(s._cnt[0], 2 ** 31 + 9);
    }
});

// ===========================================================================
// H2.6 F5/F6 -- addFrom / addHashedFrom (the zero-box entry points), D2 + D3.
// addFrom reads key = buf[i], count = buf[i+1] UNBOXED; addHashedFrom reads
// [hi, lo, count] with addHashed's exact count guard (D2); estimate returns the
// cell-min via _buf[1] (D3). Twins vs add / addHashed, tagged rejects (no-op).
// ===========================================================================
for (const conservative of [true, false]) {
    test('H2.6 (CMS ' + (conservative ? 'cons' : 'plain') + '): add and addFrom build byte-identical state (counts incl 2^31)', () => {
        const a = new CountMinSketch(7, 64, { conservative }), b = new CountMinSketch(7, 64, { conservative });
        const F = new Float64Array(3);
        const keys = [0, -0, 1, -1, 2 ** 30, 2 ** 31, -(2 ** 31), 2 ** 32 - 1, 2 ** 32 + 7, -(2 ** 32 + 7), 2 ** 53 - 1, -(2 ** 53 - 1)];
        let t = 0;
        for (const k of keys) { const cn = (t++ & 1) ? 2 ** 31 + (t & 7) : 1 + (t & 3); a.add(k, cn); F[1] = k; F[2] = cn; b.addFrom(F, 1); }
        assert.deepEqual(Array.from(a._counts), Array.from(b._counts), 'addFrom _counts != add');
        assert.equal(a.total, b.total, 'total'); assert.equal(a.saturated, b.saturated, 'saturated');
        for (const k of keys.concat([1.5, NaN, Infinity, 2 ** 53])) assert.equal(a.estimate(k), b.estimate(k), 'estimate ' + k);
    });
}

test('H2.6 (CMS): estimate returns a large (>= 2^31) cell-min exactly, and 0 for a rejected key (value check only; the D3 zero-box teeth is the N1e lane)', () => {
    const s = new CountMinSketch(4, 1024, { conservative: false });
    s.add(7, 2 ** 31);
    assert.equal(s.estimate(7), 2 ** 31, 'a >= 2^31 min must round-trip exactly (not a boxed/truncated return)');
    s.add(7, 2 ** 31);                                   // 2^32 -> clamps to 2^32-1
    assert.equal(s.estimate(7), 0xffffffff);
    assert.equal(s.saturated, true);
    assert.equal(s.estimate(1.5), 0, 'a non-integer key estimates 0 (D3 writes _buf[1] = 0)');
    assert.equal(s.estimate(2 ** 53), 0, 'an out-of-safe-range key estimates 0');
});

test('H2.6 (CMS): addHashedFrom (Uint32Array and Int32Array) equals addHashed(hi, lo, count)', () => {
    for (const conservative of [true, false]) {
        const a = new CountMinSketch(7, 64, { conservative }), b = new CountMinSketch(7, 64, { conservative });
        const U = new Uint32Array(3), I = new Int32Array(3);
        for (let t = 0; t < 4000; t++) {
            const hi = Math.imul(t + 1, 2654435761) >>> 0, lo = Math.imul(t ^ 0x5bd1e995, 40503) >>> 0, cn = 1 + (t & 7);
            a.addHashed(hi, lo, cn); U[0] = hi; U[1] = lo; U[2] = cn; b.addHashedFrom(U, 0);
        }
        assert.deepEqual(Array.from(a._counts), Array.from(b._counts), 'addHashedFrom U32 != addHashed');
        assert.equal(a.total, b.total);
        // Int32 lanes are the same 32 bits; a separate pair must agree.
        const c = new CountMinSketch(7, 64, { conservative }), d = new CountMinSketch(7, 64, { conservative });
        for (let t = 0; t < 2000; t++) {
            const hi = (t * -2654435761) | 0, lo = (t ^ 0x5bd1e995) | 0, cn = 1 + (t & 3);
            c.addHashed(hi >>> 0, lo >>> 0, cn); I[0] = hi; I[1] = lo; I[2] = cn; d.addHashedFrom(I, 0);
        }
        assert.deepEqual(Array.from(c._counts), Array.from(d._counts), 'addHashedFrom I32 != addHashed');
    }
});

test('H2.6 (CMS): addFrom rejects a bad buffer / index (needs i and i+1 in range), byte-identical no-op', () => {
    const c = new CountMinSketch(4, 64); c.add(5, 3);
    const before = cmsSnap(c);
    const F = new Float64Array(2);
    for (const bad of [new Float32Array(2), new Int32Array(2), [1, 2], new DataView(new ArrayBuffer(16)), null, undefined, {}]) {
        assert.throws(() => c.addFrom(bad, 0), (e) => e instanceof TypeError && /\[lite-sketch\] CountMinSketch\.addFrom/.test(e.message), 'buf ' + String(bad));
    }
    for (const i of [0.5, -1, NaN, Infinity, 1, 2]) {   // length 2 -> only i = 0 keeps i+1 in bounds
        assert.throws(() => c.addFrom(F, i), (e) => e instanceof TypeError && /CountMinSketch\.addFrom/.test(e.message), 'i ' + i);
    }
    cmsUnchanged(before, c, 'bad addFrom');
});

test('H2.6 (CMS): a key or count addFrom would reject throws add\'s exact error, byte-identical no-op', () => {
    const c = new CountMinSketch(4, 64); c.add(9, 2);
    const F = new Float64Array(2);
    for (const [k, cn] of [[1.5, 1], [2 ** 53, 1], [Infinity, 1], [NaN, 1], [1, 0], [1, 2 ** 32], [5, 1.5], [5, -1]]) {
        const before = cmsSnap(c);
        F[0] = k; F[1] = cn;
        let eAdd = null, eFrom = null;
        try { c.add(k, cn); } catch (e) { eAdd = e; }
        try { c.addFrom(F, 0); } catch (e) { eFrom = e; }
        assert.ok(eFrom, 'addFrom(' + k + ',' + cn + ') did not throw');
        assert.equal(eFrom.constructor, eAdd.constructor, k + ',' + cn + ' class');
        assert.equal(eFrom.message, eAdd.message, k + ',' + cn + ' message');
        cmsUnchanged(before, c, 'reject ' + k + ',' + cn);
    }
});

test('H2.6 (CMS): addHashedFrom rejects bad buffer / index / count; D2 catches a Proxy NaN count as _badCount', () => {
    const c = new CountMinSketch(4, 64);
    const before = cmsSnap(c);
    assert.throws(() => c.addHashedFrom(new Float64Array(3), 0), (e) => e instanceof TypeError && /addHashedFrom/.test(e.message), 'Float64Array');
    assert.throws(() => c.addHashedFrom(new Uint32Array(3), 1), (e) => e instanceof TypeError, 'i = length - 2 -> i+2 out of range');
    assert.throws(() => c.addHashedFrom(new Uint32Array(3), -1), (e) => e instanceof TypeError, 'i = -1');
    assert.throws(() => c.addHashedFrom(new Uint32Array([1, 2, 0]), 0), (e) => liteSketch(e) && /count must be an integer/.test(e.message), 'count 0');
    assert.throws(() => c.addHashedFrom(new Int32Array([1, 2, -1]), 0), (e) => liteSketch(e) && /count must be an integer/.test(e.message), 'Int32 count -1');
    // D2 TEETH: a Proxy over a Uint32Array passes instanceof but yields NaN for the count slot.
    // addHashed's verbatim guard (!Number.isInteger) rejects it; without D2, NaN would slip through
    // and write _cnt[0] = NaN, corrupting total -- so cmsUnchanged would catch the mis-port.
    const px = new Proxy(new Uint32Array([123, 456, 0]), { get(t, k) { return k === '2' ? NaN : t[k]; } });
    assert.throws(() => c.addHashedFrom(px, 0), (e) => e instanceof RangeError && /count must be an integer/.test(e.message), 'Proxy NaN count -> _badCount (D2)');
    cmsUnchanged(before, c, 'addHashedFrom rejects');
});

test('H2.6 (CMS): addFrom / addHashedFrom honor the running-total ceiling 2^53-1 (byte-identical)', () => {
    const f = new CountMinSketch(4, 64, { conservative: false });
    for (let i = 0; i < (1 << 21); i++) f.add(1, 0xffffffff);
    f.add(1, (1 << 21) - 1);
    assert.equal(f.total, MAX_SAFE, 'total reaches exactly 2^53-1');
    const F = new Float64Array([2, 1]), U = new Uint32Array([1, 2, 1]);
    for (const fn of [() => f.addFrom(F, 0), () => f.addHashedFrom(U, 0)]) {
        const before = cmsSnap(f);
        assert.throws(fn, (e) => liteSketch(e) && /9007199254740991/.test(e.message));
        cmsUnchanged(before, f, 'total+1 reject');
    }
});

test('H2.6 (CMS): _buf is per instance -- interleaved addFrom instances equal solo twins', () => {
    const x = new CountMinSketch(5, 128), y = new CountMinSketch(5, 128), xs = new CountMinSketch(5, 128), ys = new CountMinSketch(5, 128);
    const F = new Float64Array(2);
    for (let k = 0; k < 3000; k++) {
        F[0] = (k * 2654435761) % (2 ** 40); F[1] = 1 + (k & 7); x.addFrom(F, 0); xs.addFrom(F, 0);
        F[0] = -((k * 40503) % (2 ** 35)); F[1] = 2 ** 31 + (k & 3); y.addFrom(F, 0); ys.addFrom(F, 0);
    }
    assert.deepEqual(Array.from(x._counts), Array.from(xs._counts), 'interleaved x != solo');
    assert.deepEqual(Array.from(y._counts), Array.from(ys._counts), 'interleaved y != solo');
    assert.equal(x.total, xs.total); assert.equal(y.total, ys.total);
});

// ===========================================================================
// H2.6 TEETH -- exact HEAD (key,count) error literals (kills a count-first _badArgs
// mutant, which add==addFrom equivalence cannot catch) + addHashedFrom fail-closed.
// ===========================================================================
test('H2.6 (CMS TEETH): add pins HEAD\'s exact (key,count) error class + message (kills a count-first _badArgs)', () => {
    const sym = Symbol('z');
    const LITS = [
        [NaN, 'x', 'TypeError', '[lite-sketch] CountMinSketch.add key must be a number, got NaN'],
        ['1', NaN, 'TypeError', '[lite-sketch] CountMinSketch.add key must be a number, got 1'],
        [1, '2', 'RangeError', '[lite-sketch] CountMinSketch count must be an integer in [1, 4294967295], got 2'],
        [1.5, sym, 'TypeError', '[lite-sketch] CountMinSketch.add key must be a number, got 1.5'],
        [1, 2 ** 32, 'RangeError', '[lite-sketch] CountMinSketch count must be an integer in [1, 4294967295], got 4294967296'],
        [1, null, 'RangeError', '[lite-sketch] CountMinSketch count must be an integer in [1, 4294967295], got null'],
    ];
    const c = new CountMinSketch(4, 16); c.add(3, 2);
    const before = cmsSnap(c);
    const F = new Float64Array(2);
    for (const [k, cn, cls, msg] of LITS) {
        assert.throws(() => c.add(k, cn), (e) => e.constructor.name === cls && e.message === msg, 'add(' + String(k) + ',' + String(cn) + ')');
        // addFrom reaches _addAt only for numeric (key, count); those must give the SAME literal.
        if (typeof k === 'number' && typeof cn === 'number') { F[0] = k; F[1] = cn; assert.throws(() => c.addFrom(F, 0), (e) => e.constructor.name === cls && e.message === msg, 'addFrom(' + String(k) + ',' + String(cn) + ')'); }
    }
    cmsUnchanged(before, c, 'teeth rejects');
});

test('H2.6 (CMS TEETH): addHashedFrom fails closed on a non-int32 lane (Proxy / overridden length), byte-identical no-op', () => {
    const c = new CountMinSketch(4, 64); c.add(9, 5);
    const before = cmsSnap(c);
    for (const v of [undefined, 'x', NaN, 2 ** 40, -1.5, Infinity, null, 1.5]) {
        const pHi = new Proxy(new Uint32Array([0, 123, 1]), { get(t, k) { return k === '0' ? v : t[k]; } });
        assert.throws(() => c.addHashedFrom(pHi, 0),
            (e) => e instanceof TypeError && e.message === '[lite-sketch] CountMinSketch.addHashed lanes must be uint32, got ' + String(v), 'hi=' + String(v));
        const pLo = new Proxy(new Uint32Array([123, 0, 1]), { get(t, k) { return k === '1' ? v : t[k]; } });
        assert.throws(() => c.addHashedFrom(pLo, 0),
            (e) => e instanceof TypeError && /addHashed lanes must be uint32/.test(e.message), 'lo=' + String(v));
    }
    class Evil extends Uint32Array { get length() { return 99; } }   // backing 0, lies as 99 -> hi reads undefined
    assert.throws(() => c.addHashedFrom(new Evil(0), 0),
        (e) => e instanceof TypeError && /addHashed lanes must be uint32/.test(e.message));
    cmsUnchanged(before, c, 'bad lane');
});

test('H2.6 (CMS): addHashedFrom accepts an Int32Array (negative lanes reinterpreted) == addHashed', () => {
    for (const conservative of [true, false]) {
        const a = new CountMinSketch(5, 256, { conservative }), b = new CountMinSketch(5, 256, { conservative });
        const I = new Int32Array(3);
        for (let t = 0; t < 2000; t++) {
            const hi = (t * -2654435761) | 0, lo = (t ^ 0x5bd1e995) | 0, cn = 1 + (t & 7);
            a.addHashed(hi >>> 0, lo >>> 0, cn); I[0] = hi; I[1] = lo; I[2] = cn; b.addHashedFrom(I, 0);
        }
        assert.deepEqual(Array.from(a._counts), Array.from(b._counts), conservative ? 'cons' : 'plain');
    }
});

// ===========================================================================
// QA H2.6 -- boundary matrix for addFrom / addHashedFrom / estimate (CMS).
// Index 0 / 1 / N-2 (last valid) / N-1 / N / N+1 / -0 / empty / null /
// undefined / NaN; byteOffset / SharedArrayBuffer / detached / shrunk views;
// the key x count matrix through addFrom == add; D3 after a merge with cells
// >= 2^31; interleaved add / addFrom / estimate on two instances; a Proxy that
// re-enters the same sketch mid-read; addHashedFrom at the end of the buffer.
// ===========================================================================
const qa26Err = (fn) => { try { fn(); return null; } catch (e) { return e.constructor.name + ': ' + e.message; } };
const qa26Same = (a, b, m) => {
    assert.deepEqual(Array.from(b._counts), Array.from(a._counts), m + ': _counts');
    assert.equal(b.total, a.total, m + ': total'); assert.equal(b.saturated, a.saturated, m + ': saturated');
};

test('QA H2.6 (CMS): addFrom index matrix 0 / 1 / N-2 accepted == add; N-1 / N / N+1 / empty / -1 / NaN / null / undefined rejected tagged, no-op', () => {
    const F = new Float64Array([2 ** 40 + 1, 3, 2 ** 31 + 7, 2 ** 31, 9]);   // pairs (F[i], F[i+1]), every pair legal
    const N = F.length;
    for (const i of [0, 1, N - 2, -0]) {
        const a = new CountMinSketch(4, 256), b = new CountMinSketch(4, 256);
        a.add(F[i], F[i + 1]); b.addFrom(F, i);
        qa26Same(a, b, 'i ' + i);
    }
    const c = new CountMinSketch(4, 256); c.add(17, 4);
    const before = cmsSnap(c);
    for (const i of [N - 1, N, N + 1, -1, NaN, null, undefined, '0', 0.5, Infinity])
        assert.match(qa26Err(() => c.addFrom(F, i)), /^TypeError: \[lite-sketch\] CountMinSketch\.addFrom\(buf, i\)/, 'i ' + String(i));
    for (const len of [0, 1])
        assert.match(qa26Err(() => c.addFrom(new Float64Array(len), 0)), /^TypeError: \[lite-sketch\] CountMinSketch\.addFrom/, 'length ' + len);
    cmsUnchanged(before, c, 'rejected index');
});

test('QA H2.6 (CMS): addFrom over a byteOffset view and a SharedArrayBuffer view == add; detached / shrunk buffers reject, no-op', () => {
    const base = new Float64Array([0, 0, 0, -(2 ** 33) - 9, 2 ** 31 + 1]);
    const view = base.subarray(3);
    assert.equal(view.byteOffset, 24);
    const S = new Float64Array(new SharedArrayBuffer(16)); S[0] = -(2 ** 33) - 9; S[1] = 2 ** 31 + 1;
    for (const conservative of [true, false]) {
        const a = new CountMinSketch(5, 128, { conservative }), b = new CountMinSketch(5, 128, { conservative }), s = new CountMinSketch(5, 128, { conservative });
        a.add(-(2 ** 33) - 9, 2 ** 31 + 1);
        b.addFrom(view, view.length - 2);
        s.addFrom(S, 0);
        qa26Same(a, b, 'view'); qa26Same(a, s, 'SAB');
        assert.equal(b.estimate(-(2 ** 33) - 9), 2 ** 31 + 1);
        const before = cmsSnap(a);
        const D = new Float64Array([1, 1]); structuredClone(D.buffer, { transfer: [D.buffer] });
        assert.match(qa26Err(() => a.addFrom(D, 0)), /^TypeError: \[lite-sketch\] CountMinSketch\.addFrom/, 'detached');
        const DU = new Uint32Array([1, 2, 1]); structuredClone(DU.buffer, { transfer: [DU.buffer] });
        assert.match(qa26Err(() => a.addHashedFrom(DU, 0)), /^TypeError: \[lite-sketch\] CountMinSketch\.addHashedFrom/, 'detached hashed');
        const rab = new ArrayBuffer(32, { maxByteLength: 32 }); const R = new Float64Array(rab); R[2] = 5; R[3] = 1;
        rab.resize(24);                               // length 4 -> 3: i = 2 loses its count slot
        assert.match(qa26Err(() => a.addFrom(R, 2)), /^TypeError: \[lite-sketch\] CountMinSketch\.addFrom/, 'shrunk');
        cmsUnchanged(before, a, 'detached / shrunk');
    }
});

test('QA H2.6 (CMS): addFrom key x count matrix == add (error class + message, or state), incl -0, +-(2^53-1), 2^53, NaN, counts 0 / 2^32-1 / 2^32 / 1.5', () => {
    const KEYS = [0, -0, 1, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 53, -(2 ** 53), NaN, Infinity, 1.5, 2 ** 31];
    const COUNTS = [0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 1.5, NaN, -1, -0, Infinity];
    const F = new Float64Array(2);
    for (const conservative of [true, false]) for (const k of KEYS) for (const cn of COUNTS) {
        const a = new CountMinSketch(4, 64, { conservative }), b = new CountMinSketch(4, 64, { conservative });
        a.add(3, 2); b.add(3, 2);
        const ea = qa26Err(() => a.add(k, cn));
        F[0] = k; F[1] = cn;
        const eb = qa26Err(() => b.addFrom(F, 0));
        const lab = (conservative ? 'cons' : 'plain') + ' (' + k + ', ' + cn + ')';
        assert.equal(eb, ea, lab + ': addFrom outcome != add');
        qa26Same(a, b, lab);
        assert.equal(b.estimate(k), a.estimate(k), lab + ': estimate');
    }
});

test('QA H2.6 (CMS): estimate (D3) is exact for cells >= 2^31 built by merge, incl a non-Smi key and a clamped (saturated) merge', () => {
    for (const conservative of [true, false]) for (const key of [7, 2 ** 40 + 3, -(2 ** 31) - 1]) {
        const a = new CountMinSketch(4, 4096, { conservative }), b = new CountMinSketch(4, 4096, { conservative });
        a.add(key, 2 ** 31 + 3); b.add(key, 2 ** 31 - 7);
        a.merge(b);
        assert.equal(a.estimate(key), 2 ** 32 - 4, 'merged sum 2^32-4 key ' + key);
        assert.equal(a.saturated, false);
        const F = new Float64Array([key, 1]);
        a.addFrom(F, 0);
        assert.equal(a.estimate(key), 2 ** 32 - 3, 'after addFrom key ' + key);
        const c = new CountMinSketch(4, 4096, { conservative }); c.add(key, 2 ** 31 + 9);
        a.merge(c);                                     // clamps to 2^32-1
        assert.equal(a.estimate(key), 2 ** 32 - 1, 'clamped key ' + key);
        assert.equal(a.saturated, true);
        assert.equal(a.estimate(key + 1 === key ? 0 : 999331), 0, 'an absent key still estimates 0 after a large estimate');
    }
});

test('QA H2.6 (CMS): interleaved add / addFrom / estimate on two instances never cross-talk through _buf', () => {
    const x = new CountMinSketch(5, 512), y = new CountMinSketch(5, 512, { conservative: false });
    const xs = new CountMinSketch(5, 512), ys = new CountMinSketch(5, 512, { conservative: false });
    const F = new Float64Array(2);
    for (let t = 0; t < 3000; t++) {
        const kx = (t * 2654435761) % (2 ** 40), ky = -((t * 40503) % (2 ** 35)) - 1;
        const cx = 1 + (t & 7), cy = 2 ** 30 + (t & 3);
        if (t & 1) x.add(kx, cx); else { F[0] = kx; F[1] = cx; x.addFrom(F, 0); }
        const ey = y.estimate(ky);                      // writes y._buf[1] between x's ops
        F[0] = ky; F[1] = cy; y.addFrom(F, 0);
        const ex = x.estimate(kx);
        assert.equal(ey, ys.estimate(ky), 't ' + t + ' y.estimate (before its add)');
        xs.add(kx, cx); ys.add(ky, cy);
        assert.equal(ex, xs.estimate(kx), 't ' + t + ' x.estimate');
        assert.equal(y.estimate(ky), ys.estimate(ky), 't ' + t + ' y.estimate (after its add)');
        if ((t & 1) === 0) x.add(kx);                   // default count 1 after an estimate left _buf[1] = min
        if ((t & 1) === 0) xs.add(kx);
    }
    qa26Same(xs, x, 'x vs solo'); qa26Same(ys, y, 'y vs solo');
});

test('QA H2.6 (CMS): a Proxy that RE-ENTERS the same sketch while a slot is read still adds the caller (key, count)', () => {
    for (const slot of ['0', '1']) {
        const a = new CountMinSketch(4, 1024), b = new CountMinSketch(4, 1024);
        a.add(424242, 2); a.add(2 ** 33 + 1, 5);
        let fired = false;
        const px = new Proxy(new Float64Array([2 ** 33 + 1, 5]), {
            get(t, k) { if (k === slot && !fired) { fired = true; b.add(424242, 2); } return t[k]; },
        });
        b.addFrom(px, 0);
        assert.ok(fired);
        qa26Same(a, b, 're-entry on slot ' + slot);
        assert.equal(b.estimate(2 ** 33 + 1), a.estimate(2 ** 33 + 1));
    }
});

test('QA H2.6 (CMS): addHashedFrom at the end of the buffer (N-3 ok; N-2 / N-1 / N / -0) and the Int32Array count cap 2^31-1', () => {
    for (const Ctor of [Uint32Array, Int32Array]) {
        const U = new Ctor(7);
        U[4] = 0x9e3779b1 | 0; U[5] = 0x7f4a7c15; U[6] = 2 ** 31 - 1;
        const a = new CountMinSketch(4, 256), b = new CountMinSketch(4, 256);
        a.addHashed(0x9e3779b1, 0x7f4a7c15, 2 ** 31 - 1);
        b.addHashedFrom(U, U.length - 3);
        qa26Same(a, b, Ctor.name + ' N-3 count 2^31-1');
        const c = new CountMinSketch(4, 256); U[0] = U[4]; U[1] = U[5]; U[2] = U[6]; c.addHashedFrom(U, -0);
        qa26Same(a, c, Ctor.name + ' i = -0');
        const before = cmsSnap(b);
        for (const i of [U.length - 2, U.length - 1, U.length, U.length + 1, -1, NaN, null, undefined])
            assert.match(qa26Err(() => b.addHashedFrom(U, i)), /^TypeError: \[lite-sketch\] CountMinSketch\.addHashedFrom/, Ctor.name + ' i ' + String(i));
        for (const len of [0, 1, 2])
            assert.match(qa26Err(() => b.addHashedFrom(new Ctor(len), 0)), /^TypeError: \[lite-sketch\] CountMinSketch\.addHashedFrom/, Ctor.name + ' length ' + len);
        cmsUnchanged(before, b, Ctor.name + ' bad index');
        const V = new Ctor(9).subarray(6); V[0] = U[4]; V[1] = U[5]; V[2] = U[6];
        const d = new CountMinSketch(4, 256); d.addHashedFrom(V, 0);
        qa26Same(a, d, Ctor.name + ' subarray view');
    }
    // Int32Array: count -1 (= 0xffffffff as uint32) and 0 are _badCount, never reinterpreted.
    const e = new CountMinSketch(4, 256); e.add(1, 1);
    const before = cmsSnap(e);
    for (const cn of [-1, 0, -(2 ** 31)]) {
        const I = new Int32Array([5, 6, cn]);
        assert.match(qa26Err(() => e.addHashedFrom(I, 0)), /^RangeError: \[lite-sketch\] CountMinSketch count/, 'Int32 count ' + cn);
    }
    const U0 = new Uint32Array([5, 6, 0]);
    assert.match(qa26Err(() => e.addHashedFrom(U0, 0)), /^RangeError: /, 'Uint32 count 0');
    cmsUnchanged(before, e, 'bad hashed counts');
    // Uint32Array count 2^32-1 is legal (== addHashed); a second one saturates.
    const f = new CountMinSketch(4, 256), g = new CountMinSketch(4, 256, { conservative: true });
    const UM = new Uint32Array([1, 2, 2 ** 32 - 1]);
    f.addHashedFrom(UM, 0); g.addHashed(1, 2, 2 ** 32 - 1);
    qa26Same(g, f, 'count 2^32-1');
    assert.equal(f.estimateHashed(1, 2), 2 ** 32 - 1);
});
