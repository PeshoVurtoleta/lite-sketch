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

    // ---- H2.3: CMS + SS + message parity ------------------------------------
    // F13/F14/F15/F16/F20 are validation/disclosure fixes. On ACCEPTED inputs (integer keys,
    // counts in [1, 2^32-1], totals < 2^53) the counted members stay bit-identical to the ref.
    // Documented new-side-only differences (printed, not failed): rejected-key estimates are
    // now 0; over-cap counts / over-2^53 totals throw; `saturated` is new; withX unattainable
    // inputs throw; non-primitive throw messages print [object]/[function]; a doubly-invalid DD
    // add now names the count.
    let ir = 0x1234abcd >>> 0;
    const irnd = () => { ir = (ir + 0x6d2b79f5) | 0; let t = ir; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const keyClass = (i) => {
        const r = i & 3;
        if (r === 0) return (irnd() * 1000) | 0;                 // small
        if (r === 1) return -((irnd() * 1e6) | 0) - 1;           // negative
        if (r === 2) return 2 ** 33 + ((irnd() * 1e6) | 0);      // > 2^32
        return 9007199254740000 + ((irnd() * 900) | 0);          // near MAX_SAFE
    };
    const cmsCountsEq = (a, b, label) => {
        if (a.total !== b.total) return label + ': total ' + a.total + ' != ' + b.total;
        const ca = a._counts, cb = b._counts;
        for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) return label + ': counts[' + i + ']';
        return '';
    };
    let cmsFail = '';
    const cmsBuild = (d, w, conservative) => {
        const a = new A.CountMinSketch(d, w, { conservative, seed: 7 });
        const b = new B.CountMinSketch(d, w, { conservative, seed: 7 });
        const seen = [];
        for (let i = 0; i < 20000; i++) {
            const key = keyClass(i), cnt = 1 + ((irnd() * 1000) | 0);   // count in [1, ~1000]
            a.add(key, cnt); b.add(key, cnt);
            if ((i & 7) === 0) { const hi = (i * 2654435761) >>> 0, lo = (i * 40503) >>> 0; a.addHashed(hi, lo, cnt); b.addHashed(hi, lo, cnt); }
            if ((i % 97) === 0) seen.push(key);
        }
        const sd = cmsCountsEq(a, b, 'cms ' + d + 'x' + w + (conservative ? ' cons' : ' plain'));
        if (sd && !cmsFail) cmsFail = sd;
        for (const k of seen) if (a.estimate(k) !== b.estimate(k) && !cmsFail) cmsFail = 'cms estimate added key';
        for (let i = 0; i < 10000; i++) { const k = (irnd() * 2e6 | 0) - 1e6; if (a.estimate(k) !== b.estimate(k) && !cmsFail) cmsFail = 'cms estimate rnd int'; }
        return [a, b];
    };
    const [cp4a, cp4b] = cmsBuild(4, 1024, false);          // plain (4,1024)
    cmsBuild(4, 1024, true);                                 // cons  (4,1024)
    const [cp5a, cp5b] = cmsBuild(5, 4096, false);           // plain (5,4096)
    cmsBuild(5, 4096, true);                                 // cons  (5,4096)
    // merges: plain<-plain, cons<-plain, plain<-cons (all equal d/w/seed, total stays < 2^53).
    const mkCms = (d, w, cons) => { const a = new A.CountMinSketch(d, w, { conservative: cons, seed: 7 }); const b = new B.CountMinSketch(d, w, { conservative: cons, seed: 7 }); for (let i = 0; i < 3000; i++) { const k = keyClass(i), c = 1 + ((irnd() * 500) | 0); a.add(k, c); b.add(k, c); } return [a, b]; };
    for (const [tc, oc, label] of [[false, false, 'plain<-plain'], [true, false, 'cons<-plain'], [false, true, 'plain<-cons']]) {
        const [ta, tb] = mkCms(4, 1024, tc), [oa, ob] = mkCms(4, 1024, oc);
        ta.merge(oa); tb.merge(ob);
        const d = cmsCountsEq(ta, tb, 'cms merge ' + label);
        if (d && !cmsFail) cmsFail = d;
    }
    void cp4a; void cp4b; void cp5a; void cp5b;
    const cmsOk = cmsFail === '';
    console.log('PARITY CMS vs ' + ref + ': streams+estimate+addHashed+merges=' + (cmsFail || 'identical') + ' | ' + (cmsOk ? 'ok' : 'FAIL'));

    // ---- SS: capacity 1/7/64/1000 with evictions + merge ---------------------
    let ssFail = '';
    const ssSnapP = (s) => {
        const o = { total: s.total, size: s.size, key: [], count: [], error: [] };
        for (let i = 0; i < s.size; i++) { o.key.push(s._key[i]); o.count.push(s._count[i]); o.error.push(s._error[i]); }
        o.topK = s.topK().map((e) => e.key + ':' + e.count + ':' + e.error);
        return o;
    };
    const ssStream = (a, b, seed, n) => { let z = seed >>> 0; const zr = () => { z = (z + 0x6d2b79f5) | 0; let t = z; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; for (let i = 0; i < n; i++) { const k = ((1 / (zr() * 0.999 + 0.001)) | 0) % 5000; a.add(k); b.add(k); } };
    for (const cap of [1, 7, 64, 1000]) {
        const a = new A.SpaceSaving(cap, { seed: 5 }), b = new B.SpaceSaving(cap, { seed: 5 });
        ssStream(a, b, 0x9e37 + cap, 30000);
        if (JSON.stringify(ssSnapP(a)) !== JSON.stringify(ssSnapP(b)) && !ssFail) ssFail = 'cap ' + cap + ' stream';
    }
    // merge: two same-(capacity,seed) shards, fold one into the other.
    const sma = new A.SpaceSaving(64, { seed: 5 }), smb = new B.SpaceSaving(64, { seed: 5 });
    const soa = new A.SpaceSaving(64, { seed: 5 }), sob = new B.SpaceSaving(64, { seed: 5 });
    ssStream(sma, smb, 0x111, 20000); ssStream(soa, sob, 0x222, 20000);
    sma.merge(soa); smb.merge(sob);
    if (JSON.stringify(ssSnapP(sma)) !== JSON.stringify(ssSnapP(smb)) && !ssFail) ssFail = 'merge';
    const ssOk = ssFail === '';
    console.log('PARITY SS vs ' + ref + ': streams(cap 1/7/64/1000)+merge=' + (ssFail || 'identical') + ' | ' + (ssOk ? 'ok' : 'FAIL'));

    // ---- primitive throw-message parity (except DD/SS _badCount, whose text changed) ----
    const msgOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
    const prims = [NaN, Infinity, -Infinity, 'str', true, undefined, null, Symbol('s'), 10n];
    let msgFail = '';
    const cmpMsg = (label, fa, fb) => { const ma = msgOf(fa), mb = msgOf(fb); if (ma !== mb && !msgFail) msgFail = label + ': "' + ma + '" != "' + mb + '"'; };
    const Acms = new A.CountMinSketch(4, 16), Bcms = new B.CountMinSketch(4, 16);
    const Add = new A.DDSketch(0.01), Bdd = new B.DDSketch(0.01);
    const Ass = new A.SpaceSaving(8), Bss = new B.SpaceSaving(8);
    const Ahll = new A.HyperLogLog(4), Bhll = new B.HyperLogLog(4);
    for (const p of prims) {
        cmpMsg('cms add key', () => Acms.add(p), () => Bcms.add(p));
        cmpMsg('cms ctor d', () => new A.CountMinSketch(p, 16), () => new B.CountMinSketch(p, 16));
        cmpMsg('dd add value', () => Add.add(p), () => Bdd.add(p));
        cmpMsg('dd ctor alpha', () => new A.DDSketch(p), () => new B.DDSketch(p));
        cmpMsg('ss add key', () => Ass.add(p), () => Bss.add(p));
        cmpMsg('ss ctor capacity', () => new A.SpaceSaving(p), () => new B.SpaceSaving(p));
        cmpMsg('hll add key', () => Ahll.add(p), () => Bhll.add(p));
        cmpMsg('hll ctor p', () => new A.HyperLogLog(p), () => new B.HyperLogLog(p));
    }
    const msgOk = msgFail === '';
    console.log('PARITY messages vs ' + ref + ': primitive bad-arg messages=' + (msgFail || 'identical') + ' | ' + (msgOk ? 'ok' : 'FAIL'));

    // ---- documented diffs: each is CHECKED on the new side (A) and printed; not a parity failure.
    // These are the intended H2.3 behavior changes vs the ref; this block proves each is PRESENT on
    // the new build (so the diff is real, not an accident), rather than only listing it in a comment.
    const throws = (fn) => { try { fn(); return false; } catch { return true; } };
    const msgNew = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    const dc = new A.CountMinSketch(4, 1024); dc.add(0, 50); dc.add(1, 70);
    const dd0 = new A.DDSketch(0.01);
    const doc = {
        'estimate(reject)->0': dc.estimate(Infinity) === 0 && dc.estimate(1.5) === 0 && dc.estimate(2 ** 64) === 0,
        'saturated-new': dc.saturated === false,
        'count>2^32-1 throws (CMS/DD/SS)': throws(() => dc.add(2, 2 ** 32)) && throws(() => dd0.add(5, 2 ** 32)) && throws(() => new A.SpaceSaving(8).add(1, 2 ** 32)),
        'total>2^53-1 throws (DD fill)': (() => { const f = new A.DDSketch(0.01); for (let i = 0; i < (1 << 21); i++) f.add(5, 4294967295); f.add(5, (1 << 21) - 1); return throws(() => f.add(5)); })(),
        'withAccuracy/withError unattainable throw': throws(() => A.CountMinSketch.withAccuracy(1e-12, 0.01)) && throws(() => A.SpaceSaving.withError(1e-9)),
        'non-primitive msg -> [object]': /got \[object]$/.test(msgNew(() => dc.add({}))),
        'doubly-invalid DD add names count': /\[1, 4294967295]/.test(msgNew(() => dd0.add(-5, 2 ** 40))),
    };
    let docFail = '';
    for (const k of Object.keys(doc)) if (!doc[k] && !docFail) docFail = k;
    console.log('PARITY DOC-DIFF (new-side, H2.3 intended changes vs ' + ref + '): ' +
        Object.keys(doc).map((k) => k + '=' + (doc[k] ? 'yes' : 'NO')).join(' ') +
        ' | ' + (docFail === '' ? 'ok' : 'FAIL ' + docFail));

    const ok = hllOk && ddOk && cmsOk && ssOk && msgOk && docFail === '';
    if (!ok) process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
