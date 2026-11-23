import { appErrors } from "@grasp-os/shared/apps";
import type {
  Permission,
  PermissionSubject,
} from "@grasp-os/shared/permissions";
import type { TriggerKind } from "@grasp-os/shared/workflow-triggers";
import { nextScheduledRun } from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";

import type { Session } from "../core.ts";
import {
  appName,
  appsById,
  readPeople,
  readTeams,
  teamName,
} from "../directory.ts";
import type { Directory } from "../directory.ts";
import { formatList, formatZone } from "../format.ts";
import {
  kindLabels,
  triggerDescription,
} from "../workflows/trigger-description.ts";

// Pending approvals: the permissions Apps and agents asked for, which an
// admin grants or rejects in the Inbox (`inbox/item-detail.tsx`). Core
// checks the role on every call; the Inbox reads them only for those core
// lets decide (the organization's own admins, never Grasp staff).

/** The requests an admin decides, oldest first, with the names to show. */
export interface PendingRequests {
  requests: Permission[];
  directory: Directory;
}

/**
 * The requests waiting for an admin (as the feed of what waits lists
 * them), with the names to show. The Apps are read in full, not only for
 * names: they say which version an admin reviews, so the tab fails
 * without them rather than offer the wrong decisions.
 */
export const readRequestNames = async (
  session: Session,
  requests: Permission[]
): Promise<PendingRequests> => {
  const [apps, people, teams] = await Promise.all([
    session.apps.list(),
    readPeople(session),
    readTeams(session),
  ]);
  return { requests, directory: { people, teams, apps: appsById(apps) } };
};

/** Workflow `id`, by the name core gave it in `names`, else by its ID. */
const workflowNamed = (
  id: string,
  names: Permission["workflowNames"]
): string => i18n._(msg`Workflow ${ph({ workflow: names?.[id] ?? id })}`);

/**
 * What holds a permission other than an App, for people: the agent, or an
 * independent workflow (by its name in `names`, where core gave it), or a
 * trigger, by its ID.
 */
export const holderName = (
  subject: Exclude<PermissionSubject, { type: "app" }>,
  names?: Permission["workflowNames"]
): string => {
  switch (subject.type) {
    case "agent": {
      return i18n._(msg`Agent ${ph({ agent: subject.agentId })}`);
    }
    case "workflow": {
      return workflowNamed(subject.workflowId, names);
    }
    case "trigger": {
      return i18n._(msg`Trigger ${ph({ trigger: subject.triggerId })}`);
    }
    default: {
      return subject satisfies never;
    }
  }
};

/**
 * Who asks: the App, agent or independent resource the permission is for;
 * a trigger by its kind and what starts it, as core lists it.
 */
export const subjectOf = (
  { subject, trigger, workflowNames }: Permission,
  directory: Directory
): string => {
  if (subject.type === "app") {
    return appName(directory, subject.appId);
  }
  if (trigger === undefined) {
    return holderName(subject, workflowNames);
  }
  const kind = i18n._(kindLabels[trigger.kind]);
  const what = triggerDescription(trigger);
  return i18n._(msg`${kind} (${what})`);
};

/**
 * What it asks for: a workflow by its name, a connection by ID, as it has
 * no name here.
 */
