import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  planDocumentText,
  signPlanText,
} from "@grasp-os/connector-kit/plan-signature";
import {
  sessionTicketMaxMs,
  sessionTicketText,
  signSessionTicket,
  textDigest,
} from "@grasp-os/connector-kit/session-ticket";
import type { SessionDispatch } from "@grasp-os/connector-kit/session-ticket";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { z } from "zod";

import {
  agentSettings,
  artifactProblems,
  commitMessage,
  mainRef,
  nonceUsed,
  verifyStart,
} from "./connector-session.ts";
import type { ArtifactEntry, SessionStart } from "./connector-session.ts";

// A session of Grasp's agent (connector-session.ts and the
// connector-agent workflow), from its threat model: a forged or replayed
// plan, a plan for a different branch, an attempt to reach secrets, and a
// push outside the branch. The ticket's own signature and bounds have
// tests of their own (packages/connector-kit/test/session-ticket.test.ts).

const app = "example-hr";
const folder = `packages/connectors/${app}`;
const now = Date.parse("2026-10-29T09:00:00Z");
const nonce = "0123456789abcdef0123456789abcdef";

/** An Ed25519 key pair: the private half as the admin keeps it, the public as CI does. */
const keyPair = () => {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: der.subarray(-32).toString("base64"),
  };
};

const admin = keyPair();

/** The approved plan for `forApp`, as the admin writes it. */
const planText = (forApp = app): string =>
  planDocumentText({
    app: forApp,
    round: 1,
    plan: {
      app: forApp,
      signIn: "api_key",
      hosts: ["api.example-hr.test"],
      actions: [],
      docs: [
        "https://developer.example-hr.test/docs",
        "https://developer.example-hr.test/auth",
      ],
    },
  });

/** A dispatch of the plan for `planApp`, with a ticket for `ticketApp`, signed by the admin. */
const dispatchFor = async (
  planApp = app,
  ticketApp = app
): Promise<SessionDispatch> => {
  const plan = planText(planApp);
  const ticket = sessionTicketText({
    app: ticketApp,
    round: 1,
    plan: await textDigest(plan),
    nonce,
    run: `build-${ticketApp}-0123456789ab`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + sessionTicketMaxMs).toISOString(),
  });
  return {
    plan,
    planSignature: await signPlanText(admin.privateKey, plan),
    ticket,
    ticketSignature: await signSessionTicket(admin.privateKey, ticket),
  };
};

/** The session `dispatch` starts from `ref`, or its problems. */
const startOf = async (
  dispatch: SessionDispatch,
  ref = mainRef
): Promise<SessionStart | { problems: string[] }> =>
  await verifyStart({ ref, publicKey: admin.publicKey, dispatch }, now);

/** A session that may start, for the tests that need one. */
const started = async (): Promise<SessionStart> => {
  const start = await startOf(await dispatchFor());
  if ("problems" in start) {
    throw new Error(start.problems.join("; "));
  }
  return start;
};

const file = (at: string, bytes = 100): ArtifactEntry => ({
  path: at,
  kind: "file",
  bytes,
});

/** A connector as the agent leaves it: its folder, and the lockfile. */
const cleanArtifact: ArtifactEntry[] = [
  { path: "packages", kind: "directory", bytes: 0 },
  { path: "packages/connectors", kind: "directory", bytes: 0 },
  { path: folder, kind: "directory", bytes: 0 },
  file(`${folder}/package.json`),
  file(`${folder}/src/index.ts`),
  // The repository's own lockfile is megabytes long.
  file("pnpm-lock.yaml", 900 * 1024),
];

