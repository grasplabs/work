/**
 * Which test projects a pull request runs (test-plan.ts): those with a file
 * in a package its changes reach, by pnpm's graph, and none other.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  affectedProjects,
  packageOf,
  packagesSelected,
  filesImporting,
  journeysReached,
  reachSince,
  reachedPackages,
} from "./test-plan.ts";

const root = "/repo";
const packages = [
  root,
  "/repo/apps/core",
  "/repo/apps/web",
  "/repo/apps/admin",
];
const files = [
  { project: "@grasp-os/core", file: "/repo/apps/core/test/agent.test.ts" },
  {
    project: "@grasp-os/core:screens",
    file: "/repo/apps/core/test/screens.test.ts",
  },
  { project: "@grasp-os/web", file: "/repo/apps/web/src/app.test.tsx" },
  { project: "admin", file: "/repo/apps/admin/test/rollout.test.ts" },
  // The root's project holds a file of core's too.
  { project: "scripts", file: "/repo/scripts/test-shards.test.ts" },
  { project: "scripts", file: "/repo/apps/core/build-blueprints.test.ts" },
];

describe("planning which test projects run", () => {
  it("puts a file in the deepest package that holds it", () => {
    expect(packageOf("/repo/apps/core/test/a.test.ts", packages)).toBe(
      "/repo/apps/core"
    );
    expect(packageOf("/repo/scripts/a.test.ts", packages)).toBe(root);
  });

  it("doesn't take a package for one whose name it starts with", () => {
    expect(
      packageOf("/repo/apps/web-extra/a.test.ts", packages.slice(1))
    ).toBeUndefined();
  });

  it("runs every project with a file in an affected package", () => {
    expect(
      affectedProjects(files, packages, new Set(["/repo/apps/core"]))
    ).toStrictEqual(["@grasp-os/core", "@grasp-os/core:screens", "scripts"]);
  });

  it("runs nothing of a package the change doesn't reach", () => {
    expect(
      affectedProjects(files, packages, new Set(["/repo/apps/admin"]))
    ).toStrictEqual(["admin"]);
  });

  it("runs no project when no package is affected", () => {
    expect(affectedProjects(files, packages, new Set())).toStrictEqual([]);
  });

  it("asks pnpm for the packages a change in one reaches: itself and those that depend on it", () => {
    const workspace = path.join(import.meta.dirname, "..");
    const reached = packagesSelected("...@grasp-os/web").map((dir) =>
      path.relative(workspace, dir)
    );

    expect(reached).toContain(path.join("apps", "web"));
    expect(reached).toContain(path.join("apps", "core"));
    expect(reached).not.toContain(path.join("apps", "admin"));
  });
});

/** A package.json of `name`, with these dependencies. */
const manifest = (
  name: string,
  dependencies: Record<string, string> = {}
): string => JSON.stringify({ name, version: "0.0.0", dependencies });

/**
 * A workspace of its own in a fresh git repository, its first commit the
 * base: `lib`, `app` that depends on it, and `other` that doesn't.
 * `change` appends to a file and commits it on top, as a pull request's
 * merge commit stands on main's.
 */
const workspaceWithBase = (): {
  repo: string;
  base: string;
  change: (file: string) => void;
} => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "test-plan-")));
  const write = (file: string, content: string): void => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  };
  write("package.json", manifest("repo"));
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(".github/workflows/ci.yml", "name: CI\n");
  write("vite.config.ts", "export default {};\n");
  write("packages/lib/package.json", manifest("lib"));
  write("packages/lib/index.ts", "export const lib = 1;\n");
  write("packages/app/package.json", manifest("app", { lib: "workspace:*" }));
  write("packages/app/index.ts", "export const app = 1;\n");
  write("packages/other/package.json", manifest("other"));
  write("packages/other/index.ts", "export const other = 1;\n");
  // Git's plumbing: a commit of the tree as it stands, with no hooks or
  // user configuration involved.
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  const commit = (message: string, parents: readonly string[]): string => {
    git("add", "--all");
    const parentArgs = parents.flatMap((parent) => ["-p", parent]);
    const made = git(
      "commit-tree",
      git("write-tree"),
      ...parentArgs,
      "-m",
      message
    );
    git("update-ref", "HEAD", made);
    return made;
  };
  git("init", "--quiet");
  const base = commit("base", []);
  return {
    repo,
    base,
    change: (file) => {
      appendFileSync(path.join(repo, file), "\n");
      commit(`change ${file}`, [git("rev-parse", "HEAD")]);
    },
  };
};

const relativeTo = (repo: string, dirs: Iterable<string>): string[] =>
  [...dirs].map((dir) => path.relative(repo, dir) || ".").toSorted();

