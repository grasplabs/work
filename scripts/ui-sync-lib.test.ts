/**
 * What packages/ui must hold for its pin (ui-sync-lib.ts): the added items
 * with what they build on, and each way the package can leave Damsko's.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  carry,
  differences,
  expectedOf,
  overdue,
  parseRegistry,
  proposal,
} from "./ui-sync-lib.ts";
import type { LocalChange } from "./ui-sync-lib.ts";

const registry = parseRegistry(
  JSON.stringify({
    items: [
      {
        name: "lib",
        dependencies: ["@stylexjs/stylex"],
        files: [{ path: "src/lib/utils.ts", target: "~/src/lib/utils.ts" }],
      },
      {
        name: "spinner",
        registryDependencies: ["@damsko/lib"],
        files: [
          {
            path: "src/components/spinner.tsx",
            target: "~/src/components/spinner.tsx",
          },
        ],
      },
      {
        name: "button",
        dependencies: ["@ui-sdk/react"],
        registryDependencies: ["@damsko/lib", "@damsko/spinner"],
        files: [
          {
            path: "src/components/button.tsx",
            target: "~/src/components/button.tsx",
          },
        ],
      },
      {
        name: "fonts",
        files: [
          {
            path: "src/styles/fonts/geist.woff2",
            target: "~/src/styles/fonts/geist.woff2.base64",
          },
        ],
      },
      {
        name: "dialog",
        files: [
          {
            path: "src/components/dialog.tsx",
            target: "~/src/components/dialog.tsx",
          },
        ],
      },
    ],
  })
);

const bytes = (text: string) => new TextEncoder().encode(text);

/** Damsko's files: each holds its own path. */
const damsko = (path: string) => bytes(path);

const inStep = {
  "src/lib/utils.ts": "src/lib/utils.ts",
  "src/components/spinner.tsx": "src/components/spinner.tsx",
  "src/components/button.tsx": "src/components/button.tsx",
};

const named = { "@stylexjs/stylex": "catalog:", "@ui-sdk/react": "catalog:" };

const installed = (
  files: Record<string, string>,
  dependencies: Record<string, string> = named
) => ({
  read: (path: string) =>
    Object.hasOwn(files, path) ? bytes(files[path] ?? "") : undefined,
  sources: Object.keys(files),
  dependencies,
});

describe("what packages/ui must hold", () => {
  it("is each added item and every item it builds on", () => {
    const expected = expectedOf(registry, ["button"]);
    expect([...expected.files.keys()].toSorted()).toStrictEqual([
      "src/components/button.tsx",
      "src/components/spinner.tsx",
      "src/lib/utils.ts",
    ]);
    expect([...expected.dependencies].toSorted()).toStrictEqual([
      "@stylexjs/stylex",
      "@ui-sdk/react",
    ]);
  });

  it("holds a font as the font, not as the text it travels as", () => {
    const expected = expectedOf(registry, ["fonts"]);
    const font = "src/styles/fonts/geist.woff2";
    expect([...expected.files.keys()]).toStrictEqual([font]);
    expect(
      differences(expected, damsko, installed({ [font]: font }, {}))
    ).toStrictEqual([]);
    expect(
      differences(
        expected,
        damsko,
        installed({ [`${font}.base64`]: "packed" }, {})
      ).toSorted()
    ).toStrictEqual([
      `${font} is missing`,
      `${font}.base64 is no file of the installed items`,
    ]);
  });

  it("refuses an item the registry does not have", () => {
    expect(() => expectedOf(registry, ["tag"])).toThrow(/no item "tag"/u);
  });

  it("finds nothing when every file is Damsko's", () => {
    expect(
      differences(expectedOf(registry, ["button"]), damsko, installed(inStep))
    ).toStrictEqual([]);
  });

  it("names a file edited in place, one missing and one that is not Damsko's", () => {
    const { "src/components/spinner.tsx": _, ...rest } = inStep;
    expect(
      differences(
        expectedOf(registry, ["button"]),
        damsko,
        installed({
          ...rest,
          "src/components/button.tsx": "edited",
          "src/components/dialog.tsx": "src/components/dialog.tsx",
        })
      ).toSorted()
    ).toStrictEqual([
      "src/components/button.tsx differs from Damsko's src/components/button.tsx",
      "src/components/dialog.tsx is no file of the installed items",
      "src/components/spinner.tsx is missing",
    ]);
  });

  it("names a package the CLI wrote a version for", () => {
    expect(
      differences(
        expectedOf(registry, ["lib"]),
        damsko,
        installed(
          { "src/lib/utils.ts": "src/lib/utils.ts" },
          { "@stylexjs/stylex": "^0.19.2" }
        )
      )
    ).toStrictEqual([
      'package.json: @stylexjs/stylex must be a dependency at "catalog:", and is "^0.19.2"',
    ]);
  });
});

/** A change listed in local-changes.json. */
const listed = (path: string, since = "2026-11-20"): LocalChange => ({
  path,
  reason: "A feature needs it before Damsko has it.",
  since,
});

