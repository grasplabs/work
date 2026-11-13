import {
  canSignInAgain,
  unknownOutcomeListLimit,
} from "@grasp-os/shared/connect";
import type {
  UnknownOutcome,
  UnknownOutcomeCursor,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Permission } from "@grasp-os/shared/permissions";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  waitingErrors,
  waitingParts,
  waitingVerdictSchema,
} from "@grasp-os/shared/waiting";
import type {
  WaitingApi,
  WaitingFeed,
  WaitingItem,
  WaitingPart,
  WaitingSettled,
  WaitingVerdict,
} from "@grasp-os/shared/waiting";
import type { z } from "zod";

import type { AppsRpc } from "./apps-rpc.ts";
import type { ConnectionsRpc } from "./connections.ts";
import type { DecisionsRpc } from "./decisions/rpc.ts";
import type { HeldStartsRpc } from "./held-starts-rpc.ts";
import type { NotificationsRpc } from "./notifications.ts";
import type { PendingActionsRpc } from "./pending-actions.ts";
import type { PermissionsRpc } from "./permissions-rpc.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import type { SkillsRpc } from "./skills-rpc.ts";
import type { UnknownOutcomesRpc } from "./unknown-outcomes.ts";
import type { WorkflowResourcesRpc } from "./workflow-resources-rpc.ts";

// What waits on a person, in one feed (@grasp-os/shared/waiting). It
// keeps nothing of its own: each part is read through the namespace the
// person reaches it by anyway, with that namespace's checks, so the feed
// can't show anyone more than those do; a verdict is that namespace's own
// call, which checks again and audits as it always does. What the feed
// decides itself is only whom a kind waits on, where its namespace
// lists more than that: permission requests (listed for builders too)
// and apps to approve wait on the organization's own admins, never Grasp
// staff; a connection on whoever may sign in to it again; a version up
// for review on the member who answers for its App; a workflow's version
// asked to go live on its owner, else the organization's admins; a share
// of a skill on the organization's admins. Not
// audited: reading
// it shows a person what they may already see, as the parts do.

/** The namespaces the feed is read from and acts through: the session's own. */
export interface WaitingSources {
  pendingActions: PendingActionsRpc;
  unknownOutcomes: UnknownOutcomesRpc;
  permissions: PermissionsRpc;
  apps: AppsRpc;
  notifications: NotificationsRpc;
  connections: ConnectionsRpc;
  decisions: DecisionsRpc;
  heldStarts: HeldStartsRpc;
  /** Independent workflows' bindings that wait on an admin (`workflowResources.pendingBindings`). */
  bindings: Pick<WorkflowResourcesRpc, "pendingBindings">;
  /** Shares of skills that wait for an admin (`skills.waiting`). */
  skills: Pick<SkillsRpc, "waiting">;
}

/** Who reads the feed: whom each item is for follows from it. */
interface Reader {
  person: Identity;
  /** The item waits on the reader themself. */
  forMe: { type: "person"; userId: string };
  /** One of the organization's own admins, never Grasp staff. */
  admin: boolean;
}

/** What one part came to: its items, and for notifications, what the page says besides. */
interface PartRead {
  items: WaitingItem[];
  notifications?: Pick<
    WaitingFeed,
    "moreNotifications" | "unreadNotifications"
  >;
}

/** Each part's read, through its namespace, into the feed's items. */
type Parts = Record<
  WaitingPart,
  (sources: WaitingSources, reader: Reader) => Promise<PartRead>
>;

/** Every page of the person's calls of unknown outcome, as `list` pages them. */
const everyOutcome = async (
  outcomes: UnknownOutcomesRpc
): Promise<UnknownOutcome[]> => {
  const all: UnknownOutcome[] = [];
  let before: UnknownOutcomeCursor | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the last
    const page = await outcomes.list(before);
    all.push(...page);
    const last = page.at(-1);
    if (page.length < unknownOutcomeListLimit || last === undefined) {
      return all;
    }
    before = last.cursor;
  }
};

