/**
 * @zakkster/lite-sketch -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between Sketch.d.ts and the runtime
 * fails `npm run test:types`. Not executed; only type-checked.
 */

import {
    HyperLogLog, CountMinSketch, DDSketch, SpaceSaving, mix64, hashHi, hashLo, hashString, saltRow, VERSION,
} from '../../Sketch.js';
import type {
    CountMinSketchOptions, DDSketchOptions, SpaceSavingOptions, SpaceSavingEntry,
} from '../../Sketch.js';

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
const hllSeed: number = hll.seed;
void p; void m; void se; void hllSeed;

// @ts-expect-error -- p is readonly.
hll.p = 12;
// @ts-expect-error -- standardError is readonly.
hll.standardError = 0.5;
// @ts-expect-error -- seed is readonly.
hll.seed = 7;

// add / addHashed -> this (chainable); count -> number; merge -> this; clear -> this.
const chained: HyperLogLog = hll.add(1).add(2).addHashed(0xdeadbeef, 0x1234);
const est: number = hll.count();
const merged: HyperLogLog = hll.merge(new HyperLogLog(14));
const cleared: HyperLogLog = hll.clear();
void chained; void est; void merged; void cleared;

// addFrom / addHashedFrom: the zero-box entry points -> this (chainable).
const hllFromBuf = new Float64Array(2);
const hllFrom: HyperLogLog = hll.addFrom(hllFromBuf, 0);
const hllHashedFrom: HyperLogLog = hll.addHashedFrom(new Uint32Array(2), 0).addHashedFrom(new Int32Array(2), 0);
void hllFrom; void hllHashedFrom;

// @ts-expect-error -- addFrom needs a Float64Array, not a Float32Array.
hll.addFrom(new Float32Array(2), 0);
// @ts-expect-error -- addHashedFrom needs a Uint32Array | Int32Array, not a Float64Array.
hll.addHashedFrom(new Float64Array(2), 0);

// @ts-expect-error -- p must be a number.
new HyperLogLog('14');
// @ts-expect-error -- add key must be a number.
hll.add('1');
// @ts-expect-error -- addHashed needs two numeric lanes.
hll.addHashed('a', 'b');
// @ts-expect-error -- merge takes a HyperLogLog.
hll.merge(42);

// --- CountMinSketch ----------------------------------------------------------

const cms: CountMinSketch = new CountMinSketch(5, 1024);
const cmsSeeded: CountMinSketch = new CountMinSketch(5, 1024, { seed: 42 });
const cmsOpts: CountMinSketchOptions = { seed: 1, conservative: false };
const cmsFull: CountMinSketch = new CountMinSketch(5, 1024, cmsOpts);
void cmsSeeded; void cmsFull;

// withAccuracy is static, returns a CountMinSketch, and takes optional options.
const cmsAcc: CountMinSketch = CountMinSketch.withAccuracy(0.001, 0.01);
const cmsAccOpts: CountMinSketch = CountMinSketch.withAccuracy(0.001, 0.01, { conservative: false });
void cmsAccOpts;

// getters are readonly.
const cd: number = cms.d;
const cw: number = cms.w;
const cseed: number = cms.seed;
const ccons: boolean = cms.conservative;
const ctotal: number = cms.total;
const csat: boolean = cms.saturated;
const ceps: number = cms.epsilon;
const cdelta: number = cms.delta;
void cd; void cw; void cseed; void ccons; void ctotal; void csat; void ceps; void cdelta;

// @ts-expect-error -- saturated is readonly.
cms.saturated = true;
// @ts-expect-error -- d is readonly.
cms.d = 4;
// @ts-expect-error -- w is readonly.
cms.w = 2048;
// @ts-expect-error -- conservative is readonly.
cms.conservative = true;
// @ts-expect-error -- epsilon is readonly.
cms.epsilon = 0.1;
// @ts-expect-error -- delta is readonly.
cms.delta = 0.1;

// add / addHashed -> this (chainable, count optional); estimate / estimateHashed -> number;
// merge -> this; clear -> this.
const cmsChained: CountMinSketch = cms.add(1).add(2, 5).addHashed(0xdeadbeef, 0x1234).addHashed(1, 2, 3);
const cmsEst: number = cms.estimate(1);
const cmsEstHashed: number = cms.estimateHashed(0xdeadbeef, 0x1234);
const cmsMerged: CountMinSketch = cms.merge(new CountMinSketch(5, 1024));
const cmsCleared: CountMinSketch = cms.clear();
void cmsChained; void cmsEst; void cmsEstHashed; void cmsMerged; void cmsCleared;

// addFrom / addHashedFrom: the zero-box entry points -> this (chainable).
const cmsFromBuf = new Float64Array(2);
const cmsFrom: CountMinSketch = cms.addFrom(cmsFromBuf, 0);
const cmsHashedFrom: CountMinSketch = cms.addHashedFrom(new Uint32Array(3), 0).addHashedFrom(new Int32Array(3), 0);
void cmsFrom; void cmsHashedFrom;

