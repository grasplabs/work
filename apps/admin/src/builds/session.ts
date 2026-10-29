/**
 * The agent's session that writes a build's connector (GRA-689, S3): a run
 * of the repository's `connector-agent` workflow, on GitHub Actions, which
 * the admin starts when a build whose plan a person approved starts
 * writing (src/builds/workflow.ts). What the workflow holds the session to
 * is the repository's scripts/connector-session.ts.
 *
 * The admin dispatches it with the approved plan, signed
 * (src/builds/plan-signing.ts), and a session ticket it signs with the same
 * key: the plan's digest, the build's run, a nonce and an hour to start in
 * (`@grasp-os/connector-kit/session-ticket`). The workflow verifies both
 * before it does anything, so a dispatch nobody signed, or one signed long
 * ago, starts nothing; and the nonce, kept on the build before the
 * dispatch, means a dispatch sent twice (a step run again) pushes once.
 *
 * The run's id and page are kept on the build, so its page links the
 * session's logs, which the workflow keeps as artifacts. The admin reads
 * how the run went from GitHub; nothing the session does calls the admin.
 *
 * GitHub is reached with `AGENT_DISPATCH_TOKEN`, a token that may only run
 * this repository's workflows. Until a person stores it, and the plan
 * signing key, no session starts: a build that starts writing waits for
 * its pull request as it did before sessions existed, and stops for a
 * person when none comes.
 */
import {
  newSessionNonce,
  sessionTicketMaxMs,
  sessionTicketText,
  signSessionTicket,
  textDigest,
} from "@grasp-os/connector-kit/session-ticket";
import { log } from "@grasp-os/shared/log";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { actIfChanged, adminDatabase } from "../db/act.ts";
import { integrationBuilds } from "../db/schema.ts";
import { MissingStoreSecretError, storeSecret } from "../deploy/context.ts";
import { stop } from "../workflow-steps.ts";
import {
  BuildError,
  buildBranch,
  buildOf,
  recordPullRequest,
} from "./builds.ts";
import { signedPlan } from "./plan-signing.ts";

/** The repository the agent writes connectors in. */
export const agentRepository = { owner: "grasplabs", name: "work" } as const;

/** The workflow a session is a run of. */
export const agentWorkflow = "connector-agent.yml";

const githubApi = "https://api.github.com";

/** How long a call to GitHub may take. */
const githubTimeoutMs = 30_000;

/** A call to GitHub's API as the admin's dispatch token. */
const github = async (
  token: string,
  route: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> =>
  await fetch(`${githubApi}${route}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "grasp-os-admin",
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(githubTimeoutMs),
  });

/**
 * GitHub's refusal to `what`, as a step fails with it: a rate limit or an
 * outage is retried; anything else, such as a token without access or a
 * workflow main doesn't have, stops the build for a person. Its status,
 * never its body, which could echo what was sent.
 */
const refused = (what: string, status: number): Error =>
  status === 429 || status >= 500
    ? new Error(`github_${status}: GitHub couldn't ${what}`)
    : stop(`github_${status}`, `GitHub refused to ${what}`);

const base64 = (text: string): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(text)));

/** What a dispatch answers when asked for its run. */
const dispatchedSchema = z.object({
  workflow_run_id: z.number().int().positive(),
  html_url: z.url(),
});

/** A session, as the build keeps it. */
export interface Session {
  run: number;
  url: string;
}

/**
 * The build's ticket nonce: the one it has, or a new one kept on it now,
 * while it is still writing. A dispatch made again with it pushes once.
 */
const nonceOf = async (env: Env, app: string): Promise<string> => {
  const db = adminDatabase(env.DB);
  await db
    .update(integrationBuilds)
    .set({ sessionNonce: newSessionNonce() })
    .where(
      and(
        eq(integrationBuilds.app, app),
        eq(integrationBuilds.stage, "writing"),
        isNull(integrationBuilds.sessionNonce)
      )
    );
  const build = await buildOf(db, app);
  if (build?.stage !== "writing" || build.sessionNonce === null) {
    throw new BuildError("wrong_stage", `The build of ${app} isn't writing`);
  }
  return build.sessionNonce;
};

