// @zakkster/lite-sketch -- the ACCURACY witness (repo-only; run: `node test/witness.mjs`).
//
// The honesty anchor of the family: drive each member on a stream with an EXACT oracle,
// MEASURE the error, and GATE it against the paper's THEORETICAL bound -- printing
// MEASURED vs THEORETICAL side by side. For HyperLogLog the oracle is the true distinct
// count N (we add N distinct keys), the theoretical bound is the standard error
// 1.04/sqrt(m), and the FOIL is the exact Set, whose memory grows O(distinct) while the
// sketch stays a fixed m bytes. Independent trials (a fresh per-instance hash seed each)
// give independent error samples; we gate the RMS relative error over the sweep.
//
// GATES: for every (p, N) cell across the full cardinality range (incl. the mid-range
// that biases a raw+linear-counting scheme -- Ertl's estimator must hold there), the RMS
// relative error / theoretical std err is in [0.4, 1.5] -- the upper bound is the accuracy
// gate; the lower bound proves the error genuinely TRACKS 1.04/sqrt(m) (so it HALVES as
// p += 2, since the theoretical std itself halves when m quadruples -- a stronger, less
// noisy statement than an absolute cross-cell RMS ratio, which fluctuates at 24 trials).
// The max |relerr| <= ~3.5 sigma (the ~3-sigma tail with a small-trial allowance). The
// absolute error-halving ratio is REPORTED for the eye but not gated (sampling noise).

import { HyperLogLog, CountMinSketch } from '../Sketch.js';

const PS = [10, 12, 14];
const NS = [1000, 10000, 100000];
const TRIALS = 24;
const SEED_BASE = 0x1234567;

function fmt(x) { return Number.isFinite(x) ? x.toFixed(4) : String(x); }
function pct(x) { return (x * 100).toFixed(2) + '%'; }
function nStr(n) { return n >= 1e6 ? (n / 1e6) + 'M' : n >= 1e3 ? (n / 1e3) + 'k' : String(n); }

// rmsRelErr: RMS of the relative error over TRIALS independent sketches at (p, N).
function measure(p, N) {
    let sumSq = 0;
    let maxAbs = 0;
    for (let t = 0; t < TRIALS; t++) {
        const h = new HyperLogLog(p, (SEED_BASE + t * 0x9e3779b1) >>> 0);
        for (let i = 0; i < N; i++) h.add(i);
        const rel = (h.count() - N) / N;
        sumSq += rel * rel;
        const a = Math.abs(rel);
        if (a > maxAbs) maxAbs = a;
    }
    return { rms: Math.sqrt(sumSq / TRIALS), maxAbs };
}

console.log('');
console.log('ACCURACY Witness -- HyperLogLog distinct-count vs the exact-N oracle (RMS of ' +
    TRIALS + ' independent trials; theoretical std err = 1.04/sqrt(m))');
console.log('');
console.log('  p   m        N       RMS relerr   theo std   RMS/theo   max relerr (<=3.5 sig)');
console.log('  --  -------  ------  -----------  ---------  ---------  ----------------------');

let ok = true;
const rmsByCell = {};   // rmsByCell[p][N]
for (const p of PS) {
    rmsByCell[p] = {};
    const m = 1 << p;
    const theo = 1.04 / Math.sqrt(m);
    for (const N of NS) {
        const { rms, maxAbs } = measure(p, N);
        rmsByCell[p][N] = rms;
        const ratio = rms / theo;
        const rmsOk = ratio >= 0.4 && ratio <= 1.5;   // upper = accuracy; lower = "tracks 1.04/sqrt(m)"
        const tailOk = maxAbs <= 3.5 * theo;
        if (!rmsOk || !tailOk) ok = false;
        console.log('  ' + String(p).padEnd(2) + '  ' + String(m).padEnd(7) + '  ' +
            nStr(N).padEnd(6) + '  ' + pct(rms).padStart(11) + '  ' + pct(theo).padStart(9) + '  ' +
            (fmt(ratio) + 'x').padStart(9) + '  ' + (pct(maxAbs) + (tailOk ? '' : ' !')).padStart(22) +
            (rmsOk ? '' : '   <- RMS/theo out of [0.4, 1.5] FAIL'));
    }
}

// Error-halves-as-p+=2 (INFORMATIONAL, not gated): the ideal RMS(p+2)/RMS(p) is ~0.5
// (m quadruples). At 24 trials the absolute ratio is noisy; the gated per-cell RMS/theo
// bound above is the robust proof that error tracks 1.04/sqrt(m) (and so halves per +2 p).
console.log('');
console.log('  error-halves (info only; ideal ~0.5x, noisy at ' + TRIALS + ' trials):');
for (let i = 0; i + 1 < PS.length; i++) {
    const p = PS[i];
    const p2 = PS[i + 1];
    if (p2 - p !== 2) continue;
    for (const N of NS) {
        const r = rmsByCell[p][N];
        const r2 = rmsByCell[p2][N];
        console.log('    N=' + nStr(N).padEnd(5) + '  p' + p + '->' + pct(r) + '  p' + p2 + '->' +
            pct(r2) + '  ratio ' + fmt(r2 / r));
    }
}