// @ts-expect-error -- addFrom needs a Float64Array, not a Float32Array.
cms.addFrom(new Float32Array(2), 0);
// @ts-expect-error -- addHashedFrom needs a Uint32Array | Int32Array, not a Float64Array.
cms.addHashedFrom(new Float64Array(3), 0);

// @ts-expect-error -- d must be a number.
new CountMinSketch('5', 1024);
// @ts-expect-error -- w must be a number.
new CountMinSketch(5, '1024');
// @ts-expect-error -- options.conservative must be a boolean.
new CountMinSketch(5, 1024, { conservative: 'yes' });
// @ts-expect-error -- unknown options are rejected at the type level too.
new CountMinSketch(5, 1024, { bogus: true });
// @ts-expect-error -- add key must be a number.
cms.add('1');
// @ts-expect-error -- addHashed needs two numeric lanes.
cms.addHashed('a', 'b');
// @ts-expect-error -- estimate key must be a number.
cms.estimate('1');
// @ts-expect-error -- merge takes a CountMinSketch.
cms.merge(42);
// @ts-expect-error -- withAccuracy epsilon must be a number.
CountMinSketch.withAccuracy('0.001', 0.01);

// --- DDSketch ----------------------------------------------------------------

const dd: DDSketch = new DDSketch(0.01);
const ddOpts: DDSketchOptions = { maxBins: 128, range: [1, 1000] };
const ddFull: DDSketch = new DDSketch(0.01, ddOpts);
const ddMaxBinsOnly: DDSketch = new DDSketch(0.01, { maxBins: 128 });
const ddRangeOnly: DDSketch = new DDSketch(0.01, { range: [1, 1000] });
void ddFull; void ddMaxBinsOnly; void ddRangeOnly;

// getters are readonly.
const ddAlpha: number = dd.alpha;
const ddCount: number = dd.count;
const ddSum: number = dd.sum;
const ddMin: number = dd.min;
const ddMax: number = dd.max;
const ddZeroCount: number = dd.zeroCount;
const ddMaxBins: number = dd.maxBins;
const ddNumBins: number = dd.numBins;
const ddCollapsed: boolean = dd.collapsed;
void ddAlpha; void ddCount; void ddSum; void ddMin; void ddMax;
void ddZeroCount; void ddMaxBins; void ddNumBins; void ddCollapsed;

// @ts-expect-error -- alpha is readonly.
dd.alpha = 0.02;
// @ts-expect-error -- count is readonly.
dd.count = 5;
// @ts-expect-error -- sum is readonly.
dd.sum = 5;
// @ts-expect-error -- min is readonly.
dd.min = 0;
// @ts-expect-error -- max is readonly.
dd.max = 0;
// @ts-expect-error -- zeroCount is readonly.
dd.zeroCount = 0;
// @ts-expect-error -- maxBins is readonly.
dd.maxBins = 128;
// @ts-expect-error -- numBins is readonly.
dd.numBins = 0;
// @ts-expect-error -- collapsed is readonly.
dd.collapsed = true;

// add -> this (chainable, count optional); quantile -> number; merge -> this; clear -> this.
const ddChained: DDSketch = dd.add(1).add(2, 5);
const ddQuantile: number = dd.quantile(0.5);
const ddMerged: DDSketch = dd.merge(new DDSketch(0.01));
const ddCleared: DDSketch = dd.clear();
void ddChained; void ddQuantile; void ddMerged; void ddCleared;

// quantilesInto(qs, out) -> the number of quantiles written; both args are Float64Array (H2.7).
const ddQs: Float64Array = new Float64Array([0.5, 0.9, 0.99]);
const ddOut: Float64Array = new Float64Array(3);
const ddWritten: number = dd.quantilesInto(ddQs, ddOut);
void ddWritten;
// @ts-expect-error -- quantilesInto qs must be a Float64Array, not a number[].
dd.quantilesInto([0.5, 0.9, 0.99], ddOut);
// @ts-expect-error -- quantilesInto out must be a Float64Array, not a Float32Array.
dd.quantilesInto(ddQs, new Float32Array(3));

// @ts-expect-error -- alpha must be a number.
new DDSketch('0.01');
// @ts-expect-error -- options.maxBins must be a number.
new DDSketch(0.01, { maxBins: '128' });
// @ts-expect-error -- options.range must be a two-element numeric tuple.
new DDSketch(0.01, { range: [1, 2, 3] });
// @ts-expect-error -- unknown options are rejected at the type level too.
new DDSketch(0.01, { bogus: true });
// @ts-expect-error -- add value must be a number.
dd.add('1');
// @ts-expect-error -- add count must be a number.
dd.add(1, '5');
// @ts-expect-error -- quantile q must be a number.
dd.quantile('0.5');
// @ts-expect-error -- merge takes a DDSketch.
dd.merge(42);

