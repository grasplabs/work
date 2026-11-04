import { compilerVersion } from "@grasp-os/compiler";
import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import type { VersionReview } from "@grasp-os/shared/apps";
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
import { outlook, published, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { notesFiles } from "./notes-client-app.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, hitCall, workflowFiles } from "./workflow-apps.ts";

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

const appName = "Invoice desk";

/** A screen whose button is restyled, which @shadcn/lint refuses. */
const restyled = `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button className="rounded-full">Approve</Button>
    </main>
  );
}
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

/** Creates the App and writes the restyled screen: the write says what fails. */
const firstTry = `export default async (self, env) => {
  const app = await env.build.create({ name: ${JSON.stringify(appName)} });
  const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled })});
  return {
    errors: written.errors,
    found: written.diagnostics.map(({ file, line, rule }) => ({ file, line, rule })),
  };
};`;

/** Writes the fixed screen: nothing fails. */
const repair = `export default async (self, env) => {
  ${findApp}
  const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
  const draft = await env.build.files(app.id);
  return { ...written, screen: draft.files["screens/desk.tsx"] };
};`;

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

/** The invoices workflow, with a limit and, when `booked`, a booking. */
const invoices = (limit: number, booked: boolean) => ({
  "workflows/invoices.ts": `import { money, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "invoices",
  { input: z.unknown(), params: { limit: money({ label: "Limit", currency: "EUR", default: ${limit} }) } },
  async (step, { params }) => {
const limit = await step.do("limit", { description: "Read the limit" }, async () => params.limit);
${booked ? `await step.do("book", { description: "Book it", sideEffect: true, input: { limit } }, async () => 1);` : ""}
return limit;
  }
);
`,
  "workflows/invoices.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./invoices.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { limit: 1, book: 1 }, expect: { output: 1 } }]);
`,
});

/** A workflow whose first step calls a helper, the second a connection. */
const digest = (to: string) => ({
  "workflows/lib/total.ts": "export const total = (n: number) => n + 1;\n",
  "workflows/digest.ts": `import { type Json, workflow, z } from "@grasp-os/sdk/workflow";

import { total } from "./lib/total.ts";

export default workflow("digest", { params: {}, input: z.unknown() }, async (step, { env }) => {
  const sum = await step.do("sum", { description: "Sum" }, async () => total(1));
  await step.do("mail", { description: "Mail" }, async () => (await env.MAIL.call("mail.send", ${JSON.stringify(to)})) as Json);
  return sum;
});
`,
  "workflows/digest.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./digest.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { sum: 2, mail: 1 }, expect: { output: 2 } }]);
`,
});

/**
 * The weekly workflow, run by `triggers`; with `nested`, its step called
 * from a function of its own, which the step list can't read.
 */
const weekly = (
  triggers: string,
  nested = false,
  acting = false
): Record<string, string> => ({
  "workflows/weekly.ts": `import { schedule, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "weekly",
  { params: { every: schedule({ label: "Runs", default: "0 8 * * 1" }) }, triggers: ${triggers} },
  async (step) => {
    ${nested ? 'const run = async () => await step.do("report", { description: "Write the report" }, async () => "sent");\n    return await run();' : `return await step.do("report", { description: "Write the report"${acting ? ', sideEffect: true, input: "report"' : ""} }, async () => "sent");`}
  }
);
`,
  "workflows/weekly.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./weekly.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { report: "sent" }, expect: { output: "sent" } }]);
`,
});

/** Code that writes `changes` into the draft of `app`. */
const writing = (changes: Record<string, string>): string =>
  `await env.build.write(app.id, ${JSON.stringify(changes)})`;

/** A write or a create refused for the workflows it would add, naming them. */
const noWorkflows = (issues: string[]) => ({
  message: appErrors.create("app.no_workflows").message,
  issues,
});

/** Each workflow's changed steps, by name, as a review lists them. */
const changedSteps = (workflows: VersionReview["workflows"]) =>
  workflows.map(({ steps }) =>
    steps?.map(({ name, change, sharedCode }) => ({ name, change, sharedCode }))
  );

