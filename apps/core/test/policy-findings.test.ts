import type { PolicyFinding, RuleInput } from "@grasp-os/shared/policies";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Which apps the company's rules catch, as core works it out
// (src/policy-findings.ts) over the apps it knows: its integrations, by
// their connections in connect, and the apps its identity provider
// granted access (the landscape). The ways it can go wrong, tried here: a
// member shown an app through a connection they can't see; an app's own
// unverified word taken for its vendor; a fact nothing records (an owner)
// read as one it knows; a rule on what the identity provider says of an
// app missing it; an exception no longer letting its app be; a paused
// rule acting.

const idp = mockIdp();

/** A connection in connect: shared, or `owner`'s own. */
const connection = async (
  provider: string,
  owner: string | null = null
): Promise<void> => {
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'native', ?, ?, ?)"
    )
    .bind(
      `connection-${unique()}`,
      provider,
      owner === null ? "shared" : "personal",
      owner,
      provider,
      now,
      now
    )
    .run();
};

/** An app the identity provider granted access, as the landscape keeps it. */
const granted = async ({
  name,
  publisher = null,
  unverifiedPublisher = null,
  people = [],
  adminScopes = null,
}: {
  name: string;
  publisher?: string | null;
  unverifiedPublisher?: string | null;
  /** Each person's scopes, for themselves. */
  people?: string[][];
  /** What an admin consented to for everyone. */
  adminScopes?: string[] | null;
}): Promise<string> => {
  const connectionId = `landscape-${unique()}`;
  const appId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO landscape_apps (connection_id, app_id, name, publisher, unverified_publisher, verified, admin_scopes, admin_seen_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      connectionId,
      appId,
      name,
      publisher,
      unverifiedPublisher,
      publisher === null ? 0 : 1,
      adminScopes === null ? null : JSON.stringify(adminScopes),
      adminScopes === null ? null : now,
      now,
      now
    ),
    ...people.map((scopes, index) =>
      env.DB.prepare(
        "INSERT INTO landscape_app_people (connection_id, app_id, person_id, name, scopes, first_seen, last_seen) VALUES (?, ?, ?, NULL, ?, ?, ?)"
      ).bind(
        connectionId,
        appId,
        `person-${index}`,
        JSON.stringify(scopes),
        now,
        now
      )
    ),
  ]);
  return `landscape:${connectionId}:${appId}`;
};

const rule = (
  name: string,
  conditions: RuleInput["conditions"],
  patch: Partial<RuleInput> = {}
): RuleInput => ({
  name,
  description: "",
  conditions,
  effect: "flag",
  status: "active",
  policyId: null,
  ...patch,
});

/** What each finding says, by rule name, for the apps named `among`. */
const seen = (
  found: readonly PolicyFinding[],
  names: ReadonlyMap<string, string>,
  among: readonly string[]
): string[] =>
  found
    .filter(({ app }) => among.includes(app.id))
    .map(
      ({ ruleId, app, state }) =>
        `${names.get(ruleId) ?? ruleId}: ${app.name} ${state}`
    );

