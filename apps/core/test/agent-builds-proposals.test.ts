import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appKind } from "../src/apps.ts";
import { readDraft, saveDraft } from "../src/drafts.ts";
import {
  createdApp,
  fixed,
  idp,
  intake,
  noWorkflows,
  restyled,
  returned,
  setUp,
  writing,
  findApp,
} from "./agent-builds-harness.ts";
import { codeResults, codeStep, says } from "./agent-chat.ts";
import { mockIdpWith } from "./idp.ts";
import { defineNotes, notesCode } from "./notes-client-app.ts";

// `env.build` in a chat's code: the chat's agent building Apps for its
// person in the App's shared draft, and repairing what its checks report,
// and a builder publishing what it wrote.
// These tests start from the ways it can fail: the agent builds past what
// its person may do (an App they don't build, or any App for someone who
// doesn't build), or not at all for someone who does; a chat that read
// restricted data writes it into code others read; the agent writes a
// workflow into an App, whose calls no admin approves binding by binding;
// the agent's draft and a builder's commits overwrite each other; a draft
// that doesn't pass reaches the App; and a repair loop that never ends.

mockIdpWith(idp);

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("publishes nothing that fails its checks", async () => {
    const { person, chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        await env.build.write(app.id, ${JSON.stringify({ "src/routes/index.tsx": restyled })}, { revision: (await env.build.files(app.id)).revision });
        return { passed: (await env.build.check(app.id)).passed };
      };`),
        says("It doesn't pass yet."),
      ],
      "builder",
      true
    );
    await grant();

    await chat.ask("Build an invoice desk");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const app = await createdApp(person.api);
    const { revision } = await person.api.drafts.get({
      kind: "app",
      id: app.id,
    });
    expect({
      checked: returned(result?.text),
      published: await person.api.drafts
        .publish({ kind: "app", id: app.id }, revision)
        .then(() => "published")
        .catch((error: unknown) => appErrors.codeOf(error)),
      app: await person.api.apps.get(app.id),
      versions: await person.api.versions.list({ kind: "app", id: app.id }),
    }).toMatchObject({
      checked: { passed: false },
      published: "app.draft_failed",
      app: { currentVersion: null, liveLabel: null },
      versions: [],
    });
  });

  it("type-checks a draft's server code as its seal would, with no preview open, and passes nothing that fails it", async () => {
    // Calls an internal function by its reference, typed as the seal's
    // generated references type it from the draft's own functions: what
    // it answers is typed, and a wrong call fails.
    const serverCode = `${(notesCode["server/notes.ts"] ?? "").replace(
      "import { action, doc, mutation, query }",
      'import { internal } from "@server/_generated/internal";\nimport { action, doc, internalQuery, mutation, query }'
    )}
export const listAll = internalQuery({
  args: {},
  returns: v.array(doc("notes")),
  handler: async (ctx) => await ctx.db.query("notes").take(100),
});

export const titles = action({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const notes = await ctx.runQuery(internal.notes.listAll, {});
    return notes.map((note) => note.title);
  },
});
`;
    const wrongCall = serverCode.replace(
      "const notes = await ctx.runQuery(internal.notes.listAll, {});\n    return notes.map((note) => note.title);",
      "return await ctx.runQuery(internal.notes.missing, {});"
    );
    const sound = { ...notesCode, "server/notes.ts": serverCode };
    const mistyped = serverCode.replace(
      'import { noteFields } from "../values.ts";',
      'import { noteFields } from "../values.ts";\n\nexport const total: number = "seven";'
    );
    const { person, chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        ${defineNotes}
        // What the check says of the server code (its pages apart).
        const server = (check) => ({ errors: check.server.diagnostics.filter(({ severity }) => severity === "error").length, diagnostics: check.server.diagnostics.map(({ file, rule }) => ({ file, rule })) });
        await env.build.write(app.id, ${JSON.stringify({ ...sound, "server/notes.ts": wrongCall })}, { revision: (await env.build.files(app.id)).revision });
        const wrongCall = server(await env.build.check(app.id));
        await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": mistyped })}, { revision: (await env.build.files(app.id)).revision });
        const checked = await env.build.check(app.id);
        const mistyped = server(checked);
        return { wrongCall, mistyped, checked: { passed: checked.passed, server: checked.server.status } };
      };`),
        says("Checked."),
        says("The wrong call fails."),
      ],
      "builder",
      true
    );
    await grant();

    await chat.ask("Build a notes App");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toMatchObject({
      wrongCall: {
        errors: 1,
        diagnostics: [{ file: "server/notes.ts", rule: "TS2339" }],
      },
      mistyped: {
        errors: 1,
        diagnostics: [{ file: "server/notes.ts", rule: "TS2322" }],
      },
      checked: { passed: false, server: "failed" },
    });
    const app = await createdApp(person.api);
    await expect(
      person.api.versions.list({ kind: "app", id: app.id })
    ).resolves.toStrictEqual([]);
  });

  it("builds and previews a draft with an unused import, and passes it once the lint's finding is fixed", async () => {
    // An unused name is a lint finding, never a type error: mid-edit, the
    // draft still builds and its preview still runs.
    const unused = {
      ...notesCode,
      "server/notes.ts": (notesCode["server/notes.ts"] ?? "").replace(
        'import { noteFields } from "../values.ts";',
        'import { noteFields } from "../values.ts";\nimport { internal } from "@server/_generated/internal";'
      ),
      "src/routes/index.tsx": `import { Badge } from "@grasp-os/ui/components/badge";\n${notesCode["src/routes/index.tsx"] ?? ""}`,
    };
    const { chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        ${defineNotes}
        const written = await env.build.write(app.id, ${JSON.stringify(unused)}, { revision: (await env.build.files(app.id)).revision });
        const called = await env.build.call(app.id, "notes.echo", { word: "hi" });
        const refused = await env.build.check(app.id);
        const fixed = await env.build.write(app.id, ${JSON.stringify(notesCode)}, { revision: (await env.build.files(app.id)).revision });
        const passed = await env.build.check(app.id);
        const statuses = (check) => ({ passed: check.passed, pages: check.pages.status, server: check.server.status, lint: check.lint.status });
        return {
          written: written.errors,
          lint: refused.lint.diagnostics.map(({ file, rule, severity }) => ({ file, rule, severity })),
          called,
          refused: statuses(refused),
          fixed: fixed.errors,
          passed: passed.passed,
        };
      };`),
        says("It passes once it was clean."),
      ],
      "builder",
      true
    );
    await grant();

    await chat.ask("Build a notes App");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      // It compiles: the write says nothing fails.
      written: 0,
      lint: [
        {
          file: "server/notes.ts",
          rule: "no-unused-vars",
          severity: "error",
        },
        {
          file: "src/routes/index.tsx",
          rule: "no-unused-vars",
          severity: "error",
        },
      ],
      called: { ok: true, answer: "hi" },
      refused: {
        passed: false,
        pages: "ok",
        server: "ok",
        lint: "failed",
      },
      fixed: 0,
      passed: true,
    });
  });

  it("writes no workflow into an App, whatever the path or the company it keeps", async () => {
    // The attack: code the agent writes under workflows/ would run as the
    // App's own workflow, its calls read from the code rather than from a
    // definition an admin approves binding by binding.
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const calls = {
      added: writing(
        Object.fromEntries(
          Object.entries(intake).map(([path, source]) => [
            path.replace("intake", "outtake"),
            source.replaceAll("intake", "outtake"),
          ])
        )
      ),
      imported: writing({
        "workflows/lib/take.ts": "export const take = 1;\n",
      }),
      alongside: writing({
        "src/routes/index.tsx": fixed,
        "workflows/intake.json": "{}\n",
      }),
    };
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${ledger}
        const refusal = async (call) => {
          try {
            await call();
            return "done";
          } catch (error) {
            return { message: error.message, issues: error.details?.issues ?? null };
          }
        };
        const results = {};
        ${Object.entries(calls)
          .map(
            ([name, call]) =>
              `results[${JSON.stringify(name)}] = await refusal(async () => ${call});`
          )
          .join("\n        ")}
        results.unchanged = (await env.build.files(app.id)).changed;
        return results;
      };`),
      says("Done."),
    ]);
    await grant();

    await chat.ask("Add an intake workflow to the ledger");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      added: noWorkflows(["workflows/outtake.ts"]),
      imported: noWorkflows(["workflows/lib/take.ts"]),
      // Refused as a whole, naming only the workflow's file: the page
      // beside it didn't land either.
      alongside: noWorkflows(["workflows/intake.json"]),
      unchanged: [],
    });
  });

  it("publishes no draft saved with a workflow change before its writes were refused, committing nothing", async () => {
    // The same attack through a draft saved before this release refused
    // the write: publishing commits the saved draft, not a write.
    const { builder, existing } = await setUp([]);
    const draft = await readDraft(env, { kind: "app", id: existing });
    await saveDraft(
      env,
      appKind,

      existing,
      { ...draft, base: 1 },
      {
        changes: {
          "workflows/intake.ts": "export default 1;\n",
          "notes.md": "the agent's",
        },
        unchanged: [],
      },
      {
        by: {
          userId: builder.userId,
          role: "builder" as const,
          teams: [],
          staff: false,
          actor: actorOf({ userId: builder.userId, staff: false }),
        },
        detail: {},
      }
    );
    const { revision } = await builder.api.drafts.get({
      kind: "app",
      id: existing,
    });

    const refused = await builder.api.drafts
      .publish({ kind: "app", id: existing }, revision)
      .then(() => "published")
      .catch((error: unknown) => appErrors.codeOf(error));

    expect(refused).toBe("app.no_workflows");
    const versions = await builder.api.versions.list({
      kind: "app",
      id: existing,
    });
    expect(versions.map(({ version }) => version)).toStrictEqual([1]);
  });
});
