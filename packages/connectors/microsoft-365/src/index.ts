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
  scopes: [
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "Calendars.Read",
    "Calendars.ReadWrite",
    "Calendars.Read.Shared",
    "Files.Read.All",
    // Changing a workbook's rows: in the person's own files, and in those
    // SharePoint lets them change.
    "Files.ReadWrite.All",
    "Sites.Read.All",
  ],
  hosts: [graphHost],
  tools: [...mailTools, ...calendarTools, ...fileTools, ...workbookTools],
});
