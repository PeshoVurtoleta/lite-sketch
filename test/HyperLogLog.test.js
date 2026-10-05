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

test('VERSION is the frozen 1.1.2 string', () => {
    assert.equal(VERSION, '1.1.2');
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

// --- H2.1 / F1: the signed register suffix `h << p` --------------------------
// F1 replaced `hiSuf = (h << p) >>> 0` with `h << p` in add + addHashed. The oracle
// below is the OLD unsigned form (via expected()); these cases pin that the signed
// suffix feeds clz32 and `!== 0` identically for every edge, register and tier.

// rho exactly as the 1.1.2 body computed it (unsigned suffix) and as H2.1 does (signed).
function rhoOld(h, g, p) {
    const s = (h << p) >>> 0;
    return s !== 0 ? Math.clz32(s) + 1 : (32 - p) + Math.clz32(g) + 1;
}
function rhoNew(h, g, p) {
    const s = h << p;
    return s !== 0 ? Math.clz32(s) + 1 : (32 - p) + Math.clz32(g) + 1;
}
const EDGE_LO = [0, 1, -1, 0x80000000 | 0, 0x7fffffff, 0x40000000];

test('F1: signed suffix `h << p` gives the same rho and the same `!== 0` branch as `(h << p) >>> 0` (edges x p in [4, 18])', () => {
    for (let p = 4; p <= 18; p++) {
        const edges = [
            0, 1, -1, 0x80000000 | 0, 0x7fffffff, 0x40000000, 2, 3,
            1 << (31 - p),              // suffix MSB = bit 31 after the shift -> rho 1, signed suffix < 0
            (1 << (31 - p)) - 1,        // every suffix bit below the MSB set
            (1 << (31 - p)) | 1,        // MSB + LSB of the suffix
            -(1 << (32 - p)),           // top p bits all ones, suffix 0 -> LO-lane branch
            1 << (32 - p),              // lowest index bit only, suffix 0
            (1 << (32 - p)) - 1,        // index 0, suffix all ones
            -(1 << (32 - p)) | 1,       // last register, suffix LSB only -> rho 32 - p
            0xdeadbeef | 0, 0x9e3779b1 | 0, 0x55555555, 0xaaaaaaaa | 0,
        ];
        for (const h of edges) {
            const so = (h << p) >>> 0, sn = h << p;
            assert.equal(sn !== 0, so !== 0, 'branch p=' + p + ' h=' + h);
            assert.equal(Math.clz32(sn), Math.clz32(so), 'clz32 p=' + p + ' h=' + h);
            for (const g of EDGE_LO) {
                assert.equal(rhoNew(h, g, p), rhoOld(h, g, p), 'rho p=' + p + ' h=' + h + ' g=' + g);
                assert.ok(rhoNew(h, g, p) >= 1 && rhoNew(h, g, p) <= 64 - p + 1, 'rho range p=' + p);
            }
        }
        // the two named edges have known rho: suffix MSB set -> 1; suffix LSB only -> 32 - p
        assert.equal(rhoNew(1 << (31 - p), 0, p), 1, 'suffix MSB p=' + p);
        assert.equal(rhoNew(1, 0, p), 32 - p, 'suffix LSB p=' + p);
        assert.equal(rhoNew(-(1 << (32 - p)), 0, p), 64 - p + 1, 'all-zero suffix p=' + p);
    }
});

test('F1: addHashed with hi bit 31 set lands the reference j / rho in exactly ONE register (p in [4, 18])', () => {
    for (let p = 4; p <= 18; p++) {
        const m = 1 << p;
        const his = [
            0x80000000, 0xffffffff, 0x80000001,
            (0x80000000 | (1 << (31 - p))) >>> 0,      // suffix MSB -> rho 1, j = m/2
            (0x80000000 | 1) >>> 0,                    // suffix LSB -> rho 32 - p
            (~0 << (32 - p)) >>> 0,                    // j = m - 1 (the N-1 register), suffix 0 -> LO branch
            ((~0 << (32 - p)) | (1 << (31 - p))) >>> 0, // j = m - 1, rho 1
            0xdeadbeef, 0x9e3779b1, 0xaaaaaaaa,
        ];
        for (const hi of his) {
            for (const lo of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
                const h = new HyperLogLog(p);
                const exp = expected(hi, lo, p);
                assert.ok(exp.j >= 0 && exp.j < m, 'j range');
                assert.equal(h.addHashed(hi, lo), h);
                let nz = 0;
                for (let r = 0; r < m; r++) if (h._reg[r] !== 0) nz++;
                assert.equal(nz, 1, 'exactly one register written p=' + p + ' hi=' + hi + ' lo=' + lo);
                assert.equal(h._reg[exp.j], exp.rho, 'reg[j] p=' + p + ' hi=' + hi + ' lo=' + lo);
            }
        }
        // named expectations at the register boundaries
        const top = new HyperLogLog(p);
        top.addHashed((~0 << (32 - p)) >>> 0, 0);
        assert.equal(top._reg[m - 1], 64 - p + 1, 'reg[m-1] all-zero suffix p=' + p);
        const half = new HyperLogLog(p);
        half.addHashed((0x80000000 | (1 << (31 - p))) >>> 0, 0);
        assert.equal(half._reg[m >>> 1], 1, 'reg[m/2] suffix MSB p=' + p);
    }
});

test('F1: hi-lane boundary matrix 2^31-1 / 2^31 / 2^31+1 / 2^32-1 accepted; 2^32 / 2^32+1 / -1 / NaN / null / undefined / 1.5 rejected byte-identically; -0 behaves as 0', () => {
    const p = 10;
    for (const hi of [2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1, 2 ** 32 - 1]) {
        const h = new HyperLogLog(p);
        h.addHashed(hi, 0);
        const exp = expected(hi, 0, p);
        assert.equal(h._reg[exp.j], exp.rho, 'hi=' + hi);
    }
    const h = new HyperLogLog(p);
    for (let i = 0; i < 5000; i++) h.addHashed((i * 2654435761) >>> 0, (i * 40503) >>> 0);
    const snap = Array.from(h._reg);
    for (const bad of [2 ** 32, 2 ** 32 + 1, -1, NaN, null, undefined, 1.5, -(2 ** 31), Infinity]) {
        assert.throws(() => h.addHashed(bad, 0), liteSketch, 'hi=' + String(bad));
        assert.throws(() => h.addHashed(0x80000000, bad), liteSketch, 'lo=' + String(bad));
    }
    assert.deepEqual(Array.from(h._reg), snap, 'rejections left the registers byte-identical');
    const a = new HyperLogLog(p), b = new HyperLogLog(p);
    a.addHashed(-0, -0); b.addHashed(0, 0);
    assert.deepEqual(Array.from(a._reg), Array.from(b._reg), '-0 lanes == 0 lanes');
    assert.equal(a._reg[0], 64 - p + 1);
});

test('F1: optimized-tier parity -- 200k sign-bit addHashed lanes + 100k add keys match the unsigned-suffix oracle register-for-register (p 4/12/18)', () => {
    for (const p of [4, 12, 18]) {
        const m = 1 << p;
        const h = new HyperLogLog(p);
        const oracle = new Uint8Array(m);
        for (let i = 0; i < 200000; i++) {
            const hi = ((Math.imul(i, 0x9e3779b1) | 0x80000000) >>> 0) ^ ((i & 1) << (31 - p));
            const lo = Math.imul(i ^ 0x5bd1e995, 0x85ebca6b) >>> 0;
            h.addHashed(hi >>> 0, lo);
            const e = expected(hi >>> 0, lo, p);
            if (e.rho > oracle[e.j]) oracle[e.j] = e.rho;
        }
        const ka = new HyperLogLog(p);
        const ko = new Uint8Array(m);
        for (let i = 0; i < 100000; i++) {
            const key = i % 3 === 0 ? i : i % 3 === 1 ? -i * 7 : 2 ** 33 + i;
            ka.add(key);
            mix64(key, ka.seed);
            const e = expected(hashHi(), hashLo(), p);
            if (e.rho > ko[e.j]) ko[e.j] = e.rho;
        }
        let d = 0, dk = 0;
        for (let r = 0; r < m; r++) { if (h._reg[r] !== oracle[r]) d++; if (ka._reg[r] !== ko[r]) dk++; }
        assert.equal(d, 0, 'addHashed register diffs at p=' + p);
        assert.equal(dk, 0, 'add register diffs at p=' + p);
    }
});

test('F1: duplicate sign-bit writes and a double clear() are idempotent', () => {
    const p = 8;
    const h = new HyperLogLog(p);
    const hi = (0x80000000 | (1 << (31 - p))) >>> 0;
    h.addHashed(hi, 0).addHashed(hi, 0);
    const exp = expected(hi, 0, p);
    assert.equal(h._reg[exp.j], exp.rho);
    assert.equal(h.clear(), h);
    assert.equal(h.clear(), h);
    for (let r = 0; r < h.m; r++) assert.equal(h._reg[r], 0);
    h.addHashed(hi, 0);
    assert.equal(h._reg[exp.j], exp.rho, 'writes after a double clear land normally');
});

// G-F20 (F20, fixed in H2.3): the cold throwers now format rejected args through `_describe`,
// which runs NO user code. A null-proto object gives a TAGGED error ending in `got [object]`,
// a throwing toString no longer replaces the tag, and a toString that re-enters the receiver
// never runs, so a rejection stays byte-identical.
test('G-F20 (HLL): a rejected arg never runs caller code (tagged, calls===0, receiver untouched)', () => {
    let calls = 0;
    let hRef;
    const H = () => ({ [Symbol.toPrimitive]() { calls++; if (hRef) hRef.addHashed(0, 0); return 1; },
                       toString() { calls++; if (hRef) hRef.addHashed(0, 0); return 'x'; },
                       valueOf() { calls++; if (hRef) hRef.addHashed(0, 0); return 1; } });
    const hostile = () => [Object.create(null), { toString() { calls++; throw new Error('boom'); } }, H(),
        Object.assign(function () {}, { toString() { calls++; return 'f'; } })];
    // ctor slots p, seed
    for (const h of hostile()) assert.throws(() => new HyperLogLog(h), liteSketch);
    for (const h of hostile()) assert.throws(() => new HyperLogLog(14, h), liteSketch);
    hRef = new HyperLogLog(4);
    hRef.addHashed(123, 456);
    const snap = () => Array.from(hRef._reg);
    for (const h of hostile()) { const b = snap(); assert.throws(() => hRef.add(h), liteSketch); assert.deepEqual(snap(), b, 'add key'); }
    for (const h of hostile()) { const b = snap(); assert.throws(() => hRef.addHashed(h, 0), liteSketch); assert.deepEqual(snap(), b, 'addHashed hi'); }
    for (const h of hostile()) { const b = snap(); assert.throws(() => hRef.addHashed(0, h), liteSketch); assert.deepEqual(snap(), b, 'addHashed lo'); }
    assert.equal(calls, 0, 'no hostile toString/valueOf/toPrimitive ran');
    let msg = '';
    try { new HyperLogLog(Object.create(null)); } catch (e) { msg = e.message; }
    assert.ok(/got \[object]$/.test(msg), 'null-proto message: ' + msg);
});

// ===========================================================================
// G-F12 (HLL hash sign bit): -k and k count as distinct. FAILs on HEAD (collided).
// ===========================================================================

test('G-F12 (HLL): add(-1); add(2**32+1) counts 2 distinct (HEAD: 1 -- sign collided)', () => {
    const h = new HyperLogLog(14);
    h.add(-1);
    h.add(2 ** 32 + 1);
    assert.equal(h.count(), 2, 'two sign-split keys are two distinct cardinalities');
});

test('G-F12 (HLL): 10000 pairs (-i, 2^32+i) at p=14 count ~20000 (|count-20000| <= 488)', () => {
    const h = new HyperLogLog(14);
    for (let i = 1; i <= 10000; i++) { h.add(-i); h.add(2 ** 32 + i); }
    const c = h.count();
    assert.ok(Math.abs(c - 20000) <= 488, 'count=' + c + ' (HEAD collides to ~10000)');
});

test('G-F12 (HLL site consistency): add(k) == addHashed(mix64(k, seed)) over mixed-sign keys', () => {
    // Passes on HEAD too -- it only proves the member site uses the SAME hash as mix64.
    const a = new HyperLogLog(12, 7), b = new HyperLogLog(12, 7);
    for (const k of [-5, 2 ** 40 + 3, 7, -(2 ** 33), -1, 2 ** 32 + 1, -(2 ** 53 - 1), -(2 ** 32), 0, -0]) {
        a.add(k);
        mix64(k, a.seed);
        b.addHashed(hashHi(), hashLo());
    }
    let d = 0;
    for (let i = 0; i < a._reg.length; i++) if (a._reg[i] !== b._reg[i]) d++;
    assert.equal(d, 0, 'HLL add and addHashed(mix64) must set identical registers');
});

test('QA H2.4 (HLL site consistency, boundary matrix): add(k) == addHashed(mix64(k)) per key, ' +
    'fresh instances, across every word edge incl. -(2^31)-1, -(2^32-1), two-word negatives', () => {
    // Gap: the mixed-sign list above shares ONE instance (a register max can mask a site
    // diff) and has no |k| in [2^31, 2^32) negative, where `a | 0` is a negative int32.
    const KS = [0, -0, 1, -1, -(2 ** 31 - 1), -(2 ** 31), -(2 ** 31) - 1, -(2 ** 32 - 1), -(2 ** 32),
        -(2 ** 32 + 1), 2 ** 31, 2 ** 32 - 1, -(2 ** 40 + 104729), -(2 ** 52), -(2 ** 53 - 2),
        -(2 ** 53 - 1), 2 ** 53 - 1, -((2 ** 21 - 1) * 4294967296)];
    let bad = '';
    for (const k of KS) {
        const a = new HyperLogLog(10, 7), b = new HyperLogLog(10, 7);
        a.add(k);
        mix64(k, a.seed);
        b.addHashed(hashHi(), hashLo());
        for (let i = 0; i < a._reg.length; i++) if (a._reg[i] !== b._reg[i]) { bad += k + ' '; break; }
    }
    assert.equal(bad, '', 'add and addHashed(mix64) disagree for: ' + bad);
});

// ===========================================================================
// H2.6 F5/F6 -- addFrom / addHashedFrom (the zero-box entry points).
// addFrom reads buf[i] UNBOXED; addHashedFrom reads two uint32 lanes. Twins vs
// add / addHashed, tagged rejects with a byte-identical no-op, per-instance _buf.
// ===========================================================================
const h26Snap = (s) => Array.from(s._reg);
const h26Eq = (a, b, m) => assert.deepEqual(Array.from(a._reg), Array.from(b._reg), m);

test('H2.6 (HLL): add and addFrom build byte-identical registers over mixed-sign keys incl +-(2^53-1) and -0', () => {
    const keys = [0, -0, 1, -1, 7, -7, 2 ** 30, 2 ** 31, -(2 ** 31), 2 ** 32 - 1, 2 ** 32 + 5, -(2 ** 32 + 5), 2 ** 53 - 1, -(2 ** 53 - 1)];
    for (const seed of [undefined, 42, -3]) {
        const a = new HyperLogLog(12, seed), b = new HyperLogLog(12, seed);
        const F = new Float64Array(3);
        for (const k of keys) { a.add(k); F[1] = k; b.addFrom(F, 1); }
        h26Eq(a, b, 'seed ' + seed + ': addFrom twin != add');
    }
});

test('H2.6 (HLL): addHashedFrom (Uint32Array and Int32Array) equals addHashed (idempotent register max)', () => {
    const a = new HyperLogLog(12), b = new HyperLogLog(12);
    const U = new Uint32Array(2), I = new Int32Array(2);
    for (let t = 0; t < 5000; t++) {
        const hi = Math.imul(t + 1, 2654435761) >>> 0, lo = Math.imul(t ^ 0x5bd1e995, 40503) >>> 0;
        a.addHashed(hi, lo);
        U[0] = hi; U[1] = lo; b.addHashedFrom(U, 0);
        I[0] = hi; I[1] = lo; b.addHashedFrom(I, 0);   // same 32 bits reinterpreted
    }
    h26Eq(a, b, 'addHashedFrom U32/I32 != addHashed');
});

test('H2.6 (HLL): addFrom rejects a bad buffer / index with a tagged TypeError, byte-identical no-op', () => {
    const s = new HyperLogLog(10); s.add(123);
    const before = h26Snap(s);
    const F = new Float64Array(2);
    for (const bad of [new Float32Array(2), new Int32Array(2), [1, 2], new DataView(new ArrayBuffer(16)), null, undefined, {}]) {
        assert.throws(() => s.addFrom(bad, 0),
            (e) => e instanceof TypeError && /\[lite-sketch\] HyperLogLog\.addFrom/.test(e.message), 'buf ' + String(bad));
    }
    for (const i of [0.5, -1, NaN, Infinity, 2]) {   // length 2 -> only i = 0 / 1 are in bounds
        assert.throws(() => s.addFrom(F, i),
            (e) => e instanceof TypeError && /HyperLogLog\.addFrom/.test(e.message), 'i ' + i);
    }
    assert.deepEqual(h26Snap(s), before, 'a bad addFrom mutated state');
});

test('H2.6 (HLL): a value addFrom would reject throws add\'s exact error (class + message), byte-identical no-op', () => {
    const s = new HyperLogLog(10); s.add(5);
    const before = h26Snap(s);
    const F = new Float64Array(1);
    for (const v of [1.5, 2 ** 53, -(2 ** 53), Infinity, -Infinity, NaN]) {
        F[0] = v;
        let eAdd = null, eFrom = null;
        try { s.add(v); } catch (e) { eAdd = e; }
        try { s.addFrom(F, 0); } catch (e) { eFrom = e; }
        assert.ok(eFrom, 'addFrom(' + v + ') did not throw');
        assert.equal(eFrom.constructor, eAdd.constructor, v + ' class');
        assert.equal(eFrom.message, eAdd.message, v + ' message');
    }
    assert.deepEqual(h26Snap(s), before, 'a rejected value mutated state');
});

test('H2.6 (HLL): addHashedFrom rejects a bad buffer / index (needs i and i+1 in range)', () => {
    const s = new HyperLogLog(10); const before = h26Snap(s);
    // QA H2.6: every predicate pins the [lite-sketch] tag -- a bare TypeError also matched HEAD's
    // "s.addHashedFrom is not a function", so this test passed vacuously on b4e378f.
    const tagged = (e) => e instanceof TypeError && /^\[lite-sketch\] HyperLogLog\.addHashedFrom\(buf, i\)/.test(e.message);
    assert.throws(() => s.addHashedFrom(new Float64Array(2), 0), tagged);
    assert.throws(() => s.addHashedFrom(new Uint32Array(2), 1), tagged);   // i+1 = 2 out of range
    assert.throws(() => s.addHashedFrom(new Uint32Array(2), -1), tagged);
    assert.throws(() => s.addHashedFrom(new Uint32Array(2), 0.5), tagged);
    assert.deepEqual(h26Snap(s), before);
});

test('H2.6 (HLL): _buf is per instance -- interleaved add instances equal solo twins', () => {
    const x = new HyperLogLog(12), y = new HyperLogLog(12), xs = new HyperLogLog(12), ys = new HyperLogLog(12);
    for (let k = 0; k < 3000; k++) {
        const a = (k * 2654435761) % (2 ** 40), b = -((k * 40503) % (2 ** 35));
        x.add(a); y.add(b); xs.add(a); ys.add(b);   // x / y interleave; xs / ys are solo
    }
    h26Eq(x, xs, 'interleaved x != solo'); h26Eq(y, ys, 'interleaved y != solo');
});

// ===========================================================================
// H2.6 TEETH -- exact HEAD error literals (not just add==addFrom equivalence, which
// a both-sides mutant survives) + addHashedFrom fail-closed on a non-int32 lane.
// ===========================================================================
test('H2.6 (HLL TEETH): add / addFrom pin HEAD\'s exact bad-key error class + message', () => {
    const LITS = [
        [NaN, 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got NaN'],
        ['1', 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got 1'],
        [1.5, 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got 1.5'],
        [Symbol('z'), 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got Symbol(z)'],
        [2 ** 53, 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got 9007199254740992'],
        [-(2 ** 53), 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got -9007199254740992'],
        [Infinity, 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got Infinity'],
        [null, 'TypeError', '[lite-sketch] HyperLogLog.add key must be a number, got null'],
    ];
    const s = new HyperLogLog(10); s.add(7);
    const before = Array.from(s._reg);
    const F = new Float64Array(1);
    for (const [k, cls, msg] of LITS) {
        assert.throws(() => s.add(k), (e) => e.constructor.name === cls && e.message === msg, 'add ' + String(k));
        if (typeof k === 'number') { F[0] = k; assert.throws(() => s.addFrom(F, 0), (e) => e.constructor.name === cls && e.message === msg, 'addFrom ' + String(k)); }
    }
    assert.deepEqual(Array.from(s._reg), before, 'teeth rejects mutated state');
});

test('H2.6 (HLL TEETH): addHashedFrom fails closed on a non-int32 lane (Proxy), byte-identical no-op', () => {
    const s = new HyperLogLog(10); s.add(42);
    const before = Array.from(s._reg);
    for (const v of [undefined, 'x', NaN, 2 ** 40, -1.5, Infinity, null, 1.5]) {
        const pHi = new Proxy(new Uint32Array([0, 123]), { get(t, k) { return k === '0' ? v : t[k]; } });
        assert.throws(() => s.addHashedFrom(pHi, 0),
            (e) => e instanceof TypeError && e.message === '[lite-sketch] HyperLogLog.addHashed lanes must be uint32, got ' + String(v), 'hi=' + String(v));
        const pLo = new Proxy(new Uint32Array([123, 0]), { get(t, k) { return k === '1' ? v : t[k]; } });
        assert.throws(() => s.addHashedFrom(pLo, 0),
            (e) => e instanceof TypeError && /addHashed lanes must be uint32/.test(e.message), 'lo=' + String(v));
    }
    assert.deepEqual(Array.from(s._reg), before, 'a bad lane mutated state');
});

test('H2.6 (HLL TEETH): addHashedFrom rejects an out-of-bounds lane from an overridden-length view', () => {
    class Evil extends Uint32Array { get length() { return 99; } }   // backing 1, lies as 99
    const s = new HyperLogLog(10); const before = Array.from(s._reg);
    assert.throws(() => s.addHashedFrom(new Evil(1), 0),
        (e) => e instanceof TypeError && /addHashed lanes must be uint32/.test(e.message));
    assert.deepEqual(Array.from(s._reg), before);
});

test('H2.6 (HLL): addHashedFrom accepts an Int32Array (negative lanes reinterpreted as uint32) == addHashed', () => {
    const a = new HyperLogLog(12), b = new HyperLogLog(12);
    const I = new Int32Array(2);
    for (let t = 0; t < 3000; t++) {
        const hi = (t * -2654435761) | 0, lo = (t ^ 0x5bd1e995) | 0;
        a.addHashed(hi >>> 0, lo >>> 0); I[0] = hi; I[1] = lo; b.addHashedFrom(I, 0);
    }
    assert.deepEqual(Array.from(a._reg), Array.from(b._reg));
});

// ===========================================================================
// QA H2.6 -- boundary matrix for addFrom / addHashedFrom (HLL). Index 0 / 1 /
// N-1 / N / N+1 / -0 / empty / null / undefined / NaN / string; views with a
// byteOffset, a SharedArrayBuffer, a detached buffer (structuredClone transfer)
// and a shrunk resizable buffer; the value matrix through addFrom == add; a
// Proxy that re-enters the SAME sketch mid-read; duplicate clear().
// ===========================================================================
const qa26Err = (fn) => { try { fn(); return null; } catch (e) { return e.constructor.name + ': ' + e.message; } };
const qa26BufRe = /^\[lite-sketch\] HyperLogLog\.addFrom\(buf, i\) needs a Float64Array/;
const qa26HBufRe = /^\[lite-sketch\] HyperLogLog\.addHashedFrom\(buf, i\) needs a Uint32Array or Int32Array/;

test('QA H2.6 (HLL): addFrom index matrix 0 / 1 / N-1 accepted == add; N / N+1 / empty / -1 / NaN / null / undefined / "0" rejected tagged, no-op', () => {
    const KEYS = [3, 2 ** 31 + 5, -(2 ** 40), 2 ** 53 - 1, -7];
    const F = new Float64Array(KEYS);
    const N = F.length;
    for (const i of [0, 1, N - 1, -0]) {
        const a = new HyperLogLog(10), b = new HyperLogLog(10);
        a.add(KEYS[i === 0 ? 0 : i]); b.addFrom(F, i);
        h26Eq(a, b, 'i ' + i);
    }
    const s = new HyperLogLog(10); s.add(77);
    const before = h26Snap(s);
    for (const i of [N, N + 1, -1, NaN, null, undefined, '0', 1.5, -Infinity, 2 ** 53])
        assert.match(qa26Err(() => s.addFrom(F, i)), /^TypeError: \[lite-sketch\] HyperLogLog\.addFrom/, 'i ' + String(i));
    assert.match(qa26Err(() => s.addFrom(new Float64Array(0), 0)), /^TypeError: /, 'empty buffer');
    assert.ok(qa26BufRe.test(qa26Err(() => s.addFrom(new Float64Array(0), 0)).slice(11)));
    assert.deepEqual(h26Snap(s), before, 'a rejected index mutated the registers');
});

test('QA H2.6 (HLL): addFrom over a byteOffset view, a SharedArrayBuffer view and a grown length-tracking view == add', () => {
    const base = new Float64Array([0, 0, 0, 2 ** 33 + 1, -(2 ** 31) - 3]);
    const view = base.subarray(3);                 // byteOffset 24, length 2
    assert.equal(view.byteOffset, 24);
    const a = new HyperLogLog(12), b = new HyperLogLog(12);
    a.add(2 ** 33 + 1); a.add(-(2 ** 31) - 3);
    b.addFrom(view, 0); b.addFrom(view, view.length - 1);
    h26Eq(a, b, 'subarray view');
    const S = new Float64Array(new SharedArrayBuffer(16)); S[0] = 2 ** 33 + 1; S[1] = -(2 ** 31) - 3;
    const c = new HyperLogLog(12); c.addFrom(S, 0); c.addFrom(S, 1);
    h26Eq(a, c, 'SharedArrayBuffer view');
    const rab = new ArrayBuffer(8, { maxByteLength: 32 });
    const T = new Float64Array(rab);               // length-tracking
    const d = new HyperLogLog(12);
    assert.match(qa26Err(() => d.addFrom(T, 1)), /^TypeError: \[lite-sketch\] HyperLogLog\.addFrom/, 'before grow: i 1 out of bounds');
    rab.resize(16); T[0] = 2 ** 33 + 1; T[1] = -(2 ** 31) - 3;
    d.addFrom(T, 0); d.addFrom(T, 1);
    h26Eq(a, d, 'grown length-tracking view');
});

test('QA H2.6 (HLL): a detached or shrunk buffer rejects tagged with a byte-identical no-op (addFrom and addHashedFrom)', () => {
    const s = new HyperLogLog(10); s.add(5); s.add(2 ** 40);
    const before = h26Snap(s);
    const F = new Float64Array([9, 10]); structuredClone(F.buffer, { transfer: [F.buffer] });
    assert.equal(F.length, 0, 'detached');
    assert.match(qa26Err(() => s.addFrom(F, 0)), /^TypeError: \[lite-sketch\] HyperLogLog\.addFrom/);
    const U = new Uint32Array([1, 2, 3]); structuredClone(U.buffer, { transfer: [U.buffer] });
    assert.match(qa26Err(() => s.addHashedFrom(U, 0)), /^TypeError: \[lite-sketch\] HyperLogLog\.addHashedFrom/);
    const rab = new ArrayBuffer(32, { maxByteLength: 32 });
    const R = new Float64Array(rab); R[3] = 123;
    rab.resize(16);                                 // R.length 4 -> 2: index 3 is gone
    assert.match(qa26Err(() => s.addFrom(R, 3)), /^TypeError: \[lite-sketch\] HyperLogLog\.addFrom/);
    assert.deepEqual(h26Snap(s), before, 'detached / shrunk reject mutated the registers');
});

test('QA H2.6 (HLL): addFrom value matrix (-0, +-(2^53-1), +-2^53, NaN, +-Infinity, 1.5, 5e-324) == add (error class + message, or registers)', () => {
    const VALS = [0, -0, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity, 1.5, -1.5, 5e-324, 2 ** 31, -(2 ** 31)];
    const F = new Float64Array(1);
    for (const v of VALS) {
        const a = new HyperLogLog(10), b = new HyperLogLog(10);
        a.add(11); b.add(11);
        const ea = qa26Err(() => a.add(v));
        F[0] = v;
        const eb = qa26Err(() => b.addFrom(F, 0));
        assert.equal(eb, ea, 'key ' + v + ': addFrom outcome != add');
        h26Eq(a, b, 'key ' + v + ': registers');
    }
    // -0 and 0 are the same key
    const z = new HyperLogLog(10), nz = new HyperLogLog(10);
    F[0] = 0; z.addFrom(F, 0); F[0] = -0; nz.addFrom(F, 0);
    h26Eq(z, nz, '-0 == 0');
});

test('QA H2.6 (HLL): addHashedFrom at the end of a Uint32Array / Int32Array: N-2 accepted, N-1 / N / -0 / empty boundaries', () => {
    for (const Ctor of [Uint32Array, Int32Array]) {
        const U = new Ctor(5);
        U[3] = 0x80000001 | 0; U[4] = 7;
        const a = new HyperLogLog(10), b = new HyperLogLog(10);
        a.addHashed(0x80000001, 7); b.addHashedFrom(U, U.length - 2);
        h26Eq(a, b, Ctor.name + ' i = N-2');
        const c = new HyperLogLog(10); U[0] = 0x80000001 | 0; U[1] = 7; c.addHashedFrom(U, -0);
        h26Eq(a, c, Ctor.name + ' i = -0');
        const before = h26Snap(b);
        for (const i of [U.length - 1, U.length, U.length + 1, -1, NaN, null, undefined])
            assert.match(qa26Err(() => b.addHashedFrom(U, i)), /^TypeError: \[lite-sketch\] HyperLogLog\.addHashedFrom/, Ctor.name + ' i ' + String(i));
        assert.ok(qa26HBufRe.test(qa26Err(() => b.addHashedFrom(new Ctor(0), 0)).slice(11)), Ctor.name + ' empty');
        assert.match(qa26Err(() => b.addHashedFrom(new Ctor(1), 0)), /^TypeError: /, Ctor.name + ' length 1');
        assert.deepEqual(h26Snap(b), before, Ctor.name + ' rejects mutated the registers');
        // byteOffset view
        const V = new Ctor(6).subarray(4); V[0] = 0x80000001 | 0; V[1] = 7;
        const d = new HyperLogLog(10); d.addHashedFrom(V, 0);
        h26Eq(a, d, Ctor.name + ' subarray view');
    }
});

test('QA H2.6 (HLL): a Proxy that RE-ENTERS the same sketch mid-read still adds the caller key (each slot read once into a local)', () => {
    const a = new HyperLogLog(12), b = new HyperLogLog(12);
    a.add(2 ** 33 + 9); a.add(424242);
    let fired = false;
    const px = new Proxy(new Float64Array([2 ** 33 + 9]), {
        get(t, k) { if (k === '0' && !fired) { fired = true; b.add(424242); } return t[k]; },
    });
    b.addFrom(px, 0);
    assert.ok(fired);
    h26Eq(a, b, 're-entrant addFrom != add, add');
});

test('QA H2.6 (HLL): duplicate clear() then addFrom / addHashedFrom == a fresh sketch; interleaved add / addFrom on two instances == solo', () => {
    const s = new HyperLogLog(10), fresh = new HyperLogLog(10);
    for (let k = 0; k < 500; k++) s.add(k * 7919);
    s.clear(); s.clear();
    const F = new Float64Array([2 ** 45 + 3]), U = new Uint32Array([0xdeadbeef, 1]);
    s.addFrom(F, 0); s.addHashedFrom(U, 0);
    fresh.add(2 ** 45 + 3); fresh.addHashed(0xdeadbeef, 1);
    h26Eq(s, fresh, 'after duplicate clear');
    const x = new HyperLogLog(11), y = new HyperLogLog(11), xs = new HyperLogLog(11), ys = new HyperLogLog(11);
    const G = new Float64Array(1);
    for (let k = 0; k < 4000; k++) {
        const kx = (k * 2654435761) % (2 ** 40), ky = -((k * 40503) % (2 ** 35)) - 1;
        if (k & 1) x.add(kx); else { G[0] = kx; x.addFrom(G, 0); }
        G[0] = ky; y.addFrom(G, 0);
        if (k & 2) y.add(ky + 1); else { G[0] = ky + 1; y.addFrom(G, 0); }
        xs.add(kx); ys.add(ky); ys.add(ky + 1);
    }
    h26Eq(x, xs, 'interleaved x != solo'); h26Eq(y, ys, 'interleaved y != solo');
});

// ===========================================================================
// H2.7 G-F21: merge is BRAND-checked, not instanceof. A class-private `#brand` is installed by
// the ctor on every REAL instance; `#brand in other` runs no user code, is false for a Proxy
// over an instance and for a field-copy forgery, and the brand predicate is the FIRST statement
// of merge / _badMerge (before any read of `other`). On HEAD (`instanceof`) both forgeries pass
// and merge silently; see headrun/ in the scratchpad for the HEAD-failure evidence.
// ===========================================================================

function countingProxy(real, counter) {
    return new Proxy(real, {
        get(t, k, r) { counter.n++; return Reflect.get(t, k, r); },
        has(t, k) { counter.n++; return Reflect.has(t, k); },
        getPrototypeOf(t) { counter.n++; return Reflect.getPrototypeOf(t); },
    });
}

test('G-F21 (HLL): merge rejects a field-copy forgery + a Proxy over a real instance, TAGGED, 0 traps', () => {
    const base = new HyperLogLog(12, 7);
    for (let i = 0; i < 500; i++) base.add(i);
    const real = new HyperLogLog(12, 7);
    for (let i = 0; i < 500; i++) real.add(i + 100000);
    const snap = base._reg.slice();

    // Field-copy forgery: X.prototype + every own field, but NOT the private #brand.
    const forged = Object.assign(Object.create(HyperLogLog.prototype), real);
    assert.ok(forged instanceof HyperLogLog, 'the forgery passes instanceof (what HEAD trusted)');
    assert.throws(() => base.merge(forged), (e) => e instanceof TypeError && liteSketch(e), 'field-copy forgery');
    assert.deepEqual(base._reg, snap, 'field-copy reject is a byte-identical no-op');

    // Proxy over a real instance: instanceof passes, the brand does not; 0 traps fire in merge.
    const counter = { n: 0 };
    const px = countingProxy(real, counter);
    assert.ok(px instanceof HyperLogLog, 'the Proxy passes instanceof');
    counter.n = 0;   // discard the instanceof getPrototypeOf trap; measure only the merge
    assert.throws(() => base.merge(px), (e) => e instanceof TypeError && liteSketch(e), 'Proxy merge');
    assert.equal(counter.n, 0, 'the brand check ran NO proxy trap (no read of other)');
    assert.deepEqual(base._reg, snap, 'Proxy reject is a byte-identical no-op');
});

test('G-F21 (HLL): merge(primitive / null / undefined) throws TAGGED (the typeof / null guard)', () => {
    const base = new HyperLogLog(12, 7);
    base.add(1);
    const snap = base._reg.slice();
    for (const o of [5, 0, 'x', true, Symbol('s'), null, undefined, NaN]) {
        assert.throws(() => base.merge(o), liteSketch, 'merge(' + String(o) + ') throws tagged');
    }
    assert.deepEqual(base._reg, snap, 'primitive / null rejects are no-ops');
});

test('G-F21 (HLL): a subclass instance merges (super() installs the brand)', () => {
    class SubHLL extends HyperLogLog {}
    const base = new HyperLogLog(12, 7);
    const sub = new SubHLL(12, 7);
    for (let i = 0; i < 300; i++) { base.add(i); sub.add(i + 500000); }
    assert.doesNotThrow(() => base.merge(sub), 'a subclass carries the brand and merges');
    assert.ok(base.count() > 0);
});

// ===========================================================================
// H2.7 qa boundary suite -- merge brand edges
// ===========================================================================

test('QA H2.7 (HLL): merge brand -- a second module instance rejected TAGGED, no-op; overriding subclass via super; self-merge stays legal', async () => {
    const M2 = await import(new URL('../Sketch.js', import.meta.url).href + '?qa-second-instance-hll');
    const a = new HyperLogLog(10), b = new M2.HyperLogLog(10);
    for (let i = 0; i < 100; i++) { a.add(i); b.add(i + 1000); }
    const before = Array.from(a._reg);
    assert.throws(() => a.merge(b), (e) => e instanceof TypeError && /merge expects a HyperLogLog/.test(e.message) && liteSketch(e));
    assert.throws(() => b.merge(a), (e) => e instanceof TypeError && /merge expects a HyperLogLog/.test(e.message));
    assert.deepEqual(Array.from(a._reg), before);
    let over = 0;
    class Sub extends HyperLogLog { merge(o) { over++; return super.merge(o); } }
    const x = new Sub(10);
    x.merge(a);
    assert.equal(over, 1);
    assert.deepEqual(Array.from(x._reg), before);
    a.merge(a);
    assert.deepEqual(Array.from(a._reg), before, 'self-merge is idempotent');
    // A real instance of a SIBLING class is not a HyperLogLog (each class has its own brand).
    const { CountMinSketch } = await import('../Sketch.js');
    assert.throws(() => a.merge(new CountMinSketch(4, 64)), (e) => e instanceof TypeError && /merge expects a HyperLogLog/.test(e.message));
});