describe("which apps the company's rules catch", () => {
  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM policy_exceptions"),
      env.DB.prepare("DELETE FROM policy_rules"),
    ]);
  });

  it("are worked out over every app for the organization's own admins, and over the apps they can see for anyone else", async () => {
    const [admin, member, other] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const tag = unique();
    const shared = `shared-crm-${tag}`;
    const mine = `my-notes-${tag}`;
    const theirs = `their-notes-${tag}`;
    await Promise.all([
      connection(shared),
      connection(mine, member.userId),
      connection(theirs, other.userId),
    ]);
    const app = await granted({ name: `Planner ${tag}` });
    // Training nothing states catches every app, as the rule asks for it.
    const created = await admin.api.policies.createRule(
      rule("Training not stated", [{ field: "training", values: ["unknown"] }])
    );
    const names = new Map([[created.id, created.name]]);
    const among = [
      `native:${shared}`,
      `native:${mine}`,
      `native:${theirs}`,
      app,
    ];
    const [byAdmin, byMember, byStaff] = await Promise.all([
      admin.api.policies.findings(),
      member.api.policies.findings(),
      staff.policies.findings(),
    ]);

    expect({
      admin: seen(byAdmin.findings, names, among).toSorted(),
      member: seen(byMember.findings, names, among).toSorted(),
      staff: seen(byStaff.findings, names, among).toSorted(),
    }).toStrictEqual({
      admin: [
        `Training not stated: Planner ${tag} flagged`,
        `Training not stated: ${mine} flagged`,
        `Training not stated: ${shared} flagged`,
        `Training not stated: ${theirs} flagged`,
      ],
      // Their own connection and the shared one, never another's.
      member: [
        `Training not stated: Planner ${tag} flagged`,
        `Training not stated: ${mine} flagged`,
        `Training not stated: ${shared} flagged`,
      ],
      // Grasp staff see what a member sees: no one's own connection.
      staff: [
        `Training not stated: Planner ${tag} flagged`,
        `Training not stated: ${shared} flagged`,
      ],
    });
  });

  it("read what the identity provider says of an app: its vendor only as verified, how many granted it, and what its scopes reach", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const verified = await granted({
      name: `Mailer ${tag}`,
      publisher: "Contoso",
      people: [["openid", "Mail.Send"], ["Mail.Read"], ["User.Read"]],
    });
    const claimed = await granted({
      name: `Lookalike ${tag}`,
      unverifiedPublisher: "Contoso",
      people: [["User.Read"]],
    });
    const everyone = await granted({
      name: `Directory sync ${tag}`,
      publisher: "Fabrikam",
      people: [["User.Read"]],
      adminScopes: ["Directory.ReadWrite.All"],
    });
    const [byVendor, notByVendor, used, changes, administers] =
      await Promise.all([
        admin.api.policies.createRule(
          rule("Made by Contoso", [
            { field: "vendor", op: "is", values: ["contoso"] },
          ])
        ),
        admin.api.policies.createRule(
          rule("Not made by Contoso", [
            { field: "vendor", op: "isNot", values: ["Contoso"] },
          ])
        ),
        admin.api.policies.createRule(
          rule("Used by more than two", [{ field: "people", moreThan: 2 }])
        ),
        admin.api.policies.createRule(
          rule("Changes company data", [{ field: "access", values: ["write"] }])
        ),
        admin.api.policies.createRule(
          rule("Administers company data", [
            { field: "access", values: ["admin"] },
          ])
        ),
      ]);
    const names = new Map(
      [byVendor, notByVendor, used, changes, administers].map(
        ({ id, name }) => [id, name]
      )
    );
    const { findings } = await admin.api.policies.findings();
    const apps = findings
      .filter(({ app }) => app.id === verified)
      .map(({ app }) => app);

    expect({
      found: seen(findings, names, [verified, claimed, everyone]).toSorted(),
      app: apps[0],
    }).toStrictEqual({
      found: [
        `Administers company data: Directory sync ${tag} flagged`,
        `Changes company data: Directory sync ${tag} flagged`,
        `Changes company data: Mailer ${tag} flagged`,
        `Made by Contoso: Mailer ${tag} flagged`,
        // Consented for everyone: how many use it isn't known.
        `Not made by Contoso: Directory sync ${tag} flagged`,
        `Used by more than two: Mailer ${tag} flagged`,
      ],
      app: {
        id: verified,
        name: `Mailer ${tag}`,
        kind: "landscape",
        vendor: "Contoso",
        people: 3,
      },
    });
  });

  it("never catch an app by what nothing records, act only as each rule's status says, and let an exception hold", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const tag = unique();
    const crm = `crm-${tag}`;
    await connection(crm);
    const key = `native:${crm}`;
    const [noOwner, watching, paused, excepted] = await Promise.all([
      admin.api.policies.createRule(rule("Has no owner", [{ field: "owner" }])),
      admin.api.policies.createRule(
        rule(
          "Lacks ISO 27001",
          [{ field: "certificate", op: "lacksAny", values: ["iso27001"] }],
          { status: "watching", effect: "block" }
        )
      ),
      admin.api.policies.createRule(
        rule("Paused", [{ field: "training", values: ["unknown"] }], {
          status: "paused",
        })
      ),
      admin.api.policies.createRule(
        rule("Excepted", [{ field: "training", values: ["unknown"] }], {
          effect: "block",
        })
      ),
    ]);
    await admin.api.policies.grantException({
      ruleId: excepted.id,
      appId: key,
      reason: "Approved by the board",
      until: "2099-12-31",
    });
    const names = new Map(
      [noOwner, watching, paused, excepted].map(({ id, name }) => [id, name])
    );
    const { findings } = await admin.api.policies.findings();

    expect({
      found: seen(findings, names, [key]),
      exception: findings.find(
        ({ ruleId, app }) => ruleId === excepted.id && app.id === key
      )?.exception?.until,
      // Read by everyone signed in, as the book is.
      member: await outcome(member.api.policies.findings()),
    }).toStrictEqual({
      // An owner nothing records is neither owned nor unowned; a
      // certificate nothing declares counts as lacking, as the rule says.
      found: [`Lacks ISO 27001: ${crm} watching`, `Excepted: ${crm} excepted`],
      exception: "2099-12-31",
      member: "ok",
    });
  });
});
