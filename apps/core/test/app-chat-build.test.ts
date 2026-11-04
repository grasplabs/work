import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  says,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// An App's own chat building the App from nothing, as a model that knows
// only what the chat gives it would: it reads how an App is written in
// Grasp's reference (the SDK's sources the check type-checks against, and
// a built-in blueprint as a working example), writes a board, and repairs
// it by what the check and a call of the draft say. What could go wrong:
// the reference isn't there to read, so the model guesses the shapes; a
// check or a call answers only that something failed, never where or why;
// and an App that should pass never gets a draft with its screen.

const idp = mockIdp();

/** The board's store: cards, each in one of four columns. */
const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const columns = ["todo", "doing", "review", "done"] as const;

export default defineSchema({
  cards: defineTable({
    title: v.string().trim().min(1).max(200),
    column: v.enum(columns),
  }).index("by_column", ["column"]),
});
`;

/** The board's operations: list the cards, add one, move one on. */
const operations = `import { v } from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";

import { columns } from "../schema.ts";

export const list = query({
  args: {},
  returns: v.array(doc("cards")),
  handler: async (ctx) => await ctx.db.query("cards").take(100),
});

export const create = mutation({
  args: { title: v.string().trim().min(1).max(200) },
  returns: v.id("cards"),
  handler: async (ctx, args) => await ctx.db.insert("cards", { title: args.title, column: "todo" }),
});

export const move = mutation({
  args: { id: v.id("cards"), column: v.enum(columns), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("cards", args.id, { column: args.column }, { expectedRevision: args.expectedRevision });
    return null;
  },
});
`;

/** The board's registration, as the SDK's `app` takes it. */
const registration = `import { app } from "@grasp-os/sdk";

import { create, list, move } from "./server/cards.ts";
import schema from "./schema.ts";

export default app({
  name: "Board",
  schema,
  access: { tables: { cards: { read: "appMembers", write: "appMembers" } } },
  screens: [{ name: "board", path: "/", source: "screens/board.tsx" }],
});
`;

/** The board's one screen: four columns of cards. */
const screen = `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { api } from "@server/_generated/api";

const columns = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "Doing" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
] as const;

