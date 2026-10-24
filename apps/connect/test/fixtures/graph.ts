/**
 * Microsoft Graph's answers, in the shapes its v1.0 reference documents
 * (OData context, etags, `@odata.nextLink` naming the user its own way),
 * with example.com addresses, made-up names and IDs of the forms Graph
 * gives them (message IDs in Outlook's URL-safe base64, drive IDs with
 * their `b!` prefix). The fake Graph (test/graph-api.ts) serves them per mailbox and drive,
 * so a test can tell whose data an answer holds.
 */

export const graphOrigin = "https://graph.microsoft.com";

/** The tenant's SharePoint, where Graph redirects downloads. */
export const sharePointHost = "example.sharepoint.com";

/** A shared mailbox the tests' Apps use. */
export const invoices = "invoices@example.com";

/** Another mailbox of the same tenant. */
export const ceo = "ceo@example.com";

/** A SharePoint document library. */
export const financeDrive =
  "b!kR3pQ9xLmUe2Vt7Wj4hYc1s0nAoBdFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLm";

/** Another drive: someone's OneDrive. */
export const personalDrive =
  "b!zY9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fEdCbA9zY8xW7vU6tS5rQ4pO3nM2lK1jI0";

const local = (mailbox: string): string =>
  (mailbox.split("@")[0] ?? mailbox).replaceAll(/[^A-Za-z]/gu, "");

/** A message ID of `mailbox`, as Graph shapes them. */
export const messageId = (mailbox: string, n: number): string =>
  `AAMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwBGAAAAAAD${local(mailbox)}BwBmtXf2uSv0SqAGJ5k6N7QDAAAAAAEMAAA${n}=`;

/** The ID a message gets once it's moved. */
export const movedId = (mailbox: string, n: number): string =>
  `${messageId(mailbox, n).slice(0, -1)}Mvd=`;

export const eventId = (mailbox: string, n: number): string =>
  `AAMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwBGAAAAAAD${local(mailbox)}BwBmtXf2uSv0SqAGJ5k6N7QDAAAAAAENAAA${n}=`;

export const pdfAttachmentId =
  "AAMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwBGAAAAAADBwBmtXf2uSv0SqAGJ5k6N7QDAAAAAAEMAAABEgAQAKqz9bB4Rl5Fh5T0S2CKW0Y=";

export const itemAttachmentId =
  "AAMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwBGAAAAAADBwBmtXf2uSv0SqAGJ5k6N7QDAAAAAAEMAAABEgAQAC7hXqL0nUFJpUe2FCTbPtY=";

export const bigAttachmentId =
  "AAMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwBGAAAAAADBwBmtXf2uSv0SqAGJ5k6N7QDAAAAAAEMAAABEgAQAMu0Rz2uI2hEm1LpHkQyVxg=";

/**
 * The invoice PDF attached to the first message, as bytes: binary after
 * its header line, as PDFs are, so not UTF-8.
 */
export const invoicePdf = new Uint8Array([
  ...new TextEncoder().encode("%PDF-1.7\n%"),
  0xe2,
  0xe3,
  0xcf,
  0xd3,
  ...new TextEncoder().encode(
    "\n1 0 obj << /Type /Catalog >> endobj\n% Invoice 2026-0042\n%%EOF\n"
  ),
]);

/** Base64 of `bytes`, as the fixtures and tests spell it out. */
export const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes));

export const pdfBase64 = base64(invoicePdf);

const address = (name: string, mailbox: string) => ({
  emailAddress: { name, address: mailbox },
});

/** The number of the one message a person flagged. */
export const flaggedMessage = 3;

