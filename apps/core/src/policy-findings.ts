import type { CatalogSource } from "@grasp-os/shared/connect";
import type { PolicyBook, PolicyFindings } from "@grasp-os/shared/policies";
import {
  accessOfScopes,
  conditionsMatch,
  findingsOf,
  unknownFacts,
} from "@grasp-os/shared/policy-engine";
import type { KnownApp } from "@grasp-os/shared/policy-engine";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { entryKey, personOf } from "./connections.ts";
import { landscapeAppsOf } from "./landscape.ts";

// Which apps the company's rules catch (GRA-1214), worked out here from
// what core knows of the apps, through the policy engine
// (@grasp-os/shared/policy-engine), and served to the Policies and the
// Landscape. The apps are of two kinds:
//
// - The company's integrations, each with a connection: by their key
//   (`native:microsoft`), as exceptions name them, and their name in
//   connect's catalog. Nothing records their vendor, AI, data, hosting,
//   usage or owner yet: those facts are unknown, and a rule on them
//   catches none of these apps.
// - The apps its identity provider granted access (the landscape,
//   landscape.ts), by `landscape:<connection>:<client ID>`: their vendor
//   only as the provider verified their publisher (an unverified one's own
//   word is no vendor), how many people granted them access for
//   themselves (unknown once an admin consented for everyone), and what
//   their scopes let them do with company data.
//
// Who sees what: the organization's own admins every app, so every
// connection; anyone else, Grasp staff included, the integrations of the
// connections they can see (their own and the shared ones), as their
// Landscape lists them, and the landscape's apps, which anyone may see.
// Nothing here is a person's: an app is named, never who uses it.

/** The ID a landscape app goes by among the apps a rule can catch. */
export const landscapeAppKey = (connectionId: string, appId: string): string =>
  `landscape:${connectionId}:${appId}`;

/** The integrations of the connections `by` may see, by key, each named by the catalog. */
const integrationsFor = async (env: Env, by: Identity): Promise<KnownApp[]> => {
  const everyone = isAdmin(by.role) && !by.staff;
  const [connections, catalog] = await Promise.all([
    everyone
      ? env.CONNECT.organizationConnections()
      : personOf(env, by).then(
          async (person) => await env.CONNECT.listConnections(person)
        ),
    env.CONNECT.catalog(),
  ]);
  const names = new Map(
    catalog.entries.map(({ source, id, name }) => [entryKey(source, id), name])
  );
  const keys = new Map<string, string>();
  for (const { source, provider, status } of connections) {
    if (status !== "disconnected") {
      const key = entryKey(source satisfies CatalogSource, provider);
      // The catalog alone has its name: its ID stands in.
      keys.set(key, names.get(key) ?? provider);
    }
  }
  return [...keys].map(([id, name]) => ({
    app: { id, name, kind: "integration", vendor: null, people: null },
    facts: unknownFacts,
  }));
};

/** The landscape's apps, with what the identity provider says of them. */
const landscapeApps = async (env: Env): Promise<KnownApp[]> => {
  const apps = await landscapeAppsOf(env, new Date());
  return apps.map((app) => {
    const vendor = app.verified ? app.publisher : null;
    const people = app.adminConsented ? null : app.people;
    return {
      app: {
        id: landscapeAppKey(app.connectionId, app.appId),
        name: app.name,
        kind: "landscape",
        vendor,
        people,
      },
      facts: {
        ...unknownFacts,
        vendor,
        people,
        access: accessOfScopes(app.scopes),
      },
    };
  });
};

/** Today, as an exception's last day is compared: the UTC date. */
const todayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Which apps `book`'s rules catch, and how many each policy's proposed
 * rules would, over the apps `by` may see.
 */
export const policyFindings = async (
  env: Env,
  by: Identity,
  book: PolicyBook
): Promise<PolicyFindings> => {
  const [integrations, granted] = await Promise.all([
    integrationsFor(env, by),
    landscapeApps(env),
  ]);
  const apps = [...integrations, ...granted];
  return {
    findings: findingsOf(
      book.rules,
      apps,
      book.exceptions,
      todayOf(new Date())
    ),
    proposals: book.policies.flatMap((policy) =>
      policy.proposals.map((proposal) => ({
        policyId: policy.id,
        proposalId: proposal.id,
        apps: apps.filter(({ facts }) =>
          conditionsMatch(proposal.conditions, facts)
        ).length,
      }))
    ),
  };
};
