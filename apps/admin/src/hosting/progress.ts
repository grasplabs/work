/**
 * Setting an organization up, as the people who created it watch it: one
 * line per thing that actually happens, in plain words, each waiting,
 * being done, done, being tried again or needing a look, with what's
 * technical under its details.
 *
 * The lines are the operation's own steps (`provisionSteps`,
 * src/hosting/operation.ts), each in exactly one line (`cloudLines`, a
 * test holds them to it), so the view can't drift from what runs; then
 * its admins, invited once it's live. An on-prem organization
 * has the steps of its install connecting instead, which arrive with
 * GRA-1291: until then they wait, and say so.
 */
import { and, eq } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import { clientRuns, clients } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { clientSignInSchema } from "../deploy/core-config.ts";
import { currentRun, hasEnded } from "../runners.ts";
import { needsAttentionOf } from "./attention.ts";
import { provisionOf, provisionSteps } from "./operation.ts";
import type { ProvisionStep } from "./operation.ts";
import { clientHostingOf } from "./organization.ts";
import type { Jurisdiction } from "./organization.ts";
import { operationErrorWords } from "./words.ts";

/** Where one line stands. */
export type LineState =
  | "waiting"
  | "doing"
  | "done"
  | "retrying"
  | "needs_attention";

export interface ProgressLine {
  id: string;
  label: string;
  state: LineState;
  /** What's technical about it, for staff who open its details. */
  details: string[];
}

/** What a line's words are made from. */
interface LineContext {
  hostname: string;
  releaseId: string | null;
  /** Its sign-in providers in words (`signInProvidersOf`); null when none is known. */
  signIn: string | null;
  jurisdiction: Jurisdiction;
}

/** A line of Grasp's cloud's own steps. */
interface CloudLine {
  id: string;
  steps: readonly ProvisionStep[];
  label: (context: LineContext) => string;
  details: (context: LineContext) => string[];
}

/** Every step of the operation, each in one line, in order. */
export const cloudLines: readonly CloudLine[] = [
  {
    id: "reserve",
    steps: ["validated"],
    label: ({ hostname }) => `Reserving ${hostname}`,
    details: ({ releaseId }) => [
      `Release ${releaseId ?? "not chosen yet"} checked, and the organization's resources named`,
    ],
  },
  {
    id: "storage",
    steps: ["resources", "migrations"],
    label: () => "Creating its databases and file storage",
    details: ({ jurisdiction }) => [
      jurisdiction === "eu"
        ? "Created in Cloudflare's EU jurisdiction, and read back"
        : "Created in Cloudflare's network, in no jurisdiction",
      "Its databases brought to the release's schema",
    ],
  },
  {
    id: "install",
    steps: ["connect", "core"],
    label: () => "Installing Grasp",
    details: () => ["Its connect, then its core, uploaded and observed live"],
  },
  {
    id: "sign_in",
    steps: ["secrets"],
    label: ({ signIn }) =>
      signIn === null
        ? "Setting up sign-in"
        : `Setting up sign-in with ${signIn}`,
    details: () => ["Its keys and sign-in delivered to its Workers"],
  },
  {
    id: "reachable",
    steps: ["probe"],
    label: ({ hostname }) =>
      `Making sure ${hostname} is reachable and everything answers`,
    details: () => [
      "Its health check answers as the version just installed",
      "It answers the admin's signed probe as this organization",
      "Each of its databases, buckets and Durable Objects answers, and its clocks run",
    ],
  },
  {
    id: "publish",
    steps: ["mail", "route"],
    label: ({ hostname }) => `Publishing ${hostname}`,
    details: () => ["Its address added to Grasp's router"],
  },
];

/** What an on-prem organization's install does, once GRA-1291 lands. */
const onPremLines = (releaseId: string | null): ProgressLine[] => [
  {
    id: "pairing",
    label: "Create pairing credential",
    state: "waiting",
    details: [],
  },
  {
    id: "connect",
    label: "Waiting for your install to connect",
    state: "waiting",
    details: [],
  },
  {
    id: "heartbeat",
    label: "First heartbeat received",
    state: "waiting",
    details: [],
  },
  {
    id: "up_to_date",
    label:
      releaseId === null
        ? "Up to date on the newest release"
        : `Up to date on release ${releaseId}`,
    state: "waiting",
    details: [],
  },
];

/**
 * An on-prem organization's setting up: its install's steps, each
 * waiting until GRA-1291 brings pairing, heartbeats and updates.
 */
const onPremProgress = (
  hostname: string | null,
  startedAt: Date,
  admins: string[]
): ProvisioningProgress => ({
  hosting: "on_prem",
  hostname,
  lines: onPremLines(null),
  state: "waiting",
  notice:
    "On-prem setup arrives with GRA-1291: its install will pair, connect and report here by itself.",
  code: null,
  startedAt,
  readyAt: null,
  admins,
});

/** The organization's setting up, as its progress view shows it. */
export interface ProvisioningProgress {
  hosting: "grasp_cloud" | "on_prem";
  /** `<id>.<domain>`; null while the admin has no domain. */
  hostname: string | null;
  lines: ProgressLine[];
  /** Where it all stands: still going, live, or waiting on someone. */
  state: "working" | "ready" | "needs_attention" | "waiting";
  /** Why it waits, or needs a look, in a sentence; null while it goes. */
  notice: string | null;
  /** The code it stopped with, for its details. */
  code: string | null;
  startedAt: Date;
  /** When it went live; null until then. */
  readyAt: Date | null;
  admins: string[];
}