/** One message of `mailbox`, as a list returns it (`$select`ed fields). */
export const messageSummary = (mailbox: string, n: number) => ({
  "@odata.etag": 'W/"CQAAABYAAABmtXf2uSv0SqAGJ5k6N7QDAAAm7mc9"',
  id: messageId(mailbox, n),
  subject: `Invoice 2026-004${n} from Northwind Supplies`,
  bodyPreview: `Dear customer, please find attached invoice 2026-004${n} for EUR 1,250.00, due in 30 days.`,
  from: address("Northwind Billing", "billing@northwind.example.org"),
  toRecipients: [address("Invoices", mailbox)],
  ccRecipients: [],
  receivedDateTime: `2026-09-2${5 - n}T08:1${n}:00Z`,
  sentDateTime: `2026-09-2${5 - n}T08:0${n}:58Z`,
  isRead: n > 1,
  isDraft: false,
  hasAttachments: n === 1,
  importance: "normal",
  flag: { flagStatus: n === flaggedMessage ? "flagged" : "notFlagged" },
  parentFolderId:
    "AQMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAuAAADZ2zAAAA=",
  conversationId: `AAQkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAQAC${n}Ym9A=`,
  internetMessageId: `<AM0PR07MB44${n}1.eurprd07.prod.outlook.com>`,
  webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(messageId(mailbox, n))}&exvsurl=1&viewmodel=ReadMessageItem`,
});

/**
 * A page of `mailbox`'s messages: two per page, three in all; or the
 * flagged ones only, when `flaggedOnly`.
 */
export const messagePage = (
  mailbox: string,
  skip: number,
  flaggedOnly = false
) => {
  if (flaggedOnly) {
    return {
      "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#users('${encodeURIComponent(mailbox)}')/messages(id,subject,bodyPreview)`,
      value: [messageSummary(mailbox, flaggedMessage)],
    };
  }
  const numbers = skip === 0 ? [1, 2] : [3];
  return {
    "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#users('${encodeURIComponent(mailbox)}')/messages(id,subject,bodyPreview)`,
    value: numbers.map((n) => messageSummary(mailbox, n)),
    ...(skip === 0
      ? {
          // Graph names the user its own way here, and repeats the query.
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/users('${encodeURIComponent(mailbox)}')/messages?%24select=id%2csubject%2cbodyPreview&%24top=2&%24orderby=receivedDateTime+desc&%24skip=2`,
        }
      : {}),
  };
};

/**
 * A conversation of three messages: Northwind asks, the mailbox answers
 * from its Sent Items, and Northwind asks again, unanswered. Base64, with
 * a `+` and a `/` as Graph's conversation IDs can have.
 */
export const threadConversationId =
  "AAQkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAQAD+Th/9A=";

/** A conversation of `longThreadLength` messages, one of them long. */
export const longConversationId =
  "AAQkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAQADLongTh9A=";

export const longThreadLength = 30;

/** The text of the newest message of the long conversation. */
// An emoji's two halves sit across the 8,000th character, where its body is cut.
export const longBody = `${"Line of the contract under review.\r\n".repeat(222)}Total: 🧾\r\n${"Line of the contract under review.\r\n".repeat(78)}End.`;

/** Sent Items' ID. */
const sentItemsId =
  "AQMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAuAAADSentAAA=";

const northwind = address("Northwind Billing", "billing@northwind.example.org");

/** Message `n` (1 the oldest) of a conversation, with its own text. */
const threadMessage = (
  mailbox: string,
  conversation: string,
  n: number,
  length: number
) => {
  const fromMailbox = conversation === threadConversationId && n === 2;
  const text =
    conversation === longConversationId && n === length
      ? longBody
      : `Message ${n} of the conversation about invoice 2026-0041.`;
  const at = new Date(Date.UTC(2026, 8, 1, 8, n)).toISOString();
  return {
    "@odata.etag": 'W/"CQAAABYAAABmtXf2uSv0SqAGJ5k6N7QDAAAm7mc9"',
    id: messageId(mailbox, 100 + n),
    subject: `${n === 1 ? "" : "RE: "}Invoice 2026-0041 from Northwind Supplies`,
    bodyPreview: text.slice(0, 255),
    uniqueBody: { contentType: "text", content: text },
    from: fromMailbox ? address("Invoices", mailbox) : northwind,
    toRecipients: [fromMailbox ? northwind : address("Invoices", mailbox)],
    ccRecipients: [],
    receivedDateTime: at,
    sentDateTime: at,
    isRead: n < length,
    isDraft: false,
    hasAttachments: false,
    importance: "normal",
    flag: { flagStatus: "notFlagged" },
    parentFolderId: fromMailbox
      ? sentItemsId
      : "AQMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAuAAADZ2zAAAA=",
    conversationId: conversation,
    internetMessageId: `<AM0PR07MB7${n}.eurprd07.prod.outlook.com>`,
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(messageId(mailbox, 100 + n))}&exvsurl=1&viewmodel=ReadMessageItem`,
  };
};

/**
 * The first page of a conversation's messages in `mailbox`, newest first,
 * `top` of them, as Graph answers a `conversationId` filter: none for a
 * conversation it doesn't know.
 */
export const conversationPage = (
  mailbox: string,
  conversation: string,
  top: number
) => {
  const length = {
    [threadConversationId]: 3,
    [longConversationId]: longThreadLength,
  }[conversation];
  const numbers = Array.from({ length: length ?? 0 }, (_, at) => at + 1);
  const newest = numbers.toReversed().slice(0, top);
  return {
    "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#users('${encodeURIComponent(mailbox)}')/messages`,
    value: newest.map((n) =>
      threadMessage(mailbox, conversation, n, length ?? 0)
    ),
    ...(numbers.length > top
      ? {
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/users('${encodeURIComponent(mailbox)}')/messages?%24top=${top}&%24skip=${top}`,
        }
      : {}),
  };
};

/** One message, as `GET /messages/{id}` returns it. */
export const message = (mailbox: string, n: number, bodyType: string) => ({
  "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#users('${encodeURIComponent(mailbox)}')/messages/$entity`,
  ...messageSummary(mailbox, n),
  body:
    bodyType === "html"
      ? {
          contentType: "html",
          content:
            "<html><body><p>Dear customer,</p><p>Please find attached invoice 2026-0041.</p></body></html>",
        }
      : {
          contentType: "text",
          content:
            "Dear customer,\r\n\r\nPlease find attached invoice 2026-0041 for EUR 1,250.00.\r\n",
        },
  bccRecipients: [],
  // Message 2 asks replies to go to another address, and copied someone.
  ...(n === 2
    ? {
        ccRecipients: [address("Controller", "controller@example.com")],
        replyTo: [
          address("Northwind Accounts", "accounts@northwind.example.org"),
        ],
      }
    : {
        replyTo: [
          address("Northwind Billing", "billing@northwind.example.org"),
        ],
      }),
});

/** A message's attachments, without their content (`$select`ed). */
export const attachments = {
  "@odata.context":
    "https://graph.microsoft.com/v1.0/$metadata#users('invoices%40example.com')/messages('...')/attachments(id,name,contentType,size,isInline)",
  value: [
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      "@odata.mediaContentType": "application/pdf",
      id: pdfAttachmentId,
      name: "Invoice-2026-0041.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      isInline: false,
    },
    {
      "@odata.type": "#microsoft.graph.itemAttachment",
      id: itemAttachmentId,
      name: "Order confirmation",
      contentType: null,
      size: 18_342,
      isInline: false,
    },
  ],
};

/** Where the second page of a message's attachments starts. */
export const attachmentsSkipToken = "a7e3c1d9-2f4b-4c8e-9d6a-1b5f3e7c2a90";

/** The number of the message whose attachment list never ends. */
export const endlessAttachments = 9;

/**
 * A page of message `n`'s attachments: one per page, two in all, or a next
 * page every time for `endlessAttachments`. Graph's next link names the
 * user its own way and repeats the query.
 */
export const attachmentPage = (
  mailbox: string,
  n: number,
  skipToken: string | null
) => {
  const last = skipToken !== null && n !== endlessAttachments;
  return {
    "@odata.context": attachments["@odata.context"],
    value: [attachments.value[skipToken === null ? 0 : 1]],
    ...(last
      ? {}
      : {
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/users('${encodeURIComponent(mailbox)}')/messages('${messageId(mailbox, n)}')/attachments?%24select=id%2cname%2ccontentType%2csize%2cisInline&%24skiptoken=${attachmentsSkipToken}`,
        }),
  };
};

/** One attachment, with its content unless `bare`. */
export const attachment = (id: string, bare: boolean) => {
  if (id === itemAttachmentId) {
    return attachments.value[1];
  }
  if (id === bigAttachmentId) {
    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id,
      name: "Scans-September.zip",
      contentType: "application/zip",
      size: 9 * 1024 * 1024,
      isInline: false,
    };
  }
  return {
    ...attachments.value[0],
    ...(bare ? {} : { contentBytes: pdfBase64 }),
  };
};

/** The Archive folder's ID. */
export const archiveFolderId =
  "AQMkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAuAAADArchive=";

/** A folder of another mailbox: its ID means nothing in this one. */
export const foreignFolderId =
  "AQMkADCeoMailboxFolderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** `GET /mailFolders/{id}`: the Archive folder by name or ID, else none. */
export const mailFolder = (id: string) =>
  id === "archive" || id === archiveFolderId
    ? {
        "@odata.context":
          "https://graph.microsoft.com/v1.0/$metadata#users('invoices%40example.com')/mailFolders(id)/$entity",
        id: archiveFolderId,
      }
    : undefined;

/** What `POST /messages/{id}/move` returns: the message, with a new ID. */
export const moved = (mailbox: string, n: number) => ({
  ...messageSummary(mailbox, n),
  id: movedId(mailbox, n),
  parentFolderId: archiveFolderId,
});

/** What `POST /messages` returns for a new draft. */
export const draft = (mailbox: string, subject: string) => ({
  "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#users('${encodeURIComponent(mailbox)}')/messages/$entity`,
  id: messageId(mailbox, 9),
  subject,
  isDraft: true,
  conversationId:
    "AAQkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAQADraft9A=",
  webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(messageId(mailbox, 9))}&exvsurl=1&viewmodel=ReadMessageItem`,
});

/**
 * What `POST /messages/{id}/createReply` returns: a draft in the
 * conversation of message `n`.
 */
export const replyDraft = (mailbox: string, n: number, subject: string) => ({
  ...draft(mailbox, subject),
  id: messageId(mailbox, 8),
  conversationId: messageSummary(mailbox, n).conversationId,
  webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(messageId(mailbox, 8))}&exvsurl=1&viewmodel=ReadMessageItem`,
});

const utc = (dateTime: string) => ({ dateTime, timeZone: "UTC" });

export const event = (mailbox: string, n: number) => ({
  "@odata.etag": 'W/"ZlnW4RIAV06KYYwlrfNZvQAAKGWwbw=="',
  id: eventId(mailbox, n),
  subject: n === 1 ? "Month-end close" : "Supplier review: Northwind",
  bodyPreview:
    n === 1 ? "Agenda: open invoices, accruals." : "Quarterly review of terms.",
  start: utc(`2026-09-${28 + n}T09:00:00.0000000`),
  end: utc(`2026-09-${28 + n}T10:00:00.0000000`),
  isAllDay: false,
  isCancelled: false,
  showAs: "busy",
  location: { displayName: "Room 4.12", locationType: "default" },
  // The second is the CEO's, who hides its guest list from those invited.
  organizer:
    n === 1
      ? { emailAddress: { name: "Finance Team", address: mailbox } }
      : { emailAddress: { name: "CEO", address: ceo } },
  isOrganizer: n === 1,
  webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(eventId(mailbox, n))}&exvsurl=1&path=/calendar/item`,
});

/** A page of `calendarView`: one event per page, two in all. */
export const eventPage = (mailbox: string, skipToken: string | null) => ({
  "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#users('${encodeURIComponent(mailbox)}')/calendarView`,
  value: [event(mailbox, skipToken === null ? 1 : 2)],
  ...(skipToken === null
    ? {
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/users('${encodeURIComponent(mailbox)}')/calendarView?startDateTime=2026-09-28T00%3a00%3a00Z&endDateTime=2026-10-05T00%3a00%3a00Z&%24top=1&%24skiptoken=d2c7f1a0-5b9e-4d1c-8e6a-3f2b7c9d0e1f`,
      }
    : {}),
});

export const eventDetail = (mailbox: string, n: number) => ({
  ...event(mailbox, n),
  body: {
    contentType: "text",
    content: "Agenda: open invoices, accruals, sign-off.\r\n",
  },
  ...(n === 1
    ? {
        attendees: [
          {
            type: "required",
            status: { response: "accepted", time: "2026-09-20T10:00:00Z" },
            emailAddress: {
              name: "Controller",
              address: "controller@example.com",
            },
          },
        ],
      }
    : { hideAttendees: true, attendees: [] }),
  onlineMeeting: {
    joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_example",
  },
});

/** Items of `drive`, by ID. */
export const itemIds = {
  folder: "01BYE5RZ4QUXM4F2PGNRFK2AYDCUNXNAPW",
  report: "01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K",
  pdf: "01BYE5RZ2WXWVTTDSHABB3ERCYHAMZHC4X",
  big: "01BYE5RZ7JQFO4YRKMZDB2EHCPA6MUHF3J",
  /** Its download redirects to a host that isn't SharePoint. */
  elsewhere: "01BYE5RZ3ELSEWHEREAAAAAAAAAAAAAAAA",
  /** Its download redirects over plain HTTP. */
  plain: "01BYE5RZ3PLAINHTTPAAAAAAAAAAAAAAAA",
  /** Its download redirects to a host two labels under sharepoint.com. */
  nested: "01BYE5RZ3NESTEDHOSTAAAAAAAAAAAAAAA",
  /** Its download redirects, and SharePoint redirects again. */
  twice: "01BYE5RZ3TWICEAAAAAAAAAAAAAAAAAAAA",
  /** A text file of control characters, much longer once escaped. */
  controls: "01BYE5RZ5CONTROLSAAAAAAAAAAAAAAAAA",
  /** Shared into search results from another drive. */
  foreign: "01BYE5RZ4FOREIGNAAAAAAAAAAAAAAAAAA",
} as const;

/** The controls file's content: 2 MiB of one control character. */
export const controlText = "\u0001".repeat(2 * 1024 * 1024);

export const reportText =
  "Month-end report\nOpen invoices: 12\nTotal: EUR 18,340.00\n";

const driveItem = (drive: string, id: string) => {
  const parentReference = {
    driveType: "documentLibrary",
    // Graph finds an item shared from another drive under this one too.
    driveId: id === itemIds.foreign ? personalDrive : drive,
    id: "01BYE5RZ56Y2GOVW7725BZO354PWSELRRZ",
    path: "/drive/root:",
  };
  const base = {
    "@odata.etag": '"{A6FFB26C-8B1A-4B2E-9E47-2F0C1A4D7B35},3"',
    lastModifiedDateTime: "2026-09-24T14:02:11Z",
    parentReference,
  };
  switch (id) {
    case itemIds.folder: {
      return {
        ...base,
        id,
        name: "Invoices 2026",
        size: 1_048_576,
        webUrl:
          "https://example.sharepoint.com/sites/Finance/Shared%20Documents/Invoices%202026",
        folder: { childCount: 42 },
      };
    }
    case itemIds.pdf: {
      return {
        ...base,
        id,
        name: "Invoice-2026-0041.pdf",
        size: invoicePdf.byteLength,
        webUrl:
          "https://example.sharepoint.com/sites/Finance/Shared%20Documents/Invoice-2026-0041.pdf",
        file: { mimeType: "application/pdf" },
      };
    }
    case itemIds.controls: {
      return {
        ...base,
        id,
        name: "Export.txt",
        size: controlText.length,
        webUrl:
          "https://example.sharepoint.com/sites/Finance/Shared%20Documents/Export.txt",
        file: { mimeType: "text/plain" },
      };
    }
    case itemIds.big: {
      return {
        ...base,
        id,
        name: "Scans-2026.zip",
        size: 48 * 1024 * 1024,
        webUrl:
          "https://example.sharepoint.com/sites/Finance/Shared%20Documents/Scans-2026.zip",
        file: { mimeType: "application/zip" },
      };
    }
    default: {
      return {
        ...base,
        id,
        name: "Month-end report.txt",
        size: new TextEncoder().encode(reportText).byteLength,
        webUrl:
          "https://example.sharepoint.com/sites/Finance/Shared%20Documents/Month-end%20report.txt",
        file: { mimeType: "text/plain" },
      };
    }
  }
};

export const item = (drive: string, id: string) => ({
  "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#drives('${drive}')/items/$entity`,
  ...driveItem(drive, id),
});

/** Where the second page of a folder's children starts. */
export const childrenSkipToken =
  "UGFnZWQ9VFJVRSZwX1NvcnRCZWhhdmlvcj0xJnBfRmlsZUxlYWZSZWY9MQ";

/** A page of a folder's children: two per page, three in all. */
export const childrenPage = (drive: string, skipToken: string | null) => ({
  "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#drives('${drive}')/items('root')/children`,
  value:
    skipToken === null
      ? [driveItem(drive, itemIds.folder), driveItem(drive, itemIds.report)]
      : [driveItem(drive, itemIds.pdf)],
  ...(skipToken === null
    ? {
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/drives/${drive}/root/children?%24select=id%2cname&%24top=2&%24skiptoken=${childrenSkipToken}`,
      }
    : {}),
});

export const searchResults = (drive: string) => ({
  "@odata.context":
    "https://graph.microsoft.com/v1.0/$metadata#Collection(driveItem)",
  value: [driveItem(drive, itemIds.pdf), driveItem(drive, itemIds.foreign)],
});

/** Where Graph sends a download: a pre-authenticated SharePoint URL. */
export const downloadUrl = (id: string): string => {
  switch (id) {
    case itemIds.elsewhere: {
      return `https://files.example.net/download/${id}?tempauth=v1.eyJ0eXAi`;
    }
    case itemIds.plain: {
      return `http://${sharePointHost}/_layouts/15/download.aspx?UniqueId=${id}&tempauth=v1.eyJ0eXAi`;
    }
    case itemIds.nested: {
      return `https://files.example.sharepoint.com/_layouts/15/download.aspx?UniqueId=${id}&tempauth=v1.eyJ0eXAi`;
    }
    default: {
      return `https://${sharePointHost}/sites/Finance/_layouts/15/download.aspx?UniqueId=${id}&Translate=false&tempauth=v1.eyJ0eXAiOiJKV1QiLCJhbGciOiJub25lIn0&ApiVersion=2.0`;
    }
  }
};

/** Graph's answer when it throttles. */
export const throttled = {
  error: {
    code: "TooManyRequests",
    message: "Please retry after 7 seconds.",
    innerError: {
      "request-id": "7c9d0e1f-2a3b-4c5d-8e6f-a1b2c3d4e5f6",
      date: "2026-09-26T08:00:00",
    },
  },
};

/** A message Graph answers for with a header only connect's egress sets. */
export const spoofedId = "AAMkSpoofedEgressHeader=";

/** Graph's answer for an ID it doesn't know. */
export const notFound = {
  error: {
    code: "ErrorItemNotFound",
    message: "The specified object was not found in the store.",
  },
};

/** A SharePoint site the person can open: Finance. */
export const financeSite =
  "example.sharepoint.com,7a1e3c2b-4d5f-4e6a-9b8c-0d1e2f3a4b5c,5c4b3a2f-1e0d-4c8b-9a6e-4f5d2b3c1e7a";

/** A SharePoint site the person can't open: HR. */
export const hrSite =
  "example.sharepoint.com,1f2e3d4c-5b6a-4978-8e9d-a0b1c2d3e4f5,9e8d7c6b-5a49-4382-b1c0-d9e8f7a6b5c4";

/** Finance's contracts register, a list, by its ID. */
export const contractsList = "8d3f5a1c-2b7e-4c9d-a6f0-3e1b5d7c9a2f";

/** How many items the contracts register holds: more than a page. */
export const contractCount = 60;

const suppliers = [
  "Northwind Traders",
  "Contoso",
  "Fabrikam",
  "O'Brien & Sons",
] as const;

/** Item `n` of the contracts register, as Graph gives it, `fields` and all. */
export const contract = (n: number) => {
  const etag = `"5f0c2d4e-7a1b-4c3d-9e8f-${String(n).padStart(12, "0")},2"`;
  const modified = `2026-0${(n % 9) + 1}-1${n % 10}T09:30:00Z`;
  return {
    "@odata.etag": etag,
    id: String(n),
    createdDateTime: "2026-01-05T08:00:00Z",
    lastModifiedDateTime: modified,
    webUrl: `https://${sharePointHost}/sites/Finance/Lists/Contracts/${n}_.000`,
    fields: {
      "@odata.etag": etag,
      id: String(n),
      Title: `Contract ${n}`,
      Supplier: suppliers[n % suppliers.length],
      Status: n % 3 === 0 ? "Closed" : "Open",
      Amount: n * 250,
      Renewal_x0020_date: `2027-0${(n % 9) + 1}-01T00:00:00Z`,
      // "2nd signatory": a leading digit SharePoint writes as `_x0032_`.
      _x0032_nd_x0020_signatory: n % 2 === 0 ? "Finance" : "Legal",
      // A choice of several, and a link, which Graph gives as an object.
      Regions: ["EU", "UK"],
      Website: {
        Description: "Supplier portal",
        Url: `https://suppliers.example.com/${n}`,
      },
      ContentType: "Item",
      Modified: modified,
      Created: "2026-01-05T08:00:00Z",
      AuthorLookupId: "11",
      EditorLookupId: "11",
      _UIVersionString: "2.0",
      Attachments: false,
      Edit: "",
      LinkTitleNoMenu: `Contract ${n}`,
      LinkTitle: `Contract ${n}`,
      ItemChildCount: "0",
      FolderChildCount: "0",
      _ComplianceFlags: "",
      _ComplianceTag: "",
    },
  };
};

/** Graph's answer for a site the signed-in person can't open. */
export const accessDenied = {
  error: {
    code: "accessDenied",
    message:
      "Access denied. You do not have permission to perform this action or access this resource.",
  },
};

/** Graph's answer for a filter on a column that isn't indexed, unasked. */
export const notIndexed = {
  error: {
    code: "invalidRequest",
    message:
      "Field 'Status' cannot be referenced in filter or orderby as it is not indexed. Provide the 'Prefer: HonorNonIndexedQueriesWarningMayFailRandomly' header to allow this, but be warned that such queries may fail on large lists.",
  },
};
/** Excel workbooks of `financeDrive`, by drive item ID. */
export const workbookIds = {
  /** The supplier register, with its table and a named range. */
  register: "01BYE5RZ5SUPPLIERREGISTERXLSXAAAA",
  /** Another workbook, with a table of the same name. */
  other: "01BYE5RZ2OTHERWORKBOOKXLSXAAAAAAA",
};

/** The register's named table. */
export const supplierTable = "Suppliers";

/** A named range of the register: a name Excel knows, but no table. */
export const totalsRange = "Totals";

/** The supplier table's columns, as its header row names them. */
export const supplierColumns = ["Supplier", "IBAN", "Since", "Amount"];

/**
 * Excel's days 2024-01-01 and 2025-06-15, as its serial numbers count
 * them: what a date-formatted cell holds.
 */
export const daySerials = { first: 45_292, second: 45_823 };

/**
 * A cell as Excel holds it: its value, the number format it is shown in,
 * and its formula (the value itself, for a constant).
 */
export interface SheetCell {
  value: string | number | boolean;
  format: string;
  formula: string | number | boolean;
}

const constant = (
  value: string | number | boolean,
  format = "General"
): SheetCell => ({ value, format, formula: value });

/** The supplier table's rows as Excel holds them, fresh for each test. */
export const supplierRows = (): SheetCell[][] => [
  [
    constant("Northwind Supplies"),
    constant("NL91ABNA0417164300"),
    constant(daySerials.first, "yyyy-mm-dd"),
    constant(1200),
  ],
  [
    constant("Contoso Paper"),
    constant("NL02RABO0123456789"),
    constant(daySerials.second, String.raw`[$-409]d\-mmm\-yyyy;@`),
    constant(""),
  ],
];
