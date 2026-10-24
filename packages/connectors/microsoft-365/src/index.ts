import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { draftTools } from "./drafts.ts";
import { fileTools } from "./files.ts";
import { graphHost } from "./graph.ts";
import { listTools } from "./lists.ts";
import { mailReplyTools } from "./mail-replies.ts";
import { mailSortingTools } from "./mail-sorting.ts";
import { mailTools } from "./mail.ts";
import { todoTools } from "./todo.ts";
import { workbookTools } from "./workbook.ts";

/**
 * Native Microsoft 365 connector, on Microsoft Graph: mail and calendars
 * of one mailbox per call, a person's own Microsoft To Do, files in
 * OneDrive and SharePoint, one drive
 * per call, drafts in the person's own OneDrive, SharePoint lists, one
 * site per call, and the rows of a named table in an Excel workbook, one
 * workbook per call.
 */
export default defineConnector({
  name: "microsoft-365",
  version: "0.3.0",
  provider: "microsoft",
  // The most any class asks for: connect asks only the rights of the
  // classes a company turned on (apps/connect/src/provider-rights.ts).
  scopes: [
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    // The categories a person has, so mail.categorise sets only those.
    "MailboxSettings.Read",
    "Calendars.ReadWrite",
    "Calendars.Read.Shared",
    // Changing a workbook's rows: in the person's own files, and in those
    // SharePoint lets them change; and drafts in the person's own OneDrive
    // (files.createDraft, under /me/drive).
    "Files.ReadWrite.All",
    "Sites.ReadWrite.All",
    "Tasks.ReadWrite",
  ],
  hosts: [graphHost],
  tools: [
    ...mailTools,
    ...mailReplyTools,
    ...mailSortingTools,
    ...calendarTools,
    ...fileTools,
    ...draftTools,
    ...listTools,
    ...workbookTools,
    ...todoTools,
  ],
});