export default function Board() {
  const cards = useQuery(api.cards.list, {});
  const create = useMutation(api.cards.create);
  const move = useMutation(api.cards.move);
  if (cards === undefined) {
    return <p role="status">Loading the board…</p>;
  }
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button onClick={() => void create({ title: "New card" })}>Add a card</Button>
      <div className="grid grid-cols-4 gap-4">
        {columns.map((column, index) => {
          const next = columns[index + 1];
          return (
            <section key={column.id} className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">{column.title}</h2>
              {cards
                .filter((card) => card.column === column.id)
                .map((card) => (
                  <Card key={card._id}>
                    <CardHeader>
                      <CardTitle>{card.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {next === undefined ? null : (
                        <Button variant="outline" onClick={() => void move({ id: card._id, column: next.id, expectedRevision: card._rev })}>
                          Move to {next.title}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                ))}
            </section>
          );
        })}
      </div>
    </main>
  );
}
`;

/**
 * The board as a model that guessed would write it: who may use the
 * table as one word, not `read` and `write`.
 */
const guessed = registration.replace(
  '{ cards: { read: "appMembers", write: "appMembers" } }',
  '{ cards: "appMembers" }'
);

/** The board's operations with a type error on their line 15. */
const mistyped = operations.replace('column: "todo" }', 'column: "later" }');

/** Code that calls the draft of `app`'s `cards.list`, and nothing more. */
const calling = (app: string) =>
  `export default async (self, env) => await env.build.call(${JSON.stringify(app)}, "cards.list", {});`;

/**
 * Code that checks the draft of `app` as proposing it would, without
 * proposing it (a check job, followed until it ends), and calls its
 * `cards.list`.
 */
const checking = (app: string) => `export default async (self, env) => {
  const check = await (async () => { const { job } = await env.build.submit(${JSON.stringify(app)}, { kind: "check" }); for (;;) { const view = await env.build.job(job); if (view.status !== "running") { return view.result; } await scheduler.wait(100); } })();
  const called = await env.build.call(${JSON.stringify(app)}, "cards.list", {});
  return {
    passed: check.passed,
    server: check.server.status,
    diagnostics: check.server.diagnostics.map(({ file, line, message }) => ({ file, line, message })),
    screens: check.screens.status,
    called,
  };
};`;

/** What `checking` returned for a draft that fails. */
const guessSchema = z.object({
  passed: z.boolean(),
  server: z.string(),
  diagnostics: z.array(
    z.object({
      file: z.string().nullable(),
      line: z.number().nullable(),
      message: z.string(),
    })
  ),
  called: z.object({ ok: z.boolean(), code: z.string(), message: z.string() }),
});

/** What a code step returned, as JSON. */
const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

describe("an App's chat building its App", { timeout: 180_000 }, () => {
  it("reads the SDK and a working App, hears exactly what a guess got wrong, and drafts a board that passes", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await builder.api.apps.create({ name: `Board ${unique()}` });
    const files = {
      "schema.ts": schema,
      "server/cards.ts": operations,
      "app.ts": guessed,
      "screens/board.tsx": screen,
    };
    const { stub } = await personalChatsOf(
      builder.userId,
      toolStep("readFile", { path: "@grasp-os/sdk/src/app.ts", toLine: 400 }),
      toolStep("readFile", { path: "blueprints/board-page/app.ts" }),
      toolStep("searchFiles", {
        text: "interface TableAccess",
        path: "@grasp-os/sdk",
      }),
      toolStep("readFile", { path: "@grasp-os/sdk/src/nothing.ts" }),
      toolStep("writeFile", { app: app.id, files }),
      codeStep(checking(app.id)),
      toolStep("writeFile", {
        app: app.id,
        files: { "app.ts": registration, "server/cards.ts": mistyped },
      }),
      codeStep(calling(app.id)),
      toolStep("writeFile", {
        app: app.id,
        files: { "server/cards.ts": operations },
      }),
      codeStep(checking(app.id)),
      says("The board is drafted.")
    );
    const chat = await builder.api.chats.forApp(app.id);

    await stub.ask(chat.id, {
      text: "Build a kanban with four columns.",
      model,
    });

    const tools = await toolResults(stub, chat.id);
    const [sdk, blueprint, search, missing] = tools;
    const [guess, typed, fixed] = await codeResults(stub, chat.id);
    const drafts = await builder.api.chats.drafts(chat.id);
    expect({
      sdk: sdk?.text.includes("export interface AppDefinition<"),
      blueprint: blueprint?.text.includes("export default app({"),
      search: search?.text.includes("@grasp-os/sdk/src/schema-manifest.ts:"),
      missing: {
        isError: missing?.isError,
        names: missing?.text.includes("@grasp-os/sdk/src/app.ts"),
      },
    }).toStrictEqual({
      sdk: true,
      blueprint: true,
      search: true,
      missing: { isError: true, names: true },
    });
    // What the SDK refused the registration with, ending each answer:
    // nothing of its stack, which names only the SDK's bundled modules.
    const refused =
      "Table `cards`'s access is `read` and `write`, each `owner`, `appMembers`, `appBuilders` or `none`.";
    const failed = guessSchema.parse(returned(guess?.text));
    expect({
      passed: failed.passed,
      server: failed.server,
      diagnostics: failed.diagnostics.map(({ file, line, message }) => ({
        file,
        line,
        refused: message.endsWith(refused),
      })),
      called: {
        ok: failed.called.ok,
        code: failed.called.code,
        refused: failed.called.message.endsWith(refused),
      },
    }).toStrictEqual({
      passed: false,
      server: "failed",
      // Where its registration threw, the call of app(), and the type
      // error that says why, together.
      diagnostics: [
        { file: "app.ts", line: 6, refused: true },
        { file: "app.ts", line: 9, refused: false },
      ],
      called: { ok: false, code: "version.inspection_failed", refused: true },
    });
    // A type error, as the seal's build names it: its file and line.
    const typeError = z
      .object({ ok: z.literal(false), code: z.string(), message: z.string() })
      .parse(returned(typed?.text));
    expect({
      code: typeError.code,
      located: typeError.message
        .split("\n")
        .some((line) => line.startsWith("server/cards.ts:15: ")),
    }).toStrictEqual({ code: "version.build_failed", located: true });
    expect(returned(fixed?.text)).toStrictEqual({
      passed: true,
      server: "ok",
      diagnostics: [],
      screens: "ok",
      called: { ok: true, answer: [] },
    });
    expect(
      drafts.map(({ app: drafted, changed }) => ({ app: drafted, changed }))
    ).toStrictEqual([
      {
        app: app.id,
        changed: [
          "app.ts",
          "schema.ts",
          "screens/board.tsx",
          "server/cards.ts",
        ],
      },
    ]);
  });
});
