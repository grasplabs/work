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
// than this deployment's own docs (a newer version elsewhere, another of
// core's static files by a path it made up, or the frontend's page in
// place of one the release lacks); the guides reach the model past what
// differs between chats, so no chat's cache serves another; or everyone
// pays for thousands of tokens of docs, builder or not.
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
  system: z.array(
    z.object({
      text: z.string(),
      cache_control: z.object({ type: z.string() }).optional(),
    })
  ),
  tools: z.array(z.object({ name: z.string() })),
});

/** A request's system prompt, whole and as its blocks, and the tools it offered. */
const sent = (body: unknown) => {
  const { system, tools } = requestSchema.parse(body);
  return {
    blocks: system,
    system: system.map(({ text }) => text).join("\n"),
    tools: tools.map(({ name }) => name),
  };
};

const hitsSchema = z.array(
  z.object({ path: z.string(), title: z.string(), lines: z.array(z.string()) })
);

describe("the docs the chat's agent builds from", () => {
  it("carries every guide of the docs, as written, in a system block of its own that every builder's chat shares and caches", async () => {
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
    const [shared, rest] = one.blocks;
    expect({
      guides: guides.length > 0,
      everyGuide: guides.every(
        (guide) => shared?.text.includes(guide) === true
      ),
      // The instructions and the docs, cached on their own; the chat's
      // APIs, memory and skills after them.
      sharedEnds: shared?.text.endsWith("</docs>"),
      sharedCached: shared?.cache_control !== undefined,
      restHasApis: rest?.text.includes("<apis>"),
      samePrefix: two.blocks[0]?.text === shared?.text,
      tools: ["searchDocs", "readDocs"].every((name) =>
        one.tools.includes(name)
      ),
      // No reference of the SDK's sources and blueprints to read instead.
      reference: one.system.includes("blueprints/board-page"),
    }).toStrictEqual({
      guides: true,
      everyGuide: true,
      sharedEnds: true,
      sharedCached: true,
      restHasApis: true,
      samePrefix: true,
      tools: true,
      reference: false,
    });
  });

  it("gives no docs to someone who doesn't build", async () => {
    const user = await signedInApi(idp, "user");
    const { provider, newChat } = await personalChatsOf(
      user.userId,
      says("Hello.")
    );
    const { ask } = await newChat();

    await ask("Hi");

    const [request] = provider.requests.map(({ body }) => sent(body));
    expect({
      docs: request?.system.includes("<docs>"),
      tools: request?.tools.filter((name) => name.endsWith("Docs")),
    }).toStrictEqual({ docs: false, tools: [] });
  });

  it("searches and reads this deployment's own docs, by their paths or links, and nothing else of its static files", async () => {
    const builder = await signedInApi(idp, "builder");
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      toolStep("searchDocs", { query: "query reads" }),
      toolStep("readDocs", {
        path: "/reference/server",
        fromLine: 3,
        toLine: 5,
      }),
      // The link as the page writes it.
      toolStep("readDocs", { path: "/docs/guides/pages#reading" }),
      toolStep("readDocs", { path: "/" }),
      toolStep("readDocs", { path: "/guides/unwritten" }),
      toolStep("readDocs", { path: "/inline-hashes.json" }),
      toolStep("readDocs", { path: "/../index.html" }),
      toolStep("readFile", { path: "@grasp-os/runtime/src/server.ts" }),
      says("Read.")
    );
    const { chat, ask } = await newChat();

    await ask("How does a Page read?");

    const [search, part, linked, first, unwritten, hashes, outside, source] =
      await toolResults(stub, chat.id);
    expect({
      search: hitsSchema
        .parse(JSON.parse(search?.text ?? "[]"))
        .find(({ path }) => path === "/reference/server"),
      part: part?.text,
      linked: linked?.text,
      first: first?.text,
      // Never the frontend's page in place of one the release lacks.
      unwritten: {
        isError: unwritten?.isError,
        frontend: unwritten?.text.includes("<html"),
      },
      hashes: {
        isError: hashes?.isError,
        names: hashes?.text.includes("/reference/server"),
      },
      outside: outside?.isError,
      // The SDK's sources are no file the agent reads.
      source: source?.isError,
    }).toStrictEqual({
      search: {
        path: "/reference/server",
        title: "@grasp-os/runtime/server",
        lines: [
          "5: ### query",
          "7: Declares a query: a server function that reads, as [a Page](/docs/guides/pages#reading) calls it.",
        ],
      },
      part: "## Functions\n\n### query\n\n[Lines 3 to 5 of 8. Read on with fromLine: 6.]",
      linked: "# Pages\n\nA Page reads with `useQuery`.\n",
      first:
        "# Introduction\n\nGrasp runs Apps and workflows in its own deployment.\n",
      unwritten: { isError: true, frontend: false },
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
