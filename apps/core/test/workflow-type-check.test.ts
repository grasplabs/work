import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { buildWorkflows } from "../src/screens.ts";
import { startRun } from "../src/workflows/runs.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { refusal, signedInApi } from "./sign-in.ts";
import { sampleApp, workflowFiles } from "./workflow-apps.ts";

// An App's TypeScript workflows are type-checked wherever they are built
// (compiler `buildWorkflows`): as their version is made current, before
// their tests run, and as a run loads them. The ways it can fail come
// first (threat model on GRA-675, slice 3): a type error that still runs;
// a workflow reaching, for its types, what its isolate doesn't have (the
// DOM) or modules it may not import; one file steering the whole check
// with a directive, a suppression or an ambient declaration; and a
// version that got past the gate some other way still running. The App's
// server code joins the check as types a workflow may name (its
// `appFunctions<Tree>(env)`), only as it builds, so it steers nothing.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** A workflow `checked` whose one step runs `body`, with its tests. */
const checked = (body: string): Record<string, string> =>
  workflowFiles(
    "checked",
    `  return await step.do("work", { description: "Work" }, async () => {
${body}
  });`,
    { work: null }
  );

const failedBuild = z.object({
  code: z.string(),
  details: z
    .object({
      diagnostics: z.array(z.object({ file: z.string().nullable() })),
    })
    .optional(),
});

/**
 * A workflow `typed` whose step calls `call`, typed by the sample App's
 * own operations, as the App registers them under `counter`.
 */
const typed = (call: string): Record<string, string> => ({
  "workflows/typed.ts": `import { appFunctions, workflow, z } from "@grasp-os/sdk/workflow";

import type * as sample from "../operations/sample.ts";

type Invoices = { counter: typeof sample };

export default workflow("typed", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("count", { description: "Count" }, async () => {
    const answered = await ${call.replace("APP", "appFunctions<Invoices>(env)")};
    return answered.ok ? answered.value : 0;
  })
);
`,
});

/**
 * What building `files` as an App's workflows said: ok, the files its
 * errors name, and the rules of its warnings.
 */
const built = async (
  files: Record<string, string>
): Promise<{ ok: boolean; files: string[]; warned: string[] }> => {
  const build = await buildWorkflows(env, files, "app-test");
  const diagnostics = build.ok ? [] : build.diagnostics;
  const of = (severity: string) =>
    diagnostics.filter((diagnostic) => diagnostic.severity === severity);
  return {
    ok: build.ok,
    files: [
      ...new Set(of("error").map(({ file }) => file ?? "(App)")),
    ].toSorted(),
    warned: [...new Set(of("warning").map(({ rule }) => rule))].toSorted(),
  };
};

/**
 * The sample App with a migration its registration imports, as an App
 * registers one (`migrations: [derive]`).
 */
const migratedApp = (): Record<string, string> => {
  const app = sampleApp();
  return {
    ...app,
    "app.ts": (app["app.ts"] ?? "")
      .replace(
        'import schema from "./schema.ts";',
        'import derive from "./migrations/derive.ts";\nimport schema from "./schema.ts";'
      )
      .replace(
        "  internalOperations: {},",
        "  internalOperations: {},\n  migrations: [derive],"
      ),
    "migrations/derive.ts": `import { migration, v } from "@grasp-os/sdk";

export default migration({
  name: "derive",
  table: "counters",
  fromSchema: "before",
  toSchema: "after",
  input: v.object({ name: v.string(), count: v.number() }),
  output: v.object({ name: v.string(), count: v.number() }),
  fixtures: [],
  handler: (_ctx, row) => row,
});
`,
  };
};

/**
 * The files and the rules of the errors building `files` as an App's
 * workflows said: `rule: "imports"` is the build's own refusal (a
 * directive, a suppression, an ambient module), before any type check.
 */
const steered = async (
  files: Record<string, string>
): Promise<{ files: string[]; rules: string[] }> => {
  const build = await buildWorkflows(env, files, "app-test");
  const errors = build.ok
    ? []
    : build.diagnostics.filter(({ severity }) => severity === "error");
  return {
    files: [...new Set(errors.map(({ file }) => file ?? "(App)"))].toSorted(),
    rules: [...new Set(errors.map(({ rule }) => rule))].toSorted(),
  };
};

