import { actorOf } from "@grasp-os/shared/audit";
import {
  directoryErrors,
  directoryLimits,
  directoryProviders,
  directorySuiteOf,
  directorySuiteSchema,
} from "@grasp-os/shared/directory";
import type {
  DirectoryConnection,
  DirectoryPeople,
  DirectoryPerson,
  OnboardingDirectory,
} from "@grasp-os/shared/directory";
import { onboardingPeopleMax } from "@grasp-os/shared/onboarding";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

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
 * The directory connection the onboarding reads: one of the organization's
 * own tenant, a working one before one that needs reconnecting, the
 * newest first. Another tenant's (the deployment's sign-in moved since) is
 * never read.
 */
const connectionOf = async (
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
    people.push(...read.people);
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