// Space co-headline: the exact Set foil grows O(distinct); HLL stays fixed at m bytes.
console.log('');
const bigN = 1000000;
const hBig = new HyperLogLog(14);
for (let i = 0; i < bigN; i++) hBig.add(i);
const estBig = hBig.count();
const relBig = Math.abs(estBig - bigN) / bigN;
const setBytes = bigN * 8;         // a Set of 1M numbers, ~8 B/entry lower bound (references + slots are more)
const hllBytes = hBig.m;           // one byte per register
console.log('  space co-headline @ N=1M, p=14:  HyperLogLog = ' + (hllBytes / 1024).toFixed(0) +
    ' KB (fixed)  vs  exact Set >= ' + (setBytes / 1024 / 1024).toFixed(1) + ' MB (grows O(distinct))  |  est=' +
    estBig + ' relerr=' + pct(relBig) + ' (3sig=' + pct(3 * hBig.standardError) + ')');
if (relBig > 3.5 * hBig.standardError) ok = false;

console.log('');
console.log('WITNESS HyperLogLog ' + (ok ? 'ok' : 'FAIL'));
const hllOk = ok;

// ===========================================================================
// CountMinSketch -- point-query frequency vs the exact Map oracle
// ===========================================================================
//
// The oracle is an exact `Map<key, count>` fed the SAME Zipfian stream as the sketch.
// The theoretical bound (Cormode-Muthukrishnan): a point query over-estimates by AT
// MOST `epsilon * total` with probability >= `1 - delta`, `epsilon = e/w`, `delta =
// e^-d`. We measure, over every DISTINCT key actually queried, the fraction whose
// over-estimate exceeds `epsilon*total` and gate it against `delta` (with a small
// safety slack -- see test/CountMinSketch.test.js for the derivation of the slack:
// this is a single-stream per-query Markov bound, not a repeated-trial concentration
// statement, so a bare `<= delta` at exactly the boundary would be too tight to be a
// meaningful STATISTICAL gate at one draw). We ALSO print the honesty headline (max /
// mean relative over-estimate vs the epsilon*N bound) and the space co-headline
// (d*w*4 bytes for the sketch vs the exact Map's footprint), and gate that
// conservative's measured error never exceeds plain's on the identical stream.

function fmtInt(x) { return x.toLocaleString('en-US'); }