/** The admin's dispatch token and plan key, or undefined until a person stored both. */
const sessionKeys = async (
  env: Env
): Promise<{ token: string; planKey: string } | undefined> => {
  try {
    return {
      token: await storeSecret(env, "AGENT_DISPATCH_TOKEN"),
      planKey: await storeSecret(env, "PLAN_SIGNING_KEY"),
    };
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Starts the agent's session for the build of `app`, which must be
 * writing from a plan a person approved: its run, kept on the build and
 * audited. A build with a session keeps it. `undefined` for a build no
 * longer writing, and while the admin isn't set up to start sessions.
 */
export const startSession = async (
  env: Env,
  app: string
): Promise<Session | undefined> => {
  const db = adminDatabase(env.DB);
  const build = await buildOf(db, app);
  if (
    build !== null &&
    build.sessionRun !== null &&
    build.sessionUrl !== null
  ) {
    return { run: build.sessionRun, url: build.sessionUrl };
  }
  // A build that moved on meanwhile (its pull request recorded, or
  // stopped) has no session to start.
  if (build?.stage !== "writing") {
    return undefined;
  }
  const keys = await sessionKeys(env);
  if (keys === undefined) {
    log.warn("build.session_unavailable", { app });
    return undefined;
  }
  const nonce = await nonceOf(env, app);
  const plan = await signedPlan(env, app);
  const issued = Date.now();
  const ticket = sessionTicketText({
    app,
    round: build.planRound,
    plan: await textDigest(plan.text),
    nonce,
    run: build.runId,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + sessionTicketMaxMs).toISOString(),
  });
  const response = await github(
    keys.token,
    `/repos/${agentRepository.owner}/${agentRepository.name}/actions/workflows/${agentWorkflow}/dispatches`,
    {
      method: "POST",
      body: {
        ref: "main",
        inputs: {
          plan: base64(plan.text),
          plan_signature: plan.signature,
          ticket: base64(ticket),
          ticket_signature: await signSessionTicket(keys.planKey, ticket),
        },
        return_run_details: true,
      },
    }
  );
  if (!response.ok) {
    throw refused("start the agent's session", response.status);
  }
  const dispatched = dispatchedSchema.parse(await response.json());
  const session = {
    run: dispatched.workflow_run_id,
    url: dispatched.html_url,
  };
  await actIfChanged(
    db,
    "system",
    db
      .update(integrationBuilds)
      .set({
        sessionRun: session.run,
        sessionUrl: session.url,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationBuilds.app, app),
          eq(integrationBuilds.stage, "writing")
        )
      ),
    {
      action: "build.session",
      target: app,
      detail: { stage: "writing", run: session.run, round: build.planRound },
    }
  );
  return session;
};

/** How a session's run stands, as GitHub says. */
const runSchema = z.object({
  status: z.string(),
  conclusion: z.string().nullable(),
});

/** What became of a session: still going, or how it ended. */
export type SessionOutcome = "running" | "succeeded" | "failed";

/** How session `run` of the build stands now. */
export const sessionOutcome = async (
  env: Env,
  run: number
): Promise<SessionOutcome> => {
  const token = await storeSecret(env, "AGENT_DISPATCH_TOKEN");
  const response = await github(
    token,
    `/repos/${agentRepository.owner}/${agentRepository.name}/actions/runs/${run}`
  );
  if (!response.ok) {
    throw refused("say how the agent's session went", response.status);
  }
  const { status, conclusion } = runSchema.parse(await response.json());
  if (status !== "completed") {
    return "running";
  }
  return conclusion === "success" ? "succeeded" : "failed";
};

/** The open pull requests GitHub lists, as far as the build reads them. */
const pullsSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    head: z.object({ ref: z.string() }),
  })
);

/**
 * Records the pull request the session of the build of `app` opened, as
 * GitHub lists it open from the build's own branch: `writing` to
 * `in_review`. False when there is none.
 */
export const recordSessionPullRequest = async (
  env: Env,
  app: string
): Promise<boolean> => {
  const token = await storeSecret(env, "AGENT_DISPATCH_TOKEN");
  const branch = buildBranch(app);
  const head = `${agentRepository.owner}:${branch}`;
  const response = await github(
    token,
    `/repos/${agentRepository.owner}/${agentRepository.name}/pulls?state=open&head=${encodeURIComponent(head)}`
  );
  if (!response.ok) {
    throw refused("list the agent's pull request", response.status);
  }
  const pull = pullsSchema
    .parse(await response.json())
    .find((each) => each.head.ref === branch);
  if (pull === undefined) {
    return false;
  }
  await recordPullRequest(env, app, { number: pull.number, branch });
  return true;
};
