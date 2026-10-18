import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

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
// version that got past the gate some other way still running.

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
        "a file the type check is told to skip",
        "// @ts-nocheck\nexport const title = (): string => document.title;\n",
      ],
      [
        "a file the type check is told to skip, in another case",
        "// @ts-NoCheck\nexport const title = (): string => document.title;\n",
      ],
      [
        "an ambient module that shadows the SDK's",
        'declare module "@grasp-os/sdk/workflow" {\n  export const leak: number;\n}\nexport const extra = 1;\n',
      ],
      [
        "globals it declares for every workflow",
        "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
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

    it("make current a workflow that narrows what its bindings answer, and runs as its SDK types it", async () => {
      await expect(
        refusedActivation(
          checked(`    const answered = await env.APP.callFunction({ contractId: "counter.hits", kind: "query" }, { name: "x" });
    const { ok } = answered as { ok: boolean };
    return ok ? crypto.randomUUID().length : 0;`)
        )
      ).resolves.toStrictEqual({ code: "ok", files: [] });
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
