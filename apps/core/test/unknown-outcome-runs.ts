import { sha256Hex } from "@grasp-os/shared/encoding";
import type { Role } from "@grasp-os/shared/roles";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  graphDraftsUrl,
  graphLoseUrl,
  graphSentUrl,
} from "./connect-providers.ts";
import type { Idp } from "./idp.ts";
import { liveStatus } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  openRpc,
  routed,
  signedIn,
  signedInWithRole,
  staffPerson,
} from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
import {
  appWith,
  invoiceMail,
  runEvents,
  workflowFiles,
} from "./workflow-apps.ts";

// A run's side effect whose answer was lost, on a native connector
// (Microsoft 365, against Graph's answers), as the unknown-outcome tests
// (unknown-outcome-*.test.ts) bring it about and read what became of it.
// Each file calls `unknownOutcomesOf(mockIdp())` once, for its people.

export const day = 24 * 60 * 60 * 1000;

/** A signed-in person's API, on a connection of their own. */
const personApiOf = async (idp: Idp, role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};

export type Api = Awaited<ReturnType<typeof personApiOf>>;

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The outside systems connect reaches (test/connect-providers.ts). */
const providers = (): Fetcher => {
  const fetcher = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(fetcher)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return fetcher;
};

/** A shared Microsoft 365 account, connected by `admin`: its ID. */
export const connectShared = async (admin: Api): Promise<string> => {
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, `team-${crypto.randomUUID()}`),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  const shared = listed.find((connection) => connection.scope === "shared");
  if (shared === undefined) {
    throw new Error("Expected the shared connection");
  }
  return shared.id;
};

/** A mailbox of each test's own, so what Graph does for it is the test's. */
export const mailboxOf = (): string =>
  `invoices-${crypto.randomUUID()}@acme.test`;

/** Has Graph lose the answers of the mailbox's next `writes` writes. */
export const loseAnswers = async (
  mailbox: string,
  writes = 1
): Promise<void> => {
  await providers().fetch(graphLoseUrl, {
    method: "POST",
    body: JSON.stringify({ mailbox, writes }),
  });
};

/** How many mails Graph sent from `mailbox`. */
export const sentFrom = async (mailbox: string): Promise<number> => {
  const response = await providers().fetch(graphSentUrl);
  const sent = z
    .array(z.object({ mailbox: z.string() }))
    .parse(await response.json());
  return sent.filter((message) => message.mailbox === mailbox).length;
};

/**
 * What an auditor names each send from `mailbox` by: the SHA-256 of the tag
 * Graph keeps on the message, its effect key.
 */
export const receiptsFrom = async (mailbox: string): Promise<string[]> => {
  const response = await providers().fetch(graphSentUrl);
  const sent = z
    .array(z.object({ mailbox: z.string(), effectKey: z.string().nullable() }))
    .parse(await response.json());
  return await Promise.all(
    sent
      .filter((message) => message.mailbox === mailbox)
      .map(async ({ effectKey }) => await sha256Hex(effectKey ?? ""))
  );
};

/** The open obligations a JSON export of the log holds, for `api`. */
export const exportedObligations = async (api: Api["api"]) => {
  const stream = await api.audit.export(
    { from: new Date(Date.now() - 60_000).toISOString() },
    "json"
  );
  const exported = z
    .object({
      openObligations: z
        .object({
          complete: z.boolean(),
          obligations: z.array(z.record(z.string(), z.unknown())),
        })
        .nullable(),
    })
    .parse(JSON.parse(await new Response(stream).text()));
  return exported.openObligations;
};

/** How many drafts Graph made in `mailbox`. */
export const draftsIn = async (mailbox: string): Promise<number> => {
  const response = await providers().fetch(
    `${graphDraftsUrl}?mailbox=${encodeURIComponent(mailbox)}`
  );
  return z.object({ drafts: z.number() }).parse(await response.json()).drafts;
};

/**
 * A workflow `mailer` that calls `action` in its side-effect step, from
 * `mailbox`, under the step's key, with no retries; a call its person said
 * happened answers `{ resolved: true }`, as it has no answer of its own.
 */
