import { z } from "zod";

import type { OutboxedAuditEvent, OutboxRejected } from "./audit.ts";
import type { HeldBinding } from "./capability.ts";
import { defineErrorFamily, isExpectedError } from "./errors.ts";
import type { CodedError } from "./errors.ts";
import {
  chatIdSchema,
  connectionIdSchema,
  identifierSchema,
  workspaceIdSchema,
} from "./ids.ts";
import { landscapeProviderSchema } from "./landscape.ts";
import type { PackageRegistryApi } from "./packages.ts";
import { codeSubjectSchema, permissionActionSchema } from "./permissions.ts";
import type { CodeSubject, WorkContext } from "./permissions.ts";
import { roleSchema } from "./roles.ts";
import { eventTypeSchema } from "./workflows.ts";

/**
 * One call from core to connect, over the service binding: an action on a
 * connection, with the capability core made for exactly this call.
 */
export const connectCallSchema = z.strictObject({
  /** Checked on its own, so a call without one is refused for that. */
  capability: z.unknown().optional(),
  connectionId: connectionIdSchema,
  resource: identifierSchema.optional(),
  action: permissionActionSchema,
  input: z.json(),
  /**
   * Required for a workflow run's side effects: a repeat returns the
   * stored result. A side effect a person is there for (from chat, or from
   * a person using an App) needs none: connect makes one as it holds it.
   */
  idempotencyKey: identifierSchema.optional(),
  /**
   * The stamp core recorded for a workflow run's mail (core's
   * workflows/mail-stamps.ts), never in the input App code writes: connect
   * gives it to a native connector's side effect (`stampMetaKey`), whose
   * mail carries it as a header, so the copy a watched mailbox receives
   * names the run that sent it. Kept with a held action, so it goes out
   * with it once its person confirms.
   */
  stamp: z
    .string()
    .regex(/^[0-9a-f]{32}$/u)
    .optional(),
});
export type ConnectCall = z.infer<typeof connectCallSchema>;

/** What an action returns. */
export interface ConnectResult {
  /**
   * The action's output, as JSON text: a type for any JSON value is too deep
   * for the RPC types to follow.
   */
  output: string;
  /**
   * The IDs of the resources the action read (messages, files, events), as
   * its connector names them, so callers can label what they build from the
   * output. Empty when a native connector names none; a Composio tool that
   * names none is known by its toolkit and tool instead
   * (`hubspot/HUBSPOT_LIST_CONTACTS`).
   */
  provenance: string[];
  /**
   * Set when connect held the call for the person it acts for to confirm
   * (a side effect from chat, from a person using an App, or from a context
   * that read restricted data): nothing was done yet, so `output` is the
   * JSON text `"null"` and `provenance` is empty. A repeat with the same
   * idempotency key finds the same held action until it is decided, and
   * the action's answer once it ran; a repeat of a call without a key
   * finds the same held action while it waits, and is held as a new one
   * once that is decided. A workflow run's call is never
   * answered so: it fails with `connect.held`, and core waits for the
   * person's decision before running the step again.
   */
  pending?: PendingReference;
}

/** A held action, as the call connect held returns it. */
export interface PendingReference {
  id: string;
}

// Connecting accounts. A person starts and finishes the OAuth flow in their
// own browser, signed in to core; core says who they are, and connect keeps
// everything else: the flow's state and PKCE verifier, and the tokens, which
// never leave it (threat model R1).

/**
 * The suites a person connects through OAuth, pinned to the organization's
 * own tenant: the IdPs people sign in with.
 */
export const oauthProviderSchema = z.enum(["microsoft", "google"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/**
 * Names no app may take: the suites above, whose sign-in connect handles
 * itself; the landscape's admin connections (`./landscape.ts`), which no
 * connector's calls may use; and Composio, whose connections are another
 * kind.
 */
const reservedProviderIds: ReadonlySet<string> = new Set([
  ...oauthProviderSchema.options,
  ...landscapeProviderSchema.options,
  "composio",
]);

/**
 * Any other app a person signs in to, with OAuth 2.0 or an API key, as its
 * native connector's provider record describes it (the connector kit's
 * `signInSchema`): `hubspot`, `sample-crm`. Never one of the suites' names.
 */
export const appProviderSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}$/u)
  .refine((id) => !reservedProviderIds.has(id), "A reserved provider name");
export type AppProvider = z.infer<typeof appProviderSchema>;

/** Whose token a native connector's calls get: a suite's or an app's. */
export const connectorProviderSchema = z.union([
  oauthProviderSchema,
  appProviderSchema,
]);
export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;

/**
 * Personal: the person's own account, used only for them. Shared: an
 * account the organization uses (a service mailbox, say), connected by an
 * admin; permissions decide who uses it.
 */
export const connectionScopeSchema = z.enum(["personal", "shared"]);
export type ConnectionScope = z.infer<typeof connectionScopeSchema>;

/** Where the provider sends the browser back to, on the client's origin. */
export const connectionCallbackPath = "/api/connections/callback";

/** Longest path a flow may send the browser back to. */
export const returnPathMaxLength = 512;

/** The signed-in person a request comes from, as core read them just now. */
export const connectionPersonSchema = z.strictObject({
  userId: identifierSchema,
  role: roleSchema,
  /** Grasp staff, in a staff window. */
  staff: z.boolean(),
  /** The email they signed in with, verified by their IdP. */
  email: identifierSchema,
  /**
   * The IdP accounts they sign in with, by their subject at that provider
   * (the Entra object ID, the Google subject): a personal connection must
   * be to one of these, where they have one at that provider.
   */
  accounts: z
    .array(
      z.strictObject({
        provider: oauthProviderSchema,
        subject: identifierSchema,
      })
    )
    .max(8),
});
export type ConnectionPerson = z.infer<typeof connectionPersonSchema>;

/** Starts connecting an account through OAuth. */
export const startConnectionSchema = z.strictObject({
  person: connectionPersonSchema,
  /**
   * A connector's provider, or the landscape's read-only admin connection
   * of a suite, which no connector's calls use.
   */
  provider: z.union([connectorProviderSchema, landscapeProviderSchema]),
  scope: connectionScopeSchema,
  /** The deployment's origin, from its config: the provider returns there. */
  origin: z.url(),
  /**
   * The organization at the provider, from the deployment's sign-in config:
   * its Entra tenant ID, or its Google Workspace domain. Only accounts in
   * it can be connected. Required for those suites; an app has none.
   */
  tenant: identifierSchema.optional(),
  /** A path on the deployment's origin; core checks it. */
  returnTo: z.string().startsWith("/").max(returnPathMaxLength),
});
export type StartConnection = z.input<typeof startConnectionSchema>;

/** The provider's answer, as the browser brought it back to core. */
export const finishConnectionSchema = z.strictObject({
  person: connectionPersonSchema,
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096).optional(),
  /** The provider's error code, when it sent one instead of a code. */
  error: z.string().min(1).max(256).optional(),
});
export type FinishConnection = z.input<typeof finishConnectionSchema>;

/** Longest API key connect takes. */
export const apiKeyMaxLength = 4096;

/**
 * Connects an app that signs in with an API key, which the person typed:
 * connect checks it with the app (its provider record's account lookup)
 * and seals it in the token vault, as it does OAuth tokens. It never comes
 * back out, and never reaches the connector's code.
 */
export const connectWithKeySchema = z.strictObject({
  person: connectionPersonSchema,
  provider: appProviderSchema,
  scope: connectionScopeSchema,
  /** Printable ASCII only: it goes into a request header as it is. */
  key: z
    .string()
    .min(1)
    .max(apiKeyMaxLength)
    .regex(/^[\u0021-\u007E]+$/u, "Not an API key"),
});
export type ConnectWithKey = z.input<typeof connectWithKeySchema>;

export const disconnectSchema = z.strictObject({
  person: connectionPersonSchema,
  connectionId: connectionIdSchema,
});
export type Disconnect = z.input<typeof disconnectSchema>;

