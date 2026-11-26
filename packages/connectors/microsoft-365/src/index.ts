import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarSync } from "./calendar-sync.ts";
import { calendarTools } from "./calendar.ts";
import { chatTools } from "./chats.ts";
import { draftTools } from "./drafts.ts";
import { fileTools } from "./files.ts";
import { graphBase, graphHost } from "./graph-sdk.ts";
import { librarySync } from "./library-sync.ts";
import { listTools } from "./lists.ts";
import { mailReplyTools } from "./mail-replies.ts";
import { mailSortingTools } from "./mail-sorting.ts";
import { mailSync } from "./mail-sync.ts";
import { mailTools } from "./mail.ts";
import { meetingTools } from "./meetings.ts";
import { onedriveSync } from "./onedrive-sync.ts";
import { onenoteTools } from "./onenote.ts";
import { plannerTools } from "./planner.ts";
import { todoTools } from "./todo.ts";
import { workbookTools } from "./workbook.ts";

/**
 * Native Microsoft 365 connector, on Microsoft Graph: mail and calendars
 * of one mailbox per call, a person's own Microsoft To Do and OneNote,
 * files and Word documents' text in OneDrive and SharePoint, one drive per
 * call, drafts in the person's own OneDrive, SharePoint lists' items, one
 * site per call, a Planner plan's tasks, one plan per call, and the rows
 * of a named table in an Excel workbook, one workbook per call, and the
 * person's own Teams chats and the transcripts of meetings they were in.
 *
 * It syncs the person's own OneDrive for the Brain (onedrive-sync.ts), on
 * `Files.ReadWrite.All`, which covers the sync's reads (driveItem delta,
 * permissions and content all take `Files.Read`), their own mailbox
 * (mail-sync.ts), on `Mail.ReadWrite`, which covers listing messages, their
 * attachments and folders (`Mail.Read` at least), and their own calendar
 * (calendar-sync.ts), on `Calendars.ReadWrite`, which covers calendarView
 * delta (`Calendars.Read`). On a shared connection it syncs the SharePoint
 * document libraries an admin picked (library-sync.ts), on
 * `Sites.ReadWrite.All` for finding sites (`Sites.Read.All` at least) and
 * `Files.ReadWrite.All` for a library's drive, delta and content.
 */
export default defineConnector({
  name: "microsoft-365",
  provider: "microsoft",
  // The most any class asks for: connect asks only the rights of the
  // classes a company turned on (apps/connect/src/provider-rights.ts).
  scopes: [
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    // The categories a person has, so me.messages.update sets only those.
    "MailboxSettings.Read",
    "Calendars.ReadWrite",
    "Calendars.Read.Shared",
    // Changing a workbook's rows: in the person's own files, and in those
    // SharePoint lets them change; and drafts in the person's own OneDrive
    // (me.drive.root.content.upload, under /me/drive).
    "Files.ReadWrite.All",
    "Sites.ReadWrite.All",
    // A person's own To Do, and the Planner plans of their groups.
    "Tasks.ReadWrite",
    "Notes.ReadWrite",
    // Read others' words: the person's own Teams chats, and the
    // transcripts of the meetings they were in.
    "Chat.Read",
    "OnlineMeetings.Read",
    "OnlineMeetingTranscript.Read.All",
  ],
  hosts: [graphHost],
  tools: [
    // The mail tools, written on @grasp-os/sdk/connector.
    ...Object.entries({
      ...mailTools,
      ...mailReplyTools,
      ...mailSortingTools,
    }).map(([name, each]) =>
      each.serve(name, {
        title: "Microsoft 365",
        hosts: [graphHost],
        base: graphBase,
      })
    ),
    // The calendar, meeting and chat tools, written on
    // @grasp-os/sdk/connector.
    ...Object.entries({
      ...calendarTools,
      ...meetingTools,
      ...chatTools,
    }).map(([name, each]) =>
      each.serve(name, {
        title: "Microsoft 365",
        hosts: [graphHost],
        base: graphBase,
      })
    ),
    // The file tools, written on @grasp-os/sdk/connector.
    ...Object.entries({ ...fileTools, ...draftTools }).map(([name, each]) =>
      each.serve(name, {
        title: "Microsoft 365",
        hosts: [graphHost],
        base: graphBase,
      })
    ),
    // SharePoint lists and Excel tables, written on @grasp-os/sdk/connector.
    ...Object.entries({ ...listTools, ...workbookTools }).map(([name, each]) =>
      each.serve(name, {
        title: "Microsoft 365",
        hosts: [graphHost],
        base: graphBase,
      })
    ),
    // Written on @grasp-os/sdk/connector, served beside the kit's tools
    // until every family is.
    ...Object.entries(todoTools).map(([name, each]) =>
      each.serve(name, {
        title: "Microsoft 365",
        hosts: [graphHost],
        base: graphBase,
      })
    ),
    // Planner and OneNote, written on @grasp-os/sdk/connector.
    ...Object.entries({ ...plannerTools, ...onenoteTools }).map(
      ([name, each]) =>
        each.serve(name, {
          title: "Microsoft 365",
          hosts: [graphHost],
          base: graphBase,
        })
    ),
  ],
  syncs: [onedriveSync, mailSync, calendarSync, librarySync],
});
