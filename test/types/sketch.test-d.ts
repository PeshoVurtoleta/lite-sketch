/**
 * @zakkster/lite-sketch -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between Sketch.d.ts and the runtime
 * fails `npm run test:types`. Not executed; only type-checked.
 */

import { HyperLogLog, mix64, hashHi, hashLo, hashString, saltRow, VERSION } from '../../Sketch.js';

// VERSION is a string.
const v: string = VERSION;
void v;

// The hash: mix64 writes lanes (void); hashHi/hashLo/saltRow return numbers.
mix64(12345, 0x9e3779b1);
const hi: number = hashHi();
const lo: number = hashLo();
hashString('hello', 0x9e3779b1);
const salted: number = saltRow(hi, 3);
void hi; void lo; void salted;

// @ts-expect-error -- mix64 key must be a number.
mix64('12345', 0x9e3779b1);

// --- HyperLogLog -----------------------------------------------------------
const hll: HyperLogLog = new HyperLogLog(14);
const hllSeeded: HyperLogLog = new HyperLogLog(14, 42);
const hllDefault: HyperLogLog = new HyperLogLog();
void hllSeeded; void hllDefault;

// getters are readonly numbers.
const p: number = hll.p;
const m: number = hll.m;
const se: number = hll.standardError;
void p; void m; void se;

// @ts-expect-error -- p is readonly.
hll.p = 12;
// @ts-expect-error -- standardError is readonly.
hll.standardError = 0.5;

// add / addHashed -> this (chainable); count -> number; merge -> this; clear -> this.
const chained: HyperLogLog = hll.add(1).add(2).addHashed(0xdeadbeef, 0x1234);
const est: number = hll.count();
const merged: HyperLogLog = hll.merge(new HyperLogLog(14));
const cleared: HyperLogLog = hll.clear();
void chained; void est; void merged; void cleared;

// @ts-expect-error -- p must be a number.
new HyperLogLog('14');
// @ts-expect-error -- add key must be a number.
hll.add('1');
// @ts-expect-error -- addHashed needs two numeric lanes.
hll.addHashed('a', 'b');
// @ts-expect-error -- merge takes a HyperLogLog.
hll.merge(42);
