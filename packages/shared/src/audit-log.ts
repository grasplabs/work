import { z } from "zod";

import type { AuditActor, AuditEvent } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierMaxLength, identifierSchema } from "./ids.ts";

// Reading the audit log: search, export and chain verification, for admins.
// Only what the log holds now is searched: events past the deployment's
// retention are archived out of it (see core's src/audit-log.ts).

/**
 * What kind of thing an event records, for filtering: a read of data, an
 * action with an effect, a decision put to a person or made by one, a
 * change to permissions, a model call, a change to configuration, or an
 * update of the platform.
 */
export const auditEventTypeSchema = z.enum([
  "read",
  "action",
  "decision",
  "permission",
  "model_call",
  "config",
  "platform_update",
]);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

/**
 * The type of each action. The first rule whose `action` is the event's
 * action, or a dotted prefix of it, gives the type (`knowledge` covers
 * `knowledge.document.saved`); a rule with `sideEffect` or `access` applies
 * only to an event whose `detail.sideEffect` or `detail.access` is that
 * value. An action no rule names has no type: it is still found by every
 * other filter. New actions add a rule.
 *
 * Actions are stored in the hash-chained log, so they are a data contract:
 * never rename one, add a rule instead. A new action is `noun.verbed`, in
 * dotted segments from the general to the specific (`knowledge.document.
 * saved`, `workflow.run.started`), so a prefix finds its family. Older
 * actions that don't follow it (`connection.call`, `connection.offer_changed`)
 * keep their names.
 */
