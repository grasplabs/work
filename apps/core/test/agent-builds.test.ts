import { definitionText } from "@grasp-os/runtime/definition";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { chatWork, readDraft, saveDraft } from "../src/app-drafts.ts";
import {
  appName,
  findApp,
  fixed,
  idp,
  ledgerDefinition,
  restyled,
  returned,
  setUp,
  unclosed,
} from "./agent-builds-harness.ts";
import {
  codeResults,
  codeStep,
  says,
  toolResults,
  toolStep,
  transcript,
  turnChecks,
} from "./agent-chat.ts";
import { commitApp, withFiles } from "./app-definitions.ts";
import { agentWriting } from "./draft-writers.ts";
import { mockIdpWith } from "./idp.ts";
import { defineNotes, notesCode, notesFiles } from "./notes-client-app.ts";

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

// A count that is never a number, written anew each time.
const mistypedAt = (attempt: number) =>
  fixed.replace(
    "const Desk = () => (",
    `const count: number = "seven";\n\nconst Desk = () => (\n  // ${attempt}`
  );

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("keeps the draft apart from what a builder commits meanwhile, both ways", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const { builder, existing, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${ledger}
        await env.build.write(app.id, { "notes.md": "the agent's" }, { revision: (await env.build.files(app.id)).revision });
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
    await commitApp(
      builder.api.apps.files,
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
      files: withFiles(ledgerDefinition, {
        "AGENTS.md": "# Ledger\n",
        "notes.md": "the agent's",
      }).files,
    });
    expect(returned(after?.text)).toStrictEqual({
      notes: "the agent's",
      builder: null,
    });
    await expect(builder.api.apps.files.read(existing)).resolves.toStrictEqual(
      withFiles(ledgerDefinition, {
        "AGENTS.md": "# Ledger\n",
        "notes.md": "the builder's",
        "builder.md": "mine",
      }).files
    );
    // The chat's page lists what its agent worked on (app-drafts.test.ts
    // has who reads it).
    const listed = await chatWork(env, chat.chat.id);
    // The draft names the code step that wrote it, where the thread shows
    // its preview: the first, not the later one that only read it.
    const messages = await transcript(chat.stub, chat.chat.id);
    const steps = messages.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : []
    );
    expect(listed).toMatchObject([
      { kind: "app", id: existing, callId: steps[0] },
    ]);
    expect(steps).toHaveLength(2);
  });

  it("answers every write with what doesn't compile, however often the same error comes back, and never locks the agent out", async () => {
    const { chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        const errors = [];
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const written = await env.build.write(app.id, { "src/routes/index.tsx": ${JSON.stringify(unclosed)} + "// " + attempt + "\\n" }, { revision: (await env.build.files(app.id)).revision });
          errors.push(written.errors);
        }
        return errors;
      };`),
        says("The page still doesn't compile."),
        // What the turn's check found, the same.
        says("I'm stuck on it."),
        codeStep(`export default async (self, env) => {
        ${findApp}
        const written = await env.build.write(app.id, ${JSON.stringify({ "src/routes/index.tsx": fixed })}, { revision: (await env.build.files(app.id)).revision });
        const checked = await env.build.check(app.id);
        return { errors: written.errors, passed: checked.passed };
      };`),
        says("Fixed: it's ready to publish."),
      ],
      "builder",
      true
    );
    await grant();

    await chat.ask("Build an invoice desk");
    await chat.ask("Try once more");

    const results = await codeResults(chat.stub, chat.chat.id);
    expect(returned(results[0]?.text)).toStrictEqual(
      Array.from({ length: 8 }, () => 1)
    );
    expect(returned(results[1]?.text)).toStrictEqual({
      errors: 0,
      passed: true,
    });
  });

  it("checks the turn's drafts once it answers, a type error and a lint error together, by file, and the agent goes on in the same turn", async () => {
    const mistyped = restyled
      .replace(
        "const Desk = () => (",
        'const count: number = "seven";\n\nconst Desk = () => ('
      )
      .replace("    <Button", "    <p>{count}</p>\n    <Button");
    const { chat } = await setUp((app) => [
      toolStep("writeFile", {
        app,
        files: { "src/routes/index.tsx": mistyped },
      }),
      says("The desk is written."),
      says("Two things fail."),
    ]);

    const answered = await chat.ask("Add a desk page to the Ledger");

    const [written] = await toolResults(chat.stub, chat.chat.id);
    expect(written?.isError).toBeFalsy();
    // It compiles: the write says nothing fails.
    expect(returned(written?.text)).toMatchObject({ errors: 0, leftOut: 0 });
    expect({
      checks: turnChecks(chat.provider),
      answer: answered.answer,
    }).toMatchObject({
      checks: [
        [
          {
            errors: 2,
            diagnostics: [
              { file: "src/routes/index.tsx", line: 4, rule: "TS2322" },
              {
                file: "src/routes/index.tsx",
                line: 9,
                rule: "design/no-restyle",
              },
            ],
            leftOut: 0,
          },
        ],
      ],
      answer: "Two things fail.",
    });
  });

  it("checks the turn's drafts again each time it would answer having written, until they pass", async () => {
    const mistyped = fixed.replace(
      "const Desk = () => (",
      'const count: number = "seven";\n\nconst Desk = () => ('
    );
    const { chat } = await setUp((app) => [
      toolStep("writeFile", {
        app,
        files: { "src/routes/index.tsx": mistyped },
      }),
      says("The desk is written."),
      // The first check fails: the agent fixes it, in the same turn.
      toolStep("writeFile", {
        app,
        files: { "src/routes/index.tsx": fixed },
      }),
      says("Fixed the count."),
      says("Never asked: the second check passes."),
    ]);

    const answered = await chat.ask("Add a desk page to the Ledger");

    expect({
      answer: answered.answer,
      outcome: answered.outcome,
      // One check failed, then one passed, telling the agent nothing.
      checks: turnChecks(chat.provider),
      requests: chat.provider.requests.length,
    }).toMatchObject({
      answer: "Fixed the count.",
      outcome: "answered",
      checks: [
        [
          {
            // The mistyped count, which nothing reads either.
            errors: 2,
            diagnostics: [
              { file: "src/routes/index.tsx", rule: "TS2322" },
              { file: "src/routes/index.tsx", rule: "no-unused-vars" },
            ],
          },
        ],
      ],
      requests: 4,
    });
  });

  it("ends a turn that never fixes its drafts after three checks, telling it what failed twice", async () => {
    const writeAttempt = (app: string, attempt: number) =>
      toolStep("writeFile", {
        app,
        files: { "src/routes/index.tsx": mistypedAt(attempt) },
      });
    const { chat } = await setUp((app) => [
      writeAttempt(app, 1),
      says("The desk is written."),
      writeAttempt(app, 2),
      says("Fixed, I think."),
      writeAttempt(app, 3),
      says("Still broken."),
      says("Never asked: a third failed check ends the turn."),
    ]);

    const answered = await chat.ask("Add a desk page to the Ledger");

    expect({
      answer: answered.answer,
      outcome: answered.outcome,
      // Two notices, after the first and second checks; the third ends it.
      notices: turnChecks(chat.provider).length,
      requests: chat.provider.requests.length,
    }).toStrictEqual({
      answer: "Still broken.",
      outcome: "answered",
      notices: 2,
      requests: 6,
    });
  });

  it("reports server code that throws as it registers as one error at its line, not one per page", async () => {
    const serverCode = notesCode["server/notes.ts"] ?? "";
    const throwing = serverCode.replace(
      "\nexport const list = query({",
      '\nif (globalThis.Object === Object) throw new Error("No notes today");\nexport const list = query({'
    );
    const { chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        ${defineNotes}
        await env.build.write(app.id, ${JSON.stringify({ ...notesCode, "server/notes.ts": throwing })}, { revision: (await env.build.files(app.id)).revision });
        const checked = await env.build.check(app.id);
        const errorsOf = (check) => [check.pages, check.server].flatMap(({ diagnostics }) => diagnostics).filter(({ severity }) => severity === "error");
        // Then an serverCode file that doesn't parse, the throw gone.
        await env.build.write(app.id, ${JSON.stringify({ "server/notes.ts": `${serverCode}\nexport const broken = query({ args: {` })}, { revision: (await env.build.files(app.id)).revision });
        const unparsed = errorsOf(await env.build.check(app.id));
        return {
          errors: errorsOf(checked).length,
          diagnostics: errorsOf(checked).map(({ file, line, rule, severity, message }) => ({ file, line, rule, severity, says: message.includes("No notes today") })),
          passed: checked.passed,
          unparsed: { errors: unparsed.length, files: [...new Set(unparsed.map(({ file }) => file))] },
        };
      };`),
        says("The registration throws."),
        says("It still doesn't parse."),
      ],
      "builder",
      true
    );
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
      passed: false,
      // Its compile error, and nothing of the pages that import it.
      unparsed: { errors: 1, files: ["server/notes.ts"] },
    });
  });

  it("never passes pages checked against stand-ins, though the sandbox ends one inspection and not the next", async () => {
    // The attack, under load: the sandbox ends one inspection of the
    // server code (its deadline), so the pages fall back to the
    // permissive stand-ins, while another inspection of the same code
    // registers and passes the server check. Passed then, a page with
    // calls that don't exist would be published. The draft's builds
    // inspect once, for both, and a stand-in check never passes.
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${findApp}
        const checked = await env.build.check(app.id);
        return {
          passed: checked.passed,
          standIn: checked.pages.standIn ?? false,
          server: checked.server.status,
        };
      };`),
      says("It doesn't pass yet."),
    ]);
    await grant();
    const { id: app } = await person.api.apps.create({ name: appName });
    const chatId = chatIdSchema.parse(chat.chat.id);
    // Never inspected before, so no kept registration serves it.
    const files = withFiles(notesFiles, {
      "server/notes.ts": `${notesFiles.files["server/notes.ts"] ?? ""}// ${crypto.randomUUID()}\n`,
    });
    await saveDraft(
      env,
      app,
      await readDraft(env, app),
      {
        changes: files.files,
        unchanged: [],
        definition: definitionText(files.definition),
      },
      await agentWriting(person, chatId)
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
      await chat.ask("Check the notes App");
    } finally {
      env.LOADER = loader;
    }

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect({ inspections, checked: returned(result?.text) }).toStrictEqual({
      // One inspection, read by the pages and the server check alike.
      inspections: 1,
      checked: {
        passed: false,
        standIn: true,
        server: "failed",
      },
    });
    await expect(person.api.apps.versions.list(app)).resolves.toStrictEqual([]);
  });

  it("says a write's build couldn't run, passes nothing then, and checks it at the next write once it can", async () => {
    const write = `export default async (self, env) => {
      ${findApp}
      const written = await env.build.write(app.id, ${JSON.stringify({ "src/routes/index.tsx": fixed })}, { revision: (await env.build.files(app.id)).revision });
      const checked = await env.build.check(app.id);
      return { errors: written.errors, notChecked: written.notChecked, passed: checked.passed };
    };`;
    // Never built before, so no build of it is in the cache to serve.
    const unbuilt = `${fixed}\n// ${crypto.randomUUID()}\n`;
    const { chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        const written = await env.build.write(app.id, ${JSON.stringify({ "src/routes/index.tsx": unbuilt })}, { revision: (await env.build.files(app.id)).revision });
        const checked = await env.build.check(app.id);
        return { errors: written.errors, notChecked: written.notChecked, passed: checked.passed };
      };`),
        says("It couldn't be built now."),
        codeStep(write),
        says("Built."),
      ],
      "builder",
      true
    );
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
    // No error found, but not checked either: never passed.
    expect(returned(results[0]?.text)).toStrictEqual({
      errors: 0,
      notChecked: {
        pages:
          "The build couldn't run now. It runs again when this is first used.",
      },
      passed: false,
    });
    expect(returned(results[1]?.text)).toStrictEqual({
      errors: 0,
      notChecked: {},
      passed: true,
    });
  });

  it("says a write's build didn't finish within its bound, and passes nothing", async () => {
    const { chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        const written = await env.build.write(app.id, ${JSON.stringify({ "src/routes/index.tsx": fixed })}, { revision: (await env.build.files(app.id)).revision });
        const checked = await env.build.check(app.id);
        return {
          written: { errors: written.errors, notChecked: written.notChecked },
          checked: { passed: checked.passed, pages: checked.pages },
        };
      };`),
        says("It couldn't be built in time."),
      ],
      "builder",
      true
    );
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
            if (key.startsWith("build-cache/")) {
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
      written: { errors: 0, notChecked: { pages: late } },
      checked: {
        passed: false,
        pages: { status: "error", diagnostics: [], error: late },
      },
    });
  });
});