describe("starting a session", () => {
  it("starts on main's workflow, on the branch of the app its plan and ticket both name, and fetches only the plan's docs", async () => {
    const start = await startOf(await dispatchFor());

    expect(
      "problems" in start
        ? start
        : {
            app: start.app,
            branch: start.branch,
            nonce: start.nonce,
            docsHosts: start.docsHosts,
          }
    ).toStrictEqual({
      app,
      branch: `feat/connector-${app}`,
      nonce,
      docsHosts: ["developer.example-hr.test"],
    });
  });

  it("starts nothing for a different branch: a dispatch from another ref, or a ticket for one app with another's plan", async () => {
    expect({
      anotherRef: await startOf(await dispatchFor(), "refs/heads/feat/x"),
      anotherApp: await startOf(await dispatchFor("example-crm", app)),
    }).toStrictEqual({
      anotherRef: {
        problems: [
          "A session runs only from main's workflow, not refs/heads/feat/x",
        ],
      },
      anotherApp: {
        problems: [
          "The session ticket is for example-hr, the plan for example-crm",
        ],
      },
    });
  });

  it("starts nothing forged: a plan edited after the admin signed it", async () => {
    const dispatch = await dispatchFor();

    await expect(
      startOf({
        ...dispatch,
        plan: dispatch.plan.replace("api.example-hr.test", "evil.test"),
      })
    ).resolves.toStrictEqual({
      problems: ["The plan isn't signed by the admin's plan key"],
    });
  });

  it("starts a ticket's session once: a nonce a commit on the branch carries is used", async () => {
    const start = await started();
    const message = commitMessage(
      start,
      "https://github.com/grasplabs/work/actions/runs/1"
    );

    expect({
      pushed: nonceUsed(`${message}\n\nfix: an earlier commit\n`, nonce),
      fresh: nonceUsed("feat(connect): add the example-hr connector\n", nonce),
      quoted: nonceUsed(`It said Grasp-Session: ${nonce} somewhere`, nonce),
    }).toStrictEqual({ pushed: true, fresh: false, quoted: false });
  });
});

describe("what the session may push", () => {
  it("takes the new connector's folder and the lockfile", () => {
    expect(artifactProblems(app, cleanArtifact)).toStrictEqual([]);
  });

  it("refuses anything outside the folder: CI, another connector, a path that climbs out or is absolute", () => {
    expect(
      artifactProblems(app, [
        ...cleanArtifact,
        file(".github/workflows/ci.yml"),
        file("packages/connectors/slack/src/index.ts"),
        file(`${folder}/../slack/index.ts`),
        file("/etc/passwd"),
        file("scripts/connector-guard.ts"),
      ])
    ).toStrictEqual([
      ".github/workflows/ci.yml is outside packages/connectors/example-hr",
      "packages/connectors/slack/src/index.ts is outside packages/connectors/example-hr",
      '"packages/connectors/example-hr/../slack/index.ts" isn\'t a plain relative path',
      '"/etc/passwd" isn\'t a plain relative path',
      "scripts/connector-guard.ts is outside packages/connectors/example-hr",
    ]);
  });

  it("refuses links and other special files, files too large, and a connector without its package.json", () => {
    expect(
      artifactProblems(app, [
        { path: `${folder}/secrets`, kind: "symlink", bytes: 0 },
        { path: `${folder}/pipe`, kind: "other", bytes: 0 },
        file(`${folder}/huge.json`, 600 * 1024),
        file("pnpm-lock.yaml", 17 * 1024 * 1024),
      ])
    ).toStrictEqual([
      `${folder}/secrets isn't a regular file`,
      `${folder}/pipe isn't a regular file`,
      `${folder}/huge.json is larger than 524288 bytes`,
      "pnpm-lock.yaml is larger than 16777216 bytes",
      `The session wrote no ${folder}/package.json`,
    ]);
  });
});

describe("what the agent may reach", () => {
  it("changes only its folder, runs only the repository's checks, and fetches only the plan's docs, asking nobody", async () => {
    const settings = agentSettings(await started());

    expect(settings).toStrictEqual({
      permissions: {
        defaultMode: "dontAsk",
        allow: [
          "Read",
          "Glob",
          "Grep",
          `Edit(${folder}/**)`,
          `Write(${folder}/**)`,
          "Bash(vp check:*)",
          "Bash(vp test:*)",
          "Bash(vp install --offline --ignore-scripts:*)",
          "WebFetch(domain:developer.example-hr.test)",
        ],
        deny: ["WebSearch", "Bash(git push:*)", "Bash(curl:*)", "Bash(wget:*)"],
      },
    });
  });
});

/** The connector-agent workflow, as GitHub reads it. */
const stepSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(
    z.string(),
    z.object({
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      environment: z.string().optional(),
      permissions: z.record(z.string(), z.string()).optional(),
      steps: z.array(stepSchema),
    })
  ),
});

const workflow = workflowSchema.parse(
  parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        ".github",
        "workflows",
        "connector-agent.yml"
      ),
      "utf-8"
    )
  )
);

const secretPattern = /secrets\.[A-Z_]+/gu;