/**
 * How long a person has to finish an OAuth flow at the provider. Core also
 * keeps retrying a removed person's disconnect this long after the
 * removal, for a flow that was already finishing when it ran.
 */
export const oauthFlowLifetimeMs = 10 * 60 * 1000;

/** Most people one `disconnectPersonal` call takes. */
export const disconnectPersonalMaxOwners = 100;

/**
 * Disconnects every personal connection of the people `ownerUserIds`, who
 * were removed from the organization: for the admin `person` who removed
 * them, or, with `person` null, for core itself, which retries for people
 * whose disconnect hasn't completed yet.
 */
export const disconnectPersonalSchema = z.strictObject({
  person: connectionPersonSchema.nullable(),
  ownerUserIds: z.array(identifierSchema).max(disconnectPersonalMaxOwners),
});
export type DisconnectPersonal = z.input<typeof disconnectPersonalSchema>;

/** One connection, as people see it: never its tokens. */
export interface ConnectionSummary {
  id: string;
  /** Who holds its tokens and carries out its actions: connect, or Composio. */
  source: CatalogSource;
  /** A native provider (`microsoft`), or a Composio toolkit's slug. */
  provider: string;
  scope: ConnectionScope;
  status: "active" | "needs_reauth" | "disconnected";
  /** A personal connection's owner; `null` for a shared one. */
  ownerUserId: string | null;
  /** Who connected it. */
  connectedBy: string | null;
  /** The account at the provider, such as its email address. */
  accountName: string | null;
  /** ISO 8601. */
  createdAt: string;
  /**
   * A Composio connection's allowed tools, by name, as the admin who
   * connected it consented to them. Absent for a native connection, and
   * from a connect that predates it.
   */
  tools?: string[];
}

/**
 * Whether Composio says a Composio connection's account still works:
 * `stopped` once its account there isn't active (expired, failed, or gone),
 * which connect's own status never shows, as Composio holds the tokens;
 * `unread` when Composio couldn't be asked now.
 */
export type ComposioAccountState = "active" | "stopped" | "unread";

/**
 * One of the organization's connections, as Grasp's staff read it through
 * core's admin snapshot (`ConnectApi.organizationConnections`): what it is
 * and whether it works, never its tokens, its server's URL or what
 * Composio knows it by. A personal one says nothing of its owner or
 * account: only that someone connected their own.
 */
export interface OrganizationConnection {
  id: string;
  source: CatalogSource;
  provider: string;
  scope: ConnectionScope;
  status: "active" | "needs_reauth";
  /** Composio's word on a Composio connection; null for a native one. */
  composio: ComposioAccountState | null;
  /** Who connected a shared one; null for a personal one. */
  connectedBy: string | null;
  /** A shared one's account at the provider; null for a personal one. */
  accountName: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** A shared Composio connection's allowed tools, by name; null otherwise. */
  tools: string[] | null;
}

/** A connection as core lists it to people: who connected it, by name too. */
export interface ListedConnection extends ConnectionSummary {
  /** `connectedBy`'s name, while core knows them. */
  connectedByName: string | null;
}

/** Most connections one `connectionOwners` call takes. */
export const connectionOwnersMax = 100;

/** The connections whose owners core asks for, by ID. */
export const connectionOwnersSchema = z
  .array(identifierSchema)
  .max(connectionOwnersMax);

/**
 * Whose a connection is: a personal connection's owner, the only person
 * who may read what it holds, or `null` for a shared one, which everyone
 * in the organization may use.
 */
export interface ConnectionOwner {
  id: string;
  ownerUserId: string | null;
  /** Who carries out its actions: a native connector, or Composio. */
  source: CatalogSource;
  /** A native provider (`microsoft`), or a Composio toolkit's slug. */
  provider: string;
  /** The account's ID at the provider (Microsoft: its Entra object ID). */
  accountId: string | null;
  /** The account at the provider, such as its email address. */
  accountName: string | null;
  /**
   * The account's own email address, as its provider's sign-in said: for
   * Microsoft 365 the primary address it sends from, which may differ from
   * its sign-in name (`accountName`). Null when the provider didn't say.
   */
  accountEmail: string | null;
  /**
   * The other addresses the account's mailbox receives mail at, its
   * primary address and SMTP aliases, as its provider said when it was
   * connected; none if that wasn't read.
   */
  accountAddresses: string[];
  /**
   * The addresses the account may send as besides those (Google's
   * verified send-as addresses), as its provider said when it was
   * connected: a run's senders, never its mailbox's addresses, since such
   * an address may receive in another mailbox.
   */
  accountSenders: string[];
}

/**
 * A person's request for an app the catalog doesn't have, as they type
 * it: its name, what Grasp should do in it, and where it lives.
 */
export const appRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  why: z.string().trim().max(2000).optional(),
  url: z
    .url({ protocol: /^https?$/u })
    .max(2048)
    .optional(),
});
export type AppRequestInput = z.input<typeof appRequestSchema>;

/** An app someone asked Grasp to add, as the catalog doesn't have it. */
export interface AppRequest {
  id: string;
  /** As the first person to ask for it typed it. */
  name: string;
  /** What Grasp should do in it, in their words. */
  why: string | null;
  /** Where the app lives, as they gave it. */
  url: string | null;
  /** Who asked first; `name` is null once they are gone. */
  requestedBy: { userId: string; name: string | null };
  requestedAt: string;
}

/** Most app requests listed at once: the latest. */
export const appRequestsListed = 200;

/**
 * A signed-in person's connections, over `/rpc`. Starting one returns the
 * provider URL to send the browser to; the provider sends it back to
 * core's callback, which returns it to `returnTo` (a path on this origin)
 * with `connection=<id>` once it finished, or to the Connections page with
 * `connectionError=<code>` when it didn't. Reconnecting a connection that
 * needs it (`needs_reauth`) is starting one for its provider and scope:
 * finished with the account it holds, it is that connection again.
 */
export interface ConnectionsApi {
  start: (request: {
    provider: OAuthProvider;
    scope: ConnectionScope;
    returnTo?: string;
  }) => Promise<{ url: string }>;
  list: () => Promise<ListedConnection[]>;
  disconnect: (connectionId: string) => Promise<{ revoked: boolean }>;
  /**
   * What can be connected: the native providers, and Composio's
   * toolkits while connect has a Composio key. Admins see every entry,
   * each saying whether it is offered; everyone else only the offered ones.
   */
  catalog: () => Promise<OfferedCatalog>;
  /**
   * Offers a catalog entry, or stops offering it: nobody starts connecting
   * an entry that isn't offered (`connection.not_offered`), admins
   * included, while connections already made go on, and permissions on
   * them are still requested and granted (blueprint copies' too). One that
   * needs reconnecting (`needs_reauth`) can't be until the entry is offered
   * again. Hiding a Composio toolkit needs Composio to list it, so it is
   * `connection.provider_unavailable` while Composio isn't listed.
   * Every entry is offered until an admin says otherwise. Admins only,
   * never Grasp staff; audited.
   */
  setOffered: (
    source: CatalogSource,
    id: string,
    offered: boolean
  ) => Promise<void>;
  /**
   * The tools of one catalog entry, as `catalog` lists it: an entry that
   * isn't offered has none but for admins (`connect.catalog_entry_not_found`,
   * as for an entry there isn't).
   */
  catalogTools: (source: CatalogSource, id: string) => Promise<CatalogTool[]>;
  /**
   * Starts connecting a Composio toolkit, for an admin who consented: the
   * Composio URL to send their browser to. Composio sends it back to the
   * same callback as a provider's OAuth flow. A toolkit whose `auth` is
   * `own` is refused (`connection.own_auth_required`), and recorded.
   */
  connectToolkit: (request: {
    toolkit: string;
    /** The tools the admin allows, each by name or with its rule. */
    tools: (string | ComposioToolRule)[];
    /** Exactly {@link composioConsentText}, as the admin was shown it. */
    consent: string;
    returnTo?: string;
  }) => Promise<{ url: string }>;
  /**
   * Asks for an app the catalog doesn't have, audited. An app asked for
   * already, by its name in any case, isn't asked for again: that
   * request is returned.
   */
  requestApp: (request: AppRequestInput) => Promise<AppRequest>;
  /** The apps people asked for, latest first, at most {@link appRequestsListed}. */
  appRequests: () => Promise<AppRequest[]>;
}

