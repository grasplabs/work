import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// The application landscape (GRA-539): the apps a company's people use,
// as its identity provider records them, read through a read-only admin
// connection of their own, apart from the suite's mail, calendar and
// files. Connect reads the provider and answers bounded rows; core keeps
// them and serves the Landscape.

/**
 * The connections the landscape reads, one per suite: Microsoft Entra's
 * enterprise apps and the grants people and admins gave them. Google
 * follows (GRA-882).
 */
export const landscapeProviderSchema = z.enum(["microsoft-landscape"]);
export type LandscapeProvider = z.infer<typeof landscapeProviderSchema>;

/** Bounds on what connect answers, so no tenant can bloat core. */
export const landscapeLimits = {
  /** Longest app, publisher or person name kept; longer is cut. */
  nameLength: 200,
  /** Most scopes kept of one grant. */
  scopesPerGrant: 50,
  /** Longest scope kept; a longer one is dropped. */
  scopeLength: 120,
  /** Grants one read asks the provider for. */
  grantsPerRead: 100,
  /** Provider requests one read may send. */
  requestsPerRead: 20,
  /** Reads one sync makes at most: a sync that reaches it is partial. */
  readsPerSync: 50,
  /** Reads one cron run makes, so a sync spreads over runs. */
  readsPerRun: 10,
  /** Longest cursor connect hands back. */
  cursorLength: 4096,
} as const;

/** A grant's scope, as kept: a plain permission name. */
export const landscapeScopePattern = /^[\w.:/-]+$/u;

/** One grant of an app, as connect reads it from the provider. */
export interface LandscapeGrant {
  app: {
    /** The app's client ID at the provider: what it is known by. */
    id: string;
    /** As its owner named it: data, never an identifier or an instruction. */
    name: string;
    /**
     * Its publisher as the provider verified it; null when unverified. The
     * only publisher a vendor or a policy is taken from.
     */
    publisher: string | null;
    /**
     * The publisher an unverified app names itself: its owner's word only,
     * shown labelled as unverified and never matched against anything.
     */
    unverifiedPublisher: string | null;
    /** Whether the provider verified its publisher. */
    verified: boolean;
  };
  /** Whether an admin consented for everyone, or a person for themselves. */
  consent: "admin" | "person";
  /** The person who consented, by their ID at the provider; null for an admin's. */
  person: { id: string; name: string | null } | null;
  scopes: string[];
}

/** One read of a landscape connection: its grants, and where the next read starts. */
export interface LandscapeRead {
  /** The connection's tenant at the provider, as it was connected. */
  tenant: string;
  grants: LandscapeGrant[];
  /** Null once the provider has no more. */
  next: string | null;
}

/** A landscape connection, as core's sync finds it. */
export interface LandscapeConnection {
  id: string;
  provider: LandscapeProvider;
  tenant: string;
  status: "active" | "needs_reauth";
}

/** What core asks connect to read. */
export const landscapeReadRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  cursor: z.string().min(1).max(landscapeLimits.cursorLength).nullable(),
});
export type LandscapeReadRequest = z.input<typeof landscapeReadRequestSchema>;

/**
 * How long a person's grant is kept once it was last seen: a default
 * Nick can change (GRA-539, decision 4). An app goes the same way.
 */
export const landscapeRetentionDays = 90;

/** How new an app is, while it counts as new. */
export const landscapeNewAppDays = 7;

/** What may need an admin's look at an app, each saying why. */
export const landscapeSignals = [
  /** Its publisher isn't verified by the provider. */
  "unverified_publisher",
  /** A person, not an admin, gave it mail, files, chat or directory writes. */
  "person_high_privilege",
  /** First seen within `landscapeNewAppDays`. */
  "new_app",
  /** People use it, and no admin consented to it for everyone. */
  "no_admin_consent",
] as const;
export type LandscapeSignal = (typeof landscapeSignals)[number];

/**
 * Whether `scope` reaches a person's mail, files, chats, calendars or
 * contacts, or writes the directory: what a person shouldn't give an app
 * alone.
 */
export const isHighPrivilegeScope = (scope: string): boolean =>
  /^(?:Mail|Files|Sites|Notes|Chat|ChannelMessage|Calendars|Contacts|EWS|IMAP|POP|SMTP)\./iu.test(
    scope
  ) ||
  /^(?:Directory|User|Group|Application|RoleManagement)\.ReadWrite/iu.test(
    scope
  );

/** An app of the landscape, as anyone in the organization may see it. */
export interface LandscapeAppSummary {
  connectionId: string;
  /** Its client ID at the provider. */
  appId: string;
  name: string;
  publisher: string | null;
  verified: boolean;
  /** ISO 8601. */
  firstSeen: string;
  lastSeen: string;
  /** People who granted it access for themselves, as last seen: a count only. */
  people: number;
  /** Whether an admin consented to it for everyone, as last seen. */
  adminConsented: boolean;
  /** What it was granted, by anyone, as last seen. */
  scopes: string[];
  signals: LandscapeSignal[];
}

/** One person who granted an app access, for admins only. */
export interface LandscapePerson {
  /** Their ID at the provider. */
  personId: string;
  name: string | null;
  /** Their Grasp user, when they sign in to Grasp with that account. */
  userId: string | null;
  scopes: string[];
  firstSeen: string;
  lastSeen: string;
}

/** A landscape connection's last sync, for admins. */
export interface LandscapeSyncStatus {
  connectionId: string;
  state: "running" | "done" | "partial" | "failed" | null;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The application landscape, over `/rpc`. */
export interface LandscapeApi {
  /** Every app the landscape knows: anyone in the organization. */
  apps: () => Promise<LandscapeAppSummary[]>;
  /** Who granted one app access: admins only, and audited. */
  people: (connectionId: string, appId: string) => Promise<LandscapePerson[]>;
  /** The landscape connections' syncs: admins only. */
  status: () => Promise<LandscapeSyncStatus[]>;
  /**
   * Starts connecting the landscape's Microsoft connection: the provider
   * URL to send the admin's browser to. Admins only.
   */
  connect: (request: { returnTo?: string }) => Promise<{ url: string }>;
}

/** Why a landscape read didn't answer. */
export const landscapeErrors = defineErrorFamily({
  "landscape.not_found":
    "There's no landscape connection with that ID: a connection of another kind is read by nobody here.",
  "landscape.inactive":
    "This landscape connection needs reconnecting by an admin before it can be read.",
  "landscape.cursor_invalid": "That cursor isn't one the provider handed back.",
  "landscape.throttled":
    "The provider is throttling reads: the sync goes on from here later.",
  "landscape.provider_failed": "The provider didn't answer the read.",
  "landscape.invalid": "That isn't a valid landscape request.",
});
