/// <reference types="vite-plus/client" />
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  model,
  personalChatsOf,
  says,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// What the chat's agent builds from: the SDK docs of the release its
// deployment runs, never the SDK's sources or a blueprint's files. The
// ways it can fail: the agent reads guides that no longer say what the
// docs say (copied by hand, or built from older docs), so it writes code
// to a shape the release doesn't have; its docs tools read something other
// than this deployment's own docs (a newer version elsewhere, or another
// of core's static files by a path it made up); or the guides reach the
// model in a place the prompt cache can't keep across turns.
//
// The docs tools read core's static files, where the tests' stand-in of
// the docs' build is (fixtures/assets/docs), whose own output the docs'
// tests check (apps/docs/build.test.ts).

const idp = mockIdp();

/** The guides, as the docs keep them: what the agent's copy is built from. */
const guideFiles = import.meta.glob<string>("../../docs/content/guides/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A guide's Markdown, without its frontmatter: what a reader reads. */
const bodyOf = (page: string): string =>
  page.slice(page.indexOf("\n---\n", 3) + "\n---\n".length).trim();

const requestSchema = z.object({
  system: z.array(z.object({ text: z.string() })),
  tools: z.array(z.object({ name: z.string() })),
});

/** A request's system prompt, as one text, and the tools it offered. */
const sent = (body: unknown) => {
  const { system, tools } = requestSchema.parse(body);
  return {
    system: system.map(({ text }) => text).join("\n"),
    tools: tools.map(({ name }) => name),
  };
};

describe("the docs the chat's agent builds from", () => {
  it("carries every guide of the docs, as written, in the system prompt before anything that differs between chats", async () => {
    const builder = await signedInApi(idp, "builder");
    const { provider, newChat } = await personalChatsOf(
      builder.userId,
      says("Hello."),
      says("Hello again.")
    );
    const first = await newChat();
    const second = await newChat();

    await first.ask("Hi");
    await second.ask("Hi");

    const [one, two] = provider.requests.map(({ body }) => sent(body));
    if (one === undefined || two === undefined) {
      throw new Error("Each chat asked the model once.");
    }
    const guides = Object.values(guideFiles).map(bodyOf);
    const docsAt = one.system.indexOf("<docs>");
    const docsEnd = one.system.indexOf("</docs>");
    expect({
      guides: guides.length > 0,
      everyGuide: guides.every((guide) => one.system.includes(guide)),
      // Right after the instructions, before the chat's own APIs, memory
      // and skills: the same prefix in every chat that builds.
      beforeApis: docsAt > 0 && docsEnd < one.system.indexOf("<apis>"),
      samePrefix:
        two.system.slice(0, two.system.indexOf("</docs>")) ===
        one.system.slice(0, docsEnd),
      tools: ["searchDocs", "readDocs"].every((name) =>
        one.tools.includes(name)
      ),
      // No reference of the SDK's sources and blueprints to read instead.
      reference: one.system.includes("blueprints/board-page"),
    }).toStrictEqual({
      guides: true,
      everyGuide: true,
      beforeApis: true,
      samePrefix: true,
      tools: true,
      reference: false,
    });
  });

  it("searches and reads this deployment's own docs, and nothing else of its static files", async () => {
    const builder = await signedInApi(idp, "builder");
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      toolStep("searchDocs", { query: "useQuery" }),
      toolStep("readDocs", { path: "/guides/pages" }),
      toolStep("readDocs", {
        path: "/reference/server",
        fromLine: 3,
        toLine: 5,
      }),
      toolStep("readDocs", { path: "/" }),
      toolStep("readDocs", { path: "/inline-hashes.json" }),
      toolStep("readDocs", { path: "/../index.html" }),
      toolStep("readFile", { path: "@grasp-os/sdk/src/server.ts" }),
      says("Read.")
    );
    const { chat, ask } = await newChat();

    await ask("How does a Page read?");

    const [search, page, part, first, hashes, outside, source] =
      await toolResults(stub, chat.id);
    expect({
      search: z
        .array(z.object({ path: z.string(), title: z.string() }))
        .parse(JSON.parse(search?.text ?? "[]"))
        .at(0),
      page: page?.text,
      part: part?.text,
      first: first?.text,
      hashes: {
        isError: hashes?.isError,
        names: hashes?.text.includes("/reference/server"),
      },
      outside: outside?.isError,
      // The SDK's sources are no file the agent reads.
      source: source?.isError,
    }).toStrictEqual({
      search: { path: "/guides/pages", title: "Pages" },
      page: "# Pages\n\nA Page reads with `useQuery`.\n",
      part: "## Functions\n\n### query\n\n[Lines 3 to 5 of 8. Read on with fromLine: 6.]",
      first:
        "# Introduction\n\nGrasp runs Apps and workflows in its own deployment.\n",
      hashes: { isError: true, names: true },
      outside: true,
      source: true,
    });
  });

  it("answers a query nothing in the docs matches with where to look instead", async () => {
    const builder = await signedInApi(idp, "builder");
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      toolStep("searchDocs", { query: "zygomorphic" }),
      says("Nothing.")
    );
    const { chat } = await newChat();

    await stub.ask(chat.id, { text: "Anything on this?", model });

    const [search] = await toolResults(stub, chat.id);
    expect({
      isError: search?.isError,
      reference: search?.text.includes("/reference"),
    }).toStrictEqual({ isError: false, reference: true });
  });
});