const typeRules: readonly {
  action: string;
  type: AuditEventType;
  sideEffect?: boolean;
  access?: "read" | "write";
}[] = [
  // A person saying what became of a call of unknown outcome (or being
  // refused that): their word, never a send.
  { action: "connection.call.resolved", type: "decision" },
  { action: "connection.call.resolve_refused", type: "decision" },
  // An admin reading every person's calls of unknown outcome, without what
  // was sent: who looked at whose activity.
  { action: "connection.call.unknown_listed", type: "read" },
  // A connector call that changed something at the provider, or only read.
  { action: "connection.call", sideEffect: true, type: "action" },
  { action: "connection.call", type: "read" },
  { action: "connection.connect", type: "config" },
  // An admin changing which tools a connected app allows (GRA-993).
  { action: "connection.tools", type: "config" },
  // Connect sending, editing or deleting a message as the client's own bot
  // on a chat platform, or refusing a request core's chat adapters sent.
  { action: "channel.call", type: "action" },
  // A connection whose grant ran out given a new one, by signing in again.
  { action: "connection.reconnected", type: "config" },
  { action: "connection.disconnect", type: "config" },
  // An admin consenting to Composio holding a connection's tokens, and
  // the tools they marked as reads, which run unheld
  // (`connection.consent.read_tools`).
  { action: "connection.consent", type: "config" },
  // An admin changing which connectors are offered.
  { action: "connection.offer_changed", type: "config" },
  // An admin turning a class of tools on or off, and for whom.
  { action: "connection.class.changed", type: "config" },
  // An admin narrowing a class for one app, and changing who reaches
  // Stephen, in every chat app or one place (Settings › Stephen).
  { action: "connection.app_class.changed", type: "config" },
  { action: "stephen.reach.changed", type: "config" },
  { action: "stephen.place.changed", type: "config" },
  // An admin making or changing one of the company's agents, pausing it
  // or turning it back on, and saying whom it reaches and for whom it has
  // a class of tools (core's src/agent-builder.ts).
  { action: "agent.made", type: "config" },
  { action: "agent.changed", type: "config" },
  { action: "agent.paused", type: "config" },
  { action: "agent.reach.changed", type: "config" },
  { action: "agent.class.changed", type: "config" },
  // An admin making, pausing or deleting one of an agent's wake-ups
  // (core's src/agent-wakes.ts).
  { action: "agent.wake.made", type: "config" },
  { action: "agent.wake.paused", type: "config" },
  { action: "agent.wake.deleted", type: "config" },
  // An admin pointing Stephen at a shared mailbox, and for whom.
  { action: "connection.mailbox.pointed", type: "config" },
  // An admin pointing Stephen at a company app, and for whom.
  { action: "connection.app.pointed", type: "config" },
  // A connection's tokens stopped working: it needs signing in again.
  { action: "connection.needs_reauth", type: "config" },
  // Connect reading what changed at a connection for workflows' event
  // triggers, dropping an event it couldn't deliver, and starting or
  // stopping listening there, being refused it, or failing to read it.
  { action: "connection.events.read", type: "read" },
  // An event dropped after its last try: a workflow it would have started
  // didn't start.
  { action: "connection.events.dropped", type: "action" },
  { action: "connection.events", type: "config" },
  // Event sources (core's src/event-sources.ts): an admin creating one,
  // rotating or revoking its secret, and deleting it.
  { action: "event_source", type: "config" },
  // An event source's event a workflow's trigger refused for good (core's
  // src/workflows/source-events.ts), or a waiting run refused; its events
  // kept for a later wait expiring, or one not kept as it keeps all it
  // may (src/workflows/event-waits.ts).
  { action: "workflow.webhook", type: "action" },
  // A held action dropped because nobody can confirm it any more, then a
  // person confirming or declining one (or being refused that).
  { action: "connection.action.dropped", type: "action" },
  { action: "connection.action", type: "decision" },
  // The onboarding: who works where, the plan, pausing it, the
  // agreements, and the gate that keeps the company out until Grasp's go.
  { action: "onboarding", type: "config" },
  // An admin adding records the brain is built from, and a purge
  // rewriting a record's words.
  { action: "brain.records", type: "action" },
  // A Grasp staff member reaching a namespace, method or route of the
  // client's deployment (core's staff-audit.ts): what they looked at or
  // did there, by its surface and identifiers, never its content.
  { action: "staff.accessed", type: "read" },
  // A gap's owner asked (Grasp's), and a person answering or closing it.
  { action: "brain.gap.asked", type: "action" },
  // A purge rewriting answers, or forgetting who gave them.
  { action: "brain.gap.answers_purged", type: "action" },
  { action: "brain.gap.answerer_erased", type: "action" },
  { action: "brain.gap", type: "decision" },
  // Two entities of different collections decided to be one, or not
  // (GRA-1080): their IDs and evidence, never a name.
  { action: "brain.entity_match", type: "decision" },
  { action: "knowledge.search", type: "read" },
  // A skill selected for a task, or none (GRA-310): which, never its text.
  { action: "knowledge.skill", type: "read" },
  { action: "knowledge.read", type: "read" },
  // Knowledge usage signals: the daily computation, an owner reading those
  // of their collections, and dismissing one.
  { action: "knowledge.signals.computed", type: "action" },
  { action: "knowledge.signals.read", type: "read" },
  { action: "knowledge.signal.dismissed", type: "decision" },
  { action: "knowledge.collection", type: "config" },
  { action: "knowledge", type: "action" },
  // A person making, renaming or deleting one of their chats.
  { action: "chat", type: "action" },
  // A call of the chat agent's code that nothing else records: a listing,
  // a catalog or a run's status, or a call refused before it did anything.
  // Its calls that can change something (a connector call, an App's
  // export) record themselves under their own actions.
  { action: "agent.call", type: "read" },
  { action: "model", type: "model_call" },
  { action: "permission", type: "permission" },
  // A chat or run whose context read restricted sources, and so is held to
  // them, and a staff member signing in to the deployment.
  { action: "context.restricted", type: "permission" },
  { action: "staff.session", type: "permission" },
  // A call of another App's function, by the calling App (`app.call`)
  // and by the called App (`app.called`), both read from older entries
  // only, since Apps no longer call each other: a read for one that only
  // read, and an action for one that wrote, or one refused before its
  // access was known.
  // An App's server code refused a use its sealed manifest doesn't allow
  // (core's src/function-host.ts): a function, resource or workflow it
  // doesn't list, or a request its declaration doesn't allow.
  { action: "app.use.refused", type: "permission" },
  // An App reading the organization's people for the person using it
  // (core's src/app-people.ts): which read, and how many people it
  // answered, never whom; and a read refused to an App that doesn't
  // declare it reads them.
  { action: "app.people.read", type: "read" },
  { action: "app.people.refused", type: "permission" },
  { action: "app.call", access: "read", type: "read" },
  { action: "app.call", type: "action" },
  { action: "app.called", access: "read", type: "read" },
  { action: "app.called", type: "action" },
  // Code refused an App's data (core's src/page-delivery.ts): a page
  // of a revoked release, or a call with no lease while the App's data
  // isn't `ordinary`. An admin approving a page's build or taking that back
  // is no longer recorded, but past records stay decisions.
  { action: "app.artifact.refused", type: "action" },
  { action: "app.artifact", type: "decision" },
  // Events already in the log from the removed portable host; nothing writes them now.
  { action: "app.token.issued", type: "permission" },
  { action: "app.portable.called", type: "action" },
  // An App's webhooks (core's src/app-webhooks.ts): an admin letting its
  // data go to one's URL, a delivery given up, and connect sending one
  // (`webhook.call`); adding and removing one are the App's configuration.
  // An App's data read and changed from its page (core's src/app-data.ts):
  // a builder or admin exporting a table, and importing rows into one.
  { action: "app.data.exported", type: "read" },
  // A table its schema declares sensitive read (core's
  // src/sensitive-reads.ts): by an App's function, once a call for each
  // function and table, or by the data browser or an export; who read,
  // which table and how many of its records, never what they hold.
  { action: "app.data.read", type: "read" },
  { action: "app.data.imported", type: "action" },
  // A defaulted field, or one the App answered for, filled in on the records
  // that lacked it as a version was published (core's store-host.ts): one
  // entry a field, saying how many records took its value.
  { action: "app.data.filled", type: "action" },
  // What else a version's schema did to an App's records as it was
  // published (core's store-host.ts): a table or field renamed, left out
  // and kept with its values, or rewritten by the version's migration
  // (with how many records). Names and counts only.
  { action: "app.data.renamed", type: "action" },
  { action: "app.data.kept", type: "action" },
  { action: "app.data.migrated", type: "action" },
  // An App's data reset (core's store-host.ts): by an admin of the
  // organization, or by a builder for data stored before stable IDs. Every
  // record gone, its current version applied to the empty store; one entry
  // more a table, with how many records it held.
  { action: "store.reset", type: "action" },
  { action: "app.data.erased", type: "action" },
  // A publish whose version's schema reached the App's store but that
  // core couldn't make current, the current version's schema not taken
  // back (core's app-schema.ts): only that version runs until it is
  // published again.
  { action: "app.version.unfinished", type: "action" },
  { action: "app.webhook.approved", type: "decision" },
  { action: "app.webhook.undeliverable", type: "action" },
  { action: "webhook.call", type: "action" },
  // Visitors of a published App (core's src/app-visitors.ts): who may
  // visit, a visitor signing in and out, and each refusal, are who gets
  // in; a code mailed is something done for them.
  { action: "app.visitor_listed", type: "permission" },
  { action: "app.visitor_unlisted", type: "permission" },
  { action: "app.visitor_signed_in", type: "permission" },
  { action: "app.visitor_signed_out", type: "permission" },
  { action: "app.visitor_refused", type: "permission" },
  { action: "app.visitor_code_sent", type: "action" },
  // The functions a version grants visitors (core's
  // src/app-visitor-grants.ts) are who may do what; a visitor's call of
  // one runs it.
  { action: "app.visitor_granted", type: "permission" },
  { action: "app.visitor_ungranted", type: "permission" },
  { action: "app.visitor_called", type: "action" },
  { action: "app", type: "config" },
  // A person linking a chat platform account to themselves, so the agent
  // knows them there, or unlinking it: who they are on that door.
  { action: "channel_account", type: "permission" },
  { action: "member", type: "config" },
  { action: "team", type: "config" },
  // A decision a run put to people: opened, asked, answered, timed out.
  { action: "workflow.decision", type: "decision" },
  // npm packages asked for an App or a workflow: the request, and another
  // taking its place.
  { action: "dependency.requested", type: "action" },
  { action: "dependency.superseded", type: "action" },
  // A resolve, an approval, a build or a rescan refused because a package
  // in the graph is known malware; an approval refused because whether it
  // is couldn't be checked; and a rescan finding an advisory the approval
  // didn't know.
  { action: "dependency.malware_refused", type: "action" },
  { action: "dependency.approval_refused", type: "action" },
  { action: "dependency.advisory_found", type: "action" },
  // An approved graph built for what uses it: its install.
  { action: "dependency.built", type: "action" },
  // What follows from a decision or a deletion, not one itself: an
  // approval replaced by a later one, and one withdrawn once its App or
  // workflow is gone or no kept release runs on it.
  { action: "dependency.retired", type: "action" },
  { action: "dependency.withdrawn", type: "action" },
  // What releases before GRA-1636 wrote, read as they were filed: a build
  // refused packages nobody approved, a build's pin of an approved
  // graph's artifact dropping, and a resolve changing what a lock's
  // target is built for.
  { action: "dependency.admission_refused", type: "action" },
  { action: "dependency.pin_dropped", type: "action" },
  { action: "dependency.lock_targets_changed", type: "action" },
  // A builder approving or denying a request, and core revoking one.
  { action: "dependency", type: "decision" },
  // A run reading an attachment of a message its email trigger kept.
  { action: "workflow.email.read", type: "read" },
  // Someone with a role in a workflow reading the organization's people
  // and teams, to name one in its start form (core's
  // src/workflow-start-form.ts): how many it answered, never whom.
  { action: "workflow.people.read", type: "read" },
  // An attachment of a message an independent workflow's email trigger
  // received, copied into the run it started as a file of the run.
  { action: "workflow.email.attachment", type: "action" },
  // A reply to a run's mail reaching its inbox (core's
  // src/workflows/inbound-email.ts): one the run took, and one dropped
  // (the run ended, its approval went, its inbox is full, or it may loop).
  { action: "workflow.email.reply", type: "action" },
  // A run's step refused a call of a binding its version's review doesn't
  // show it calling.
  { action: "workflow.call.refused", type: "permission" },
  { action: "workflow.run", type: "action" },
  // A wake the request that owed it didn't get through, sent by the
  // platform's repair (core's src/workflows/wakes.ts).
  { action: "workflow.wake.repaired", type: "action" },
  { action: "workflow.step", type: "action" },
  { action: "workflow.param", type: "config" },
  // What a workflow keeps between its runs: a step writing it, a builder
  // resetting it (core's src/workflow-state.ts).
  { action: "workflow.state", type: "action" },
  // A schedule stopped after its run kept failing to start.
  { action: "workflow.schedule", type: "action" },
  { action: "platform", type: "platform_update" },
  // Improvement signals: the daily computation, and reading them.
  { action: "improvement.signals.computed", type: "action" },
  { action: "improvement.signals.read", type: "read" },
  // An App reading a measure the platform publishes of an App's runs
  // (src/statistics.ts): counts and sums only.
  { action: "statistics.read", type: "read" },
  // Events already in the log from the removed published templates: a
  // read of the version a binding pinned, and an admin publishing a
  // version. Nothing writes them now.
  { action: "resource.template.read", type: "read" },
  { action: "resource.template", type: "config" },
  // A store's cascade job deleting, after their commit, the records a
  // deletion reached past one commit's bound (core's src/store-host.ts):
  // started with the commit, each batch, its end, and a job set aside
  // after its batches kept failing.
  { action: "store.cascade_started", type: "action" },
  { action: "store.cascade_batch", type: "action" },
  { action: "store.cascade_finished", type: "action" },
  { action: "store.cascade_failed", type: "action" },
  // Guest chats (core's src/guests.ts): an App inviting someone, revoking
  // the link, and reading back what they wrote; the guest opening the
  // chat, sending a message and finishing it.
  { action: "guest.read", type: "read" },
  { action: "guest.invited", type: "permission" },
  { action: "guest.revoked", type: "permission" },
  { action: "guest", type: "action" },
  // The log's own events, each named, so an `audit` action added later has
  // no type until it gets a rule: retention moving events out and purging
  // them, gaps (outbox rows the log can't take, moved aside), then reading
  // the log.
  { action: "audit.archived", type: "action" },
  { action: "audit.purged", type: "action" },
  { action: "audit.gap", type: "action" },
  { action: "audit.searched", type: "read" },
  { action: "audit.exported", type: "read" },
  { action: "audit.verified", type: "read" },
];

