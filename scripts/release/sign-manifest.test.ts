/**
 * CI's release signer (sign-manifest.ts), run as sign-release runs it: in
 * a Node of its own, with the environment GitHub gives a job. What it
 * signs must verify with @grasp-os/shared/release-signature, which every
 * import, promotion and on-premises install uses.
 *
 * Threat model: the signing key is reachable by whatever runs in the job
 * that holds it, so that job must run nothing but GitHub's own actions,
 * pinned, and this one file, which imports nothing but Node's built-ins;
 * no other job may name the key's environment or the key; and the signer
 * must sign nothing but a manifest of its own run's commit, for a push to
 * main, under an id of this month.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";

import { releaseMonthPrefix } from "@grasp-os/shared/release-id";
import {
  RELEASE_SIGNATURE_FILE,
  releaseSignatureProblem,
} from "@grasp-os/shared/release-signature";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { z } from "zod";

import {
  releaseSigningKeys,
  testReleaseSigningKey,
} from "../../packages/shared/test/release-signing-keys.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const SIGNER = path.join(import.meta.dirname, "sign-manifest.ts");
const COMMIT = "c".repeat(40);
const ENVIRONMENT = "release-signing";
const SECRET = "RELEASE_SIGNING_KEY";

/** A push to main of `COMMIT`, as GitHub sets it, and the key the tests trust. */
const pushToMain = {
  PATH: process.env.PATH,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: COMMIT,
  [SECRET]: JSON.stringify(testReleaseSigningKey),
};

/** Runs the signer on `dir`: its exit code and what it said. */
const sign = async (
  dir: string,
  env: Record<string, string | undefined> = pushToMain
): Promise<{ code: number | null; output: string }> => {
  const child = spawn("node", [SIGNER, dir], { env });
  const closed = once(child, "close");
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
  ]);
  await closed;
  return { code: child.exitCode, output: stdout + stderr };
};

describe("signing a release's manifest in CI", () => {
  let dir = "";
  const thisMonths = `${releaseMonthPrefix(new Date())}7`;

  /** Writes a manifest of `commit` under `releaseId` to the directory: its bytes. */
  const writeManifest = (releaseId: string, commit = COMMIT): Buffer => {
    const bytes = Buffer.from(
      `${JSON.stringify({ releaseId, commit, notes: "feat(core): signed" })}\n`
    );
    writeFileSync(path.join(dir, "manifest.json"), bytes);
    return bytes;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-sign-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("signs a manifest of its run's commit, under an id of this month, so that every verifier takes it", async () => {
    const bytes = writeManifest(thisMonths);
    const { code } = await sign(dir);
    const signature = readFileSync(path.join(dir, RELEASE_SIGNATURE_FILE));
    const changed = Buffer.from(bytes.toString().replace("signed", "s1gned"));

    expect({
      code,
      problem: await releaseSignatureProblem(
        bytes,
        signature,
        releaseSigningKeys
      ),
      changed: await releaseSignatureProblem(
        changed,
        signature,
        releaseSigningKeys
      ),
    }).toStrictEqual({
      code: 0,
      problem: undefined,
      changed: "has a signature that doesn't match it",
    });
  });

  it("signs nothing for a pull request, another branch, another commit, an id of another month or a local build, nor with a key it can't use", async () => {
    const lastYears = `${String((new Date().getUTCFullYear() - 1) % 100).padStart(2, "0")}.01.1`;
    const cases: [string, () => Record<string, string | undefined>][] = [
      [
        "pullRequest",
        () => {
          writeManifest(thisMonths);
          return { ...pushToMain, GITHUB_EVENT_NAME: "pull_request" };
        },
      ],
      [
        "otherBranch",
        () => {
          writeManifest(thisMonths);
          return { ...pushToMain, GITHUB_REF: "refs/heads/feat/x" };
        },
      ],
      [
        "mergeQueue",
        () => {
          writeManifest(thisMonths);
          return { ...pushToMain, GITHUB_EVENT_NAME: "merge_group" };
        },
      ],
      [
        "otherCommit",
        () => {
          writeManifest(thisMonths, "d".repeat(40));
          return pushToMain;
        },
      ],
      [
        "otherMonth",
        () => {
          writeManifest(lastYears);
          return pushToMain;
        },
      ],
      [
        "localBuild",
        () => {
          writeManifest("dev-abc");
          return pushToMain;
        },
      ],
      [
        "notJson",
        () => {
          writeFileSync(path.join(dir, "manifest.json"), "{ not json");
          return pushToMain;
        },
      ],
      [
        "noKey",
        () => {
          writeManifest(thisMonths);
          return { ...pushToMain, [SECRET]: "" };
        },
      ],
      [
        "notEd25519",
        () => {
          writeManifest(thisMonths);
          return {
            ...pushToMain,
            [SECRET]: JSON.stringify({ kty: "oct", k: "c2VjcmV0" }),
          };
        },
      ],
    ];

    const outcomes: Record<string, { code: number | null; signed: boolean }> =
      {};
    for (const [name, arrange] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one directory, in turn
      const { code } = await sign(dir, arrange());
      outcomes[name] = {
        code,
        signed: existsSync(path.join(dir, RELEASE_SIGNATURE_FILE)),
      };
    }

    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        cases.map(([name]) => [name, { code: 1, signed: false }])
      )
    );
  });
});

