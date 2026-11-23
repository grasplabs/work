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
  {
    action: "chat.turn_noted",
    text: msg`Noted a question asked in a chat, to keep in its person's own Brain`,
  },
  {
    action: "chat.private_read",
    text: msg`Used something only its person can read, so what it writes for others waits for them`,
  },
  {
    action: "chat.app_call.confirmed",
    text: msg`Confirmed a write to an App`,
  },
  {
    action: "chat.app_call.ended",
    text: msg`Carried out a confirmed write to an App, or failed to`,
  },
  {
    action: "chat.app_call.lapsed",
    text: msg`Ended a held write to an App nobody confirmed within a day`,
  },
  {
    action: "chat.app_call.declined",
    text: msg`Declined a write to an App`,
  },
  {
    action: "chat.apps_deleted",
    text: msg`Deleted their conversations in chat apps`,
  },
  { action: "chat", text: msg`Changed a chat` },
  {
    action: "brain.source.handover_skipped",
    text: msg`Didn't keep something noted for the Brain, and recorded why`,
  },
  {
    action: "brain.capture.erased",
    text: msg`Erased what the Brain kept from a connection, as it was disconnected`,
  },
  {
    action: "brain.sync.applied",
    text: msg`Brought changes from a connected system into the Brain`,
  },
  {
    action: "brain.sync.erased",
    text: msg`Erased what the Brain copied from a connection, as it was disconnected`,
  },
  {
    action: "brain.run_sources.removed",
    text: msg`Stopped the Brain using someone's workflow results, as they lost the workflow`,
  },
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
  { action: "app.data.read", text: msg`Read records of a sensitive table` },
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
  { action: "app", text: msg`Changed an App` },
  { action: "session.ended", text: msg`Signed out a device` },
  { action: "organization.renamed", text: msg`Renamed the organization` },
  {
    action: "organization.logo.updated",
    text: msg`Changed the organization's logo`,
  },
  {
    action: "organization.logo.removed",
    text: msg`Removed the organization's logo`,
  },
  {
    action: "organization.time_zone.updated",
    text: msg`Changed the organization's time zone`,
  },
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
  { action: "member.guest_invited", text: msg`Invited a guest` },
  {
    action: "member.guest_code_sent",
    text: msg`Was sent a code to sign in as a guest`,
  },
  { action: "member.guest_signed_in", text: msg`Signed in as a guest` },
  { action: "member", text: msg`Changed a member` },
  { action: "team.created", text: msg`Created a team` },
  { action: "team.deleted", text: msg`Deleted a team` },
  { action: "team.member.added", text: msg`Added someone to a team` },
  { action: "team.member.removed", text: msg`Took someone off a team` },
  { action: "team", text: msg`Changed a team` },
  { action: "project.created", text: msg`Created a project` },
  { action: "project.updated", text: msg`Changed a project` },
  { action: "project.deleted", text: msg`Deleted a project` },
  {
    action: "project.item.filed",
    text: msg`Added an App or workflow to a project`,
  },
  {
    action: "project.item.unfiled",
    text: msg`Took an App or workflow out of a project`,
  },
  {
    action: "project.member.added",
    text: msg`Added a person or team to a project`,
  },
  {
    action: "project.member.removed",
    text: msg`Took a person or team out of a project`,
  },
  { action: "chat.filed", text: msg`Added a chat to a project` },
  { action: "chat.unfiled", text: msg`Took a chat out of a project` },
  {
    action: "workflow.decision",
    text: msg`A decision was put to people, or answered`,
  },
  { action: "dependency.requested", text: msg`Proposed packages` },
  { action: "dependency.approved", text: msg`Approved packages` },
  { action: "dependency.denied", text: msg`Denied packages` },
  { action: "dependency.built", text: msg`Built approved packages` },
  {
    action: "dependency.superseded",
    text: msg`Replaced a request for packages`,
  },
  { action: "dependency.revoked", text: msg`Revoked packages as malware` },
  {
    action: "dependency.advisory_found",
    text: msg`Found a new advisory against approved packages`,
  },
  {
    action: "dependency.approval_refused",
    text: msg`Was refused approving packages that couldn't be checked`,
  },
  {
    action: "dependency.malware_refused",
    text: msg`Was refused packages known as malware`,
  },
  { action: "dependency", text: msg`Changed a request for packages` },
  {
    action: "event_source.created",
    text: msg`Created a webhook source`,
  },
  {
    action: "event_source.secret_rotated",
    text: msg`Made a webhook source a new secret`,
  },
  {
    action: "event_source.secret_revoked",
    text: msg`Revoked a webhook source's secret`,
  },
  { action: "event_source.deleted", text: msg`Deleted a webhook source` },
  {
    action: "event_source.delivery.read",
    text: msg`Read the payload of a webhook event`,
  },
  {
    action: "event_source.test_sent",
    text: msg`Sent a webhook source a test event`,
  },
  {
    action: "workflow.webhook.refused",
    text: msg`Didn't start a workflow from a webhook event`,
  },
  {
    action: "workflow.webhook.wait_refused",
    text: msg`Didn't hand a webhook event to the run waiting for it`,
  },
  {
    action: "workflow.webhook.kept_expired",
    text: msg`Let webhook events no run waited for expire`,
  },
  {
    action: "workflow.webhook.kept_full",
    text: msg`Didn't keep a webhook event: its source keeps as many as it may`,
  },
  { action: "workflow.email.read", text: msg`Read an email attachment` },
  {
    action: "workflow.email.attachment.sent",
    text: msg`Handed an email attachment to a run`,
  },
  {
    action: "workflow.email.reply.received",
    text: msg`Took a reply to a run's email`,
  },
  {
    action: "workflow.email.reply.dropped",
    text: msg`Dropped a reply to a run's email`,
  },
  { action: "workflow.run.fix_asked", text: msg`Asked the agent to fix a run` },
  { action: "workflow.run", text: msg`Ran a workflow` },
  {
    action: "workflow.wake.repaired",
    text: msg`Woke a waiting run whose wake hadn't got through`,
  },
  { action: "workflow.step", text: msg`Ran a step of a workflow` },
  { action: "workflow.param", text: msg`Changed a workflow's parameter` },
  {
    action: "workflow.schedule",
    text: msg`Stopped a schedule that kept failing`,
  },
  { action: "workflow", text: msg`Changed a workflow` },
  { action: "ai_provider.added", text: msg`Added an AI provider's key` },
  { action: "ai_provider.replaced", text: msg`Replaced an AI provider's key` },
  { action: "ai_provider.removed", text: msg`Deleted an AI provider's key` },
  { action: "ai_provider.tested", text: msg`Tested an AI provider's key` },
  {
    action: "ai_provider.models_set",
    text: msg`Changed the default and fallback models`,
  },
  {
    action: "ai_provider.source_set",
    text: msg`Chose between Grasp's AI and the organization's own key`,
  },
  { action: "ai_provider", text: msg`Changed the AI providers` },
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
  { action: "brain.recall", text: msg`Recalled from the Brain` },
  {
    action: "brain.who_knows",
    text: msg`Asked the Brain who knows about something`,
  },
  { action: "brain.upload", text: msg`Uploaded a file into the Brain` },
  { action: "brain.upload.added", text: msg`Uploaded a file into the Brain` },
  {
    action: "brain.upload.refused",
    text: msg`Was refused an upload into the Brain, or its removal`,
  },
  { action: "brain.upload.failed", text: msg`An upload into the Brain failed` },
  {
    action: "brain.upload.deleted",
    text: msg`Erased an upload from the Brain for good`,
  },
  {
    action: "brain.upload.delete_failed",
    text: msg`Couldn't erase an upload from the Brain`,
  },
  {
    action: "brain.upload.listed",
    text: msg`Looked at the uploads shared with a team or everyone`,
  },
  // Each named exactly: a release installing skills is no read.
  { action: "brain.skills.select", text: msg`Read skills from the Brain` },
  { action: "brain.skills.read", text: msg`Read skills from the Brain` },
  // An App or a workflow reading entities: each named exactly.
  { action: "brain.entities.get", text: msg`Read entities from the Brain` },
  { action: "brain.entities.find", text: msg`Read entities from the Brain` },
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
  {
    action: "admin.brain.erasure.looked_up",
    text: msg`Looked up whether something was erased from the Brain`,
  },
  { action: "admin.brain.read", text: msg`Read the Brain's report` },
  { action: "admin.command", text: msg`Sent a change from Grasp's admin` },
  { action: "admin.kickoff.read", text: msg`Read the onboarding kickoff` },
  {
    action: "admin.snapshot.read",
    text: msg`Read a snapshot of the workspace`,
  },
  {
    action: "agent.adopted",
    text: msg`Took on an agent offered to the company`,
  },
  { action: "agent.app.changed", text: msg`Changed an App an agent may use` },
  {
    action: "agent.apps.worked_out",
    text: msg`Asked Grasp which Apps an agent needs`,
  },
  { action: "agent.changed", text: msg`Changed an agent` },
  {
    action: "agent.class.changed",
    text: msg`Changed for whom an agent has a kind of tool`,
  },
  {
    action: "agent.declined",
    text: msg`Declined an agent offered to the company`,
  },
  { action: "agent.deleted", text: msg`Deleted an agent` },
  { action: "agent.document.added", text: msg`Added a document to an agent` },
  {
    action: "agent.document.removed",
    text: msg`Removed a document from an agent`,
  },
  { action: "agent.made", text: msg`Made an agent` },
  {
    action: "agent.offered",
    text: msg`Offered an agent to the company, or took the offer back`,
  },
  { action: "agent.paused", text: msg`Paused or resumed an agent` },
  {
    action: "agent.reach.changed",
    text: msg`Turned an agent on or off, or changed who may reach it`,
  },
  { action: "agent.wake.deleted", text: msg`Deleted an agent's schedule` },
  { action: "agent.wake.made", text: msg`Set up a schedule for an agent` },
  {
    action: "agent.wake.paused",
    text: msg`Paused or resumed an agent's schedule`,
  },
  {
    action: "brain.connection_audience.changed",
    text: msg`Changed who reads what a shared connection brings into the Brain`,
  },
  {
    action: "brain.gap.answerer_erased",
    text: msg`Forgot an erased member as the one who answered the Brain's questions`,
  },
  {
    action: "brain.gap.asked",
    text: msg`Asked people to fill a gap in the Brain`,
  },
  {
    action: "brain.gap.redacted",
    text: msg`Took away an answer to the Brain's question`,
  },
  { action: "brain.records.added", text: msg`Added records to the Brain` },
  {
    action: "brain.records.forgotten",
    text: msg`Had the Brain forget a record`,
  },
  {
    action: "brain.shared_reads.erase_requested",
    text: msg`Asked to erase what the Brain kept from a shared connection`,
  },
  {
    action: "brain.shared_reads.erased",
    text: msg`Erased what the Brain kept from a shared connection`,
  },
  {
    action: "brain.skills.installed",
    text: msg`Installed Grasp's skills with a release`,
  },
  {
    action: "brain.source.handover_started",
    text: msg`Started handing something over to the Brain`,
  },
  {
    action: "brain.team_groups.arranged",
    text: msg`Arranged the company's groups of teams`,
  },
  {
    action: "brain.team_groups.saved",
    text: msg`Saved the company's groups of teams`,
  },
  {
    action: "brain.work.more_voices_asked",
    text: msg`Asked Stephen to hear more people about a piece of work`,
  },
  { action: "channel_account.linked", text: msg`Linked a chat app account` },
  {
    action: "channel_account.unlinked",
    text: msg`Unlinked a chat app account`,
  },
  {
    action: "directory.group_mapped",
    text: msg`Matched a directory group to a team`,
  },
  {
    action: "directory.group_unmapped",
    text: msg`Stopped matching a directory group to a team`,
  },
  { action: "file.downloaded", text: msg`Downloaded a file` },
  { action: "file.previewed", text: msg`Previewed a file` },
  { action: "file.sent_to_run", text: msg`Handed a file to a run` },
  { action: "instructions.saved", text: msg`Saved instructions` },
  {
    action: "onboarding.directory_read",
    text: msg`Read the directory for the onboarding`,
  },
  {
    action: "onboarding.document_fetched",
    text: msg`Shared a document for the onboarding`,
  },
  { action: "onboarding.gate.closed", text: msg`Closed Grasp to the company` },
  {
    action: "onboarding.gate.opened",
    text: msg`Opened Grasp to the whole company`,
  },
  {
    action: "onboarding.gate.threshold_set",
    text: msg`Set how much Grasp must know before it opens to the company`,
  },
  {
    action: "onboarding.hr_read",
    text: msg`Read the HR system for the onboarding`,
  },
  {
    action: "onboarding.staff_access.ended",
    text: msg`Ended Grasp staff's access`,
  },
  { action: "opportunity.dismissed", text: msg`Dismissed an opportunity` },
  {
    action: "opportunity.restored",
    text: msg`Brought back a dismissed opportunity`,
  },
  {
    action: "staff.accessed",
    text: msg`Viewed something as Grasp staff`,
  },
  {
    action: "stephen.place.changed",
    text: msg`Changed who reaches Stephen in a place`,
  },
  {
    action: "stephen.reach.changed",
    text: msg`Turned Stephen on or off, or changed who may reach him`,
  },
  { action: "store.created", text: msg`Created a data store` },
  { action: "store.deleted", text: msg`Deleted a data store` },
  { action: "version.published", text: msg`Published a version` },
  { action: "version.rolled_back", text: msg`Went back to an earlier version` },
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
