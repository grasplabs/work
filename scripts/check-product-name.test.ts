import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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

/**
 * How long the lint test may take. It runs the repo's own `vp lint`, as
 * `vp check` does: type-aware and type-checking, so it builds the
 * TypeScript programs of both apps the planted files sit in, with every JS
 * plugin loaded. About a second on an idle machine, and well past the
 * default 5 s on a CI runner shared with the other test shards. The
 * config's file scoping is what the test checks, so no lighter run will do.
 */
const lintTimeoutMs = 60_000;

/**
 * What `command` printed, once it exited, whatever its exit code. Killed
 * once `signal` aborts (its test timed out), so its caller still cleans up.
 */
const stdoutOf = async (
  command: string,
  args: string[],
  signal: AbortSignal
): Promise<string> => {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "ignore"],
    signal,
  });
  child.stdout.setEncoding("utf-8");
  let stdout = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  // Killed, this rejects at once, without waiting for its streams to
  // close: a process it started may hold them open, and the test runner
  // stops soon after a timeout, so the planted files go first. What the
  // killed lint still reads of them no one reads.
  await once(child, "close");
  return stdout;
};

/** What `vp lint` reports for each rule of ours on `files`, planted in the repo for the run. */
const linted = async (
  files: Record<string, string>,
  signal: AbortSignal
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
    // Not spawnSync: the worker waits on the lint without blocking.
    const stdout = await stdoutOf(
      "node_modules/.bin/vp",
      ["lint", "--format", "json", ...planted.map(({ path }) => path)],
      signal
    );
    const { diagnostics } = lintReport.parse(JSON.parse(stdout));
    return (
      diagnostics
        .filter(({ code }) => code === "grasp(no-old-product-name)")
        .map(({ filename, labels }) => ({
          file: filename.replace(`planted-${tag}`, "NAME"),
          line: labels[0]?.span.line ?? 0,
        }))
        // In file and line order: oxlint reports files as its threads finish.
        .toSorted(
          (one, other) =>
            one.file.localeCompare(other.file) || one.line - other.line
        )
    );
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

  it(
    "fails the lint in a string or JSX text people read, never in a comment, a code name or a test",
    {
      timeout: lintTimeoutMs,
    },
    async ({ signal }) => {
      const reported = await linted(
        {
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
        },
        signal
      );
      expect(reported).toStrictEqual([
        { file: "apps/core/src/NAME.ts", line: 1 },
        { file: "apps/core/src/NAME.ts", line: 2 },
        { file: "apps/web/src/NAME.tsx", line: 2 },
        { file: "apps/web/src/NAME.tsx", line: 3 },
      ]);
    }
  );

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
        path: "apps/core/blueprints/intake/blueprint.json",
        text: '{\n  "name": "Intake",\n  "description": "Intake for Grasp OS"\n}\n',
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
      // The manifest that names and describes a built-in to builders.
      'apps/core/blueprints/intake/blueprint.json:3: "Grasp OS"',
      // Wrapped across lines, named where it starts.
      'apps/core/src/skills/brief/SKILL.md:4: "Grasp\\n  OS"',
    ]);
  });
});
