/**
 * What packages/ui must hold for its pin (ui-sync-lib.ts): the added items
 * with what they build on, and each way the package can leave Damsko's.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import {
  carry,
  damskoLicence,
  damskoNotices,
  differences,
  expectedOf,
  fetchDamsko,
  fetchFor,
  localChangesSchema,
  movedNotice,
  noticeDifference,
  overdue,
  parseRegistry,
  pinSchema,
  proposal,
  readWithin,
  removeWithin,
  serveFolder,
  treeOf,
  updateTree,
  within,
  writeWithin,
} from "./ui-sync-lib.ts";
import type { DamskoAt, LocalChange } from "./ui-sync-lib.ts";

/** A folder of the running test's own, removed after it. */
const scratchFolder = (): string => {
  const created = mkdtempSync(nodePath.join(tmpdir(), "ui-sync-test-"));
  onTestFinished(() => {
    rmSync(created, { recursive: true, force: true });
  });
  return created;
};

/** Writes each file under `root`, with its folders. */
const plant = (root: string, files: Record<string, string>): void => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(nodePath.dirname(nodePath.join(root, file)), { recursive: true });
    writeFileSync(nodePath.join(root, file), content);
  }
};

/** Every file under `root`, with its content: what a test compares before and after. */
const snapshot = (root: string): Record<string, string> => {
  const files: Record<string, string> = {};
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const file = nodePath.join(entry.parentPath, entry.name);
      files[nodePath.relative(root, file).split(nodePath.sep).join("/")] =
        readFileSync(file, "utf-8");
    }
  }
  return files;
};

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
  links: [],
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

  it("names the packages an item builds with too, its dev dependencies", () => {
    const withTypes = parseRegistry(
      JSON.stringify({
        items: [
          {
            name: "code-block",
            dependencies: ["prismjs"],
            devDependencies: ["@types/prismjs"],
            files: [
              {
                path: "src/components/code-block.tsx",
                target: "~/src/components/code-block.tsx",
              },
            ],
          },
        ],
      })
    );
    const expected = expectedOf(withTypes, ["code-block"]);
    expect([...expected.dependencies].toSorted()).toStrictEqual([
      "@types/prismjs",
      "prismjs",
    ]);
    const file = "src/components/code-block.tsx";
    expect(
      differences(
        expected,
        damsko,
        installed({ [file]: file }, { prismjs: "catalog:" })
      )
    ).toStrictEqual([
      'package.json: @types/prismjs must be a dependency at "catalog:", and is undefined',
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

  it("fails once the listed file is Damsko's again, and for a file that never was", () => {
    expect(
      differences(expected, damsko, installed(inStep), [
        listed("src/components/button.tsx"),
        listed("src/lib/extra.ts"),
      ])
    ).toStrictEqual([
      "local-changes.json lists src/components/button.tsx, which no longer differs from Damsko's: remove the entry",
      "local-changes.json lists src/lib/extra.ts, which neither Damsko's items nor packages/ui has: remove the entry",
    ]);
  });

  it("fails for a listed file still holding git's conflict markers, by file and line", () => {
    const resolved = "one\nTWO\nthree\n";
    const conflicted =
      "one\n<<<<<<< here\nTWO\n=======\nTwo\n>>>>>>> Damsko\nthree\n";
    expect(
      differences(
        expected,
        damsko,
        installed({
          ...inStep,
          "src/components/button.tsx": conflicted,
          "src/lib/extra.ts":
            "a\r\n<<<<<<< here\r\nb\r\n||||||| pinned\r\nbase\r\n=======\r\nc\r\n>>>>>>> Damsko\r\n",
        }),
        [listed("src/components/button.tsx"), listed("src/lib/extra.ts")]
      )
    ).toStrictEqual(
      [
        "src/components/button.tsx:2",
        "src/components/button.tsx:4",
        "src/components/button.tsx:6",
        "src/lib/extra.ts:2",
        "src/lib/extra.ts:4",
        "src/lib/extra.ts:6",
        "src/lib/extra.ts:8",
      ].map(
        (line) =>
          `${line} holds one of git's conflict markers: resolve the conflict, keeping what the change here needs`
      )
    );
    // Eight of a sign, one inside a line, a line of `=======` alone (in a
    // template string) and markers out of git's order are none.
    expect(
      differences(
        expected,
        damsko,
        installed({
          ...inStep,
          "src/components/button.tsx": `${resolved}========\nconst arrow = "<<<<<<< x";\nconst rule = \`\n=======\n\`;\n>>>>>>> b\n=======\n<<<<<<< a\n`,
        }),
        [listed("src/components/button.tsx")]
      )
    ).toStrictEqual([]);
  });

  it("fails for an entry dated after today anywhere, which would put off its warning", () => {
    expect(
      differences(
        expected,
        damsko,
        installed({ ...inStep, "src/components/button.tsx": "edited" }),
        [listed("src/components/button.tsx", "2026-11-25")],
        new Date("2026-11-23T23:00:00Z")
      )
    ).toStrictEqual([
      "local-changes.json dates src/components/button.tsx 2026-11-25, after today: give the day it was listed",
    ]);
    expect(
      differences(
        expected,
        damsko,
        installed({ ...inStep, "src/components/button.tsx": "edited" }),
        // Today, and tomorrow, as it already is east of UTC.
        [
          listed("src/components/button.tsx", "2026-11-23"),
          listed("src/components/button.tsx", "2026-11-24"),
        ],
        new Date("2026-11-23T23:00:00Z")
      )
    ).toStrictEqual([]);
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

  it("is kept as this repository's own, for someone to decide, where Damsko removed the file", () => {
    expect(carry({ was: pinned, ours })).toStrictEqual({
      kind: "removed",
      content: ours,
    });
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

/** Paths that name somewhere else than they seem to, each a way out. */
const escapes = [
  "src/../../../outside.txt",
  "src/components/../../../outside.txt",
  "../outside.txt",
  "/etc/passwd",
  "~/outside.txt",
  "src/~/outside.txt",
  "src/%2e%2e/%2e%2e/outside.txt",
  "src/..%2foutside.txt",
  "src\\..\\..\\outside.txt",
  "src/./components/button.tsx",
  "src//components/button.tsx",
  "src/components/",
  "",
];

/** Why local-changes.json refuses an entry for `path`, if it does. */
const refusal = (path: string) =>
  localChangesSchema.safeParse([
    { path, reason: "A reason.", since: "2026-11-20" },
  ]).error?.issues[0]?.message;

describe("a path from any input", () => {
  it("is let through when plain, and resolved inside its root", () => {
    const root = scratchFolder();
    expect(within(root, "src/components/button.tsx")).toBe(
      nodePath.join(realpathSync(root), "src", "components", "button.tsx")
    );
  });

  it.each(escapes)("refuses %j", (path) => {
    expect(() => within(scratchFolder(), path)).toThrow(/not a plain path/u);
  });

  it("refuses a path through a symbolic link, to a folder or to a file", () => {
    const root = scratchFolder();
    const outside = scratchFolder();
    plant(outside, { "secret.txt": "secret" });
    mkdirSync(nodePath.join(root, "src"));
    symlinkSync(outside, nodePath.join(root, "src", "components"));
    symlinkSync(
      nodePath.join(outside, "secret.txt"),
      nodePath.join(root, "src", "button.tsx")
    );
    expect(() => readWithin(root, "src/components/secret.txt")).toThrow(
      /symbolic link/u
    );
    expect(() => readWithin(root, "src/button.tsx")).toThrow(/symbolic link/u);
    expect(() => {
      removeWithin(root, "src/components/secret.txt");
    }).toThrow(/symbolic link/u);
    expect(() => {
      writeWithin(root, "src/button.tsx", bytes("over"));
    }).toThrow(/symbolic link/u);
    expect(readFileSync(nodePath.join(outside, "secret.txt"), "utf-8")).toBe(
      "secret"
    );
  });

  it.each(escapes)("is refused in local-changes.json: %j", (path) => {
    expect(
      localChangesSchema.safeParse([
        { path, reason: "A reason.", since: "2026-11-20" },
      ]).success
    ).toBeFalsy();
  });

  it("is refused in local-changes.json outside src/, and for a font, with why", () => {
    expect(refusal("package.json")).toMatch(/under packages\/ui\/src\//u);
    expect(refusal("src/styles/fonts/geist-latin.woff2")).toMatch(
      /can't be a font file.*SHA256SUMS.*change them in Damsko/u
    );
    expect(refusal("src/styles/fonts/fonts.css")).toMatch(
      /can't be a font file/u
    );
    expect(refusal("src/components/button.tsx")).toBeUndefined();
  });

  it.each([
    "~/../outside.txt",
    "~/src/../../outside.txt",
    "~/../../etc/passwd",
    "/etc/passwd",
    "~/~/outside.txt",
    "~/src/%2e%2e/outside.txt",
    "~/package.json",
  ])("is refused as a registry's target: %j", (target) => {
    expect(() =>
      expectedOf(
        parseRegistry(
          JSON.stringify({
            items: [{ name: "evil", files: [{ path: "src/evil.ts", target }] }],
          })
        ),
        ["evil"]
      )
    ).toThrow(/not a plain path under ~\/src\//u);
  });

  it("is refused as a registry's own path", () => {
    expect(() =>
      expectedOf(
        parseRegistry(
          JSON.stringify({
            items: [
              {
                name: "evil",
                files: [{ path: "../../etc/passwd", target: "~/src/evil.ts" }],
              },
            ],
          })
        ),
        ["evil"]
      )
    ).toThrow(/not a plain path in Damsko/u);
  });

  it.each(escapes.filter(Boolean))(
    "is refused as a file of the patch, and nothing outside is written or removed: %j",
    (path) => {
      const root = scratchFolder();
      const pinned = nodePath.join(root, "a", "b", "damsko");
      checkout(pinned);
      plant(root, { "outside.txt": "kept" });
      expect(() => proposal(pinned, new Map([[path, bytes("over")]]))).toThrow(
        /not a plain path/u
      );
      expect(() => proposal(pinned, new Map([[path, undefined]]))).toThrow(
        /not a plain path/u
      );
      expect(readFileSync(nodePath.join(root, "outside.txt"), "utf-8")).toBe(
        "kept"
      );
    }
  );
});

describe("a symbolic link under src/", () => {
  it("fails the check, listed or not, and is never followed", () => {
    const ui = scratchFolder();
    const outside = scratchFolder();
    plant(outside, { "button.tsx": "src/components/button.tsx" });
    plant(ui, {
      "src/lib/utils.ts": "src/lib/utils.ts",
      "src/components/spinner.tsx": "src/components/spinner.tsx",
    });
    symlinkSync(
      nodePath.join(outside, "button.tsx"),
      nodePath.join(ui, "src", "components", "button.tsx")
    );
    const tree = treeOf(ui);
    expect(tree.links).toStrictEqual(["src/components/button.tsx"]);
    const found = (local: LocalChange[]) =>
      differences(
        expectedOf(registry, ["button"]),
        damsko,
        { ...tree, dependencies: named },
        local
      );
    const line =
      "src/components/button.tsx is a symbolic link: packages/ui holds Damsko's files themselves, so a link is never followed and can't be listed";
    expect(found([])).toStrictEqual([line]);
    expect(found([listed("src/components/button.tsx")])).toStrictEqual([line]);
  });

  it("fails the check as a linked folder, without reading through it", () => {
    const ui = scratchFolder();
    const outside = scratchFolder();
    plant(outside, {
      "button.tsx": "src/components/button.tsx",
      "spinner.tsx": "src/components/spinner.tsx",
    });
    plant(ui, { "src/lib/utils.ts": "src/lib/utils.ts" });
    symlinkSync(outside, nodePath.join(ui, "src", "components"));
    expect(
      differences(expectedOf(registry, ["button"]), damsko, {
        ...treeOf(ui),
        dependencies: named,
      })
    ).toStrictEqual([
      "src/components is a symbolic link: packages/ui holds Damsko's files themselves, so a link is never followed and can't be listed",
    ]);
  });
});

/** A Damsko of its own: main with two commits, an unmerged branch, a release tag off main. */
const damskoRemote = () => {
  const remote = scratchFolder();
  git(remote, "init", "--quiet", "--initial-branch=main");
  const commit = (message: string) => {
    writeFileSync(nodePath.join(remote, "registry.json"), message);
    git(remote, "add", "--all");
    git(remote, "commit", "--quiet", "--message", message);
    return git(remote, "rev-parse", "HEAD").trim();
  };
  const first = commit("first");
  const merged = commit("merged");
  git(remote, "switch", "--quiet", "--create", "pull-request");
  const unmerged = commit("unmerged");
  git(remote, "switch", "--quiet", "--create", "release", first);
  const released = commit("released");
  git(remote, "tag", "--annotate", "--message", "v0.2.0", "v0.2.0");
  git(remote, "switch", "--quiet", "--create", "other", first);
  const experiment = commit("experiment");
  git(remote, "tag", "experiment");
  // As GitHub serves a pull request's head: a ref that is no branch.
  git(remote, "update-ref", "refs/pull/1/head", unmerged);
  git(remote, "switch", "--quiet", "main");
  git(remote, "branch", "--quiet", "--delete", "--force", "pull-request");
  return { remote, first, merged, unmerged, released, experiment };
};

describe("the pin fetched", () => {
  const fetched = (remote: string, ref: string) => {
    const into = nodePath.join(scratchFolder(), "damsko");
    const commit = fetchDamsko(remote, ref, into);
    return {
      commit,
      registry: readFileSync(nodePath.join(into, "registry.json"), "utf-8"),
    };
  };

  it("is a commit on Damsko's main, its head or before", () => {
    const { remote, first, merged } = damskoRemote();
    expect(fetched(remote, merged)).toStrictEqual({
      commit: merged,
      registry: "merged",
    });
    expect(fetched(remote, first)).toStrictEqual({
      commit: first,
      registry: "first",
    });
  });

  it("is a release tag's commit, by the tag or its commit", () => {
    const { remote, released } = damskoRemote();
    expect(fetched(remote, "v0.2.0")).toStrictEqual({
      commit: released,
      registry: "released",
    });
    expect(fetched(remote, released)).toStrictEqual({
      commit: released,
      registry: "released",
    });
  });

  it("refuses a commit neither merged nor released, and fetches none of its files", () => {
    const { remote, unmerged, experiment } = damskoRemote();
    for (const commit of [unmerged, experiment]) {
      const into = nodePath.join(scratchFolder(), "damsko");
      expect(() => fetchDamsko(remote, commit, into)).toThrow(
        `${commit} is neither on Damsko's main nor a release tag of it`
      );
      expect(existsSync(nodePath.join(into, "registry.json"))).toBeFalsy();
    }
  });

  it("refuses a tag that is no release, a short commit, a branch and a missing tag", () => {
    const { remote, merged } = damskoRemote();
    for (const ref of [
      "experiment",
      merged.slice(0, 12),
      "main",
      "--upload-pack=touch",
    ]) {
      expect(() =>
        fetchDamsko(remote, ref, nodePath.join(scratchFolder(), "damsko"))
      ).toThrow(/neither a commit of Damsko in full .* nor a release tag/u);
    }
    expect(() =>
      fetchDamsko(remote, "v9.9.9", nodePath.join(scratchFolder(), "damsko"))
    ).toThrow("Damsko has no tag v9.9.9.");
  });
});

/** What a checkout of the Damsko of its own holds: its commit's message. */
const registryAt = (folder: string) =>
  readFileSync(nodePath.join(folder, "registry.json"), "utf-8");

describe("the pins a command reads", () => {
  it("holds check and propose to a pin on Damsko's main or a release tag", () => {
    const { remote, merged, unmerged } = damskoRemote();
    expect(
      fetchFor(remote, "check", merged, undefined, scratchFolder())
    ).toMatchObject({
      commit: merged,
    });
    for (const command of ["check", "propose"] as const) {
      expect(() =>
        fetchFor(remote, command, unmerged, merged, scratchFolder())
      ).toThrow(
        `${unmerged} is neither on Damsko's main nor a release tag of it`
      );
    }
  });

  it("lets an update move off a pin that is no longer on main, holding only the new one", () => {
    const { remote, merged, unmerged, experiment } = damskoRemote();
    for (const [from, to] of [
      [unmerged, merged],
      [experiment, "v0.2.0"],
    ] as const) {
      const fetched = fetchFor(remote, "update", from, to, scratchFolder());
      expect(registryAt(fetched.checkout)).toBe(
        to === merged ? "merged" : "released"
      );
      expect(registryAt(fetched.pinned)).toBe(
        from === unmerged ? "unmerged" : "experiment"
      );
    }
    expect(() =>
      fetchFor(remote, "update", merged, unmerged, scratchFolder())
    ).toThrow(
      `${unmerged} is neither on Damsko's main nor a release tag of it`
    );
    // Again at the pin: the pin is the new one, so it is held.
    expect(() =>
      fetchFor(remote, "update", unmerged, undefined, scratchFolder())
    ).toThrow(
      `${unmerged} is neither on Damsko's main nor a release tag of it`
    );
  });
});

describe("the registry served to the CLI", () => {
  it("serves its folder's files, and nothing through a link or outside it", async () => {
    const site = scratchFolder();
    const outside = scratchFolder();
    plant(site, { "r/button.json": '{"name":"button"}' });
    plant(outside, { "secret.json": "secret" });
    symlinkSync(
      nodePath.join(outside, "secret.json"),
      nodePath.join(site, "r", "linked.json")
    );
    symlinkSync(outside, nodePath.join(site, "out"));
    const served = await serveFolder(site);
    onTestFinished(served.close);
    const get = async (path: string) => {
      const response = await fetch(`${served.url}${path}`);
      return { status: response.status, body: await response.text() };
    };
    await expect(get("/r/button.json")).resolves.toStrictEqual({
      status: 200,
      body: '{"name":"button"}',
    });
    const refused = [
      "/r/linked.json",
      "/out/secret.json",
      "/r/%2e%2e/%2e%2e/secret.json",
      "/r/..%2fsecret.json",
      "/r",
      "/r/missing.json",
    ];
    await expect(Promise.all(refused.map(get))).resolves.toStrictEqual(
      refused.map(() => ({ status: 404, body: "" }))
    );
  });
});

/** What a full disk's write or rename throws. */
const ioError = (path: string) => new Error(`EIO: i/o error, ${path}`);

/** An install that writes Damsko's files at the new pin into the stage, as the CLI does. */
const installs =
  (now: DamskoAt) =>
  async (stage: string): Promise<void> => {
    for (const [path, source] of now.expected.files) {
      writeWithin(stage, path, readWithin(now.root, source));
    }
    await Promise.resolve();
  };

describe("the update", () => {
  /** Damsko at a pin, from its files: one item, `kit`, with what it holds. */
  const damskoWith = (files: Record<string, string>): DamskoAt => {
    const root = scratchFolder();
    plant(root, files);
    return {
      root,
      expected: expectedOf(
        parseRegistry(
          JSON.stringify({
            items: [
              {
                name: "kit",
                dependencies: ["@stylexjs/stylex"],
                files: Object.keys(files).map((path) => ({
                  path,
                  target: `~/${path}`,
                })),
              },
            ],
          })
        ),
        ["kit"]
      ),
    };
  };

  /** packages/ui at the old pin, with a listed edit and a listed file in a folder of its own. */
  const setUp = () => {
    const ui = scratchFolder();
    const old = {
      "src/components/button.tsx": "one\ntwo\nthree\nfour\nfive\n",
      "src/lib/utils.ts": "utils\n",
    };
    plant(ui, {
      ...old,
      "src/components/button.tsx": "one\nTWO\nthree\nfour\nfive\n",
      "src/features/save-bar/placement.ts": "added here\n",
      "damsko.json": '{ "commit": "old" }\n',
      "local-changes.json": "[]\n",
    });
    const local = [
      listed("src/components/button.tsx"),
      listed("src/features/save-bar/placement.ts"),
    ];
    return { ui, old: damskoWith(old), local };
  };

  it("installs the new pin, carries each listed change over, a file in a new folder too, and writes the pin", async () => {
    const { ui, old, local } = setUp();
    const now = damskoWith({
      "src/components/button.tsx": "one\ntwo\nthree\nfour\nFIVE\n",
      "src/lib/utils.ts": "utils, newer\n",
      "src/lib/new.ts": "new in Damsko\n",
    });
    const updated = await updateTree({
      ui,
      install: installs(now),
      was: old,
      now,
      local,
      pin: '{ "commit": "new" }\n',
      dependencies: { "@stylexjs/stylex": "catalog:" },
    });
    expect(updated).toStrictEqual({ conflicts: [], removed: [], dropped: [] });
    expect(snapshot(ui)).toStrictEqual({
      "damsko.json": '{ "commit": "new" }\n',
      "local-changes.json": `${JSON.stringify(local, null, 2)}\n`,
      "src/components/button.tsx": "one\nTWO\nthree\nfour\nFIVE\n",
      "src/features/save-bar/placement.ts": "added here\n",
      "src/lib/new.ts": "new in Damsko\n",
      "src/lib/utils.ts": "utils, newer\n",
    });
    expect(readdirSync(ui).toSorted()).toStrictEqual([
      "damsko.json",
      "local-changes.json",
      "src",
    ]);
  });

  it("drops an entry once Damsko's file is the same", async () => {
    const { ui, old, local } = setUp();
    const now = damskoWith({
      "src/components/button.tsx": "one\nTWO\nthree\nfour\nfive\n",
      "src/lib/utils.ts": "utils\n",
    });
    const updated = await updateTree({
      ui,
      install: installs(now),
      was: old,
      now,
      local,
      pin: '{ "commit": "new" }\n',
      dependencies: { "@stylexjs/stylex": "catalog:" },
    });
    expect(updated.dropped).toStrictEqual(["src/components/button.tsx"]);
    expect(
      JSON.parse(readFileSync(nodePath.join(ui, "local-changes.json"), "utf-8"))
    ).toStrictEqual([local[1]]);
  });

  it("leaves a conflict with git's markers, the entry kept, and says so", async () => {
    const { ui, old, local } = setUp();
    const now = damskoWith({
      "src/components/button.tsx": "one\nTwo\nthree\nfour\nfive\n",
      "src/lib/utils.ts": "utils\n",
    });
    const updated = await updateTree({
      ui,
      install: installs(now),
      was: old,
      now,
      local,
      pin: '{ "commit": "new" }\n',
      dependencies: { "@stylexjs/stylex": "catalog:" },
    });
    expect(updated.conflicts).toStrictEqual(["src/components/button.tsx"]);
    const button = readFileSync(
      nodePath.join(ui, "src/components/button.tsx"),
      "utf-8"
    );
    expect(button).toContain("<<<<<<< here\nTWO\n");
    expect(button).toContain(">>>>>>> Damsko\n");
    expect(
      readFileSync(
        nodePath.join(ui, "src/features/save-bar/placement.ts"),
        "utf-8"
      )
    ).toBe("added here\n");
  });

  it("leaves packages/ui exactly as it was when the install fails mid-way", async () => {
    const { ui, old, local } = setUp();
    const before = snapshot(ui);
    const now = damskoWith({ "src/components/button.tsx": "new\n" });
    await expect(
      updateTree({
        ui,
        install: async (stage) => {
          await installs(now)(stage);
          throw new Error("shadcn add exited 1.");
        },
        was: old,
        now,
        local,
        pin: '{ "commit": "new" }\n',
        dependencies: { "@stylexjs/stylex": "catalog:" },
      })
    ).rejects.toThrow("shadcn add exited 1.");
    expect(snapshot(ui)).toStrictEqual(before);
    expect(readdirSync(ui).toSorted()).toStrictEqual([
      "damsko.json",
      "local-changes.json",
      "src",
    ]);
  });

  it("keeps a listed file Damsko removed, as this repository's own, and says so", async () => {
    const { ui, old, local } = setUp();
    const now = damskoWith({ "src/lib/utils.ts": "utils\n" });
    const updated = await updateTree({
      ui,
      install: installs(now),
      was: old,
      now,
      local,
      pin: '{ "commit": "new" }\n',
      dependencies: { "@stylexjs/stylex": "catalog:" },
    });
    expect(updated).toStrictEqual({
      conflicts: [],
      removed: ["src/components/button.tsx"],
      dropped: [],
    });
    expect(
      readFileSync(nodePath.join(ui, "src/components/button.tsx"), "utf-8")
    ).toBe("one\nTWO\nthree\nfour\nfive\n");
  });

  /**
   * An update whose install and check pass, so that only the swap can
   * fail: the writes and renames `fails` picks fail as a full disk would.
   */
  const swapping = (fails: {
    write?: (relative: string) => boolean;
    rename?: (from: string) => boolean;
  }) => {
    const { ui, old, local } = setUp();
    const now = damskoWith({
      "src/components/button.tsx": "one\ntwo\nthree\nfour\nFIVE\n",
      "src/lib/utils.ts": "utils\n",
    });
    return {
      ui,
      before: snapshot(ui),
      update: async () =>
        await updateTree({
          ui,
          install: installs(now),
          was: old,
          now,
          local,
          pin: '{ "commit": "new" }\n',
          dependencies: { "@stylexjs/stylex": "catalog:" },
          files: {
            rename: (from, to) => {
              if (fails.rename?.(from) === true) {
                throw ioError(from);
              }
              renameSync(from, to);
            },
            write: (root, relative, content) => {
              if (fails.write?.(relative) === true) {
                throw ioError(relative);
              }
              writeWithin(root, relative, content);
            },
          },
        }),
    };
  };

  it("puts packages/ui back, src/ and all, when writing damsko.json fails after src/ moved", async () => {
    // The new pin's write fails, not the old one's put back after it.
    let writes = 0;
    const { ui, before, update } = swapping({
      write: (relative) => relative === "damsko.json" && (writes += 1) === 1,
    });
    await expect(update()).rejects.toThrow("EIO: i/o error, damsko.json");
    expect(writes).toBe(2);
    expect(snapshot(ui)).toStrictEqual(before);
    expect(readdirSync(ui).toSorted()).toStrictEqual([
      "damsko.json",
      "local-changes.json",
      "src",
    ]);
  });

  it("keeps the old src/ and says where when putting it back fails too", async () => {
    const { ui, before, update } = swapping({
      write: (relative) => relative === "damsko.json",
      rename: (from) => from.endsWith(`${nodePath.sep}before`),
    });
    const failure = await update().catch((error: unknown) => error);
    const aside = readdirSync(ui).find((name) => name.startsWith(".update-"));
    const kept = nodePath.join(ui, aside ?? "", "before");
    expect(failure instanceof Error ? failure.message : failure).toContain(
      `EIO: i/o error, damsko.json\nPutting packages/ui back failed too: EIO: i/o error, ${kept}\npackages/ui/src as it was, listed changes and all, is in ${kept}: move it back`
    );
    // Only what the update wrote: local-changes.json may hold entries not
    // committed yet.
    expect(failure instanceof Error ? failure.message : failure).toMatch(
      /; git checkout packages\/ui\/damsko\.json puts back what the update wrote beside it\.$/u
    );
    // The only copy of what src/ held, the listed edit and the added file
    // among it.
    const src = Object.fromEntries(
      Object.entries(before).flatMap(([file, content]) =>
        file.startsWith("src/") ? [[file.slice(4), content]] : []
      )
    );
    expect(snapshot(kept)).toStrictEqual(src);
  });

  it("removes its folder once src/ is back, though putting a file back fails", async () => {
    const { ui, before, update } = swapping({
      write: (relative) => relative === "damsko.json",
    });
    const failure = await update().catch((error: unknown) => error);
    expect(failure instanceof Error ? failure.message : failure).toMatch(
      /Putting packages\/ui back failed too: EIO: i\/o error, damsko\.json\npackages\/ui\/src is back as it was; git checkout packages\/ui\/damsko\.json puts back what the update wrote beside it\.$/u
    );
    expect(snapshot(ui)).toStrictEqual(before);
    expect(readdirSync(ui).toSorted()).toStrictEqual([
      "damsko.json",
      "local-changes.json",
      "src",
    ]);
  });

  it("tells git to put back no file the update never wrote", async () => {
    const { ui, update } = swapping({
      rename: (from) =>
        from.endsWith(`${nodePath.sep}next`) ||
        from.endsWith(`${nodePath.sep}before`),
    });
    const failure = await update().catch((error: unknown) => error);
    const message = failure instanceof Error ? failure.message : "";
    const aside = readdirSync(ui).find((name) => name.startsWith(".update-"));
    expect(message).toContain(
      `is in ${nodePath.join(ui, aside ?? "", "before")}: move it back to `
    );
    expect(message).toMatch(/\)\.$/u);
    expect(message).not.toContain("git checkout");
  });

  const noDependencies: Record<string, string> = {};
  const newPin = {
    "src/components/button.tsx": "one\ntwo\nthree\nfour\nFIVE\n",
    "src/lib/utils.ts": "utils\n",
  };

  it.each([
    {
      name: "a file the CLI left out",
      install: async (stage: string) => {
        writeWithin(stage, "src/components/button.tsx", bytes("button\n"));
        await Promise.resolve();
      },
      dependencies: { "@stylexjs/stylex": "catalog:" },
      error: /packages\/ui is left as it was:\nsrc\/lib\/utils.ts is missing/u,
    },
    {
      name: "a file the CLI wrote other than Damsko's",
      install: async (stage: string) => {
        writeWithin(stage, "src/lib/utils.ts", bytes("rewritten\n"));
        await Promise.resolve();
      },
      dependencies: { "@stylexjs/stylex": "catalog:" },
      error: /src\/lib\/utils.ts differs from Damsko's/u,
    },
    {
      name: "a package the new pin names that isn't in the catalog",
      install: undefined,
      dependencies: noDependencies,
      error: /@stylexjs\/stylex must be a dependency at "catalog:"/u,
    },
  ])(
    "leaves packages/ui exactly as it was when the new install isn't Damsko's: $name",
    async ({ install, dependencies, error }) => {
      const { ui, old, local } = setUp();
      const before = snapshot(ui);
      const now = damskoWith(newPin);
      await expect(
        updateTree({
          ui,
          install: install ?? installs(now),
          was: old,
          now,
          local,
          pin: '{ "commit": "new" }\n',
          dependencies,
        })
      ).rejects.toThrow(error);
      expect(snapshot(ui)).toStrictEqual(before);
    }
  );

  it.each(["src/../../../x.ts", "src/linked/x.ts"])(
    "refuses a listed path that isn't plain or goes through a link, before anything moves: %s",
    async (path) => {
      const { ui, old } = setUp();
      const outside = scratchFolder();
      plant(outside, { "x.ts": "outside\n" });
      symlinkSync(outside, nodePath.join(ui, "src", "linked"));
      const before = snapshot(ui);
      const now = damskoWith({ "src/lib/utils.ts": "utils\n" });
      await expect(
        updateTree({
          ui,
          install: installs(now),
          was: old,
          now,
          local: [{ ...listed("src/lib/utils.ts"), path }],
          pin: '{ "commit": "new" }\n',
          dependencies: { "@stylexjs/stylex": "catalog:" },
        })
      ).rejects.toThrow(/not a plain path|symbolic link/u);
      expect(snapshot(ui)).toStrictEqual(before);
      expect(readFileSync(nodePath.join(outside, "x.ts"), "utf-8")).toBe(
        "outside\n"
      );
    }
  );
});

const noticePin = "2d49f2dfd0fb6b86d78a224253bd788ec6fc9ba7";
const earlierPin = "aba6f6e9327fdd78f9aee01c2f9dcf28593c4e74";
const noticeAt = (at: string) =>
  `Damsko's licence:\n${damskoLicence(at)}\nIts third-party notices:\n${damskoNotices(at)}\n`;

describe("the notice that src/ stays under Damsko's licence", () => {
  it("links Damsko's licence and third-party notices at the pinned commit, and at no other", () => {
    expect(noticeDifference(noticeAt(noticePin), noticePin)).toBeUndefined();
    expect(noticeDifference(noticeAt(earlierPin), noticePin)).toBe(
      `LICENSE must link Damsko's licence and third-party notices at the pin: ${damskoLicence(noticePin)}, ${damskoNotices(noticePin)}`
    );
    expect(
      noticeDifference(
        `Damsko's licence:\n${damskoLicence(noticePin)}\n`,
        noticePin
      )
    ).toBe(
      `LICENSE must link Damsko's licence and third-party notices at the pin: ${damskoNotices(noticePin)}`
    );
    expect(noticeDifference(undefined, noticePin)).toMatch(
      /^LICENSE is missing/u
    );
  });

  it("moves both links with the pin, and nothing else", () => {
    const moved = movedNotice(
      `${noticeAt(earlierPin)}Kept as it is.\n`,
      earlierPin,
      noticePin
    );
    expect(moved).toBe(`${noticeAt(noticePin)}Kept as it is.\n`);
    expect(noticeDifference(moved, noticePin)).toBeUndefined();
  });

  it("holds this repository's own notice at its pin", () => {
    const ui = nodePath.join(import.meta.dirname, "../packages/ui");
    const pin = pinSchema.parse(
      JSON.parse(readFileSync(nodePath.join(ui, "damsko.json"), "utf-8"))
    );
    expect(
      noticeDifference(
        readFileSync(nodePath.join(ui, "LICENSE"), "utf-8"),
        pin.commit
      )
    ).toBeUndefined();
  });
});
