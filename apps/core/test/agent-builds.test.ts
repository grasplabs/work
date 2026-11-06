import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  chatOf,
  codeResults,
  codeStep,
  openTestRun,
  says,
  setObjectEnv,
  testRunOpening,
  toolResults,
  toolStep,
  transcript,
} from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { appDefinition, definedWith, redefined } from "./app-definitions.ts";
import { published, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { defineNotes, notesCode, notesFiles } from "./notes-client-app.ts";
import { calledAs } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";
import { stoppingUltracite } from "./ultracite-stops.ts";

// `env.build` in a chat's code: the chat's agent building Apps for its
// person in a draft of its own, and repairing what its checks report.
// These tests start from the ways it can fail: the agent builds past what
// its person may do (an App they don't build, or any App for someone who
// doesn't build), or not at all for someone who does; a chat that read
// restricted data writes it into code others read; the agent writes a
// workflow into an App, whose calls no admin approves binding by binding;
// the agent's draft and a builder's commits overwrite each other; a draft
// that doesn't pass reaches the App; and a repair loop that never ends.

const idp = mockIdp();

/** 300 lines of constants, about 8,000 characters, as file `at` of a write has them. */
const lines = (at: number): string =>
  Array.from(
    { length: 300 },
    (_, line) => `export const value${at}x${line} = ${line};`
  ).join("\n");

/** File `at` of a write of rates, as the agent might write it: unformatted, a `var`, a body that only returns. */
const rates = (at: number): string =>
  `var rate${at} = ${at}\nexport const total${at} = (n: number) => { return n*rate${at} }\n`;

const appName = "Invoice desk";

/** The Ledger's definition, which its first version got: empty, as it has pages alone. */
const ledgerDefinition = appDefinition({ name: "Ledger" });

/** A screen whose button is restyled, which @shadcn/lint refuses. */
const restyled = `import { Button } from "@grasp-os/ui/components/button";

const Desk = () => (
  <main className="flex flex-col gap-4 p-6">
    <Button className="rounded-full">Approve</Button>
  </main>
);

export default Desk;
`;

/** The same screen with the button's own variant: what the lint asks for. */
const fixed = restyled.replace(
  '<Button className="rounded-full">',
  '<Button variant="outline">'
);

/** A workflow a builder wrote, with its tests. */
const intake = {
  "workflows/intake.ts": `import { type Json, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("intake", { params: {}, input: z.unknown() }, async (step, { input }) => {
  return await step.do("read", { description: "Read the invoice" }, async () => input as Json);
});
`,
  "workflows/intake.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./intake.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: { read: 1 }, expect: {} },
]);
`,
};

/** Code that finds the App the agent created, by its name, as `app`. */
const findApp = `const [app] = (await env.apps.list()).filter(({ name }) => name === ${JSON.stringify(appName)});`;

/** A diagnostic of the App's layout about `file`, as a write reports it. */
const layout = (file: string | null) => ({ file, rule: "server" });

/** What a code step returned, as JSON. */
const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Code that makes each call in turn: what it returned, or its message. */
const tryEach = (calls: Record<string, string>, before = ""): string =>
  `export default async (self, env) => {
    ${before}
    const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

/**
 * A chat of `role`'s person (a builder unless another is given) answered
 * by `replies`, with an App a builder released so the Apps collection is
 * there, and `grant`: a permission of the agent's own on it, which
 * building doesn't need but whose revocation ends what the agent does.
 */
const setUp = async (
  /** The model's replies, or those it gives about the released App. */
  replies: ProviderReply[] | ((existing: string) => ProviderReply[]),
  role: "admin" | "builder" | "user" = "builder"
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
  await published(existing);
  await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
  const others = { admin, builder };
  const person = role === "user" ? await signedInApi(idp, role) : others[role];
  const chat = await chatOf(
    person.userId,
    ...(typeof replies === "function" ? replies(existing) : replies)
  );
  const grant = async () => {
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read"],
      binding: "APP_LIBRARY",
    });
  };
  return { admin, builder, person, existing, chat, grant };
};

/**
 * Runs `during` with the object's code runs limited to a second, and the
 * calls to core's files `slowed` picks (every read, unless told otherwise)
 * two seconds slow: a call let in at once outlives its run while it waits
 * on them. Set back however it ends.
 */
const slowFilesDuring = async (
  stub: WorkspaceStub,
  during: () => Promise<void>,
  slowed: (method: string, key: unknown) => boolean = (method) =>
    method === "get"
): Promise<void> => {
  const { FILES: files } = env;
  const slow = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof property === "string" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (slowed(property, args[0])) {
            await scheduler.wait(2000);
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1000" });
  env.FILES = slow;
  try {
    await during();
  } finally {
    env.FILES = files;
    await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "" });
  }
};

/** A gate one read of core's files waits at (`gatedFilesDuring`). */
interface FilesGate {
  /** Set once the read reached the gate. */
  reached: boolean;
  /** The read goes on once this is set. */
  released: boolean;
}

/**
 * Runs `during` with the first read of core's files whose key `gated`
 * picks held at `gate` until it is released; every other read goes
 * straight through. Plain flags, each side polling the other's: the read
 * runs in another request's context, where a promise this test resolves
 * would never settle. Set back however it ends.
 */
const gatedFilesDuring = async (
  gated: (key: string) => boolean,
  gate: FilesGate,
  during: () => Promise<void>
): Promise<void> => {
  const { FILES: files } = env;
  const held = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "get" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          const [key] = args;
          if (!gate.reached && typeof key === "string" && gated(key)) {
            gate.reached = true;
            while (!gate.released) {
              // oxlint-disable-next-line no-await-in-loop -- polls the gate
              await scheduler.wait(20);
            }
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  env.FILES = held;
  try {
    await during();
  } finally {
    gate.released = true;
    env.FILES = files;
  }
};

/** The methods of the chat's calls refused because their run had ended. */
const endedRefusals = async (chatId: string): Promise<unknown[]> => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chatId &&
        detail.reason === "agent.run_ended"
    )
    .map(({ detail }) => detail.method);
};

/** The App the agent created, as the person's session finds it. */
const createdApp = async (
  api: Awaited<ReturnType<typeof signedInApi>>["api"]
) => {
  const listed = await api.apps.list();
  const app = listed.find(({ name }) => name === appName);
  if (app === undefined) {
    throw new Error("The agent created no App");
  }
  return app;
};

/** Code that writes `changes` into the draft of `app`. */
const writing = (changes: Record<string, string>): string =>
  `await env.build.write(app.id, ${JSON.stringify(changes)})`;

