/**
 * CI's release signer (sign-manifest.ts), run as sign-release runs it
 * (fake-google.ts): in a Node of its own, with the environment GitHub
 * gives a job, against stand-ins for GitHub's token service, Google's
 * Security Token Service and Cloud KMS. What it signs must verify with the
 * shared package's release-signature module, which every import,
 * promotion and on-premises install uses.
 *
 * Threat model: the key never leaves KMS, so what matters is who can get
 * something signed. Google lets a token through only for this
 * repository's ci.yml on main, a push, a GitHub-hosted runner and the
 * `release-signing` environment, so the job that names that environment
 * must run nothing but GitHub's own actions, pinned, and this one file,
 * which imports nothing but Node's built-ins; no other job may name the
 * environment, Google's provider or the key; and the signer must sign
 * nothing but a manifest of its own run's commit, for a push to main,
 * under an id of this month (a far-off id would hold Edge for good), and
 * only what KMS says it signed with the key version asked for, intact.
 * The checks on the workflows catch mistakes; review of the paths
 * .github/CODEOWNERS names is the control.
 */
import { createHash } from "node:crypto";
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

import {
  RELEASE_SIGNATURE_FILE,
  releaseSignatureProblem,
  releaseSignatureSchema,
} from "@grasp-os/shared/release-signature";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { z } from "zod";

import {
  releaseSigningKeys,
  testReleaseSigningKey,
} from "../../packages/shared/test/release-signing-keys.ts";
import {
  ACCESS_TOKEN,
  crc32c,
  GITHUB_TOKEN,
  pushToMain,
  runSigner,
  TEST_NOW,
  TEST_PROVIDER,
  TOKEN_REQUEST_URL,
} from "./fake-google.ts";
import type { GoogleFault } from "./fake-google.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const SIGNER = path.join(import.meta.dirname, "sign-manifest.ts");
const COMMIT = "c".repeat(40);
const ENVIRONMENT = "release-signing";