/** Whether `action` is `prefix` or starts with it and a dot. */
export const actionHasPrefix = (action: string, prefix: string): boolean =>
  action === prefix || action.startsWith(`${prefix}.`);

/** The event's type, by the rules above; `null` when none names it. */
export const auditEventTypeOf = (
  event: Pick<AuditEvent, "action" | "detail">
): AuditEventType | null =>
  typeRules.find(
    ({ action, sideEffect, access }) =>
      actionHasPrefix(event.action, action) &&
      (sideEffect === undefined || event.detail.sideEffect === sideEffect) &&
      (access === undefined || event.detail.access === access)
  )?.type ?? null;

/** A dotted action or the start of one: `connection` or `connection.call`. */
export const auditActionPrefixSchema = z
  .string()
  .max(identifierMaxLength)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);

/** An ISO 8601 time, as the log writes its own (`toISOString`), to compare. */
const timeSchema = z.iso
  .datetime({ offset: true })
  .transform((time) => new Date(time).toISOString());

const actorTypes = [
  "person",
  "agent",
  "app",
  "workflow",
  "staff",
  "guest",
  "visitor",
  "system",
] as const satisfies readonly AuditActor["type"][];

/**
 * Which events to find; every field narrows it, and none finds them all.
 * Times are when the log received the event, `from` included and `to` not.
 */
