import type { PendingAction } from "@grasp-os/shared/connect";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import type { Notification } from "@grasp-os/shared/notifications";
import type { Permission } from "@grasp-os/shared/permissions";
import type { ScreensWaiting } from "@grasp-os/shared/screen-trust";
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";

import { objectOf, subjectOf } from "../activity/pending.tsx";
import type { PendingRequests } from "../activity/pending.tsx";
import { targetNames } from "../dashboard/dependency-requests.tsx";
import type { NotificationsPage } from "../dashboard/failed-workflows.tsx";
import { decidesRequests, toReconnect } from "../dashboard/to-do.tsx";
import type { Viewer, Waiting } from "../dashboard/to-do.tsx";
import { formatDateTime, formatList } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";

// The inbox, as the prototype derives it (`lib/inbox.ts`): what waits on a
// person to decide, each item made from what core says waits now, so an
// item goes by itself once what it is about is settled. The prototype's
// kinds are kept, so the filter and the marks are the same; what core
// lists today fills those it has (a connection to sign in to again) and
// kinds of its own: a change an agent wants to make, a permission an App
// or agent asked for, packages proposed for an engine, an engine's apps
// whose code nobody approved, a workflow that failed while acting for the
// person. Core keeps nothing the inbox adds (put away until a date, given
// to someone, dismissed with why), so none of that is here. Pure.

export type InboxKind =
  | "checkDrawing"
  | "checkProposal"
  | "goLive"
  | "approveChange"
  | "confirmResult"
  | "conflict"
  | "openQuestion"
  | "reviewPolicy"
  | "watchingRule"
  | "exceptionEnding"
  | "unknownAiTool"
  | "signInAgain"
  | "externalDomain"
  | "heldWrite"
  | "permissionRequest"
  | "packages"
  | "appApproval"
  | "failedRun";

/** Where an item can be opened: the page of what it is about. */
export type Target =
  | { kind: "workflow"; app: string; workflow: string }
  | { kind: "engine"; engine: string }
  | { kind: "integration"; integration: string }
  | { kind: "chat"; chat: string };

/** What an item was made from: what its page shows of it and acts on. */
export type InboxSource =
  | { type: "held"; action: PendingAction }
  | { type: "request"; request: Permission; pending: PendingRequests }
  | { type: "packages"; request: DependencyRequest; policyGeneration: number }
  | { type: "screens"; waiting: ScreensWaiting }
  | { type: "failed"; notification: Notification; model: string | undefined }
  | { type: "reconnect"; integration: string };

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
export type Group = "all" | "workflows" | "brain" | "policies" | "apps";

export const groupOf: Record<InboxKind, Exclude<Group, "all">> = {
  checkDrawing: "workflows",
  checkProposal: "workflows",
  goLive: "workflows",
  approveChange: "workflows",
  confirmResult: "workflows",
  conflict: "brain",
  openQuestion: "brain",
  reviewPolicy: "policies",
  watchingRule: "policies",
  exceptionEnding: "policies",
  unknownAiTool: "apps",
  signInAgain: "apps",
  externalDomain: "apps",
  heldWrite: "apps",
  permissionRequest: "apps",
  packages: "apps",
  appApproval: "apps",
  failedRun: "workflows",
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

/** Where a held write came from: its chat, or its engine. */
const heldAbout = ({ context }: PendingAction): Target =>
  context.type === "chat"
    ? { kind: "chat", chat: context.chatId }
    : { kind: "engine", engine: context.appId };

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

/** A permission an App or agent asked for, which an admin grants or rejects. */
const requestItems = (pending: PendingRequests): InboxItem[] =>
  pending.requests.map((request) => {
    const { directory, exports } = pending;
    const subject = subjectOf(request, directory);
    const object = objectOf(request, directory, exports);
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
          ? { kind: "engine", engine: request.subject.appId }
          : undefined,
      date: request.requestedAt,
      urgent: false,
      source: { type: "request", request, pending },
    };
  });

