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
  {
    action: "connection.call.unknown_listed",
    text: msg`Read everyone's calls of unknown outcome`,
  },
  { action: "connection.connect", text: msg`Connected an account` },
  {
    action: "channel.call",
    // Recorded for refusals and failures too: the words say what was
    // asked, and the entry's outcome says how it ended.
    text: msg`Asked to send, edit or delete a chat app message as the company's bot`,
  },
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
    action: "connection.revoked",
    text: msg`Revoked a disconnected account's access at its provider`,
  },
  {
    action: "connection.revoke_superseded",
    text: msg`Kept access at the provider for an account connected again`,
  },
  {
    action: "connection.revocations.viewed",
    text: msg`Looked at the access to remove by hand`,
  },
  {
    action: "connection.revoke_abandoned",
    text: msg`Gave up revoking a disconnected account's access at its provider`,
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
  {
    action: "chat.history_withheld",
    text: msg`Kept something the chat can no longer read from the model`,
  },
  { action: "chat.file_attached", text: msg`Attached a file to a chat` },
  {
    action: "chat.file_removed",
    text: msg`Removed a file from a chat before sending it`,
  },
  { action: "chat", text: msg`Changed a chat` },
  { action: "agent.call", text: msg`The agent looked something up` },
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
  { action: "app.call", text: msg`Called another App` },
  { action: "app.called", text: msg`Was called by another App` },
  { action: "app.member.added", text: msg`Added a member to an App` },
  {
    action: "app.member.refused",
    text: msg`Was refused adding a member to an App`,
  },
  // No longer recorded (pages need no approval), but past records stay.
  { action: "app.artifact.approved", text: msg`Approved a page's code` },
  {
    action: "app.artifact.revoked",
    text: msg`Took back the approval of a page's code`,
  },
  {
    action: "app.artifact.refused",
    text: msg`A page was refused the App's data`,
  },
  {
    action: "app.output.classified",
    text: msg`Changed whether an App's data goes to code outside Grasp`,
  },
  { action: "app.webhook.added", text: msg`Added a webhook to an App` },
  {
    action: "app.webhook.approved",
    text: msg`Let an App's data go to a webhook`,
  },
  {
    action: "app.webhook.removed",
    text: msg`Removed a webhook from an App`,
  },
  {
    action: "app.webhook.undeliverable",
    text: msg`Gave up sending an App's event to a webhook`,
  },
  {
    action: "webhook.call",
    // Recorded for refusals and failures too, as a channel call is.
    text: msg`Sent an App's event to a webhook`,
  },
  // A published App's visitors (core's src/app-visitors.ts), each
  // action by name: an `app.visitor_*` action has no dotted prefix of its
  // own, so it would otherwise read as `app`.
  {
    action: "app.visitor_listed",
    text: msg`Let someone visit an App`,
  },
  {
    action: "app.visitor_unlisted",
    text: msg`Stopped someone visiting an App`,
  },
  {
    action: "app.visitor_code_sent",
    text: msg`Was sent a code to visit an App`,
  },
  {
    action: "app.visitor_signed_in",
    text: msg`Signed in to an App as a visitor`,
  },
  {
    action: "app.visitor_signed_out",
    text: msg`Signed out of an App as a visitor`,
  },
  {
    action: "app.visitor_refused",
    text: msg`Was refused as an App's visitor`,
  },
  {
    action: "app.visitor_granted",
    text: msg`Let an App's visitors use one of its functions`,
  },
  {
    action: "app.visitor_ungranted",
    text: msg`Stopped an App's visitors using one of its functions`,
  },
  {
    action: "app.visitor_called",
    text: msg`Used an App's function as a visitor`,
  },
  { action: "app", text: msg`Changed an App` },
  { action: "member.removed", text: msg`Removed a member` },
  {
    action: "member.erasure.requested",
    text: msg`Asked to erase a removed member`,
  },
  { action: "member.erased", text: msg`Erased a removed member` },
  {
    action: "member.address.released",
    text: msg`Let an erased member's old address in again`,
  },
  { action: "member.role", text: msg`Changed a member's role` },
  { action: "member.invited", text: msg`Invited someone` },
  {
    action: "member.invitation.withdrawn",
    text: msg`Withdrew an invitation`,
  },
  {
    action: "member.invitation.accepted",
    text: msg`Joined through an invitation`,
  },
  {
    action: "member.joined_from_directory",
    text: msg`Joined from the directory, writing to Stephen`,
  },
  {
    action: "member.signed_in_from_directory",
    text: msg`Signed in for the first time, after joining from the directory`,
  },
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
  { action: "dependency.requested", text: msg`Proposed packages` },
  { action: "dependency.approved", text: msg`Approved packages` },
  { action: "dependency.denied", text: msg`Denied packages` },
  { action: "dependency.built", text: msg`Built approved packages` },
  {
    action: "dependency.pin_dropped",
    text: msg`Dropped a kept build of approved packages`,
  },
  {
    action: "dependency.lock_targets_changed",
    text: msg`Changed what is built of approved packages`,
  },
  {
    action: "dependency.superseded",
    text: msg`Replaced a request for packages`,
  },
  {
    action: "dependency.withdrawn",
    text: msg`Withdrew a request for packages`,
  },
  {
    action: "dependency.admission_refused",
    text: msg`Was refused packages nobody approved`,
  },
  {
    action: "dependency.malware_refused",
    text: msg`Was refused packages known as malware`,
  },
  {
    action: "dependency.decision_refused",
    text: msg`Was refused a decision on packages`,
  },
  {
    action: "dependency.advisory_found",
    text: msg`Found a new advisory for approved packages`,
  },
  { action: "dependency", text: msg`Changed a request for packages` },
  { action: "workflow.email.read", text: msg`Read an email attachment` },
  {
    action: "workflow.email.attachment.sent",
    text: msg`Handed an email attachment to a run`,
  },
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
  { action: "statistics.read", text: msg`Read an App's statistics` },
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
