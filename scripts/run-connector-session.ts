/**
 * Runs a step of a session of Grasp's agent (GRA-689, S3), as the
 * `connector-agent` workflow's jobs call it; scripts/connector-session.ts
 * says what each holds the session to. Every value from the dispatch
 * comes in through env, never the command line:
 *
 * - `verify`: the dispatch (REF, CONNECTOR_PLAN_KEY, PLAN, PLAN_SIGNATURE,
 *   TICKET, TICKET_SIGNATURE; the plan and ticket in base64), and that no
 *   commit on the branch carries its nonce yet. Writes the app, branch,
 *   round, nonce and when it was accepted to GITHUB_OUTPUT.
 * - `brief`: the dispatch again, as of when `verify` accepted it
 *   (VERIFIED_AT), and the agent's settings and first message to
 *   BRIEF_DIR. Asks git nothing: the agent's job has no token to.
 * - `stage`: after the agent, copies the regular files of the new
 *   connector's folder, and the lockfile, to STAGE_DIR, following no
 *   link: the artifact the `push` job gets.
 * - `collect`: in the `push` job, from the artifact in ARTIFACT_DIR,
 *   checked, onto the branch (or main, for a new one), with the plan
 *   written from the dispatch; holds the result to the guard and commits
 *   it, as RUN_URL's session. Pushing is the workflow's, with the App's
 *   token, which exists only after this.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { planFiles } from "@grasp-os/connector-kit/plan-signature";

import { folderOf, lockfile, staticProblems } from "./connector-guard.ts";
import type { ChangedPath } from "./connector-guard.ts";
import {
  agentPrompt,
  agentSettings,
  artifactProblems,
  commitMessage,
  nonceUsed,
  verifyStart,
} from "./connector-session.ts";
import type { ArtifactEntry, SessionStart } from "./connector-session.ts";

const root = path.join(import.meta.dirname, "..");

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" });

/** Prints `problems` as errors the run shows, and fails when there are any. */
const report = (problems: readonly string[]): boolean => {
  for (const problem of problems) {
    console.error(`::error title=connector session::${problem}`);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  }
  return problems.length === 0;
};

/** Base64 `text` decoded; empty for anything else. */
const decoded = (text: string | undefined): string => {
  try {
    return Buffer.from(text ?? "", "base64").toString("utf-8");
  } catch {
    return "";
  }
};

/**
 * When the dispatch is checked as of: now in `verify`, and in the jobs
 * after it the time `verify` accepted it (VERIFIED_AT, its output), so a
 * session longer than its ticket's hour still pushes. Only main's
 * `verify` job sets it; the agent's job can't change another job's
 * outputs.
 */
const acceptedAt = (): number => {
  const verified = Number(process.env.VERIFIED_AT);
  return Number.isSafeInteger(verified) && verified > 0 ? verified : Date.now();
};

/** The session the dispatch in env starts, or why it may not. */
const started = async (): Promise<SessionStart | undefined> => {
  const start = await verifyStart(
    {
      ref: process.env.REF ?? "",
      publicKey: process.env.CONNECTOR_PLAN_KEY,
      dispatch: {
        plan: decoded(process.env.PLAN),
        planSignature: process.env.PLAN_SIGNATURE ?? "",
        ticket: decoded(process.env.TICKET),
        ticketSignature: process.env.TICKET_SIGNATURE ?? "",
      },
    },
    acceptedAt()
  );
  if ("problems" in start) {
    report(start.problems);
    return undefined;
  }
  return start;
};

/**
 * Where the session's commit goes on top of: the branch, fetched, or main
 * when there is no branch yet. A branch that exists but won't fetch fails
 * the step: its log is what says whether this ticket ran already.
 */
const sessionBase = (branch: string): { ref: string; log: string } => {
  let listed = "";
  try {
    listed = execFileSync(
      "git",
      ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
      { cwd: root, encoding: "utf-8" }
    );
  } catch (error) {
    throw new Error(`Couldn't ask origin for ${branch}`, { cause: error });
  }
  if (listed.trim() === "") {
    return { ref: "origin/main", log: "" };
  }
  const local = `refs/remotes/origin/${branch}`;
  git(["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${local}`]);
  // Only the branch's own commits can carry a session's nonce: what it
  // shares with main was merged from main.
  return {
    ref: local,
    log: git(["log", "--format=%B", `origin/main..${local}`]),
  };
};

/** Every entry under `dir`, relative and `/`-separated, following no link. */
const entriesUnder = (dir: string, prefix = ""): ArtifactEntry[] =>
  readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const stat = lstatSync(path.join(dir, relative));
      if (stat.isSymbolicLink()) {
        return [{ path: relative, kind: "symlink" as const, bytes: 0 }];
      }
      if (stat.isDirectory()) {
        return [
          { path: relative, kind: "directory" as const, bytes: 0 },
          ...entriesUnder(dir, relative),
        ];
      }
      return [
        {
          path: relative,
          kind: stat.isFile() ? ("file" as const) : ("other" as const),
          bytes: stat.size,
        },
      ];
    }
  );