// The catalog: everything an admin can connect, in one list. Native
// providers (our own connectors, whose tokens connect holds) and, next to
// them, Composio's toolkits, whose tokens sit in Composio's cloud. Each
// entry says which it is, so people can tell who holds the tokens before
// they connect anything.

/** Who carries out a catalog entry's actions: our connector, or Composio. */
export const catalogSourceSchema = z.enum(["native", "composio"]);
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

/** A Composio toolkit's slug, such as `hubspot`. */
export const composioToolkitSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);

/** One thing that can be connected. */
export interface CatalogEntry {
  source: CatalogSource;
  /** A native provider (`microsoft`), or a Composio toolkit's slug. */
  id: string;
  name: string;
  categories: string[];
  /** How many tools it has; `catalogTools` lists them. */
  toolCount: number;
  /**
   * Where its logo is, on the deployment's own origin
   * ({@link catalogLogoUrl}), or `null` when it has none: the page draws its
   * first letter. Never its provider's address: a browser loading that
   * would call outside connect, and tell the provider who looks.
   */
  logo: string | null;
  /**
   * What it is for, in its provider's words: the first sentence of its
   * description ({@link firstSentence}), or `null` when it has none.
   */
  description: string | null;
  /** Which of Grasp's kinds of app it is ({@link catalogGroupOf}). */
  group: CatalogGroup;
  /** Whose sign-in app connecting it takes ({@link CatalogAuth}). */
  auth: CatalogAuth;
}

/**
 * Whose sign-in app connecting an entry takes. `managed`: one Grasp or
 * Composio holds, so connecting needs nothing but consent; every native
 * provider is. `own`: a Composio toolkit Composio holds no app for, which
 * the organization connects only with a sign-in app of its own (its own
 * OAuth client or API key). Grasp can't take one yet, so connecting such a
 * toolkit is refused (`connection.own_auth_required`).
 */
export type CatalogAuth = "managed" | "own";

/**
 * Grasp's kinds of app, in the order the Integrations page lists them. Each
 * id is the group's English name, which the web app translates; `Other` is
 * for an app none of the others fits.
 */
export const catalogGroups = [
  "Email and calendar",
  "Files and documents",
  "Chat",
  "CRM",
  "Finance and accounting",
  "HR",
  "Signing",
  "Marketing",
  "Support",
  "Projects and tasks",
  "Forms and surveys",
  "Data and analytics",
  "AI",
  "Commerce",
  "Design and media",
  "Developer tools",
  "Other",
] as const;
export type CatalogGroup = (typeof catalogGroups)[number];

/**
 * Which group a category is in, by its words in lower case. The first
 * group that fits wins, so the order is the precedence: "payroll" is HR
 * before it is finance, "e-signature" signing before documents. These are
 * the design prototype's words for Composio's categories.
 */
const groupWords: readonly (readonly [CatalogGroup, RegExp])[] = [
  ["Signing", /signature/u],
  ["HR", /human resources|hr talent|recruit|payroll/u],
  [
    "Finance and accounting",
    /accounting|payment|invoic|tax|fundraising|banking|finance|proposal & invoice/u,
  ],
  ["CRM", /crm|contact management|sales/u],
  ["Support", /customer support|help ?desk|customer appreciation|reviews/u],
  [
    "Marketing",
    /marketing|newsletter|social media|ads|url shortener|seo|drip email|webinar/u,
  ],
  ["Email and calendar", /email|calendar|scheduling/u],
  [
    "Chat",
    /chat|communication|phone|sms|notification|video conferencing|team collaboration/u,
  ],
  ["Forms and surveys", /form|survey/u],
  [
    "Projects and tasks",
    /project|task|productivity|time tracking|event management|notes|bookmark/u,
  ],
  [
    "Files and documents",
    /document|file|spreadsheet|content|transcription|pdf/u,
  ],
  ["Data and analytics", /analytics|business intelligence|database|dashboard/u],
  ["AI", /artificial intelligence|^ai |ai$|model context protocol/u],
  ["Commerce", /commerce|fulfil|shipping|inventory/u],
  [
    "Design and media",
    /image|design|video|audio|website builder|photo|music|gaming/u,
  ],
  [
    "Developer tools",
    /developer|server|it operations|security|internet of things|devops|app builder|cloud/u,
  ],
];

/** The group one category is in, if any fits it. */
const groupOfCategory = (category: string): CatalogGroup | undefined => {
  const words = category.trim().toLowerCase();
  return groupWords.find(([, pattern]) => pattern.test(words))?.[0];
};

/**
 * The group of an app with these categories, as its provider names them
 * (Composio's, its main one first): that of the first category a group
 * fits, or `Other` when none does.
 */
export const catalogGroupOf = (categories: readonly string[]): CatalogGroup => {
  for (const category of categories) {
    const group = groupOfCategory(category);
    if (group !== undefined) {
      return group;
    }
  }
  return "Other";
};

/** Longest description a catalog entry carries: one line a row can show. */
const descriptionMaxLength = 140;

const whitespace = /\s+/gu;
/**
 * Up to the first sentence's end: a stop, possibly inside closing quotes,
 * followed by a space or the end, but not the stop of a common
 * abbreviation ("Acme Inc. makes…").
 */
