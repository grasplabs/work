import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import type { DirectoryPerson } from "@grasp-os/shared/directory";
import {
  hrErrors,
  hrLimits,
  hrProviderSchema,
  hrReadRequestSchema,
} from "@grasp-os/shared/hr";
import type { HrConnection, HrRead } from "@grasp-os/shared/hr";
import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connections } from "./db/schema.ts";
import { emailOf, textOf } from "./directory.ts";
import { requestBudget, SourceError } from "./event-kinds.ts";
import type { ProviderAccess } from "./event-kinds.ts";
import { hibobPeople } from "./hibob.ts";
import type { HibobPerson } from "./hibob.ts";
import { credentialFor } from "./tokens.ts";

// The HR platform's reads (GRA-371): who leads which team, from the
// company's HR platform, with its connection's key, which stays here.
// Core asks for everyone at once, for the onboarding, and the admin's
// browser makes a roster of what it answers, as of a directory's. HiBob
// is the first platform (hibob.ts). Threat model, before code, as the
// directory's (directory.ts):
//
// - A key reaching more than the people: the platform can't be asked to
//   hold no more than the read, so the connection is the organization's
//   only, connected by an admin (oauth.ts, `sharedOnly`); it takes no
//   connector calls (call.ts, no connector can name its provider); and
//   its key is sent only with the one search built here, on the
//   platform's own host, every time. Nothing of a request is taken from
//   core but which connection to read.
// - Personal data past what a roster needs: only names, email addresses,
//   departments, jobs and supervisors are asked for and answered. Nothing
//   of salaries, addresses, absences or anything else a service user may
//   be let read.
// - Planted text: anyone in the platform can be named anything. Names,
//   departments and jobs are cut as a directory's are, and are only data.
//   IDs that aren't the platform's are left out; an address that isn't
//   one is none.
// - A flood: one read sends one request, and an answer holding more
//   people than a read takes is refused, not cut short.

/** IDs as HiBob issues them. */
const hibobIdPattern = /^\d{1,32}$/u;

/** Someone in HiBob, as kept; none without an ID of HiBob's or a name. */
const hibobPerson = (person: HibobPerson): DirectoryPerson | null => {
  const name = textOf(person.name);
  if (!hibobIdPattern.test(person.id) || name === "") {
    return null;
  }
  return {
    id: person.id,
    name,
    email: emailOf(person.email),
    department: textOf(person.department),
    title: textOf(person.title),
    manager: hibobIdPattern.test(person.manager) ? person.manager : null,
  };
};

/** The HR platforms' connections still connected, for core. */
export const hrConnections = async (env: Env): Promise<HrConnection[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: connections.id,
      provider: connections.provider,
      status: connections.status,
      createdAt: connections.createdAt,
    })
    .from(connections)
    .where(
      and(
        inArray(connections.provider, hrProviderSchema.options),
        eq(connections.scope, "shared"),
        ne(connections.status, "disconnected")
      )
    );
  return rows.flatMap(({ id, provider, status, createdAt }) => {
    const known = hrProviderSchema.safeParse(provider);
    return known.success && status !== "disconnected"
      ? [
          {
            id,
            provider: known.data,
            status,
            connectedAt: createdAt.toISOString(),
          },
        ]
      : [];
  });
};

/**
 * What the connection's requests carry: a key no longer there is
 * `hr.inactive`, for an admin to connect again.
 */
const hrCredential = async (env: Env, connectionId: string) => {
  try {
    return await credentialFor(env, connectionId);
  } catch (error) {
    if (connectErrors.codeOf(error) === "connect.connection_inactive") {
      throw hrErrors.create("hr.inactive");
    }
    if (connectionErrors.codeOf(error) !== undefined) {
      throw hrErrors.create("hr.provider_failed");
    }
    throw error;
  }
};

/** The platform's refusal or failure, as the HR platform's error. */
const readFailure = (error: unknown): unknown => {
  if (error instanceof z.ZodError) {
    return hrErrors.create("hr.provider_failed");
  }
  if (!(error instanceof SourceError)) {
    return error;
  }
  const { status, retryAfterMs } = error;
  if (status === 429 || status === 503) {
    return hrErrors.create(
      "hr.throttled",
      retryAfterMs === undefined ? undefined : { retryAfterMs }
    );
  }
  // The platform no longer takes the key: revoked, or the service user's
  // access taken away.
  if (status === 401 || status === 403) {
    return hrErrors.create("hr.inactive");
  }
  return hrErrors.create("hr.provider_failed");
};

/** Reads everyone in an HR platform's connection. */
export const readHr = async (env: Env, request: unknown): Promise<HrRead> => {
  const { connectionId } = hrErrors.parse(
    "hr.not_found",
    hrReadRequestSchema,
    request
  );
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const provider = hrProviderSchema.safeParse(connection?.provider);
  if (
    connection === undefined ||
    !provider.success ||
    connection.scope !== "shared"
  ) {
    throw hrErrors.create("hr.not_found");
  }
  if (connection.status !== "active") {
    throw hrErrors.create("hr.inactive");
  }
  const access: ProviderAccess = {
    credential: await hrCredential(env, connection.id),
    budget: requestBudget(1),
  };
  let found: Awaited<ReturnType<typeof hibobPeople>>;
  try {
    found = await hibobPeople(access);
  } catch (error) {
    throw readFailure(error);
  }
  if (found.read > hrLimits.peoplePerRead) {
    throw hrErrors.create("hr.too_large");
  }
  return { people: found.people.flatMap((each) => hibobPerson(each) ?? []) };
};
