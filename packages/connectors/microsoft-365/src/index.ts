import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { draftTools } from "./drafts.ts";
import { fileTools } from "./files.ts";
import { graphHost } from "./graph.ts";
import { mailTools } from "./mail.ts";

/**
 * Native Microsoft 365 connector, on Microsoft Graph: mail and calendars
 * of one mailbox per call, files in OneDrive and SharePoint, one drive
 * per call, and drafts in the person's own OneDrive.
 */
export default defineConnector({
  name: "microsoft-365",
  version: "0.2.0",
  provider: "microsoft",
  scopes: [
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "Calendars.Read",
    "Calendars.Read.Shared",
    "Files.Read.All",
    // Drafts in the person's own OneDrive only: files.createDraft writes
    // under /me/drive, and no other tool writes a file.
    "Files.ReadWrite.All",
    "Sites.Read.All",
  ],
  hosts: [graphHost],
  tools: [...mailTools, ...calendarTools, ...fileTools, ...draftTools],
});