/** The model renames the Ledger in its AGENTS.md, with `editFile`. */
const editing = (app: string) =>
  toolStep("editFile", {
    app,
    path: "AGENTS.md",
    oldText: "# Ledger",
    newText: "# Ledger desk",
  });

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("repairs a restyled button without the person, in a draft nobody else sees, and puts nothing live", async () => {
    const { builder, person, chat, grant } = await setUp([
      codeStep(firstTry),
      codeStep(repair),
      says("The invoice desk passes its checks."),
    ]);
    await grant();

    // One question: every step after it is the agent's own.
    const answer = await chat.ask("Build an invoice desk for invoices@");

    expect(answer.outcome).toBe("answered");
    const results = await codeResults(chat.stub, chat.chat.id);
    expect(results.map(({ isError }) => isError)).toStrictEqual([false, false]);
    const [first, second] = results;
    expect(returned(first?.text)).toStrictEqual({
      errors: 1,
      found: [{ file: "screens/desk.tsx", line: 6, rule: "shadcn/no-restyle" }],
    });
    expect(returned(second?.text)).toStrictEqual({
      base: null,
      changed: ["screens/desk.tsx"],
      errors: 0,
      warnings: 0,
      diagnostics: [],
      leftOut: 0,
      notChecked: {},
      screen: fixed,
    });

    // The App is the person's, and has nothing of the draft: no version,
    // nothing current, and no files for its builders.
    const app = await createdApp(person.api);
    expect({
      app,
      versions: await builder.api.apps.versions.list(app.id),
      files: await builder.api.apps.files.read(app.id),
    }).toMatchObject({
      app: { owner: person.userId, currentVersion: null, pendingVersion: null },
      versions: [],
      files: {},
    });
    // Created by the agent acting for the person, as the audit log says.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        const created = events.find(
          ({ action, target }) =>
            action === "app.created" && target?.id === app.id
        );
        expect(created?.actor).toStrictEqual({
          type: "agent",
          agentId: chat.agent.agentId,
          onBehalfOf: person.userId,
        });
      },
      { timeout: 10_000, interval: 50 }
    );
  });

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
      files: { "AGENTS.md": "# Ledger\n", "notes.md": "the agent's" },
    });
    expect(returned(after?.text)).toStrictEqual({
      notes: "the agent's",
      builder: null,
    });
    await expect(builder.api.apps.files.read(existing)).resolves.toStrictEqual({
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
    const mistyped = restyled.replace(
      "export default function Desk() {",
      'const count: number = "seven";\n\nexport default function Desk() {\n  void count;'
    );
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
        { file: "screens/desk.tsx", line: 9, rule: "shadcn/no-restyle" },
      ],
      leftOut: 0,
    });
  });

  it("reports server code that throws as it registers as one error at its line, not one per screen", async () => {
    const throwing = (notesFiles["app.ts"] ?? "").replace(
      "\nexport default app({",
      'if (schema !== undefined) throw new Error("No notes today");\nexport default app({'
    );
    const { chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        const written = await env.build.write(app.id, ${JSON.stringify({ ...notesFiles, "app.ts": throwing })});
        const proposal = await env.build.propose(app.id, "Notes");
        // Then an operations file that doesn't parse, its registration fixed.
        const unparsed = await env.build.write(app.id, ${JSON.stringify({ "app.ts": notesFiles["app.ts"], "server/notes.ts": `${notesFiles["server/notes.ts"] ?? ""}\nexport const broken = query({ args: {` })});
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
    expect(returned(result?.text)).toStrictEqual({
      errors: 1,
      diagnostics: [
        {
          file: "app.ts",
          line: 3,
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
      "app.ts": `${notesFiles["app.ts"] ?? ""}// ${crypto.randomUUID()}\n`,
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
    // Nor does the chat's page list it.
    await expect(
      runInDurableObject(chat.stub, (instance) =>
        instance.drafts(chat.chat.id, chat.personId)
      )
    ).resolves.toStrictEqual([]);
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
    // Formatted as Prettier formats it, a `var` that never changes is a
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
    // person presses Stop: refused as it commits.
    await slowFilesDuring(chat.stub, async () => {
      const reply = chat.ask("Write it.");
      await vi.waitFor(
        async () => {
          await expect(
            transcript(chat.stub, chat.chat.id)
          ).resolves.toHaveLength(3);
        },
        { timeout: 10_000 }
      );
      await chat.stub.cancel(chat.chat.id, chat.personId);
      await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    });

    const [written] = await toolResults(chat.stub, chat.chat.id);
    expect({
      written: [written?.tool, written?.isError],
      cancelled: written?.text.startsWith("Error (cancelled)"),
      draft: await chat.stub.draft(chatIdSchema.parse(chat.chat.id), existing),
    }).toStrictEqual({
      written: ["writeFile", true],
      cancelled: true,
      draft: { base: null, changes: {}, revision: 0 },
    });
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
      written: { errors: 0, notChecked: { screens: late } },
      proposal: {
        version: null,
        passed: false,
        screens: { status: "error", diagnostics: [], error: late },
      },
    });
  });

  it("proposes a passing draft for review, and nothing goes live until a builder makes it current", async () => {
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
        const permission = await env.build.requestPermission(app.id, {
          object: { type: "connection", connectionId: "connection-outlook" },
          actions: ["mail.list"],
          binding: "INVOICES",
        });
        const proposal = await env.build.propose(app.id, "An invoice desk for invoices@");
        const tried = async (call) => { try { await call(); return "done"; } catch (error) { return error.message; } };
        return {
          permission: permission.status,
          version: proposal.version,
          passed: proposal.check.passed,
          review: proposal.review,
          reviewUnavailable: proposal.reviewUnavailable,
          // No way to make it current, under any name.
          setCurrent: await tried(() => env.build.setCurrent(app.id, proposal.version)),
          appsSetCurrent: await tried(() => env.apps.setCurrent(app.id, proposal.version)),
          left: (await env.build.files(app.id)).changed,
        };
      };`),
      says("Proposed: a builder makes it current."),
    ]);
    await grant();

    await chat.ask("Build an invoice desk for invoices@");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const app = await createdApp(person.api);
    const review = await person.api.apps.versions.review(app.id, 1);
    const noSetCurrent = 'The RPC receiver does not implement "setCurrent".';
    expect(returned(result?.text)).toStrictEqual({
      permission: "requested",
      version: 1,
      passed: true,
      review: structuredClone(review),
      reviewUnavailable: false,
      // Neither API has such a method: the call reaches nothing.
      setCurrent: noSetCurrent,
      appsSetCurrent: noSetCurrent,
      left: [],
    });
    const agent = {
      type: "agent",
      agentId: chat.agent.agentId,
      onBehalfOf: person.userId,
    };
    const proposer = {
      ...agent,
      workspaceId: chat.id,
      chatId: chat.chat.id,
    };
    expect(review).toMatchObject({
      version: {
        version: 1,
        parent: null,
        author: person.userId,
        proposedBy: proposer,
      },
      // The chat's title, for the person the agent acted for.
      proposedBy: { ...proposer, ownChat: true, chatTitle: "Questions" },
      current: null,
      files: [{ path: "screens/desk.tsx", change: "added" }],
      server: null,
      serverFiles: [],
      workflows: [],
      permissions: [
        {
          subject: { type: "app", appId: app.id },
          binding: "INVOICES",
          status: "requested",
          requestedBy: person.userId,
          requestedVia: proposer,
        },
      ],
      grants: [],
      tests: { status: "none", failures: [] },
    });
    // Pending, not live, until a builder makes it current.
    await expect(createdApp(person.api)).resolves.toMatchObject({
      currentVersion: null,
      pendingVersion: 1,
    });
    await expect(
      person.api.apps.versions.setCurrent(app.id, 1)
    ).resolves.toMatchObject({ currentVersion: 1, pendingVersion: null });
    // Committed and proposed by the agent, acting for the person.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        const actors = Object.fromEntries(
          events
            .filter(({ target }) => target?.id === app.id)
            .map(({ action, actor }) => [action, actor])
        );
        expect(actors).toMatchObject({
          "app.committed": agent,
          "app.version.proposed": agent,
          "app.version.current": { type: "person", userId: person.userId },
        });
      },
      { timeout: 10_000, interval: 50 }
    );
  });

  it("stands by a proposal once committed, when what follows it fails", async () => {
    const { builder, existing, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
        const proposal = await env.build.propose(app.id, "A desk");
        return {
          version: proposal.version,
          review: proposal.review,
          reviewUnavailable: proposal.reviewUnavailable,
          left: (await env.build.files(app.id)).changed,
        };
      };`),
      says("Proposed; its review comes later."),
    ]);
    await grant();
    // A workflow its builder wrote, whose tests the check runs.
    await release(builder, existing, intake);
    // After the commit, keeping the check's tests and reading them for the
    // review fail: the proposal is made all the same.
    const { FILES: files } = env;
    const failing = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (
          (property === "get" || property === "put") &&
          typeof value === "function"
        ) {
          return (key: string, ...rest: unknown[]): unknown =>
            key.includes("/tests/")
              ? Promise.reject(new Error("The test results can't be reached"))
              : Reflect.apply(value, target, [key, ...rest]);
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    try {
      env.FILES = failing;
      await chat.ask("Build an invoice desk");
    } finally {
      env.FILES = files;
    }

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      version: 3,
      review: null,
      reviewUnavailable: true,
      left: [],
    });
    // Pending, and its review reads once the test results can be reached.
    const listed = await builder.api.apps.list();
    const app = listed.find(({ id }) => id === existing);
    expect(app).toMatchObject({ currentVersion: 2, pendingVersion: 3 });
    await expect(
      builder.api.apps.versions.review(existing, 3)
    ).resolves.toMatchObject({ tests: { status: "passed" } });
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
    const operations = `${(notesFiles["server/notes.ts"] ?? "").replace(
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
    const sound = { ...notesFiles, "server/notes.ts": operations };
    const mistyped = operations.replace(
      'import { noteFields } from "../schema.ts";',
      'import { noteFields } from "../schema.ts";\n\nexport const total: number = "seven";'
    );
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        // What each write says of the server code (its screens apart).
        const server = (written) => ({ errors: written.errors, diagnostics: written.diagnostics.filter(({ file }) => !file?.startsWith("screens/")).map(({ file, rule }) => ({ file, rule })) });
        const wrongCall = server(await env.build.write(app.id, ${JSON.stringify({ ...sound, "server/notes.ts": wrongCall })}));
        const sound = server(await env.build.write(app.id, ${JSON.stringify(sound)}));
        const mistyped = server(await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": mistyped })}));
        const proposal = await env.build.propose(app.id, "Notes");
        const leftover = server(await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": operations, "app/server.ts": "export {};\n", "app/exports.json": "{}" })}));
        const unregistered = server(await env.build.write(app.id, ${JSON.stringify({ "app/server.ts": null, "app/exports.json": null, "app.ts": null })}));
        return { wrongCall, sound, mistyped, proposed: { version: proposal.version, passed: proposal.check.passed, server: proposal.check.server.status }, leftover, unregistered };
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
      unregistered: { diagnostics: [layout(null)] },
    });
    const app = await createdApp(person.api);
    await expect(person.api.apps.versions.list(app.id)).resolves.toStrictEqual(
      []
    );
  });

  it("writes no workflow into an App, whatever the path, the company it keeps or the blueprint it comes from, and changes none a builder wrote but to delete it", async () => {
    // The attack: code the agent writes under workflows/ would run as the
    // App's own workflow, its calls read from the code rather than from a
    // definition an admin approves binding by binding. A builder's
    // workflow is there for the agent to tamper with, and a blueprint
    // marked from that version for the agent to copy it from.
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
      changed: writing({ "workflows/intake.ts": "export default 1;\n" }),
      imported: writing({
        "workflows/lib/take.ts": "export const take = 1;\n",
      }),
      alongside: writing({
        "screens/desk.tsx": fixed,
        "workflows/intake.workflow-tests.ts": "export default [];\n",
      }),
      copied: `await env.build.createFromBlueprint((await env.build.blueprints()).find(({ name }) => name === "Ledger").id, { name: "Ledger copy" })`,
    };
    const { builder, person, existing, chat, grant } = await setUp([
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
        results.deleted = (await env.build.write(app.id, ${JSON.stringify({ "workflows/intake.ts": null, "workflows/intake.workflow-tests.ts": null })})).changed;
        results.proposed = (await env.build.propose(app.id, "No intake")).version;
        return results;
      };`),
      says("Done."),
    ]);
    await grant();
    await release(builder, existing, intake);
    await builder.api.apps.blueprints.mark(existing, 2);

    await chat.ask("Add an intake workflow to the ledger");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      added: noWorkflows([
        "workflows/outtake.ts",
        "workflows/outtake.workflow-tests.ts",
      ]),
      changed: noWorkflows(["workflows/intake.ts"]),
      imported: noWorkflows(["workflows/lib/take.ts"]),
      // Refused as a whole, naming only the workflow's file: the screen
      // beside it didn't land either.
      alongside: noWorkflows(["workflows/intake.workflow-tests.ts"]),
      copied: noWorkflows([
        "workflows/intake.ts",
        "workflows/intake.workflow-tests.ts",
      ]),
      unchanged: [],
      deleted: ["workflows/intake.ts", "workflows/intake.workflow-tests.ts"],
      proposed: 3,
    });
    // What the version holds is the builder's code less what was deleted,
    // and no App was created from the blueprint.
    const listed = await person.api.apps.list();
    expect({
      files: Object.keys(
        await builder.api.apps.files.read(existing, 3)
      ).toSorted(),
      copies: listed.filter(({ name }) => name === "Ledger copy"),
    }).toStrictEqual({ files: ["AGENTS.md"], copies: [] });
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
    await release(builder, existing, intake);
    const chatId = chatIdSchema.parse(chat.chat.id);
    await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(chatId, testRunOpening);
      return instance.saveDraft(
        chatId,
        existing,
        2,
        {
          "workflows/intake.ts": "export default 1;\n",
          "workflows/intake.workflow-tests.ts": null,
          "notes.md": "the agent's",
        },
        [],
        0,
        run
      );
    });

    await chat.ask("Propose the ledger's draft");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    // Named alone: deleting the builder's tests is no workflow change.
    expect(returned(result?.text)).toStrictEqual(
      noWorkflows(["workflows/intake.ts"])
    );
    const versions = await builder.api.apps.versions.list(existing);
    expect(
      versions.map(({ version }) => version).toSorted((a, b) => a - b)
    ).toStrictEqual([1, 2]);
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
      "AGENTS.md": "# Ledger\n\nWith notes.\n",
      "board.md": "the builder's",
      "notes.md": "the agent's",
    });
  });

  it("reviews a version's tests as they ran, not as results rewritten in R2's cache say", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    const failing = invoices(500, false);
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        ...failing,
        "workflows/invoices.workflow-tests.ts": failing[
          "workflows/invoices.workflow-tests.ts"
        ].replace("expect: { output: 1 }", "expect: { output: 2 }"),
      },
      "Fails its tests"
    );
    const ran = await builder.api.apps.versions.review(app, version);
    // Rewritten to pass, as someone who can write to the bucket but doesn't
    // hold core's secret could, keeping what each was written with.
    const page = await env.FILES.list({
      prefix: `apps/${app}/tests/`,
      include: ["customMetadata"],
    });
    await Promise.all(
      page.objects.map(async ({ key, customMetadata }) => {
        await env.FILES.put(
          key,
          JSON.stringify({ status: "passed", failures: [] }),
          customMetadata === undefined ? {} : { customMetadata }
        );
      })
    );

    const reviewed = await builder.api.apps.versions.review(app, version);

    expect({
      ran: ran.tests.status,
      rewrote: page.objects.length,
      reviewed: reviewed.tests.status,
    }).toStrictEqual({ ran: "failed", rewrote: 1, reviewed: "failed" });
  });

  it("reviews what a version changes against the current one, for its builders only", async () => {
    const builder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    await published(app);
    await release(builder, app, {
      ...invoices(500, false),
      "notes.md": "old",
    });
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        ...invoices(900, true),
        "notes.md": null,
      },
      "Book them"
    );

    const review = await builder.api.apps.versions.review(app, version);

    expect(review).toMatchObject({
      version: { version: 2, parent: 1, message: "Book them" },
      current: 1,
      files: [
        { path: "notes.md", change: "removed" },
        { path: "workflows/invoices.ts", change: "modified" },
      ],
      workflows: [
        {
          id: "invoices",
          change: "modified",
          steps: [{ name: "book", change: "added", sideEffect: true }],
          params: [{ name: "limit", change: "modified" }],
        },
      ],
      permissions: [],
      tests: { status: "passed", failures: [] },
    });
    // Someone who uses its screens, but doesn't build it.
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await expect(user.api.apps.versions.review(app, version)).rejects.toThrow(
      roleErrors.create("role.forbidden").message
    );
  });

  it("reviews the grants a version uses, asking again for those its reviewer can't grant", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const notify = workflowFiles(
      "notify",
      `  return await step.do("save", { description: "Save it" }, async () => await ${hitCall(`"notify"`)});`,
      { save: 1 }
    );
    const app = await appWith(builder, notify);
    await requestGranted(idp, builder, outlook(app));
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        "workflows/notify.ts": `// Saves it.\n${notify["workflows/notify.ts"] ?? ""}`,
      },
      "Noted"
    );

    const grant = {
      subject: { type: "app", appId: app },
      binding: "OUTLOOK",
      status: "active",
    };
    // A builder can't grant it: making the version current asks again.
    await expect(
      builder.api.apps.versions.review(app, version)
    ).resolves.toMatchObject({
      grants: [{ permission: grant, askedAgain: true }],
    });
    // An admin can: nothing is asked for again.
    await expect(
      admin.api.apps.versions.review(app, version)
    ).resolves.toMatchObject({
      grants: [{ permission: grant, askedAgain: false }],
    });
  });

  it("reviews code a workflow may use, the steps that call the App, and the grants the version uses", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const notify = {
      "workflows/notify.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("notify", { params: {}, input: z.unknown() }, async (step, { env }) => {
  return await step.do("save", { description: "Save it" }, async () => ((await env.APP.callFunction({ contractId: "counter.hits", kind: "query" }, { name: "notify" })).ok ? 1 : 0));
});
`,
      "workflows/notify.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./notify.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { save: 1 }, expect: { output: 1 } }]);
`,
    };
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await published(app);
    await release(builder, app, {
      ...notesFiles,
      "server/books.ts": "export const twice = false;\n",
      ...notify,
    });
    await requestGranted(idp, builder, outlook(app));
    // Only server code changes: the workflow's steps call the App's
    // functions.
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        "server/books.ts": "export const twice = true;\n",
      },
      "Server"
    );

    const review = await builder.api.apps.versions.review(app, version);

    const grant = {
      subject: { type: "app", appId: app },
      binding: "OUTLOOK",
      status: "active",
    };
    expect(review).toMatchObject({
      proposedBy: null,
      server: "modified",
      serverFiles: [{ path: "server/books.ts", change: "modified" }],
      workflows: [
        {
          id: "notify",
          change: "modified",
          shared: ["server/books.ts"],
          // Code it may use changed: it may change things through it.
          steps: [
            {
              name: "save",
              change: "modified",
              sideEffect: true,
              calls: ["APP"],
              sharedCode: true,
            },
          ],
          params: [],
        },
      ],
      // A builder can't grant it: making the version current asks again.
      grants: [{ permission: grant, askedAgain: true }],
      tests: { status: "passed", failures: [] },
    });
    // An admin can: nothing is asked for again.
    await expect(
      admin.api.apps.versions.review(app, version)
    ).resolves.toMatchObject({
      grants: [{ permission: grant, askedAgain: false }],
    });

    // A change to one step's function alone shows that step as changed.
    const { version: bodyOnly } = await builder.api.apps.files.commit(
      app,
      {
        "workflows/notify.ts": (notify["workflows/notify.ts"] ?? "").replace(
          'name: "notify"',
          'name: "notified"'
        ),
      },
      "Body"
    );
    await expect(
      builder.api.apps.versions.review(app, bodyOnly)
    ).resolves.toMatchObject({
      server: "modified",
      workflows: [
        {
          id: "notify",
          steps: [{ name: "save", change: "modified", calls: ["APP"] }],
        },
      ],
    });
  });

  it("lists every step of a workflow whose shared code changed, and a step changed only in its code", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Digest" });
    await published(app);
    await release(builder, app, digest("hwczrv0to6"));
    // Only the mail's address: two calls a 32-bit hash couldn't tell apart.
    const { version: address } = await builder.api.apps.files.commit(
      app,
      digest("flfoi83s5j"),
      "Address"
    );
    const addressReview = await builder.api.apps.versions.review(app, address);
    // Then only the helper the first step calls, without reading env.
    const { version: helper } = await builder.api.apps.files.commit(
      app,
      {
        ...digest("hwczrv0to6"),
        "workflows/lib/total.ts":
          "export const total = (n: number) => n + 2;\n",
      },
      "Helper"
    );
    const helperReview = await builder.api.apps.versions.review(app, helper);

    expect({
      address: addressReview.workflows,
      helper: helperReview.workflows,
    }).toStrictEqual({
      address: [
        {
          id: "digest",
          change: "modified",
          shared: [],
          sideEffect: true,
          triggers: [],
          steps: [
            // Calls MAIL: may change things, though it doesn't say so.
            {
              name: "mail",
              change: "modified",
              sideEffect: true,
              calls: ["MAIL"],
              sharedCode: false,
            },
          ],
          calls: ["MAIL"],
          params: [],
        },
      ],
      helper: [
        {
          id: "digest",
          change: "modified",
          shared: ["workflows/lib/total.ts"],
          sideEffect: true,
          triggers: [],
          // Every step, and each may change things: the workflow calls
          // bindings, and the helper may too.
          steps: [
            {
              name: "mail",
              change: "modified",
              sideEffect: true,
              calls: ["MAIL"],
              sharedCode: true,
            },
            {
              name: "sum",
              change: "modified",
              sideEffect: true,
              calls: [],
              sharedCode: true,
            },
          ],
          calls: ["MAIL"],
          params: [],
        },
      ],
    });
  });

  it("lists a step whose option is chosen at run time when its file changed outside the steps' calls, as through a helper it reads", async () => {
    const builder = await signedInApi(idp, "builder");
    const paced = workflowFiles(
      "paced",
      `  await step.do("fetch", { description: "Fetch it" }, async () => 1);
  await step.sleep("pause", { description: "Wait a while", duration: wait(2) });
  return "done";`,
      { fetch: 1 }
    );
    const files = (factor: number) => ({
      ...paced,
      "workflows/paced.ts": (paced["workflows/paced.ts"] ?? "").replace(
        "export default",
        `const wait = (n: number): number => n * ${factor};\n\nexport default`
      ),
    });
    const app = await appWith(builder, files(1000));
    const { version } = await builder.api.apps.files.commit(
      app,
      files(60_000),
      "Longer"
    );
    // Another App whose helper changes only inside a string, which only
    // its spaces tell apart.
    const risky = (kind: string) => ({
      ...paced,
      "workflows/paced.ts": (paced["workflows/paced.ts"] ?? "").replace(
        "export default",
        `const wait = (n: number): number => ("${kind}" === "high risk" ? n : 2 * n);\n\nexport default`
      ),
    });
    const other = await appWith(builder, risky("high risk"));
    const { version: respaced } = await builder.api.apps.files.commit(
      other,
      risky("highrisk"),
      "Respaced"
    );

    // And one whose helper's string becomes a step's very call as written:
    // only the call itself is cut out of the comparison, never the same
    // text elsewhere.
    const fetchCall =
      'step.do("fetch", { description: "Fetch it" }, async () => 1)';
    const echoing = (text: string) => ({
      ...paced,
      "workflows/paced.ts": (paced["workflows/paced.ts"] ?? "").replace(
        "export default",
        `const wait = (n: number): number => ('${text}' === '' ? n : 2 * n);\n\nexport default`
      ),
    });
    const third = await appWith(builder, echoing(""));
    const { version: echoed } = await builder.api.apps.files.commit(
      third,
      echoing(fetchCall),
      "Echoed"
    );

    const review = await builder.api.apps.versions.review(app, version);
    const respacedReview = await builder.api.apps.versions.review(
      other,
      respaced
    );
    const echoedReview = await builder.api.apps.versions.review(third, echoed);

    expect({
      respaced: changedSteps(respacedReview.workflows),
      echoed: changedSteps(echoedReview.workflows),
    }).toStrictEqual({
      respaced: [[{ name: "pause", change: "modified", sharedCode: true }]],
      echoed: [[{ name: "pause", change: "modified", sharedCode: true }]],
    });
    expect(review.workflows).toMatchObject([
      {
        id: "paced",
        change: "modified",
        shared: [],
        // Neither call changed; the helper the pause reads at run time
        // did. `fetch` reads nothing outside its call.
        steps: [
          {
            name: "pause",
            change: "modified",
            sharedCode: true,
            dynamic: ["duration"],
          },
        ],
      },
    ]);
  });

  it("calls out new triggers, and steps it can't read as possibly acting", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Weekly" });
    await published(app);
    await release(builder, app, {
      ...weekly(`[{ type: "manual" }]`),
      "data/totals.json": JSON.stringify({ totals: "read" }),
    });
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        // Now on a schedule, and its step inside a function of its own.
        ...weekly(`[{ type: "schedule", param: "every" }]`, true),
        "data/totals.json": JSON.stringify({ totals: "write" }),
      },
      "Weekly"
    );

    const review = await builder.api.apps.versions.review(app, version);

    expect({
      workflows: review.workflows,
    }).toStrictEqual({
      workflows: [
        {
          id: "weekly",
          change: "modified",
          // Code it may import: JSON too.
          shared: ["data/totals.json"],
          sideEffect: true,
          steps: null,
          calls: [],
          params: [],
          triggers: [
            {
              trigger: { type: "schedule", param: "every" },
              change: "added",
              count: 1,
              countBefore: 0,
              countAfter: 1,
            },
            {
              trigger: { type: "manual" },
              change: "removed",
              count: 1,
              countBefore: 1,
              countAfter: 0,
            },
          ],
        },
      ],
    });
  });

  it("counts a second identical trigger as added, and a workflow with an unchanged acting step as acting", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Weekly" });
    await published(app);
    const once = `[{ type: "schedule", param: "every" }]`;
    await release(builder, app, weekly(once, false, true));
    // Only a second schedule, the same as the first: both run it.
    const { version } = await builder.api.apps.files.commit(
      app,
      weekly(
        `[{ type: "schedule", param: "every" }, { type: "schedule", param: "every" }]`,
        false,
        true
      ),
      "Twice"
    );

    const review = await builder.api.apps.versions.review(app, version);

    expect(review.workflows).toStrictEqual([
      {
        id: "weekly",
        change: "modified",
        shared: [],
        // Its step, unchanged, says it changes things: so the workflow can.
        sideEffect: true,
        steps: [],
        calls: [],
        params: [],
        triggers: [
          {
            trigger: { type: "schedule", param: "every" },
            change: "added",
            count: 1,
            countBefore: 1,
            countAfter: 2,
          },
        ],
      },
    ]);
  });

  it("runs a version's tests once", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    await published(app);
    await release(builder, app, invoices(500, false));
    const [latest] = await builder.api.apps.versions.list(app);
    const kept = `apps/${app}/tests/${latest?.tree ?? ""}-${compilerVersion}.json`;

    const first = await builder.api.apps.versions.review(app, 1);
    const keptFirst = await env.FILES.head(kept);
    const second = await builder.api.apps.versions.review(app, 1);
    // What the first review kept is what the next one reads: running the
    // tests again would have kept their results again.
    const keptSecond = await env.FILES.head(kept);

    expect({
      reviewed: [first.tests, second.tests],
      kept: keptFirst !== null,
      keptAgain: keptSecond?.version !== keptFirst?.version,
    }).toStrictEqual({
      reviewed: [
        { status: "passed", failures: [] },
        { status: "passed", failures: [] },
      ],
      kept: true,
      keptAgain: false,
    });
  });
});
