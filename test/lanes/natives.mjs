// @zakkster/lite-sketch -- the %NeverOptimizeFunction door for the nc lane (repo-only).
//
// Imported ONLY by lane.mjs in `--nc` mode, where the parent spawns the child with
// `--allow-natives-syntax`. Keeping the `%` call in this separate module means the
// default / no-inline children (spawned WITHOUT the flag) never parse native syntax.
// `neverOpt(step)` pins `step` in the interpreter, so `add` is compiled STANDALONE with
// its murmur helpers inlined -- the realistic "big consumer frame never inlines add"
// case. ASCII-only.

/* eslint-disable no-undef */
export function neverOpt(f) { %NeverOptimizeFunction(f); }