describe("following a pull request's changes from its base", () => {
  it.each([
    ["the lockfile", "pnpm-lock.yaml"],
    ["a CI workflow", ".github/workflows/ci.yml"],
    ["the repo's config", "vite.config.ts"],
  ])("runs every project when %s changes", (_, file) => {
    const { repo, base, change } = workspaceWithBase();
    try {
      change(file);

      expect(reachSince(base, repo).all).toBeTruthy();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runs a changed package and every package that depends on it, and no other", () => {
    const { repo, base, change } = workspaceWithBase();
    try {
      change("packages/lib/index.ts");
      const reach = reachSince(base, repo);

      expect(reach.all).toBeFalsy();
      expect(relativeTo(repo, reach.changed)).toStrictEqual(["packages/lib"]);
      expect(reach.all ? [] : relativeTo(repo, reach.affected)).toStrictEqual([
        "packages/app",
        "packages/lib",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reaches nothing when nothing changed", () => {
    const { repo, base } = workspaceWithBase();
    try {
      const reach = reachSince(base, repo);

      expect(reach.all).toBeFalsy();
      expect(reach.all ? ["all"] : [...reach.affected]).toStrictEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("leaving out what no Vitest test sees", () => {
  it("sets journey files apart from the root's own, for the tests that import them", () => {
    const { repo, base, change } = workspaceWithBase();
    try {
      mkdirSync(path.join(repo, "e2e"));
      change("e2e/apps.e2e.ts");
      change("playwright.config.ts");
      const reach = reachSince(base, repo);

      expect(reach.all).toBeFalsy();
      expect(reach.all ? ["all"] : [...reach.affected]).toStrictEqual([]);
      expect(reach.all ? [] : relativeTo(repo, reach.journeys)).toStrictEqual([
        "e2e/apps.e2e.ts",
        "playwright.config.ts",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  /**
   * A repository shaped like this one where it matters: the Playwright
   * config imports a journey helper, and a script its test imports reads
   * the config, as scripts/e2e-parts.ts does.
   */
  const importing = (changed: string, { deleted = false } = {}): string[] => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "importers-")));
    try {
      const sources: Record<string, string> = {
        "e2e/stack.ts": "export const port = 1;\n",
        "e2e/apps.e2e.ts": 'import { port } from "./stack.ts";\n',
        "playwright.config.ts":
          'import { port } from "./e2e/stack.ts";\nexport const journeys = port;\n',
        "scripts/parts.ts":
          'import { journeys } from "../playwright.config.ts";\nexport const parts = journeys;\n',
        // A `.js` specifier for its TypeScript source.
        "scripts/parts.test.ts": 'import { parts } from "./parts.js";\n',
        "scripts/other.test.ts": "export const other = 1;\n",
        // A re-export, with no extension, out of a package.
        "packages/lib/src/helper.ts":
          'export { port } from "../../../e2e/stack";\n',
        // An import by an expression, naming the helper.
        "scripts/loose.test.ts":
          'const name = "../e2e/stack.ts";\nawait import(name);\n',
      };
      for (const [file, content] of Object.entries(sources)) {
        mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
        writeFileSync(path.join(repo, file), content);
      }
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      if (deleted) {
        rmSync(path.join(repo, changed));
      }
      return relativeTo(repo, filesImporting([path.join(repo, changed)], repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };

  it("reaches the tests that import playwright.config.ts through a script", () => {
    expect(importing("playwright.config.ts")).toStrictEqual([
      "playwright.config.ts",
      "scripts/parts.test.ts",
      "scripts/parts.ts",
    ]);
  });

  it("reaches the scripts project's test when a helper the config imports is deleted", () => {
    expect(
      importing("e2e/stack.ts", { deleted: true }).filter((file) =>
        file.startsWith("scripts/")
      )
    ).toContain("scripts/parts.test.ts");
  });

  it("reaches no test when only a journey changes", () => {
    expect(importing("e2e/apps.e2e.ts")).toStrictEqual(["e2e/apps.e2e.ts"]);
  });

  it("reaches every importer of a helper, a package's file and an import it can't read included", () => {
    expect(importing("e2e/stack.ts")).toStrictEqual([
      "e2e/apps.e2e.ts",
      "e2e/stack.ts",
      "packages/lib/src/helper.ts",
      "playwright.config.ts",
      "scripts/loose.test.ts",
      "scripts/parts.test.ts",
      "scripts/parts.ts",
    ]);
  });

  it("doesn't reach a package through a dependency on another's build alone", () => {
    const { repo, base, change } = workspaceWithBase();
    try {
      change("packages/lib/index.ts");
      const reach = reachSince(base, repo, new Map([["app", ["lib"]]]));

      expect(reach.all ? [] : relativeTo(repo, reach.affected)).toStrictEqual([
        "packages/lib",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/** The workspace's shape where it matters: core uses ui, and web's build. */
const workspace = [
  { name: "grasp-os", dir: root, dependsOn: ["/repo/packages/shared"] },
  { name: "@grasp-os/shared", dir: "/repo/packages/shared", dependsOn: [] },
  {
    name: "@grasp-os/ui",
    dir: "/repo/packages/ui",
    dependsOn: ["/repo/packages/shared"],
  },
  {
    name: "@grasp-os/web",
    dir: "/repo/apps/web",
    dependsOn: ["/repo/packages/ui", "/repo/packages/shared"],
  },
  {
    name: "@grasp-os/core",
    dir: "/repo/apps/core",
    dependsOn: ["/repo/apps/web", "/repo/packages/ui"],
  },
  {
    name: "@grasp-os/admin",
    dir: "/repo/apps/admin",
    dependsOn: ["/repo/packages/ui"],
  },
];

describe("following a change through Grasp's workspace", () => {
  it("reaches every package that depends on a changed one, directly or not", () => {
    expect(reachedPackages(workspace, ["/repo/packages/shared"])).toStrictEqual(
      new Set([
        "/repo/packages/shared",
        root,
        "/repo/packages/ui",
        "/repo/apps/web",
        "/repo/apps/core",
        "/repo/apps/admin",
      ])
    );
  });

  it("doesn't reach core from web, whose build is all core takes", () => {
    expect(reachedPackages(workspace, ["/repo/apps/web"])).toStrictEqual(
      new Set(["/repo/apps/web"])
    );
  });

  it("still reaches core from what web and core both use", () => {
    expect(reachedPackages(workspace, ["/repo/packages/ui"])).toContain(
      "/repo/apps/core"
    );
  });

  it("follows every dependency when none is build-only", () => {
    expect(
      reachedPackages(workspace, ["/repo/apps/web"], new Map())
    ).toStrictEqual(new Set(["/repo/apps/web", "/repo/apps/core"]));
  });
});

/** The journey stacks' packages and two apart from them, as Grasp's are. */
const stackPackages = [
  { name: "grasp-os", dir: root, dependsOn: ["/repo/packages/shared"] },
  { name: "@grasp-os/shared", dir: "/repo/packages/shared", dependsOn: [] },
  {
    name: "@grasp-os/ui",
    dir: "/repo/packages/ui",
    dependsOn: ["/repo/packages/shared"],
  },
  {
    name: "@grasp-os/web",
    dir: "/repo/apps/web",
    dependsOn: ["/repo/packages/ui"],
  },
  {
    name: "@grasp-os/connect",
    dir: "/repo/apps/connect",
    dependsOn: ["/repo/packages/shared"],
  },
  {
    name: "@grasp-os/core",
    dir: "/repo/apps/core",
    dependsOn: ["/repo/apps/web", "/repo/apps/connect"],
  },
  {
    name: "@grasp-os/admin",
    dir: "/repo/apps/admin",
    dependsOn: ["/repo/packages/ui"],
  },
  {
    name: "@grasp-os/router",
    dir: "/repo/apps/router",
    dependsOn: ["/repo/packages/shared"],
  },
];

const journeysFor = (...changedFiles: string[]) =>
  journeysReached({
    changedFiles,
    testFiles: new Set(["/repo/apps/core/test/agent.test.ts"]),
    packages: stackPackages,
    root,
  });

describe("choosing which journey suites a change reaches", () => {
  it("runs e2e for a change in what its stack runs, web's build included", () => {
    expect(journeysFor("/repo/apps/web/src/app.tsx")).toStrictEqual({
      e2e: true,
      "admin-e2e": false,
    });
  });

  it("runs both for a package both stacks depend on", () => {
    expect(journeysFor("/repo/packages/ui/src/button.tsx")).toStrictEqual({
      e2e: true,
      "admin-e2e": true,
    });
  });

  it("runs only admin-e2e for a change to the admin alone", () => {
    expect(journeysFor("/repo/apps/admin/src/rollout.ts")).toStrictEqual({
      e2e: false,
      "admin-e2e": true,
    });
  });

  it("runs neither for a test file, which no build bundles, or a package no stack runs", () => {
    expect(
      journeysFor(
        "/repo/apps/core/test/agent.test.ts",
        "/repo/apps/router/src/index.ts"
      )
    ).toStrictEqual({ e2e: false, "admin-e2e": false });
  });

  it("runs a stack for a helper of the tests, which isn't a test file", () => {
    expect(journeysFor("/repo/apps/core/test/helpers.ts")).toStrictEqual({
      e2e: true,
      "admin-e2e": false,
    });
  });

  it("runs a suite alone for a change to its own journeys or config", () => {
    expect(journeysFor("/repo/e2e/chat.e2e.ts")).toStrictEqual({
      e2e: true,
      "admin-e2e": false,
    });
    expect(
      journeysFor(
        "/repo/e2e/admin/rollout.e2e.ts",
        "/repo/playwright.admin.config.ts"
      )
    ).toStrictEqual({ e2e: false, "admin-e2e": true });
  });

  it("runs both for any other file outside every package", () => {
    expect(journeysFor("/repo/scripts/dev.ts")).toStrictEqual({
      e2e: true,
      "admin-e2e": true,
    });
  });
});
