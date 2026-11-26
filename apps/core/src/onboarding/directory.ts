import { actorOf } from "@grasp-os/shared/audit";
import {
  accountDomainSchema,
  directoryErrors,
  directoryLimits,
  directoryProviders,
  directorySuiteOf,
  directorySuiteSchema,
} from "@grasp-os/shared/directory";
import type {
  DirectoryConnection,
  OnboardingDirectoryAccount,
  DirectoryPeople,
  DirectoryPerson,
  OnboardingDirectory,
} from "@grasp-os/shared/directory";
import { onboardingPeopleMax } from "@grasp-os/shared/onboarding";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { appendAuditEvent } from "../audit-outbox.ts";
import { signInConfig } from "../auth/config.ts";
import { tenantOf } from "../connections.ts";
import { startOnboardingConnection } from "./connections.ts";

// Who works where, from the organization's directory (GRA-369): the admin
// connects their Microsoft or Google sign-in in the onboarding's company
// step, and core reads everyone in it through connect, a page at a time,
// for the admin's browser to make a roster of, as it makes one of a staff
// list (the web app's staff-list.ts), so people keep their IDs and links
// whichever way they came in. Core keeps nothing of the read itself: the
// roster the browser saves is what stays.

/**
 * The directory connection the onboarding and the daily read
 * (directory-people.ts) read: one of the organization's own tenant, a
 * working one before one that needs reconnecting, the newest first.
 * Another tenant's (the deployment's sign-in moved since) is never read.
 */
export const connectionOf = async (
  env: Env,
  provider?: DirectoryConnection["provider"]
): Promise<DirectoryConnection | undefined> => {
  const config = signInConfig(env);
  if (config === undefined) {
    return undefined;
  }
  const listed = await env.CONNECT.directoryConnections();
  return listed
    .filter(
      (connection) =>
        (provider === undefined || connection.provider === provider) &&
        connection.tenant.toLowerCase() ===
          tenantOf(config, directorySuiteOf(connection.provider))?.toLowerCase()
    )
    .toSorted(
      (one, other) =>
        Number(one.status !== "active") - Number(other.status !== "active") ||
        other.connectedAt.localeCompare(one.connectedAt)
    )[0];
};

/**
 * The Microsoft directory of the deployment's own Entra tenant, while it
 * can be read: what knows the people writing on Teams by their object id
 * (channels/who.ts). None while it needs reconnecting.
 */
export const entraDirectoryOf = async (
  env: Env
): Promise<DirectoryConnection | undefined> => {
  const connection = await connectionOf(env, "microsoft-directory");
  return connection?.status === "active" ? connection : undefined;
};

/** The directory connected for the onboarding; null before one is. */
export const onboardingDirectory = async (
  env: Env,
  identity: Identity
): Promise<OnboardingDirectory | null> => {
  requireAdmin(identity);
  const connection = await connectionOf(env);
  return connection === undefined
    ? null
    : {
        suite: directorySuiteOf(connection.provider),
        status: connection.status,
      };
};

/** Starts connecting the directory of `suite`, from the step at `returnTo`. */
export const connectDirectory = async (
  env: Env,
  identity: Identity,
  suite: unknown,
  returnTo: unknown
): Promise<{ url: string }> => {
  const parsed = directorySuiteSchema.safeParse(suite);
  if (!parsed.success) {
    throw directoryErrors.create("directory.invalid");
  }
  return await startOnboardingConnection(env, identity, {
    provider: directoryProviders[parsed.data],
    suite: parsed.data,
    returnTo,
  });
};

/** Everyone in `connection`'s directory, page by page, on the record first. */
const readEveryone = async (
  env: Env,
  identity: Identity,
  connection: DirectoryConnection
): Promise<DirectoryPeople> => {
  await appendAuditEvent(env, {
    actor: actorOf(identity),
    action: "onboarding.directory_read",
    target: { type: "connection", id: connection.id },
  });
  const people: DirectoryPerson[] = [];
  let cursor: string | null = null;
  for (let reads = 0; reads < directoryLimits.readsPerDirectory; reads += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the last
    const read = await env.CONNECT.readDirectory({
      connectionId: connection.id,
      cursor,
    });
    if (read.tenant.toLowerCase() !== connection.tenant.toLowerCase()) {
      throw directoryErrors.create("directory.other_tenant");
    }
    // A roster names everyone it holds: an account with no name is none.
    people.push(...read.people.filter(({ name }) => name !== ""));
    if (people.length > onboardingPeopleMax) {
      throw directoryErrors.create("directory.too_large");
    }
    cursor = read.next;
    if (cursor === null) {
      return { suite: directorySuiteOf(connection.provider), people };
    }
  }
  throw directoryErrors.create("directory.too_large");
};

/**
 * Everyone in the onboarding's directory, read just now, page by page: on
 * the record before anything is read. Refused when it holds more than an
 * onboarding takes, rather than cut short: a roster of part of the
 * company would leave the rest out unseen.
 */
export const readOnboardingDirectory = async (
  env: Env,
  identity: Identity
): Promise<DirectoryPeople> => {
  requireAdmin(identity);
  // The client's people are the client's: not Grasp staff's to read.
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const connection = await connectionOf(env);
  if (connection === undefined) {
    throw directoryErrors.create("directory.not_connected");
  }
  if (connection.status !== "active") {
    throw directoryErrors.create("directory.inactive");
  }
  return await readEveryone(env, identity, connection);
};

