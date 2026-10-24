import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { draftTools } from "./drafts.ts";
import { driveTools } from "./drive.ts";
import { gmailTools } from "./gmail.ts";
import { apisHost, gmailHost } from "./google.ts";

/**
 * Native Google Workspace connector, on Google's APIs: Gmail of one
 * mailbox, one calendar, and the files of one shared drive, per call, and
 * drafts in the person's own Drive.
 *
 * Scopes, the least the tools need: `gmail.modify` (read, label, draft
 * and send; applying labels to a message needs it, and it can't delete
 * for good), `calendar.events` (events only, not calendar settings or
 * sharing; it writes, and calendar.ts holds writes to the person's own
 * calendar), `calendar.calendarlist.readonly` (which calendar is their
 * own), `drive.readonly` (reading a file's content needs it) and
 * `drive.file` (drafts: only the files this app made).
 */
export default defineConnector({
  name: "google-workspace",
  version: "0.4.0",
  provider: "google",
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ],
  hosts: [gmailHost, apisHost],
  tools: [...gmailTools, ...calendarTools, ...driveTools, ...draftTools],
});
