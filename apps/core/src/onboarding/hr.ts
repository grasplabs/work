import { actorOf } from "@grasp-os/shared/audit";
import { connectionErrors } from "@grasp-os/shared/connect";
import {
  hrCredentialsSchema,
  hrErrors,
  hrPlatformOf,
  hrPlatformSchema,
  hrProviders,
} from "@grasp-os/shared/hr";
import type { HrConnection, HrPeople, OnboardingHr } from "@grasp-os/shared/hr";
import { onboardingPeopleMax } from "@grasp-os/shared/onboarding";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { appendAuditEvent } from "../audit-outbox.ts";
import { connectOnboardingWithKey } from "./connections.ts";

// Who leads which team, from the company's HR platform (GRA-371): the
// admin connects it in the onboarding's confirm step with API credentials
// they made there, and core reads everyone in it through connect, for the
// admin's browser to make a roster of, as of a directory (directory.ts):
// teams from departments, leads from who reports to whom, on the staff
// list's own path, so people keep their IDs and links. The admin still
// checks every team and its lead before anything goes out. Core keeps
// nothing of the read itself: the roster the browser saves is what stays.

/**
 * The HR platform connection the onboarding reads: a working one before
 * one that needs connecting again, the newest first.
 */
const connectionOf = async (env: Env): Promise<HrConnection | undefined> => {
  const listed = await env.CONNECT.hrConnections();
  return listed.toSorted(
    (one, other) =>
      Number(one.status !== "active") - Number(other.status !== "active") ||
      other.connectedAt.localeCompare(one.connectedAt)
  )[0];
};

const viewOf = (connection: HrConnection): OnboardingHr => ({
  platform: hrPlatformOf[connection.provider],
  status: connection.status,
});

/** The HR platform connected for the onboarding; null before one is. */
export const onboardingHr = async (
  env: Env,
  identity: Identity
): Promise<OnboardingHr | null> => {
  requireAdmin(identity);
  const connection = await connectionOf(env);
  return connection === undefined ? null : viewOf(connection);
};

/**
 * Connects `platform` with the credentials the admin made there: refused
 * as `hr.refused` when the platform doesn't take them.
 */
export const connectHr = async (
  env: Env,
  identity: Identity,
  platform: unknown,
  credentials: unknown
): Promise<OnboardingHr> => {
  const parsedPlatform = hrPlatformSchema.safeParse(platform);
  const parsed = hrCredentialsSchema.safeParse(credentials);
  if (!parsedPlatform.success || !parsed.success) {
    throw hrErrors.create("hr.invalid");
  }
  const { id, secret } = parsed.data;
  try {
    await connectOnboardingWithKey(env, identity, {
      provider: hrProviders[parsedPlatform.data],
      key: `${id}:${secret}`,
    });
  } catch (error) {
    if (connectionErrors.codeOf(error) === "connection.provider_refused") {
      throw hrErrors.create("hr.refused");
    }
    throw error;
  }
  return { platform: parsedPlatform.data, status: "active" };
};

/**
 * Everyone in the onboarding's HR platform, read just now: on the record
 * before anything is read. Refused when it holds more than an onboarding
 * takes, rather than cut short: a roster of part of the company would
 * leave the rest out unseen.
 */
export const readOnboardingHr = async (
  env: Env,
  identity: Identity
): Promise<HrPeople> => {
  requireAdmin(identity);
  // The client's people are the client's: not Grasp staff's to read.
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const connection = await connectionOf(env);
  if (connection === undefined) {
    throw hrErrors.create("hr.not_connected");
  }
  if (connection.status !== "active") {
    throw hrErrors.create("hr.inactive");
  }
  await appendAuditEvent(env, {
    actor: actorOf(identity),
    action: "onboarding.hr_read",
    target: { type: "connection", id: connection.id },
  });
  const { people } = await env.CONNECT.readHr({ connectionId: connection.id });
  if (people.length > onboardingPeopleMax) {
    throw hrErrors.create("hr.too_large");
  }
  return { platform: hrPlatformOf[connection.provider], people };
};
