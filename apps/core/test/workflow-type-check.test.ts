import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { buildWorkflows } from "../src/screens.ts";
import { startRun } from "../src/workflows/runs.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { outcome as codeOf, refusal, signedInApi } from "./sign-in.ts";
import { steeringCases } from "./steering-cases.ts";
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
// `appFunctions<Tree>(env)`), only as it builds, so it steers nothing. Its
// `env` is typed by the App's permissions (GRA-720): each binding name
// they hold as what it is, a connection, a collection or another App's
// exports, with the App's own `APP`; any other name answers `unknown`,
// never `any`, as the runtime refuses it if the App has no grant for it.

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

/** Server code with an action that answers once and one that streams. */
const streams = {
  "operations/streams.ts": `import { v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const once = action({ args: {}, returns: v.number(), handler: async () => 1 });

export const progress = action({
  args: {},
  returns: v.number(),
  stream: v.object({ done: v.number() }),
  handler: async (ctx) => {
    await ctx.emit({ done: 1 });
    return 1;
  },
});
`,
};
/** A workflow `streaming` calling the action at `path` of `streams`. */
const calling = (path: string): Record<string, string> => ({
  "workflows/streaming.ts": `import { appFunctions, workflow, z } from "@grasp-os/sdk/workflow";

import type * as streams from "../operations/streams.ts";

type Invoices = { streams: typeof streams };

export default workflow("streaming", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("call", { description: "Call" }, async () => {
    const answered = await appFunctions<Invoices>(env).action("${path}", {});
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
  files: Record<string, string>,
  bindings: Record<string, string> = {}
): Promise<{ ok: boolean; files: string[]; warned: string[] }> => {
  const build = await buildWorkflows(env, files, "app-test", bindings);
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
  const build = await buildWorkflows(env, files, "app-test", {});
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
  files: Record<string, string>,
  /**
   * Whether the App asks for a connection as `MAIL` first; `revoked`: and
   * an admin grants it, then takes it back.
   */
  mail: boolean | "revoked" = false
): Promise<{ code: string; files: string[] }> => {
  const builder = await personApi("builder");
  const { id: app } = await builder.api.apps.create({ name: "Checked" });
  if (mail !== false) {
    const connection = await mailConnection();
    const request: PermissionRequest = {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: connection.id },
      actions: ["mail.send"],
      binding: "MAIL",
    };
    if (mail === "revoked") {
      const granted = await requestGranted(idp, builder, request);
      const admin = await personApi("admin");
      await admin.api.permissions.revoke(granted);
    } else {
      await builder.api.permissions.request(request);
    }
  }
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
        "the answer of a binding its App has no permission for, unnarrowed",
        '    return (await env.CRM.call("find", {})).output;',
      ],
      [
        "a connection's answer read as an App function's",
        '    const answered = await env.MAIL.call("mail.send", {});\n    return answered.ok ? 1 : 0;',
      ],
      [
        "an App function's answer read as a connection's",
        '    return (await env.APP.callFunction({ contractId: "counter.hits", kind: "query" }, { name: "x" })).output;',
      ],
      [
        "a call of the App's server methods, which a run no longer has",
        '    return await env.APP.call("hits");',
      ],
    ])("refuse %s", async (_case, body) => {
      await expect(
        refusedActivation(checked(body), true)
      ).resolves.toStrictEqual({
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

    it.each(steeringCases("@grasp-os/sdk/workflow"))(
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

    it("make current a workflow that reads its bindings as what its App's permissions make them", async () => {
      await expect(
        refusedActivation(
          checked(`    const answered = await env.APP.callFunction({ contractId: "counter.hits", kind: "query" }, { name: "x" });
    const sent = await env.MAIL.call("mail.send", { to: "ada@acme.test" });
    return answered.ok ? sent.output.length + crypto.randomUUID().length : 0;`),
          true
        )
      ).resolves.toStrictEqual({ code: "ok", files: [] });
    });

    it("keep typing a binding whose permission was revoked, so its workflows still build", async () => {
      // The call is refused when made (`permission.denied`); the code may
      // still name it, as it may a binding only asked for.
      await expect(
        refusedActivation(
          checked(
            '    return (await env.MAIL.call("mail.send", {})).output.length;'
          ),
          "revoked"
        )
      ).resolves.toStrictEqual({ code: "ok", files: [] });
    });

    it("type each binding as the kind of binding its permission makes, and any other name's answer as unknown", async () => {
      const bindings = {
        HANDBOOK: "collection",
        MAIL: "connection",
      };
      await expect(
        Promise.all(
          [
            '    return (await env.HANDBOOK.search("refunds")).hits.length;',
            '    return (await env.MAIL.call("mail.send", {})).output;',
            // A name the App holds no permission for: callable, its answer
            // `unknown` until narrowed.
            '    return (await env.ARCHIVE.call("find", {})) === null ? 0 : 1;',
            '    return (await env.HANDBOOK.search("refunds")).output;',
            '    return (await env.MAIL.call("mail.send", {})).ok ? 1 : 0;',
            '    return (await env.MAIL.search("refunds")).hits.length;',
            '    return (await env.ARCHIVE.call("find", {})).output;',
            '    const found: Json = await env.ARCHIVE.call("find", {});\n    return found;',
          ].map(
            async (body) =>
              await built({ ...sampleApp(), ...checked(body) }, bindings)
          )
        )
      ).resolves.toStrictEqual([
        { ok: true, files: [], warned: [] },
        { ok: true, files: [], warned: [] },
        { ok: true, files: [], warned: [] },
        { ok: false, files: ["workflows/checked.ts"], warned: [] },
        { ok: false, files: ["workflows/checked.ts"], warned: [] },
        { ok: false, files: ["workflows/checked.ts"], warned: [] },
        { ok: false, files: ["workflows/checked.ts"], warned: [] },
        { ok: false, files: ["workflows/checked.ts"], warned: [] },
      ]);
    });

    it("type a version by the permissions asked for when it was committed: a later request types later versions, never one already current", async () => {
      const builder = await personApi("builder");
      const { id: app } = await builder.api.apps.create({ name: "Checked" });
      // A cast that holds only while MAIL's answer is unknown.
      const files = {
        ...sampleApp(),
        ...checked(`    if (input === "never") {
      const sent = (await env.MAIL.call("mail.send", {})) as { other: number };
      return sent.other;
    }
    return 1;`),
      };
      const first = await builder.api.apps.files.commit(app, files, "First");
      await builder.api.apps.versions.setCurrent(app, first.version);
      const connection = await mailConnection();
      await builder.api.permissions.request({
        subject: { type: "app", appId: app },
        object: { type: "connection", connectionId: connection.id },
        actions: ["mail.send"],
        binding: "MAIL",
      });
      // Its run builds it again, as it was committed: still untyped.
      const run = await startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("checked"),
        input: undefined,
        startedBy: builder.userId,
        actor: { type: "system" },
      });
      await finished(run.id);
      const { status } = await builder.api.workflows.status(run.id);
      // The same code committed after the request is typed, and refused.
      const second = await builder.api.apps.files.commit(
        app,
        { ...files, "notes.md": "Again" },
        "Second"
      );
      const outcome = await refusal(
        builder.api.apps.versions.setCurrent(app, second.version)
      );
      expect({
        status,
        second: failedBuild.safeParse(outcome).data?.code,
      }).toStrictEqual({
        status: "completed",
        second: "workflow.build_failed",
      });
    });

    it("type a name by the permission that holds it now over one revoked, whatever their kinds", async () => {
      const builder = await personApi("builder");
      const { id: app } = await builder.api.apps.create({ name: "Checked" });
      const admin = await personApi("admin");
      // MAIL once named a connection, taken back; now a collection.
      const connection = await mailConnection();
      await admin.api.permissions.revoke(
        await requestGranted(idp, builder, {
          subject: { type: "app", appId: app },
          object: { type: "connection", connectionId: connection.id },
          actions: ["mail.send"],
          binding: "MAIL",
        })
      );
      const { id: collectionId } = await admin.api.knowledge.createCollection({
        name: `Mail ${crypto.randomUUID()}`,
        access: "everyone",
      });
      await builder.api.permissions.request({
        subject: { type: "app", appId: app },
        object: { type: "collection", collectionId },
        actions: ["read"],
        binding: "MAIL",
      });
      const tried = async (body: string): Promise<string> => {
        const { version } = await builder.api.apps.files.commit(
          app,
          { ...sampleApp(), ...checked(body) },
          body
        );
        const outcome = await refusal(
          builder.api.apps.versions.setCurrent(app, version)
        );
        return outcome === "ok"
          ? "ok"
          : (failedBuild.safeParse(outcome).data?.code ?? String(outcome));
      };
      // One after the other: each commit is the App's next version.
      const asCollection = await tried(
        '    return (await env.MAIL.search("refunds")).hits.length;'
      );
      const asConnection = await tried(
        '    return (await env.MAIL.call("mail.send", {})).output;'
      );
      expect({ asCollection, asConnection }).toStrictEqual({
        asCollection: "ok",
        asConnection: "workflow.build_failed",
      });
    });

    it("keep a version typed as committed when making it current asks for its permissions again", async () => {
      const builder = await personApi("builder");
      const { id: app } = await builder.api.apps.create({ name: "Checked" });
      const connection = await mailConnection();
      await requestGranted(idp, builder, {
        subject: { type: "app", appId: app },
        object: { type: "connection", connectionId: connection.id },
        actions: ["mail.send"],
        binding: "MAIL",
      });
      // Reads MAIL's answer as a connection's: typed only while MAIL is.
      const { version } = await builder.api.apps.files.commit(
        app,
        {
          ...sampleApp(),
          ...checked(`    if (input === "never") {
      return (await env.MAIL.call("mail.send", {})).output.length;
    }
    return 1;`),
        },
        "Typed"
      );
      // Made current by a builder who can't grant: MAIL, which changes
      // things, is asked for again, now.
      await builder.api.apps.versions.setCurrent(app, version);
      const [mail] = await builder.api.permissions.list({
        type: "app",
        appId: app,
      });
      // Its run builds it again, as it was committed: MAIL still typed.
      const run = await startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("checked"),
        input: undefined,
        startedBy: builder.userId,
        actor: { type: "system" },
      });
      await finished(run.id);
      const { status } = await builder.api.workflows.status(run.id);
      expect({ mail: mail?.status, status }).toStrictEqual({
        mail: "requested",
        status: "completed",
      });
    });

    it("type a build again once the App asks for another permission: the bindings are part of its cache key", async () => {
      const files = {
        ...sampleApp(),
        ...checked(
          `    return (await env.MAIL.call("mail.send", { at: "${crypto.randomUUID()}" })).output;`
        ),
      };
      // The same files, built through the same R2 cache: first with no
      // permission for MAIL, its answer then unknown; then with one.
      const before = await built(files);
      const after = await built(files, { MAIL: "connection" });
      expect({ before, after }).toStrictEqual({
        before: { ok: false, files: ["workflows/checked.ts"], warned: [] },
        after: { ok: true, files: [], warned: [] },
      });
    });

    it("refuse binding names the build is given that aren't a permission's, the platform's own among them", async () => {
      const given: Record<string, string>[] = [
        { APP: "connection" },
        { mail: "connection" },
        { MAIL: "model" },
      ];
      await expect(
        Promise.all(
          given.map(
            async (bindings) =>
              await built(
                { ...sampleApp(), ...checked("    return 1;") },
                bindings
              )
          )
        )
      ).resolves.toStrictEqual([
        { ok: false, files: [".grasp/workflow-bindings.json"], warned: [] },
        { ok: false, files: [".grasp/workflow-bindings.json"], warned: [] },
        { ok: false, files: [".grasp/workflow-bindings.json"], warned: [] },
      ]);
    });

    it("take a workflow's binding types only from the host: an App's own files where the host puts them are refused when saved and change nothing when built", async () => {
      // What an App would write there to type a name it holds no
      // permission for as answering anything.
      const planted = {
        ".grasp/workflow-env.ts": `declare module "@grasp-os/sdk/workflow" {
  interface WorkflowBindings {
    readonly ARCHIVE: { call(...args: unknown[]): Promise<any> };
  }
}
export {};
`,
        ".grasp/workflow-bindings.json": JSON.stringify({
          ARCHIVE: "connection",
        }),
      };
      const declaration = planted[".grasp/workflow-env.ts"];
      const builder = await personApi("builder");
      const { id: app } = await builder.api.apps.create({ name: "Planted" });
      const saved = await Promise.all(
        Object.entries(planted).map(
          async ([path, source]) =>
            await codeOf(
              builder.api.apps.files.commit(
                app,
                { ...sampleApp(), [path]: source },
                "Planted"
              )
            )
        )
      );
      const files = {
        ...sampleApp(),
        ...checked('    return (await env.ARCHIVE.call("find", {})).output;'),
      };
      const plantedAt: Record<string, string>[] = [
        planted,
        { ".grasp/workflow-env.ts": declaration },
        {
          ".grasp/workflow-bindings.json":
            planted[".grasp/workflow-bindings.json"],
        },
        // Anywhere else the host puts its modules, too.
        { ".grasp/extra.ts": declaration },
      ];
      const builtWith = await Promise.all(
        plantedAt.map(async (more) => await built({ ...files, ...more }))
      );
      expect({ saved, builtWith }).toStrictEqual({
        saved: ["app.invalid", "app.invalid"],
        builtWith: [
          { ok: false, files: ["workflows/checked.ts"], warned: [] },
          { ok: false, files: ["workflows/checked.ts"], warned: [] },
          { ok: false, files: ["workflows/checked.ts"], warned: [] },
          { ok: false, files: ["workflows/checked.ts"], warned: [] },
        ],
      });
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

    it("offer a workflow's call no streaming action, which runs only for a screen following it", async () => {
      await expect(
        Promise.all(
          ["streams.once", "streams.progress"].map(
            async (path) =>
              await built({ ...sampleApp(), ...streams, ...calling(path) })
          )
        )
      ).resolves.toStrictEqual([
        { ok: true, files: [], warned: [] },
        { ok: false, files: ["workflows/streaming.ts"], warned: [] },
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

    it("type a workflow by operations kept in a folder whose name has a dot", async () => {
      const dotted = Object.fromEntries(
        Object.entries(sampleApp()).map(([path, source]) => [
          path.replace(/^operations\//u, "operations/v1.0/"),
          path === "app.ts"
            ? source.replaceAll('"./operations/', '"./operations/v1.0/')
            : source,
        ])
      );
      const typedFrom = (call: string) =>
        Object.fromEntries(
          Object.entries(typed(call)).map(([path, source]) => [
            path,
            source.replace(
              '"../operations/sample.ts"',
              '"../operations/v1.0/sample.ts"'
            ),
          ])
        );
      await expect(
        Promise.all(
          [
            'APP.query("counter.hits", { name: "x" })',
            'APP.query("counter.hits", { name: 1 })',
          ].map(async (call) => await built({ ...dotted, ...typedFrom(call) }))
        )
      ).resolves.toStrictEqual([
        { ok: true, files: [], warned: [] },
        { ok: false, files: ["workflows/typed.ts"], warned: [] },
      ]);
    });

    it("import code the workflows share from a folder whose name has a dot", async () => {
      const files = checked("    return twice(21);");
      const workflow = files["workflows/checked.ts"] ?? "";
      await expect(
        built({
          ...sampleApp(),
          ...files,
          "workflows/checked.ts": `import { twice } from "./lib.v2/twice.ts";\n${workflow}`,
          "workflows/lib.v2/twice.ts":
            "export const twice = (value: number): number => value * 2;\n",
        })
      ).resolves.toStrictEqual({ ok: true, files: [], warned: [] });
    });

    it("never make a workflow of a file in a folder, dotted or not, even one that default-exports a workflow", async () => {
      const builder = await personApi("builder");
      const { id: app } = await builder.api.apps.create({ name: "Nested" });
      const nested = checked("    return 1;")["workflows/checked.ts"] ?? "";
      const { version } = await builder.api.apps.files.commit(
        app,
        {
          ...sampleApp(),
          ...checked("    return 1;"),
          "workflows/lib.v2/nested.ts": nested.replace(
            'workflow("checked"',
            'workflow("nested"'
          ),
        },
        "Nested"
      );
      await builder.api.apps.versions.setCurrent(app, version);
      await expect(
        Promise.all(
          ["checked", "nested"].map(
            async (workflow) =>
              await codeOf(builder.api.workflows.start(app, workflow))
          )
        )
      ).resolves.toStrictEqual(["ok", "workflow.not_found"]);
    });

    it("refuse, by name, anything under workflows/ that isn't workflow code", async () => {
      const strays = [
        "workflows/notes.md",
        "workflows/flow.json",
        "workflows/types.d.ts",
        // Never saved (a save refuses each), never workflow code.
        "workflows/.hidden/x.ts",
        "workflows/../app.ts",
        "workflows//x.ts",
      ];
      await expect(
        built({
          ...sampleApp(),
          ...checked("    return 1;"),
          ...Object.fromEntries(strays.map((path) => [path, "export {};\n"])),
        })
      ).resolves.toStrictEqual({
        ok: false,
        files: strays.toSorted((a, b) => (a < b ? -1 : 1)),
        warned: [],
      });
    });

    it("leave a stray declaration under operations/ out of a workflow's check, so it gives the workflows nothing", async () => {
      await expect(
        built({
          ...sampleApp(),
          "operations/types.d.ts": "declare var document: { title: string };\n",
          ...checked("    return document.title;"),
        })
      ).resolves.toMatchObject({
        ok: false,
        files: ["workflows/checked.ts"],
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