/** What a workflow's job is read as here: loosely, as the rules read only these. */
const jobSchema = z.looseObject({
  environment: z
    .union([z.string(), z.looseObject({ name: z.string() })])
    .optional(),
  permissions: z.unknown().optional(),
  steps: z
    .array(
      z.looseObject({ uses: z.string().optional(), run: z.string().optional() })
    )
    .optional(),
});
const workflowSchema = z.looseObject({
  jobs: z.record(z.string(), jobSchema).optional(),
});

/** Every workflow and action file under .github, by its path from the repo's root. */
const githubFiles = (): string[] =>
  readdirSync(path.join(ROOT, ".github"), {
    recursive: true,
    encoding: "utf-8",
  })
    .filter((file) => /\.ya?ml$/u.test(file))
    .map((file) => path.join(".github", file));

const readYaml = (file: string): unknown =>
  parse(readFileSync(path.join(ROOT, file), "utf-8"));

/** A pinned action of GitHub's own: `actions/<name>@<commit>`. */
const GITHUB_ACTION = /^actions\/[a-z-]+@[0-9a-f]{40}$/u;
/** Each import's module: `from "…"`, `import "…"`. */
const IMPORTED = /\b(?:from|import)\s*["'](?<module>[^"']+)["']/gu;

describe("the job that holds the signing key", () => {
  const ci = workflowSchema.parse(readYaml(".github/workflows/ci.yml"));
  const job = ci.jobs?.["sign-release"];

  it("is the only one that names its environment or the key", () => {
    const others = githubFiles().filter((file) => {
      const workflow = readYaml(file);
      if (file === ".github/workflows/ci.yml") {
        const { "sign-release": _signing, ...rest } = ci.jobs ?? {};
        return /release-signing|RELEASE_SIGNING_KEY/u.exec(
          JSON.stringify({ ...ci, jobs: rest })
        );
      }
      return /release-signing|RELEASE_SIGNING_KEY/u.exec(
        JSON.stringify(workflow)
      );
    });
    expect({ environment: job?.environment, others }).toStrictEqual({
      environment: ENVIRONMENT,
      others: [],
    });
  });

  it("runs only GitHub's own actions, pinned, and the signer, with no more than read access to the code", () => {
    const steps = job?.steps ?? [];
    const strays = steps.filter(
      (step) =>
        !(step.uses !== undefined && GITHUB_ACTION.test(step.uses)) &&
        step.run !== "node scripts/release/sign-manifest.ts release-manifest"
    );
    expect({
      steps: steps.length,
      strays,
      permissions: job?.permissions,
    }).toStrictEqual({
      steps: 4,
      strays: [],
      permissions: { contents: "read" },
    });
  });

  it("signs with a file that imports nothing but Node's built-ins", () => {
    const source = readFileSync(SIGNER, "utf-8");
    const modules = [...source.matchAll(IMPORTED)].map(
      (match) => match.groups?.module
    );
    expect({
      outside: modules.filter((name) => name?.startsWith("node:") !== true),
      dynamic: /\b(?:import|require)\s*\(/u.test(source),
      any: modules.length > 0,
    }).toStrictEqual({ outside: [], dynamic: false, any: true });
  });
});
