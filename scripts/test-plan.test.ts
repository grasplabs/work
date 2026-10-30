/**
 * Which test projects a pull request runs (test-plan.ts): those with a file
 * in a package its changes reach, by pnpm's graph, and none other.
 */
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  affectedProjects,
  packageOf,
  packagesSelected,
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

/** The workspace's shape where it matters: core uses ui, and web's build. */
const workspace = [
  { name: "grasp-os", dir: root, dependsOn: ["/repo/packages/shared"] },
  {
    name: "@grasp-os/shared",
    dir: "/repo/packages/shared",
    dependsOn: [],
  },
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

describe("following a change through the workspace", () => {
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
