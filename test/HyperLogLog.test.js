/**
 * @zakkster/lite-sketch -- HyperLogLog boundary + white-box + accuracy suite (node:test).
 *
 * Proves the HyperLogLog contract:
 *   1. Ctor fail-closed: a bad p / seed throws `[lite-sketch]` BEFORE any allocation
 *      (no half-built instance).
 *   2. Hot path: register values in [0, 64 - p + 1]; a known key/lane pair sets the
 *      expected register (white-box: replicate index + rho); a bad key throws.
 *   3. Accuracy SANITY: relative error within 3 sigma over an N-sweep (p=14); empty ~0;
 *      small N near-exact via linear counting.
 *   4. merge: disjoint halves merge to ~N; register-wise max hand-verified; equal-m-or-throw.
 *   5. clear: fill + clear -> count ~0 and all registers zero.
 *
 * (The full accuracy witness is the orchestrator's test/witness.mjs; this is sanity.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HyperLogLog, mix64, hashHi, hashLo, VERSION } from '../Sketch.js';

const liteSketch = (e) => e instanceof Error && /^\[lite-sketch]/.test(e.message);

// Replicate the hot-path index + rho from two lanes (the white-box oracle).
function expected(hi, lo, p) {
    const j = hi >>> (32 - p);
    const hiSuf = (hi << p) >>> 0;
    const rho = hiSuf !== 0 ? Math.clz32(hiSuf) + 1 : (32 - p) + Math.clz32(lo) + 1;
    return { j, rho };
}

test('VERSION is the frozen 1.1.1 string', () => {
    assert.equal(VERSION, '1.1.1');
});

// --- ctor fail-closed ------------------------------------------------------

test('ctor rejects a bad p [lite-sketch] before allocation', () => {
    for (const p of [3, 19, 1.5, NaN, '8', null, -1, Infinity]) {
        assert.throws(() => new HyperLogLog(p), liteSketch, 'p=' + String(p));
    }
});

test('ctor rejects a bad seed [lite-sketch]', () => {
    for (const seed of [1.5, NaN, '5', null, {}, Infinity]) {
        assert.throws(() => new HyperLogLog(14, seed), liteSketch, 'seed=' + String(seed));
    }
});

test('ctor leaves NO half-built instance on a bad p (throws at the door)', () => {
    // A thrown constructor must not have allocated a register bank we can observe.
    let inst;
    try {
        inst = new HyperLogLog(99);
    } catch (e) {
        assert.ok(liteSketch(e));
    }
    assert.equal(inst, undefined);
});

test('ctor accepts p in [4, 18] and default p=14; m = 1 << p', () => {
    for (let p = 4; p <= 18; p++) {
        const h = new HyperLogLog(p);
        assert.equal(h.p, p);
        assert.equal(h.m, 1 << p);
    }
    const d = new HyperLogLog();
    assert.equal(d.p, 14);
    assert.equal(d.m, 16384);
});

test('ctor accepts any integer seed, coerced to uint32', () => {
    assert.doesNotThrow(() => new HyperLogLog(8, -1));
    assert.doesNotThrow(() => new HyperLogLog(8, 0));
    assert.doesNotThrow(() => new HyperLogLog(8, 0x7fffffff));
});

test('standardError getter is 1.04 / sqrt(m)', () => {
    const h = new HyperLogLog(14);
    assert.equal(h.standardError, 1.04 / Math.sqrt(16384));
});

// --- hot path: add value contract ------------------------------------------

test('add typeof-guards the key: Symbol / BigInt / NaN / string / object throw', () => {
    const h = new HyperLogLog(10);
    assert.throws(() => h.add(Symbol('x')), liteSketch);
    assert.throws(() => h.add(5n), liteSketch);
    assert.throws(() => h.add(NaN), liteSketch);
    assert.throws(() => h.add('x'), liteSketch);
    assert.throws(() => h.add({}), liteSketch);
    assert.throws(() => h.add(null), liteSketch);
    assert.throws(() => h.add(undefined), liteSketch);
});

test('add returns this (chainable)', () => {
    const h = new HyperLogLog(8);
    assert.equal(h.add(1), h);
});

// F1/F2 (v1.1.0 hardening): the key domain is the SAFE INTEGER range. A +-Infinity would
// hash identically to key 0 (fail-open) and a non-integer would truncate under >>> 0 and
// collide; both now fail closed, matching CountMinSketch / SpaceSaving. Smoke coverage.
test('F1: add rejects +-Infinity [lite-sketch] (was fail-open: Infinity aliased key 0)', () => {
    const h = new HyperLogLog(14);
    assert.throws(() => h.add(Infinity), liteSketch);
    assert.throws(() => h.add(-Infinity), liteSketch);
    // fail-closed is a byte-identical no-op: nothing was counted.
    assert.ok(h.count() < 0.5);
});

test('F2: add rejects a non-integer / out-of-safe-range key [lite-sketch] (was truncated by >>> 0)', () => {
    const h = new HyperLogLog(14);
    for (const bad of [1.5, 1.9, 0.5, Math.PI, 2 ** 53, -(2 ** 53), 2 ** 60]) {
        assert.throws(() => h.add(bad), liteSketch, 'key=' + bad);
    }
    // the whole SAFE-INTEGER range is still accepted (the hot body reads the high word + sign).
    for (const ok of [0, -0, 1, -5, 2 ** 32 + 1, 2 ** 40, Number.MAX_SAFE_INTEGER, -(2 ** 40)]) {
        assert.equal(h.add(ok), h, 'key=' + ok);
    }
    // 1.0, 1.5, 1.9 no longer collapse to one distinct: only the integer 1 was accepted.
    const g = new HyperLogLog(14);
    g.add(1.0);
    assert.throws(() => g.add(1.5), liteSketch);
    assert.throws(() => g.add(1.9), liteSketch);
});

test('register values stay within [0, 64 - p + 1] after a large add stream', () => {
    const p = 12;
    const h = new HyperLogLog(p);
    for (let i = 0; i < 200000; i++) h.add(i);
    const max = 64 - p + 1;
    for (let i = 0; i < h.m; i++) {
        const v = h._reg[i];
        assert.ok(v >= 0 && v <= max, 'reg[' + i + ']=' + v + ' out of [0, ' + max + ']');
    }
});

test('white-box: add(key) sets reg[j] to the rho computed from its lanes', () => {
    const p = 12;
    const seed = 0x9e3779b1;
    const h = new HyperLogLog(p, seed);
    // pick a handful of keys; each must land its expected rho in its expected register
    for (const key of [1, 7, 42, 12345, 999999]) {
        mix64(key, seed);
        const { j, rho } = expected(hashHi(), hashLo(), p);
        const before = h._reg[j];
        h.add(key);
        assert.equal(h._reg[j], Math.max(before, rho), 'key=' + key);
    }
});

test('white-box: addHashed(hi, lo) with crafted lanes hits a known j / rho', () => {
    const p = 6; // 32 - p = 26
    const h = new HyperLogLog(p);
    // hi top 6 bits = 0b000101 -> j = 5; the next bit (bit 25) is 1 -> rho = 1.
    const hi = ((5 << 26) | (1 << 25)) >>> 0;
    const lo = 0;
    const exp = expected(hi, lo, p);
    assert.equal(exp.j, 5);
    assert.equal(exp.rho, 1);
    h.addHashed(hi, lo);
    assert.equal(h._reg[5], 1);
});

test('white-box: addHashed with hiSuf == 0 counts leading zeros into the LO lane', () => {
    const p = 4; // 32 - p = 28
    const h = new HyperLogLog(p);
    // hi = 0 -> j = 0, hiSuf = 0. lo has its leftmost 1 at bit 30 -> clz32(lo)=1.
    const hi = 0;
    const lo = (1 << 30) >>> 0;
    const exp = expected(hi, lo, p);
    assert.equal(exp.j, 0);
    assert.equal(exp.rho, (32 - p) + 1 + 1); // 28 + clz32(lo)=1 + 1 = 30
    h.addHashed(hi, lo);
    assert.equal(h._reg[0], exp.rho);
});

test('white-box: all-zero suffix gives the max rho = 64 - p + 1', () => {
    const p = 14;
    const h = new HyperLogLog(p);
    // hi top p bits index j, remaining hi bits 0, lo all 0 -> rho = 64 - p + 1.
    const hi = 0; // j = 0, hiSuf = 0
    const lo = 0;
    const exp = expected(hi, lo, p);
    assert.equal(exp.rho, 64 - p + 1);
    h.addHashed(hi, lo);
    assert.equal(h._reg[0], 64 - p + 1);
});

test('addHashed typeof-guards both lanes as uint32', () => {
    const h = new HyperLogLog(8);
    assert.throws(() => h.addHashed(-1, 0), liteSketch);
    assert.throws(() => h.addHashed(0, 1.5), liteSketch);
    assert.throws(() => h.addHashed(2 ** 32, 0), liteSketch);
    assert.throws(() => h.addHashed('0', 0), liteSketch);
    assert.throws(() => h.addHashed(0, Symbol()), liteSketch);
});

// --- accuracy sanity -------------------------------------------------------

test('count() of an empty sketch is ~0', () => {
    const h = new HyperLogLog(14);
    assert.ok(h.count() <= 1, 'empty count ' + h.count());
});

test('small N (< m) is near-exact via linear counting', () => {
    const h = new HyperLogLog(14); // m = 16384
    const N = 500;
    for (let i = 0; i < N; i++) h.add(i);
    const c = h.count();
    assert.ok(Math.abs(c - N) / N <= 0.02, 'small-N count ' + c + ' vs ' + N);
});

test('accuracy sanity: |count - N| / N <= 3 sigma over an N-sweep (p=14)', () => {
    const p = 14;
    const se = 1.04 / Math.sqrt(1 << p);
    for (const N of [1000, 10000, 100000]) {
        const h = new HyperLogLog(p);
        for (let i = 0; i < N; i++) h.add(i);
        const c = h.count();
        const rel = Math.abs(c - N) / N;
        assert.ok(rel <= 3 * se, 'N=' + N + ' count=' + c + ' rel=' + rel.toFixed(5) + ' > 3sigma=' + (3 * se).toFixed(5));
    }
});

test('addHashed accuracy tracks add accuracy (pre-hashed fast path)', () => {
    const p = 14;
    const seed = 0x9e3779b1;
    const se = 1.04 / Math.sqrt(1 << p);
    const N = 50000;
    const h = new HyperLogLog(p, seed);
    for (let i = 0; i < N; i++) {
        mix64(i, seed);
        h.addHashed(hashHi(), hashLo());
    }
    const rel = Math.abs(h.count() - N) / N;
    assert.ok(rel <= 3 * se, 'addHashed rel=' + rel.toFixed(5));
});

// --- merge -----------------------------------------------------------------

test('merge: two HLLs fed disjoint halves merge to ~N within 3 sigma', () => {
    const p = 14;
    const se = 1.04 / Math.sqrt(1 << p);
    const N = 100000;
    const a = new HyperLogLog(p);
    const b = new HyperLogLog(p);
    for (let i = 0; i < N; i++) (i < N / 2 ? a : b).add(i);
    assert.equal(a.merge(b), a);
    const rel = Math.abs(a.count() - N) / N;
    assert.ok(rel <= 3 * se, 'merged rel=' + rel.toFixed(5));
});

test('merge: register-wise max on a hand-built pair', () => {
    const a = new HyperLogLog(4);
    const b = new HyperLogLog(4);
    a._reg[0] = 3; a._reg[1] = 1; a._reg[2] = 0;
    b._reg[0] = 2; b._reg[1] = 5; b._reg[2] = 7;
    a.merge(b);
    assert.equal(a._reg[0], 3);
    assert.equal(a._reg[1], 5);
    assert.equal(a._reg[2], 7);
});

test('merge: merging a full sketch is idempotent-safe (max keeps the max)', () => {
    const p = 10;
    const a = new HyperLogLog(p);
    for (let i = 0; i < 20000; i++) a.add(i);
    const before = a.count();
    a.merge(a);
    assert.equal(a.count(), before);
});

test('merge: unequal p throws [lite-sketch]', () => {
    const a = new HyperLogLog(10);
    const b = new HyperLogLog(11);
    assert.throws(() => a.merge(b), liteSketch);
});

test('merge: a non-HyperLogLog throws [lite-sketch]', () => {
    const a = new HyperLogLog(10);
    for (const bad of [null, undefined, {}, { _m: 1024, _reg: new Uint8Array(1024) }, 5]) {
        assert.throws(() => a.merge(bad), liteSketch, String(bad));
    }
});

test('merge: a non-HyperLogLog throws a TypeError specifically (regression guard)', () => {
    const a = new HyperLogLog(10);
    for (const bad of [null, undefined, {}, 5]) {
        assert.throws(() => a.merge(bad), (e) => e instanceof TypeError && liteSketch(e), String(bad));
    }
});

// --- merge: seed parity (new behavior) --------------------------------------

test('merge: mismatched seed throws [lite-sketch] RangeError and does NOT mutate the receiver', () => {
    const h = new HyperLogLog(12, 1);
    for (let i = 0; i < 1000; i++) h.add(i);
    const before = h.count();
    const regSnapshot = h._reg.slice();
    const other = new HyperLogLog(12, 2); // same m, different seed
    for (let i = 0; i < 1000; i++) other.add(i + 10000);

    let thrown;
    try {
        h.merge(other);
    } catch (e) {
        thrown = e;
    }
    assert.ok(thrown instanceof RangeError, 'expected a RangeError');
    assert.ok(liteSketch(thrown), 'message must carry [lite-sketch]');
    // fail-closed: byte-identical no-op on the receiver's registers, and count() unchanged.
    assert.deepEqual(h._reg, regSnapshot, 'registers mutated by a rejected merge');
    assert.equal(h.count(), before, 'count() drifted after a rejected merge');

    // duplicate attempt: repeating the illegal merge is consistently rejected, no cumulative damage.
    assert.throws(() => h.merge(other), liteSketch);
    assert.deepEqual(h._reg, regSnapshot, 'registers mutated by a SECOND rejected merge');

    // re-entrant recovery: a LEGAL merge immediately after a rejected one still works cleanly
    // (the failed attempt left no partial/half-applied state behind).
    const good = new HyperLogLog(12, 1); // same seed as h
    good.add(999999);
    assert.equal(h.merge(good), h);
    assert.ok(h.count() >= before, 'legal merge after a rejected one did not apply');
});

test('merge: same explicit seed still merges disjoint halves to a sensible union estimate', () => {
    const p = 14;
    const seed = 0xC0FFEE;
    const se = 1.04 / Math.sqrt(1 << p);
    const N = 100000;
    const a = new HyperLogLog(p, seed);
    const b = new HyperLogLog(p, seed);
    for (let i = 0; i < N; i++) (i < N / 2 ? a : b).add(i);
    assert.equal(a.merge(b), a);
    const rel = Math.abs(a.count() - N) / N;
    assert.ok(rel <= 3 * se, 'merged rel=' + rel.toFixed(5));
});

test('merge: unequal-m mismatch and unequal-seed mismatch throw DISTINCT [lite-sketch] messages', () => {
    let mErr, seedErr;
    try {
        new HyperLogLog(14).merge(new HyperLogLog(12));
    } catch (e) {
        mErr = e;
    }
    try {
        new HyperLogLog(14, 1).merge(new HyperLogLog(14, 2));
    } catch (e) {
        seedErr = e;
    }
    assert.ok(liteSketch(mErr) && mErr instanceof RangeError, 'm-mismatch must be [lite-sketch] RangeError');
    assert.ok(liteSketch(seedErr) && seedErr instanceof RangeError, 'seed-mismatch must be [lite-sketch] RangeError');
    assert.notEqual(mErr.message, seedErr.message, 'the two _badMerge branches must not share a message');
    assert.match(mErr.message, /equal m/);
    assert.match(seedErr.message, /equal seed/);
});

test('merge: two same-p same-seed HLLs fed the SAME keys produce the SAME registers (true no-op union)', () => {
    const p = 10;
    const seed = 555;
    const a = new HyperLogLog(p, seed);
    const b = new HyperLogLog(p, seed);
    for (let i = 0; i < 5000; i++) {
        a.add(i);
        b.add(i);
    }
    assert.deepEqual(a._reg, b._reg, 'identical stream + identical seed must produce identical registers');
    const before = a._reg.slice();
    a.merge(b);
    assert.deepEqual(a._reg, before, 'merging an identical-registers peer must be a byte-identical no-op');
});

// --- seed getter -------------------------------------------------------------

test('seed getter returns the ctor seed as an effective uint32', () => {
    assert.equal(new HyperLogLog(14, 7).seed, 7);
    const d = new HyperLogLog();
    assert.equal(typeof d.seed, 'number');
    assert.ok(d.seed >= 0);
    assert.equal(d.seed, d.seed >>> 0);
});

test('seed getter boundary matrix: 0, 1, -0, int32 max/min, uint32 max round-trip through >>> 0', () => {
    // 0 / 1 -- the low boundary.
    assert.equal(new HyperLogLog(8, 0).seed, 0);
    assert.equal(new HyperLogLog(8, 1).seed, 1);
    // -0 -- ctor accepts it (Number.isInteger(-0) is true); the getter normalizes to +0.
    assert.equal(new HyperLogLog(8, -0).seed, 0);
    assert.ok(!Object.is(new HyperLogLog(8, -0).seed, -0), 'seed getter must not leak a signed -0');
    // N-1 / N / N+1 around the int32 boundary (2^31 - 1, 2^31, 2^31 + 1): the ctor stores
    // `seed | 0` (signed int32) and the getter reads it back `>>> 0` (unsigned) -- the
    // round trip must survive the sign flip at the boundary.
    assert.equal(new HyperLogLog(8, 0x7fffffff).seed, 0x7fffffff);     // N-1: last positive int32
    assert.equal(new HyperLogLog(8, -0x80000000).seed, 0x80000000);    // N: first negative int32, as uint32
    assert.equal(new HyperLogLog(8, -0x7fffffff).seed, 0x80000001);    // N+1
    // full uint32 max and the documented 0xDEADBEEF example.
    assert.equal(new HyperLogLog(8, -1).seed, 0xffffffff);
    assert.equal(new HyperLogLog(8, 0xDEADBEEF | 0).seed, 0xDEADBEEF);
});

test('seed getter is read-only: assignment throws in strict-mode ESM', () => {
    const h = new HyperLogLog(8, 42);
    assert.throws(() => { h.seed = 99; }, TypeError);
    assert.equal(h.seed, 42, 'a rejected assignment must not have mutated the seed');
});

test('adversarial: a self-merge with a corrupted NaN _seed still fails closed (NaN !== NaN)', () => {
    // Not a planner-anticipated path: `other` IS `this` (same object reference), so the
    // instanceof and m checks trivially pass -- but if `_seed` is ever NaN (e.g. corrupted
    // by a future refactor bypassing the ctor guard), `other._seed !== this._seed` is TRUE
    // even comparing the SAME value to itself, because NaN !== NaN. merge() must still
    // reject rather than silently accept a self-merge as a no-op.
    const h = new HyperLogLog(8, 1);
    h.add(1); h.add(2); h.add(3);
    const before = h._reg.slice();
    h._seed = NaN; // white-box corruption, simulating a broken invariant
    assert.throws(() => h.merge(h), (e) => liteSketch(e) && e instanceof RangeError && /equal seed/.test(e.message));
    assert.deepEqual(h._reg, before, 'a self-merge that throws must not touch the registers');
    // the getter still coerces the corrupted NaN seed to a uint32 (NaN >>> 0 === 0) --
    // fail-closed does not mean the getter itself throws; only the merge equality check does.
    assert.equal(h.seed, 0);
});

// --- clear -----------------------------------------------------------------

test('clear: after fill + clear, count ~0 and every register is zero', () => {
    const p = 12;
    const h = new HyperLogLog(p);
    for (let i = 0; i < 50000; i++) h.add(i);
    assert.ok(h.count() > 1000);
    assert.equal(h.clear(), h);
    assert.ok(h.count() <= 1, 'count after clear ' + h.count());
    for (let i = 0; i < h.m; i++) assert.equal(h._reg[i], 0);
});