const firstSentenceOf =
  /^.*?(?<!\b(?:Inc|Ltd|Co|Corp|LLC|etc|vs|e\.g|i\.e|approx|St|Dr|Mr|Mrs|Ms|No))[.!?]["'”’)]?(?= |$)/u;
const lastWord = /\s+\S*$/u;
const trailingPause = /[,;:]$/u;

/**
 * A description as a catalog entry carries it: its first sentence, its
 * whitespace collapsed, cut at a word with an ellipsis where it is longer
 * than {@link descriptionMaxLength}; `null` when nothing is left.
 */
export const firstSentence = (text: string): string | null => {
  const clean = text.replaceAll(whitespace, " ").trim();
  if (clean === "") {
    return null;
  }
  const sentence = firstSentenceOf.exec(clean)?.[0] ?? clean;
  if (sentence.length <= descriptionMaxLength) {
    return sentence;
  }
  const cut = sentence
    .slice(0, descriptionMaxLength - 2)
    .replace(lastWord, "")
    .replace(trailingPause, "");
  return `${cut}…`;
};

/**
 * Where core serves catalog entries' logos, which connect fetches from
 * their provider and checks (`ConnectApi.catalogLogo`).
 */
export const catalogLogoPath = "/api/catalog/logos";

/** Where one catalog entry's logo is served. */
export const catalogLogoUrl = (source: CatalogSource, id: string): string =>
  `${catalogLogoPath}/${source}/${encodeURIComponent(id)}`;

/**
 * A catalog entry's logo, as connect hands it to core: an image, of
 * `contentType`, which connect has checked is what its bytes are.
 */
export interface CatalogLogo {
  contentType: CatalogLogoType;
  bytes: Uint8Array;
}

/** The image types a catalog logo may be. */
export const catalogLogoTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;
export type CatalogLogoType = (typeof catalogLogoTypes)[number];

/**
 * The catalog, native entries first. `composio` says whether Composio's
 * toolkits are in it: `listed`, `off` (connect has no Composio key), or `unavailable` (Composio didn't answer,
 * or not completely: the native entries are listed all the same). Listed
 * are the toolkits that have tools and take an account, whether Composio
 * holds an app for them or not (`auth`).
 */
export interface Catalog {
  entries: CatalogEntry[];
  composio: "listed" | "off" | "unavailable";
}

/** The catalog as core hands it out: each entry says whether it is offered. */
export interface OfferedCatalog extends Catalog {
  entries: (CatalogEntry & { offered: boolean })[];
}

/** One tool of a catalog entry. */
export interface CatalogTool {
  /** The action a call names, exactly. */
  name: string;
  description: string | null;
  /**
   * The properties its input takes, as its provider declares them: the
   * input property that names a Composio tool's resource is one of these.
   */
  inputs: string[];
  /**
   * Whether its provider declares that it only reads. A native tool's
   * manifest says so and connect goes by it. A Composio tool's is only a
   * hint (its `readOnlyHint` tag), the default for the admin's own choice
   * (`ComposioToolRule.read`): a tool without the hint counts as one that
   * changes things.
   */
  readOnly: boolean;
}

/**
 * What an admin consents to before connecting a Composio toolkit: shown to
 * them word for word, sent back with the request, and recorded (as its
 * SHA-256) with who consented, in the audit log. Changing it changes what
 * the next consent records.
 */
export const composioConsentText =
  "Composio, a third party, will hold this connection's tokens in its own cloud, outside this deployment, and Grasp won't see them. Grasp calls only the tools you allow, through Composio, which acts for your organization with those tokens. Disconnecting deletes the account at Composio.";

/** Most tools an admin may allow on one Composio connection. */
export const composioToolsMax = 1000;

/**
 * What the admin says about one tool they allow on a Composio connection,
 * in place of anything its server declares (threat model CN16): whether a
 * call of it only reads (`read`; otherwise it is a side effect, held for
 * its person as every write is), and which input property names the one
 * resource a call of it acts on (`resource`; otherwise it can't be called
 * for one resource).
 */
export const composioToolRuleSchema = z.strictObject({
  name: permissionActionSchema,
  read: z.boolean().optional(),
  /** A plain property name, one the tool's input takes. */
  resource: z
    .string()
    .regex(/^[A-Za-z_]\w{0,127}$/u)
    .optional(),
});
export type ComposioToolRule = z.infer<typeof composioToolRuleSchema>;

/** One allowed tool: by name alone (a side effect, no resource), or its rule. */
const composioToolSchema = z.union([
  permissionActionSchema,
  composioToolRuleSchema,
]);

/** The name of an allowed tool, however it was given. */
export const composioToolName = (
  tool: z.infer<typeof composioToolSchema>
): string => (typeof tool === "string" ? tool : tool.name);

/**
 * The tools an admin allows on a Composio connection, once each: names a
 * call can name as its action, each alone or with its rule.
 */
export const composioToolsSchema = z
  .array(composioToolSchema)
  .min(1)
  .max(composioToolsMax)
  .refine(
    (tools) => new Set(tools.map(composioToolName)).size === tools.length,
    { message: "Each tool once" }
  );

/**
 * Starts connecting a Composio toolkit as a shared connection, for an
 * admin who consented to Composio holding its tokens.
 */
export const startToolkitConnectionSchema = z.strictObject({
  person: connectionPersonSchema,
  toolkit: composioToolkitSchema,
  tools: composioToolsSchema,
  /** Exactly {@link composioConsentText}, as the admin was shown it. */
  consent: z.string().refine((text) => text === composioConsentText),
  /** The deployment's origin, from its config: Composio returns there. */
  origin: z.url(),
  /** A path on the deployment's origin; core checks it. */
  returnTo: z.string().startsWith("/").max(returnPathMaxLength),
});
export type StartToolkitConnection = z.input<
  typeof startToolkitConnectionSchema
>;

/** Lists one entry's tools. */
export const catalogToolsRequestSchema = z.strictObject({
  source: catalogSourceSchema,
  id: identifierSchema,
});
export type CatalogToolsRequest = z.input<typeof catalogToolsRequestSchema>;

export const catalogLogoRequestSchema = catalogToolsRequestSchema;
export type CatalogLogoRequest = CatalogToolsRequest;

// Side effects held for their person (threat model R7, R12). Connect
// holds a side effect from chat, from a person using an App, or from any
// context that read restricted data, until the person it acts for confirms
// it on a view of the exact input it will run with; confirming runs that
// input, once; declining drops it. Core names the person from their
// session, as for connecting accounts, and signs the confirmed call's
// capability after checking the permission and the context again.

/**
 * A held action as its tool describes it (a native connector's `describe`),
 * for the person to read before they decide: what it does, and the parts
 * of its input that matter. Nothing here is summarised or reworded: each
 * value is the input's own.
 */
export interface ActionDescription {
  /** What the action does, such as "Send an email". */
  title: string;
  /**
   * The input's properties the tool shows, those the input holds, each
   * (`input`, once) under its label: a string as it is, a list of strings
   * as it is, any other value as its JSON text.
   */
  fields: { input: string; label: string; value: string | string[] }[];
  /**
   * Whether `fields` show every property the input holds. When not, say
   * so: the exact input (`PendingAction.input`) holds more.
   */
  complete: boolean;
}

/** A held action, as the person it waits for sees it. */
export interface PendingAction {
  id: string;
  /** The App or agent that asked for it. */
  subject: CodeSubject;
  /** For an App's code: the version that asked. */
  appVersion: number | null;
  /** Asked for with the person there, or by a workflow run. */
  mode: "interactive" | "workflow";
  /** The chat, App or run it came from. */
  context: WorkContext;
  /**
   * Asked for by a chat, App or run that had read restricted data, or, as
   * core lists it, from one that has read restricted data by now: what it
   * sends out may carry that data. Show the person a warning; the
   * confirmation and its events record it.
   */
  restricted: boolean;
  /** The permission that allowed it. */
  permissionId: string;
  connectionId: string;
  /**
   * The connection as people know it, by what it reaches and its account,
   * such as "Microsoft 365 (anna@acme.test)"; a Composio connection by its
   * toolkit's slug, whatever that is, never by a native connector's name.
   * `null` when connect no longer has the connection.
   */
  connectionName: string | null;
  resource: string | null;
  action: string;
  /**
   * The call as its tool describes it. Absent for a tool that describes
   * none (every Composio tool): show the action's name and `input`.
   */
  description?: ActionDescription;
  /** The key its answer is kept under: a repeat of the call gets it. */
  idempotencyKey: string;
  /**
   * The exact input it runs with once confirmed, as JSON text: always
   * there for the person to see, whatever `description` shows.
   */
  input: string;
  /**
   * SHA-256 of its resource and input: confirming names it, so only what
   * the person was shown runs.
   */
  inputHash: string;
  /** ISO 8601. */
  requestedAt: string;
  /**
   * The App's approved resource binding it came through, as it served then
   * (`HeldBinding`); null for any other call; `unreadable` when what connect
   * stored no longer reads as one, which core never confirms.
   */
  binding: HeldBinding | "unreadable" | null;
}

const inputHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** Runs a held action its person confirmed, with core's capability for it. */
export const confirmActionSchema = z.strictObject({
  capability: z.unknown(),
  person: connectionPersonSchema,
  id: z.uuid(),
  inputHash: inputHashSchema,
});
export type ConfirmAction = z.input<typeof confirmActionSchema>;

/** Drops a held action its person declined. */
export const declineActionSchema = z.strictObject({
  person: connectionPersonSchema,
  id: z.uuid(),
});
export type DeclineAction = z.input<typeof declineActionSchema>;

/** Every held action of one chat, for the person it waits for. */
export const declineChatActionsSchema = z.strictObject({
  person: connectionPersonSchema,
  /** The Workspace object that holds the chat, as its context names it. */
  workspaceId: workspaceIdSchema,
  chatId: chatIdSchema,
});
export type DeclineChatActions = z.input<typeof declineChatActionsSchema>;

/** One held action, for the person it waits for. */
export const heldRequestSchema = z.strictObject({
  person: connectionPersonSchema,
  id: z.uuid(),
});
export type HeldRequest = z.input<typeof heldRequestSchema>;

/**
 * Which call a held action of a chat was, for the chat's agent, which has
 * only the ID the call was answered with: core names the agent, its person
 * and the chat from the chat's own scope.
 */
export const heldCallRequestSchema = z.strictObject({
  agentId: identifierSchema,
  onBehalfOf: identifierSchema,
  /** The Workspace object that holds the chat, as its context names it. */
  workspaceId: workspaceIdSchema,
  chatId: chatIdSchema,
  id: z.uuid(),
});
export type HeldCallRequest = z.input<typeof heldCallRequestSchema>;

/**
 * The call a held action was, as far as authorising it again takes: the
 * connection, the one resource its capability named (`null` for the whole
 * connection), the action, and the key connect made for it. Never its
 * input.
 */
export interface HeldCall {
  connectionId: string;
  resource: string | null;
  action: string;
  idempotencyKey: string;
}

/**
 * Reads how a held call ended: the call as `HeldCall` names it, with the
 * capability core made for exactly that call, as for carrying it out.
 */
export const heldOutcomeRequestSchema = connectCallSchema
  .omit({ input: true, stamp: true })
  .required({ idempotencyKey: true });
export type HeldOutcomeRequest = z.input<typeof heldOutcomeRequestSchema>;

/**
 * What became of a held action: it still waits for its person (or is being
 * carried out now); they declined it, or it was dropped; it ran and
 * answered (`done`); it was sent and nobody can tell whether it took
 * effect (`unknown`: it may have been carried out, and is never sent
 * again blindly under its key); its person said what became of such a
 * call (`resolved`: `connect.resolved_done`, it took effect and is never
 * sent again; `connect.resolved_not_done`, it didn't, and may be sent once
 * more); or it didn't end well (`failed`: `reason` is the error's code,
 * and `output` what the tool said, for a tool's own error).
 */
export type HeldOutcome =
  | { state: "waiting" }
  | { state: "declined" }
  | { state: "done"; result: ConnectResult }
  | { state: "unknown"; reason: "connect.outcome_unknown" }
  | {
      state: "resolved";
      reason: "connect.resolved_done" | "connect.resolved_not_done";
    }
  | { state: "failed"; reason: string; output: string | null };

/** Workflow runs that have ended, each with its App: at most 50. */
export const endedRunsSchema = z.strictObject({
  runs: z
    .array(
      z.union([
        // An App's run.
        z.strictObject({ appId: identifierSchema, runId: identifierSchema }),
        // A run of an independent workflow (a restricted one's).
        z.strictObject({
          workflowId: identifierSchema,
          runId: identifierSchema,
        }),
      ])
    )
    .max(50),
});
export type EndedRuns = z.input<typeof endedRunsSchema>;

/** A confirmation core refused, with why, for the audit log. */
export const refuseConfirmationSchema = z.strictObject({
  person: connectionPersonSchema,
  id: z.uuid(),
  /** An error code, such as `permission.denied`: never free text. */
  reason: z
    .string()
    .regex(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/u)
    .max(64),
});
export type RefuseConfirmation = z.input<typeof refuseConfirmationSchema>;

/** The held side effects of one workflow run's step, by the step's key. */
export const pendingKeySchema = z.strictObject({
  onBehalfOf: identifierSchema,
  idempotencyKey: identifierSchema,
  /**
   * Count a call of unknown outcome connect could recover now as waiting
   * too: past a hold's deadline, nothing is recovered on its own.
   */
  orRecoverable: z.literal(true).optional(),
});
export type PendingKey = z.input<typeof pendingKeySchema>;

/**
 * The held actions waiting for a signed-in person, over `/rpc`: only
 * their own. Grasp staff have none, and decide none.
 */
export interface PendingActionsApi {
  list: () => Promise<PendingAction[]>;
  /**
   * Runs the held action `id`, with the input whose hash is `inputHash`,
   * once: its answer, as the call would have had it. A chat's agent is
   * told, on its next turn, that its action ran, or failed once confirmed.
   */
  confirm: (id: string, inputHash: string) => Promise<ConnectResult>;
  /**
   * Drops the held action `id`: it never runs. A chat's agent is told so
   * on its next turn.
   */
  decline: (id: string) => Promise<void>;
}

// Calls of unknown outcome (spec 14.3). A side effect sent whose answer
// was lost, and that connect couldn't recover, is an open obligation of
// the person it acted for: connect lists it for them, with what was sent,
// and they say what became of it, once they have looked. "It happened"
// keeps its key spent for good, answering every repeat with
// `connect.resolved_done`; "it didn't happen" frees its key for exactly one
// more send of the same input. Core signs the resolution's capability only
// while the call's permission still holds, as for confirming a held
// action; connect records it, and never says anything was undone.

/** What the person a call acted for says became of its unknown outcome. */
export const resolutionChoiceSchema = z.enum(["happened", "not_happened"]);
export type ResolutionChoice = z.infer<typeof resolutionChoiceSchema>;

/** The call of unknown outcome: whose, where, and the key it was sent under. */
export const unknownOutcomeKeySchema = z.strictObject({
  subject: codeSubjectSchema,
  connectionId: connectionIdSchema,
  action: permissionActionSchema,
  idempotencyKey: identifierSchema,
});
export type UnknownOutcomeKey = z.infer<typeof unknownOutcomeKeySchema>;

/** One call of unknown outcome, for the person it acted for. */
export const unknownOutcomeRequestSchema = z.strictObject({
  person: connectionPersonSchema,
  key: unknownOutcomeKeySchema,
});
export type UnknownOutcomeRequest = z.input<typeof unknownOutcomeRequestSchema>;

/** Resolves a call of unknown outcome, with core's capability for it. */
export const resolveOutcomeSchema = z.strictObject({
  capability: z.unknown(),
  person: connectionPersonSchema,
  key: unknownOutcomeKeySchema,
  choice: resolutionChoiceSchema,
});
export type ResolveOutcome = z.input<typeof resolveOutcomeSchema>;

/** A resolution core refused, with why, for the audit log. */
export const refuseResolutionSchema = z.strictObject({
  person: connectionPersonSchema,
  key: unknownOutcomeKeySchema,
  choice: resolutionChoiceSchema,
  /** An error code, such as `permission.denied`: never free text. */
  reason: z
    .string()
    .regex(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/u)
    .max(64),
});
export type RefuseResolution = z.input<typeof refuseResolutionSchema>;

/**
 * Where a call of unknown outcome came from, as its capability said: what
 * core checks again before it signs a resolution of it.
 */
export interface UnknownOutcomeOrigin {
  mode: "interactive" | "workflow";
  appVersion: number | null;
  permissionId: string;
  context: WorkContext;
  /** The App's resource binding it came through, as `PendingAction.binding`. */
  binding?: HeldBinding;
}

/** A call of unknown outcome, as the person it acted for sees it. */
export interface UnknownOutcome {
  key: UnknownOutcomeKey;
  /** As `PendingAction.connectionName`. */
  connectionName: string | null;
  resource: string | null;
  /** As `PendingAction.description`, of the input it was sent with. */
  description?: ActionDescription;
  /** The exact input it was sent with, as JSON text, while connect has it. */
  input: string | null;
  /** When it was first sent, ISO 8601. */
  sentAt: string;
  /**
   * Which claim of its key this is, in milliseconds: a resolution names it,
   * so it applies to this send only, never to one sent again since.
   */
  claim: number;
  /** Null for a call whose origin connect doesn't have: it can't be resolved. */
  origin: UnknownOutcomeOrigin | null;
  /** Where the list goes on after it: the next page is `before` it. */
  cursor: UnknownOutcomeCursor;
}

/** Most calls of unknown outcome one list answers: the newest. */
export const unknownOutcomeListLimit = 200;

/**
 * Where a list of calls of unknown outcome goes on: when the call was
 * first sent, in milliseconds, and its random list ID; never its key,
 * which App code chooses, nor anything counting other calls. A list
 * `before` one answers the calls listed after it, newest first.
 */
export const unknownOutcomeCursorSchema = z
  .string()
  .regex(/^\d{1,15}\.[0-9a-f-]{0,36}$/u);
export type UnknownOutcomeCursor = z.infer<typeof unknownOutcomeCursorSchema>;

/**
 * A call of unknown outcome as an organization's admin sees it, to follow
 * up with the person it acted for: whose it is, what and where, and when.
 * Never what was sent, nor its key (App code chooses keys), its claim or
 * its origin: only that person resolves it, and only they see its input.
 */
export interface UnknownOutcomeListing {
  /**
   * Its receipt, as the audit log's events of the call and of its
   * resolution name it: a SHA-256 of its effect key, never the key.
   */
  effectKeyHash: string;
  /**
   * For telling rows apart, unique across every page: a digest of what
   * the listing shows anyway and the call's random list ID, never of its
   * key.
   */
  id: string;
  /** The person it acted for: theirs to resolve. */
  onBehalfOf: string;
  subject: CodeSubject;
  connectionId: string;
  /** As `PendingAction.connectionName`. */
  connectionName: string | null;
  action: string;
  /** What the action does, as its tool names it, such as "Send an email". */
  title?: string;
  resource: string | null;
  /** When it was first sent, ISO 8601. */
  sentAt: string;
  /** As `UnknownOutcome.cursor`. */
  cursor: UnknownOutcomeCursor;
}

/**
 * The calls of unknown outcome of a signed-in person, over `/rpc`: only
 * their own. Grasp staff have none, and resolve none.
 */
export interface UnknownOutcomesApi {
  /**
   * The person's own, newest first, at most {@link unknownOutcomeListLimit}
   * a page: a full page goes on `before` its last one's `cursor`.
   */
  list: (before?: UnknownOutcomeCursor) => Promise<UnknownOutcome[]>;
  /**
   * Every person's open calls of unknown outcome, newest first, paged as
   * `list` is, for the organization's own admins only (never Grasp staff),
   * to follow up with each call's person: read only, as
   * `UnknownOutcomeListing` shows them. An admin resolves only their own,
   * with `resolve`.
   */
  listAll: (before?: UnknownOutcomeCursor) => Promise<UnknownOutcomeListing[]>;
  /**
   * Says what became of the call `key` names: `happened` keeps it from
   * ever being sent again; `not_happened` lets it be sent once more, with
   * the same input, under the same key. Refused once the call's permission
   * is gone. `claim` is the call's `UnknownOutcome.claim`, as shown: one
   * sent again since, and lost again, is another call to decide on.
   */
  resolve: (
    key: UnknownOutcomeKey,
    choice: ResolutionChoice,
    claim: number
  ) => Promise<void>;
}

/**
 * The event types connections report, each with the connector's read
 * action whose data it carries: an App hears one only through a
 * permission that allows that action (core's
 * workflows/connector-events.ts). Connect reads them (its events.ts).
 */
export const connectorEventActions = {
  "m365.mail.received": "mail.list",
  "m365.file.created": "files.list",
  "google.mail.received": "mail.list",
  "google.file.created": "files.list",
} as const satisfies Record<string, string>;

/** An event type a connection reports. */
export type ConnectorEventType = keyof typeof connectorEventActions;

/** Most listeners core sends connect at once (`syncEventSources`). */
export const eventListenersMax = 5000;

/**
 * Who listens for events of `type` on a connection: an App whose current
 * version has an event trigger for `type` and holds an active
 * permission on the connection that allows the type's read action
 * (`connectorEventActions`), from a version an admin approved. The
 * permission is on the whole connection (`resource` null) or on one
 * resource of it (a mailbox, a drive). `owner` is the App's owner, whom
 * its triggered runs act for. On a personal connection connect listens
 * only for its owner's Apps; core checks each event again as it delivers
 * it.
 */
export const eventListenerSchema = z.strictObject({
  type: eventTypeSchema,
  connection: connectionIdSchema,
  resource: identifierSchema.nullable(),
  owner: identifierSchema,
});
export type EventListener = z.infer<typeof eventListenerSchema>;

export const eventListenersSchema = z
  .array(eventListenerSchema)
  .max(eventListenersMax);

/** Most connector events connect hands core at once. */
export const connectorEventsTakeMax = 100;

/** A connector event waiting in connect's outbox: the event as JSON. */
export interface OutboxedConnectorEvent {
  id: string;
  event: string;
}

/**
 * What core settles of the events it took: those it delivered (`done`,
 * removed), those whose delivery failed (`failed`, tried again later), and
 * those that will never be taken (`rejected`: not an event core takes,
 * removed and recorded in the audit log).
 */
export const connectorEventsAckSchema = z
  .strictObject({
    done: z.array(z.uuid()),
    failed: z.array(z.uuid()),
    rejected: z.array(z.uuid()).default([]),
  })
  .refine(
    ({ done, failed, rejected }) =>
      done.length + failed.length + rejected.length <= connectorEventsTakeMax,
    { message: `At most ${connectorEventsTakeMax} events` }
  );
export type ConnectorEventsAck = z.input<typeof connectorEventsAckSchema>;

/**
 * What core reaches in connect, over the `CONNECT` service binding: the
 * npm registry among the rest (`PackageRegistryApi`).
 */
export interface ConnectApi extends PackageRegistryApi {
  call: (call: ConnectCall) => Promise<ConnectResult>;
  /** The provider URL to send the person's browser to. */
  startConnection: (request: StartConnection) => Promise<{ url: string }>;
  /**
   * Finishes a flow the same person started: the new connection, or the
   * one that needed connecting again (`needs_reauth`) and holds the account
   * the flow came back with, which keeps its ID and its permissions. That
   * one only for its owner, or, if shared, an admin; anyone else, or any
   * other connection holding the account, is `connection.already_connected`.
   */
  finishConnection: (
    request: FinishConnection
  ) => Promise<{ connectionId: string; returnTo: string }>;
  /**
   * Connects an app that signs in with an API key, once the app accepted
   * the key: the new connection, or the one that needed connecting again
   * and holds the same account, as `finishConnection` has it.
   */
  connectWithKey: (
    request: ConnectWithKey
  ) => Promise<{ connectionId: string }>;
  /** The person's own connections and the shared ones. */
  listConnections: (person: ConnectionPerson) => Promise<ConnectionSummary[]>;
  /**
   * Every connection that isn't disconnected, for core's staff-only admin
   * snapshot, with Composio asked whether each Composio account still
   * works: nothing in it is a token or a URL.
   */
  organizationConnections: () => Promise<OrganizationConnection[]>;
  /**
   * Whose each of the connections `connectionIds` names is, disconnected
   * ones too: those that were ever registered, in no particular order.
   * Core checks against it that sharing an App reaches nobody who can't
   * read what the App read.
   */
  connectionOwners: (
    connectionIds: readonly string[]
  ) => Promise<ConnectionOwner[]>;
  /**
   * Deletes the connection's tokens, revoking them at the provider where it
   * can (`revoked`); the connection takes no more calls.
   */
  disconnect: (request: Disconnect) => Promise<{ revoked: boolean }>;
  /**
   * Disconnects every personal connection of someone an admin removed from
   * the organization, as `disconnect` does each one, and spends the flows
   * they still have open. Admins only, or core itself (`person` null); core
   * calls it only for people it removed. Returns how many it stopped.
   */
  disconnectPersonal: (
    request: DisconnectPersonal
  ) => Promise<{ disconnected: number }>;
  /**
   * Spends a flow that came back but can't finish (no session, say), so its
   * code can't be brought back to finish it later.
   */
  abandonFlow: (state: string) => Promise<void>;
  /**
   * The catalog: the native providers, then Composio's toolkits if
   * connect has a Composio key. Composio failing to answer leaves the
   * native entries listed.
   */
  catalog: () => Promise<Catalog>;
  /**
   * Starts connecting a Composio toolkit for an admin who consented, and
   * records their consent: the Composio URL to send their browser to.
   * `finishConnection` finishes it, as it does an OAuth flow, once
   * Composio sends the browser back. One whose `auth` is `own` is refused
   * and recorded before anything is made at Composio
   * (`connection.own_auth_required`).
   */
  startToolkitConnection: (
    request: StartToolkitConnection
  ) => Promise<{ url: string }>;
  /**
   * One catalog entry's tools, or `connect.catalog_entry_not_found` for
   * anything `catalog` doesn't list. Composio's toolkits are listed only if
   * `composio` and connect has a Composio key, and only those that have
   * tools and take an account. `connect.catalog_unavailable` when
   * Composio doesn't list the catalog or the toolkit's tools completely.
   */
  catalogTools: (request: CatalogToolsRequest) => Promise<CatalogTool[]>;
  /**
   * One catalog entry's logo, fetched from its provider and checked, or
   * `null` when the catalog lists none for it, or its provider's isn't
   * an image connect serves (`catalogLogoTypes`, size-capped) or doesn't
   * come.
   */
  catalogLogo: (request: CatalogLogoRequest) => Promise<CatalogLogo | null>;
  /**
   * The generated contract `contract` names as the connection
   * `connectionId` serves it now, each action with the JSON Schemas of its
   * input and output. A native connection serves `<connector>.<family>@1`,
   * its connector's actions of that family, read from the release's
   * manifests: nothing is loaded and no token is read. A Composio
   * connection serves `composio.<toolkit>@1`, its own toolkit's allowed
   * tools, as its server lists them now. `connect.contract_not_found` for
   * any other contract, or one with no actions it can serve;
   * `connect.server_unavailable` when a Composio server can't be reached
   * to read it.
   */
  connectorContract: (
    request: ConnectorContractRequest
  ) => Promise<ConnectorContract>;
  /**
   * The held actions waiting for `person`, newest first (at most 200):
   * none for Grasp staff.
   */
  listPendingActions: (person: ConnectionPerson) => Promise<PendingAction[]>;
  /** One held action waiting for the person, or `null`. */
  pendingAction: (request: HeldRequest) => Promise<PendingAction | null>;
  /**
   * Which call a held action was, for the chat whose agent asked for it,
   * by the ID its call was answered with: `connect.pending_not_found` for
   * any other chat, agent or person, as for an ID there never was, and for
   * an action held under a key of its caller's.
   */
  heldCall: (request: HeldCallRequest) => Promise<HeldCall>;
  /**
   * How a held call ended, for a caller core authorised for that call as
   * it would be now: its capability is checked as any call's. Recorded as
   * a call.
   */
  heldOutcome: (request: HeldOutcomeRequest) => Promise<HeldOutcome>;
  /**
   * Drops a workflow run's held action whose run has ended, found when its
   * person came to confirm it.
   */
  dropForEndedRun: (request: HeldRequest) => Promise<void>;
  /**
   * Drops every held action of the workflow runs `runs`, which have ended
   * for their retention (core's src/workflows/retention.ts): nothing may
   * keep their inputs past it. Dropping again drops nothing.
   */
  dropForEndedRuns: (request: EndedRuns) => Promise<void>;
  /**
   * Drops every held action an App's calls made through resource binding
   * `bindingId`, once core revoked or replaced it: none of them could run.
   * Recorded as `connection.action.dropped`, reason `binding.revoked`.
   */
  dropForBinding: (request: BindingDropRequest) => Promise<void>;
  /**
   * Drops one held action of `person`'s that came through a resource
   * binding core refused to confirm because the binding no longer serves
   * it. Its key stays free. Recorded, reason `binding.stale`.
   */
  dropStaleBinding: (request: HeldRequest) => Promise<void>;
  /**
   * Runs a held action its person confirmed: only with the capability core
   * signed for confirming it, and only for that person.
   */
  confirmAction: (request: ConfirmAction) => Promise<ConnectResult>;
  /** Drops a held action its person declined. */
  declineAction: (request: DeclineAction) => Promise<void>;
  /**
   * Declines every held action of one chat waiting for the person, each
   * recorded as `declineAction` records it, however many there are (a
   * chat being deleted): how many it declined.
   */
  declineChatActions: (request: DeclineChatActions) => Promise<number>;
  /**
   * Whether any side effect with idempotency key `idempotencyKey`, acting
   * for `onBehalfOf`, still waits for that person: held for them, or of
   * unknown outcome, unresolved and not recoverable now. A workflow run
   * waits before running a step whose side effect was held again.
   */
  anyPending: (request: PendingKey) => Promise<boolean>;
  /**
   * The calls of unknown outcome that acted for `person`, newest first (at
   * most 200 a page, the next `before` the last one's cursor), those
   * connect may still recover on its own included: none for Grasp staff.
   */
  listUnknownOutcomes: (
    person: ConnectionPerson,
    before?: UnknownOutcomeCursor
  ) => Promise<UnknownOutcome[]>;
  /**
   * Every person's calls of unknown outcome, newest first, paged as
   * `listUnknownOutcomes` is, as an admin sees them: for `admin`, one of
   * the organization's own admins as core read them now, never Grasp
   * staff; refused to anyone else.
   */
  listAllUnknownOutcomes: (
    admin: ConnectionPerson,
    before?: UnknownOutcomeCursor
  ) => Promise<UnknownOutcomeListing[]>;
  /** One call of unknown outcome of the person's, or `null`. */
  unknownOutcome: (
    request: UnknownOutcomeRequest
  ) => Promise<UnknownOutcome | null>;
  /**
   * Resolves a call of unknown outcome its person resolved: only with the
   * capability core signed for that resolution, and only for that person.
   * Recorded as `connection.call.resolved`.
   */
  resolveOutcome: (request: ResolveOutcome) => Promise<void>;
  /** Records a resolution core refused before it reached connect. */
  refuseResolution: (request: RefuseResolution) => Promise<void>;
  /**
   * Records a confirmation core refused before it reached connect (the
   * permission is gone, the person has left, the context is invalid): the
   * held action keeps waiting.
   */
  refuseConfirmation: (request: RefuseConfirmation) => Promise<void>;
  /**
   * The oldest audit events connect recorded that core hasn't acknowledged,
   * in the order they were stored, at most `auditOutboxTakeMax`. Taking
   * removes nothing: events core took but didn't acknowledge are taken
   * again, so core appends each at least once, and the log keeps it once.
   */
  takeAuditEvents: () => Promise<OutboxedAuditEvent[]>;
  /**
   * Settles taken events by ID: removes those core appended to the audit
   * log, and moves those the log can't take to `audit_outbox_rejected`,
   * with why. At most `auditOutboxTakeMax` in all; IDs already settled are
   * ignored.
   */
  ackAuditEvents: (
    appended: readonly string[],
    rejected?: readonly OutboxRejected[]
  ) => Promise<void>;
  /**
   * Listens for events where `listeners` say, and only there: starts
   * listening where it didn't, stops where no listener is left, then reads
   * what changed at the sources that are due, into the event outbox. Core
   * sends every listener each time, so a workflow removed, a version made
   * current without the trigger, or a permission revoked stops its
   * listening at the next call.
   */
  syncEventSources: (listeners: readonly EventListener[]) => Promise<void>;
  /**
   * The oldest connector events due for delivery, at most
   * `connectorEventsTakeMax`. Taking removes nothing: core settles them
   * with `ackConnectorEvents`.
   */
  takeConnectorEvents: () => Promise<OutboxedConnectorEvent[]>;
  /** Settles taken events; IDs already settled are ignored. */
  ackConnectorEvents: (ack: ConnectorEventsAck) => Promise<void>;
}

/** Why connecting or disconnecting an account didn't work. */
export const connectionErrors = defineErrorFamily({
  "connection.invalid": "That isn't a valid connection request.",
  "connection.provider_unavailable":
    "Connecting this provider isn't set up for this deployment.",
  "connection.flow_invalid":
    "This connection attempt has expired, was already used, or was started by someone else. Start again.",
  "connection.provider_refused":
    "The provider didn't complete the connection. Start again.",
  "connection.wrong_account":
    "That account isn't in your organization. Connect an account of your organization.",
  "connection.refresh_failed":
    "The provider didn't renew this connection's access. Try again shortly.",
  "connection.already_connected":
    "That account is already connected here. Disconnect it first to connect it again.",
  "connection.not_own_account":
    "A personal connection must be to your own account, the one you sign in with.",
  "connection.staff_not_allowed":
    "Grasp staff can't connect accounts in a client's deployment.",
  "connection.not_offered":
    "Your organization doesn't offer this connection. An admin can offer it.",
  "connection.scopes_refused":
    "The provider granted more or less access than this connection asks for, so it wasn't kept. Connect it with Grasp's landscape app, granting exactly what it asks.",
  "connection.own_auth_required":
    "Composio holds no sign-in app for this one: connecting it needs your organization's own, which Grasp can't take yet.",
});

/** Which App's held actions of which binding to drop. */
export const bindingDropRequestSchema = z.strictObject({
  appId: identifierSchema,
  bindingId: identifierSchema,
});
export type BindingDropRequest = z.input<typeof bindingDropRequestSchema>;

// Generated connector contracts (spec 12): what an App's connector
// resource is bound to. A native connector's actions of one family (its
// tools named `<family>.<action>`, such as `mail.send`) make the contract
// `<connector>.<family>@1`, whose shape is the tools' own input and output
// schemas. A Composio connection's allowed tools make `composio.<toolkit>@1`
// (a toolkit slug that starts with a letter), whose shape is what its
// server lists now. Core fingerprints what it gets, so a connector release,
// or Composio, changing any of it is a drifted contract an admin approves
// again.

/**
 * A generated contract's ID: `<connector>.<family>@<major>`, or
 * `composio.<toolkit>@1`.
 */
export const connectorContractIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9_-]{0,62}@[1-9]\d{0,5}$/u);

