import type { PendingAction, UnknownOutcome } from "@grasp-os/shared/connect";
import type { DecisionView } from "@grasp-os/shared/decisions";
import type { HeldStart } from "@grasp-os/shared/held-starts";
import type {
  AppMessageNotification,
  GapAskedNotification,
  TriggerStoppedNotification,
} from "@grasp-os/shared/notifications";
import type { Permission } from "@grasp-os/shared/permissions";
import type {
  BindingApprovalItem,
  SkillShareItem,
  WorkflowGoLiveItem,
} from "@grasp-os/shared/waiting";
import { plural, t } from "@lingui/core/macro";

import { objectOf, subjectOf } from "../activity/pending.tsx";
import type { PendingRequests } from "../activity/pending.tsx";
import { integrationKey } from "../connections/integrations.ts";
import type { NotificationsPage } from "../dashboard/notifications-page.ts";
import { decidesRequests } from "../dashboard/waiting.ts";
import type { Viewer, Waiting } from "../dashboard/waiting.ts";
import { formatDateTime, formatList } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";

// The inbox, as the prototype derives it (`lib/inbox.ts`): what waits on a
// person to decide, each item made from what core says waits now, so an
// item goes by itself once what it is about is settled. The prototype's
// kinds are kept, so the filter and the marks are the same; what core
// lists today fills those it has (a connection to sign in to again) and
// kinds of its own: a change an agent wants to make, a change sent for
// the person whose answer was lost, a permission an App
// or agent asked for, a version of a
// workflow asked to go live. Core keeps nothing the inbox adds (put away until a date, given
// to someone, dismissed with why), so none of that is here. Pure.

export type InboxKind =
  | "checkDrawing"
  | "checkProposal"
  | "goLive"
  | "approveChange"
  | "confirmResult"
  | "conflict"
  | "openQuestion"
  | "unknownAiTool"
  | "signInAgain"
  | "externalDomain"
  | "heldWrite"
  | "heldStart"
  | "unknownOutcome"
  | "permissionRequest"
  | "stoppedSchedule"
  | "packageNotice"
  | "stoppedEvents"
  | "appMessage"
  | "bindingApproval"
  | "skillShare"
  | "decision";

/** Where an item can be opened: the page of what it is about. */
export type Target =
  | { kind: "independentWorkflow"; workflow: string; section?: "triggers" }
  /**
   * An App: its own page, or the section of its settings where what the
   * item is about is decided.
   */
  | {
      kind: "app";
      app: string;
      place?: "connections";
    }
  | { kind: "integration"; integration: string }
  | { kind: "chat"; chat: string }
  | { kind: "brain" }
  | { kind: "skills" }
  | { kind: "decision"; decision: string };

/** What an item was made from: what its page shows of it and acts on. */
export type InboxSource =
  | { type: "held"; action: PendingAction }
  | { type: "heldStart"; start: HeldStart }
  | { type: "outcome"; outcome: UnknownOutcome }
  | { type: "request"; request: Permission; pending: PendingRequests }
  | { type: "workflowGoLive"; item: WorkflowGoLiveItem }
  | { type: "bindings"; item: BindingApprovalItem }
  | { type: "skillShare"; item: SkillShareItem }
  | { type: "reconnect"; integration: string }
  | { type: "asked"; notification: GapAskedNotification }
  | { type: "stopped"; notification: TriggerStoppedNotification }
  | { type: "packageNotice"; notification: PackageNotification }
  | { type: "stoppedEvents"; notification: EventsStoppedNotification }
  | { type: "appMessage"; notification: AppMessageNotification }
  | { type: "decision"; decision: DecisionView };

export interface InboxItem {
  /** Stable from one read to the next: its kind and what it is about, e.g. "held:<id>". */
  id: string;
  kind: InboxKind;
  title: string;
  /** What it is about, in a few words. The list shows this, with the kind. */
  context: string;
  /** The application or connection it is about, when it is about one: its tile stands for it. */
  logo?: { name: string };
  /** What happened and why it waits, in a few plain sentences. */
  body: string[];
  /** Short facts in the item: a label and its value. */
  facts: { label: string; value: string }[];
  /** Where it can be opened. */
  about?: Target;
  /** Who it is for, as a role or a person; none means an admin. */
  forWhom?: { role: string } | { person: string };
  /** ISO 8601, when it came in. */
  date: string;
  /** Something waits or stops until this is decided. */
  urgent: boolean;
  source: InboxSource;
}