/**
 * The version of the App a grant of `request` approves, as it is current
 * now (`current`): the asking App's, or, for a workflow's request on one
 * of an App's functions, that App's. Null for any other request.
 */
const reviewedVersionOf = (
  { subject, object }: Permission,
  current: ReadonlyMap<string, number | null>
): number | null => {
  if (subject.type === "app") {
    return current.get(subject.appId) ?? null;
  }
  return object.type === "app" && object.function !== undefined
    ? (current.get(object.appId) ?? null)
    : null;
};

/**
 * The permission requests waiting for an admin, each with the version of
 * its App current now: what a grant approves.
 */
const requestItems = async (
  { permissions, apps }: WaitingSources,
  { admin }: Reader
): Promise<PartRead> => {
  if (!admin) {
    return { items: [] };
  }
  const [requests, listed] = await Promise.all([
    permissions.list(undefined, "requested"),
    apps.list(),
  ]);
  const current = new Map(listed.map((app) => [app.id, app.currentVersion]));
  return {
    items: requests.map((request) => ({
      kind: "permissionRequest",
      id: `permissionRequest:${request.id}`,
      at: request.requestedAt,
      urgent: false,
      waitsOn: { type: "admin" },
      verdicts: ["grant", "reject"],
      request,
      reviewedVersion: reviewedVersionOf(request, current),
    })),
  };
};

/** The latest page of the person's notifications: questions they were asked, schedules of theirs that stopped, workflows changed under their triggers, sources connect stopped hearing for their triggers, what core found of their approved packages, and what Apps told them. */
const notificationItems = async (
  { notifications, connections }: WaitingSources,
  { forMe }: Reader
): Promise<PartRead> => {
  const page = await notifications.list();
  // Named by their accounts as the person may see them: read only when a
  // source connect stopped hearing is among them.
  const named = page.notifications.some(({ type }) => type === "events_stopped")
    ? await connections.list()
    : [];
  const connectionsById = new Map(named.map((listed) => [listed.id, listed]));
  return {
    items: page.notifications.map((notification): WaitingItem => {
      const base = { at: notification.at, urgent: false, waitsOn: forMe };
      switch (notification.type) {
        case "gap_asked": {
          return {
            ...base,
            kind: "openQuestion",
            id: `openQuestion:${notification.id}`,
            verdicts: [],
            notification,
          };
        }
        case "trigger_stopped": {
          return {
            ...base,
            kind: "stoppedSchedule",
            id: `stoppedSchedule:${notification.id}`,
            verdicts: [],
            notification,
          };
        }
        case "trigger_workflow_changed": {
          return {
            ...base,
            kind: "workflowChanged",
            id: `workflowChanged:${notification.id}`,
            verdicts: [],
            notification,
          };
        }
        case "events_stopped": {
          const connection = connectionsById.get(notification.connection);
          return {
            ...base,
            kind: "stoppedEvents",
            id: `stoppedEvents:${notification.id}`,
            verdicts: [],
            notification,
            // An HTTP connection listens for no events: never one of these.
            account:
              connection === undefined || connection.source === "http"
                ? null
                : {
                    name: connection.accountName,
                    source: connection.source,
                    provider: connection.provider,
                  },
          };
        }
        case "package_revoked":
        case "package_advisory": {
          return {
            ...base,
            kind: "packageNotice",
            id: `packageNotice:${notification.id}`,
            verdicts: [],
            notification,
          };
        }
        case "app_message": {
          return {
            ...base,
            kind: "appMessage",
            id: `appMessage:${notification.id}`,
            verdicts: [],
            notification,
          };
        }
        default: {
          return notification satisfies never;
        }
      }
    }),
    notifications: {
      moreNotifications: page.more,
      unreadNotifications: page.unread,
    },
  };
};