const key = testReleaseSigningKey;

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

  const sign = async (
    env: Record<string, string> = pushToMain(COMMIT),
    options: { at?: string; fault?: GoogleFault } = {}
  ) => await runSigner(dir, { env, key, ...options });

  const signed = (): boolean =>
    existsSync(path.join(dir, RELEASE_SIGNATURE_FILE));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-sign-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("has KMS sign the release's id and manifest hash so that every verifier takes it, asking each service as its documentation says", async () => {
    const bytes = writeManifest("26.11.7");
    const { code, requests } = await sign();
    const signature = readFileSync(path.join(dir, RELEASE_SIGNATURE_FILE));
    const changed = Buffer.from(bytes.toString().replace("signed", "s1gned"));
    const message = Buffer.from(
      `grasp-release-manifest\n26.11.7\n${createHash("sha256").update(bytes).digest("hex")}`
    );

    const { signature: _signed, ...named } = releaseSignatureSchema.parse(
      JSON.parse(signature.toString())
    );

    expect({
      code,
      named,
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
      // The stand-in's CRC32C, by which KMS checks the message, is the
      // standard one: its check value.
      checkValue: crc32c(Buffer.from("123456789")).toString(16),
      requests,
    }).toStrictEqual({
      code: 0,
      named: { alg: "Ed25519", keyId: key.id },
      problem: undefined,
      changed: "has a signature that doesn't match it",
      checkValue: "e3069283",
      requests: [
        {
          method: "GET",
          url: `${TOKEN_REQUEST_URL}&audience=${encodeURIComponent(`https://iam.googleapis.com/${TEST_PROVIDER}`)}`,
          headers: { authorization: "bearer request-token" },
        },
        {
          method: "POST",
          url: "https://sts.googleapis.com/v1/token",
          headers: { "content-type": "application/json" },
          body: {
            grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
            audience: `//iam.googleapis.com/${TEST_PROVIDER}`,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
            subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
            subjectToken: GITHUB_TOKEN,
          },
        },
        {
          method: "POST",
          url: `https://cloudkms.googleapis.com/v1/${key.id}:asymmetricSign`,
          headers: {
            authorization: `Bearer ${ACCESS_TOKEN}`,
            "content-type": "application/json",
          },
          body: {
            data: message.toString("base64"),
            dataCrc32c: String(crc32c(message)),
          },
        },
      ],
    });
  });

  it("signs only an id of this month, or of the month before in the first hours of a new one, with N at most 99,999", async () => {
    const cases = {
      thisMonth: { id: "26.11.7", at: TEST_NOW, signs: true },
      largestN: { id: "26.11.99999", at: TEST_NOW, signs: true },
      lastMonth: { id: "26.10.40", at: TEST_NOW, signs: false },
      nextMonth: { id: "26.12.1", at: TEST_NOW, signs: false },
      farOff: { id: "99.12.1", at: TEST_NOW, signs: false },
      tooLargeN: { id: "26.11.100000", at: TEST_NOW, signs: false },
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
    const outcomes: Record<string, boolean> = {};
    for (const [name, { id, at }] of Object.entries(cases)) {
      writeManifest(id);
      // oxlint-disable-next-line no-await-in-loop -- one directory, in turn
      const { code } = await sign(pushToMain(COMMIT), { at });
      outcomes[name] = code === 0;
    }

    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        Object.entries(cases).map(([name, { signs }]) => [name, signs])
      )
    );
  });

  it("asks nothing of anyone for a pull request, the merge queue, another branch, another commit or a local build, and says why", async () => {
    const id = "26.11.7";
    const cases: [string, string, () => Record<string, string>][] = [
      [
        "pullRequest",
        "Only a push signs",
        () => {
          writeManifest(id);
          return { ...pushToMain(COMMIT), GITHUB_EVENT_NAME: "pull_request" };
        },
      ],
      [
        "mergeQueue",
        "Only a push signs",
        () => {
          writeManifest(id);
          return { ...pushToMain(COMMIT), GITHUB_EVENT_NAME: "merge_group" };
        },
      ],
      [
        "otherBranch",
        "Only main signs",
        () => {
          writeManifest(id);
          return { ...pushToMain(COMMIT), GITHUB_REF: "refs/heads/feat/x" };
        },
      ],
      [
        "otherCommit",
        "this run is",
        () => {
          writeManifest(id, "d".repeat(40));
          return pushToMain(COMMIT);
        },
      ],
      [
        "localBuild",
        "isn't an id of this month's",
        () => {
          writeManifest("dev-abc");
          return pushToMain(COMMIT);
        },
      ],
      [
        "notJson",
        "isn't JSON",
        () => {
          writeFileSync(path.join(dir, "manifest.json"), "{ not json");
          return pushToMain(COMMIT);
        },
      ],
    ];

    const outcomes: Record<string, unknown> = {};
    for (const [name, reason, arrange] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one directory, in turn
      const { code, output, requests } = await sign(arrange());
      outcomes[name] = {
        code,
        said: output.includes(reason),
        asked: requests.length,
        signed: signed(),
      };
    }

    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        cases.map(([name]) => [
          name,
          { code: 1, said: true, asked: 0, signed: false },
        ])
      )
    );
  });

  it("writes no signature when GitHub, Google's token service or KMS refuses, or KMS answers for another key version or with bytes that fail their CRC32C, and says why", async () => {
    const cases: [GoogleFault | "noIdToken", string][] = [
      ["noIdToken", "ACTIONS_ID_TOKEN_REQUEST_URL is required"],
      ["githubRefuses", "GitHub's token service answered 500"],
      [
        "stsRefuses",
        'Google\'s Security Token Service answered 400: {"error":"unauthorized_client"',
      ],
      ["kmsRefuses", "Cloud KMS answered 403"],
      ["otherKeyVersion", `Cloud KMS signed with ${key.id}0, not ${key.id}`],
      ["signatureCrc", "Cloud KMS's signature doesn't match its CRC32C"],
      [
        "dataCrcUnchecked",
        "Cloud KMS didn't check the message against its CRC32C",
      ],
    ];

    const outcomes: Record<string, unknown> = {};
    for (const [fault, reason] of cases) {
      writeManifest("26.11.7");
      const { ACTIONS_ID_TOKEN_REQUEST_URL: _url, ...noIdToken } =
        pushToMain(COMMIT);
      // oxlint-disable-next-line no-await-in-loop -- one directory, in turn
      const { code, output } = await (fault === "noIdToken"
        ? sign(noIdToken)
        : sign(pushToMain(COMMIT), { fault }));
      outcomes[fault] = {
        code,
        said: output.includes(reason),
        signed: signed(),
      };
    }

    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        cases.map(([fault]) => [fault, { code: 1, said: true, signed: false }])
      )
    );
  });

  it("asks nothing of anyone while its identifiers aren't filled in", async () => {
    writeManifest("26.11.7");
    const { code, output, requests } = await runSigner(dir, {
      env: pushToMain(COMMIT),
      key,
      config: { workloadIdentityProvider: "", keyVersion: "" },
    });
    expect({
      code,
      said: output.includes("names no workload identity provider"),
      asked: requests.length,
      signed: signed(),
    }).toStrictEqual({ code: 1, said: true, asked: 0, signed: false });
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

  it("is the only one that names its environment, Google's services, the provider or the key", () => {
    // What a token Google takes would be asked for with, or what a job
    // would sign with: none of it anywhere but in sign-release.
    const identifiers = Object.values(
      z
        .record(z.string(), z.string())
        .parse(
          JSON.parse(
            readFileSync(
              path.join(import.meta.dirname, "release-signing.json"),
              "utf-8"
            )
          )
        )
    ).filter((value) => value !== "");
    const names = (value: unknown): boolean => {
      const json = JSON.stringify(value);
      return (
        /release-signing|googleapis|workloadIdentityPools|cryptoKeyVersions/u.test(
          json
        ) || identifiers.some((identifier) => json.includes(identifier))
      );
    };
    const others = githubFiles().filter((file) => {
      if (file === ".github/workflows/ci.yml") {
        const { "sign-release": _signing, ...rest } = ci.jobs ?? {};
        return names({ ...ci, jobs: rest });
      }
      return names(readYaml(file));
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

  it("runs only GitHub's own actions, at the commits reviewed, and the signer, on the runner's own Node, with a token for its OIDC identity and no more than read access to the code", () => {
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
        needs: ["stage-release"],
        if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.stage-release.outputs.staged == 'true'",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        environment: ENVIRONMENT,
        permissions: { contents: "read", "id-token": "write" },
        steps: [
          {
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              "persist-credentials": false,
              "sparse-checkout":
                "scripts/release/sign-manifest.ts\nscripts/release/release-signing.json\n",
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
