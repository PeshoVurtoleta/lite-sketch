/**
 * @zakkster/lite-sketch -- the canonical two-lane 64-bit hash suite (node:test).
 *
 * Proves the hash contract that every member's accuracy claim ASSUMES:
 *   1. Determinism: same (key, seed) -> same (HI, LO); different seeds decorrelate.
 *   2. Avalanche: over >= 2048 random 32-bit inputs, flipping EACH of the 32 input
 *      bits flips ~half of the 64 output bits (mean flip fraction in [0.45, 0.55]),
 *      and no output bit is stuck (each flips for some input).
 *   3. hashString: determinism, distinct strings -> distinct lanes, no throw on '',
 *      ASCII + basic multi-byte code units.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mix64, hashHi, hashLo, hashString, saltRow, VERSION } from '../Sketch.js';

test('VERSION is the frozen 1.1.1 string', () => {
    assert.equal(VERSION, '1.1.1');
});

// --- determinism -----------------------------------------------------------

test('mix64: same (key, seed) -> same (HI, LO), byte-identical', () => {
    const seed = 0x9e3779b1;
    for (const key of [0, 1, 2, 42, 1000, -7, 2 ** 31, 2 ** 40, 9007199254740991]) {
        mix64(key, seed);
        const hi1 = hashHi(), lo1 = hashLo();
        mix64(key, seed);
        assert.equal(hashHi(), hi1);
        assert.equal(hashLo(), lo1);
        // lanes are uint32
        assert.ok(hi1 >= 0 && hi1 <= 0xffffffff && (hi1 >>> 0) === hi1);
        assert.ok(lo1 >= 0 && lo1 <= 0xffffffff && (lo1 >>> 0) === lo1);
    }
});

test('mix64: different seeds decorrelate the same key', () => {
    let diffs = 0;
    for (let key = 0; key < 256; key++) {
        mix64(key, 1);
        const a = (hashHi() ^ hashLo()) >>> 0;
        mix64(key, 2);
        const b = (hashHi() ^ hashLo()) >>> 0;
        if (a !== b) diffs++;
    }
    // essentially every key must produce a different combined hash under a new seed
    assert.ok(diffs >= 255, 'expected near-total decorrelation, got ' + diffs + '/256');
});

test('mix64: HI and LO are not the same lane (decorrelated)', () => {
    let equal = 0;
    for (let key = 0; key < 4096; key++) {
        mix64(key, 0x1234);
        if (hashHi() === hashLo()) equal++;
    }
    assert.ok(equal <= 1, 'HI and LO collide far too often: ' + equal);
});

// --- avalanche -------------------------------------------------------------

test('mix64: avalanche mean flip fraction in [0.45, 0.55], no stuck output bit', () => {
    const N = 4096;              // >= 2048 random 32-bit inputs
    const seed = 0x51ed270b;
    let sum = 0;
    let samples = 0;
    const flipsPerOutputBit = new Array(64).fill(0);
    // deterministic PRNG so the test never flakes
    let s = 0x2545f491 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let t = 0; t < N; t++) {
        const x = rnd();
        mix64(x, seed);
        const h0 = hashHi(), l0 = hashLo();
        for (let b = 0; b < 32; b++) {
            const y = (x ^ (1 << b)) >>> 0;
            mix64(y, seed);
            const dh = (h0 ^ hashHi()) >>> 0;
            const dl = (l0 ^ hashLo()) >>> 0;
            let cnt = 0;
            for (let k = 0; k < 32; k++) {
                if ((dh >>> k) & 1) { cnt++; flipsPerOutputBit[k]++; }
                if ((dl >>> k) & 1) { cnt++; flipsPerOutputBit[32 + k]++; }
            }
            sum += cnt / 64;
            samples++;
        }
    }
    const mean = sum / samples;
    assert.ok(mean >= 0.45 && mean <= 0.55, 'avalanche mean flip fraction ' + mean.toFixed(5) + ' out of [0.45, 0.55]');
    const stuck = flipsPerOutputBit.filter((v) => v === 0).length;
    assert.equal(stuck, 0, stuck + ' output bit(s) never flipped');
});

// --- hashString ------------------------------------------------------------

test('hashString: deterministic for same (str, seed)', () => {
    for (const str of ['', 'a', 'hello', 'the quick brown fox', 'user:12345']) {
        hashString(str, 7);
        const hi1 = hashHi(), lo1 = hashLo();
        hashString(str, 7);
        assert.equal(hashHi(), hi1);
        assert.equal(hashLo(), lo1);
    }
});

test('hashString: empty string does not throw and yields uint32 lanes', () => {
    assert.doesNotThrow(() => hashString('', 0));
    hashString('', 0);
    assert.equal(hashHi() >>> 0, hashHi());
    assert.equal(hashLo() >>> 0, hashLo());
});

test('hashString: distinct strings -> distinct lane pairs', () => {
    const seen = new Set();
    // include high code units (built alloc-free from char codes to keep source ASCII)
    const strs = ['', 'a', 'b', 'ab', 'ba', 'abc', 'hello', 'world', 'user:1', 'user:2',
        'hi' + String.fromCharCode(0x00b5), 'x' + String.fromCharCode(0x00d7) + 'y', String.fromCharCode(0x4e2d, 0x6587)];
    for (const str of strs) {
        hashString(str, 0x9e3779b1);
        const key = (hashHi() >>> 0) + ':' + (hashLo() >>> 0);
        assert.ok(!seen.has(key), 'lane collision for ' + JSON.stringify(str));
        seen.add(key);
    }
});

test('hashString: different seeds decorrelate the same string', () => {
    hashString('collision', 1);
    const a = (hashHi() ^ hashLo()) >>> 0;
    hashString('collision', 2);
    const b = (hashHi() ^ hashLo()) >>> 0;
    assert.notEqual(a, b);
});

// --- saltRow (Count-Min row derivation, M2) --------------------------------

test('saltRow: deterministic, uint32, distinct per row index', () => {
    mix64(123456, 0x9e3779b1);
    const base = hashHi();
    const seen = new Set();
    for (let i = 0; i < 16; i++) {
        const r = saltRow(base, i);
        assert.equal(r >>> 0, r, 'saltRow must return a uint32');
        assert.equal(saltRow(base, i), r, 'saltRow must be deterministic');
        seen.add(r);
    }
    assert.ok(seen.size >= 15, 'row salts should be near-distinct, got ' + seen.size + '/16');
});