/** The person's connections whose access ran out, among those they may sign in to again. */
const connectionItems = async (
  { connections }: WaitingSources,
  { person, forMe }: Reader
): Promise<PartRead> => {
  const [listed, catalog] = await Promise.all([
    connections.list(),
    connections.catalog(),
  ]);
  const entries = new Map(
    catalog.entries.map((entry) => [`${entry.source}:${entry.id}`, entry])
  );
  return {
    items: listed.flatMap((connection): WaitingItem[] => {
      const entry = entries.get(`${connection.source}:${connection.provider}`);
      const { source } = connection;
      // An HTTP connection is never signed in again: its admin approves
      // another (`canSignInAgain` says so too).
      if (source === "http") {
        return [];
      }
      const waits =
        connection.status === "needs_reauth" &&
        canSignInAgain(connection, entry?.offered ?? false, person);
      return waits
        ? [
            {
              kind: "signInAgain",
              id: `signInAgain:${connection.id}`,
              // Core says what waits now, not since when.
              at: null,
              // Workflows that use it wait until someone signs in again.
              urgent: true,
              waitsOn: forMe,
              verdicts: [],
              connection,
              integration: {
                source,
                id: connection.provider,
                // The catalog alone has its name: its ID stands in.
                name: entry?.name ?? connection.provider,
              },
            },
          ]
        : [];
    }),
  };
};

const parts: Parts = {
  held: async ({ pendingActions }, { forMe }) => {
    const held = await pendingActions.list();
    return {
      items: held.map((action) => ({
        kind: "heldWrite",
        id: `heldWrite:${action.id}`,
        at: action.requestedAt,
        // What asked for it waits on the answer.
        urgent: true,
        waitsOn: forMe,
        verdicts: ["approve", "decline"],
        action,
      })),
    };
  },
  outcomes: async ({ unknownOutcomes }, { forMe }) => {
    const outcomes = await everyOutcome(unknownOutcomes);
    return {
      items: outcomes.map((outcome) => ({
        kind: "unknownOutcome",
        // Its key and its claim: the same call sent again and lost again
        // is another item.
        id: `unknownOutcome:${JSON.stringify([outcome.key, outcome.claim])}`,
        at: outcome.sentAt,
        // A run may wait on the answer that was lost.
        urgent: true,
        waitsOn: forMe,
        verdicts: ["happened", "notHappened"],
        outcome,
      })),
    };
  },
  requests: requestItems,
  notifications: notificationItems,
  connections: connectionItems,
  // Live workflow versions whose bindings no admin approved: their starts
  // are refused, so they are urgent.
  bindings: async ({ bindings }, { admin }) => {
    if (!admin) {
      return { items: [] };
    }
    const pending = await bindings.pendingBindings();
    return {
      items: pending.map((each) => ({
        kind: "bindingApproval",
        id: `bindingApproval:${each.workflow.id}:${each.version}`,
        at: null,
        urgent: true,
        waitsOn: { type: "admin" },
        verdicts: [],
        pending: each,
      })),
    };
  },
  decisions: async ({ decisions }, { forMe }) => {
    const waiting = await decisions.waiting();
    return {
      items: waiting.map((decision) => ({
        kind: "decision",
        id: `decision:${decision.id}`,
        at: null,
        // Its run waits on the answer.
        urgent: true,
        waitsOn: forMe,
        verdicts: [],
        decision,
      })),
    };
  },
  heldStarts: async ({ heldStarts }, { forMe }) => {
    const held = await heldStarts.list();
    return {
      items: held.map((start) => ({
        kind: "heldStart",
        id: `heldStart:${start.id}`,
        at: start.requestedAt,
        // The chat's agent waits on the answer.
        urgent: true,
        waitsOn: forMe,
        verdicts: ["confirm", "decline"],
        start,
      })),
    };
  },
  // Shares of skills that wait on the organization's own admins, decided
  // on the skills page, where their text is read.
  skillShares: async ({ skills }, { admin }) => {
    if (!admin) {
      return { items: [] };
    }
    const waiting = await skills.waiting();
    return {
      items: waiting.map((share) => ({
        kind: "skillShare",
        id: `skillShare:${share.id}`,
        at: share.requestedAt,
        urgent: false,
        waitsOn: { type: "admin" },
        verdicts: [],
        share,
      })),
    };
  },
};

