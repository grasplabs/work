import { describe, expect, it } from "vite-plus/test";

import { clientOrigin } from "./sign-in-config.ts";
import { routed } from "./sign-in.ts";

// The SDK docs each deployment serves at /docs: the site its release
// carries among the frontend's files (the global setup builds it as
// core's build does), for people and, as Markdown, for the agent.

/** A page's inline scripts' text, as a policy hashes them. */
const inlineScripts = (html: string): string[] =>
  [
    ...html.matchAll(
      /<script(?![^>]*\ssrc=)[^>]*>(?<text>[\s\S]*?)<\/script>/gu
    ),
  ].map((match) => match.groups?.text ?? "");

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return `'sha256-${btoa(String.fromCodePoint(...new Uint8Array(digest)))}'`;
};

/** A directive's sources, from a response's policy. */
const sourcesOf = (response: Response, directive: string): string[] =>
  (response.headers.get("content-security-policy") ?? "")
    .split(";")
    .map((part) => part.trim().split(/\s+/u))
    .find(([name]) => name === directive)
    ?.slice(1) ?? [];

/** A file of the docs, as the agent reads it: its status, type and text. */
const read = async (path: string) => {
  const response = await routed(path);
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
};

describe("the SDK docs", () => {
  it("serves its pages", async () => {
    const page = await read("/docs/guides/pages/");

    expect(page.status).toBe(200);
    expect(page.type).toContain("text/html");
    expect(page.text).toContain("useQuery");
  });

  it("runs a page's own inline scripts, and no other script but the docs' files", async () => {
    const response = await routed("/docs/guides/pages/");
    const scripts = sourcesOf(response, "script-src");
    const inline = inlineScripts(await response.text());
    const hashes = await Promise.all(inline.map(sha256));

    expect(inline.length).toBeGreaterThan(0);
    expect(scripts).toStrictEqual(expect.arrayContaining(hashes));
    expect(
      scripts.filter((source) => !source.startsWith("'sha256-"))
    ).toStrictEqual([`${clientOrigin}/docs/_astro/`]);
  });

  it("serves llms.txt, listing every guide", async () => {
    const index = await read("/docs/llms.txt");

    expect(index.status).toBe(200);
    expect(index.type).toContain("text/plain");
    expect(index.text).toContain("(/docs/guides/server-functions)");
  });

  it("serves each page's Markdown, the generated API reference's too", async () => {
    const guide = await read("/docs/guides/server-functions.md");
    const reference = await read("/docs/reference/react.md");

    expect(guide.status).toBe(200);
    expect(guide.type).toContain("text/markdown");
    expect(guide.text).toContain("export const open = query({");
    // Generated from the SDK the release was built from.
    expect(reference.status).toBe(200);
    expect(reference.text).toContain("useQuery");
  });

  it("answers a path the docs don't have with their own 404, never the frontend", async () => {
    const page = await read("/docs/guides/nothing-here/");
    const markdown = await read("/docs/guides/nothing-here.md");

    expect([page.status, markdown.status]).toStrictEqual([404, 404]);
    expect(page.text).not.toContain('<div id="root">');
    expect(markdown.text).not.toContain('<div id="root">');
  });
});
