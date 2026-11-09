import { appErrors } from "@grasp-os/shared/apps";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  editing,
  fixed,
  gatedFilesDuring,
  idp,
  lines,
  rates,
  returned,
  setUp,
  tryEach,
} from "./agent-builds-harness.ts";
import type { FilesGate } from "./agent-builds-harness.ts";
import {
  codeResults,
  codeStep,
  says,
  toolResults,
  toolStep,
  turnChecks,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdpWith } from "./idp.ts";
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

mockIdpWith(idp);

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("writes and edits a draft's files with tools of their own, editing only a file it read, as its person's own build", async () => {
    const { person, chat, existing } = await setUp((app) => [
      editing(app),
      toolStep("readFile", { app, path: "AGENTS.md" }),
      editing(app),
      toolStep("writeFile", {
        app,
        files: { "src/routes/index.tsx": fixed, "notes.md": "Desk notes" },
      }),
      codeStep(`export default async (self, env) => {
        const { files } = await env.build.files(${JSON.stringify(app)});
        return { agents: files["AGENTS.md"], desk: files["src/routes/index.tsx"], notes: files["notes.md"] };
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

    await chat.ask("Name the desk, and add its page");

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
          "src/components/total.ts":
            "var rate = 2\nexport const total = (n: number) => { return n*rate }\nexport const same = (a: number, b: number) => a == b\n",
        },
      }),
      toolStep("readFile", { app, path: "src/components/total.ts" }),
      says("Written."),
      says("The comparison is loose."),
    ]);

    await chat.ask("Add a total");

    const [, read] = await toolResults(chat.stub, chat.chat.id);
    // The turn's one check, of its one draft.
    const [[found]] = z
      .tuple([z.tuple([z.unknown()])])
      .parse(turnChecks(chat.provider));
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
      .parse(found);
    expect({
      written: diagnostics
        .filter(({ file }) => file === "src/components/total.ts")
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
        `src/components/rate-${at}.ts`,
        `var rate${at} = ${at}\nexport const total${at} = (n: number) => { return n*rate${at} }\n${lines(at)}\n`,
      ])
    );
    const { chat } = await setUp((app) => [
      toolStep("writeFile", { app, files }),
      toolStep("readFile", { app, path: "src/components/rate-0.ts" }),
      toolStep("readFile", { app, path: "src/components/rate-49.ts" }),
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
        `src/components/rate-${at}.ts`,
        rates(at),
      ])
    );
    const { chat } = await setUp((app) => [
      toolStep("writeFile", { app, files }),
      toolStep("readFile", { app, path: "src/components/rate-0.ts" }),
      toolStep("readFile", { app, path: "src/components/rate-3.ts" }),
      says("Written."),
    ]);

    const { LOADER: loader } = env;
    env.LOADER = stoppingUltracite(loader, {
      marker: "src/components/rate-0.ts",
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
          "pages/a.md": "Alpha\nbeta\nalphabet",
          "pages/b.md": "ALPHA",
          "pagesaver.md": "alpha",
          "server/x.ts": "alpha",
          "many.md": many,
        },
      }),
      toolStep("searchFiles", { app, text: "aLpHa", path: "pages" }),
      toolStep("searchFiles", { app, text: "an alpha" }),
      toolStep("readFile", { app, path: "pages/a.md" }),
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
      // Not `pagesaver.md`, which only starts like the folder.
      inFolder: {
        matches: [
          "pages/a.md:1:Alpha",
          "pages/a.md:3:alphabet",
          "pages/b.md:1:ALPHA",
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
});