export const objectOf = (
  { object, actions, workflowNames, functionName }: Permission,
  directory: Directory
): string => {
  if (object.type === "connection") {
    const { connectionId, resource } = object;
    return resource === undefined
      ? i18n._(msg`Connection ${connectionId}`)
      : i18n._(msg`Connection ${connectionId}, ${resource}`);
  }
  if (object.type === "app" && object.function !== undefined) {
    // A workflow's permission on one function, by its ID, named by its
    // path now. Consent in plain words: it reads or changes what that
    // function does, as the person each run acts for.
    const app = appName(directory, object.appId);
    const path = functionName ?? object.function;
    return i18n._(
      msg`Calls ${ph({ path })} of ${ph({ app })}. Each run can read or change whatever that function reads or changes in the App, as the person it runs for`
    );
  }
  if (object.type === "app") {
    // An agent's permission on an App's functions, by action as core
    // checks it (agent-apps.ts): `read` calls its queries, `write` its
    // mutations and actions, and neither allows the other's.
    const app = appName(directory, object.appId);
    const reads = actions.includes("read");
    const writes = actions.includes("write");
    if (reads && writes) {
      return i18n._(msg`Queries, mutations and actions of ${ph({ app })}`);
    }
    return writes
      ? i18n._(msg`Mutations and actions of ${ph({ app })}`)
      : i18n._(msg`Queries of ${ph({ app })}`);
  }
  if (object.type === "platform" && actions.includes("brain")) {
    // Consent in plain words: what it reads, whose access bounds it, and
    // who it may then be shared with (core's brain-recall.ts). The teams
    // by name, or by ID for one that no longer exists.
    const named = object.teams ?? [];
    if (named.length === 0) {
      return i18n._(
        msg`Company Brain, read only. This can recall and look up what everyone in the company may read, its entities and their memories included, never a team's or anyone's own content. It can never write to the Brain. Every read is recorded`
      );
    }
    const count = named.length;
    const teamNames = formatList(named.map((id) => teamName(directory, id)));
    return i18n._(
      msg`${plural(count, {
        one: `Company Brain, read only. This App can recall what everyone in the company may read and what the team ${teamNames} may read, as far as the person it works for is in that team, and look up the entities and memories everyone in the company may read. Only people in that team can use it, its owner and admins too. It can never write to the Brain. Every read is recorded`,
        other: `Company Brain, read only. This App can recall what everyone in the company may read and what the teams ${teamNames} may read, as far as the person it works for is in them, and look up the entities and memories everyone in the company may read. Only people in all of them can use it, its owner and admins too. It can never write to the Brain. Every read is recorded`,
      })}`
    );
  }
  if (object.type === "platform") {
    // Consent in plain words: what the App reads is published company-wide
    // on purpose (counts only, never a run), and it may show it to anyone.
    return i18n._(
      msg`Platform statistics. This App can read run and signal counts for every App, and may show them to anyone who uses it`
    );
  }
  return workflowNamed(object.workflowId, workflowNames);
};

/**
 * The App whose version an admin reviews as they decide: the App asking,
 * or the App whose one function a workflow asks to call, as its current
 * version names it. None for any other request.
 */
const reviewedApp = ({ subject, object }: Permission): string | undefined => {
  if (subject.type === "app") {
    return subject.appId;
  }
  return object.type === "app" && object.function !== undefined
    ? object.appId
    : undefined;
};

/**
 * The version of the App an admin reviews as they decide (`reviewedApp`):
 * the one current as the list was read, whose code the grant trusts. Null
 * for an agent's permission, an App with none current, or one the list
 * doesn't have: core then grants only if the App still has none current.
 */
export const reviewedVersion = (
  request: Permission,
  directory: Directory
): number | null => {
  const app = reviewedApp(request);
  return app === undefined
    ? null
    : (directory.apps.get(app)?.currentVersion ?? null);
};

/** The label people know the version to review by (`App.liveLabel`). */
const reviewedLabel = (
  { subject }: Permission,
  directory: Directory
): string | null =>
  subject.type === "app"
    ? (directory.apps.get(subject.appId)?.liveLabel ?? null)
    : null;

/** The version to review, as the row shows it. */
/** What `reviewedVersionText` says for a request with no App version to review. */
export const noVersion = "–";

export const reviewedVersionText = (
  request: Permission,
  directory: Directory
): string => {
  const app = reviewedApp(request);
  if (app === undefined) {
    return noVersion;
  }
  if (!directory.apps.has(app)) {
    return i18n._(msg`Unknown`);
  }
  return reviewedLabel(request, directory) ?? i18n._(msg`None live`);
};

const versionChanged = msg`Another version of this App was published since this list was read. The list now shows it: review that version, then approve again.`;

/**
 * Grants `request` for `version`, the one the admin reviewed. Core refuses
 * with `app.conflict` once another version is current: that is said
 * plainly. Outside components, as the React Compiler can't compile `try`.
 */
export const grantReviewed = async (
  permissions: Session["permissions"],
  request: Permission,
  version: number | null
): Promise<Permission> => {
  try {
    return await permissions.grant(request.id, { version });
  } catch (error) {
    if (appErrors.codeOf(error) === "app.conflict") {
      throw new Error(i18n._(versionChanged), { cause: error });
    }
    throw error;
  }
};

/**
 * A schedule trigger asking to start its workflow: its workflow's name and
 * when it next runs, from the request's own fields (the cron read by
 * croner, through `nextScheduledRun`, skipping a time the clocks skip, as
 * such a trigger does). Undefined for any other request, or a schedule
 * with no time to come: then the request reads as every other one.
 */
const scheduleOf = (
  { trigger, object, actions, workflowNames }: Permission,
  now: Date
): { workflow: string; next: Date; timeZone: string } | undefined => {
  const schedule = trigger?.kind === "schedule" ? trigger.schedule : null;
  const startsWorkflow =
    object.type === "workflow" &&
    actions.length === 1 &&
    actions[0] === "start";
  if (schedule === null || !startsWorkflow) {
    return undefined;
  }
  const next = nextScheduledRun(schedule, now, "skip");
  if (next === undefined) {
    return undefined;
  }
  const workflow = workflowNames?.[object.workflowId] ?? object.workflowId;
  return { workflow, next, timeZone: schedule.timeZone };
};

