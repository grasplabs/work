import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { fileTools } from "./files.ts";
import { graphHost } from "./graph.ts";
import { mailTools } from "./mail.ts";
import { workbookTools } from "./workbook.ts";

/**
 * Native Microsoft 365 connector, on Microsoft Graph: mail and calendars
 * of one mailbox per call, files in OneDrive and SharePoint, one drive
 * per call, and the rows of a named table in an Excel workbook, one
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
    "Mail.Send",
    "Calendars.ReadWrite",
    "Calendars.Read.Shared",
    "Files.ReadWrite.All",
    "Sites.ReadWrite.All",
  ],
  hosts: [graphHost],
  tools: [...mailTools, ...calendarTools, ...fileTools, ...workbookTools],
});