// --- SpaceSaving -------------------------------------------------------------

const ss: SpaceSaving = new SpaceSaving(1024);
const ssSeeded: SpaceSaving = new SpaceSaving(1024, { seed: 42 });
const ssOpts: SpaceSavingOptions = { seed: 1 };
const ssFull: SpaceSaving = new SpaceSaving(1024, ssOpts);
void ssSeeded; void ssFull;

// withError is static, returns a SpaceSaving, takes optional options.
const ssErr: SpaceSaving = SpaceSaving.withError(0.001);
const ssErrOpts: SpaceSaving = SpaceSaving.withError(0.001, { seed: 7 });
void ssErr; void ssErrOpts;

// getters are readonly.
const ssCap: number = ss.capacity;
const ssSize: number = ss.size;
const ssTotal: number = ss.total;
const ssEps: number = ss.epsilon;
const ssSeed: number = ss.seed;
void ssCap; void ssSize; void ssTotal; void ssEps; void ssSeed;

// @ts-expect-error -- capacity is readonly.
ss.capacity = 8;
// @ts-expect-error -- size is readonly.
ss.size = 0;
// @ts-expect-error -- total is readonly.
ss.total = 0;
// @ts-expect-error -- epsilon is readonly.
ss.epsilon = 0.1;

// add -> this (chainable, count optional); estimate / errorOf -> number; merge -> this; clear -> this.
const ssChained: SpaceSaving = ss.add(1).add(2, 5);
const ssEst: number = ss.estimate(1);
const ssErrOf: number = ss.errorOf(1);
const ssMerged: SpaceSaving = ss.merge(new SpaceSaving(1024));
const ssCleared: SpaceSaving = ss.clear();
void ssChained; void ssEst; void ssErrOf; void ssMerged; void ssCleared;

// addFrom: the zero-box entry point -> this (chainable). There is no addHashedFrom (no pre-hashed path).
const ssFromBuf = new Float64Array(2);
const ssFrom: SpaceSaving = ss.addFrom(ssFromBuf, 0);
void ssFrom;

// @ts-expect-error -- addFrom needs a Float64Array, not a Float32Array.
ss.addFrom(new Float32Array(2), 0);
// @ts-expect-error -- SpaceSaving has no addHashedFrom (it stores key identities).
ss.addHashedFrom(new Uint32Array(2), 0);

// forEach is alloc-free with a (key, count, error, ss) callback.
ss.forEach((key: number, count: number, error: number, self: SpaceSaving) => {
    void key; void count; void error; void self;
});

// topK / heavyHitters return SpaceSavingEntry[].
const ssTop: SpaceSavingEntry[] = ss.topK(3);
const ssTopAll: SpaceSavingEntry[] = ss.topK();
const ssHH: SpaceSavingEntry[] = ss.heavyHitters(0.01);
const ssEntry: SpaceSavingEntry = ssTop[0];
const ek: number = ssEntry.key;
const ec: number = ssEntry.count;
const ee: number = ssEntry.error;
void ssTopAll; void ssHH; void ek; void ec; void ee;

// topKInto(outKeys, outCounts, outErrors, n?) -> the number of entries written; all three outs
// are Float64Array and n is optional (H2.7).
const ssOK: Float64Array = new Float64Array(8);
const ssOC: Float64Array = new Float64Array(8);
const ssOE: Float64Array = new Float64Array(8);
const ssWritten: number = ss.topKInto(ssOK, ssOC, ssOE, 3);
const ssWrittenAll: number = ss.topKInto(ssOK, ssOC, ssOE);
void ssWritten; void ssWrittenAll;
// @ts-expect-error -- topKInto outKeys must be a Float64Array, not a Float32Array.
ss.topKInto(new Float32Array(8), ssOC, ssOE, 3);
// @ts-expect-error -- topKInto n must be a number.
ss.topKInto(ssOK, ssOC, ssOE, '3');

// @ts-expect-error -- capacity must be a number.
new SpaceSaving('1024');
// @ts-expect-error -- options.seed must be a number.
new SpaceSaving(1024, { seed: 'x' });
// @ts-expect-error -- unknown options are rejected at the type level too.
new SpaceSaving(1024, { bogus: true });
// @ts-expect-error -- add key must be a number.
ss.add('1');
// @ts-expect-error -- add count must be a number.
ss.add(1, '5');
// @ts-expect-error -- estimate key must be a number.
ss.estimate('1');
// @ts-expect-error -- errorOf key must be a number.
ss.errorOf('1');
// @ts-expect-error -- merge takes a SpaceSaving.
ss.merge(42);
// @ts-expect-error -- withError epsilon must be a number.
SpaceSaving.withError('0.001');
// @ts-expect-error -- SpaceSaving has no addHashed (it stores key identities).
ss.addHashed(1, 2);
