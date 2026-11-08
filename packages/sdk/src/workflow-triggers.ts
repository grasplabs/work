import { triggerDeclarationsSchema } from "@grasp-os/shared/workflows";

import { parseOrThrow, WorkflowError } from "./workflow-error.ts";
import type { Params } from "./workflow-params.ts";

/**
 * What starts a run, besides a person starting it by hand. Triggers only
 * ever start workflows: pages can't declare them. They take effect when
 * the App's version is made current, and stop when another version that
 * doesn't declare them is. A run a trigger starts acts for the App's
 * owner, and fails if the owner has left the organization.
 *
 * ```ts
 * workflow("weekly-report", {
 *   params: { every: schedule({ label: "Runs", default: "0 8 * * 1" }) },
 *   triggers: [{ type: "schedule", param: "every", timeZone: "Europe/Amsterdam" }],
 * }, async (step) => ...);
 * ```
 */
export type Trigger<ScheduleParam extends string = string> =
  | { type: "manual" }
  /**
   * On the schedule a schedule parameter holds, so people can change when
   * it runs without changing the code. Its cron expression is read in
   * `timeZone` (an IANA name, e.g. `Europe/Amsterdam`; UTC when missing),
   * so `0 8 * * 1` is 8:00 on Mondays there, summer time or not. A time
   * the change to summer time skips runs an hour later (2:30 at 3:30); in
   * the hour the change back repeats, times run once, in its first pass. A
   * scheduled run starts with no input. A time missed (an outage, say)
   * starts one run late, however many times were
   * missed; a schedule set or made current starts from the next time
   * after, never one already past.
   */
  | { type: "schedule"; param: ScheduleParam; timeZone?: string }
  /**
   * When a connection reports an event of this type, e.g.
   * `m365.mail.received`, and only what the App could read: through a
   * permission on the connection (or on the part of it the event is
   * about) that allows the read action the event names, e.g. `mail.list`;
   * from someone's personal connection, only if the
   * App's owner is that person. `filter` narrows it: each field it names must hold
   * that value at the top of the event's payload, e.g.
   * `{ folder: "inbox" }`. The run starts with the event as input: declare
   * `input: connectorEvent`. The same event delivered again starts no
   * second run. Events start at most 60 runs of a workflow an hour; past
   * that they wait, and start their runs later.
   *
   * Microsoft 365 connections report, within about a minute:
   * - `m365.mail.received` (read action `mail.list`): mail arriving in a
   *   mailbox's inbox. Its payload: `mailbox`, `id`, `folder` (`"inbox"`),
   *   `subject`, `from` (`{ name, address }`), `receivedAt`,
   *   `hasAttachments`, `conversationId`, `internetMessageId`, `webLink`.
   * - `m365.file.created` (read action `files.list`): a file created in a
   *   drive, in any folder. Its payload: `drive`, `id`, `name`,
   *   `mimeType`, `size`, `folderId`, `createdAt`, `webUrl`.
   *
   * Google Workspace connections report, within about a minute:
   * - `google.mail.received` (read action `mail.list`): mail arriving in a
   *   mailbox's inbox. Its payload: `mailbox`, `id`, `threadId`, `folder`
   *   (`"inbox"`), `subject`, `from` (`{ name, address }`), `receivedAt`.
   *   Only mail as it arrives: unlike `m365.mail.received`, a message
   *   moved into the inbox later isn't reported.
   * - `google.file.created` (read action `files.list`): a file created in
   *   a shared drive, in any folder. Its payload as `m365.file.created`'s.
   *
   * Through a permission on one mailbox or drive, the event is of that
   * one (its `resource`); through one on the whole connection, of the
   * account's own mailbox or OneDrive (a Google connection reports no
   * file events for a permission on the whole connection: a person's My
   * Drive isn't a shared drive). Only what arrives once both the
   * trigger and the permission are in place is reported, from about a
   * minute after. A mail's sender and subject are whatever
   * its sender wrote: treat the payload as untrusted data.
   */
  | {
      type: "event";
      event: string;
      filter?: Record<string, string | number | boolean | null>;
    }
  /**
   * When mail arrives at `address` (the part before the `@`, e.g.
   * `invoices`) on the deployment's mail domain. The run starts with the
   * message as input: declare `input: emailMessage`. Mail to an address no
   * workflow receives at bounces. Only one workflow receives at an address:
   * making a version current fails with `workflow.email_taken` while
   * another App's current version, or an independent workflow's email
   * trigger, does. Anyone can send mail: treat the
   * message as untrusted data, its sender (`from`) included: it's
   * whatever the sender wrote, and nothing vouches for it. The same message delivered again starts no second run of
   * the workflow: the same Message-ID is the same message (without one,
   * or with one lacking an `@` such as `<>`, the same bytes are), so a
   * message that reuses an earlier one's Message-ID starts none. Mail
   * starts at most 60 runs of a workflow an hour. Past that, mail is
   * refused for now, and its sender tries again later.
   */
  | { type: "email"; address: string };

export type ScheduleParams<P extends Params> = {
  [Name in keyof P]: P[Name]["kind"] extends "schedule" ? Name : never;
}[keyof P] &
  string;

export const validateTriggers = (params: Params, triggers: Trigger[]): void => {
  parseOrThrow(
    triggerDeclarationsSchema,
    triggers,
    "workflow.invalid_definition",
    "Triggers"
  );
  for (const trigger of triggers) {
    if (
      trigger.type === "schedule" &&
      params[trigger.param]?.kind !== "schedule"
    ) {
      throw new WorkflowError(
        "workflow.invalid_definition",
        `Schedule trigger: "${trigger.param}" isn't a schedule parameter`
      );
    }
  }
};