function makeCmsRng(seed) {
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

/** Drive one Zipfian stream against ONE sketch + the exact Map oracle; return the measured stats. */
function measureCms(sketch, N, nKeys, skew, seed) {
    const rng = makeCmsRng(seed);
    const zipf = makeZipf(nKeys, skew, rng);
    const truth = new Map();
    for (let i = 0; i < N; i++) {
        const key = zipf();
        sketch.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    const bound = sketch.epsilon * sketch.total;
    let violations = 0;
    let maxOver = 0;
    let sumOver = 0;
    let underCount = 0;
    for (const [key, trueCount] of truth) {
        const est = sketch.estimate(key);
        if (est < trueCount) underCount++;         // one-sidedness must NEVER break
        const over = est - trueCount;
        sumOver += over;
        if (over > maxOver) maxOver = over;
        if (over > bound) violations++;
    }
    return {
        distinct: truth.size,
        fraction: violations / truth.size,
        maxOver,
        meanOver: sumOver / truth.size,
        bound,
        underCount,
    };
}

console.log('');
console.log('ACCURACY Witness -- CountMinSketch point-query frequency vs the exact-Map oracle ' +
    '(Zipfian stream, skew=1.1; theoretical: over-estimate <= epsilon*N w.p. >= 1-delta)');
console.log('');
console.log('  epsilon    delta      d   w        N        distinct  violFrac    <=slack*delta  ' +
    'maxOver  meanOver  bound      underCount');
console.log('  ---------  ---------  --  -------  -------  --------  ----------  --------------  ' +
    '-------  --------  ---------  ----------');

const CMS_N = 300000;      // a solid 3e5 stream (1e6 is also fine but slower for a repo-gated witness)
const CMS_NKEYS = 20000;
const CMS_SKEW = 1.1;
const CMS_SLACK = 3;       // see test/CountMinSketch.test.js: a single-stream Markov bound needs slack
const cmsSweep = [
    { epsilon: 0.01, delta: 0.1 },
    { epsilon: 0.001, delta: 0.01 },
    { epsilon: 0.001, delta: 0.001 },
];

let cmsOk = true;
for (let t = 0; t < cmsSweep.length; t++) {
    const { epsilon, delta } = cmsSweep[t];
    const c = CountMinSketch.withAccuracy(epsilon, delta);
    const r = measureCms(c, CMS_N, CMS_NKEYS, CMS_SKEW, 0xA5A5A5A5 ^ (t * 0x9e3779b1));
    const gateOk = r.underCount === 0 && r.fraction <= CMS_SLACK * c.delta;
    if (!gateOk) cmsOk = false;
    console.log('  ' + pct(c.epsilon).padStart(9) + '  ' + pct(c.delta).padStart(9) + '  ' +
        String(c.d).padEnd(2) + '  ' + String(c.w).padEnd(7) + '  ' + nStr(CMS_N).padEnd(7) + '  ' +
        String(r.distinct).padStart(8) + '  ' + pct(r.fraction).padStart(10) + '  ' +
        pct(CMS_SLACK * c.delta).padStart(14) + '  ' + String(r.maxOver).padStart(7) + '  ' +
        fmt(r.meanOver).padStart(8) + '  ' + fmt(r.bound).padStart(9) + '  ' +
        String(r.underCount).padStart(10) + (gateOk ? '' : '  <- FAIL'));
}

// Conservative <= plain: identical Zipfian stream fed to both update modes, same d/w/seed.
console.log('');
const CONS_D = 5, CONS_W = 4096, CONS_SEED = 0x1234;
const consSketch = new CountMinSketch(CONS_D, CONS_W, { seed: CONS_SEED, conservative: true });
const plainSketch = new CountMinSketch(CONS_D, CONS_W, { seed: CONS_SEED, conservative: false });
const consRng = makeCmsRng(0xC0DEC0DE);
const consZipf = makeZipf(CMS_NKEYS, CMS_SKEW, consRng);
const consKeys = [];
for (let i = 0; i < CMS_N; i++) {
    const key = consZipf();
    consKeys.push(key);
    consSketch.add(key);
    plainSketch.add(key);
}
const distinctCons = new Set(consKeys);
let consMaxOver = 0, plainMaxOver = 0, consSumOver = 0, plainSumOver = 0, consViol = 0;
const truthCons = new Map();
for (const k of consKeys) truthCons.set(k, (truthCons.get(k) || 0) + 1);
for (const key of distinctCons) {
    const ce = consSketch.estimate(key), pe = plainSketch.estimate(key);
    const tc = truthCons.get(key);
    if (ce > pe) consViol++;
    consMaxOver = Math.max(consMaxOver, ce - tc);
    plainMaxOver = Math.max(plainMaxOver, pe - tc);
    consSumOver += (ce - tc);
    plainSumOver += (pe - tc);
}
const consMeanOver = consSumOver / distinctCons.size;
const plainMeanOver = plainSumOver / distinctCons.size;
const consLooseOk = consViol === 0 && consMeanOver <= plainMeanOver;
if (!consLooseOk) cmsOk = false;
console.log('  conservative vs plain (same d=' + CONS_D + ' w=' + CONS_W + ' seed=' + CONS_SEED +
    ' stream): conservative>plain violations=' + consViol + '/0  meanOver cons=' + fmt(consMeanOver) +
    ' plain=' + fmt(plainMeanOver) + ' (cons<=plain: ' + (consMeanOver <= plainMeanOver ? 'ok' : 'FAIL') + ')' +
    '  maxOver cons=' + consMaxOver + ' plain=' + plainMaxOver +
    '  | ' + (consLooseOk ? 'ok' : 'FAIL'));

// Space co-headline: the sketch is a fixed d*w*4 bytes; the exact Map grows O(distinct).
console.log('');
const spaceD = 5, spaceW = 4096;
const spaceSketch = new CountMinSketch(spaceD, spaceW);
const spaceRng = makeCmsRng(0xF00DF00D);
const spaceZipf = makeZipf(CMS_NKEYS, CMS_SKEW, spaceRng);
const spaceTruth = new Map();
for (let i = 0; i < CMS_N; i++) {
    const key = spaceZipf();
    spaceSketch.add(key);
    spaceTruth.set(key, (spaceTruth.get(key) || 0) + 1);
}
const cmsBytes = spaceD * spaceW * 4;
const mapBytesLowerBound = spaceTruth.size * 32;   // a Map<number, number> entry: >= ~32 B/entry lower bound
console.log('  space co-headline @ N=' + fmtInt(CMS_N) + ', distinct=' + fmtInt(spaceTruth.size) +
    ':  CountMinSketch d=' + spaceD + ' w=' + spaceW + ' = ' + (cmsBytes / 1024).toFixed(1) +
    ' KB (fixed)  vs  exact Map >= ' + (mapBytesLowerBound / 1024).toFixed(1) + ' KB (grows O(distinct))');

console.log('');
console.log('WITNESS CountMinSketch ' + (cmsOk ? 'ok' : 'FAIL'));

const ok2 = hllOk && cmsOk;
console.log('');
console.log('WITNESS lite-sketch (all members) ' + (ok2 ? 'ok' : 'FAIL'));
if (!ok2) process.exitCode = 1;
