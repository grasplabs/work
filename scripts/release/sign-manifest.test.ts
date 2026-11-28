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
 * main, under an id of this month (a far-off id would hold Edge for
 * good). The checks on the workflows catch mistakes; review of the paths
 * .github/CODEOWNERS names is the control.
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

/** When the tests sign, unless said: mid-month, UTC. */
const MID_NOVEMBER = "2026-11-15T12:00:00Z";

/**
 * A module that sets Node's clock to `at` before the signer runs: the
 * signer reads the month from it, untouched.
 */
const clockAt = (at: string): string =>
  `data:text/javascript,${encodeURIComponent(
    `const at = Date.parse(${JSON.stringify(at)}); const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length > 0 ? args : [at])); } static now() { return at; } };`
  )}`;

/** Runs the signer on `dir` at `at`: its exit code and what it said. */
const sign = async (
  dir: string,
  env: Record<string, string | undefined> = pushToMain,
  at = MID_NOVEMBER
): Promise<{ code: number | null; output: string }> => {
  const child = spawn("node", ["--import", clockAt(at), SIGNER, dir], { env });
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

  it("signs a manifest of its run's commit so that every verifier takes it", async () => {
    const bytes = writeManifest("26.11.7");
    const { code } = await sign(dir);
    const signature = readFileSync(path.join(dir, RELEASE_SIGNATURE_FILE));
    const changed = Buffer.from(bytes.toString().replace("signed", "s1gned"));

    expect({
      code,
      problem: await releaseSignatureProblem(
        bytes,
        signature,
        releaseSigningKeys,
        "26.11.7"
      ),
      changed: await releaseSignatureProblem(
        changed,
        signature,
        releaseSigningKeys,
        "26.11.7"
      ),
    }).toStrictEqual({
      code: 0,
      problem: undefined,
      changed: "has a signature that doesn't match it",
    });
  });

  it("signs only an id of this month, or of the month before in the first hours of a new one, with N at most 99,999", async () => {
    const cases = {
      thisMonth: { id: "26.11.7", at: MID_NOVEMBER, signs: true },
      largestN: { id: "26.11.99999", at: MID_NOVEMBER, signs: true },
      lastMonth: { id: "26.10.40", at: MID_NOVEMBER, signs: false },
      nextMonth: { id: "26.12.1", at: MID_NOVEMBER, signs: false },
      farOff: { id: "99.12.1", at: MID_NOVEMBER, signs: false },
      tooLargeN: { id: "26.11.100000", at: MID_NOVEMBER, signs: false },
      justAfterRollover: {
        id: "26.11.40",
        at: "2026-12-01T05:59:00Z",
        signs: true,
      },
      hoursAfterRollover: {
        id: "26.11.40",
        at: "2026-12-01T06:01:00Z",
        signs: false,
      },
      acrossTheYear: { id: "26.12.9", at: "2027-01-01T01:00:00Z", signs: true },
    };
    const signed: Record<string, boolean> = {};
    for (const [name, { id, at }] of Object.entries(cases)) {
      writeManifest(id);
      // oxlint-disable-next-line no-await-in-loop -- one directory, in turn
      const { code } = await sign(dir, pushToMain, at);
      signed[name] = code === 0;
    }

    expect(signed).toStrictEqual(
      Object.fromEntries(
        Object.entries(cases).map(([name, { signs }]) => [name, signs])
      )
    );
  });

  it("signs nothing for a pull request, the merge queue, another branch, another commit or a local build, nor with a key it can't use, and says why", async () => {
    const id = "26.11.7";
    const cases: [string, string, () => Record<string, string | undefined>][] =
      [
        [
          "pullRequest",
          "Only a push signs",
          () => {
            writeManifest(id);
            return { ...pushToMain, GITHUB_EVENT_NAME: "pull_request" };
          },
        ],
        [
          "mergeQueue",
          "Only a push signs",
          () => {
            writeManifest(id);
            return { ...pushToMain, GITHUB_EVENT_NAME: "merge_group" };
          },
        ],
        [
          "otherBranch",
          "Only main signs",
          () => {
            writeManifest(id);
            return { ...pushToMain, GITHUB_REF: "refs/heads/feat/x" };
          },
        ],
        [
          "otherCommit",
          "this run is",
          () => {
            writeManifest(id, "d".repeat(40));
            return pushToMain;
          },
        ],
        [
          "localBuild",
          "isn't an id of this month's",
          () => {
            writeManifest("dev-abc");
            return pushToMain;
          },
        ],
        [
          "notJson",
          "isn't JSON",
          () => {
            writeFileSync(path.join(dir, "manifest.json"), "{ not json");
            return pushToMain;
          },
        ],
        [
          "noKey",
          "RELEASE_SIGNING_KEY isn't a JWK",
          () => {
            writeManifest(id);
            return { ...pushToMain, [SECRET]: "" };
          },
        ],
        [
          "notEd25519",
          "isn't an Ed25519 private key",
          () => {
            writeManifest(id);
            return {
              ...pushToMain,
              [SECRET]: JSON.stringify({ kty: "oct", k: "c2VjcmV0" }),
            };
          },
        ],
      ];

    const outcomes: Record<string, unknown> = {};
    for (const [name, reason, arrange] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one directory, in turn
      const { code, output } = await sign(dir, arrange());
      outcomes[name] = {
        code,
        said: output.includes(reason),
        signed: existsSync(path.join(dir, RELEASE_SIGNATURE_FILE)),
      };
    }

    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        cases.map(([name]) => [name, { code: 1, said: true, signed: false }])
      )
    );
  });
});

