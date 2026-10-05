import { actionHasPrefix } from "@grasp-os/shared/audit-log";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What each audit entry did, in words, as the prototype's audit trail says
// it (`routes/settings/audit.tsx`): a sentence per action, read under who
// did it and to what. Keyed by the action or a dotted prefix of it, as
// core files actions into types (`@grasp-os/shared/audit-log`), so an
// action core adds later reads as its family until it gets its own words.

const words: readonly { action: string; text: MessageDescriptor }[] = [
  { action: "connection.call", text: msg`Used a connected tool` },
  { action: "connection.connect", text: msg`Connected an account` },
  {
    action: "connection.reconnected",
    text: msg`Signed in to a connection again`,
  },
  { action: "connection.disconnect", text: msg`Disconnected an account` },
  { action: "connection.consent", text: msg`Gave consent for a connection` },
  {
    action: "connection.offer_changed",
    text: msg`Changed which integrations are offered`,
  },
  {
    action: "connection.needs_reauth",
    text: msg`A connection needs signing in again`,
  },
  {
    action: "connection.events.read",
    text: msg`Read what changed at a connection`,
  },
  {
    action: "connection.events.dropped",
    text: msg`Dropped an event no workflow could take`,
  },
  {
    action: "connection.events.started",
    text: msg`Started following what changes at a connection`,
  },
  {
    action: "connection.events.stopped",
    text: msg`Stopped following what changes at a connection`,
  },
  {
    action: "connection.events.refused",
    text: msg`A connection refused to say what changed`,
  },
  {
    action: "connection.events.failed",
    text: msg`Reading what changed at a connection failed`,
  },
  {
    action: "connection.events.primed_late",
    text: msg`Started following a connection late: changes before then weren't read`,
  },
  {
    action: "connection.events",
    text: msg`Changed what a connection listens for`,
  },
  {
    action: "connection.action.dropped",
    text: msg`Dropped a held action nobody can confirm`,
  },
  { action: "connection.action", text: msg`Decided on a held action` },
  { action: "connection", text: msg`Changed a connection` },
  { action: "knowledge.search", text: msg`Searched knowledge` },
  { action: "knowledge.read", text: msg`Read a knowledge document` },
  {
    action: "knowledge.signals.computed",
    text: msg`Worked out how knowledge is used`,
  },
  { action: "knowledge.signals.read", text: msg`Read how knowledge is used` },
  {
    action: "knowledge.signal.dismissed",
    text: msg`Dismissed a knowledge signal`,
  },
  { action: "knowledge.collection.created", text: msg`Created a collection` },
  { action: "knowledge.collection", text: msg`Changed a collection` },
  { action: "knowledge.upload", text: msg`Uploaded to knowledge` },
  { action: "knowledge", text: msg`Changed knowledge` },
  { action: "chat.created", text: msg`Started a chat` },
  { action: "chat", text: msg`Changed a chat` },
  { action: "agent.call", text: msg`The agent looked something up` },
  {
    action: "model.budget",
    text: msg`A model budget reached its alert or ran out`,
  },
  { action: "model.refused", text: msg`A model call was refused` },
  { action: "model", text: msg`Called a model` },
  { action: "permission.requested", text: msg`Asked for a permission` },
  { action: "permission.granted", text: msg`Granted a permission` },
  { action: "permission.revoked", text: msg`Revoked a permission` },
  { action: "permission", text: msg`Changed a permission` },
  {
    action: "context.restricted",
    text: msg`Read restricted sources, and is held to them`,
  },
  { action: "staff.session", text: msg`Grasp staff signed in` },
  { action: "app.call", text: msg`Called another engine` },
  { action: "app.called", text: msg`Was called by another engine` },
  { action: "app.member.added", text: msg`Added a member to an engine` },
  {
    action: "app.member.refused",
    text: msg`Was refused adding a member to an engine`,
  },
  { action: "app", text: msg`Changed an engine` },
  { action: "member.removed", text: msg`Removed a member` },
  { action: "member.role", text: msg`Changed a member's role` },
  { action: "member", text: msg`Changed a member` },
  { action: "team.created", text: msg`Created a team` },
  { action: "team.deleted", text: msg`Deleted a team` },
  { action: "team.member.added", text: msg`Added someone to a team` },
  { action: "team.member.removed", text: msg`Took someone off a team` },
  { action: "team", text: msg`Changed a team` },
  {
    action: "workflow.decision",
    text: msg`A decision was put to people, or answered`,
  },
  { action: "workflow.email.read", text: msg`Read an email attachment` },
  { action: "workflow.run.fix_asked", text: msg`Asked the agent to fix a run` },
  { action: "workflow.run", text: msg`Ran a workflow` },
  { action: "workflow.step", text: msg`Ran a step of a workflow` },
  { action: "workflow.param", text: msg`Changed a workflow's parameter` },
  {
    action: "workflow.schedule",
    text: msg`Stopped a schedule that kept failing`,
  },
  { action: "workflow", text: msg`Changed a workflow` },
  { action: "platform", text: msg`Updated Grasp` },
  {
    action: "improvement.signals.computed",
    text: msg`Worked out what could be improved`,
  },
  {
    action: "improvement.signals.read",
    text: msg`Read what could be improved`,
  },
  { action: "statistics.read", text: msg`Read an engine's statistics` },
  { action: "guest.invited", text: msg`Invited a guest` },
  { action: "guest.revoked", text: msg`Took back a guest's link` },
  { action: "guest.read", text: msg`Read what a guest wrote` },
  { action: "guest.opened", text: msg`A guest opened their chat` },
  { action: "guest.message", text: msg`A guest wrote a message` },
  { action: "guest.finished", text: msg`A guest finished their chat` },
  { action: "guest", text: msg`A guest chat changed` },
  {
    action: "audit.archived",
    text: msg`Moved old entries out of the audit trail`,
  },
  { action: "audit.purged", text: msg`Deleted entries past their retention` },
  {
    action: "audit.gap",
    text: msg`Set aside entries the audit trail couldn't take`,
  },
  { action: "audit.searched", text: msg`Searched the audit trail` },
  { action: "audit.exported", text: msg`Exported the audit trail` },
  { action: "audit.verified", text: msg`Checked the audit trail's chain` },
];

/**
 * What `action` did, in words: those of the longest action or prefix of
 * it that has words, or none for an action nothing here names, which the
 * page then shows as core recorded it.
 */
export const actionWords = (action: string): MessageDescriptor | undefined =>
  words
    .filter((entry) => actionHasPrefix(action, entry.action))
    .toSorted((one, other) => other.action.length - one.action.length)[0]?.text;
