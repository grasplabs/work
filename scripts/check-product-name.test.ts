import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { oldProductNames, readPaths } from "./check-product-name.ts";
import { findOldProductName } from "./lint/old-product-name.ts";

// The product is Grasp Work in everything clients and buyers read
// (GRA-143); its code names stay `grasp-os`. These plant the old name where
// people read it, and where they don't, and check what the checks say.

/** What `vp lint --format json` says, as far as these tests read it. */
const lintReport = z.object({
  diagnostics: z.array(
    z.object({
      code: z.string(),
      filename: z.string(),
      labels: z.array(z.object({ span: z.object({ line: z.number() }) })),
    })
  ),
});

/** What `vp lint` reports for each rule of ours on `files`, planted in the repo for the run. */
const linted = async (
  files: Record<string, string>
): Promise<{ file: string; line: number }[]> => {
  const tag = randomUUID().slice(0, 8);
  const planted = Object.entries(files).map(([path, text]) => ({
    path: path.replace("NAME", `planted-${tag}`),
    text,
  }));
  try {
    await Promise.all(
      planted.map(async ({ path, text }) => {
        await writeFile(path, text);
      })
    );
    // The repo's own, whatever the shell running the tests has on its path.
    const { stdout } = spawnSync(
      "node_modules/.bin/vp",
      ["lint", "--format", "json", ...planted.map(({ path }) => path)],
      { encoding: "utf-8" }
    );
    const { diagnostics } = lintReport.parse(JSON.parse(stdout));
    return diagnostics
      .filter(({ code }) => code === "grasp(no-old-product-name)")
      .map(({ filename, labels }) => ({
        file: filename.replace(`planted-${tag}`, "NAME"),
        line: labels[0]?.span.line ?? 0,
      }));
  } finally {
    await Promise.all(
      planted.map(async ({ path }) => {
        await rm(path, { force: true });
      })
    );
  }
};

describe("the product's old name", () => {
  it.each([
    ["Welcome to Grasp OS", "Grasp OS"],
    ["grasp os", "grasp os"],
    ["Grasp OS keeps your work", "Grasp OS"],
    ["Grasp\n  OS", "Grasp\n  OS"],
  ])("is found in %j", (text, found) => {
    expect(findOldProductName(text)).toBe(found);
  });

  it.each(["grasp-os", "@grasp-os/ui", "Grasp Work", "Grasp OSes", "graspos"])(
    "is not found in %j",
    (text) => {
      expect(findOldProductName(text)).toBeUndefined();
    }
  );

  it("fails the lint in a string or JSX text people read, never in a comment, a code name or a test", async () => {
    const reported = await linted({
      "apps/web/src/NAME.tsx": [
        "// Grasp OS, in a comment, is for us.",
        'export const title = "Welcome to Grasp OS";',
        "export const Banner = () => <p>Grasp OS is here</p>;",
        'export const route = "/grasp-os";',
        "",
      ].join("\n"),
      "apps/core/src/NAME.ts": [
        "export const subject = `Your Grasp OS invite`;",
        // Escaped, it still reads as the old name.
        "export const escaped = `Grasp\\u0020OS`;",
        "",
      ].join("\n"),
      "apps/web/src/NAME.test.ts": 'export const title = "Grasp OS";\n',
    });
    expect(reported).toStrictEqual([
      { file: "apps/core/src/NAME.ts", line: 1 },
      { file: "apps/core/src/NAME.ts", line: 2 },
      { file: "apps/web/src/NAME.tsx", line: 2 },
      { file: "apps/web/src/NAME.tsx", line: 3 },
    ]);
  });

  it("fails the check in a catalog or page people read, naming where", () => {
    const files = [
      {
        path: "apps/web/src/locales/nl/messages.po",
        text: 'msgid "Welcome"\nmsgstr "Welkom bij Grasp OS"\n',
      },
      { path: "apps/web/index.html", text: "<title>Grasp Work</title>\n" },
      {
        path: "apps/web/src/locales/de/messages.po",
        text: [
          'msgid ""',
          '"Welcome to Grasp "',
          '"OS"',
          'msgstr ""',
          '"Grasp"',
          '"OS"',
          "",
          'msgid "Hello"',
          String.raw`msgstr "Hallo von Grasp\nOS"`,
          "",
          '#~ msgid "Old"',
          '#~ msgstr "Grasp OS"',
          "",
          'msgctxt "Grasp OS menu"',
          'msgid "Open"',
          String.raw`msgstr "Grasp\040OS öffnen"`,
          "",
        ].join("\n"),
      },
      {
        path: "apps/core/blueprints/intake/files/screens/desk.tsx",
        text: "<h1>Grasp OS desk</h1>\n",
      },
      {
        path: "apps/core/src/skills/brief/SKILL.md",
        text: "# Brief\n\nWrite to the person as\nGrasp\n  OS does.\n",
      },
      { path: "apps/core/test/fixtures/page.html", text: "<p>Grasp OS</p>\n" },
      { path: "apps/web/src/routes/index.tsx", text: '"Grasp OS"\n' },
    ];
    const read = new Set(readPaths(files.map(({ path }) => path)));

    expect(
      oldProductNames(files.filter(({ path }) => read.has(path)))
    ).toStrictEqual([
      'apps/web/src/locales/nl/messages.po:2: "Grasp OS"',
      // Wrapped over the catalog's quoted lines, named on the line its
      // field starts; parts join with nothing between them, so "GraspOS"
      // is no name.
      'apps/web/src/locales/de/messages.po:1: "Grasp OS"',
      // An escaped newline reads as one; an obsolete entry is no one's.
      'apps/web/src/locales/de/messages.po:9: "Grasp\\nOS"',
      // An octal escape reads as its character; a context is never shown.
      'apps/web/src/locales/de/messages.po:16: "Grasp OS"',
      // A built-in App's screen, which the root lint leaves alone.
      'apps/core/blueprints/intake/files/screens/desk.tsx:1: "Grasp OS"',
      // Wrapped across lines, named where it starts.
      'apps/core/src/skills/brief/SKILL.md:4: "Grasp\\n  OS"',
    ]);
  });
});
