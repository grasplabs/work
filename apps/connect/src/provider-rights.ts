import {
  companyToolClasses,
  defaultToolClassAudiences,
} from "@grasp-os/shared/connect";
import type { CompanyToolClass } from "@grasp-os/shared/connect";

// What Microsoft 365 is asked for, by the classes a company turned on
// (GRA-717): least privilege at any breadth. A consent asks only the
// rights of the classes on for anyone in the company, a connection's tokens
// keep the rights they were granted (`connection_tokens.granted_scopes`),
// and turning a class on asks the connections that lack its rights to
// connect again, in place (`requireClassRights`). The ways it can fail, which the tests
// start from: a consent asks a right no class that is on needs (sending
// mail while Reach others is off, reading Teams chats while Read others'
// words is off); a class turned on runs on a grant that
// lacks its rights, and fails at Microsoft instead of asking the person;
// a right read with another's case or prefix counts as missing, or one
// that isn't granted counts as held.
//
// The connector's manifest (packages/connectors/microsoft-365) names the
// most any class asks for; this table says which class asks which.

/** Asked whatever is on: the sign-in, and a refresh token. */
const microsoftSignIn = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
] as const;

/**
 * Each class's rights. Reading the person's own is reading their mailbox
 * (and its categories), calendar, OneDrive and OneNote; changing it,
 * writing them (drafts, flags, events, their own documents, their To Do,
 * their notes). The company's is SharePoint, others' calendars and the
 * Planner plans of the person's groups, and reaching others is sending
 * mail. Reading others' words is the person's own Teams chats and the
 * transcripts of the meetings they were in (GRA-747), found through their
 * calendar. Shared mailboxes' rights come with pointing Stephen at one
 * (`sharedMailboxRights`).
 */
const microsoftClassRights: Readonly<
  Record<CompanyToolClass, readonly string[]>
> = {
  "read-own": [
    "Mail.Read",
    "MailboxSettings.Read",
    "Calendars.Read",
    "Files.Read",
    "Notes.Read",
  ],
  "change-own": [
    "Mail.ReadWrite",
    "Calendars.ReadWrite",
    "Files.ReadWrite.All",
    "Tasks.ReadWrite",
    "Notes.ReadWrite",
  ],
  "read-company": [
    "Files.Read.All",
    "Sites.Read.All",
    "Calendars.Read.Shared",
    "Tasks.Read",
  ],
  "change-company": [
    "Files.ReadWrite.All",
    "Sites.ReadWrite.All",
    "Tasks.ReadWrite",
  ],
  "reach-others": ["Mail.Send"],
  "read-others": [
    "Calendars.Read",
    "Chat.Read",
    "OnlineMeetings.Read",
    "OnlineMeetingTranscript.Read.All",
  ],
};

/**
 * The rights each right takes in, besides itself, in Microsoft Graph's
 * own terms: writing reads, and a right on every file the person can
 * open covers their own.
 */
const impliedRights: Readonly<Record<string, readonly string[]>> = {
  "mail.readwrite": ["mail.read"],
  "calendars.readwrite": ["calendars.read"],
  "files.readwrite.all": ["files.readwrite", "files.read.all", "files.read"],
  "files.readwrite": ["files.read"],
  "files.read.all": ["files.read"],
  "sites.readwrite.all": ["sites.read.all"],
  "tasks.readwrite": ["tasks.read"],
  "notes.readwrite": ["notes.read"],
};

/** How Entra may prefix a Microsoft Graph right in a token's answer. */
const graphPrefix = "https://graph.microsoft.com/";

/** A right as compared: lower case, without Graph's prefix. */
export const rightKey = (right: string): string =>
  right.toLowerCase().replace(graphPrefix, "");

/** `rights` with every one they take in, each by its key. */
const heldWith = (rights: Iterable<string>): Set<string> => {
  const held = new Set<string>();
  for (const right of rights) {
    const key = rightKey(right);
    held.add(key);
    for (const implied of impliedRights[key] ?? []) {
      held.add(implied);
    }
  }
  return held;
};

/**
 * Shared mailboxes' rights, asked only while the company points Stephen at
 * one (GRA-724): reading and sorting them, and sending from them only with
 * Reach others on too.
 */
const sharedMailboxRights = (
  classes: readonly CompanyToolClass[]
): readonly string[] =>
  classes.includes("reach-others")
    ? ["Mail.ReadWrite.Shared", "Mail.Send.Shared"]
    : ["Mail.ReadWrite.Shared"];

/**
 * The rights to ask Microsoft for, for `classes`, and shared mailboxes'
 * with `sharedMailbox`: the sign-in's and each class's, leaving out any
 * another of them takes in, in a stable order.
 */
export const microsoftRights = (
  classes: readonly CompanyToolClass[],
  sharedMailbox = false
): string[] => {
  const wanted = [
    ...microsoftSignIn,
    ...classes.flatMap((toolClass) => microsoftClassRights[toolClass]),
    ...(sharedMailbox ? sharedMailboxRights(classes) : []),
  ];
  const unique = [...new Map(wanted.map((each) => [rightKey(each), each]))];
  return unique
    .filter(
      ([key]) =>
        !unique.some(
          ([other]) =>
            other !== key && (impliedRights[other]?.includes(key) ?? false)
        )
    )
    .map(([, right]) => right);
};

/**
 * The classes on until an admin changes them, for a core that names none
 * (`StartConnection.classes`).
 */
export const classesOnByDefault: readonly CompanyToolClass[] =
  companyToolClasses.filter(
    (toolClass) => defaultToolClassAudiences[toolClass].who !== "nobody"
  );

/**
 * What a Microsoft connection made before its grant was kept was asked
 * for: one wide set, whatever was on.
 */
export const microsoftRightsBefore = [
  ...microsoftSignIn,
  "Mail.ReadWrite",
  "Mail.ReadWrite.Shared",
  "Mail.Send",
  "Mail.Send.Shared",
  "Calendars.Read",
  "Calendars.Read.Shared",
  "Files.Read.All",
  "Sites.Read.All",
] as const;

/**
 * Whether `granted` holds every right `classes` ask Microsoft for, but the
 * sign-in's: Entra's answer may leave those out of what it lists.
 */
export const holdsMicrosoftRights = (
  granted: readonly string[],
  classes: readonly CompanyToolClass[],
  sharedMailbox = false
): boolean => {
  const held = heldWith(granted);
  const signInKeys = new Set(microsoftSignIn.map(rightKey));
  return microsoftRights(classes, sharedMailbox)
    .map(rightKey)
    .every((key) => signInKeys.has(key) || held.has(key));
};

/** The rights a token's answer lists (`scope`), each once. */
export const grantedRights = (scope: string | undefined): string[] | null =>
  scope === undefined
    ? null
    : [...new Set(scope.split(" ").filter((each) => each !== ""))];

/**
 * What `provider` asks for when the company has `classes` on, if it asks
 * by class: Microsoft 365's own connections only, not the read-only admin
 * connections that share its sign-in (the landscape's, the directory's,
 * the documents'), which ask for their own.
 */
export const rightsFor = (
  provider: string,
  classes: readonly CompanyToolClass[],
  sharedMailbox = false
): string[] | undefined =>
  provider === "microsoft"
    ? microsoftRights(classes, sharedMailbox)
    : undefined;