/** The kinds, grouped as the filter offers them. */
export type Group = "all" | "workflows" | "brain" | "apps";

export const groupOf: Record<InboxKind, Exclude<Group, "all">> = {
  checkDrawing: "workflows",
  checkProposal: "workflows",
  goLive: "workflows",
  approveChange: "workflows",
  confirmResult: "workflows",
  conflict: "brain",
  openQuestion: "brain",
  unknownAiTool: "apps",
  signInAgain: "apps",
  externalDomain: "apps",
  heldWrite: "apps",
  heldStart: "workflows",
  unknownOutcome: "apps",
  permissionRequest: "apps",
  stoppedSchedule: "workflows",
  packageNotice: "apps",
  stoppedEvents: "workflows",
  appMessage: "apps",
  bindingApproval: "workflows",
  skillShare: "brain",
  decision: "workflows",
};

export type Sort = "urgent" | "newest" | "oldest";

/** Urgent first, then the newest, then by title: the inbox's own order. */
const order = (a: InboxItem, b: InboxItem): number =>
  Number(b.urgent) - Number(a.urgent) ||
  b.date.localeCompare(a.date) ||
  a.title.localeCompare(b.title);

/** The list as the person filtered and ordered it; "urgent" keeps the inbox's own order. */
export const listed = (
  items: readonly InboxItem[],
  group: Group,
  sort: Sort
): InboxItem[] =>
  items
    .filter((item) => group === "all" || groupOf[item.kind] === group)
    .toSorted((a, b) => {
      if (sort === "newest") {
        return b.date.localeCompare(a.date);
      }
      if (sort === "oldest") {
        return a.date.localeCompare(b.date);
      }
      return 0;
    });

/** A held write's name: what it does, on which connection. */
export const heldName = (action: PendingAction): string => {
  const title = action.description?.title ?? action.action;
  const connection = action.connectionName ?? action.connectionId;
  return t`${title} on ${connection}`;
};

/**
 * Where a held write came from: its chat, or its App (its own or a run
 * of its workflow's). An independent workflow's run has no page to go to.
 */
const heldAbout = ({ context }: PendingAction): Target | undefined => {
  if (context.type === "chat") {
    return { kind: "chat", chat: context.chatId };
  }
  if (context.type === "workflowRun") {
    return undefined;
  }
  return { kind: "app", app: context.appId };
};

/** A change an agent or App wants to make, held until the person approves it. */
const heldItems = (
  actions: readonly PendingAction[],
  me: string
): InboxItem[] =>
  actions.map((action) => {
    const name = heldName(action);
    const connection = action.connectionName ?? action.connectionId;
    return {
      id: `held:${action.id}`,
      kind: "heldWrite",
      title: t`Approve ${name}?`,
      context: name,
      body: [
        t`Nothing is sent or changed on ${connection} until you approve it, with exactly what is shown.`,
      ],
      facts: [{ label: t`Connection`, value: connection }],
      about: heldAbout(action),
      forWhom: { person: me },
      date: action.requestedAt,
      // What asked for it waits on the answer.
      urgent: true,
      source: { type: "held", action },
    };
  });

/**
 * A start of a workflow a chat's agent asked for, held until the person
 * confirms it: nothing runs before, and it runs with exactly what is shown.
 */
const heldStartItems = (
  starts: readonly HeldStart[],
  me: string
): InboxItem[] =>
  starts.map((start) => {
    const name = start.workflowName;
    return {
      id: `heldStart:${start.id}`,
      kind: "heldStart",
      title: t`Start ${name}?`,
      context: name,
      body: [
        t`Your chat's agent asked to start this workflow for you. Nothing runs until you confirm it, with exactly the input shown.`,
      ],
      facts: [
        { label: t`Workflow`, value: name },
        { label: t`Waits until`, value: formatDateTime(start.expiresAt) },
      ],
      forWhom: { person: me },
      date: start.requestedAt,
      // The chat's agent waits on the answer.
      urgent: true,
      source: { type: "heldStart", start },
    };
  });

