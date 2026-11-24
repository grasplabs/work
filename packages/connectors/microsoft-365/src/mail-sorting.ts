import {
  defineTool,
  invalidCode,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  mailboxSchema,
  nextPageOf,
  pageOf,
  v1,
} from "./graph.ts";

// Sorting a person's own inbox: flags and categories, on a card they
// press. These reach `own`, so each call first asks Graph whose token it
// holds (`GET /me`, the one route that isn't bound to a mailbox, and only
// a read of who that is) and refuses any mailbox but that person's: a
// shared or a colleague's mailbox the token may also open
// (`Mail.ReadWrite.Shared`) is never one of these tools' (GRA-724 is the
// shared mailbox's own issue). Requests still go to `/users/{mailbox}`,
// so the egress binds them to the call's mailbox as it binds every mail
// tool's.
//
// A card shows a call's input, not the email it acts on, so these tools
// take the email's sender and subject as input and check them against the
// email before they change it: what the person confirmed is what changes.

const users = `${v1}/users/{mailbox}`;

const get = (path: string) =>
  ({ method: "GET", host: graphHost, path: `${users}${path}` }) as const;
const patch = (path: string) =>
  ({ method: "PATCH", host: graphHost, path: `${users}${path}` }) as const;

/** Who the connection's token is for: read before any own-mailbox write. */
export const meRoute = {
  method: "GET",
  host: graphHost,
  path: `${v1}/me`,
} as const;

const graphMe = z.object({
  id: z.string().nullish(),
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
  proxyAddresses: z.array(z.string()).nullish(),
});

/** An Exchange proxy address that is an email address: `SMTP:` or `smtp:`. */
const smtpPrefix = /^smtp:/iu;

/**
 * Refuses `mailbox` unless it names the person the token is for: their
 * user ID, address, sign-in name or one of their email aliases, in any
 * case. The refusal is `invalid`, not `access_denied`: Graph didn't deny
 * anything, the call named someone else's mailbox. Gives back every name
 * the person goes by, in lower case.
 */
export const requireOwnMailbox = async (
  mailbox: string
): Promise<ReadonlySet<string>> => {
  const me = await graphJson(
    graphUrl("/me", { $select: "id,mail,userPrincipalName,proxyAddresses" }),
    graphMe
  );
  const own = new Set(
    [
      me.id,
      me.mail,
      me.userPrincipalName,
      ...(me.proxyAddresses ?? [])
        .filter((address) => smtpPrefix.test(address))
        .map((address) => address.replace(smtpPrefix, "")),
    ]
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase())
  );
  if (!own.has(mailbox.toLowerCase())) {
    throw new ToolError("This works only in the person's own mailbox", {
      code: invalidCode,
    });
  }
  return own;
};

