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

    const ok = regDiffs === 0 && countDiffs === 0;
    console.log('PARITY HLL vs ' + ref + ': ' + lines.join(' | ') +
        ' | total reg-diffs=' + regDiffs + ' count-diffs=' + countDiffs + ' | ' + (ok ? 'ok' : 'FAIL'));
    if (!ok) process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