/** What a call of unknown outcome did, and where: its tool's title, or its action. */
export const outcomeName = (outcome: UnknownOutcome): string => {
  const title = outcome.description?.title ?? outcome.key.action;
  const connection = outcome.connectionName ?? outcome.key.connectionId;
  return t`${title} on ${connection}`;
};

/**
 * A change Grasp sent for the person whose answer was lost: only they say
 * whether it happened (the dashboard's `outcome-card.tsx`).
 */
const outcomeItems = (
  outcomes: readonly UnknownOutcome[],
  me: string
): InboxItem[] =>
  outcomes.map((outcome) => {
    const who = outcomeName(outcome);
    const connection = outcome.connectionName ?? outcome.key.connectionId;
    return {
      // Its key and its claim: the same call sent again and lost again
      // is another item.
      id: `outcome:${JSON.stringify([outcome.key, outcome.claim])}`,
      kind: "unknownOutcome",
      title: t`Did this happen? ${who}`,
      context: who,
      body: [],
      facts: [
        { label: t`Connection`, value: connection },
        { label: t`Sent`, value: formatDateTime(outcome.sentAt) },
      ],
      forWhom: { person: me },
      date: outcome.sentAt,
      // A run may wait on the answer that was lost.
      urgent: true,
      source: { type: "outcome", outcome },
    };
  });

/** A permission an App or agent asked for, which an admin grants or rejects. */
const requestItems = (pending: PendingRequests): InboxItem[] =>
  pending.requests.map((request) => {
    const { directory } = pending;
    const subject = subjectOf(request, directory);
    const object = objectOf(request, directory);
    const actions = formatList(request.actions);
    const who = t`${subject}: ${actions} on ${object}`;
    const { binding } = request;
    return {
      id: `request:${request.id}`,
      kind: "permissionRequest",
      title: t`Grant ${who}?`,
      context: who,
      body: [t`${subject} gets this permission once it is granted.`],
      facts: [
        { label: t`Binding`, value: binding },
        { label: t`Asked`, value: formatDateTime(request.requestedAt) },
      ],
      about:
        request.subject.type === "app"
          ? {
              kind: "app",
              app: request.subject.appId,
              place: "connections",
            }
          : undefined,
      date: request.requestedAt,
      urgent: false,
      source: { type: "request", request, pending },
    };
  });

/**
 * A version of a workflow a builder asked to go live, which the person
 * approves or sends back here: as its owner, or as an admin.
 */
const workflowGoLiveItems = (
  goLives: readonly WorkflowGoLiveItem[],
  me: string
): InboxItem[] =>
  goLives.map((item) => {
    const { workflow, version } = item;
    const { name } = workflow;
    return {
      id: item.id,
      kind: "goLive",
      title: t`Let version ${version} of ${name} go live?`,
      context: name,
      body: [
        t`A builder asked for this version of ${name} to go live: approved, it is the version the company runs. Send it back to keep the version that runs now.`,
        // Their own request, as nobody else may decide it (GRA-1227).
        ...(item.selfApproval
          ? [
              t`You asked for this yourself, and nobody else may approve it, so you decide it. It is recorded as self-approved.`,
            ]
          : []),
      ],
      facts: [
        { label: t`Version`, value: String(version) },
        ...(item.selfApproval
          ? [{ label: t`Approval`, value: t`Self-approved` }]
          : []),
      ],
      about: { kind: "independentWorkflow", workflow: workflow.id },
      // As the workflow's owner, or else as an admin.
      ...(item.waitsOn.type === "person" ? { forWhom: { person: me } } : {}),
      date: item.at ?? "",
      urgent: false,
      source: { type: "workflowGoLive", item },
    };
  });

/**
 * A version of a workflow whose bindings no admin approved, so its starts
 * are refused: approved here, binding by binding, by an admin.
 */