export const auditFilterSchema = z
  .strictObject({
    from: timeSchema.optional(),
    to: timeSchema.optional(),
    actorType: z.enum(actorTypes).optional(),
    /**
     * A person's or staff member's user ID, an agent's ID, an App's ID (its
     * pages, server code and workflow runs) or a workflow run's ID.
     */
    actorId: identifierSchema.optional(),
    type: auditEventTypeSchema.optional(),
    /** The action or a dotted prefix of it: `connection` finds `connection.call`. */
    action: auditActionPrefixSchema.optional(),
    targetType: identifierSchema.optional(),
    targetId: identifierSchema.optional(),
    /** A resource the event names in its provenance or as `detail.resource`. */
    resource: identifierSchema.optional(),
  })
  .default({});
export type AuditFilter = z.input<typeof auditFilterSchema>;
export type ParsedAuditFilter = z.output<typeof auditFilterSchema>;

/** A position in the chain, from 1; 0 is before the first entry. */
export const auditPositionSchema = z.int().nonnegative();

/** One event as the log holds it, with its place in the hash chain. */
export interface AuditRecord {
  /** Position in the chain, from 1. */
  seq: number;
  /** When the log received it (ISO 8601), set by the log. */
  receivedAt: string;
  /**
   * The event exactly as it was stored and hashed: its canonical JSON
   * (RFC 8785). This, not `event`, is what the hash covers.
   */
  eventJson: string;
  /** The event, read with today's schema; `null` if what's stored isn't one. */
  event: AuditEvent | null;
  type: AuditEventType | null;
  /** The hash format, the hash of the entry before it, and its own hash. */
  version: number;
  prevHash: string;
  hash: string;
  /**
   * Whether it's an event, its hash matches `eventJson` and its other
   * fields, and it links to the entry before it as the log holds that now.
   */
  verified: boolean;
}

