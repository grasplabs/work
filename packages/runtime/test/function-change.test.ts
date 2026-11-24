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

/** Arguments holding `field` in an object at each depth and container. */
const nested = (field: AnySchema): Record<string, AnySchema> => ({
  config: v.object({ status: field }),
  items: v.array(v.object({ status: field })),
  byKey: v.record(v.object({ status: field })),
  either: v.union(v.object({ status: field }), v.string()),
  deep: v.object({ inner: v.array(v.object({ status: field })) }),
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

  test("takes a nested argument a caller may leave out as one it may still leave out", () => {
    const status = v.string().default("open");
    const defaulted = fn(nested(status), null);

    expect(
      functionBreak(defaulted, fn(nested(v.string().optional()), null))
    ).toBeUndefined();
    // Each place made required on its own: a call sending `{}` there fails.
    for (const [place, schema] of Object.entries(nested(v.string()))) {
      const required = { ...nested(status), [place]: schema };
      expect(functionBreak(defaulted, fn(required, null))).toMatch(
        /arguments/u
      );
    }
  });

  test("lets a field be added to an answer inside a record, a union or deeper", () => {
    const answers: [AnySchema, AnySchema][] = [
      [
        v.record(v.object({ id: v.string() })),
        v.record(v.object({ id: v.string(), at: v.number() })),
      ],
      [
        v.union(v.object({ id: v.string() }), v.null()),
        v.union(v.object({ id: v.string(), at: v.number() }), v.null()),
      ],
      [
        v.object({
          pages: v.array(
            v.record(v.union(v.object({ id: v.string() }), v.string()))
          ),
        }),
        v.object({
          pages: v.array(
            v.record(
              v.union(v.object({ id: v.string(), at: v.number() }), v.string())
            )
          ),
          total: v.number(),
        }),
      ],
    ];
    for (const [read, answered] of answers) {
      expect(functionBreak(fn({}, read), fn({}, answered))).toBeUndefined();
    }
    // A field the caller reads, removed inside a record: still a break.
    expect(
      functionBreak(
        fn({}, v.record(v.object({ id: v.string() }))),
        fn({}, v.record(v.object({ at: v.number() })))
      )
    ).toMatch(/answer/u);
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
