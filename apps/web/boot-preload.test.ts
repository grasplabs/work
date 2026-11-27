import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { importedFrom, preloadScript } from "./boot-preload.ts";

// The script index.html runs to preload the routes main.tsx then loads
// (src/boot-path.ts): run in a page of its own, it asks for the
// interview's files at an interview link, and the app's anywhere else.

const files = {
  app: ["/assets/app-routes.js", "/assets/shell.js"],
  interview: ["/assets/interview-routes.js", "/assets/mark.js"],
};

/** What the script preloads in a page at `pathname`. */
const preloaded = (pathname: string): unknown[] => {
  const head: { href?: unknown; rel?: unknown }[] = [];
  runInNewContext(preloadScript(files), {
    document: {
      createElement: () => ({}),
      head: {
        append: (link: { href?: unknown; rel?: unknown }) => {
          head.push(link);
        },
      },
    },
    location: { pathname },
  });
  expect(head.every(({ rel }) => rel === "modulepreload")).toBeTruthy();
  return head.map(({ href }) => href);
};

describe("the routes preload", () => {
  it("preloads the interview's files at an interview link", () => {
    expect(preloaded("/interview")).toStrictEqual(files.interview);
  });

  it("preloads the app's files anywhere else", () => {
    expect(preloaded("/")).toStrictEqual(files.app);
    expect(preloaded("/setup")).toStrictEqual(files.app);
  });
});

/** A built chunk and what it imports. */
const chunk = (fileName: string, imports: string[]) => ({ fileName, imports });

describe(importedFrom, () => {
  it("follows every static import once, however deep", () => {
    const chunks = new Map(
      [
        chunk("a.js", ["b.js", "c.js"]),
        chunk("b.js", ["c.js"]),
        chunk("c.js", ["a.js"]),
        chunk("d.js", []),
      ].map((each) => [each.fileName, each])
    );
    const start = chunks.get("a.js");
    if (start === undefined) {
      throw new Error("no start");
    }

    expect(importedFrom(start, chunks, "/assets/").toSorted()).toStrictEqual([
      "/assets/a.js",
      "/assets/b.js",
      "/assets/c.js",
    ]);
  });
});