/**
 * A trigger asking to start its workflow: what kind it is, the workflow
 * by its name, and what it listens to. Undefined for any other request.
 */
const triggerStartOf = ({
  trigger,
  object,
  actions,
  workflowNames,
}: Permission):
  | { kind: TriggerKind; workflow: string; what: string }
  | undefined => {
  const startsWorkflow =
    object.type === "workflow" &&
    actions.length === 1 &&
    actions[0] === "start";
  if (trigger === undefined || !startsWorkflow) {
    return undefined;
  }
  return {
    kind: trigger.kind,
    workflow: workflowNames?.[object.workflowId] ?? object.workflowId,
    what: triggerDescription(trigger),
  };
};

/**
 * A trigger asking to start its workflow, by its kind and the workflow; a
 * webhook trigger by its source too (`triggerDescription`), as an admin
 * may have several. Core's request names no mailbox or connection by
 * name, so the others say no more.
 */
const startAskers = {
  email: msg({ message: "Email trigger for {workflow}" }),
  schedule: msg({ message: "Schedule for {workflow}" }),
  connector: msg({ message: "Connection trigger for {workflow}" }),
  webhook: msg({ message: "Webhook trigger for {workflow} ({what})" }),
} as const satisfies Record<TriggerKind, MessageDescriptor>;

/**
 * Who asks, in one line: a schedule asking to start its workflow by what
 * it is ("Schedule for invoice-approval"), never its cron; another trigger
 * by its kind and its workflow ("Email trigger for invoice-intake"), so
 * two never read the same; any other as `subjectOf` names it.
 */
export const requestAsker = (
  request: Permission,
  directory: Directory,
  now: Date = new Date()
): string => {
  const scheduled = scheduleOf(request, now);
  if (scheduled !== undefined) {
    const { workflow } = scheduled;
    return i18n._(msg`Schedule for ${ph({ workflow })}`);
  }
  const started = triggerStartOf(request);
  if (started === undefined) {
    return subjectOf(request, directory);
  }
  return i18n._({
    ...startAskers[started.kind],
    values: { workflow: started.workflow, what: started.what },
  });
};

/**
 * When a schedule asking to start its workflow next runs, in words: the
 * time in the schedule's own zone, as the page's language writes a day and
 * an hour (24-hour where its language is). Undefined for any other request.
 */
export const requestNextRun = (
  request: Permission,
  now: Date = new Date()
): string | undefined => {
  const scheduled = scheduleOf(request, now);
  if (scheduled === undefined) {
    return undefined;
  }
  const { next, timeZone } = scheduled;
  const when = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(next);
  const zone = formatZone(timeZone);
  return i18n._(msg`Next run ${ph({ when })} (${ph({ zone })})`);
};

/**
 * What a request asks, in one line: who asks, for what, on what; a
 * schedule asking to start its workflow by what it is alone, as
 * `requestAsker` has it (its next run is `requestNextRun`'s line).
 */
export const requestWords = (
  request: Permission,
  directory: Directory,
  now: Date = new Date()
): string => {
  if (scheduleOf(request, now) !== undefined) {
    return requestAsker(request, directory, now);
  }
  const subject = subjectOf(request, directory);
  const object = objectOf(request, directory);
  const actions = formatList(request.actions);
  return i18n._(
    msg`${ph({ subject })}: ${ph({ actions })} on ${ph({ object })}`
  );
};

/** What a trigger asking to start its workflow lets it do, as a question. */
const startQuestions = {
  email: msg({ message: "Let {workflow} start when an email arrives?" }),
  schedule: msg({ message: "Let {workflow} start on its schedule?" }),
  connector: msg({
    message: "Let {workflow} start on events from its connection?",
  }),
  webhook: msg({ message: "Let {workflow} start when its webhook is called?" }),
} as const satisfies Record<TriggerKind, MessageDescriptor>;

/**
 * A request as the question an admin answers: a trigger asking to start
 * its workflow by which workflow and what lets it start; any other as
 * "Grant" what it asks (`requestWords`).
 */
export const requestQuestion = (
  request: Permission,
  directory: Directory
): string => {
  const started = triggerStartOf(request);
  if (started === undefined) {
    const who = requestWords(request, directory);
    return i18n._(msg`Grant ${ph({ who })}?`);
  }
  return i18n._({
    ...startQuestions[started.kind],
    values: { workflow: started.workflow },
  });
};
