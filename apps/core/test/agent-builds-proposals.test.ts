import { appErrors } from "@grasp-os/shared/apps";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import {
  appName,
  createdApp,
  fixed,
  idp,
  intake,
  ledgerDefinition,
  noWorkflows,
  restyled,
  returned,
  setUp,
  writing,
} from "./agent-builds-harness.ts";
import { codeResults, codeStep, says, testRunOpening } from "./agent-chat.ts";
import { withFiles } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdpWith } from "./idp.ts";
import { defineNotes, notesCode } from "./notes-client-app.ts";

// `env.build` in a chat's code: the chat's agent building Apps for its
// person in a draft of its own, and repairing what its checks report.
// These tests start from the ways it can fail: the agent builds past what
// its person may do (an App they don't build, or any App for someone who
// doesn't build), or not at all for someone who does; a chat that read
// restricted data writes it into code others read; the agent writes a
// workflow into an App, whose calls no admin approves binding by binding;
// the agent's draft and a builder's commits overwrite each other; a draft
// that doesn't pass reaches the App; and a repair loop that never ends.

mockIdpWith(idp);

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("proposes nothing that fails its checks", async () => {
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "src/routes/index.tsx": restyled })});
        const proposal = await env.build.propose(app.id, "A desk");
        return {
          version: proposal.version,
          passed: proposal.check.passed,
          review: proposal.review,
          reviewUnavailable: proposal.reviewUnavailable,
        };
      };`),
      says("It doesn't pass yet."),
    ]);
    await grant();

    await chat.ask("Build an invoice desk");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      version: null,
      passed: false,
      review: null,
      reviewUnavailable: false,
    });
    const app = await createdApp(person.api);
    expect({
      app,
      versions: await person.api.apps.versions.list(app.id),
    }).toMatchObject({ app: { pendingVersion: null }, versions: [] });
  });

  it("type-checks a draft's server code as its seal would, with no preview open, and proposes nothing that fails it", async () => {
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
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        ${defineNotes}
        // What proposing says of the server code (its pages apart).
        const server = ({ check }) => ({ errors: check.server.diagnostics.filter(({ severity }) => severity === "error").length, diagnostics: check.server.diagnostics.map(({ file, rule }) => ({ file, rule })) });
        await env.build.write(app.id, ${JSON.stringify({ ...sound, "server/notes.ts": wrongCall })});
        const wrongCall = server(await env.build.propose(app.id, "Notes"));
        await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": mistyped })});
        const proposal = await env.build.propose(app.id, "Notes");
        const mistyped = server(proposal);
        return { wrongCall, mistyped, proposed: { version: proposal.version, passed: proposal.check.passed, server: proposal.check.server.status } };
      };`),
      says("Checked."),
      says("The wrong call fails."),
    ]);
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
      proposed: { version: null, passed: false, server: "failed" },
    });
    const app = await createdApp(person.api);
    await expect(person.api.apps.versions.list(app.id)).resolves.toStrictEqual(
      []
    );
  });

  it("builds and previews a draft with an unused import, and proposes it once the lint's finding is fixed", async () => {
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
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        ${defineNotes}
        const written = await env.build.write(app.id, ${JSON.stringify(unused)});
        const called = await env.build.call(app.id, "notes.echo", { word: "hi" });
        const refused = await env.build.propose(app.id, "Notes");
        const fixed = await env.build.write(app.id, ${JSON.stringify(notesCode)});
        const proposed = await env.build.propose(app.id, "Notes");
        const statuses = ({ check }) => ({ passed: check.passed, pages: check.pages.status, server: check.server.status, lint: check.lint.status });
        return {
          written: written.errors,
          lint: refused.check.lint.diagnostics.map(({ file, rule, severity }) => ({ file, rule, severity })),
          called,
          refused: { version: refused.version, ...statuses(refused) },
          fixed: fixed.errors,
          proposed: proposed.version,
        };
      };`),
      says("Proposed once it was clean."),
    ]);
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
        version: null,
        passed: false,
        pages: "ok",
        server: "ok",
        lint: "failed",
      },
      fixed: 0,
      proposed: 1,
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

  it("proposes no draft saved with a workflow change before its writes were refused, committing nothing", async () => {
    // The same attack through a draft saved before this release refused
    // the write: proposing commits the saved draft, not a write.
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const { builder, existing, chat, grant } = await setUp([
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
        return await refusal(async () => await env.build.propose(app.id, "Tampered intake"));
      };`),
      says("Done."),
    ]);
    await grant();
    const chatId = chatIdSchema.parse(chat.chat.id);
    await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(
        chatId,
        crypto.randomUUID(),
        testRunOpening
      );
      return instance.saveDraft(
        chatId,
        existing,
        1,
        {
          "workflows/intake.ts": "export default 1;\n",
          "notes.md": "the agent's",
        },
        [],
        0,
        { runId: run }
      );
    });

    await chat.ask("Propose the ledger's draft");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual(
      noWorkflows(["workflows/intake.ts"])
    );
    const versions = await builder.api.apps.versions.list(existing);
    expect(versions.map(({ version }) => version)).toStrictEqual([1]);
  });

  it("proposes over what builders committed since, and never undoes it", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const propose = `export default async (self, env) => {
      ${ledger}
      try {
        return (await env.build.propose(app.id, "Notes")).version;
      } catch (error) {
        return error.message;
      }
    };`;
    const { builder, existing, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${ledger}
        await env.build.write(app.id, { "notes.md": "the agent's", "AGENTS.md": "# Ledger, by the agent\\n" });
      };`),
      says("Written."),
      codeStep(propose),
      says("Someone changed it meanwhile."),
      codeStep(`export default async (self, env) => {
        ${ledger}
        await env.build.write(app.id, { "AGENTS.md": "# Ledger\\n\\nWith notes.\\n" });
      };`),
      codeStep(propose),
      says("Proposed."),
    ]);
    await grant();

    await chat.ask("Add notes to the Ledger");
    // A builder commits a change to a file the draft changes too, and one
    // to a file it doesn't.
    await release(builder, existing, {
      "AGENTS.md": "# Ledger\n\nWith notes.\n",
      "board.md": "the builder's",
    });
    await chat.ask("Propose it");
    await chat.ask("Take theirs, and propose again");

    const results = await codeResults(chat.stub, chat.chat.id);
    expect(results[1]?.text).toBe(
      `Returned:\n${appErrors.create("app.conflict").message}`
    );
    expect(returned(results[3]?.text)).toBe(3);
    await expect(
      builder.api.apps.files.read(existing, 3)
    ).resolves.toStrictEqual(
      withFiles(ledgerDefinition, {
        "AGENTS.md": "# Ledger\n\nWith notes.\n",
        "board.md": "the builder's",
        "notes.md": "the agent's",
      }).files
    );
  });
});