/**
 * Reads one part. A part that fails leaves the rest: the feed names it,
 * with its code when the failure is one a caller may see.
 */
const readPart = async (
  part: WaitingPart,
  read: () => Promise<PartRead>
): Promise<PartRead | { part: WaitingPart; code: string }> => {
  try {
    return await read();
  } catch (error) {
    if (isExpectedError(error)) {
      return { part, code: error.code };
    }
    log.error("waiting.part_failed", { part, ...errorFields(error) });
    return { part, code: "internal.unexpected" };
  }
};

/** Urgent first, then the newest (one without a date as of `readAt`), then by ID. */
const ordered = (items: WaitingItem[], readAt: string): WaitingItem[] =>
  items.toSorted(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      (b.at ?? readAt).localeCompare(a.at ?? readAt) ||
      a.id.localeCompare(b.id)
  );

/** Everything that waits on `person`, each part read on its own. */
const feedOf = async (
  sources: WaitingSources,
  person: Identity
): Promise<WaitingFeed> => {
  const reader: Reader = {
    person,
    forMe: { type: "person", userId: person.userId },
    admin: isMemberAdmin(person),
  };
  const read = await Promise.all(
    waitingParts.map(
      async (part) =>
        await readPart(part, async () => await parts[part](sources, reader))
    )
  );
  const readAt = new Date().toISOString();
  const items: WaitingItem[] = [];
  const unread: WaitingFeed["unread"] = [];
  let notifications: PartRead["notifications"];
  for (const result of read) {
    if ("code" in result) {
      unread.push(result);
    } else {
      items.push(...result.items);
      notifications ??= result.notifications;
    }
  }
  return {
    readAt,
    items: ordered(items, readAt),
    unread,
    moreNotifications: notifications?.moreNotifications ?? false,
    unreadNotifications: notifications?.unreadNotifications ?? 0,
  };
};

/** What the person may do about what waits on them. */
export class WaitingRpc extends CoreRpcTarget implements WaitingApi {
  readonly #check: SessionCheck;
  readonly #sources: WaitingSources;

  constructor(check: SessionCheck, sources: WaitingSources) {
    super();
    this.#check = check;
    this.#sources = sources;
  }

  async list(): Promise<WaitingFeed> {
    return await withPerson(
      this.#check,
      async (person) => await feedOf(this.#sources, person)
    );
  }

  async settle(verdict: WaitingVerdict): Promise<WaitingSettled> {
    return await withPerson(this.#check, async () => {
      const parsed = waitingVerdictSchema.safeParse(verdict);
      if (!parsed.success) {
        throw waitingErrors.create("waiting.invalid_verdict");
      }
      return await this.#settle(parsed.data);
    });
  }

  async #settle(
    verdict: z.output<typeof waitingVerdictSchema>
  ): Promise<WaitingSettled> {
    const sources = this.#sources;
    switch (verdict.kind) {
      case "heldWrite": {
        await (verdict.verdict === "approve"
          ? sources.pendingActions.confirm(verdict.id, verdict.inputHash)
          : sources.pendingActions.decline(verdict.id));
        return { kind: verdict.kind };
      }
      case "heldStart": {
        await (verdict.verdict === "confirm"
          ? sources.heldStarts.confirm(verdict.id, verdict.argsHash)
          : sources.heldStarts.decline(verdict.id));
        return { kind: verdict.kind };
      }
      case "unknownOutcome": {
        await sources.unknownOutcomes.resolve(
          verdict.key,
          verdict.verdict === "happened" ? "happened" : "not_happened",
          verdict.claim
        );
        return { kind: verdict.kind };
      }
      case "permissionRequest": {
        await (verdict.verdict === "grant"
          ? sources.permissions.grant(verdict.id, verdict.reviewed)
          : sources.permissions.revoke(verdict.id));
        return { kind: verdict.kind };
      }
      default: {
        return verdict satisfies never;
      }
    }
  }
}