/**
 * The sign-in providers its sign-in config names, in words, as the create
 * page's detection or staff set them: Google Workspace, Microsoft 365, or
 * both; null for none known.
 */
export const signInProvidersOf = (signIn: string | null): string | null => {
  const parsed = clientSignInSchema.safeParse(
    signIn === null ? null : JSON.parse(signIn)
  );
  if (!parsed.success) {
    return null;
  }
  const providers = [
    ...(parsed.data.googleHostedDomain === undefined
      ? []
      : ["Google Workspace"]),
    ...(parsed.data.entraTenantId === undefined ? [] : ["Microsoft 365"]),
  ];
  return providers.length === 0 ? null : providers.join(" and ");
};

/** The admins its sign-in names. */
const adminsOf = (signIn: string | null): string[] => {
  const parsed = clientSignInSchema.safeParse(
    signIn === null ? null : JSON.parse(signIn)
  );
  return parsed.success ? parsed.data.admins : [];
};

/** Where `step` is in the operation's order; -1 before the first. */
const stepOrder: readonly string[] = provisionSteps;
const stepIndex = (step: string | null): number =>
  step === null ? -1 : stepOrder.indexOf(step);

/**
 * Where each of the operation's lines stands: done up to the last step
 * it finished; the next being done while a run goes (tried again once
 * its run is on a later attempt). Once it stopped, being tried again, as
 * the admin resumes it by itself (src/hosting/reconcile.ts), unless the
 * admin gave up and asked a person to look (`needsAttention`).
 */
const cloudLineStates = (
  operation: { status: "running" | "failed" | "done"; step: string | null },
  going: boolean,
  retrying: boolean,
  needsAttention: boolean
): LineState[] => {
  // Running or stopped, it records the last step it finished.
  const lastDone =
    operation.status === "done"
      ? provisionSteps.length - 1
      : stepIndex(operation.step);
  let current = false;
  return cloudLines.map((line) => {
    const last = Math.max(...line.steps.map((step) => stepIndex(step)));
    if (last <= lastDone) {
      return "done";
    }
    if (current) {
      return "waiting";
    }
    current = true;
    if (operation.status === "failed" && !going) {
      return needsAttention ? "needs_attention" : "retrying";
    }
    if (!going) {
      return "waiting";
    }
    return retrying ? "retrying" : "doing";
  });
};

/** Whether client `clientId`'s provisioning run goes, and is on a later attempt. */
const runOf = async (
  env: Env,
  clientId: string
): Promise<{ going: boolean; retrying: boolean }> => {
  const run = await currentRun(env, clientId);
  const going =
    run !== null && run.kind === "provision_placed" && !hasEnded(run.status);
  const claim = await adminDatabase(env.DB)
    .select({ attempt: clientRuns.attempt })
    .from(clientRuns)
    .where(
      and(
        eq(clientRuns.clientId, clientId),
        eq(clientRuns.kind, "provision_placed")
      )
    )
    .get();
  return { going, retrying: going && (claim?.attempt ?? 0) > 1 };
};

/** Where it all stands, from what its lines say. */
const overallState = (
  ready: boolean,
  stopped: boolean,
  notStarted: boolean
): ProvisioningProgress["state"] => {
  if (ready) {
    return "ready";
  }
  if (stopped) {
    return "needs_attention";
  }
  return notStarted ? "waiting" : "working";
};

/** Client `clientId`'s setting up, or null when there's no such client. */
export const provisioningProgress = async (
  env: Env,
  clientId: string
): Promise<ProvisioningProgress | null> => {
  const db = adminDatabase(env.DB);
  const client = await db
    .select({
      status: clients.status,
      signIn: clients.signIn,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    return null;
  }
  const { hosting, jurisdiction } = await clientHostingOf(db, clientId);
  const domain = clientDomain(env);
  const hostname = domain === null ? null : `${clientId}.${domain}`;
  const admins = adminsOf(client.signIn);
  const operation = await provisionOf(db, clientId);
  if (hosting === "on_prem") {
    return onPremProgress(hostname, client.createdAt, admins);
  }
  const { going, retrying } = await runOf(env, clientId);
  const attention = await needsAttentionOf(db, clientId);
  const context: LineContext = {
    hostname: hostname ?? clientId,
    releaseId: operation?.releaseId ?? null,
    signIn: signInProvidersOf(client.signIn),
    jurisdiction,
  };
  const states =
    operation === undefined
      ? cloudLines.map((): LineState => "waiting")
      : cloudLineStates(operation, going, retrying, attention !== null);
  const lines: ProgressLine[] = cloudLines.map((line, at) => ({
    id: line.id,
    label: line.label(context),
    state: states[at] ?? "waiting",
    details: line.details(context),
  }));
  const ready = client.status === "active" || operation?.status === "done";
  lines.push({
    id: "admins",
    label: "Inviting admins",
    state: ready ? "done" : "waiting",
    details: admins.map(
      (email) =>
        `${email} becomes an admin on first signing in at ${hostname ?? clientId}`
    ),
  });
  const stopped = lines.some(({ state }) => state === "needs_attention");
  return {
    hosting: "grasp_cloud",
    hostname,
    lines,
    state: overallState(ready, stopped, operation === undefined && !going),
    notice:
      stopped && typeof operation?.error === "string"
        ? operationErrorWords(operation.error)
        : null,
    code: operation?.error ?? null,
    startedAt: client.createdAt,
    readyAt: ready ? (operation?.updatedAt ?? null) : null,
    admins,
  };
};
