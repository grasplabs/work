import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { escapeHtml, reportHtml } from "./report.ts";
import { parityRoutes } from "./routes.ts";

// The parity tool's own logic (GRA-493): the route map holds only pages
// Grasp OS has, each once, and the report shows every pair, or why one is
// missing, with nothing a page's name or an error can inject.

const root = path.join(import.meta.dirname, "../..");

/** Every full path the frontend's router knows (routeTree.gen.ts). */
const graspPaths = (): Set<string> => {
  const tree = readFileSync(
    path.join(root, "apps/web/src/routeTree.gen.ts"),
    "utf-8"
  );
  const block = /interface FileRoutesByFullPath \{(?<body>[^}]*)\}/u.exec(tree)
    ?.groups?.body;
  return new Set(
    [...(block ?? "").matchAll(/^\s*'(?<path>[^']+)':/gmu)].map(
      (match) => match.groups?.path ?? ""
    )
  );
};

const fileName = /^[a-z0-9-]+$/u;

describe("the parity tool", () => {
  it("maps each page once, to a route Grasp OS has, by a name a file can take", () => {
    const known = graspPaths();
    const names = parityRoutes.map(({ name }) => name);
    expect({
      unknown: parityRoutes
        // An index route's full path ends in a slash (`/apps/`).
        .filter(({ grasp }) => !known.has(grasp) && !known.has(`${grasp}/`))
        .map(({ grasp }) => grasp),
      repeated: names.filter((name, at) => names.indexOf(name) !== at),
      badNames: names.filter((name) => !fileName.test(name)),
      relative: parityRoutes
        .filter(
          ({ prototype, grasp }) =>
            !prototype.startsWith("/") || !grasp.startsWith("/")
        )
        .map(({ name }) => name),
    }).toStrictEqual({ unknown: [], repeated: [], badNames: [], relative: [] });
  });

  it("shows each pair side by side, says why a shot is missing, and escapes what it prints", () => {
    const html = reportHtml(
      [
        {
          name: "inbox",
          prototypePath: "/inbox",
          graspPath: "/inbox?<script>",
          pairs: [
            {
              width: 1440,
              theme: "light",
              prototype: { file: "inbox/1440-light-prototype.png" },
              grasp: { file: "inbox/1440-light-grasp.png" },
            },
            {
              width: 390,
              theme: "dark",
              prototype: { file: "inbox/390 dark.png" },
              grasp: { missing: 'answered 500: <img src=x onerror="1">' },
            },
          ],
        },
      ],
      { commit: "ddd235d4", takenAt: "2026-10-20T07:00:00.000Z" }
    );
    expect({
      images: [...html.matchAll(/<img [^>]*src="(?<src>[^"]+)"/gu)].map(
        (match) => match.groups?.src
      ),
      missing: html.includes(
        "answered 500: &lt;img src=x onerror=&quot;1&quot;&gt;"
      ),
      injected: html.includes("<script>") || html.includes("<img src=x"),
      headings: [...html.matchAll(/<h3>(?<label>[^<]+)<\/h3>/gu)].map(
        (match) => match.groups?.label
      ),
      commit: html.includes("<code>ddd235d4</code>"),
    }).toStrictEqual({
      images: [
        "inbox/1440-light-prototype.png",
        "inbox/1440-light-grasp.png",
        "inbox/390%20dark.png",
      ],
      missing: true,
      injected: false,
      headings: ["1440 px · light", "390 px · dark"],
      commit: true,
    });
    expect(escapeHtml(`a&b"'`)).toBe("a&amp;b&quot;&#39;");
  });
});
