import {
  GLOBAL_EXPECT,
  JestAsymmetricMatchers,
  JestChaiExpect,
  JestExtend,
  chai,
  getState,
  setState,
} from "@vitest/expect";
import type { ExpectStatic, MatchersObject } from "@vitest/expect";

// `expect` for an App's tests: vitest's own, from `@vitest/expect`, the
// Chai plugin of Jest's matchers vitest builds its `expect` from, set up
// as that package says. An App's tests run in a sandboxed isolate with
// core's host and nothing else (no Node, no Vite, no files), where
// vitest's runner can't run; its matchers can, and read the same as in
// any vitest test: `toBe`, `toEqual`, `toMatchObject`, `rejects`, ... What
// only vitest's runner adds (`expect.soft`, `expect.poll`, counting
// assertions) isn't here.

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(JestAsymmetricMatchers);

/** `expect.extend` as `JestExtend` adds it: the `expect` it extends first. */
const extendOf = (): ((
  extended: ExpectStatic,
  matchers: MatchersObject
) => void) => {
  const added: unknown = Reflect.get(chai.expect, "extend");
  if (typeof added !== "function") {
    throw new TypeError("@vitest/expect's JestExtend adds expect.extend.");
  }
  return (extended, matchers) => {
    Reflect.apply(added, chai.expect, [extended, matchers]);
  };
};

/**
 * vitest's `expect`: Chai's, with the plugins above, and the state and
 * `extend` vitest gives its own (`createExpect`). A refused call rejects
 * with the `GraspError` a page gets, its `code` what to match:
 *
 * ```ts
 * await expect(bo.query(api.notes.get, { id })).rejects.toMatchObject({
 *   code: "note.not_found",
 * });
 * ```
 */
// SAFETY: Chai's `expect` with the plugins above, and the members set
// below, is what `ExpectStatic` types, as `@vitest/expect` declares it.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
export const expect = chai.expect as ExpectStatic;
const extend = extendOf();
expect.extend = (matchers) => {
  extend(expect, matchers);
};
expect.getState = () => getState(expect);
expect.setState = (state) => {
  setState(state, expect);
};
setState(
  {
    assertionCalls: 0,
    isExpectingAssertions: false,
    isExpectingAssertionsError: null,
    expectedAssertionsNumber: null,
    expectedAssertionsNumberErrorGen: null,
  },
  expect
);
// Where matchers made with `expect.extend` read their state from.
Object.defineProperty(globalThis, GLOBAL_EXPECT, {
  value: expect,
  configurable: true,
});