/** A page of search results, newest first. */
export interface AuditPage {
  records: AuditRecord[];
  /**
   * Pass as `before` for the next, older page; `null` once nothing older is
   * left. A page may hold fewer records than the most, or none, and still
   * have a next one: each page reads a bounded stretch of the log.
   */
  next: number | null;
}

export const auditExportFormatSchema = z.enum(["json", "csv"]);
export type AuditExportFormat = z.infer<typeof auditExportFormatSchema>;

/**
 * How an export reads: `archive` takes in what retention moved to the
 * archive, as `export` describes. Without it, what the log holds alone.
 */
export const auditExportOptionsSchema = z
  .strictObject({ archive: z.boolean().optional() })
  .optional();
export type AuditExportOptions = z.input<typeof auditExportOptionsSchema>;

/** Why the chain breaks at a position: see core's src/audit-chain.ts. */
export type ChainBreak = "missing" | "unlinked" | "altered";

/**
 * One step of verifying the chain. The chain is checked a stretch at a
 * time: a step checks the entries after position `after`, from the hash
 * the log holds for that position, and says how far it got. Pass `through`
 * as the next step's `after` until `done`. A broken step names the first
 * position where the chain breaks; nothing after it is verified.
 */
export type ChainVerification =
  | {
      ok: true;
      through: number;
      head: string;
      done: boolean;
      /**
       * Set when the step's stretch was purged by retention: the log
       * recorded the purge (`audit.purged`), and the stretch still links
       * the chain before it to the chain after it, but its entries are gone
       * and weren't checked.
       */
      purged?: true;
    }
  | { ok: false; brokenAt: number; reason: ChainBreak };