/** Packages proposed for an engine, which someone given the permission approves. */
const packageItems = (
  requests: readonly DependencyRequest[],
  policyGeneration: number
): InboxItem[] =>
  requests.map((request) => {
    const engine = request.app.name;
    const targets = formatList(
      request.targets.map((target) => i18n._(targetNames[target]))
    );
    const count = request.counts.packages;
    return {
      id: `packages:${request.id}`,
      kind: "packages",
      title: t`Approve the packages for ${engine}?`,
      context: t`Packages for ${engine}`,
      body: [request.purpose],
      facts: [
        { label: t`Asked by`, value: request.requestedBy.name },
        {
          label: t`Packages`,
          value: plural(count, {
            one: "# package",
            other: "# packages",
          }),
        },
        { label: t`Runs in`, value: targets },
      ],
      about: { kind: "engine", engine: request.app.id },
      forWhom: { role: t`package approvers` },
      date: request.requestedAt,
      urgent: false,
      source: { type: "packages", request, policyGeneration },
    };
  });

/** An engine whose current apps run code nobody approved: approved on the engine's page. */
const screenItems = (
  engines: readonly ScreensWaiting[],
  readAt: string
): InboxItem[] =>
  engines.map((waiting) => {
    const { name, screens, version } = waiting;
    const count = screens.length;
    return {
      id: `screens:${waiting.app}`,
      kind: "appApproval",
      title: plural(count, {
        one: `${name} has # app whose code nobody approved`,
        other: `${name} has # apps whose code nobody approved`,
      }),
      context: name,
      body: [
        t`An app runs only once an admin approved its code. That happens on the engine's page.`,
      ],
      facts: [
        { label: t`Version`, value: String(version) },
        { label: t`Apps`, value: formatList(screens) },
      ],
      about: { kind: "engine", engine: waiting.app },
      // Core says what waits now, not since when: as of the read.
      date: readAt,
      urgent: false,
      source: { type: "screens", waiting },
    };
  });

/** A workflow that failed while acting for the person, with a way to ask the agent to fix it. */
const failedItems = (failed: NotificationsPage, me: string): InboxItem[] =>
  failed.page.notifications.map((notification) => {
    const { app, appName, workflow, failures, at } = notification;
    return {
      id: `failed:${notification.id}`,
      kind: "failedRun",
      title: t`${workflow} in ${appName} failed`,
      context: workflow,
      body: [
        t`It failed while acting for you. Ask the agent to fix it: a new chat starts, with the run's failure report attached.`,
      ],
      facts: [
        { label: t`Engine`, value: appName },
        {
          label: t`Failed`,
          value: plural(failures, { one: "Once", other: "# times" }),
        },
        { label: t`Last`, value: formatDateTime(at) },
      ],
      about: { kind: "workflow", app, workflow },
      forWhom: { person: me },
      date: at,
      urgent: false,
      source: { type: "failed", notification, model: failed.model },
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
  const requests = decidesRequests(viewer)
    ? readyOf(waiting.requests)
    : undefined;
  const dependencies = readyOf(waiting.dependencies);
  const screens = readyOf(waiting.screens) ?? [];
  const failed = readyOf(waiting.failed);
  const integrations = readyOf(waiting.integrations);
  const reconnect = (
    integrations === undefined ? [] : toReconnect(integrations, viewer)
  ).map(({ integration, connection }): InboxItem => {
    // Named as its card on the integration's page is: the account too.
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
      about: { kind: "integration", integration: integration.key },
      forWhom: { person: me },
      date: readAt,
      urgent: true,
      source: { type: "reconnect", integration: integration.key },
    };
  });
  return [
    ...heldItems(held, me),
    ...(requests === undefined ? [] : requestItems(requests)),
    ...(dependencies === undefined
      ? []
      : packageItems(dependencies.requests, dependencies.policyGeneration)),
    ...screenItems(screens, readAt),
    ...(failed === undefined ? [] : failedItems(failed, me)),
    ...reconnect,
  ].toSorted(order);
};

/** The parts of what waits that couldn't be read: the inbox says so rather than look empty. */
export const unread = (waiting: Waiting): Loaded<unknown>[] => {
  const parts: (Loaded<unknown> | undefined)[] = [
    waiting.held,
    waiting.requests,
    waiting.dependencies,
    waiting.screens,
    waiting.failed,
    waiting.integrations,
  ];
  return parts.filter(
    (part): part is Loaded<unknown> =>
      part !== undefined && part.state !== "ready"
  );
};
