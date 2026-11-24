import { describe, expect, it } from "vite-plus/test";

import { clientOrigin } from "./sign-in-config.ts";
import { routed } from "./sign-in.ts";

// The SDK docs each deployment serves at /docs, from the release's static
// files: here a stand-in of the docs' build (fixtures/assets/docs), whose
// own output the docs' tests check (apps/docs/build.test.ts).

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
  it("serves a page at the address its links name, without a redirect", async () => {
    const page = await read("/docs/guides/pages");

    expect(page.status).toBe(200);
    expect(page.type).toContain("text/html");
    expect(page.text).toContain("useQuery");
  });

  it("runs a page's own inline scripts, and no other script but the docs' files", async () => {
    const response = await routed("/docs/guides/pages");
    const scripts = sourcesOf(response, "script-src");
    const hashes = await Promise.all(
      inlineScripts(await response.text()).map(sha256)
    );

    expect(hashes.length).toBeGreaterThan(0);
    expect(scripts).toStrictEqual(expect.arrayContaining(hashes));
    expect(
      scripts.filter((source) => !source.startsWith("'sha256-"))
    ).toStrictEqual([`${clientOrigin}/docs/_astro/`]);
  });

  it("keeps the docs' policy on a page a browser revalidates", async () => {
    const page = await routed("/docs/guides/pages");
    await page.body?.cancel();
    const etag = page.headers.get("etag") ?? "";
    const revalidated = await routed("/docs/guides/pages", {
      headers: { "if-none-match": etag },
    });

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("content-security-policy")).toBe(
      page.headers.get("content-security-policy")
    );
  });

  it("serves llms.txt and each page's Markdown, for the agent", async () => {
    const index = await read("/docs/llms.txt");
    const guide = await read("/docs/guides/pages.md");

    expect(index.text).toContain("(/docs/guides/pages)");
    expect(index.type).toContain("text/plain");
    expect(guide.text).toContain("useQuery");
    expect(guide.type).toContain("text/markdown");
  });

  it("answers a path the docs don't have with their own 404, never the frontend", async () => {
    const page = await read("/docs/guides/nothing-here");
    const markdown = await read("/docs/guides/nothing-here.md");

    expect([page.status, markdown.status]).toStrictEqual([404, 404]);
    expect(page.text).toContain("Page not found");
    expect(markdown.text).not.toContain('<div id="root">');
  });
});