/**
 * The last pass that verified the whole chain, from its first position, in
 * unbroken steps: when it ran, and how it ended. `purgedThrough` is the
 * last position of the purged stretches it went across, if any: those it
 * found linked, but couldn't check.
 */
export type FullVerification = {
  startedAt: string;
  finishedAt: string;
  purgedThrough?: number;
} & (
  | { ok: true; through: number; head: string }
  | { ok: false; brokenAt: number; reason: ChainBreak }
);

/**
 * The audit log, over `/rpc`, for admins only. Every search that returns
 * records, every first page of a search, every export, and every
 * verification that finishes or finds a break is itself recorded in the log.
 */
export interface AuditApi {
  /** The events that match `filter`, newest first, from before `before`. */
  search: (filter?: AuditFilter, before?: number) => Promise<AuditPage>;
  /**
   * Every event that matches `filter`, oldest first, up to the head the log
   * had when the export began, as a download.
   *
   * `json`: one document, `{ exportedAt, filter, chain, records,
   * recordCheck, lastFullVerification, openObligations }`. `chain` is the
   * log's head when the export began. `recordCheck` says whether each
   * exported record verified on its own and against the entry before it;
   * that is not a verification of the whole chain, which
   * `lastFullVerification` (the last full `verify` pass, or `null`)
   * reports. `openObligations` is every person's calls of unknown outcome
   * as the export ends, `{ listedAt, complete, obligations }`: the
   * export's filter doesn't apply to it, only to `records`. Each obligation
   * is as `UnknownOutcomesApi.listAll` lists it, without its `id` and
   * `cursor`; its `effectKeyHash` is the one the call's events and its
   * resolution's carry. It holds at most 1,000, and `complete` says whether
   * that is all of them; it is `null` for Grasp staff, who see no one's.
   * It is read page by page from `listedAt`, not as one snapshot: a call
   * that becomes of unknown outcome while it is read may be missing, and
   * one resolved meanwhile may still be listed.
   *
   * `csv`: a header and a row per record; its `verified`, `prev_hash` and
   * `hash` columns are the record check. A cell that a spreadsheet would
   * read as a formula starts with `'`, so the CSV is for reading. The
   * `event` column is the stored event, which starts with `{`, except for a
   * stored row that isn't an event (`verified` false): it gets the `'` too
   * when it starts with a formula character. JSON is the exact form.
   *
   * Either way each record carries `eventJson`, its event byte for byte as
   * stored and hashed, so anyone can recompute its hash (see core's
   * src/audit-chain.ts) and compare it with the live chain. An export stops
   * with `audit.export_too_large` past {@link auditExportMaxRecords}, and
   * with `audit.export_interrupted` if retention archives events it hasn't
   * read yet.
   *
   * With `{ archive: true }` (`archive=1` on the download), it takes in
   * the archive too: every record, archived or held, in one order, by its
   * position in the chain, oldest first, so archived ones come before the
   * ones the log holds. Retention archiving under it is no interruption:
   * what moved is read from the archive. A stretch purged by archive
   * retention has nothing left: it is passed over, and JSON names it in
   * `archive.purged` (`[{ from, through }]`, positions). An archived
   * stretch that can't be read stops it with `audit.archive_unreadable`.
   * The export is recorded with `archive: true` and `purged`, how many
   * purged stretches it passes over as it begins.
   */
  export: (
    filter: AuditFilter | undefined,
    format: AuditExportFormat,
    options?: AuditExportOptions
  ) => Promise<ReadableStream<Uint8Array>>;
  /** One step of verifying the whole chain, archived stretches included. */
  verify: (after?: number) => Promise<ChainVerification>;
  /**
   * The last pass of `verify` that ran from the chain's first position and
   * ended, as JSON exports report it; `null` before one has. Not recorded
   * in the log: it reads what passes already recorded.
   */
  lastVerification: () => Promise<FullVerification | null>;
  /**
   * The archived events that match `filter`, newest first, from before
   * `before`: what retention moved out of the log, while it is kept (until
   * archive retention purges it). Each page reads one archived stretch, so
   * it may hold none and still have a next one. Recorded as a search is,
   * marked as of the archive. Refused with `audit.archive_unreadable` at a
   * stretch whose archived copy can't be read.
   */
  searchArchive: (filter?: AuditFilter, before?: number) => Promise<AuditPage>;
  /** How long Grasp keeps events and run details. Not recorded. */
  retention: () => Promise<AuditRetention>;
}

/** How long Grasp keeps what it records, in days, as fixed in code. */
export interface AuditRetention {
  /** Events stay in the log, where a search finds them, then are archived. */
  auditDays: number;
  /** Events are kept in all, archive included, then purged. */
  archiveDays: number;
  /** A run keeps its details after it ends, then they are removed. */
  runDays: number;
}

/**
 * Where a browser downloads an export: `GET` with `format` (`json` or
 * `csv`) and the filter's fields as query parameters, on the admin's
 * session cookie. The same export as `AuditApi.export`, written to disk as
 * it arrives.
 */
export const auditExportPath = "/api/audit/export";

/** Most records one export holds. */
export const auditExportMaxRecords = 100_000;

/** Why a read of the audit log was refused or stopped. */
export const auditErrors = defineErrorFamily({
  "audit.invalid": "That isn't a valid audit log query.",
  "audit.export_too_large":
    "Too many events for one export. Narrow the time range or the filter.",
  "audit.export_interrupted":
    "Older events were archived while exporting. Export again.",
  "audit.archive_unreadable":
    "Part of the audit log's archive can't be read. Verify the chain to see where.",
});
