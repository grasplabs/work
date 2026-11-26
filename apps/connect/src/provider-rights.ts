import {
  companyToolClasses,
  defaultToolClassAudiences,
} from "@grasp-os/shared/connect";
import type { CompanyToolClass } from "@grasp-os/shared/connect";

import { appRecords } from "./bundled-connectors.ts";
import type { AppRecord } from "./bundled-connectors.ts";

// What the suites, Microsoft 365 and Google Workspace, are asked for, by
// the classes a company turned on (GRA-717, GRA-756): least privilege at
// any breadth. A consent asks only the
// rights of the classes on for anyone in the company, a connection's tokens
// keep the rights they were granted (`connection_tokens.granted_scopes`),
// and turning a class on asks the connections that lack its rights to
// connect again, in place (`requireClassRights`). The ways it can fail, which the tests
// start from: a consent asks a right no class that is on needs (sending
// mail while Reach others is off, reading Teams chats while Read others'
// words is off); a class turned on runs on a grant that lacks its rights,
// and fails at the provider instead of asking the person; a right read
// with another's case or prefix counts as missing, or one that isn't
// granted counts as held.
//
// Each connector's manifest (packages/connectors/microsoft-365,
// google-workspace) names the most any class asks for; these tables say
// which class asks which. A connector's own sign-in may say the same
// (`rights`, runtime/connector's sign-in.ts), and is asked by class as these
// are.

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
const microsoftImpliedRights: Readonly<Record<string, readonly string[]>> = {
  "mail.readwrite": ["mail.read"],
  "calendars.readwrite": ["calendars.read"],
  "files.readwrite.all": ["files.readwrite", "files.read.all", "files.read"],
  "files.readwrite": ["files.read"],
  "files.read.all": ["files.read"],
  "sites.readwrite.all": ["sites.read.all"],
  "tasks.readwrite": ["tasks.read"],
  "notes.readwrite": ["notes.read"],
};

/** A Google OAuth scope, by its name under Google's prefix. */
const googleScope = (name: string): string =>
  `https://www.googleapis.com/auth/${name}`;

/**
 * Asked whatever is on: the sign-in, and the groups the account is in,
 * which core counts the person in a copied reader list's group by
 * (reader-groups.ts; Microsoft's sign-in `User.Read` reads them there).
 * Google gives a refresh token anyway.
 */
const googleSignIn = [
  "openid",
  "email",
  "profile",
  googleScope("cloud-identity.groups.readonly"),
] as const;

/**
 * Each class's rights at Google, as the Google Workspace connector's tools
 * of that class need them. Reading the person's own is reading their
 * mailbox; changing it, labelling and drafting mail (`gmail.modify`),
 * putting an event in their own calendar (`calendar.events`, and the
 * calendar list that says which is theirs) and drafts in their own Drive
 * (`drive.file`: only the files Grasp made). The company's is reading
 * colleagues' and groups' calendars and the shared drives' files and
 * spreadsheets. Google has no tool that changes the company's.
 *
 * Reaching others asks `gmail.send`, but Gmail can't split sending off
 * modifying: `gmail.modify` sends too, so once Change own is on the grant
 * can send whether Reach others is on or not. There Reach others is held by
 * its class alone: core refuses `mail.send` before it signs a call for
 * connect while the class is off for the person (tool-classes.ts).
 *
 * Google has no tool that reads others' words (Teams is Microsoft's).
 */
const googleClassRights: Readonly<Record<CompanyToolClass, readonly string[]>> =
  {
    "read-own": [googleScope("gmail.readonly")],
    "change-own": [
      googleScope("gmail.modify"),
      googleScope("calendar.events"),
      googleScope("calendar.calendarlist.readonly"),
      googleScope("drive.file"),
    ],
    "read-company": [
      googleScope("calendar.events.readonly"),
      googleScope("drive.readonly"),
    ],
    "change-company": [],
    "reach-others": [googleScope("gmail.send")],
    "read-others": [],
  };

/**
 * The rights each Google right takes in, besides itself, by key: modifying
 * mail reads and sends it, and writing events reads them. `drive.file`
 * reads only Grasp's own files, so it takes in no reading of the rest.
 */
const googleImpliedRights: Readonly<Record<string, readonly string[]>> = {
  [googleScope("gmail.modify")]: [
    googleScope("gmail.readonly"),
    googleScope("gmail.send"),
  ],
  [googleScope("calendar.events")]: [googleScope("calendar.events.readonly")],
};