export const mailer = (mailbox: string, action = "mail.send") =>
  workflowFiles(
    "mailer",
    `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify({ mailbox, subject: invoiceMail.subject, body: "Attached.", to: [invoiceMail.to] })}, retries: { limit: 0 } },
    async ({ idempotencyKey, input: mail }) => {
      try {
        return JSON.parse(((await env.MAIL.call(${JSON.stringify(action)}, mail, { idempotencyKey })) as { output: string }).output);
      } catch (error) {
        if ((error as { code?: string }).code === resolvedDone) {
          return { resolved: true };
        }
        throw error;
      }
    }
  );`,
    { send: { mailbox, sent: true } }
  );

/** The workflow file, importing what it catches from the SDK. */
export const withResolvedDone = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, source]) => [
      path,
      path.endsWith("mailer.ts")
        ? source.replace(" workflow, z }", " resolvedDone, workflow, z }")
        : source,
    ])
  );

/** The resolution events of the log, for the connection `connectionId`. */
export const resolutions = async (connectionId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action.startsWith("connection.call.resolve") &&
        target?.id === connectionId
    )
    .map(({ action, actor, detail }) => ({
      action,
      actor: actor.type,
      choice: detail.choice,
      reason: detail.reason,
      // Only where the resolution read the call it names.
      ...(detail.effectKeyHash === undefined
        ? {}
        : { effectKeyHash: detail.effectKeyHash }),
    }));
};

/** How many calls the log records on the connection `connectionId`. */
export const callsOn = async (connectionId: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "connection.call" && target?.id === connectionId
  ).length;
};

/** How each call the log records on `connectionId` ended, and its receipt. */
export const callReceipts = async (connectionId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "connection.call" && target?.id === connectionId
    )
    .map(({ detail }) => ({
      outcome: detail.outcome,
      effectKeyHash: detail.effectKeyHash,
    }));
};

/** How many calls of unknown outcome are listed for `person`. */
export const listedFor = async (person: Api) => {
  const listed = await person.api.unknownOutcomes.list();
  return listed.length;
};

/** How the run `run` stands, as its person sees it. */
export const statusOf = async (person: Api, run: string) => {
  const { status } = await person.api.workflows.status(run);
  return status;
};

/** Waits `ms` of real time. */
export const elapse = async (ms: number): Promise<void> => {
  await scheduler.wait(ms);
};

/**
 * Run `runId`'s status once it is asleep between its checks: `waiting`.
 * A check that comes due runs it for a moment, and it waits on.
 */
export const asleep = async (runId: string): Promise<string> =>
  await vi.waitFor(
    async () => {
      const status = await liveStatus(runId);
      expect(status).toBe("waiting");
      return status;
    },
    { timeout: 10_000, interval: 100 }
  );

/** What the tests do as people of `idp`'s organization. */
export const unknownOutcomesOf = (idp: Idp) => {
  /** A signed-in person's API, on a connection of their own. */
  const personApi = async (role: Role) => await personApiOf(idp, role);

  /**
   * The open obligations a JSON export holds for Grasp staff, signed in from
   * Grasp's tenant, who read the log as admins.
   */
  const staffExport = async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session);
    return await exportedObligations(core.authenticate());
  };

  /**
   * An App with `mailer`, allowed `action` on a shared Microsoft 365
   * connection, whose first write from its mailbox Graph carries out and
   * then loses the answer of: the run, started, and the permission's ID.
   */
  const lostRun = async (admin: Api, action = "mail.send") => {
    const mailbox = mailboxOf();
    const connectionId = await connectShared(admin);
    const app = await appWith(admin, withResolvedDone(mailer(mailbox, action)));
    const permission = await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId },
      actions: [action],
      binding: "MAIL",
    });
    await loseAnswers(mailbox);
    const run = await admin.api.workflows.start(app, "mailer");
    return { mailbox, connectionId, app, permission, run };
  };

  /** `lostRun`, once its run waits, with the one call of unknown outcome. */
  const waitingRun = async (admin: Api, action = "mail.send") => {
    const lost = await lostRun(admin, action);
    await runEvents(lost.run.id, "workflow.run.waiting");
    const [unknown, ...others] = await admin.api.unknownOutcomes.list();
    if (unknown === undefined || others.length > 0) {
      throw new Error("Expected one call of unknown outcome");
    }
    return { ...lost, unknown };
  };

  return { personApi, staffExport, lostRun, waitingRun };
};