const bindingItems = (
  pending: readonly BindingApprovalItem[],
  readAt: string
): InboxItem[] =>
  pending.map((item) => {
    const { workflow, version, live, bindings } = item.pending;
    const { name } = workflow;
    const count = bindings.length;
    return {
      id: item.id,
      kind: "bindingApproval",
      title: t`Approve what ${name} reaches`,
      context: name,
      body: [
        live
          ? t`Version ${version} of ${name} is live, but nothing starts it until an admin approves what it reaches: each model, connection, store or collection it calls.`
          : t`Version ${version} of ${name} is asked to go live. Once it is, nothing starts it until an admin approves what it reaches: each model, connection, store or collection it calls.`,
      ],
      facts: [
        { label: t`Version`, value: String(version) },
        {
          label: t`Waiting`,
          value: plural(count, {
            one: "# binding",
            other: "# bindings",
          }),
        },
      ],
      about: { kind: "independentWorkflow", workflow: workflow.id },
      date: readAt,
      urgent: item.urgent,
      source: { type: "bindings", item },
    };
  });

/**
 * A person's ask to share one of their skills with the company: read and
 * decided by an admin on the skills page, where its text is.
 */
const skillShareItems = (shares: readonly SkillShareItem[]): InboxItem[] =>
  shares.map((item) => {
    const { name, requestedBy, requestedAt } = item.share;
    const asker = requestedBy.name ?? requestedBy.userId;
    return {
      id: item.id,
      kind: "skillShare",
      title: t`Share ${name} with the company?`,
      context: name,
      body: [
        t`${asker} asked to share their skill ${name} with the company. Approved, every member's agents use it. Read it on the skills page before you decide.`,
      ],
      facts: [{ label: t`Asked`, value: formatDateTime(requestedAt) }],
      about: { kind: "skills" },
      date: requestedAt,
      urgent: false,
      source: { type: "skillShare", item },
    };
  });

/** A question of the brain an admin asked the person, as the role that can answer it, while it is open. */
const askedItems = (
  notifications: NotificationsPage,
  me: string
): InboxItem[] =>
  notifications.page.notifications.flatMap((notification): InboxItem[] => {
    if (notification.type !== "gap_asked") {
      return [];
    }
    const { question, owner, at } = notification;
    return [
      {
        id: `asked:${notification.id}`,
        kind: "openQuestion",
        title: question,
        context: owner,
        body: [
          t`You were asked this as the ${owner}. Answer it in the brain: everyone in the company reads the answer, with your name.`,
        ],
        facts: [{ label: t`Asked`, value: formatDateTime(at) }],
        about: { kind: "brain" },
        forWhom: { person: me },
        date: at,
        urgent: false,
        source: { type: "asked", notification },
      },
    ];
  });

/** What core's rescan found of an App's approved packages. */
type PackageNotification = Extract<
  NotificationsPage["page"]["notifications"][number],
  { type: "package_revoked" | "package_advisory" }
>;

/**
 * What core's rescan found of the approved packages of an App the person
 * builds: revoked as malware, or a new advisory.
 */
const packageNoticeItems = (
  notifications: NotificationsPage,
  me: string
): InboxItem[] =>
  notifications.page.notifications.flatMap((notification): InboxItem[] => {
    if (
      notification.type !== "package_revoked" &&
      notification.type !== "package_advisory"
    ) {
      return [];
    }
    const { at, advisory, app, appName: name } = notification;
    const about: Target = { kind: "app", app };
    const found = `${notification.package.name}@${notification.package.version}`;
    const revoked = notification.type === "package_revoked";
    return [
      {
        id: `packageNotice:${notification.id}`,
        kind: "packageNotice",
        title: revoked
          ? t`Packages of ${name} were revoked as malware`
          : t`A new advisory affects the packages of ${name}`,
        context: name,
        body: [
          revoked
            ? t`${found} was reported as malware, so Grasp revoked the packages approved with it: nothing of ${name} that uses them is built or started. Remove the package, then ask for a new set to be approved.`
            : t`${found}, approved for ${name}, has an advisory it didn't have when it was approved. The approval stands: decide whether to update or remove the package.`,
        ],
        facts: [
          { label: t`Package`, value: found },
          { label: t`Advisory`, value: advisory },
          { label: t`Found`, value: formatDateTime(at) },
        ],
        about,
        forWhom: { person: me },
        date: at,
        urgent: revoked,
        source: { type: "packageNotice", notification },
      },
    ];
  });

/** Connect stopped hearing a source: what the notification says of it. */
type EventsStoppedNotification = Extract<
  NotificationsPage["page"]["notifications"][number],
  { type: "events_stopped" }