/** Which contract to read, and the connection that must serve it. */
export const connectorContractRequestSchema = z.strictObject({
  contract: connectorContractIdSchema,
  connectionId: connectionIdSchema,
});
export type ConnectorContractRequest = z.input<
  typeof connectorContractRequestSchema
>;

/** One action of a generated contract. */
export interface ConnectorContractAction {
  /** The tool a call of it names, e.g. `mail.send`. */
  tool: string;
  /**
   * Whether it only reads: as a native connector declares, or as the
   * admin's rule for a Composio tool says (never Composio's hint).
   */
  readOnly: boolean;
  /**
   * The JSON Schemas of its input and output, as the connector makes them
   * or a Composio server lists them (closed, composio-contracts.ts), each
   * as JSON text: a type for any JSON value is too deep for the RPC types
   * to follow.
   */
  input: string;
  output: string;
}

/** A generated contract, as connect serves it now. */
export interface ConnectorContract {
  contract: string;
  /**
   * Each action, by its name in the contract: `send`, not `mail.send`, for
   * a native one; its tool, such as `HUBSPOT_LIST_CONTACTS`, for Composio.
   */
  actions: Record<string, ConnectorContractAction>;
}

/** Why connect refused or couldn't finish a call, other than its capability. */
export const connectErrors = defineErrorFamily({
  "connect.invalid":
    "That isn't a valid call: an action name, JSON input and options.",
  "connect.connection_not_found": "There's no such connection.",
  "connect.connection_inactive":
    "This connection isn't active: it needs to be connected again.",
  "connect.not_owner":
    "This is someone's personal connection: only calls for its owner can use it.",
  "connect.action_not_found": "This connection has no such action.",
  "connect.contract_not_found":
    "This connection doesn't serve that contract: it isn't a connection of that connector or toolkit, or it has no such actions to serve.",
  "connect.input_too_large": "This call's input is too large.",
  "connect.resource_out_of_scope":
    "This call reaches beyond the one resource it may use.",
  "connect.idempotency_key_required":
    "This action has a side effect, so it needs an idempotency key.",
  "connect.read_only":
    "This call may only read, and this action may change something, so it wasn't run.",
  "connect.idempotency_conflict":
    "This idempotency key was already used with a different input.",
  "connect.answer_not_kept":
    "A call with this idempotency key already ran, but its answer is no longer kept, so it won't run again.",
  "connect.call_in_progress":
    "A call with this idempotency key is still running. Try again shortly.",
  "connect.outcome_unknown":
    "A call with this idempotency key was interrupted after it was sent, so it may or may not have taken effect. It won't be sent again blindly: where its connector can find what it did, or can't do it twice, trying again later (after `retryAfterSeconds`, when given) recovers it; otherwise check the outside system to see whether it did.",
  "connect.outcome_unknown_unresolved":
    "A call of this step was interrupted after it was sent, so it may or may not have taken effect, and the person it acted for didn't say what became of it in time: the step stopped waiting. It's still theirs to resolve.",
  "connect.resolved_done":
    "A call with this idempotency key was interrupted after it was sent, and the person it acted for said it took effect: it won't be sent again, and what it returned isn't known.",
  "connect.resolved_not_done":
    "A call with this idempotency key was interrupted after it was sent, and the person it acted for said it didn't take effect: it may be sent once more, with the same input.",
  "connect.outcome_not_kept":
    "What this call sent is no longer kept, so nobody can read what saying it didn't happen would let go out again: only that it happened can be said.",
  "connect.outcome_not_found":
    "There's no call of unknown outcome like that for you to resolve: it was resolved or recovered, or it isn't yours.",
  "connect.action_failed": "The action reported an error.",
  "connect.pending_not_found":
    "There's no such action waiting for you: it was confirmed or declined, or it isn't yours.",
  "connect.pending_changed":
    "This isn't the action you were shown, so nothing was done. Look at it again.",
  "connect.held":
    "This action waits for the person it acts for to confirm it. Try again once they have.",
  "connect.run_ended":
    "The workflow run this action was held for has ended, so it was dropped and won't run.",
  "connect.declined":
    "The person this action acts for declined it, or it was dropped when its connection or person went, so it won't run.",
  "connect.connection_changed":
    "This connection now reaches another account than when the action was asked for, so it wasn't run.",
  "connect.server_unavailable":
    "The connection's server didn't take the call, so nothing was done.",
  "connect.catalog_entry_not_found": "There's no such entry in the catalog.",
  "connect.catalog_unavailable":
    "Composio's toolkits can't be listed right now. Try again shortly.",
});

/**
 * An error of a held action's confirmation that came after connect took the
 * action (`confirmAction`), so it no longer waits and it failed: marked in
 * its details, which cross RPC with it. A refusal before connect took it,
 * which leaves it waiting, never is. Only a confirmation that took the
 * action tells anyone it failed, so a refused one racing it can't. An
 * unexpected error goes as `connect.action_failed`, marked too, so every
 * failure after the take reaches core marked; its internals stay with
 * connect, which logs them.
 */
export const markTaken = (error: unknown): CodedError => {
  const coded = isExpectedError(error)
    ? error
    : connectErrors.create("connect.action_failed");
  coded.details = { ...coded.details, taken: true };
  return coded;
};

/** Whether `error` is one `markTaken` marked. */
export const wasTaken = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const details: unknown = Reflect.get(error, "details");
  return (
    typeof details === "object" &&
    details !== null &&
    Reflect.get(details, "taken") === true
  );
};
