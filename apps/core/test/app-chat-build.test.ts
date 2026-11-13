import { runInDurableObject } from "cloudflare:test";
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
  turnChecks,
} from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// An App's own chat building the App from nothing, as a model that knows
// only what the chat gives it would: it reads how an App is written in
// the release's docs (agent-docs.test.ts), defines the board's table with
// the definition tools, writes its code, and repairs it by what the
// tools, the check and a call of the draft say. What could go wrong: the
// generated config is written by hand, past the definition; a tool, a
// check or a call answers only that something failed, never where or
// why; and an App that should pass never gets a draft with its page.

const idp = mockIdp();

/** The board's values: the columns a card may be in. */
const values = `export const columns = ["todo", "doing", "review", "done"] as const;
`;

/** The board's table, as `addTable` takes it: cards, each in one column. */
const cards = {
  name: "cards",
  fields: {
    title: "v.string().trim().min(1).max(200)",
    column: 'v.enum(["todo", "doing", "review", "done"])',
  },
  access: { read: "appMembers", write: "appMembers" },
};

/** The board's functions: list the cards, add one, move one on. */
const serverCode = `import { v } from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";

import { columns } from "../values.ts";

export const list = query({
  args: {},
  returns: v.array(doc("cards")),
  handler: async (ctx) => await ctx.db.query("cards").take(100),
});

export const create = mutation({
  args: { title: v.string().trim().min(1).max(200) },
  returns: v.id("cards"),
  handler: async (ctx, args) =>
    await ctx.db.insert("cards", { title: args.title, column: "todo" }),
});

export const move = mutation({
  args: {
    id: v.id("cards"),
    column: v.enum(columns),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(
      "cards",
      args.id,
      { column: args.column }
    );
    return null;
  },
});
`;

/** A config written by hand, as a model that guessed would write it. */
const handwritten = `import { defineApp } from "@grasp-os/sdk";

export default defineApp({ name: "Board" });
`;

/** The board's one page: four columns of cards. */
const page = `import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { api } from "@server/_generated/api";

const columns = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "Doing" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
] as const;

const Board = () => {
  const cards = useQuery(api.cards.list, {});
  const create = useMutation(api.cards.create);
  const move = useMutation(api.cards.move);
  const handleAdd = async () => {
    await create({ title: "New card" });
  };
  if (cards === undefined) {
    return <output>Loading the board…</output>;
  }
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button onClick={handleAdd}>Add a card</Button>
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
                        <Button
                          variant="outline"
                          onClick={async () => {
                            await move({
                              id: card._id,
                              column: next.id,
                            });
                          }}
                        >
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
};

export const Route = createFileRoute("/")({ component: Board });
`;

/** The board's serverCode with a type error on their line 16. */
const mistyped = serverCode.replace('column: "todo" }', 'column: "later" }');

/** Code that calls the draft of `app`'s `cards.list`, and nothing more. */
const calling = (app: string) =>
  `export default async (self, env) => await env.build.call(${JSON.stringify(app)}, "cards.list", {});`;

/** What a code step returned, as JSON. */
const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

describe("an App's chat building its App", { timeout: 180_000 }, () => {
  it("reads the docs, defines the board's table with the tools, hears exactly what a guess got wrong, and drafts a board that passes", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await builder.api.apps.create({ name: `Board ${unique()}` });
    const code = {
      "values.ts": values,
      "server/cards.ts": mistyped,
      "src/routes/index.tsx": page,
    };
    const { stub, provider } = await personalChatsOf(
      builder.userId,
      toolStep("readDocs", { path: "/reference/server" }),
      toolStep("writeFile", {
        app: app.id,
        files: { "grasp.config.ts": handwritten },
      }),
      toolStep("addTable", {
        app: app.id,
        ...cards,
        fields: { ...cards.fields, column: "v.enumerate(columns)" },
      }),
      toolStep("addTable", { app: app.id, ...cards }),
      toolStep("addIndex", {
        app: app.id,
        table: "cards",
        name: "by_column",
        fields: ["column"],
      }),
      toolStep("writeFile", { app: app.id, files: code }),
      codeStep(calling(app.id)),
      toolStep("writeFile", {
        app: app.id,
        files: { "server/cards.ts": serverCode },
      }),
      codeStep(calling(app.id)),
      says("The board is drafted.")
    );
    const chat = await builder.api.chats.forApp(app.id);

    await stub.ask(chat.id, {
      text: "Build a kanban with four columns.",
      model,
    });

    const [docs, handwrittenConfig, guess, added, indexed] = await toolResults(
      stub,
      chat.id
    );
    const [typed, fixed] = await codeResults(stub, chat.id);
    // Each call of the draft, as the chat's steps show it: on the App, the
    // one that failed as failed, so a page knows when examples were added.
    const calls = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ event: string }>(
          "SELECT event FROM chat_tool_events WHERE chat_id = ? ORDER BY id",
          chat.id
        )
        .toArray()
        .map(({ event }) =>
          z
            .object({
              method: z.string(),
              target: z.unknown(),
              outcome: z.string(),
            })
            .parse(JSON.parse(event))
        )
        .filter(({ method }) => method === "build.call")
        .map(({ target, outcome }) => ({ target, outcome }))
    );
    const drafts = [await builder.api.drafts.get({ kind: "app", id: app.id })];
    expect({
      docs: docs?.text.includes("# @grasp-os/sdk/server"),
      // The generated config is never written by hand: the refusal names
      // the tools.
      handwritten: {
        isError: handwrittenConfig?.isError,
        tools: handwrittenConfig?.text.includes("addTable"),
      },
      // A type that isn't one: the problem in words, nothing saved.
      guess: {
        ok: guess?.text.includes('"ok":false'),
        says: guess?.text.includes("enumerate"),
      },
      // Then the table, and what it does to the App's records.
      added: added?.text.includes('"addedTables":["cards"]'),
      indexed: indexed?.text.includes('"ok":true'),
    }).toStrictEqual({
      docs: true,
      handwritten: { isError: true, tools: true },
      guess: { ok: true, says: true },
      added: true,
      indexed: true,
    });
    // A type error, as the seal's build names it: its file and line.
    const typeError = z
      .object({ ok: z.literal(false), code: z.string(), message: z.string() })
      .parse(returned(typed?.text));
    expect({
      code: typeError.code,
      located: typeError.message
        .split("\n")
        .some((line) => line.startsWith("server/cards.ts:16: ")),
    }).toStrictEqual({ code: "version.build_failed", located: true });
    expect(calls).toStrictEqual([
      { target: { type: "app", id: app.id }, outcome: "failed" },
      { target: { type: "app", id: app.id }, outcome: "ok" },
    ]);
    expect({
      called: returned(fixed?.text),
      // The turn's check of the draft, as it answered, found nothing.
      checks: turnChecks(provider),
    }).toStrictEqual({ called: { ok: true, answer: [] }, checks: [] });
    expect(
      drafts.map(({ subject, changed }) => ({ app: subject.id, changed }))
    ).toStrictEqual([
      {
        app: app.id,
        changed: [
          "grasp.config.ts",
          "server/_generated/api.ts",
          "server/_generated/dataModel.ts",
          "server/_generated/internal.ts",
          "server/_generated/server.ts",
          "server/cards.ts",
          "server/schema.ts",
          "src/routes/index.tsx",
          "values.ts",
        ],
      },
    ]);
  });
});
