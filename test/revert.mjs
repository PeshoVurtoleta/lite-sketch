// @zakkster/lite-sketch -- the release revert-check (repo-only; `npm run revert-check`).
//
// CLAUDE.md: "Before /release, revert-check the new gates." This runs every H2 gate
// against an OLD library (default 1a2673e = 1.1.2, the pre-H2 audit baseline) and
// proves each one has teeth BY NAME: a gate that cannot FAIL on the old code is not a
// gate. It is NOT part of `verify` -- it EXPECTS FAILs and takes ~40 s against 1.1.2.
//
// Read-only git: every input is `git show <ref>:<file>`; nothing in the tree is
// touched. All writes go to one mkdtemp under os.tmpdir(), with the real node_modules
// symlinked in, so the ref's test files resolve the dev deps. Families run SEQUENTIALLY
// (no unhandled rejection): spawnSync per child.
//
// Families + the BY-NAME teeth (parsed from each gate's own output):
//   lanes --lib <ref>  : exit 1; every N1 / AHF / N8-Into gate ABSENT; every N2-HLL,
//                        N5[df], N5[ni], N3[ni/*], N3[nc/hll|ss/*], N3[nc/{cms,cmsest}/n31]
//                        FAILs; NO *CTRL gate FAILs; N4-CTRL present and >= 8. (N3[nc/
//                        {cms,cmsest}/{b31,u32,safe}] read 0-1 on 1.1.2, so are NOT asserted.)
//   chrome --lib <ref> : exit 1; df HLL add small + ni CMS/SS add c30 {small,b30} FAIL;
//                        the HLL/CMS/SS addFrom + addHashedFrom + topKInto + quantilesInto
//                        lanes ABSENT per mode (1.1.2 HAS DD addFrom, so it is not asserted);
//                        CTRL PASS in both modes.
//   perf (F9 teeth)    : the ref's PerfGate with maxScavenges 64 -> 2 (exactly one
//                        replacement) FAILs on the ref Sketch.js; unedited it PASSes.
//   torture (F9 teeth) : the ref's torture with SCAV_BOX 48 -> 0 (exactly one
//                        replacement) FAILs; unedited it PASSes.
//   parity             : test/parity.mjs <ref> -- every PARITY section reads `| ok` EXCEPT
//                        the three that legitimately differ vs 1.1.2 (each matched on its
//                        documented diff tag; a different-reason FAIL is a hard FAIL), and
//                        the N9 hash-identity reads 0 diffs.
//
// `--ref 5fecd6e` (H2.7, green) must exit 1: a green ref cannot satisfy the FAIL
// expectations. Prints `family | expected | observed | verdict`; exits 0 only if every
// expectation holds. ASCII-only; no deps.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const refIdx = process.argv.indexOf('--ref');
const REF = refIdx >= 0 ? process.argv[refIdx + 1] : '1a2673e';
// Fail closed on a hostile / malformed ref: no leading '-' (so `--ref --output=x` is
// rejected before it can reach git as an option), and only git-safe ref characters.
if (REF === undefined || !/^[0-9A-Za-z._/][0-9A-Za-z._/-]*$/.test(REF)) {
    console.error('REVERT: invalid --ref ' + JSON.stringify(REF) + ' (must match /^[0-9A-Za-z._/][0-9A-Za-z._/-]*$/, no leading dash)');
    process.exit(1);
}
const HERE = new URL('..', import.meta.url).pathname;          // package root
const REAL_NM = join(HERE, 'node_modules');

