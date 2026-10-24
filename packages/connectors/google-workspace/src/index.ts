import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { driveTools } from "./drive.ts";
import { gmailTools } from "./gmail.ts";
import { apisHost, gmailHost, sheetsHost } from "./google.ts";
import { sheetsTools } from "./sheets.ts";

/**
 * Native Google Workspace connector, on Google's APIs: Gmail of one
 * mailbox, one calendar, and the files and spreadsheets of one shared
 * drive, per call.
 *
 * Scopes, the least the tools need: `gmail.modify` (read, label, draft
 * and send; applying labels to a message needs it, and it can't delete
 * for good), `calendar.events.readonly` (events only, not calendar
 * settings or sharing) and `drive.readonly` (reading a file's content
 * needs it, and Sheets takes it to read a spreadsheet's cells).
 */
export default defineConnector({
  name: "google-workspace",
  version: "0.3.0",
  provider: "google",
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  hosts: [gmailHost, apisHost, sheetsHost],
  tools: [...gmailTools, ...calendarTools, ...driveTools, ...sheetsTools],
});