/** Writes `values` to the job's outputs. */
const output = (values: Record<string, string | number>): void => {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (file === undefined) {
    console.info(lines.join("\n"));
  } else {
    appendFileSync(file, `${lines.join("\n")}\n`);
  }
};

const verify = async (): Promise<void> => {
  const start = await started();
  if (start === undefined) {
    return;
  }
  if (nonceUsed(sessionBase(start.branch).log, start.nonce)) {
    report([
      `A session with this ticket was pushed to ${start.branch} already`,
    ]);
    return;
  }
  output({
    app: start.app,
    branch: start.branch,
    round: start.round,
    nonce: start.nonce,
    verified_at: Date.now(),
  });
};

const brief = async (): Promise<void> => {
  const start = await started();
  const dir = process.env.BRIEF_DIR ?? "";
  if (start === undefined) {
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "settings.json"),
    `${JSON.stringify(agentSettings(start), null, 2)}\n`
  );
  writeFileSync(path.join(dir, "prompt.md"), agentPrompt(start));
};

/** Copies regular file `relative` from `from` to `to`, its folders made. */
const copyInto = (from: string, to: string, relative: string): void => {
  mkdirSync(path.dirname(path.join(to, relative)), { recursive: true });
  copyFileSync(path.join(from, relative), path.join(to, relative));
};

const stage = (): void => {
  const app = process.env.APP ?? "";
  const to = process.env.STAGE_DIR ?? "";
  const folder = folderOf(app);
  for (const entry of entriesUnder(root, folder)) {
    if (entry.kind === "file") {
      copyInto(root, to, entry.path);
    } else if (entry.kind !== "directory") {
      console.warn(`Left out ${entry.path}: not a regular file`);
    }
  }
  if (lstatSync(path.join(root, lockfile)).isFile()) {
    copyInto(root, to, lockfile);
  }
};

/** The paths the index changes since `base`, renames as such. */
const stagedChanges = (base: string): ChangedPath[] =>
  git(["diff", "--cached", "--name-status", "-M", base])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [status = "", first = "", second] = line.split("\t");
      return second === undefined
        ? { status, path: first }
        : { status, path: second, from: first };
    });

/** A file's text at `ref` (`:` for the index), or undefined when it has none. */
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

const collect = async (): Promise<void> => {
  const start = await started();
  const from = process.env.ARTIFACT_DIR ?? "";
  if (start === undefined) {
    return;
  }
  const folder = folderOf(start.app);
  const entries = entriesUnder(from);
  if (!report(artifactProblems(start.app, entries))) {
    return;
  }
  // On the branch where there is one, so a later session builds on it.
  const onto = sessionBase(start.branch);
  if (nonceUsed(onto.log, start.nonce)) {
    report([
      `A session with this ticket was pushed to ${start.branch} already`,
    ]);
    return;
  }
  git(["checkout", "--quiet", "--detach", onto.ref]);
  rmSync(path.join(root, folder), { recursive: true, force: true });
  for (const entry of entries) {
    if (entry.kind === "file") {
      copyInto(from, root, entry.path);
    }
  }
  // The plan the admin signed, never the agent's copy of it.
  mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(
    path.join(root, folder, planFiles.plan),
    decoded(process.env.PLAN)
  );
  writeFileSync(
    path.join(root, folder, planFiles.signature),
    `${process.env.PLAN_SIGNATURE ?? ""}\n`
  );
  git(["add", "--all", "--", folder, lockfile]);
  const base = git(["merge-base", "origin/main", "HEAD"]).trim();
  const problems = await staticProblems(
    {
      branch: start.branch,
      changed: stagedChanges(base),
      head: (file) => showAt("", file),
      base: (file) => showAt(base, file),
      baseHasFolder: (dir) =>
        git(["ls-tree", "-r", "--name-only", base, "--", dir]).trim() !== "",
    },
    process.env.CONNECTOR_PLAN_KEY
  );
  if (!report(problems)) {
    return;
  }
  git([
    "-c",
    "user.name=Grasp agent",
    "-c",
    "user.email=grasp-agent@users.noreply.github.com",
    "commit",
    "--quiet",
    "--message",
    commitMessage(start, process.env.RUN_URL ?? ""),
  ]);
  output({ commit: git(["rev-parse", "HEAD"]).trim() });
};

const mode = process.argv.at(2);
if (mode === "verify") {
  await verify();
} else if (mode === "brief") {
  await brief();
} else if (mode === "stage") {
  stage();
} else if (mode === "collect") {
  await collect();
} else {
  console.error("Say verify, brief, stage or collect.");
  process.exitCode = 1;
}
