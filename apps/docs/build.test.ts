import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  docsMarkdownFile,
  docsPagesSchema,
  docsSearchIndexFile,
} from "@grasp-os/shared/docs";
import { beforeAll, describe, expect, it } from "vite-plus/test";

// The site the docs' build writes (build.ts), as core serves it at /docs
// (apps/core/src/docs.ts): every inline script, style and `style`
// attribute among the hashes core's policy allows, every link under
// /docs, and nothing written for other hosts. TypeDoc's own checks run in
// the release build.

const root = import.meta.dirname;
const site = path.join(root, "dist");

/** A minute and more: TypeDoc, then Blume. */
const buildTimeout = 300_000;

const files = (): string[] =>
  readdirSync(site, { recursive: true, encoding: "utf-8" });

const pages = (): string[] =>
  files()
    .filter((file) => file.endsWith(".html"))
    .map((file) => readFileSync(path.join(site, file), "utf-8"));

const hashOf = (text: string): string =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** The few entities a `style` attribute's value is escaped with. */
const entities: Readonly<Record<string, string>> = {
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

const unescaped = (value: string): string =>
  value.replaceAll(
    /&(?:quot|#39|lt|gt|amp);/gu,
    (entity) => entities[entity] ?? entity
  );

/** `html`'s inline code, by kind, as a browser hashes it. */
const inlineCode = (html: string) => ({
  scripts: [
    ...html.matchAll(
      /<script(?![^>]*\ssrc=)[^>]*>(?<text>[\s\S]*?)<\/script>/gu
    ),
  ].map((match) => match.groups?.text ?? ""),
  styles: [...html.matchAll(/<style[^>]*>(?<text>[\s\S]*?)<\/style>/gu)].map(
    (match) => match.groups?.text ?? ""
  ),
  styleAttributes: [...html.matchAll(/\sstyle="(?<value>[^"]*)"/gu)].map(
    (match) => unescaped(match.groups?.value ?? "")
  ),
});

describe("the docs' build", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, "build.ts")], {
      cwd: root,
      stdio: "ignore",
    });
  }, buildTimeout);

  it("lists every page's inline scripts, styles and style attributes among the hashes core allows", () => {
    const allowed: unknown = JSON.parse(
      readFileSync(path.join(site, "inline-hashes.json"), "utf-8")
    );
    const kinds = ["scripts", "styles", "styleAttributes"] as const;
    const missing = kinds.flatMap((kind) => {
      const listed: unknown =
        typeof allowed === "object" && allowed !== null
          ? Reflect.get(allowed, kind)
          : undefined;
      const hashes = new Set(
        pages().flatMap((html) => inlineCode(html)[kind].map(hashOf))
      );
      return [...hashes]
        .filter((hash) => !(Array.isArray(listed) && listed.includes(hash)))
        .map((hash) => `${kind}: ${hash}`);
    });

    expect(inlineCode(pages().join("")).scripts.length).toBeGreaterThan(0);
    expect(missing).toStrictEqual([]);
  });

  it("links every page and file under /docs", () => {
    const links = pages().flatMap((html) =>
      [...html.matchAll(/\s(?:href|src)="(?<link>\/[^"]*)"/gu)].map(
        (match) => match.groups?.link ?? ""
      )
    );
    const agentLinks = [
      ...readFileSync(path.join(site, "llms.txt"), "utf-8").matchAll(
        /\]\((?<link>\/[^)]*)\)/gu
      ),
    ].map((match) => match.groups?.link ?? "");

    expect(links.length).toBeGreaterThan(0);
    expect(
      [...links, ...agentLinks].filter(
        (link) => link !== "/docs" && !link.startsWith("/docs/")
      )
    ).toStrictEqual([]);
  });

  it("writes the search index the agent's docs tools read, and each page it lists as Markdown", () => {
    // As core's `searchDocs` and `readDocs` read them (apps/core/src/agent-docs.ts).
    const listed = docsPagesSchema.parse(
      JSON.parse(readFileSync(path.join(site, docsSearchIndexFile), "utf-8"))
    );

    expect(listed.map(({ route }) => route)).toContain("/guides/project");
    expect(
      listed
        .map(({ route }) => docsMarkdownFile(route))
        .filter((file) => !existsSync(path.join(site, file)))
    ).toStrictEqual([]);
  });

  it("writes nothing for other hosts, and no page's source twice", () => {
    expect(
      files().filter(
        (file) =>
          file.endsWith(".mdx") ||
          ["_headers", "vercel.json", "404.json", "404.md"].includes(file)
      )
    ).toStrictEqual([]);
    expect(existsSync(path.join(site, "llms.txt"))).toBeTruthy();
  });
});