/** How Entra may prefix a Microsoft Graph right in a token's answer. */
const graphPrefix = "https://graph.microsoft.com/";

/**
 * A right as compared: lower case, without `prefix` (a provider's
 * `scopePrefix`) at its start.
 */
export const rightKey = (right: string, prefix = ""): string => {
  const key = right.toLowerCase();
  const start = prefix.toLowerCase();
  return start !== "" && key.startsWith(start) ? key.slice(start.length) : key;
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

/** How a suite is asked by class. */
interface SuiteRights {
  /** Asked whatever is on. */
  signIn: readonly string[];
  classRights: Readonly<Record<CompanyToolClass, readonly string[]>>;
  /** The rights each right takes in, besides itself, by key. */
  implied: Readonly<Record<string, readonly string[]>>;
  /** Asked besides the classes' while a shared mailbox is pointed at. */
  sharedMailbox: (classes: readonly CompanyToolClass[]) => readonly string[];
  /** What a token answer may put before a right (`rightKey`). */
  scopePrefix?: string;
  /**
   * What a connection made before its grant was kept was asked for: one
   * wide set, whatever was on. None for a connector's own sign-in, whose
   * connections always kept theirs: one that didn't holds nothing.
   */
  before?: readonly string[];
}

const microsoftSuite: SuiteRights = {
  signIn: microsoftSignIn,
  classRights: microsoftClassRights,
  implied: microsoftImpliedRights,
  sharedMailbox: sharedMailboxRights,
  scopePrefix: graphPrefix,
  before: [
    ...microsoftSignIn,
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "Calendars.Read",
    "Calendars.Read.Shared",
    "Files.Read.All",
    "Sites.Read.All",
  ],
};

const googleSuite: SuiteRights = {
  signIn: googleSignIn,
  classRights: googleClassRights,
  implied: googleImpliedRights,
  // A Google token reaches only its own person's mailbox: there are no
  // shared mailboxes to ask for.
  sharedMailbox: () => [],
  // Before the connector wrote events and drafts (#1150, #1153).
  before: [
    ...googleSignIn,
    googleScope("gmail.modify"),
    googleScope("calendar.events.readonly"),
    googleScope("drive.readonly"),
  ],
};

/** The suites asked by class, by provider. */
const suites: Readonly<Record<string, SuiteRights>> = {
  microsoft: microsoftSuite,
  google: googleSuite,
};

/**
 * How a connector's own sign-in asks by class, if it says (`rights`), and
 * connect has no table of its own for its provider.
 */
const declaredSuite = ({
  provider,
  signIn,
}: AppRecord): SuiteRights | undefined => {
  if (
    Object.hasOwn(suites, provider) ||
    signIn.kind !== "oauth2" ||
    signIn.rights === undefined
  ) {
    return undefined;
  }
  const { rights, scopePrefix } = signIn;
  const key = (right: string): string => rightKey(right, scopePrefix);
  return {
    signIn: rights.signIn,
    classRights: rights.classes,
    implied: Object.fromEntries(
      Object.entries(rights.implied ?? {}).map(([right, takesIn]) => [
        key(right),
        takesIn.map(key),
      ])
    ),
    sharedMailbox: (classes) =>
      rights.sharedMailbox === undefined
        ? []
        : [
            ...rights.sharedMailbox.read,
            ...(classes.includes("reach-others")
              ? rights.sharedMailbox.reach
              : []),
          ],
    ...(scopePrefix === undefined ? {} : { scopePrefix }),
  };
};

/** The connectors' own sign-ins asked by class, by provider. */
const declared: ReadonlyMap<string, SuiteRights> = new Map(
  appRecords().flatMap((record) => {
    const suite = declaredSuite(record);
    return suite === undefined ? [] : [[record.provider, suite] as const];
  })
);

/** The providers whose connections are asked by class. */
export const classRightsProviders = [
  ...Object.keys(suites),
  ...declared.keys(),
];

/** The suite `provider` names, if it is asked by class. */
const suiteOf = (provider: string): SuiteRights | undefined =>
  Object.hasOwn(suites, provider) ? suites[provider] : declared.get(provider);

/**
 * What the right `key` takes in, by key. Own entries only: a token
 * answer names its rights, and `constructor` is no right.
 */
const takenIn = ({ implied }: SuiteRights, key: string): readonly string[] =>
  Object.hasOwn(implied, key) ? (implied[key] ?? []) : [];

/** `rights` with every one they take in, each by its key. */
const heldWith = (
  suite: SuiteRights,
  rights: Iterable<string>
): Set<string> => {
  const held = new Set<string>();
  for (const right of rights) {
    const key = rightKey(right, suite.scopePrefix);
    held.add(key);
    for (const each of takenIn(suite, key)) {
      held.add(each);
    }
  }
  return held;
};

/**
 * The rights to ask `suite` for, for `classes`, and shared mailboxes' with
 * `sharedMailbox`: the sign-in's and each class's, leaving out any another
 * of them takes in, in a stable order.
 */
const suiteRights = (
  suite: SuiteRights,
  classes: readonly CompanyToolClass[],
  sharedMailbox: boolean
): string[] => {
  const wanted = [
    ...suite.signIn,
    ...classes.flatMap((toolClass) => suite.classRights[toolClass]),
    ...(sharedMailbox ? suite.sharedMailbox(classes) : []),
  ];
  const unique = [
    ...new Map(wanted.map((each) => [rightKey(each, suite.scopePrefix), each])),
  ];
  return unique
    .filter(
      ([key]) =>
        !unique.some(
          ([other]) => other !== key && takenIn(suite, other).includes(key)
        )
    )
    .map(([, right]) => right);
};

/** The rights to ask Microsoft for, for `classes` (`suiteRights`). */
export const microsoftRights = (
  classes: readonly CompanyToolClass[],
  sharedMailbox = false
): string[] => suiteRights(microsoftSuite, classes, sharedMailbox);

/** The rights to ask Google for, for `classes` (`suiteRights`). */
export const googleRights = (classes: readonly CompanyToolClass[]): string[] =>
  suiteRights(googleSuite, classes, false);

/**
 * The classes on until an admin changes them, for a core that names none
 * (`StartConnection.classes`).
 */
export const classesOnByDefault: readonly CompanyToolClass[] =
  companyToolClasses.filter(
    (toolClass) => defaultToolClassAudiences[toolClass].who !== "nobody"
  );

/**
 * The rights a `provider` token's answer lists (`scope`), each by its key,
 * with every one they take in; undefined for a provider not asked by
 * class, whose rights take in none.
 */
export const rightsHeld = (
  provider: string,
  scope: string
): ReadonlySet<string> | undefined => {
  const suite = suiteOf(provider);
  return suite === undefined ? undefined : heldWith(suite, scope.split(" "));
};

/** The rights a token's answer lists (`scope`), each once. */
export const grantedRights = (scope: string | undefined): string[] | null =>
  scope === undefined ? null : [...new Set(scope.split(" "))];

/**
 * Whether a `provider` connection granted `granted` (a token answer's
 * `scope`; null for one kept before grants were, which holds the suite's
 * old wide set, or nothing) holds every right `classes` ask for, but the sign-in's:
 * the provider's answer may leave those out, or name them otherwise. A
 * provider not asked by class holds what it holds.
 */
export const holdsClassRights = (
  provider: string,
  granted: string | null,
  classes: readonly CompanyToolClass[],
  sharedMailbox = false
): boolean => {
  const suite = suiteOf(provider);
  if (suite === undefined) {
    return true;
  }
  const held = heldWith(
    suite,
    grantedRights(granted ?? undefined) ?? suite.before ?? []
  );
  const key = (right: string): string => rightKey(right, suite.scopePrefix);
  const signInKeys = new Set(suite.signIn.map(key));
  return suiteRights(suite, classes, sharedMailbox)
    .map(key)
    .every((each) => signInKeys.has(each) || held.has(each));
};

/**
 * What `provider` asks for when the company has `classes` on, if it asks
 * by class: the suites' own connections only, not the read-only admin
 * connections that share their sign-in (the directory's, the
 * documents'), which ask for their own.
 */
export const rightsFor = (
  provider: string,
  classes: readonly CompanyToolClass[],
  sharedMailbox = false
): string[] | undefined => {
  const suite = suiteOf(provider);
  return suite === undefined
    ? undefined
    : suiteRights(suite, classes, sharedMailbox);
};