>;

/** The title of a stopped source: what it stopped hearing, at whose account when the feed named it. */
const stoppedTitle = (mail: boolean, name: string | undefined): string => {
  if (name === undefined) {
    return mail
      ? t`Your triggers stopped hearing new mail`
      : t`Your triggers stopped hearing new files`;
  }
  return mail
    ? t`Your triggers stopped hearing new mail at ${name}`
    : t`Your triggers stopped hearing new files at ${name}`;
};

/** A mailbox or drive the person's triggers listen to, which connect stopped hearing. */
const stoppedEventsItems = (
  notifications: NotificationsPage,
  me: string
): InboxItem[] =>
  notifications.page.notifications.flatMap((notification): InboxItem[] => {
    if (notification.type !== "events_stopped") {
      return [];
    }
    const { at, reason, resource } = notification;
    const mail = notification.event.endsWith(".mail.received");
    const account = notifications.accounts?.get(notification.connection);
    const name = account?.name ?? undefined;
    return [
      {
        id: `stoppedEvents:${notification.id}`,
        kind: "stoppedEvents",
        title: stoppedTitle(mail, name),
        context: name ?? (mail ? t`Mail` : t`Files`),
        body: [
          reason === "refused"
            ? t`The provider refused access, so your triggers there start nothing new. Sign in to the connection again, or ask whoever manages it to give its access back. Grasp asks again once a day.`
            : t`Reading it kept failing, so your triggers there start nothing new for now. Grasp keeps trying; if it doesn't come back, check the connection.`,
        ],
        facts: [
          ...(resource === null
            ? []
            : [{ label: mail ? t`Mailbox` : t`Drive`, value: resource }]),
          { label: t`Stopped`, value: formatDateTime(at) },
        ],
        ...(account === undefined
          ? {}
          : {
              about: {
                kind: "integration",
                integration: integrationKey(account.source, account.provider),
              },
            }),
        forWhom: { person: me },
        date: at,
        urgent: true,
        source: { type: "stoppedEvents", notification },
      },
    ];
  });

/** A schedule trigger of the person's that stopped after its starts kept failing, until they enable it again. */
const stoppedItems = (
  notifications: NotificationsPage,
  me: string
): InboxItem[] =>
  notifications.page.notifications.flatMap((notification): InboxItem[] => {
    if (notification.type !== "trigger_stopped") {
      return [];
    }
    const { workflowName, at } = notification;
    return [
      {
        id: `stopped:${notification.id}`,
        kind: "stoppedSchedule",
        title: t`The schedule of ${workflowName} stopped`,
        context: workflowName,
        body: [
          t`Its runs kept failing to start, so it starts no more. Fix what stopped them, then turn it on again in the workflow's Triggers: it goes on from its next time.`,
        ],
        facts: [{ label: t`Stopped`, value: formatDateTime(at) }],
        // Its Triggers, in its Settings, where its owner turns it on again.
        about: {
          kind: "independentWorkflow",
          workflow: notification.workflow,
          section: "triggers",
        },
        forWhom: { person: me },
        date: at,
        urgent: false,
        source: { type: "stopped", notification },
      },
    ];
  });

/** What an App the person can open told them, opened on the App's page. */
const appMessageItems = (
  notifications: NotificationsPage,
  me: string
): InboxItem[] =>
  notifications.page.notifications.flatMap((notification): InboxItem[] => {
    if (notification.type !== "app_message") {
      return [];
    }
    const { app, appName, title, body, at } = notification;
    return [
      {
        id: `appMessage:${notification.id}`,
        kind: "appMessage",
        title,
        context: appName,
        body: body === null ? [] : [body],
        facts: [
          { label: t`App`, value: appName },
          { label: t`Sent`, value: formatDateTime(at) },
        ],
        about: { kind: "app", app },
        forWhom: { person: me },
        date: at,
        urgent: false,
        source: { type: "appMessage", notification },
      },
    ];
  });

/**
 * A decision a workflow's run waits for the person to answer: answered on
 * its own page, where they review what it is about and confirm.
 */
