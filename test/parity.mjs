// @zakkster/lite-sketch -- the parity runner (repo-only; `node test/parity.mjs [ref]`).
//
// Proves a behavior change is bit-identical to a git ref (default HEAD): it loads
// `git show <ref>:Sketch.js` into a temp file and runs the SAME streams through the
// working-tree module and the ref module, comparing every register and count(). A
// pre-commit check, NOT part of `verify` (once the maintainer commits, `<ref>` is
// the working tree and the check is vacuous). H2.1 compares HyperLogLog; H2.4
// extends this into the full N9. Read-only git only (`git show`). ASCII-only.
//
// H2.1: for p in {4, 12, 18}, feed 600k MIXED keys (positive, negative, > 2^32) via
// add, plus two addHashed lanes, then compare _reg[] and count() exactly. F1 is a
// pure deopt/box fix: `h << p` and `(h << p) >>> 0` feed clz32 / `!== 0` identically,
// so parity must hold with ZERO register diffs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ref = process.argv[2] || 'HEAD';
const HERE = new URL('..', import.meta.url).pathname;   // package root

let src;
try {
    src = execFileSync('git', ['show', ref + ':Sketch.js'], { cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
    console.error('PARITY: cannot `git show ' + ref + ':Sketch.js` -- ' + (e && e.message));
    process.exitCode = 1;
    throw e;
}
const dir = mkdtempSync(join(tmpdir(), 'lite-sketch-parity-'));
const refFile = join(dir, 'Sketch.ref.mjs');
writeFileSync(refFile, src);

try {
    const A = await import(new URL('../Sketch.js', import.meta.url).pathname);   // working tree
    const B = await import(refFile);                                            // ref

    const PS = [4, 12, 18];
    const KEYS = 600000;
    let regDiffs = 0;
    let countDiffs = 0;
    const lines = [];

    for (const p of PS) {
        // SEPARATE instances per lane so one lane's register max cannot mask another's diff.
        const aAdd = new A.HyperLogLog(p), bAdd = new B.HyperLogLog(p);
        const aHsh = new A.HyperLogLog(p), bHsh = new B.HyperLogLog(p);
        for (let i = 0; i < KEYS; i++) {
            // add lane: mixed key domain -- positive, negative, and > 2^32
            const k = i % 3 === 0 ? i : i % 3 === 1 ? -(i * 7919) : 2 ** 40 + i * 104729;
            aAdd.add(k); bAdd.add(k);
            // addHashed lane (uint32)
            const hi = (i * 2654435761) >>> 0;
            const lo = (i * 40503) >>> 0;
            aHsh.addHashed(hi, lo); bHsh.addHashed(hi, lo);
        }
        let d = 0;
        for (let j = 0; j < aAdd._reg.length; j++) {
            if (aAdd._reg[j] !== bAdd._reg[j]) d++;
            if (aHsh._reg[j] !== bHsh._reg[j]) d++;
        }
        regDiffs += d;
        const caAdd = aAdd.count(), cbAdd = bAdd.count();
        const caHsh = aHsh.count(), cbHsh = bHsh.count();
        if (caAdd !== cbAdd || caHsh !== cbHsh) countDiffs++;
        lines.push('p=' + p + ' reg-diffs=' + d +
            ' add-count(new/ref)=' + caAdd + '/' + cbAdd +
            ' addHashed-count(new/ref)=' + caHsh + '/' + cbHsh);
    }

    const hllOk = regDiffs === 0 && countDiffs === 0;
    console.log('PARITY HLL vs ' + ref + ': ' + lines.join(' | ') +
        ' | total reg-diffs=' + regDiffs + ' count-diffs=' + countDiffs + ' | ' + (hllOk ? 'ok' : 'FAIL'));

    // ---- DDSketch (H2.2) -----------------------------------------------------
    // F10/F11/F17 are cold ctor/merge fixes: the KEY bounds and every non-collapsed
    // stream/merge must stay bit-identical to the ref. The only two allowed differences
    // are documented (printed, not failed): the minIndexable/maxIndexable getters (F17,
    // now the exact edges instead of pow(gamma,K+-1)) and `collapsed` after merging a
    // collapsed other into a non-strict sketch (F11). Bins/quantiles stay identical there.
    const nextUp = (x) => { const f = new Float64Array([x]); const u = new BigUint64Array(f.buffer); u[0] += 1n; return f[0]; };
    const QGRID = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999, 1];
    // Observable state excluding the two documented getters (compared separately).
    const ddSnap = (s) => {
        const o = { off: s._offset, bc: s._binCount, mkp: s._maxKeyPop, zc: s._zeroCount,
            cnt: s._count, sum: s._sum, min: s._min, max: s._max, col: s._collapsed, bins: Array.from(s._bins) };
        o.q = QGRID.map((q) => s.quantile(q));
        return o;
    };
    const ddEq = (a, b, skipCol) => {
        for (const k of ['off', 'bc', 'mkp', 'zc', 'cnt', 'sum', 'min', 'max']) {
            if (!Object.is(a[k], b[k])) return 'field ' + k + ' ' + a[k] + ' != ' + b[k];
        }
        if (!skipCol && a.col !== b.col) return 'collapsed ' + a.col + ' != ' + b.col;
        if (a.bins.length !== b.bins.length) return 'bins length';
        for (let i = 0; i < a.bins.length; i++) if (!Object.is(a.bins[i], b.bins[i])) return 'bin[' + i + ']';
        for (let i = 0; i < a.q.length; i++) if (!Object.is(a.q[i], b.q[i])) return 'q[' + QGRID[i] + ']';
        return '';
    };

    // 1. KEY bounds identical over >= 300 alphas in [1e-6, 0.9999].
    const NA = 300;
    let keyDiffs = 0;
    for (let i = 0; i < NA; i++) {
        const alpha = 1e-6 * Math.pow(0.9999 / 1e-6, i / (NA - 1));
        const da = new A.DDSketch(alpha), db = new B.DDSketch(alpha);
        if (da._maxKeyIndexable !== db._maxKeyIndexable || da._minKeyIndexable !== db._minKeyIndexable) keyDiffs++;
    }

    // Deterministic positive stream (mulberry32-style), lognormal-ish over several decades.
    let rs = 0x51701234 >>> 0;
    const rnd = () => { rs = (rs + 0x6d2b79f5) | 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const STREAM = []; for (let i = 0; i < 4000; i++) STREAM.push(Math.exp((rnd() - 0.5) * 18) + rnd());

    const alpha = 0.01;
    let streamFail = '';
    const run = (ctorOpts, label) => {
        const a = new A.DDSketch(alpha, ctorOpts), b = new B.DDSketch(alpha, ctorOpts);
        for (const v of STREAM) {
            try { a.add(v); } catch { /* same throw on both */ }
            try { b.add(v); } catch { /* ignore */ }
        }
        const d = ddEq(ddSnap(a), ddSnap(b), false);
        if (d && !streamFail) streamFail = label + ': ' + d;
    };
    run(undefined, 'non-strict default');
    run({ maxBins: 64 }, 'non-strict maxBins 64 (collapses)');
    run({ range: [1, 1e9] }, 'strict [1,1e9]');

    // Merge of NON-collapsed others: build two in-window sketches and fold one into the other.
    const mkPair = (opts) => {
        const a = new A.DDSketch(alpha, opts), b = new B.DDSketch(alpha, opts);
        return [a, b];
    };
    const [ma, mb] = mkPair(undefined);
    const [oa, ob] = mkPair(undefined);
    for (let i = 0; i < 500; i++) { const v = 100 + (i % 50); ma.add(v); mb.add(v); }
    for (let i = 0; i < 500; i++) { const v = 200 + (i % 50); oa.add(v); ob.add(v); }
    ma.merge(oa); mb.merge(ob);
    const mergeDiff = ddEq(ddSnap(ma), ddSnap(mb), false);
    if (mergeDiff && !streamFail) streamFail = 'merge non-collapsed: ' + mergeDiff;

    // Documented difference 1 (F17): the getters. The ref's are pow-based; assert the NEW
    // getters pass the four-edge check at a sweep of alphas (print the ref gap, do not fail).
    let edgeFail = 0, getterGap = 0;
    const accepts = (s, x) => { try { s.add(x); return true; } catch { return false; } };
    for (let i = 0; i < NA; i++) {
        const al = 1e-6 * Math.pow(0.9999 / 1e-6, i / (NA - 1));
        const a = new A.DDSketch(al), b = new B.DDSketch(al);
        if (a.minIndexable !== b.minIndexable || a.maxIndexable !== b.maxIndexable) getterGap++;
        const mn = a.minIndexable, mx = a.maxIndexable;
        if (accepts(a, mn)) edgeFail++;
        if (!accepts(a, nextUp(mn))) edgeFail++;
        if (!accepts(a, mx)) edgeFail++;
        if (accepts(a, nextUp(mx))) edgeFail++;   // max is always strictly below MAX_VALUE
    }

    // Documented difference 2 (F11): collapsed after merging a collapsed other into a
    // non-strict sketch. New carries it (true); ref drops it (false). Bins/quantiles identical.
    const ca = new A.DDSketch(alpha, { maxBins: 16 }), cb = new B.DDSketch(alpha, { maxBins: 16 });
    for (let i = 1; i <= 1000; i++) { ca.add(i); cb.add(i); }  // both collapse the shard
    const ta = new A.DDSketch(alpha, { maxBins: 16 }), tb = new B.DDSketch(alpha, { maxBins: 16 });
    ta.merge(ca); tb.merge(cb);
    const sa = ddSnap(ta), sb = ddSnap(tb);
    const collapsedGap = sa.col !== sb.col;                   // expected documented difference
    const binsQDiff = ddEq(sa, sb, true);                     // bins + quantiles must still match

    const ddOk = keyDiffs === 0 && streamFail === '' && edgeFail === 0 && binsQDiff === '';
    console.log('PARITY DD vs ' + ref + ': key-diffs=' + keyDiffs + '/' + NA +
        ' | streams=' + (streamFail || 'identical') +
        ' | merge-non-collapsed=' + (mergeDiff || 'identical') +
        ' | four-edge-fails=' + edgeFail +
        ' | DOC-DIFF getters-gap=' + getterGap + '/' + NA + ' (F17)' +
        ' collapsed-gap=' + (collapsedGap ? 'yes' : 'no') + ' bins/q-there=' + (binsQDiff || 'identical') + ' (F11)' +
        ' | ' + (ddOk ? 'ok' : 'FAIL'));

    const ok = hllOk && ddOk;
    if (!ok) process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