function gitShow(file) {
    return execFileSync('git', ['show', REF + ':' + file], { cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function editOne(src, find, replace) {
    const parts = src.split(find);
    if (parts.length - 1 !== 1) throw new Error('expected exactly 1 occurrence of ' + JSON.stringify(find) + ', found ' + (parts.length - 1));
    return parts.join(replace);
}
function node(args) {
    const r = spawnSync(process.execPath, args, { cwd: HERE, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---- stage the ref into a scratch tree (os.tmpdir() only) --------------------
let tmp;
try { tmp = mkdtempSync(join(tmpdir(), 'lite-sketch-revert-')); }
catch (e) { console.error('REVERT: cannot mkdtemp -- ' + e.message); process.exit(1); }
function cleanup() { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }

let refLib, perfEdited, perfRef, tortEdited, tortRef;
try {
    refLib = join(tmp, 'Sketch.js');
    writeFileSync(refLib, gitShow('Sketch.js'));
    symlinkSync(REAL_NM, join(tmp, 'node_modules'), 'dir');

    mkdirSync(join(tmp, 'test', 'perf'), { recursive: true });
    const perfSrc = gitShow('test/perf/PerfGate.test.mjs');
    perfRef = join(tmp, 'test', 'perf', 'PerfGate.ref.mjs');
    perfEdited = join(tmp, 'test', 'perf', 'PerfGate.edited.mjs');
    writeFileSync(perfRef, perfSrc);
    writeFileSync(perfEdited, editOne(perfSrc, 'maxScavenges: 64', 'maxScavenges: 2'));

    const tortSrc = gitShow('test/torture.mjs');
    tortRef = join(tmp, 'test', 'torture.ref.mjs');
    tortEdited = join(tmp, 'test', 'torture.edited.mjs');
    writeFileSync(tortRef, tortSrc);
    writeFileSync(tortEdited, editOne(tortSrc, 'SCAV_BOX = 48', 'SCAV_BOX = 0'));
} catch (e) {
    cleanup();
    console.error('REVERT: staging failed for ref ' + REF + ' -- ' + e.message);
    process.exit(1);
}

const rows = [];
function record(family, expected, observed, pass) { rows.push({ family, expected, observed, pass }); }

// ---- family: lanes --lib (assert the teeth BY NAME) --------------------------
{
    const r = node([join(HERE, 'test', 'lanes.mjs'), '--lib', refLib]);
    // Universe of gate names from the GATE line (each token is name=value, no spaces).
    const gm = r.out.match(/GATE lanes[^:]*:\s*(.*?)\s*\|\s*(?:ok|FAIL)/);
    const names = gm ? gm[1].split(' ').map((t) => t.split('=')[0]).filter(Boolean) : [];
    const uniq = [...new Set(names)];
    const fm = r.out.match(/LANES-FAILED=(.*)/);
    const am = r.out.match(/LANES-ABSENT=(.*)/);
    const failed = new Set((fm ? fm[1].trim() : '').split(',').filter(Boolean));
    const abs = new Set((am ? am[1].trim() : '').split(',').filter(Boolean));

    const sel = (re) => uniq.filter((n) => re.test(n));
    const has = (n) => uniq.includes(n);
    // The literal teeth gate names: a MISSING one is a fail-open hole, so require each
    // PRESENT (a dropped gate FAILs the family instead of silently vanishing).
    const LIT_FAIL = ['N5[df]', 'N5[ni]', 'N3[nc/cms/n31]', 'N3[nc/cmsest/n31]'];
    const missingLit = LIT_FAIL.filter((n) => !has(n));
    // Expected ABSENT / FAIL sets derived from the harness universe.
    const expectAbsent = uniq.filter((n) => /^N1\[/.test(n) || /^AHF\[/.test(n) || (/^N8\[/.test(n) && /(topKInto|quantilesInto)/.test(n)));
    const expectFail = [...sel(/^N2-HLL\[/), 'N5[df]', 'N5[ni]', ...sel(/^N3\[ni\//), ...sel(/^N3\[nc\/hll\//), ...sel(/^N3\[nc\/ss\//), 'N3[nc/cms/n31]', 'N3[nc/cmsest/n31]'];
    // Pin EXACT structural counts (harness integrity): any drift -> FAIL with the diff.
    const counts = {
        'N1': uniq.filter((n) => /^N1\[/.test(n)).length,
        'AHF': uniq.filter((n) => /^AHF\[/.test(n)).length,
        'N8-Into': uniq.filter((n) => /^N8\[/.test(n) && /(topKInto|quantilesInto)/.test(n)).length,
        'N2-HLL': sel(/^N2-HLL\[/).length,
        'N3[ni]': sel(/^N3\[ni\//).length,
        'N3[nc/hll]': sel(/^N3\[nc\/hll\//).length,
        'N3[nc/ss]': sel(/^N3\[nc\/ss\//).length,
    };
    const want = { 'N1': 240, 'AHF': 8, 'N8-Into': 6, 'N2-HLL': 8, 'N3[ni]': 16, 'N3[nc/hll]': 4, 'N3[nc/ss]': 4 };
    const countDiffs = Object.keys(want).filter((k) => counts[k] !== want[k]).map((k) => k + '=' + counts[k] + '(want ' + want[k] + ')');
    // Totals: 254 ABSENT (240 N1 + 8 AHF + 6 N8-Into), 36 FAIL (8+2+16+4+4+2).
    const absTotalOk = expectAbsent.length === 254;
    const failTotalOk = expectFail.length === 36;

    const ctrlNames = uniq.filter((n) => /CTRL/.test(n));
    const n4m = r.out.match(/N4-CTRL\[df\/ring\]=min=(\d+)/);
    const n4 = n4m ? Number(n4m[1]) : null;
    // N5 non-vacuity: each N5[tag] must carry a numeric value > 3 (a real over-budget
    // deopt count) AND there must be no N5[tag]VACUOUS token (the trace was live).
    const n5v = (tag) => { const m = r.out.match(new RegExp('N5\\[' + tag + '\\]=(\\d+)')); return m ? Number(m[1]) : null; };
    const n5df = n5v('df'), n5ni = n5v('ni');
    const n5vac = /N5\[(?:df|ni)\]VACUOUS/.test(r.out);
    const n5ok = n5df !== null && n5df > 3 && n5ni !== null && n5ni > 3 && !n5vac;

    const missAbsent = expectAbsent.filter((n) => !abs.has(n));
    const missFail = expectFail.filter((n) => !failed.has(n));
    const ctrlBroke = ctrlNames.filter((n) => failed.has(n) || abs.has(n));
    const n4ok = n4 !== null && n4 >= 8;
    const pass = r.status === 1 && missingLit.length === 0 && countDiffs.length === 0 &&
        absTotalOk && failTotalOk && missAbsent.length === 0 && missFail.length === 0 &&
        ctrlBroke.length === 0 && n4ok && n5ok;

    const prob = [];
    if (r.status !== 1) prob.push('exit=' + r.status);
    if (missingLit.length) prob.push('missing-gate[' + missingLit.join(',') + ']');
    if (countDiffs.length) prob.push('count-drift[' + countDiffs.join(';') + ']');
    if (!absTotalOk) prob.push('absN=' + expectAbsent.length + '(want 254)');
    if (!failTotalOk) prob.push('failN=' + expectFail.length + '(want 36)');
    if (missAbsent.length) prob.push('not-absent[' + missAbsent.slice(0, 3).join(',') + (missAbsent.length > 3 ? ',+' + (missAbsent.length - 3) : '') + ']');
    if (missFail.length) prob.push('not-failed[' + missFail.slice(0, 3).join(',') + (missFail.length > 3 ? ',+' + (missFail.length - 3) : '') + ']');
    if (ctrlBroke.length) prob.push('ctrl-broke[' + ctrlBroke.join(',') + ']');
    if (!n4ok) prob.push('N4-CTRL=' + (n4 === null ? 'absent' : n4));
    if (!n5ok) prob.push('N5-vacuous(df=' + n5df + ',ni=' + n5ni + ',vac=' + n5vac + ')');
    record('lanes --lib',
        'exit1; 254 ABSENT (240 N1/8 AHF/6 Into); 36 FAIL (N2-HLL 8/N5 2/N3[ni] 16/N3[nc/hll] 4/N3[nc/ss] 4/N3[nc/*n31] 2); N5 live >3; CTRL/N4-CTRL ok',
        pass ? 'exit1; absent=254 failed=36 N5(df=' + n5df + ',ni=' + n5ni + ',live) N4-CTRL=' + n4 + ' CTRL-intact' : prob.join(' '),
        pass);
}

// ---- family: chrome --lib (assert the teeth BY NAME) -------------------------
{
    const r = node([join(HERE, 'test', 'chrome', 'run.mjs'), '--lib', refLib]);
    const verdict = {};   // 'mode|name' -> PASS | FAIL | ABSENT | INVALID
    const minOver = {};   // 'mode|name' -> true when a FAIL prints min=X strictly above (<= L)
    for (const line of r.out.split('\n')) {
        const m = line.match(/^(df|ni) (.+?) \((?:from|add|into|ctrl)(?:,k=\d+)?\) (.+)$/);
        if (!m) continue;
        const key = m[1] + '|' + m[2];
        const rest = m[3];
        // INVALID (all windows discarded) is its OWN class -- it never satisfies an
        // expected FAIL or PASS, so a mustFail lane cannot pass unmeasured.
        verdict[key] = /INVALID/.test(rest) ? 'INVALID' : /ABSENT/.test(rest) ? 'ABSENT' : /\bPASS\b/.test(rest) ? 'PASS' : 'FAIL';
        const mm = rest.match(/min=([\d.]+) .*\(<=\s*([\d.]+)\)/);
        if (mm) minOver[key] = Number(mm[1]) > Number(mm[2]);   // a real over-budget measurement
    }
    const mustFail = ['df|HLL add small', 'ni|CMS add c30 small', 'ni|CMS add c30 b30', 'ni|SS add c30 small', 'ni|SS add c30 b30'];
    const absBase = ['HLL addFrom small', 'CMS addFrom c30 small', 'SS addFrom c30 small', 'HLL addHashedFrom', 'CMS addHashedFrom', 'SS topKInto n16 big', 'DD quantilesInto q4'];
    const mustAbsent = [];
    for (const mode of ['df', 'ni']) for (const b of absBase) mustAbsent.push(mode + '|' + b);
    const mustPass = ['df|CTRL box', 'ni|CTRL box'];

    // A mustFail lane must be verdict FAIL AND print a numeric min strictly above its limit.
    const badFail = mustFail.filter((k) => verdict[k] !== 'FAIL' || minOver[k] !== true);
    const badAbsent = mustAbsent.filter((k) => verdict[k] !== 'ABSENT');
    const badPass = mustPass.filter((k) => verdict[k] !== 'PASS');
    const pass = r.status === 1 && badFail.length === 0 && badAbsent.length === 0 && badPass.length === 0;

    const prob = [];
    if (r.status !== 1) prob.push('exit=' + r.status);
    if (badFail.length) prob.push('not-FAIL-over[' + badFail.map((k) => k + ':' + (verdict[k] || 'absent') + (minOver[k] === false ? '/not-over' : '')).join(',') + ']');
    if (badAbsent.length) prob.push('not-ABSENT[' + badAbsent.slice(0, 3).join(',') + (badAbsent.length > 3 ? ',+' + (badAbsent.length - 3) : '') + ']');
    if (badPass.length) prob.push('CTRL-not-PASS[' + badPass.join(',') + ']');
    record('chrome --lib',
        'exit1; HLL add small + ni CMS/SS add c30 {small,b30} FAIL (min>limit); addFrom/AHF/Into ABSENT; CTRL PASS',
        pass ? 'exit1; ' + mustFail.length + ' FAIL(min>limit) + ' + mustAbsent.length + ' ABSENT by name; CTRL PASS' : prob.join(' '),
        pass);
}

// ---- family: perf (F9 teeth) -------------------------------------------------
{
    const edited = node(['--expose-gc', '--max-semi-space-size=4', '--test', perfEdited]);
    const unedited = node(['--expose-gc', '--max-semi-space-size=4', '--test', perfRef]);
    const pass = edited.status === 1 && unedited.status === 0;   // === 1, not != 0 (a signal kill is null)
    record('perf (64->2)', 'edited FAILs, unedited PASSes',
        'edited exit ' + edited.status + ', unedited exit ' + unedited.status, pass);
}

// ---- family: torture (F9 teeth) ----------------------------------------------
{
    const edited = node(['--expose-gc', tortEdited]);
    const unedited = node(['--expose-gc', tortRef]);
    const pass = edited.status === 1 && unedited.status === 0;   // === 1, not != 0 (a signal kill is null)
    record('torture (48->0)', 'edited FAILs, unedited PASSes',
        'edited exit ' + edited.status + ', unedited exit ' + unedited.status, pass);
}

// ---- family: parity (every section ok except the 3 documented diffs) ---------
{
    const r = node([join(HERE, 'test', 'parity.mjs'), REF]);
    // The 3 sections that legitimately differ vs 1.1.2, each matched on its diff tag.
    const allow = [
        { id: 'PARITY H2.5 F3/F4 identity', tag: 'cms 1x1 saturated', why: 'H2.5 F3/F4: CMS saturated flag added' },
        { id: 'PARITY messages', tag: '[1e-6, 1)', why: 'DD alpha domain re-worded to [1e-6, 1)' },
        { id: 'PARITY H2.6 F5/F6 identity', tag: 'cms 4x1024 total/saturated', why: 'H2.6 F5/F6 + H2.3 CMS total/saturated' },
    ];
    const bad = [];
    const n9 = /PARITY N9 hash-identity[^\n]*non-neg mix64\/hashHi\/hashLo-diffs=0 hashString-diffs=0 saltRow-diffs=0[^\n]*\| ok/.test(r.out);
    if (!n9) bad.push('N9-hash-identity-not-0/ok');
    for (const line of r.out.split('\n')) {
        if (!line.startsWith('PARITY ')) continue;
        const vm = line.match(/\|\s*(ok|FAIL)\s*$/);
        if (!vm) continue;                       // multi-section line without a trailing verdict: skip
        const verd = vm[1];
        const a = allow.find((x) => line.startsWith(x.id));
        if (a) {
            if (verd === 'FAIL' && !line.includes(a.tag)) bad.push(a.id + '(wrong-reason)');   // failed for a DIFFERENT reason
        } else if (verd !== 'ok') {
            bad.push(line.slice(0, 40).replace(/\s+/g, ' ') + '...(unexpected FAIL)');
        }
    }
    const pass = bad.length === 0;
    record('parity',
        'every section ok except 3 doc diffs (cms 1x1 saturated; DD alpha [1e-6,1); cms 4x1024 total/saturated); N9 0 diffs',
        pass ? 'N9 0 diffs; 3 allowlisted diffs on tag; no unexpected FAIL' : bad.slice(0, 3).join(' '),
        pass);
}

cleanup();

// ---- table + verdict ---------------------------------------------------------
const wFam = Math.max(6, ...rows.map((r) => r.family.length));
const wExp = Math.max(8, ...rows.map((r) => r.expected.length));
const wObs = Math.max(8, ...rows.map((r) => r.observed.length));
console.log('revert-check vs ' + REF);
console.log('family'.padEnd(wFam) + ' | ' + 'expected'.padEnd(wExp) + ' | ' + 'observed'.padEnd(wObs) + ' | verdict');
for (const r of rows) {
    console.log(r.family.padEnd(wFam) + ' | ' + r.expected.padEnd(wExp) + ' | ' + r.observed.padEnd(wObs) + ' | ' + (r.pass ? 'PASS' : 'FAIL'));
}
const allPass = rows.every((r) => r.pass);
console.log('GATE revert-check vs ' + REF + ': ' + (allPass ? 'ok' : 'FAIL') + ' (' + rows.filter((r) => r.pass).length + '/' + rows.length + ')');
if (!allPass) process.exit(1);
