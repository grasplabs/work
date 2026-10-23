import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { fileTools } from "./files.ts";
import { graphHost } from "./graph.ts";
import { mailTools } from "./mail.ts";
import { todoTools } from "./todo.ts";

/**
 * Native Microsoft 365 connector, on Microsoft Graph: mail and calendars
 * of one mailbox per call, a person's own Microsoft To Do, and files in
 * OneDrive and SharePoint, one drive per call.
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
    "Sites.Read.All",
    "Tasks.ReadWrite",
  ],
  hosts: [graphHost],
  tools: [...mailTools, ...calendarTools, ...fileTools, ...todoTools],
});