/**
 * What making `files` current was refused with: its code, and the files
 * its diagnostics name; `ok` when it was made current.
 */
const refusedActivation = async (
  files: Record<string, string>
): Promise<{ code: string; files: string[] }> => {
  const builder = await personApi("builder");
  const { id: app } = await builder.api.apps.create({ name: "Checked" });
  const { version } = await builder.api.apps.files.commit(
    app,
    { ...sampleApp(), ...files },
    "Try"
  );
  const outcome = await refusal(
    builder.api.apps.versions.setCurrent(app, version)
  );
  if (outcome === "ok") {
    return { code: "ok", files: [] };
  }
  const parsed = failedBuild.safeParse(outcome);
  if (!parsed.success) {
    return { code: String(outcome), files: [] };
  }
  const { code, details } = parsed.data;
  return {
    code,
    files: [
      ...new Set(
        (details?.diagnostics ?? []).map(({ file }) => file ?? "(App)")
      ),
    ].toSorted(),
  };
};

describe(
  "TypeScript workflows, type-checked as they are built",
  { timeout: 120_000 },
  () => {
    afterEach(endLiveRuns);

    it.each([
      [
        "a DOM global, which its isolate doesn't have",
        "    return document.title;",
      ],
      ["browser storage", '    return localStorage.getItem("x");'],
      [
        "a type error",
        '    const total: number = "twelve";\n    return total;',
      ],
      [
        "a binding's answer read as what it isn't said to be",
        '    return (await env.MAIL.call("mail.send", {})).output;',
      ],
      [
        "a binding's answer recorded as a step's result, unnarrowed",
        '    return await env.MAIL.call("mail.send", {});',
      ],
    ])("refuse %s", async (_case, body) => {
      await expect(refusedActivation(checked(body))).resolves.toStrictEqual({
        code: "workflow.build_failed",
        files: ["workflows/checked.ts"],
      });
    });

    it.each([
      [
        "a path into the kit's packages, for its types",
        'import type { runScreen } from "../node_modules/@grasp-os/sdk/src/screen-runtime.ts";\nexport type Reached = typeof runScreen;\n',
      ],
      [
        "a module of the kit's screens, for its types",
        'import type { ReactNode } from "react";\nexport type Reached = ReactNode;\n',
      ],
      [
        "a module the SDK doesn't give it, named with a trailing slash",
        'import type { GraspClient } from "@grasp-os/sdk/client/";\nexport type Reached = GraspClient;\n',
      ],
    ])("refuse, in a helper they share, %s", async (_case, source) => {
      await expect(
        refusedActivation({
          ...checked("    return 1;"),
          "workflows/lib/extra.ts": source,
        })
      ).resolves.toStrictEqual({
        code: "workflow.build_failed",
        files: ["workflows/lib/extra.ts"],
      });
    });

    it.each([
      [
        "a reference path into the kit",
        '/// <reference path="../../node_modules/@grasp-os/sdk/src/client.ts" />\nexport const extra = 1;\n',
      ],
      [
        "a lib it references, the DOM's",
        '/// <reference lib="dom" />\nexport const title = (): string => document.title;\n',
      ],
      [
        "a types reference",
        '/// <reference types="node" />\nexport const extra = 1;\n',
      ],
      [
        "a line the type check is told to ignore",
        "// @ts-ignore\nexport const title = (): string => document.title;\n",
      ],
      [
        "an error the type check is told to expect",
        "// @ts-expect-error\nexport const title = (): string => document.title;\n",
      ],
      [
        "an error the type check is told to expect, on a block comment's last line",
        "/* Expected:\n @ts-expect-error */\nexport const title = (): string => document.title;\n",
      ],
      [
        "a line the type check is told to ignore, after a carriage return in a block comment",
        "/* x\r @ts-ignore */\nexport const title = (): string => document.title;\n",
      ],
      [
        "an error the type check is told to expect, after a line separator in a block comment",
        "/* x\u2028 @ts-expect-error */\nexport const title = (): string => document.title;\n",
      ],
      [
        "an error the type check is told to expect, after a paragraph separator in a block comment",
        "/* x\u2029 @ts-expect-error */\nexport const title = (): string => document.title;\n",
      ],
      [
        "a file the type check is told to skip",
        "// @ts-nocheck\nexport const title = (): string => document.title;\n",
      ],
      [
        "a file the type check is told to skip, in another case",
        "// @ts-NoCheck\nexport const title = (): string => document.title;\n",
      ],
      [
        "an ambient module that adds to the SDK's, which a workflow then reads",
        'import { leak } from "@grasp-os/sdk/workflow";\n\ndeclare module "@grasp-os/sdk/workflow" {\n  export const leak: number;\n}\nexport const extra: number = leak;\n',
      ],
      [
        "globals it declares for every workflow",
        "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
      ],
    ])(
      "refuse, in a helper they share, %s, before the type check reads it",
      async (_case, source) => {
        await expect(
          steered({
            ...sampleApp(),
            ...checked("    return 1;"),
            "workflows/lib/extra.ts": source,
          })
        ).resolves.toStrictEqual({
          files: ["workflows/lib/extra.ts"],
          rules: ["imports"],
        });
      }
    );

    it("make current a workflow that narrows what its bindings answer, and runs as its SDK types it", async () => {
      await expect(
        refusedActivation(
          checked(`    const answered = await env.APP.callFunction({ contractId: "counter.hits", kind: "query" }, { name: "x" });
    const { ok } = answered as { ok: boolean };
    return ok ? crypto.randomUUID().length : 0;`)
        )
      ).resolves.toStrictEqual({ code: "ok", files: [] });
    });

    it("type a workflow's calls of its App's functions by the App's own operations", async () => {
      await expect(
        Promise.all(
          [
            'APP.query("counter.hits", { name: "x" })',
            'APP.query("counter.missing", { name: "x" })',
            'APP.query("counter.hits", { name: 1 })',
            'APP.query("counter.hit", { name: "x", execution: "e" })',
          ].map(async (call) => await built({ ...sampleApp(), ...typed(call) }))
        )
      ).resolves.toStrictEqual([
        { ok: true, files: [], warned: [] },
        { ok: false, files: ["workflows/typed.ts"], warned: [] },
        { ok: false, files: ["workflows/typed.ts"], warned: [] },
        { ok: false, files: ["workflows/typed.ts"], warned: [] },
      ]);
    });

    it("leave out of a workflow's check server code that doesn't build, so it gives the workflows nothing, and say so", async () => {
      await expect(
        built({
          ...sampleApp(),
          "operations/extra.ts":
            "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
          ...checked("    return document.title;"),
        })
      ).resolves.toStrictEqual({
        ok: false,
        files: ["workflows/checked.ts"],
        warned: ["server"],
      });
    });

    it("type a workflow by the operations of an App that registers a migration", async () => {
      await expect(
        built({
          ...migratedApp(),
          ...typed('APP.query("counter.hits", { name: "x" })'),
        })
      ).resolves.toStrictEqual({ ok: true, files: [], warned: [] });
    });

    it("build a workflow beside server code with type errors of its own, which its seal refuses", async () => {
      await expect(
        built({
          ...sampleApp(),
          "operations/extra.ts": 'export const total: number = "twelve";\n',
          ...typed('APP.query("counter.hits", { name: "x" })'),
        })
      ).resolves.toStrictEqual({ ok: true, files: [], warned: [] });
    });

    it("fail a run whose version holds a workflow that doesn't type-check, however it became current", async () => {
      const builder = await personApi("builder");
      const { id: app } = await builder.api.apps.create({ name: "Checked" });
      const { version } = await builder.api.apps.files.commit(
        app,
        { ...sampleApp(), ...checked("    return document.title;") },
        "Unchecked"
      );
      // Made current behind the gate's back, as no API does.
      await env.DB.prepare("UPDATE apps SET current_version = ? WHERE id = ?")
        .bind(version, app)
        .run();
      const run = await startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("checked"),
        input: undefined,
        startedBy: builder.userId,
        actor: { type: "system" },
      });
      await finished(run.id);
      const { status, failure } = await builder.api.workflows.status(run.id);
      expect({
        status,
        code: failure?.error.code,
      }).toStrictEqual({ status: "failed", code: "workflow.build_failed" });
    });
  }
);
