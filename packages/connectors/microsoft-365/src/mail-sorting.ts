import { tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api } from "@grasp-os/sdk/connector";

import {
  checkIds,
  graphId,
  graphPage,
  nextOf,
  positionOf,
} from "./graph-sdk.ts";
import { flagStatus } from "./mail.ts";

// Sorting the person's own inbox: moving, flags and categories, on a card
// they press. These reach `own`, so every route is under `/me`: a call
// reaches only the mailbox of the person whose token it holds, never a
// shared or a colleague's mailbox the token may also open
// (`Mail.ReadWrite.Shared`; GRA-724 is the shared mailbox's own issue).
//
// A card shows a call's args, not the email it acts on, so these tools
// take the email's sender and subject and check them against the email
// before they change it: what the person confirmed is what changes.

const messageRoute = "/me/messages/{message}";
const moveRoute = "/me/messages/{message}/move";
const folderRoute = "/me/mailFolders/{folder}";
const categoriesRoute = "/me/outlook/masterCategories";

/** The sender an email is from, as a card shows it. */
const from = v.string().email().max(256);

/** An email's subject, as a card shows it. */
const subject = v.string().max(1024);

const Shown = v.object({
  id: v.string(),
  subject: v.string().nullable().optional(),
  from: v
    .object({
      emailAddress: v
        .object({ address: v.string().nullable().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Refuses the call unless the person's email `message` is from `from`
 * (in any case) and has exactly `subject`, each when given.
 */
const requireShown = async (
  api: Api,
  message: string,
  shown: { from?: string | undefined; subject?: string | undefined }
): Promise<void> => {
  if (shown.from === undefined && shown.subject === undefined) {
    return;
  }
  const found = await api.get(messageRoute, {
    path: { message },
    query: { $select: "id,from,subject" },
    returns: Shown,
  });
  const sender = found.from?.emailAddress?.address ?? "";
  if (
    shown.from !== undefined &&
    sender.toLowerCase() !== shown.from.toLowerCase()
  ) {
    throw new ToolError("That email isn't from the sender the card shows", {
      code: "invalid",
    });
  }
  if (shown.subject !== undefined && (found.subject ?? "") !== shown.subject) {
    throw new ToolError("That email's subject isn't the one the card shows", {
      code: "invalid",
    });
  }
};

/** A moved message: its new ID, and the folder it is in now. */
const Moved = v.object({
  id: v.string(),
  parentFolderId: v.string().nullable().optional(),
});

/** A message's flag and categories, as Graph has them. */
const Updated = v.object({
  id: v.string(),
  flag: v
    .object({ flagStatus: v.string().nullable().optional() })
    .nullable()
    .optional(),
  categories: v.array(v.string()).nullable().optional(),
});

/** How many pages of the person's categories are read at most. */
const categoryPageLimit = 10;

/**
 * Refuses any of `categories` the person doesn't have in Outlook: a new
 * one would show up there as a category nobody made. Their categories are
 * read page by page up to `categoryPageLimit`; one past the last page
 * read counts as one they don't have, so it is refused, never made.
 */
const requireKnownCategories = async (
  api: Api,
  categories: readonly string[]
): Promise<void> => {
  const known = new Set<string>();
  let at: string | undefined;
  for (let read = 0; read < categoryPageLimit; read += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's position is in the one before
    const answer = await api.get(categoriesRoute, {
      query: { $select: "displayName", ...positionOf(at) },
      returns: graphPage(v.object({ displayName: v.string() })),
    });
    for (const { displayName } of answer.value) {
      known.add(displayName);
    }
    const following = nextOf(answer["@odata.nextLink"]);
    if (following === null) {
      break;
    }
    at = following;
  }
  if (categories.some((category) => !known.has(category))) {
    throw new ToolError(
      "The person doesn't have that category in Outlook: use one they have",
      { code: "invalid" }
    );
  }
};

/** The person's own inbox, sorted, by name, named from their routes. */
export const mailSortingTools = {
  "me.messages.move.create": tool({
    description:
      "Moves an email in the person's own mailbox to another of its folders (destinationId: a folder ID, or a well-known name such as archive). The moved email has a new ID. Give the email's sender and subject, and the folder's name, as the person sees them: they must match.",
    readOnly: false,
    reach: "own",
    mail: true,
    scopes: ["Mail.ReadWrite"],
    routes: [`POST ${moveRoute}`, `GET ${messageRoute}`, `GET ${folderRoute}`],
    describe: {
      title: "Move an email to another folder",
      fields: [
        { label: "From", arg: "from" },
        { label: "Subject", arg: "subject" },
        { label: "To folder", arg: "folderName" },
        { label: "Folder", arg: "destinationId" },
        { label: "Message", arg: "message" },
      ],
    },
    args: {
      message: graphId,
      destinationId: graphId,
      from: from.optional(),
      subject: subject.optional(),
      folderName: v.string().min(1).max(256).optional(),
    },
    returns: Moved,
    handler: async ({ message, destinationId, folderName, ...shown }, api) => {
      checkIds({ message, destinationId });
      await requireShown(api, message, shown);
      // The destination is looked up in the person's mailbox first, and the
      // message moved to the folder that names: a folder of another
      // mailbox is never a destination.
      const folder = await api.get(folderRoute, {
        path: { folder: destinationId },
        query: { $select: "id,displayName" },
        returns: v.object({
          id: v.string(),
          displayName: v.string().nullable().optional(),
        }),
      });
      if (folderName !== undefined && folder.displayName !== folderName) {
        throw new ToolError("That folder isn't the one the card names", {
          code: "invalid",
        });
      }
      return await api.post(moveRoute, {
        path: { message },
        body: { destinationId: folder.id },
        returns: Moved,
      });
    },
  }),
  "me.messages.update": tool({
    description:
      "Flags an email in the person's own mailbox for follow-up, marks its flag complete or clears it (flag), and sets its categories to exactly these, from the categories they already use (an empty list clears them). Give the email's sender and subject as the person sees them: the email must match them.",
    readOnly: false,
    reach: "own",
    mail: true,
    scopes: ["Mail.ReadWrite", "MailboxSettings.Read"],
    routes: [
      `PATCH ${messageRoute}`,
      `GET ${messageRoute}`,
      `GET ${categoriesRoute}`,
    ],
    describe: {
      title: "Flag or categorise an email",
      fields: [
        { label: "From", arg: "from" },
        { label: "Subject", arg: "subject" },
        { label: "Flag", arg: "flag" },
        { label: "Categories", arg: "categories" },
        { label: "Message", arg: "message" },
      ],
    },
    args: {
      message: graphId,
      from,
      subject,
      flag: v.object({ flagStatus }).optional(),
      categories: v.array(v.string().min(1).max(255)).max(25).optional(),
    },
    returns: Updated,
    // It sets a flag and the whole list of categories: set again, it
    // leaves the same.
    repeatable: true,
    handler: async ({ message, flag, categories, ...shown }, api) => {
      checkIds({ message });
      if (flag === undefined && categories === undefined) {
        throw new ToolError("Invalid input: give a flag, categories or both", {
          code: "invalid",
        });
      }
      if (categories !== undefined) {
        await requireKnownCategories(api, categories);
      }
      await requireShown(api, message, shown);
      return await api.patch(messageRoute, {
        path: { message },
        body: {
          ...(flag === undefined ? {} : { flag }),
          ...(categories === undefined
            ? {}
            : { categories: [...new Set(categories)] }),
        },
        returns: Updated,
      });
    },
  }),
};
