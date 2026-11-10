import {
  clockAndRandomnessFrom,
  descriptorOf,
  isInPlace,
  withoutPrototype,
} from "./clock-and-randomness.ts";
import { refusals } from "./lockdown.ts";
import { impureMessage } from "./migration.ts";

// What a migration's transform must not reach while it runs: the clock
// and randomness, so it answers the same for the same row however often a
// batch is retried. The attacker is the App's module code, which loads
// before a transform runs and runs again inside it. How it could reach
// them, and what stops it:
// - Calls them plainly (`Math.random()`, `Date.now()`, `new Date()`,
//   `Date()`, `crypto.randomUUID()`, `performance.now()`, a formatter
//   given no date), or generates a key (an extractable key's bytes are
//   randomness): each is shadowed with a refusal.
// - Reads the time through what records it: a `File`'s `lastModified`, a
//   `PerformanceMark`'s or `performance.mark`'s `startTime` (each unless
//   given), `performance.measure`: shadowed with refusals too.
// - Reaches them past the object: `crypto`'s, `crypto.subtle`'s and
//   `performance`'s methods on their prototypes, `Date` and the timed
//   classes as their prototype's `constructor`: shadowed there too.
// - Gives `performance`, `crypto` or `crypto.subtle` an own `now`,
//   `randomUUID` or the like as it loads, which the platform keeps only
//   on their prototypes: each is shadowed on the object too, and the
//   shadow deleted after where the object had none.
// - Makes one non-configurable, so it can't be shadowed: each shadow is
//   checked, and the batch refused before any row runs where one didn't
//   take.
// - Reads `Date.now` through a descriptor (`getOwnPropertyDescriptor(s)`
//   of the global's proxy, which reach its target): shadowed on the real
//   `Date` as well.
// - Defines a proxy trap on `Object.prototype` (`getOwnPropertyDescriptor`,
//   `has`, `defineProperty` …) to be handed the real `Date`: the proxies'
//   handlers have no prototype.
// - Replaces `Reflect.construct` or `Reflect.apply` to be handed the real
//   `Date` or formatter as they are passed on: the replacements use the
//   ones taken as clock-and-randomness.ts loads, before any App module.
// - Replaces what the shadowing itself runs on before the transform runs
//   (`Array.prototype.map` or an iterator, `Object.defineProperty`), so a
//   shadow is skipped, or defines `get`, `value` or the like on
//   `Object.prototype` to be read as part of one: the shadowing uses the
//   intrinsics taken as this module loads, indexed loops, and
//   descriptors and records without a prototype.
// - Replaces a global before the transform runs: what is shadowed, and
//   what it passes on to, is taken as these modules load.
// Not stopped, and not a boundary: a reference App code kept from before,
// or a value computed as its modules loaded, still differs between calls,
// and the isolate has no capability for it to misuse either way. So a
// retried batch is answered from the store's receipt and never compared
// with an earlier answer.

/** The intrinsics the shadowing runs on, as this module loads. */
const { defineProperty, getOwnPropertyDescriptor } = Object;
const { deleteProperty } = Reflect;

/** A function that refuses, for what a migration can't use. */
const unavailable = refusals(impureMessage);
const refuseClock = unavailable("the clock");
const refuseRandomness = unavailable("randomness");

/**
 * What a transform reads the clock and randomness through, refused: on
 * the platform's prototypes, and on the objects themselves (`ifOwn`),
 * where module code may have put its own.
 */
const refused = clockAndRandomnessFrom({
  now: refuseClock,
  performanceNow: refuseClock,
  measure: refuseClock,
  random: refuseRandomness,
  getRandomValues: refuseRandomness,
  randomUUID: refuseRandomness,
  generateKey: refuseRandomness,
});

/** Puts back what each of `refused` up to `count` held (`saved`). */
const restore = (
  saved: Record<number, PropertyDescriptor | undefined>,
  count: number
): void => {
  for (let index = count - 1; index >= 0; index -= 1) {
    const replacement = refused[index];
    const before = saved[index];
    try {
      if (replacement === undefined) {
        // Nothing was shadowed at this index.
      } else if (before === undefined) {
        deleteProperty(replacement.target, replacement.key);
      } else {
        defineProperty(
          replacement.target,
          replacement.key,
          withoutPrototype({ ...before })
        );
      }
    } catch {
      // As the shadowing left it.
    }
  }
};

/**
 * Runs `work` with the clock and randomness taken away (see the threat
 * model above), restoring them after. Where one can't be taken away
 * (module code made it non-configurable), nothing of `work` runs:
 * answers `refuse` with the refusal of what is still reachable. The loops
 * are indexed: `map`, or `for...of`'s iterator, is looked up as it runs,
 * when module code may have replaced it.
 */
export const deterministically = <Result>(
  work: () => Result,
  refuse: (message: string) => Result
): Result => {
  // What each key held before, by index.
  const saved: Record<number, PropertyDescriptor | undefined> =
    withoutPrototype({});
  for (let index = 0; index < refused.length; index += 1) {
    const replacement = refused[index];
    if (replacement !== undefined) {
      const { target, key } = replacement;
      saved[index] = getOwnPropertyDescriptor(target, key);
      try {
        defineProperty(target, key, descriptorOf(replacement, true));
      } catch {
        // Not configurable here: checked below.
      }
      if (!isInPlace(replacement)) {
        restore(saved, index + 1);
        return refuse(
          impureMessage(
            replacement.value === refuseRandomness ? "randomness" : "the clock"
          )
        );
      }
    }
  }
  try {
    return work();
  } finally {
    restore(saved, refused.length);
  }
};
