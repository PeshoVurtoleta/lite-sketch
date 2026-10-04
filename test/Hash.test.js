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

test('VERSION is the frozen 1.1.2 string', () => {
    assert.equal(VERSION, '1.1.2');
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

// ===========================================================================
// G-F12 (hash sign bit): a negative key's sign lives in bit 31 of the high word
// (`hiw ^ (neg << 31)`), so -k and k no longer collide on bit 0. The negative-vector
// and pair tests FAIL on HEAD (where the sign was bit 0 -- a magnitude bit).
// ===========================================================================

test('G-F12 (hash): the pair (-(H*2^32+L), (H^1)*2^32+L) separates on BOTH lanes over 1e5 keys', () => {
    const N = 100000;
    let both = 0;
    for (let i = 0; i < N; i++) {
        const H = (i % 1000) + 1;
        const L = (i * 2654435761) >>> 0;
        const k1 = -(H * 4294967296 + L);
        const k2 = (H ^ 1) * 4294967296 + L;
        mix64(k1, 7); const a1h = hashHi(), a1l = hashLo();
        mix64(k2, 7); const a2h = hashHi(), a2l = hashLo();
        if (a1h !== a2h && a1l !== a2l) both++;
    }
    assert.equal(both, N, 'every pair must separate on both lanes (HEAD: all collide)');
});

test('G-F12 (hash): mix64(-0, s) === mix64(0, s) -- negative zero is not a negative key', () => {
    for (const s of [0x9e3779b1, 1, 123]) {
        mix64(-0, s); const nh = hashHi(), nl = hashLo();
        mix64(0, s); const ph = hashHi(), pl = hashLo();
        assert.equal(nh, ph, 'hi seed=' + s);
        assert.equal(nl, pl, 'lo seed=' + s);
    }
});

test('G-F12 (hash): golden POSITIVE vectors are bit-identical to HEAD (positive parity)', () => {
    // Cut from `git show HEAD:Sketch.js` BEFORE the H2.4 edit; the sign split must not
    // perturb any non-negative key. k in {0, 1, 2^31, 2^32-1, 2^32, 2^32+1, 2^53-1, 1.5}.
    const GOLDEN_POS = [
        [0x9e3779b1, [[0, 2362355725, 2021278343], [1, 3200788411, 2496031126], [2 ** 31, 1978638733, 1058767606], [2 ** 32 - 1, 2401977980, 1300909082], [2 ** 32, 1139062891, 1931245547], [2 ** 32 + 1, 2853606066, 4110443577], [2 ** 53 - 1, 1595987163, 2417292288], [1.5, 3200788411, 2496031126]]],
        [1, [[0, 3935659133, 1322395136], [1, 3741873941, 3242480447], [2 ** 31, 3655845367, 759505952], [2 ** 32 - 1, 2673058961, 1886042939], [2 ** 32, 4108302650, 407570088], [2 ** 32 + 1, 2688304468, 1424160707], [2 ** 53 - 1, 4036036706, 3721801793], [1.5, 3741873941, 3242480447]]],
    ];
    for (const [seed, vecs] of GOLDEN_POS) {
        for (const [k, hi, lo] of vecs) {
            mix64(k, seed);
            assert.equal(hashHi(), hi, 'hi k=' + k + ' seed=' + seed);
            assert.equal(hashLo(), lo, 'lo k=' + k + ' seed=' + seed);
        }
    }
});

test('G-F12 (hash): golden NEGATIVE vectors are pinned (FAILs on HEAD -- sign was bit 0)', () => {
    // Pinned from the H2.4 code: k in {-1, -(2^31), -(2^32+1), -(2^53-1)} at two seeds.
    const GOLDEN_NEG = [
        [0x9e3779b1, [[-1, 1034675502, 2434954898], [-(2 ** 31), 2993034131, 4207917661], [-(2 ** 32 + 1), 3774027700, 3328298424], [-(2 ** 53 - 1), 4060527541, 3493993696]]],
        [1, [[-1, 2480142199, 642811977], [-(2 ** 31), 2031817424, 739786215], [-(2 ** 32 + 1), 3084668204, 177295390], [-(2 ** 53 - 1), 674693959, 2374071941]]],
    ];
    for (const [seed, vecs] of GOLDEN_NEG) {
        for (const [k, hi, lo] of vecs) {
            mix64(k, seed);
            assert.equal(hashHi(), hi, 'hi k=' + k + ' seed=' + seed);
            assert.equal(hashLo(), lo, 'lo k=' + k + ' seed=' + seed);
        }
    }
});

// QA H2.4 boundary matrix (gap: the G-F12 pins cover 4 negative keys; nothing proved the
// new (a|0, hiw ^ (neg<<31)) word split is INJECTIVE across the int32 / uint32 / 2^32 /
// 2^53 word edges, where `a | 0` goes negative and `hiw` first turns non-zero).
const QA_EDGE = [0, 1, -1, 2 ** 31 - 1, -(2 ** 31 - 1), 2 ** 31, -(2 ** 31), -(2 ** 31) - 1,
    2 ** 32 - 1, -(2 ** 32 - 1), 2 ** 32, -(2 ** 32), 2 ** 32 + 1, -(2 ** 32 + 1),
    2 ** 40 + 104729, -(2 ** 40 + 104729), 2 ** 52, -(2 ** 52), 2 ** 53 - 2, -(2 ** 53 - 2),
    2 ** 53 - 1, -(2 ** 53 - 1), (2 ** 21 - 1) * 4294967296, -((2 ** 21 - 1) * 4294967296)];

test('QA H2.4 (hash): every boundary key (0, +-1, +-(2^31-1), +-2^31, +-(2^32-1), +-2^32, ' +
    '+-(2^53-1) ...) hashes to a distinct (hi,lo) at two seeds; -0 aliases 0 only', () => {
    for (const seed of [0x9e3779b1, 7]) {
        const seen = new Map();
        for (const k of QA_EDGE) {
            mix64(k, seed);
            const id = hashHi() + ':' + hashLo();
            assert.ok(!seen.has(id), 'k=' + k + ' collides with k=' + seen.get(id) + ' at seed ' + seed);
            seen.set(id, k);
        }
        mix64(-0, seed);
        assert.equal(seen.get(hashHi() + ':' + hashLo()), 0, '-0 hashes exactly as 0');
    }
});

test('QA H2.4 (hash): ADVERSARIAL -- -k never aliases ANY high-word bit flip of k ' +
    '(the old sign-on-bit-0 collision generalised to every high-word bit 0..20)', () => {
    // On HEAD the sign was xor-ed into bit 0 of the high word, so -k aliased k ^ 2^32. A bad
    // encoding could alias any other high-word bit; probe every bit a safe integer can own.
    let collisions = 0, checked = 0;
    for (let i = 1; i <= 64; i++) {
        const L = (i * 2654435761) >>> 0;
        const H = i * 997 % 2097152;
        const k = H * 4294967296 + L;
        mix64(-k, 7); const nh = hashHi(), nl = hashLo();
        for (let b = 0; b < 21; b++) {
            const k2 = (H ^ (1 << b)) * 4294967296 + L;
            if (k2 > 9007199254740991) continue;
            mix64(k2, 7); checked++;
            if (hashHi() === nh || hashLo() === nl) collisions++;
        }
    }
    assert.ok(checked > 1000, 'checked ' + checked);
    assert.equal(collisions, 0, 'a negative key must not share a lane with any bit-flip twin');
});