const graphShown = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  from: z
    .object({
      emailAddress: z.object({ address: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

/** The email a card shows: who it is from and its subject. */
export interface Shown {
  from?: string | undefined;
  subject?: string | undefined;
}

/**
 * Refuses the call unless the email at `path` is from `from` (in any
 * case) and has exactly `subject`, each when given.
 */
export const requireShown = async (
  path: string,
  { from, subject }: Shown
): Promise<void> => {
  if (from === undefined && subject === undefined) {
    return;
  }
  const message = await graphJson(
    graphUrl(path, { $select: "id,from,subject" }),
    graphShown
  );
  const sender = message.from?.emailAddress?.address ?? "";
  if (from !== undefined && sender.toLowerCase() !== from.toLowerCase()) {
    throw new ToolError("That email isn't from the sender the card shows", {
      code: invalidCode,
    });
  }
  if (subject !== undefined && (message.subject ?? "") !== subject) {
    throw new ToolError("That email's subject isn't the one the card shows", {
      code: invalidCode,
    });
  }
};

/** The sender an email is from, as a card shows it. */
export const fromSchema = z.email().max(256);

/** An email's subject, as a card shows it. */
export const subjectSchema = z.string().max(1024);

/** How an email is flagged, in Graph's words. */
const flagSchema = z.enum(["flagged", "complete", "notFlagged"]);

const graphFlagged = z.object({
  id: z.string(),
  flag: z.object({ flagStatus: z.string() }).nullish(),
  categories: z.array(z.string()).nullish(),
});

const flagMessage = defineTool({
  name: "mail.flag",
  description:
    "Flags an email in the person's own mailbox for follow-up, marks its flag complete, or clears it. Give the email's sender and subject as the person sees them: the email must match them.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    from: fromSchema,
    subject: subjectSchema,
    flag: flagSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    id: z.string(),
    flag: z.string(),
  }),
  readOnly: false,
  reach: "own",
  destructive: false,
  // A flag is a state: set again, it leaves the same flag.
  repeatable: true,
  resource: "mailbox",
  routes: [meRoute, get("/messages/{message}"), patch("/messages/{message}")],
  describe: {
    title: "Flag an email",
    fields: [
      { label: "Mailbox", input: "mailbox" },
      { label: "From", input: "from" },
      { label: "Subject", input: "subject" },
      { label: "Flag", input: "flag" },
      { label: "Message", input: "message" },
    ],
  },
  run: async ({ mailbox, message, from, subject, flag }) => {
    await requireOwnMailbox(mailbox);
    const path = `/users/${segment(mailbox)}/messages/${segment(message)}`;
    await requireShown(path, { from, subject });
    const flagged = await graphJson(graphUrl(path), graphFlagged, {
      ...jsonBody({ flag: { flagStatus: flag } }),
      method: "PATCH",
    });
    return {
      output: {
        mailbox,
        id: flagged.id,
        flag: flagged.flag?.flagStatus ?? flag,
      },
    };
  },
});

/** A category's name, as Outlook keeps it. */
const categorySchema = z.string().min(1).max(255);

const graphCategory = z.object({ displayName: z.string() });

/** How many pages of a person's categories mail.categorise reads at most. */
const categoryPageLimit = 10;

/**
 * The names of the categories the person has in `mailbox`, page by page
 * up to `categoryPageLimit`, each next page asked for on the tool's own
 * route with only its position taken from Graph's `@odata.nextLink`. A
 * category past the last page read counts as one they don't have, so it
 * is refused, never made.
 */
const categoriesOf = async (mailbox: string): Promise<Set<string>> => {
  const names = new Set<string>();
  let page: string | null | undefined;
  for (let read = 0; read < categoryPageLimit && page !== null; read += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's position is in the one before
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(
        graphUrl(`/users/${segment(mailbox)}/outlook/masterCategories`, {
          $select: "displayName",
        }),
        page
      ),
      pageOf(graphCategory)
    );
    for (const { displayName } of value) {
      names.add(displayName);
    }
    page = nextPageOf(nextLink);
  }
  return names;
};

const categoriseMessage = defineTool({
  name: "mail.categorise",
  description:
    "Sets an email's categories in the person's own mailbox to exactly these, from the categories they already use (an empty list clears them). Give the email's sender and subject as the person sees them: the email must match them.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    from: fromSchema,
    subject: subjectSchema,
    categories: z.array(categorySchema).max(25),
  }),
  output: z.strictObject({
    mailbox: z.string(),
    id: z.string(),
    categories: z.array(z.string()),
  }),
  readOnly: false,
  reach: "own",
  destructive: false,
  // It sets the whole list: set again, it leaves the same categories.
  repeatable: true,
  resource: "mailbox",
  routes: [
    meRoute,
    get("/outlook/masterCategories"),
    get("/messages/{message}"),
    patch("/messages/{message}"),
  ],
  describe: {
    title: "Categorise an email",
    fields: [
      { label: "Mailbox", input: "mailbox" },
      { label: "From", input: "from" },
      { label: "Subject", input: "subject" },
      { label: "Categories", input: "categories" },
      { label: "Message", input: "message" },
    ],
  },
  run: async ({ mailbox, message, from, subject, categories }) => {
    await requireOwnMailbox(mailbox);
    // Only the categories the person already has: a new one would show
    // up in their Outlook as a category nobody made.
    const known = await categoriesOf(mailbox);
    const unknown = categories.filter((category) => !known.has(category));
    if (unknown.length > 0) {
      throw new ToolError(
        "The person doesn't have that category in Outlook: use one they have",
        { code: invalidCode }
      );
    }
    const path = `/users/${segment(mailbox)}/messages/${segment(message)}`;
    await requireShown(path, { from, subject });
    const categorised = await graphJson(graphUrl(path), graphFlagged, {
      ...jsonBody({ categories: [...new Set(categories)] }),
      method: "PATCH",
    });
    return {
      output: {
        mailbox,
        id: categorised.id,
        categories: categorised.categories ?? [],
      },
    };
  },
});

export const mailSortingTools = [flagMessage, categoriseMessage];
