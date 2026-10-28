/**
 * Holds a branch of Grasp's agent, `feat/connector-<app>`, to what
 * scripts/connector-guard.ts says it may be (GRA-689); passes any other
 * branch untouched. Two modes:
 *
 * - `static`: from what the branch changes alone, nothing of it run. In
 *   `pull_request_target` (.github/workflows/connector-guard.yml), from
 *   main's own copy of this script, the branch read through git only, so
 *   a branch can't change what checks it. Needs BRANCH (the pull
 *   request's head branch), HEAD_SHA (its head commit, fetched) and
 *   CONNECTOR_PLAN_KEY (the admin's plan signing public key).
 * - `manifest`: in CI's own job, on the branch checked out, it loads the
 *   new connector as connect's build does and holds its manifest's hosts
 *   to the signed plan's. Needs BRANCH and CONNECTOR_PLAN_KEY. `static`
 *   keeps the branch from changing that job.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  connectorOfBranch,
  folderOf,
  manifestProblems,
  readSignedPlan,
  staticProblems,
} from "./connector-guard.ts";
import type { ChangedPath } from "./connector-guard.ts";

/** What the manifest check reads of the connector's package.json: its entry. */
const packageSchema = z.object({ exports: z.object({ ".": z.string() }) });

const root = path.join(import.meta.dirname, "..");

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" });

/** A file's text at `ref`, or undefined when it has none. */
const showAt = (ref: string, file: string): string | undefined => {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};

/** The paths `head` changes since `base`, renames as such. */
const changedPaths = (base: string, head: string): ChangedPath[] =>
  git(["diff", "--name-status", "-M", base, head])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [status = "", first = "", second] = line.split("\t");
      return second === undefined
        ? { status, path: first }
        : { status, path: second, from: first };
    });

/** Prints `problems` as errors CI shows, and fails when there are any. */
const report = (problems: readonly string[]): void => {
  for (const problem of problems) {
    console.error(`::error title=connector guard::${problem}`);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  }
};

const branch = process.env.BRANCH ?? "";
const publicKey = process.env.CONNECTOR_PLAN_KEY;
const mode = process.argv.at(2);

if (mode === "static") {
  const head = process.env.HEAD_SHA ?? "";
  if (connectorOfBranch(branch) === undefined) {
    console.info(`${branch || "This branch"} is no connector branch.`);
  } else {
    const base = git(["merge-base", "origin/main", head]).trim();
    report(
      await staticProblems(
        {
          branch,
          changed: changedPaths(base, head),
          head: (file) => showAt(head, file),
          base: (file) => showAt(base, file),
          baseHasFolder: (folder) =>
            git(["ls-tree", "-r", "--name-only", base, "--", folder]).trim() !==
            "",
        },
        publicKey
      )
    );
  }
} else if (mode === "manifest") {
  const app = connectorOfBranch(branch);
  if (app === undefined || app === "") {
    console.info(`${branch || "This branch"} is no connector branch.`);
  } else {
    const folder = path.join(root, folderOf(app));
    const read = (file: string): string | undefined => {
      const full = path.join(root, file);
      return existsSync(full) ? readFileSync(full, "utf-8") : undefined;
    };
    const plan = await readSignedPlan(app, read, publicKey);
    if (Array.isArray(plan)) {
      report(plan);
    } else {
      const declared = packageSchema.safeParse(
        JSON.parse(readFileSync(path.join(folder, "package.json"), "utf-8"))
      );
      const entry = declared.success
        ? path.resolve(folder, declared.data.exports["."])
        : undefined;
      if (entry === undefined || !entry.startsWith(`${folder}${path.sep}`)) {
        report([`${folderOf(app)}'s entry must be a file in its folder`]);
      } else {
        const loaded: unknown = await import(pathToFileURL(entry).href);
        const connector: unknown =
          typeof loaded === "object" && loaded !== null
            ? Reflect.get(loaded, "default")
            : undefined;
        const manifest: unknown =
          typeof connector === "object" && connector !== null
            ? Reflect.get(connector, "manifest")
            : undefined;
        report(manifestProblems(app, manifest, plan));
      }
    }
  }
} else {
  console.error("Say static or manifest.");
  process.exitCode = 1;
}