/** The company's own tenant at `provider`'s suite, as its sign-in names it, lower case. */
const ownTenantOf = (
  env: Env,
  provider: DirectoryConnection["provider"]
): string | undefined => {
  const config = signInConfig(env);
  return config === undefined
    ? undefined
    : tenantOf(config, directorySuiteOf(provider))?.toLowerCase();
};

/**
 * Every account's directory connected for the roster: the company's own
 * and its others (a second Microsoft tenant, another Google domain), one
 * per account, a working one before one that needs reconnecting, the
 * newest first; the company's own first.
 */
export const onboardingDirectoryAccounts = async (
  env: Env,
  identity: Identity
): Promise<OnboardingDirectoryAccount[]> => {
  requireAdmin(identity);
  if (signInConfig(env) === undefined) {
    return [];
  }
  const connections = await env.CONNECT.directoryConnections();
  const listed = connections.toSorted(
    (one, other) =>
      Number(one.status !== "active") - Number(other.status !== "active") ||
      other.connectedAt.localeCompare(one.connectedAt)
  );
  const seen = new Set<string>();
  const accounts: OnboardingDirectoryAccount[] = [];
  for (const connection of listed) {
    const tenant = connection.tenant.toLowerCase();
    const key = `${connection.provider}|${tenant}`;
    if (!seen.has(key)) {
      seen.add(key);
      accounts.push({
        id: connection.id,
        suite: directorySuiteOf(connection.provider),
        tenant,
        own: tenant === ownTenantOf(env, connection.provider),
        status: connection.status,
      });
    }
  }
  return accounts.toSorted(
    (one, other) =>
      Number(other.own) - Number(one.own) ||
      one.suite.localeCompare(other.suite)
  );
};

/** What Microsoft's discovery names as a tenant's issuer: its id in the path. */
const issuerSchema = z.object({ issuer: z.string() });
const microsoftIssuer =
  /^https:\/\/login\.microsoftonline\.com\/(?<tenant>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/u;

/** An Entra tenant's id. */
const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** How long Microsoft may take to say which tenant a domain is. */
const discoveryTimeoutMs = 10_000;

/**
 * The Entra tenant `domain` belongs to, by Microsoft's public OpenID
 * discovery for it: what a flow is pinned to, as the company's own is.
 */
const microsoftTenantOf = async (domain: string): Promise<string> => {
  let response: Response;
  try {
    response = await fetch(
      `https://login.microsoftonline.com/${domain}/v2.0/.well-known/openid-configuration`,
      { redirect: "manual", signal: AbortSignal.timeout(discoveryTimeoutMs) }
    );
  } catch {
    throw directoryErrors.create("directory.provider_failed");
  }
  if (!response.ok) {
    throw directoryErrors.create("directory.unknown_domain");
  }
  const issuer = issuerSchema.safeParse(await response.json()).data?.issuer;
  const tenant = microsoftIssuer.exec(issuer ?? "")?.groups?.tenant;
  if (tenant === undefined) {
    throw directoryErrors.create("directory.unknown_domain");
  }
  return tenant;
};

/**
 * Starts connecting another of the company's accounts at `suite`, named
 * by its domain, for the roster only: the flow is pinned to that account's
 * tenant, so only its accounts can consent, and nobody signs in to Grasp
 * through it (sign-in stays the company's own tenant's).
 */
export const connectOtherDirectory = async (
  env: Env,
  identity: Identity,
  {
    suite,
    domain,
    returnTo,
  }: { suite: unknown; domain: unknown; returnTo: unknown }
): Promise<{ url: string }> => {
  const parsedSuite = directorySuiteSchema.safeParse(suite);
  // A Microsoft account connected before comes back by its tenant's id, which needs no lookup.
  const tenantId =
    typeof domain === "string" ? domain.trim().toLowerCase() : "";
  const byId =
    parsedSuite.data === "microsoft" && tenantIdPattern.test(tenantId);
  const parsedDomain = accountDomainSchema.safeParse(domain);
  if (!parsedSuite.success || (!byId && !parsedDomain.success)) {
    throw directoryErrors.create("directory.invalid");
  }
  let tenant = tenantId;
  if (!byId && parsedDomain.success) {
    tenant =
      parsedSuite.data === "microsoft"
        ? await microsoftTenantOf(parsedDomain.data)
        : parsedDomain.data;
  }
  return await startOnboardingConnection(env, identity, {
    provider: directoryProviders[parsedSuite.data],
    suite: parsedSuite.data,
    returnTo,
    otherTenant: tenant,
  });
};

/**
 * Everyone in one account's directory, `connectionId` among
 * `onboardingDirectoryAccounts`, read just now for the roster: the same
 * read, and the same refusals, as the company's own.
 */
export const readDirectoryAccount = async (
  env: Env,
  identity: Identity,
  connectionId: unknown
): Promise<DirectoryPeople> => {
  requireAdmin(identity);
  // The client's people are the client's: not Grasp staff's to read.
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  if (typeof connectionId !== "string" || signInConfig(env) === undefined) {
    throw directoryErrors.create("directory.invalid");
  }
  const connections = await env.CONNECT.directoryConnections();
  const connection = connections.find(({ id }) => id === connectionId);
  if (connection === undefined) {
    throw directoryErrors.create("directory.not_connected");
  }
  if (connection.status !== "active") {
    throw directoryErrors.create("directory.inactive");
  }
  return await readEveryone(env, identity, connection);
};
