import { describe, expect, test } from "vite-plus/test";

import type { FunctionManifest } from "../src/app-types.ts";
import { functionBreak } from "../src/function-change.ts";
import { descriptorOf } from "../src/sealed-descriptors.ts";
import type { AnySchema } from "../src/value-schema.ts";
import { v } from "../src/values.ts";

// Whether a function still serves a workflow bound to it as another
// version declared it (function-change.ts): what an App's publish checks
// of every function a workflow calls. Pure, so unit tests; the publish
// that refuses a break is tested through core
// (apps/core/test/workflow-app-functions.test.ts).

/** A public function of `kind` taking `args` and answering `returns`. */
const fn = (
  args: Record<string, AnySchema>,
  returns: AnySchema | null,
  kind: FunctionManifest["kind"] = "mutation"
): FunctionManifest => ({
  path: "tasks.create",
  kind,
  visibility: "public",
  args: descriptorOf(v.object(args)),
  returns: returns === null ? null : descriptorOf(returns),
  stream: null,
});

const before = fn({ title: v.string().max(200) }, v.object({ id: v.string() }));

describe(functionBreak, () => {
  test("takes an argument a caller may leave out as one it may still leave out", () => {
    const defaulted = fn(
      { title: v.string(), status: v.string().default("open") },
      null
    );

    expect([
      functionBreak(
        defaulted,
        fn({ title: v.string(), status: v.string().optional() }, null)
      ),
      functionBreak(
        defaulted,
        fn({ title: v.string(), status: v.string() }, null)
      ),
    ]).toStrictEqual([undefined, expect.stringMatching(/arguments/u)]);
  });

  test("lets through what serves every call the workflow makes", () => {
    const serving = [
      before,
      // A new optional argument, a looser bound, a narrower answer.
      fn(
        { title: v.string().max(500), note: v.string().optional() },
        v.object({ id: v.string() })
      ),
      fn({ title: v.string() }, v.object({ id: v.string().max(36) })),
      // A field added to the answer, at any depth: no caller reads it.
      fn(
        { title: v.string().max(200) },
        v.object({ id: v.string(), createdAt: v.number() })
      ),
    ];
    for (const after of serving) {
      expect(functionBreak(before, after)).toBeUndefined();
    }
    // A function that promised no answer may answer anything.
    expect(
      functionBreak(fn({}, null), fn({}, v.object({ id: v.string() })))
    ).toBeUndefined();
  });

  test("names what breaks a call the workflow makes", () => {
    const id = v.object({ id: v.string() });
    const breaks: [FunctionManifest, RegExp][] = [
      [{ ...before, visibility: "internal" }, /internal/u],
      [{ ...before, kind: "action" }, /action now, not a mutation/u],
      // An argument dropped, one required added, one narrowed or retyped.
      [fn({}, id), /arguments/u],
      [fn({ title: v.string().max(200), due: v.string() }, id), /arguments/u],
      [fn({ title: v.string().max(100) }, id), /arguments/u],
      [fn({ title: v.number() }, id), /arguments/u],
      // An answer retyped, a field it had removed, or no longer promised.
      [
        fn({ title: v.string().max(200) }, v.object({ id: v.number() })),
        /answer/u,
      ],
      [
        fn({ title: v.string().max(200) }, v.object({ other: v.string() })),
        /answer/u,
      ],
      [fn({ title: v.string().max(200) }, null), /answer/u],
    ];
    for (const [after, reason] of breaks) {
      expect(functionBreak(before, after)).toMatch(reason);
    }
  });
});