/** What a workflow's job is read as here: loosely, as the rules read only these. */
const jobSchema = z.looseObject({
  environment: z
    .union([z.string(), z.looseObject({ name: z.string() })])
    .optional(),
  uses: z.string().optional(),
  secrets: z.unknown().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const workflowSchema = z.looseObject({
  env: z.unknown().optional(),
  defaults: z.unknown().optional(),
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

/** Every workflow, parsed, by its path. */
const workflows = (): [string, z.infer<typeof workflowSchema>][] =>
  githubFiles()
    .filter((file) => file.startsWith(".github/workflows/"))
    .map((file) => [file, workflowSchema.parse(readYaml(file))]);

/** Each import's module: `from "…"`, `import "…"`. */
const IMPORTED = /\b(?:from|import)\s*["'](?<module>[^"']+)["']/gu;

/**
 * The stage Deploy platform takes as its environment
 * (`${{ inputs.stage }}`), the one environment that isn't a literal: its
 * callers and its run by hand may name only these.
 */
const DEPLOY_STAGES = ["staging", "production"];

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

  it("can't be reached by a name built at run time, every secret at once, or a workflow from elsewhere", () => {
    const strays: string[] = [];
    for (const [file, workflow] of workflows()) {
      const json = JSON.stringify(workflow);
      // Secrets only by a literal name: never `secrets[…]` or all of them.
      if (/secrets\s*\[|toJSON\(\s*secrets\s*\)/iu.test(json)) {
        strays.push(`${file}: secrets read by a computed name, or all at once`);
      }
      for (const [name, each] of Object.entries(workflow.jobs ?? {})) {
        const environment =
          typeof each.environment === "object"
            ? each.environment.name
            : each.environment;
        const deployStage =
          file === ".github/workflows/deploy-platform.yml" &&
          environment === `\${{ inputs.stage }}`;
        if (environment?.includes(`\${{`) === true && !deployStage) {
          strays.push(`${file} ${name}: environment ${environment}`);
        }
        if (each.secrets === "inherit") {
          strays.push(`${file} ${name}: secrets: inherit`);
        }
        if (
          each.uses !== undefined &&
          !each.uses.startsWith("./.github/workflows/")
        ) {
          strays.push(`${file} ${name}: reusable workflow ${each.uses}`);
        }
        if (
          each.uses === "./.github/workflows/deploy-platform.yml" &&
          !DEPLOY_STAGES.includes(String(each.with?.stage))
        ) {
          strays.push(
            `${file} ${name}: deploys stage ${String(each.with?.stage)}`
          );
        }
      }
    }
    const byHand = z
      .object({
        on: z.object({
          workflow_dispatch: z.object({
            inputs: z.object({
              stage: z.object({ options: z.array(z.string()) }),
            }),
          }),
        }),
      })
      .parse(readYaml(".github/workflows/deploy-platform.yml"));

    expect({
      strays,
      deployByHand: byHand.on.workflow_dispatch.inputs.stage.options,
    }).toStrictEqual({ strays: [], deployByHand: DEPLOY_STAGES });
  });

  it("runs only GitHub's own actions, at the commits reviewed, and the signer, on the runner's own Node, with no more than read access to the code", () => {
    // The job exactly, pins included: any other step, input, environment
    // variable, shell, container, permission or action commit changes
    // what runs beside the key, and fails here (a pin's bump included,
    // so it's reviewed as a change to this code-owned file).
    expect({
      job,
      workflow: { env: ci.env, defaults: ci.defaults },
    }).toStrictEqual({
      job: {
        name: "sign-release",
        needs: ["stage-release", "signing-environment"],
        if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.stage-release.outputs.staged == 'true'",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        environment: ENVIRONMENT,
        permissions: { contents: "read" },
        steps: [
          {
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              "persist-credentials": false,
              "sparse-checkout": "scripts/release/sign-manifest.ts",
              "sparse-checkout-cone-mode": false,
            },
          },
          {
            uses: "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
            with: {
              name: "release-manifest",
              path: `\${{ runner.temp }}/release-manifest`,
            },
          },
          {
            run: 'node scripts/release/sign-manifest.ts "$RUNNER_TEMP/release-manifest"',
            env: { [SECRET]: `\${{ secrets.${SECRET} }}` },
          },
          {
            uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
            with: {
              name: "release-signature",
              path: `\${{ runner.temp }}/release-manifest/manifest.signature.json`,
              "if-no-files-found": "error",
              "retention-days": 14,
            },
          },
        ],
      },
      workflow: { env: undefined, defaults: undefined },
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