const decisionItems = (
  decisions: readonly DecisionView[],
  me: string,
  readAt: string
): InboxItem[] =>
  decisions.map((decision) => {
    const { name } = decision.workflowResource;
    return {
      id: `decision:${decision.id}`,
      kind: "decision",
      title: decision.description,
      context: name,
      body: [
        t`A run of ${name} waits for your answer. Nothing more happens in it until someone answers, or until it stops waiting.`,
      ],
      facts: [
        { label: t`Workflow`, value: name },
        { label: t`Answer by`, value: formatDateTime(decision.expiresAt) },
      ],
      about: { kind: "decision", decision: decision.id },
      forWhom: { person: me },
      // Core says what waits now, not since when: as of the read.
      date: readAt,
      // Its run waits on the answer.
      urgent: true,
      source: { type: "decision", decision },
    };
  });

/** What is ready of a part of what waits; nothing of one that couldn't be read. */
const readyOf = <T>(part: Loaded<T> | undefined): T | undefined =>
  part?.state === "ready" ? part.data : undefined;

/**
 * Every item that waits on the person, in the inbox's order: what blocks
 * something first, then the newest. `readAt` dates what core lists
 * without a date of its own.
 */
export const inboxItems = (
  waiting: Waiting,
  viewer: Viewer & { name: string },
  readAt: string
): InboxItem[] => {
  const me = viewer.name;
  const held = readyOf(waiting.held) ?? [];
  const outcomes = readyOf(waiting.outcomes) ?? [];
  const requests = decidesRequests(viewer)
    ? readyOf(waiting.requests)
    : undefined;
  const notifications = readyOf(waiting.notifications);
  const decisions = readyOf(waiting.decisions) ?? [];
  const heldStarts = readyOf(waiting.heldStarts) ?? [];
  const workflowGoLives = readyOf(waiting.workflowGoLives) ?? [];
  const bindings = decidesRequests(viewer)
    ? (readyOf(waiting.bindings) ?? [])
    : [];
  const skillShares = decidesRequests(viewer)
    ? (readyOf(waiting.skillShares) ?? [])
    : [];
  const reconnect = (readyOf(waiting.reconnect) ?? []).map(
    ({ integration, connection }): InboxItem => {
      const app =
        connection.accountName === null
          ? integration.name
          : `${integration.name} (${connection.accountName})`;
      return {
        id: `signIn:${connection.id}`,
        kind: "signInAgain",
        title: t`Sign in to ${app} again`,
        context: app,
        logo: { name: integration.name },
        body: [
          t`The connection stopped working. Workflows that use it wait until someone signs in again.`,
        ],
        facts: [],
        about: {
          kind: "integration",
          integration: integrationKey(integration.source, integration.id),
        },
        forWhom: { person: me },
        date: readAt,
        urgent: true,
        source: {
          type: "reconnect",
          integration: integrationKey(integration.source, integration.id),
        },
      };
    }
  );
  return [
    ...decisionItems(decisions, me, readAt),
    ...heldItems(held, me),
    ...heldStartItems(heldStarts, me),
    ...outcomeItems(outcomes, me),
    ...(requests === undefined ? [] : requestItems(requests)),
    ...workflowGoLiveItems(workflowGoLives, me),
    ...bindingItems(bindings, readAt),
    ...skillShareItems(skillShares),
    ...(notifications === undefined ? [] : askedItems(notifications, me)),
    ...(notifications === undefined ? [] : stoppedItems(notifications, me)),
    ...(notifications === undefined
      ? []
      : packageNoticeItems(notifications, me)),
    ...(notifications === undefined
      ? []
      : stoppedEventsItems(notifications, me)),
    ...(notifications === undefined ? [] : appMessageItems(notifications, me)),
    ...reconnect,
  ].toSorted(order);
};

/** The parts of what waits that couldn't be read: the inbox says so rather than look empty. */
export const unread = (waiting: Waiting): Loaded<unknown>[] => {
  const parts: (Loaded<unknown> | undefined)[] = [
    waiting.held,
    waiting.outcomes,
    waiting.requests,
    waiting.notifications,
    waiting.reconnect,
    waiting.decisions,
    waiting.workflowGoLives,
    waiting.heldStarts,
    waiting.bindings,
    waiting.skillShares,
  ];
  return parts.filter(
    (part): part is Loaded<unknown> =>
      part !== undefined && part.state !== "ready"
  );
};
