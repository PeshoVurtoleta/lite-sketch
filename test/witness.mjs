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

import { HyperLogLog } from '../Sketch.js';

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
if (!ok) process.exitCode = 1;