/** A run that interpolates what was dispatched into the script itself. */
const interpolation = /\$\{\{\s*(?:inputs|github\.event)\./u;

/** Whether `text` is there and has `part`. */
const has = (text: string | undefined, part: string): boolean =>
  text !== undefined && text.includes(part);

/** What a step of the push job after the download runs, by name. */
const runKind = (run: string): string => {
  if (run.includes("run-connector-session.ts collect")) {
    return "collect";
  }
  return run.split("\n").some((line) => line.trim().startsWith("git push"))
    ? "push"
    : run;
};

/** Every `${{ secrets.X }}` job `name` refers to. */
const secretsOf = (name: string): string[] => {
  const text = JSON.stringify(workflow.jobs[name]);
  return [...new Set(text.match(secretPattern))];
};

/** Job `name`'s steps. */
const stepsOf = (name: string) => workflow.jobs[name]?.steps ?? [];

describe("the connector-agent workflow", () => {
  it("runs only when dispatched, and every job can only read the repository with GitHub's own token", () => {
    expect({
      on: Object.keys(workflow.on),
      permissions: workflow.permissions,
      jobs: Object.fromEntries(
        Object.entries(workflow.jobs).map(([name, job]) => [
          name,
          job.permissions ?? workflow.permissions,
        ])
      ),
    }).toStrictEqual({
      on: ["workflow_dispatch"],
      permissions: { contents: "read" },
      jobs: {
        verify: { contents: "read" },
        session: { contents: "read" },
        push: { contents: "read" },
      },
    });
  });

  it("gives the agent's job no secret but its own Anthropic key, and keeps no GitHub token in its checkout", () => {
    const checkout = stepsOf("session").find(({ uses }) =>
      has(uses, "actions/checkout@")
    );

    expect({
      verify: secretsOf("verify"),
      session: secretsOf("session"),
      environment: workflow.jobs.session?.environment,
      persisted: checkout?.with?.["persist-credentials"],
    }).toStrictEqual({
      verify: [],
      session: ["secrets.CONNECTOR_AGENT_ANTHROPIC_KEY"],
      environment: "connector-agent-session",
      persisted: false,
    });
  });

  it("holds the App's key only in the push job, asks it for a token only after the commit is checked, and runs nothing the agent wrote there", () => {
    const steps = stepsOf("push");
    const commit = steps.findIndex(({ id }) => id === "commit");
    const token = steps.findIndex(({ uses }) =>
      has(uses, "actions/create-github-app-token@")
    );
    const afterDownload = steps
      .slice(
        steps.findIndex(({ uses }) => has(uses, "actions/download-artifact@"))
      )
      .flatMap(({ run }) => (run === undefined ? [] : [run]));

    expect({
      push: secretsOf("push"),
      environment: workflow.jobs.push?.environment,
      tokenAfterCommit: commit !== -1 && token > commit,
      tokenPermissions: Object.keys(steps[token]?.with ?? {}).filter((key) =>
        key.startsWith("permission-")
      ),
      runsAfterDownload: afterDownload.map((run) => runKind(run)),
    }).toStrictEqual({
      push: ["secrets.CONNECTOR_AGENT_PRIVATE_KEY"],
      environment: "connector-agent",
      tokenAfterCommit: true,
      tokenPermissions: ["permission-contents", "permission-pull-requests"],
      runsAfterDownload: ["collect", "push"],
    });
  });

  it("checks the later jobs' dispatch as of when verify accepted it, so a long session still pushes", () => {
    const verifiedAtOutput = [
      "$",
      "{{ needs.verify.outputs.verified_at }}",
    ].join("");
    const acceptedAt = (job: string) =>
      stepsOf(job).find(({ run }) => has(run, "run-connector-session.ts"))?.env
        ?.VERIFIED_AT;

    expect({
      verify: acceptedAt("verify"),
      session: acceptedAt("session"),
      push: acceptedAt("push"),
    }).toStrictEqual({
      verify: undefined,
      session: verifiedAtOutput,
      push: verifiedAtOutput,
    });
  });

  it("checks the dispatch first in every job, and passes what was dispatched to scripts only through env", () => {
    const interpolated = Object.values(workflow.jobs)
      .flatMap(({ steps }) => steps)
      .flatMap(({ run }) => (run === undefined ? [] : [run]))
      .filter((run) => interpolation.test(run));
    const checksFirst = Object.fromEntries(
      Object.entries(workflow.jobs).map(([name, { steps }]) => [
        name,
        steps.find(({ run }) => has(run, "run-connector-session.ts"))?.run,
      ])
    );

    expect({ interpolated, checksFirst }).toStrictEqual({
      interpolated: [],
      checksFirst: {
        verify: "node scripts/run-connector-session.ts verify",
        session: "node scripts/run-connector-session.ts brief",
        push: "node scripts/run-connector-session.ts collect",
      },
    });
  });
});