/** A write or a create refused for the workflows it would add, naming them. */
const noWorkflows = (issues: string[]) => ({
  message: appErrors.create("app.no_workflows").message,
  issues,
});

/** The model renames the Ledger in its AGENTS.md, with `editFile`. */
const editing = (app: string) =>
  toolStep("editFile", {
    app,
    path: "AGENTS.md",
    oldText: "# Ledger",
    newText: "# Ledger desk",
  });

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("keeps the draft apart from what a builder commits meanwhile, both ways", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const { builder, existing, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${ledger}
        await env.build.write(app.id, { "notes.md": "the agent's" });
        return await env.build.files(app.id);
      };`),
      says("Written."),
      codeStep(`export default async (self, env) => {
        ${ledger}
        const draft = await env.build.files(app.id);
        return { notes: draft.files["notes.md"], builder: draft.files["builder.md"] ?? null };
      };`),
      says("Still mine."),
    ]);
    await grant();

    await chat.ask("Add notes to the Ledger");
    // A builder commits meanwhile, the same file too.
    await builder.api.apps.files.commit(
      existing,
      { "notes.md": "the builder's", "builder.md": "mine" },
      "Mine"
    );
    await chat.ask("Are your notes still there?");

    const [draft, after] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(draft?.text)).toStrictEqual({
      base: 1,
      revision: 1,
      changed: ["notes.md"],
      files: {
        ...ledgerDefinition,
        "AGENTS.md": "# Ledger\n",
        "notes.md": "the agent's",
      },
    });
    expect(returned(after?.text)).toStrictEqual({
      notes: "the agent's",
      builder: null,
    });
    await expect(builder.api.apps.files.read(existing)).resolves.toStrictEqual({
      ...ledgerDefinition,
      "AGENTS.md": "# Ledger\n",
      "notes.md": "the builder's",
      "builder.md": "mine",
    });
    // The chat's page lists what the agent is changing, for its person only.
    // In the object itself: a refusal over RPC is also reported as
    // uncaught by the object, which fails the run.
    const listed = await runInDurableObject(chat.stub, (instance) => {
      const refused = (() => {
        try {
          instance.drafts(chat.chat.id, "someone-else");
          return "listed";
        } catch (error) {
          return agentErrors.codeOf(error);
        }
      })();
      return { own: instance.drafts(chat.chat.id, builder.userId), refused };
    });
    // The draft names the code step that wrote it, where the thread shows
    // its preview: the first, not the later one that only read it.
    const messages = await transcript(chat.stub, chat.chat.id);
    const steps = messages.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : []
    );
    expect(listed).toMatchObject({
      own: [
        { app: existing, base: 1, changed: ["notes.md"], callId: steps[0] },
      ],
      refused: "agent.chat_not_found",
    });
    expect(steps).toHaveLength(2);
  });

  it("answers every write with what fails, however often the same error comes back, and never locks the agent out", async () => {
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        const errors = [];
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const written = await env.build.write(app.id, { "screens/desk.tsx": ${JSON.stringify(restyled)} + "// " + attempt + "\\n" });
          errors.push(written.errors);
        }
        return errors;
      };`),
      says("The button is still restyled: I'm stuck on it."),
      codeStep(`export default async (self, env) => {
        ${findApp}
        const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
        const proposal = await env.build.propose(app.id, "A desk");
        return { errors: written.errors, version: proposal.version };
      };`),
      says("Fixed and proposed."),
    ]);
    await grant();

    await chat.ask("Build an invoice desk");
    await chat.ask("Try once more");

    const results = await codeResults(chat.stub, chat.chat.id);
    expect(returned(results[0]?.text)).toStrictEqual(
      Array.from({ length: 8 }, () => 1)
    );
    expect(returned(results[1]?.text)).toStrictEqual({ errors: 0, version: 1 });
  });

  it("answers a write tool with a type error and a lint error together, by file", async () => {
    const mistyped = restyled
      .replace(
        "const Desk = () => (",
        'const count: number = "seven";\n\nconst Desk = () => ('
      )
      .replace("    <Button", "    <p>{count}</p>\n    <Button");
    const { chat } = await setUp((app) => [
      toolStep("writeFile", { app, files: { "screens/desk.tsx": mistyped } }),
      says("Two things fail."),
    ]);

    await chat.ask("Add a desk screen to the Ledger");

    const [written] = await toolResults(chat.stub, chat.chat.id);
    expect(written?.isError).toBeFalsy();
    expect(returned(written?.text)).toMatchObject({
      errors: 2,
      diagnostics: [
        { file: "screens/desk.tsx", line: 3, rule: "TS2322" },
        { file: "screens/desk.tsx", line: 8, rule: "shadcn/no-restyle" },
      ],
      leftOut: 0,
    });
  });

  it("reports server code that throws as it registers as one error at its line, not one per screen", async () => {
    const operations = notesCode["server/notes.ts"] ?? "";
    const throwing = operations.replace(
      "\nexport const list = query({",
      '\nif (globalThis.Object === Object) throw new Error("No notes today");\nexport const list = query({'
    );
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        ${defineNotes}
        const written = await env.build.write(app.id, ${JSON.stringify({ ...notesCode, "server/notes.ts": throwing })});
        const proposal = await env.build.propose(app.id, "Notes");
        // Then an operations file that doesn't parse, the throw gone.
        const unparsed = await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": `${operations}\nexport const broken = query({ args: {` })});
        return {
          errors: written.errors,
          diagnostics: written.diagnostics.map(({ file, line, rule, severity, message }) => ({ file, line, rule, severity, says: message.includes("No notes today") })),
          version: proposal.version,
          unparsed: { errors: unparsed.errors, files: [...new Set(unparsed.diagnostics.map(({ file }) => file))] },
        };
      };`),
      says("The registration throws."),
    ]);
    await grant();

    await chat.ask("Build a notes App");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    // Where the throw is: its file, whatever line the tidied write puts it on.
    expect(returned(result?.text)).toMatchObject({
      errors: 1,
      diagnostics: [
        {
          file: "server/notes.ts",
          rule: "server",
          severity: "error",
          says: true,
        },
      ],
      version: null,
      // Its compile error, and nothing of the screens that import it.
      unparsed: { errors: 1, files: ["server/notes.ts"] },
    });
  });

  it("never proposes screens checked against stand-ins, though the sandbox ends one inspection and not the next", async () => {
    // The attack, under load: the sandbox ends one inspection of the
    // server code (its deadline), so the screens fall back to the
    // permissive stand-ins, while another inspection of the same code
    // registers and passes the server check. Proposed then, a screen with
    // calls that don't exist would be committed. The draft's builds
    // inspect once, for both, and a stand-in check never passes.
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${findApp}
        const proposal = await env.build.propose(app.id, "Notes");
        return {
          version: proposal.version,
          passed: proposal.check.passed,
          standIn: proposal.check.screens.standIn ?? false,
          server: proposal.check.server.status,
        };
      };`),
      says("It doesn't pass yet."),
    ]);
    await grant();
    const { id: app } = await person.api.apps.create({ name: appName });
    const chatId = chatIdSchema.parse(chat.chat.id);
    // Never inspected before, so no kept registration serves it.
    const files = {
      ...notesFiles,
      "server/notes.ts": `${notesFiles["server/notes.ts"] ?? ""}// ${crypto.randomUUID()}\n`,
    };
    await chat.stub.saveDraft(
      chatId,
      app,
      null,
      files,
      [],
      0,
      await openTestRun(chat.stub, chatId)
    );
    // The sandbox ends the first inspection only, as its deadline would.
    const { LOADER: loader } = env;
    let inspections = 0;
    const ending: WorkerLoader = {
      // Unnamed: an isolate of the sandbox's, whose code is read when it
      // starts, wrapped (shared/quiet-loader.ts) around its own main.
      get: (name, code) =>
        loader.get(
          name,
          name === null
            ? async () => {
                const worker = await code();
                if (!Object.hasOwn(worker.modules, "grasp-inspect.js")) {
                  return worker;
                }
                inspections += 1;
                return inspections === 1
                  ? {
                      ...worker,
                      modules: {
                        ...worker.modules,
                        "grasp-inspect.js":
                          'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class Inspect extends WorkerEntrypoint { manifest() { throw new Error("The sandbox ended it: past its deadline."); } }\n',
                      },
                    }
                  : worker;
              }
            : code
        ),
      load: (code) => loader.load(code),
    };
    try {
      env.LOADER = ending;
      await chat.ask("Propose the notes App");
    } finally {
      env.LOADER = loader;
    }

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect({ inspections, proposal: returned(result?.text) }).toStrictEqual({
      // One inspection, read by the screens and the server check alike.
      inspections: 1,
      proposal: {
        version: null,
        passed: false,
        standIn: true,
        server: "failed",
      },
    });
    await expect(person.api.apps.versions.list(app)).resolves.toStrictEqual([]);
  });

  it("caps the Apps a turn creates, counting none that wasn't created", async () => {
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
        // Refused as invalid: it creates nothing, and takes no App's place.
        const created = [await tried(async () => (await env.build.create({ name: "" })).name)];
        for (let count = 0; count < 4; count += 1) {
          created.push(await tried(async () => (await env.build.create({ name: ${JSON.stringify(appName)} + count })).name));
        }
        return created;
      };`),
      says("Done."),
    ]);
    await grant();

    await chat.ask("Build three desks");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual([
      appErrors.create("app.invalid").message,
      `${appName}0`,
      `${appName}1`,
      `${appName}2`,
      appErrors.create("app.creates_exhausted").message,
    ]);
  });

  it("changes a definition whose table holds records only as the records can follow, says what each change does to them, and records each change", async () => {
    // Version 1: the Notes App, current, with a note in its store, and an
    // answer its definition kept for a category it no longer has.
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        const definition = async () => JSON.parse((await env.build.files(app.id)).files["definition.json"]);
        const steps = {};
        // A field the released version has holds the note's value under
        // its name: refused, saying what to do instead.
        steps.released = await env.build.define(app.id, { op: "renameField", table: "notes", field: "title", name: "heading" });
        // A field the note lacks: checked against it, answered or not.
        const unanswered = await env.build.define(app.id, { op: "addField", table: "notes", name: "category", type: "v.string()" });
        steps.unanswered = unanswered.ok && unanswered.plan.checks;
        const answered = await env.build.define(app.id, { op: "changeField", table: "notes", field: "category", type: "v.string()", answer: "general" });
        steps.answered = answered.ok && answered.plan.checks;
        // An answer belongs to the version it is committed with: the
        // draft starts with none of the released version's, and keeps its
        // own through a rename of its field, which this draft added.
        steps.answers = (await definition()).answers.length;
        const renamed = await env.build.define(app.id, { op: "renameField", table: "notes", field: "category", name: "topic" });
        steps.renamed = renamed.ok && renamed.plan.checks;
        steps.afterRename = (await definition()).answers.length;
        const sensitive = await env.build.define(app.id, { op: "setAccess", table: "notes", access: { read: "owner", write: "owner" }, sensitive: true });
        steps.sensitive = sensitive.ok && sensitive.plan.sensitiveTables;
        return steps;
      };`),
      says("Defined."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await published(app);
    await release(
      builder,
      app,
      redefined(notesFiles, (definition) => ({
        ...definition,
        answers: [
          {
            table: definition.tables[0]?.id ?? "",
            field: definition.tables[0]?.fields[0]?.id ?? "",
            value: "Untitled",
          },
        ],
      }))
    );
    await calledAs(
      await builder.api.whoami(),
      app,
      { name: "notes.create", kind: "mutation" },
      { title: "Plan" }
    );
    await grant();

    await chat.ask("Give the notes a category");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const steps = z
      .object({
        released: z.object({ ok: z.literal(false), problem: z.string() }),
      })
      .loose()
      .parse(returned(result?.text));
    const events = await allEvents();
    const defined = events.filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chat.chat.id &&
        detail.method === "build.define"
    );
    expect({
      ...steps,
      released: steps.released.problem.includes(
        "Only a field this draft added renames"
      ),
      audited: defined.map(({ detail }) => [detail.op, detail.table]),
    }).toStrictEqual({
      released: true,
      unanswered: [{ table: "notes", field: "category", answered: false }],
      answered: [{ table: "notes", field: "category", answered: true }],
      answers: 1,
      renamed: [{ table: "notes", field: "topic", answered: true }],
      afterRename: 1,
      sensitive: ["notes"],
      audited: [
        ["renameField", "notes"],
        ["addField", "notes"],
        ["changeField", "notes"],
        ["renameField", "notes"],
        ["setAccess", "notes"],
      ],
    });
  });

  it("saves a new App's first write with the definition it gets, so its draft reads and previews whole", async () => {
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled.replace(' className="rounded-full"', "") })});
        const draft = await env.build.files(app.id);
        return { changed: written.changed.toSorted(), files: Object.keys(draft.files).toSorted() };
      };`),
      says("Written."),
    ]);
    await grant();

    await chat.ask("Build a desk");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const files = [
      "definition.json",
      "grasp.config.ts",
      "screens/desk.tsx",
      "server/schema.ts",
    ];
    expect(returned(result?.text)).toStrictEqual({ changed: files, files });
  });

  it("plans a definition change from the version people use, and asks again for an answer a skipped version had", async () => {
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        const indexed = await env.build.define(app.id, { op: "addIndex", table: "notes", name: "by_title", fields: ["title"] });
        const answered = await env.build.define(app.id, { op: "changeField", table: "notes", field: "category", type: "v.string()", answer: "general" });
        const definition = JSON.parse((await env.build.files(app.id)).files["definition.json"]);
        return { indexed: indexed.ok && indexed.plan.checks, answered: answered.ok && answered.plan.checks, answers: definition.answers.length };
      };`),
      says("Indexed."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await published(app);
    // Version 1 runs; version 2 adds a category its notes lack, answered,
    // and isn't current yet.
    await release(builder, app, notesFiles);
    await builder.api.apps.files.commit(
      app,
      definedWith(notesFiles, {
        op: "addField",
        table: "notes",
        name: "category",
        type: "v.string()",
        answer: "general",
      }),
      "Categories"
    );
    await grant();

    await chat.ask("Index the notes by title");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    // Released from version 1, the notes still lack the category: the
    // plan of that move checks them for it, unanswered, as version 2's
    // answer was version 2's; answered again, it is the draft's own.
    expect(returned(result?.text)).toStrictEqual({
      indexed: [{ table: "notes", field: "category", answered: false }],
      answered: [{ table: "notes", field: "category", answered: true }],
      answers: 1,
    });
  });

  it("renames no field a version that ran had, after a rollback to one without it too", async () => {
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        return await env.build.define(app.id, { op: "renameField", table: "notes", field: "nickname", name: "displayName" });
      };`),
      says("Renamed."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await published(app);
    // Version 2 ran with a nickname, which people may have filled in;
    // then the App was rolled back to version 1, which has none.
    await release(builder, app, notesFiles);
    await release(
      builder,
      app,
      definedWith(notesFiles, {
        op: "addField",
        table: "notes",
        name: "nickname",
        type: "v.string().optional()",
      })
    );
    await builder.api.apps.versions.setCurrent(app, 1);
    await grant();

    await chat.ask("Call the nickname a display name");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const refused = z
      .object({ ok: z.literal(false), problem: z.string() })
      .parse(returned(result?.text));
    expect(refused.problem).toContain("`notes.nickname` is in a version");
  });

  it("keeps a draft's answer for a field whose type the version people use doesn't have yet, whatever that version answered", async () => {
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        const changed = await env.build.define(app.id, { op: "changeField", table: "notes", field: "category", type: 'v.string().default("general")', answer: "general" });
        const indexed = await env.build.define(app.id, { op: "addIndex", table: "notes", name: "by_title", fields: ["title"] });
        const definition = JSON.parse((await env.build.files(app.id)).files["definition.json"]);
        return { changed: changed.ok, checks: indexed.ok && indexed.plan.checks, answers: definition.answers.map(({ value }) => value) };
      };`),
      says("Changed."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await published(app);
    // The version people use: a category that may be null, answered null.
    await release(
      builder,
      app,
      definedWith(notesFiles, {
        op: "addField",
        table: "notes",
        name: "category",
        type: "v.string().nullable().default(null)",
        answer: null,
      })
    );
    await grant();

    await chat.ask("Make the category required");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    // The draft's own answer stays through a later change: the notes
    // holding null need it to fit the category that can't be null.
    expect(returned(result?.text)).toStrictEqual({
      changed: true,
      checks: [{ table: "notes", field: "category", answered: true }],
      answers: ["general"],
    });
  });

  it("keeps no change that leaves a file as the base has it", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const { existing, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${ledger}
        const steps = [];
        steps.push((await env.build.write(app.id, { "notes.md": "new", "gone.md": null })).changed);
        // Back as the base has it, and a missing file deleted again.
        steps.push((await env.build.write(app.id, { "notes.md": null, "AGENTS.md": "# Ledger\\n", "gone.md": null })).changed);
        return steps;
      };`),
      says("Nothing changed."),
    ]);
    await grant();

    await chat.ask("Try some notes");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual([["notes.md"], []]);
    await expect(
      runInDurableObject(chat.stub, (instance) =>
        instance.draft(chatIdSchema.parse(chat.chat.id), existing)
      )
    ).resolves.toMatchObject({ changes: {}, revision: 2 });
    // The chat's page lists it as changing nothing.
    await expect(
      runInDurableObject(chat.stub, (instance) =>
        instance.drafts(chat.chat.id, chat.personId)
      )
    ).resolves.toMatchObject([{ app: existing, changed: [], revision: 2 }]);
  });

  it("builds for whoever builds, as them, with no permission of its own, and never past what they may do", async () => {
    const calls = tryEach({
      create: `(await env.build.create({ name: ${JSON.stringify(appName)} })).name`,
      call: `await env.build.call("app_refused", "count")`,
    });
    const resultOf = async (role: "admin" | "user", granted: boolean) => {
      const { chat, grant, person } = await setUp(
        [codeStep(calls), says("Done.")],
        role
      );
      if (granted) {
        await grant();
      }
      await chat.ask("Build something");
      const [result] = await codeResults(chat.stub, chat.chat.id);
      return { result: returned(result?.text), person };
    };
    const notFound = appErrors.create("app.not_found").message;

    // An admin in a new deployment, whose agent was granted nothing: the
    // App is made, theirs.
    const { result: made, person: admin } = await resultOf("admin", false);
    expect(made).toStrictEqual({ create: appName, call: notFound });
    const listed = await admin.api.apps.list();
    expect(
      listed
        .filter(({ owner }) => owner === admin.userId)
        .map(({ name, role }) => ({ name, role }))
    ).toStrictEqual([{ name: appName, role: "builder" }]);
    // Every permission the agent could hold reaches no further than its
    // person.
    await expect(resultOf("user", true)).resolves.toMatchObject({
      result: {
        create: roleErrors.create("role.forbidden").message,
        call: notFound,
      },
    });
  });

  it("changes only the Apps its person builds", async () => {
    const other = await signedInApi(idp, "builder");
    const { id: shared } = await other.api.apps.create({ name: "Shared" });
    await published(shared);
    const { id: unshared } = await other.api.apps.create({ name: "Other" });
    await published(unshared);
    const { person, chat, grant } = await setUp([
      codeStep(
        tryEach({
          shared: `await env.build.write(${JSON.stringify(shared)}, { "a.md": "a" })`,
          unshared: `await env.build.write(${JSON.stringify(unshared)}, { "a.md": "a" })`,
          sharedCall: `await env.build.call(${JSON.stringify(shared)}, "count")`,
          unsharedCall: `await env.build.call(${JSON.stringify(unshared)}, "count")`,
        })
      ),
      says("No."),
    ]);
    await grant();
    // They use the shared App's screens, but don't build it.
    await other.api.apps.members.add(shared, {
      type: "person",
      id: person.userId,
      role: "user",
    });

    await chat.ask("Change the other Apps");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      shared: roleErrors.create("role.forbidden").message,
      unshared: appErrors.create("app.not_found").message,
      sharedCall: roleErrors.create("role.forbidden").message,
      unsharedCall: appErrors.create("app.not_found").message,
    });
  });

  it("writes and edits a draft's files with tools of their own, editing only a file it read, as its person's own build", async () => {
    const { person, chat, existing } = await setUp((app) => [
      editing(app),
      toolStep("readFile", { app, path: "AGENTS.md" }),
      editing(app),
      toolStep("writeFile", {
        app,
        files: { "screens/desk.tsx": fixed, "notes.md": "Desk notes" },
      }),
      codeStep(`export default async (self, env) => {
        const { files } = await env.build.files(${JSON.stringify(app)});
        return { agents: files["AGENTS.md"], desk: files["screens/desk.tsx"], notes: files["notes.md"] };
      };`),
      says("Done."),
      // The next question's edit, which the person's discard overtakes.
      toolStep("editFile", {
        app,
        path: "AGENTS.md",
        oldText: "# Ledger desk",
        newText: "# Ledger book",
      }),
      says("It moved."),
    ]);

    await chat.ask("Name the desk, and add its screen");

    const steps = await toolResults(chat.stub, chat.chat.id);
    const [unread, read, edited, written, draft] = steps;
    const events = await allEvents();
    const writes = events.filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chat.chat.id &&
        detail.method === "build.write"
    );
    expect({
      unread: [unread?.tool, unread?.isError],
      unreadSays: unread?.text.includes("Read AGENTS.md with readFile"),
      read: [read?.tool, read?.isError, read?.text.includes("# Ledger")],
      edited: [edited?.tool, edited?.isError],
      written: [written?.tool, written?.isError],
      draft: returned(draft?.text),
      // Each write the person's own, by the agent acting for them.
      writes: writes.map(({ actor, detail }) => [actor, detail.outcome]),
    }).toStrictEqual({
      unread: ["editFile", true],
      unreadSays: true,
      read: ["readFile", false, true],
      edited: ["editFile", false],
      written: ["writeFile", false],
      draft: { agents: "# Ledger desk\n", desk: fixed, notes: "Desk notes" },
      writes: Array.from({ length: 2 }, () => [
        {
          type: "agent",
          agentId: chat.agent.agentId,
          onBehalfOf: person.userId,
        },
        "ok",
      ]),
    });

    // The person discards the draft while an edit has read it and not
    // yet written: the edit is refused, and the discard stands.
    const chatId = chatIdSchema.parse(chat.chat.id);
    // The edit's read of the App's files waits at this gate, after it read
    // the draft's revision and before it writes.
    const gate: FilesGate = { reached: false, released: false };
    await gatedFilesDuring(
      (key) => key.startsWith(`apps/${existing}/trees/`),
      gate,
      async () => {
        const reply = chat.ask("Call it the Ledger book");
        await vi.waitFor(
          () => {
            expect(gate.reached).toBeTruthy();
          },
          { timeout: 15_000, interval: 20 }
        );
        await chat.stub.discardDraft(chatId, person.userId, existing, {
          type: "person",
          userId: person.userId,
        });
        gate.released = true;
        await reply;
      }
    );
    const results = await toolResults(chat.stub, chatId);
    const overtaken = results.at(-1);
    const { changes } = await chat.stub.draft(chatId, existing);
    expect({
      overtaken: [overtaken?.tool, overtaken?.isError],
      conflict: overtaken?.text.includes(
        appErrors.create("app.conflict").message
      ),
      draft: changes,
    }).toStrictEqual({
      overtaken: ["editFile", true],
      conflict: true,
      draft: {},
    });
  });

  it("saves what it writes fixed and formatted, as Ultracite would, and reports what is left by file", async () => {
    // Formatted as oxfmt formats it, a `var` that never changes is a
    // `const` and a body that only returns is the arrow's: each fixes
    // itself. A loose `==` doesn't: oxlint's fix of it may change what the
    // code does, so it is reported, at its line.
    const { chat } = await setUp((app) => [
      toolStep("writeFile", {
        app,
        files: {
          "components/total.ts":
            "var rate = 2\nexport const total = (n: number) => { return n*rate }\nexport const same = (a: number, b: number) => a == b\n",
        },
      }),
      toolStep("readFile", { app, path: "components/total.ts" }),
      says("Written."),
    ]);

    await chat.ask("Add a total");

    const [written, read] = await toolResults(chat.stub, chat.chat.id);
    const { diagnostics } = z
      .object({
        diagnostics: z.array(
          z.object({
            file: z.string().nullable(),
            line: z.number().nullable(),
            rule: z.string(),
          })
        ),
      })
      .parse(returned(written?.text));
    expect({
      written: diagnostics
        .filter(({ file }) => file === "components/total.ts")
        .map(({ line, rule }) => ({ line, rule })),
      read: read?.text,
    }).toStrictEqual({
      written: [{ line: 3, rule: "eqeqeq" }],
      read: "Returned:\nconst rate = 2;\nexport const total = (n: number) => n * rate;\nexport const same = (a: number, b: number) => a == b;\n",
    });
  });

  it("tidies a write of more than one call of the lint takes, every file of it", async () => {
    // 50 files (as many as a write takes) of about 8,000 characters each:
    // more than one call's 250,000 (`ultraciteBatch`).
    const files = Object.fromEntries(
      Array.from({ length: 50 }, (_, at) => [
        `components/rate-${at}.ts`,
        `var rate${at} = ${at}\nexport const total${at} = (n: number) => { return n*rate${at} }\n${lines(at)}\n`,
      ])
    );
    const { chat } = await setUp((app) => [
      toolStep("writeFile", { app, files }),
      toolStep("readFile", { app, path: "components/rate-0.ts" }),
      toolStep("readFile", { app, path: "components/rate-49.ts" }),
      says("Written."),
    ]);

    await chat.ask("Add the rates");

    const [, first, last] = await toolResults(chat.stub, chat.chat.id);
    expect([first?.text, last?.text]).toStrictEqual([
      `Returned:\nconst rate0 = 0;\nexport const total0 = (n: number) => n * rate0;\n${lines(0)}\n`,
      `Returned:\nconst rate49 = 49;\nexport const total49 = (n: number) => n * rate49;\n${lines(49)}\n`,
    ]);
  });

  it("saves as written a file whose tidy stops at its isolate's limits by itself, and tidies the rest of the write", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 4 }, (_, at) => [
        `components/rate-${at}.ts`,
        rates(at),
      ])
    );
    const { chat } = await setUp((app) => [
      toolStep("writeFile", { app, files }),
      toolStep("readFile", { app, path: "components/rate-0.ts" }),
      toolStep("readFile", { app, path: "components/rate-3.ts" }),
      says("Written."),
    ]);

    const { LOADER: loader } = env;
    env.LOADER = stoppingUltracite(loader, {
      marker: "components/rate-0.ts",
      limit: "CPU time",
      fresh: true,
    });
    try {
      await chat.ask("Add the rates");
    } finally {
      env.LOADER = loader;
    }

    const [, stopped, tidied] = await toolResults(chat.stub, chat.chat.id);
    expect([stopped?.text, tidied?.text]).toStrictEqual([
      `Returned:\n${rates(0)}`,
      "Returned:\nconst rate3 = 3;\nexport const total3 = (n: number) => n * rate3;\n",
    ]);
  });

  it("searches a draft's files in a folder or all of them, ignoring case, up to a hundred lines and how many more", async () => {
    const many = Array.from({ length: 105 }, () => "an alpha line").join("\n");
    const { chat } = await setUp((app) => [
      toolStep("writeFile", {
        app,
        files: {
          "screens/a.md": "Alpha\nbeta\nalphabet",
          "screens/b.md": "ALPHA",
          "screensaver.md": "alpha",
          "server/x.ts": "alpha",
          "many.md": many,
        },
      }),
      toolStep("searchFiles", { app, text: "aLpHa", path: "screens" }),
      toolStep("searchFiles", { app, text: "an alpha" }),
      toolStep("readFile", { app, path: "screens/a.md" }),
      toolStep("readFile", { app, path: "many.md", fromLine: 104 }),
      says("Found."),
    ]);

    await chat.ask("Where does alpha come up?");

    const [, inFolder, everywhere, whole, end] = await toolResults(
      chat.stub,
      chat.chat.id
    );
    const capped = z
      .object({ matches: z.array(z.string()), leftOut: z.number() })
      .parse(returned(everywhere?.text));
    expect({
      inFolder: returned(inFolder?.text),
      capped: [capped.matches.length, capped.leftOut, capped.matches[0]],
      // A file as its own text, whole or in part, saying which part.
      whole: whole?.text,
      end: end?.text,
    }).toStrictEqual({
      // Not `screensaver.md`, which only starts like the folder.
      inFolder: {
        matches: [
          "screens/a.md:1:Alpha",
          "screens/a.md:3:alphabet",
          "screens/b.md:1:ALPHA",
        ],
      },
      capped: [100, 5, "many.md:1:an alpha line"],
      whole: "Returned:\nAlpha\nbeta\nalphabet",
      end: "Returned:\nan alpha line\nan alpha line\n\n[Lines 104 to 105 of 105. That is the end of the file.]",
    });
  });

  it("refuses a write of more files than one call takes in a few words, without its files", async () => {
    const content = "x".repeat(1000);
    const { chat, existing } = await setUp((app) => [
      toolStep("writeFile", {
        app,
        files: Object.fromEntries(
          Array.from({ length: 51 }, (_, at) => [`notes/${at}.md`, content])
        ),
      }),
      says("Too many."),
    ]);

    await chat.ask("Write fifty-one notes");

    const [refused] = await toolResults(chat.stub, chat.chat.id);
    const { changes } = await chat.stub.draft(
      chatIdSchema.parse(chat.chat.id),
      existing
    );
    expect({
      refused: refused?.isError,
      short: (refused?.text.length ?? Infinity) < 500,
      quotes: refused?.text.includes(content),
      says: refused?.text.startsWith("writeFile refused its input:"),
      changes,
    }).toStrictEqual({
      refused: true,
      short: true,
      quotes: false,
      says: true,
      changes: {},
    });
  });

  it("refuses a file write for someone who doesn't build the App, as it refuses their code", async () => {
    const { chat } = await setUp(
      (app) => [
        toolStep("writeFile", { app, files: { "a.md": "a" } }),
        codeStep(
          tryEach({
            write: `await env.build.write(${JSON.stringify(app)}, { "a.md": "a" })`,
          })
        ),
        says("No."),
      ],
      "user"
    );

    await chat.ask("Change the Ledger");

    const [tool, code] = await toolResults(chat.stub, chat.chat.id);
    const refused = appErrors.create("app.not_found").message;
    expect({
      tool: [tool?.isError, tool?.text.includes(refused)],
      code: returned(code?.text),
    }).toStrictEqual({
      tool: [true, true],
      code: { write: refused },
    });
  });

  it("writes no App code from a restricted chat, though building needs no grant", async () => {
    const calls = tryEach({
      create: `(await env.build.create({ name: "Refused" })).name`,
    });
    const { chat } = await setUp([codeStep(calls), says("No.")]);
    await runInDurableObject(chat.stub, (instance) =>
      instance.restrictChat(chatIdSchema.parse(chat.chat.id))
    );
    await chat.ask("Build something now");

    const [restricted] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(restricted?.text)).toStrictEqual({
      create: permissionErrors.create("permission.restricted").message,
    });
  });

  it("lands no draft write whose run ran out of time while it was under way, with no grant to revoke", async () => {
    const { chat, existing } = await setUp([]);
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          await env.build.write(${JSON.stringify(existing)}, { "screens/late.tsx": "export default () => null;" });
        };`),
      says("It ran out of time.")
    );

    // The write is let in at once, then waits on the App's files past its
    // run's end: refused as it commits.
    await slowFilesDuring(chat.stub, async () => {
      await chat.ask("Write it.");
    });

    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.write",
        ]);
      },
      { timeout: 15_000, interval: 100 }
    );
    await expect(
      chat.stub.draft(chatIdSchema.parse(chat.chat.id), existing)
    ).resolves.toStrictEqual({ base: null, changes: {}, revision: 0 });
  });

  it("lands no file write the person stopped while it was under way", async () => {
    const { chat, existing } = await setUp((app) => [
      toolStep("writeFile", {
        app,
        files: { "screens/late.tsx": "export default () => null;" },
      }),
      says("Never asked."),
    ]);

    // The write is let in at once, then waits on the App's files while the
    // person presses Stop: refused as it commits. The chat shows the
    // question, then the call under way.
    await slowFilesDuring(chat.stub, async () => {
      const reply = chat.ask("Write it.");
      await vi.waitFor(
        async () => {
          await expect(
            transcript(chat.stub, chat.chat.id)
          ).resolves.toHaveLength(2);
        },
        { timeout: 10_000 }
      );
      await chat.stub.cancel(chat.chat.id, chat.personId);
      await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    });

    // pi ends the aborted call with its own result; the run's record says
    // how the call itself ended.
    const [written] = await toolResults(chat.stub, chat.chat.id);
    expect([written?.tool, written?.isError, written?.text]).toStrictEqual([
      "writeFile",
      true,
      "Tool writeFile was aborted",
    ]);
    await vi.waitFor(async () => {
      await expect(
        runInDurableObject(chat.stub, (_instance, state) =>
          state.storage.sql
            .exec<{ status: string }>(
              "SELECT status FROM chat_code_runs WHERE chat_id = ?",
              chat.chat.id
            )
            .toArray()
            .map(({ status }) => status)
        )
      ).resolves.toStrictEqual(["cancelled"]);
    });
    // pi's result doesn't wait for the call: the write is refused as it
    // commits, after it.
    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.write",
        ]);
      },
      { timeout: 15_000, interval: 100 }
    );
    await expect(
      chat.stub.draft(chatIdSchema.parse(chat.chat.id), existing)
    ).resolves.toStrictEqual({ base: null, changes: {}, revision: 0 });
  });

  it("commits no proposal whose run ran out of time while it was checked", async () => {
    const { chat, builder, existing, grant } = await setUp([]);
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          await env.build.write(${JSON.stringify(existing)}, { "AGENTS.md": "# Ledger, again\\n" });
        };`),
      says("Written."),
      codeStep(`export default async (self, env) => {
          await env.build.propose(${JSON.stringify(existing)}, "Again");
        };`),
      says("It ran out of time.")
    );
    await grant();
    await chat.ask("Write it.");

    // Checked past its run's end: the commit after the check is refused.
    await slowFilesDuring(chat.stub, async () => {
      await chat.ask("Propose it.");
    });

    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.propose",
        ]);
      },
      { timeout: 30_000, interval: 200 }
    );
    const listed = await builder.api.apps.list();
    expect(listed.find(({ id }) => id === existing)?.pendingVersion).toBeNull();
  });

  it("commits no proposal whose run ran out of time while it stored the version's files, after its last check", async () => {
    const { chat, builder, existing, grant } = await setUp([]);
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          await env.build.write(${JSON.stringify(existing)}, { "AGENTS.md": "# Ledger, once more\\n" });
        };`),
      says("Written."),
      codeStep(`export default async (self, env) => {
          await env.build.propose(${JSON.stringify(existing)}, "Once more");
        };`),
      says("It ran out of time.")
    );
    await grant();
    await chat.ask("Write it.");

    // Only storing the version's tree is slow: the check and the
    // admission before it pass, and the run ends while the tree is stored.
    await slowFilesDuring(
      chat.stub,
      async () => {
        await chat.ask("Propose it.");
      },
      (method, key) =>
        method === "put" && typeof key === "string" && key.includes("/trees/")
    );

    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.propose",
        ]);
      },
      { timeout: 30_000, interval: 200 }
    );
    const listed = await builder.api.apps.list();
    expect(listed.find(({ id }) => id === existing)?.pendingVersion).toBeNull();
  });

  it("lands a draft write only over the revision it read", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(chatId, testRunOpening);
      return [
        instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0, run),
        // Another write read revision 0 too, and lost.
        instance.saveDraft(chatId, "app-1", null, { "a.md": "b" }, [], 0, run),
        instance.saveDraft(chatId, "app-1", null, { "b.md": "b" }, [], 1, run),
        instance.draft(chatId, "app-1"),
      ];
    });

    expect(saved).toStrictEqual([
      true,
      false,
      true,
      {
        base: null,
        changes: { "a.md": "a", "b.md": "b" },
        revision: 2,
      },
    ]);
  });

  it("keeps a draft's revisions going when its changes are all gone", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(chatId, testRunOpening);
      return [
        // A write reads revision 0; meanwhile another creates the draft and
        // writes its only change back as the base has it.
        instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0, run),
        instance.saveDraft(chatId, "app-1", null, {}, ["a.md"], 1, run),
        instance.draft(chatId, "app-1"),
        // The write that read revision 0 lands on nothing.
        instance.saveDraft(chatId, "app-1", null, { "b.md": "b" }, [], 0, run),
        // Nor once the draft is dropped, as a proposal drops it.
        instance.saveDraft(chatId, "app-1", null, { "c.md": "c" }, [], 2, run),
        instance.dropDraft(chatId, "app-1", { revision: 3 }),
        instance.saveDraft(chatId, "app-1", null, { "d.md": "d" }, [], 0, run),
        instance.saveDraft(chatId, "app-1", null, { "d.md": "d" }, [], 3, run),
        instance.draft(chatId, "app-1"),
      ];
    });

    expect(saved).toStrictEqual([
      true,
      true,
      { base: null, changes: {}, revision: 2 },
      false,
      true,
      true,
      false,
      false,
      { base: null, changes: {}, revision: 4 },
    ]);
  });

  it("lands no first write that read the draft before a discard", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(chatId, testRunOpening);
      return [
        // A first write reads revision 0; a discard runs before it lands.
        instance.dropDraft(chatId, "app-1", { runId: run }),
        instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0, run),
        instance.draft(chatId, "app-1"),
      ];
    });

    expect(saved).toStrictEqual([
      true,
      false,
      { base: null, changes: {}, revision: 1 },
    ]);
  });

  it("says a write's build couldn't run, proposes nothing then, and checks it at the next write once it can", async () => {
    const write = `export default async (self, env) => {
      ${findApp}
      const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
      const proposal = await env.build.propose(app.id, "A desk");
      return { errors: written.errors, notChecked: written.notChecked, version: proposal.version };
    };`;
    // Never built before, so no build of it is in the cache to serve.
    const unbuilt = `${fixed}\n// ${crypto.randomUUID()}\n`;
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": unbuilt })});
        const proposal = await env.build.propose(app.id, "A desk");
        return { errors: written.errors, notChecked: written.notChecked, version: proposal.version };
      };`),
      says("It couldn't be built now."),
      codeStep(write),
      says("Built."),
    ]);
    await grant();
    // The compiler can't start: no build can run now. (The build cache
    // being out is only a miss: the build runs, build-cache.ts.)
    const { LOADER: loader } = env;
    const down: WorkerLoader = {
      get: (name, code) => {
        if (name?.startsWith("compiler:") === true) {
          throw new Error("The compiler can't start");
        }
        return loader.get(name, code);
      },
      load: (code) => loader.load(code),
    };
    try {
      env.LOADER = down;
      await chat.ask("Build an invoice desk");
    } finally {
      env.LOADER = loader;
    }
    await chat.ask("Check it again");

    const results = await codeResults(chat.stub, chat.chat.id);
    // No error found, but not checked either: never proposed.
    expect(returned(results[0]?.text)).toStrictEqual({
      errors: 0,
      notChecked: {
        screens:
          "The build couldn't run now. It runs again when this is first used.",
      },
      version: null,
    });
    expect(returned(results[1]?.text)).toStrictEqual({
      errors: 0,
      notChecked: {},
      version: 1,
    });
  });

  it("says a write's build didn't finish within its bound, and proposes nothing", async () => {
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
        const proposal = await env.build.propose(app.id, "Fixed the button");
        return {
          written: { errors: written.errors, notChecked: written.notChecked },
          proposal: { version: proposal.version, passed: proposal.check.passed, screens: proposal.check.screens },
        };
      };`),
      says("It couldn't be built in time."),
    ]);
    await grant();
    // The build cache holds every build until the test ends: none finishes
    // within the bound, which the test shortens.
    const held = Promise.withResolvers<boolean>();
    const { FILES: files } = env;
    const holding = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "get" && typeof value === "function") {
          return async (key: string, ...rest: unknown[]): Promise<unknown> => {
            if (key.includes("-builds/")) {
              await held.promise;
            }
            return await Reflect.apply(value, target, [key, ...rest]);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    try {
      env.FILES = holding;
      env.BUILD_WAIT_MS = "50";
      await chat.ask("Build an invoice desk");
    } finally {
      env.FILES = files;
      delete env.BUILD_WAIT_MS;
      held.resolve(true);
    }

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const late =
      "The build didn't finish in time. It runs again when this is first used.";
    expect(returned(result?.text)).toStrictEqual({
      written: { errors: 0, notChecked: { screens: late, server: late } },
      proposal: {
        version: null,
        passed: false,
        screens: { status: "error", diagnostics: [], error: late },
      },
    });
  });

  it("proposes nothing that fails its checks", async () => {
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled })});
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
    // Calls an internal operation by its reference, typed as the seal's
    // generated references type it from the draft's own operations: what
    // it answers is typed, and a wrong call fails.
    const operations = `${(notesCode["server/notes.ts"] ?? "").replace(
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
  uses: [internal.notes.listAll],
  handler: async (ctx) => {
    const notes = await ctx.runQuery(internal.notes.listAll, {});
    return notes.map((note) => note.title);
  },
});
`;
    const wrongCall = operations.replace(
      "const notes = await ctx.runQuery(internal.notes.listAll, {});\n    return notes.map((note) => note.title);",
      "return await ctx.runQuery(internal.notes.missing, {});"
    );
    const sound = { ...notesCode, "server/notes.ts": operations };
    const mistyped = operations.replace(
      'import { noteFields } from "../values.ts";',
      'import { noteFields } from "../values.ts";\n\nexport const total: number = "seven";'
    );
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        ${defineNotes}
        // What each write says of the server code (its screens apart).
        const server = (written) => ({ errors: written.errors, diagnostics: written.diagnostics.filter(({ file }) => !file?.startsWith("screens/")).map(({ file, rule }) => ({ file, rule })) });
        const wrongCall = server(await env.build.write(app.id, ${JSON.stringify({ ...sound, "server/notes.ts": wrongCall })}));
        const sound = server(await env.build.write(app.id, ${JSON.stringify(sound)}));
        const mistyped = server(await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": mistyped })}));
        const proposal = await env.build.propose(app.id, "Notes");
        const leftover = server(await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": operations, "app/server.ts": "export const leftover = 1;\n", "app/exports.json": "{}" })}));
        return { wrongCall, sound, mistyped, proposed: { version: proposal.version, passed: proposal.check.passed, server: proposal.check.server.status }, leftover };
      };`),
      says("Checked."),
    ]);
    await grant();

    await chat.ask("Build a notes App");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toMatchObject({
      wrongCall: {
        errors: 1,
        diagnostics: [{ file: "server/notes.ts", rule: "TS2339" }],
      },
      sound: { errors: 0, diagnostics: [] },
      mistyped: {
        errors: 1,
        diagnostics: [{ file: "server/notes.ts", rule: "TS2322" }],
      },
      proposed: { version: null, passed: false, server: "failed" },
      leftover: {
        diagnostics: [layout("app/exports.json"), layout("app/server.ts")],
      },
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
      "screens/notes.tsx": `import { Badge } from "@grasp-os/ui/components/badge";\n${notesCode["screens/notes.tsx"] ?? ""}`,
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
        const statuses = ({ check }) => ({ passed: check.passed, screens: check.screens.status, server: check.server.status, lint: check.lint.status });
        return {
          written: { errors: written.errors, diagnostics: written.diagnostics.map(({ file, rule, severity }) => ({ file, rule, severity })) },
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
      written: {
        errors: 2,
        diagnostics: [
          {
            file: "screens/notes.tsx",
            rule: "no-unused-vars",
            severity: "error",
          },
          {
            file: "server/notes.ts",
            rule: "no-unused-vars",
            severity: "error",
          },
        ],
      },
      called: { ok: true, answer: "hi" },
      refused: {
        version: null,
        passed: false,
        screens: "ok",
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
        "screens/desk.tsx": fixed,
        "workflows/intake.workflow-tests.ts": "export default [];\n",
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
      added: noWorkflows([
        "workflows/outtake.ts",
        "workflows/outtake.workflow-tests.ts",
      ]),
      imported: noWorkflows(["workflows/lib/take.ts"]),
      // Refused as a whole, naming only the workflow's file: the screen
      // beside it didn't land either.
      alongside: noWorkflows(["workflows/intake.workflow-tests.ts"]),
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
      const run = instance.openCodeRun(chatId, testRunOpening);
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
        run
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
    ).resolves.toStrictEqual({
      ...ledgerDefinition,
      "AGENTS.md": "# Ledger\n\nWith notes.\n",
      "board.md": "the builder's",
      "notes.md": "the agent's",
    });
  });
});
