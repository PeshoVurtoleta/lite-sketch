// test/docs.test.js -- the doc-truth gate (H2.8 T6g, F19). ASCII-only.
//
// Scans the shipped docs (README.md / llms.txt / Sketch.d.ts / Sketch.js) for the
// H2.8 wording rules. It is part of `npm test`.
//
// Teeth: on HEAD's docs (1.1.2) it FAILs -- 61 unqualified "0 B/op" lines and the two
// collapse / p90 overclaim phrases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const DOC_FILES = ['README.md', 'llms.txt', 'Sketch.d.ts', 'Sketch.js'];

// Rule 1 (D7): every "0 B/op" / "0 bytes/op" / "**0 bytes**" claim carries one of the
// allowed qualifiers -- `library` (the library allocates nothing), `unboxed`, `net`, or a
// `xxxFrom` / `xxxInto` zero-box method token. The method tokens are matched case-SENSITIVE
// (a lowercase letter then `From` / `Into`) so the English words "from" / "into" do not
// count; `net` is matched whole-word so "network" does not. An unqualified claim is false
// for a non-Smi argument, which boxes ~16 B at a non-inlined call.
const ZERO = /\b0 (?:B|bytes)\/op\b|\*\*0 bytes\*\*/i;
const QUAL = (l) => /library|unboxed|\bnet\b/i.test(l) || /[a-z](From|Into)\b/.test(l);

test('docs: every "0 B/op" claim is qualified (library / unboxed / net / xxxFrom / xxxInto)', () => {
    const bad = [];
    for (const f of DOC_FILES) {
        const lines = read(f).split('\n');
        lines.forEach((line, i) => {
            if (ZERO.test(line) && !QUAL(line)) bad.push(f + ':' + (i + 1) + ': ' + line.trim());
        });
    }
    assert.deepEqual(bad, [], 'unqualified "0 B/op" claims:\n' + bad.join('\n'));
});

// Rule 2 (D8): the collapse / p90 overclaim phrases are gone. A collapse does NOT keep
// the upper quantiles within alpha; which quantiles survive depends on the value span.
const BANNED = /tail-accurate p50|\(p50\/p90\/p99 -- the ones you page on\)/;

test('docs: no collapse / p90 overclaim phrase remains', () => {
    const bad = [];
    for (const f of DOC_FILES) {
        const lines = read(f).split('\n');
        lines.forEach((line, i) => {
            if (BANNED.test(line)) bad.push(f + ':' + (i + 1) + ': ' + line.trim());
        });
    }
    assert.deepEqual(bad, [], 'banned collapse / p90 phrase:\n' + bad.join('\n'));
});

// Rule 3: the README Testing section states the test count as a three-digit number.
test('docs: README Testing section states "<NNN> tests"', () => {
    const readme = read('README.md');
    const start = readme.indexOf('## Testing');
    assert.ok(start >= 0, 'README has a Testing section');
    const next = readme.indexOf('\n## ', start + 1);
    const section = next >= 0 ? readme.slice(start, next) : readme.slice(start);
    assert.match(section, /\b\d{3} tests\b/);
});

// ---- qa H2.8 boundary cases: the rule predicates over fixture strings (no doc edits) ----

test('docs qa: rule 1 -- English "from" / "into" / "network" do NOT qualify a claim', () => {
    const unq = [
        'add is 0 B/op from the start',
        'writes 0 B/op into the ring',
        '0 B/op over the network',
        'From now on add is 0 B/op',            // capital From at line start: no [a-z] before it
        'Into the loop: 0 bytes/op',
        '**0 bytes** per op',
        'add: 0 BYTES/OP (case-insensitive claim)',
        'x -0 B/op',                             // \b0 still sees a claim after a sign
        'informal 0 B/op',                       // "inform" + "al": not a From/Into token
    ];
    for (const l of unq) {
        assert.equal(ZERO.test(l), true, 'claim not detected: ' + l);
        assert.equal(QUAL(l), false, 'wrongly qualified: ' + l);
    }
});

test('docs qa: rule 1 -- the allowed qualifiers do qualify', () => {
    const ok = [
        'add is 0 library B/op; addFrom is 0 B/op',
        'addFrom(buf, i) -- 0 B/op',
        'quantilesInto: 0 B/op',
        'the lane reads 0 B/op unboxed',
        'net 0 B/op after the warm-up',
        'LIBRARY: 0 B/op',
    ];
    for (const l of ok) {
        assert.equal(ZERO.test(l), true, 'claim not detected: ' + l);
        assert.equal(QUAL(l), true, 'not qualified: ' + l);
    }
});

test('docs qa: rule 1 -- non-claims are not claims (10 / 0.5 / per-call / empty)', () => {
    for (const l of ['10 B/op', '0.5 B/op', '100 bytes/op', '0 B/call', '0 B', '', '0 library B/op', 'B/op 0']) {
        assert.equal(ZERO.test(l), false, 'false claim: ' + JSON.stringify(l));
    }
});

test('docs qa: rule 2 -- banned phrases matched exactly, the corrected wording passes', () => {
    assert.equal(BANNED.test('keeps the upper quantiles (p50/p90/p99 -- the ones you page on) within alpha'), true);
    assert.equal(BANNED.test('a tail-accurate p50 and p99'), true);
    assert.equal(BANNED.test('p50/p90/p99 within alpha only above the collapsed mass'), false);
    assert.equal(BANNED.test(''), false);
});

test('docs qa: rule 3 -- the Testing count regex wants exactly a 3-digit count', () => {
    const re = /\b\d{3} tests\b/;
    assert.equal(re.test('**361 tests** across'), true);
    assert.equal(re.test('36 tests'), false);
    assert.equal(re.test('1361 tests'), false);
    assert.equal(re.test('361 testsuites'), false);
    assert.equal(re.test('361tests'), false);
});