describe("a change made here on purpose", () => {
  const expected = expectedOf(registry, ["button"]);

  it("passes where local-changes.json lists it: a file edited, one added and one removed", () => {
    const { "src/components/spinner.tsx": _, ...rest } = inStep;
    expect(
      differences(
        expected,
        damsko,
        installed({
          ...rest,
          "src/components/button.tsx": "edited",
          "src/lib/extra.ts": "added",
        }),
        [
          listed("src/components/button.tsx"),
          listed("src/lib/extra.ts"),
          listed("src/components/spinner.tsx"),
        ]
      )
    ).toStrictEqual([]);
  });

  it("still fails beside it for a difference not listed", () => {
    expect(
      differences(
        expected,
        damsko,
        installed({
          ...inStep,
          "src/components/button.tsx": "edited",
          "src/lib/utils.ts": "edited too",
        }),
        [listed("src/components/button.tsx")]
      )
    ).toStrictEqual([
      "src/lib/utils.ts differs from Damsko's src/lib/utils.ts",
    ]);
  });

  it("fails once the listed file is Damsko's again, or gone", () => {
    expect(
      differences(expected, damsko, installed(inStep), [
        listed("src/components/button.tsx"),
        listed("src/lib/extra.ts"),
      ])
    ).toStrictEqual([
      "local-changes.json lists src/components/button.tsx, which no longer differs from Damsko's: remove the entry",
      "local-changes.json lists src/lib/extra.ts, which no longer differs from Damsko's: remove the entry",
    ]);
  });

  it("is named after two weeks, and never fails for it", () => {
    const today = new Date("2026-12-10T12:00:00Z");
    expect(
      overdue(
        [
          listed("src/components/button.tsx", "2026-11-20"),
          {
            ...listed("src/lib/utils.ts", "2026-11-20"),
            pullRequest: "https://github.com/grasplabs/damsko/pull/50",
          },
          listed("src/components/spinner.tsx", "2026-12-01"),
        ],
        today
      )
    ).toStrictEqual([
      "local-changes.json: src/components/button.tsx has differed from Damsko's since 2026-11-20 with no pull request there (vp run ui:propose)",
      "local-changes.json: src/lib/utils.ts has differed from Damsko's since 2026-11-20; once https://github.com/grasplabs/damsko/pull/50 merges, move the pin there (vp run ui:update <commit>)",
    ]);
  });
});

const lines = (...each: string[]) => bytes(`${each.join("\n")}\n`);
const text = (content: Uint8Array | undefined) =>
  content === undefined ? undefined : new TextDecoder().decode(content);

describe("a listed change at a new pin", () => {
  const pinned = lines("one", "two", "three", "four", "five");
  const ours = lines("one", "TWO", "three", "four", "five");

  it("is dropped once Damsko's file is the same", () => {
    expect(carry({ was: pinned, now: ours, ours })).toStrictEqual({
      kind: "dropped",
    });
  });

  it("is kept as it was where Damsko left the file alone", () => {
    expect(carry({ was: pinned, now: pinned, ours })).toStrictEqual({
      kind: "kept",
      content: ours,
    });
  });

  it("is applied again on top of Damsko's own change elsewhere in the file", () => {
    const carried = carry({
      was: pinned,
      now: lines("one", "two", "three", "four", "FIVE"),
      ours,
    });
    expect(carried.kind).toBe("kept");
    expect(text("content" in carried ? carried.content : undefined)).toBe(
      "one\nTWO\nthree\nfour\nFIVE\n"
    );
  });

  it("is a conflict, marked by git, where Damsko changed the same lines", () => {
    const carried = carry({
      was: pinned,
      now: lines("one", "Two", "three", "four", "five"),
      ours,
    });
    expect(carried.kind).toBe("conflict");
    expect(text("content" in carried ? carried.content : undefined)).toContain(
      "<<<<<<< here\nTWO\n"
    );
  });

  it("keeps a file added here, and a file removed here stays removed", () => {
    expect(carry({ ours })).toStrictEqual({
      kind: "kept",
      content: ours,
    });
    expect(carry({ was: pinned, now: pinned })).toStrictEqual({
      kind: "kept",
      content: undefined,
    });
  });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf-8" }
  );
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  }
  return run.stdout;
};

/** Damsko's tree at a pin, as a checkout of one commit. */
const checkout = (folder: string) => {
  for (const file of ["src/components/button.tsx", "src/lib.ts"]) {
    mkdirSync(nodePath.dirname(nodePath.join(folder, file)), {
      recursive: true,
    });
    writeFileSync(nodePath.join(folder, file), `${file}\n`);
  }
  git(folder, "init", "--quiet");
  git(folder, "add", "--all");
  git(folder, "commit", "--quiet", "--message", "pin");
};

describe("the listed changes proposed to Damsko", () => {
  it("is one patch that makes Damsko's files ours, each at its own path: edited, added and removed", () => {
    const folder = mkdtempSync(nodePath.join(tmpdir(), "ui-sync-test-"));
    try {
      const pinned = nodePath.join(folder, "damsko");
      checkout(pinned);
      const patch = proposal(
        pinned,
        new Map([
          ["src/components/button.tsx", bytes("edited here\n")],
          ["src/components/badge.tsx", bytes("added here\n")],
          ["src/lib.ts", undefined],
        ])
      );

      const fresh = nodePath.join(folder, "fresh");
      checkout(fresh);
      writeFileSync(nodePath.join(folder, "local.patch"), patch);
      git(fresh, "apply", nodePath.join(folder, "local.patch"));
      const read = (file: string) =>
        readFileSync(nodePath.join(fresh, file), "utf-8");
      expect(read("src/components/button.tsx")).toBe("edited here\n");
      expect(read("src/components/badge.tsx")).toBe("added here\n");
      expect(
        git(fresh, "status", "--porcelain").split("\n").toSorted()
      ).toStrictEqual([
        "",
        " D src/lib.ts",
        " M src/components/button.tsx",
        "?? src/components/badge.tsx",
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
