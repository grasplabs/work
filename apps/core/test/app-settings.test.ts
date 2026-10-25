import { appLimits } from "@grasp-os/shared/app-limits";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { updateApp } from "../src/app-settings.ts";
import { outlook, published, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { racingDb } from "./racing-db.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// An App's settings besides its code: its name and description, who
// answers for it, whom it is made for, and the integrations added to it
// by hand. What could go wrong: someone without the right changes them (a
// user of the App, someone it isn't shared with, Grasp staff naming
// people); someone answers for it who can't open it, or isn't in the
// organization; it is made for a team or person who isn't the
// organization's; naming who answers for it hands over what only its
// owner holds (its builder role, whom its runs act for); a change goes
// unrecorded, or overwrites one made meanwhile; and the integrations list
// lets out whose connection the App holds.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const slow = { timeout: 60_000 };

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** A new App of `owner`'s, published for the people it is shared with. */
const newApp = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  await published(id);
  return id;
};

const share = async (
  owner: Person,
  app: string,
  person: Person,
  role: "user" | "builder"
): Promise<void> => {
  await owner.api.apps.members.add(app, {
    type: "person",
    id: person.userId,
    role,
  });
};

/** A shared connection to `provider`, `status` at connect. */
const connection = async (
  provider: string,
  status: "active" | "disconnected" = "active"
): Promise<string> => {
  const id = `connection-${provider}-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, ?, 'shared', NULL, ?, 'native', ?, ?, ?)"
    )
    .bind(id, provider, status, provider, now, now)
    .run();
  return id;
};

/** What an audit event says, without its ID and time. */
const said = (
  events: Awaited<ReturnType<typeof auditedDuring>>
): { action: string; actor: unknown; detail: unknown }[] =>
  events.map(({ action, actor, detail }) => ({ action, actor, detail }));

describe("an App's name and description", slow, () => {
  it("are changed by its builders, audited without the text, and a change to what they are records nothing", async () => {
    const [owner, builder, user, outsider] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
    ]);
    const app = await newApp(owner);
    await share(owner, app, builder, "builder");
    await share(owner, app, user, "user");

    const audited = await auditedDuring(
      async () =>
        await builder.api.apps.update(app, {
          name: "Invoices",
          description: "Chases unpaid invoices.",
        })
    );
    const unchanged = await auditedDuring(
      async () => await owner.api.apps.update(app, { name: "Invoices" })
    );
    const refused = {
      user: await outcome(user.api.apps.update(app, { name: "Mine" })),
      outsider: await outcome(outsider.api.apps.update(app, { name: "Mine" })),
      empty: await outcome(owner.api.apps.update(app, {})),
      blank: await outcome(owner.api.apps.update(app, { name: "  " })),
      unknown: await outcome(
        // @ts-expect-error: the owner never changes, as a client could ask
        owner.api.apps.update(app, { owner: user.userId })
      ),
    };
    const seen = await user.api.apps.get(app);

    expect({
      audited: said(audited),
      unchanged: unchanged.length,
      refused,
      seen: { name: seen.name, description: seen.description },
    }).toStrictEqual({
      audited: [
        {
          action: "app.updated",
          actor: { type: "person", userId: builder.userId },
          detail: { name: true, description: true },
        },
      ],
      unchanged: 0,
      refused: {
        user: "role.forbidden",
        outsider: "app.not_found",
        empty: "app.invalid",
        blank: "app.invalid",
        unknown: "app.invalid",
      },
      seen: { name: "Invoices", description: "Chases unpaid invoices." },
    });
  });

  it("aren't changed over a change made since they were read", async () => {
    const owner = await personApi("builder");
    const app = await newApp(owner);
    const by = await owner.api.whoami();
    // Renamed by someone else just before the batch lands.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare("UPDATE apps SET name = 'Theirs' WHERE id = ?")
          .bind(app)
          .run()
    );

    const refused = await outcome(
      updateApp({ ...env, DB: racing }, by, app, { name: "Mine" })
    );
    const { name } = await owner.api.apps.get(app);
    expect({ refused, name }).toStrictEqual({
      refused: "app.conflict",
      name: "Theirs",
    });
  });
});

describe("who answers for an App", slow, () => {
  it("is its owner until a builder names a member who can open it, which hands over nothing else", async () => {
    const [owner, builder, user, outsider, admin, removed] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
      personApi("admin"),
      personApi("user"),
    ]);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const app = await newApp(owner);
    await share(owner, app, builder, "builder");
    await share(owner, app, user, "user");
    await share(owner, app, removed, "user");
    await admin.api.members.remove(removed.userId);

    const before = await user.api.apps.get(app);
    const audited = await auditedDuring(
      async () =>
        await builder.api.apps.update(app, { responsible: user.userId })
    );
    const named = await user.api.apps.get(app);
    const refused = {
      user: await outcome(
        user.api.apps.update(app, { responsible: user.userId })
      ),
      staff: await outcome(
        staff.apps.update(app, { responsible: owner.userId })
      ),
      // A member who can't open the App: they couldn't see what they answer for.
      noAccess: await outcome(
        owner.api.apps.update(app, { responsible: outsider.userId })
      ),
      removed: await outcome(
        owner.api.apps.update(app, { responsible: removed.userId })
      ),
      nobody: await outcome(
        owner.api.apps.update(app, { responsible: `user-${unique()}` })
      ),
    };
    // The owner still builds it, and the one named only uses it.
    const stillOwner = await outcome(
      owner.api.apps.update(app, { description: "Still mine." })
    );
    const namedBuilds = await outcome(
      user.api.apps.update(app, { description: "Mine now." })
    );
    const back = await auditedDuring(
      async () =>
        await admin.api.apps.update(app, { responsible: owner.userId })
    );
    const after = await user.api.apps.get(app);

    expect({
      before: { owner: before.owner, responsible: before.responsible },
      named: { owner: named.owner, responsible: named.responsible },
      audited: said([...audited, ...back]),
      refused,
      stillOwner,
      namedBuilds,
      after: after.responsible,
    }).toStrictEqual({
      before: { owner: owner.userId, responsible: owner.userId },
      named: { owner: owner.userId, responsible: user.userId },
      audited: [
        {
          action: "app.updated",
          actor: { type: "person", userId: builder.userId },
          detail: {
            responsible: user.userId,
            previousResponsible: owner.userId,
          },
        },
        {
          action: "app.updated",
          actor: { type: "person", userId: admin.userId },
          detail: {
            responsible: owner.userId,
            previousResponsible: user.userId,
          },
        },
      ],
      refused: {
        user: "role.forbidden",
        staff: "role.forbidden",
        noAccess: "app.responsible_invalid",
        removed: "app.responsible_invalid",
        nobody: "app.responsible_invalid",
      },
      stillOwner: "ok",
      namedBuilds: "role.forbidden",
      after: owner.userId,
    });
  });
});

describe("who answers for a draft", slow, () => {
  it("is only someone who builds it, as only they open a draft", async () => {
    const [owner, builder, user] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
    ]);
    const { id: app } = await owner.api.apps.create({
      name: `Draft ${unique()}`,
    });
    await share(owner, app, builder, "builder");
    await share(owner, app, user, "user");

    const refused = await outcome(
      owner.api.apps.update(app, { responsible: user.userId })
    );
    const named = await owner.api.apps.update(app, {
      responsible: builder.userId,
    });
    expect({ refused, named: named.responsible }).toStrictEqual({
      refused: "app.responsible_invalid",
      named: builder.userId,
    });
  });
});

describe("an App's owner, named again to answer for it", slow, () => {
  it("qualifies only as anyone else would: not once removed, nor for a draft once they no longer build", async () => {
    const [demoted, removed, builder, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    // Drafts, which only those who build them open.
    const draftOf = async (owner: Person): Promise<string> => {
      const { id } = await owner.api.apps.create({ name: `Draft ${unique()}` });
      await share(owner, id, builder, "builder");
      await builder.api.apps.update(id, { responsible: builder.userId });
      return id;
    };
    const [ofDemoted, ofRemoved] = await Promise.all([
      draftOf(demoted),
      draftOf(removed),
    ]);
    await admin.api.members.setRole(demoted.userId, "user");
    await admin.api.members.remove(removed.userId);

    const refused = {
      demoted: await outcome(
        builder.api.apps.update(ofDemoted, { responsible: demoted.userId })
      ),
      removed: await outcome(
        builder.api.apps.update(ofRemoved, { responsible: removed.userId })
      ),
    };
    const kept = await builder.api.apps.get(ofDemoted);
    // Published, the App is open to its owner as a user: they may answer.
    await published(ofDemoted);
    const named = await builder.api.apps.update(ofDemoted, {
      responsible: demoted.userId,
    });

    expect({
      refused,
      kept: kept.responsible,
      named: named.responsible,
    }).toStrictEqual({
      refused: {
        demoted: "app.responsible_invalid",
        removed: "app.responsible_invalid",
      },
      kept: builder.userId,
      named: demoted.userId,
    });
  });
});

describe("whom an App is made for", slow, () => {
  it("is a team or a member of the organization a builder names, or nobody in particular, and grants nothing", async () => {
    const [owner, admin, person] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
      personApi("user"),
    ]);
    const team = await newTeam(admin, [person]);
    const app = await newApp(owner);

    const created = await owner.api.apps.get(app);
    const audited = await auditedDuring(
      async () =>
        await owner.api.apps.update(app, {
          audience: { type: "team", id: team },
        })
    );
    const forTeam = await owner.api.apps.get(app);
    const forPerson = await owner.api.apps.update(app, {
      audience: { type: "person", id: person.userId },
    });
    // Made for them, but not shared with them: they can't open it.
    const reached = await outcome(person.api.apps.get(app));
    const refused = {
      team: await outcome(
        owner.api.apps.update(app, {
          audience: { type: "team", id: `team-${unique()}` },
        })
      ),
      person: await outcome(
        owner.api.apps.update(app, {
          audience: { type: "person", id: `user-${unique()}` },
        })
      ),
    };
    const cleared = await owner.api.apps.update(app, { audience: null });
    // Clearing what is clear changes and records nothing.
    const clearedAgain = await auditedDuring(
      async () => await owner.api.apps.update(app, { audience: null })
    );

    expect({
      created: created.audience,
      audited: said(audited),
      forTeam: forTeam.audience,
      forPerson: forPerson.audience,
      reached,
      refused,
      cleared: cleared.audience,
      clearedAgain: clearedAgain.length,
    }).toStrictEqual({
      created: null,
      audited: [
        {
          action: "app.updated",
          actor: { type: "person", userId: owner.userId },
          detail: {
            audienceType: "team",
            audience: team,
            previousAudienceType: null,
            previousAudience: null,
          },
        },
      ],
      forTeam: { type: "team", id: team },
      forPerson: { type: "person", id: person.userId },
      reached: "app.not_found",
      refused: {
        team: "app.audience_invalid",
        person: "app.audience_invalid",
      },
      cleared: null,
      clearedAgain: 0,
    });
  });

  it("isn't a team removed since it was checked", async () => {
    const [owner, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    const team = await newTeam(admin, []);
    const app = await newApp(owner);
    const by = await owner.api.whoami();
    // Removed just before the batch lands.
    const racing = racingDb(
      async (db) =>
        await db.prepare("DELETE FROM teams WHERE id = ?").bind(team).run()
    );

    const refused = await outcome(
      updateApp({ ...env, DB: racing }, by, app, {
        audience: { type: "team", id: team },
      })
    );
    const { audience } = await owner.api.apps.get(app);
    expect({ refused, audience }).toStrictEqual({
      refused: "app.conflict",
      audience: null,
    });
  });
});

describe("an App's integrations", slow, () => {
  it("are those it holds permissions on and those its builders add, listed to its users as entries only", async () => {
    const [owner, user, outsider] = await Promise.all([
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
    ]);
    const app = await newApp(owner);
    await share(owner, app, user, "user");
    const [mailbox, drive] = await Promise.all([
      connection("microsoft"),
      connection("google", "disconnected"),
    ]);
    await requestGranted(idp, owner, {
      ...outlook(app, `MAIL_${unique().toUpperCase()}`),
      object: { type: "connection", connectionId: mailbox },
    });
    // Asked for, not granted: the App still works with it.
    await owner.api.permissions.request({
      ...outlook(app, `DRIVE_${unique().toUpperCase()}`),
      object: { type: "connection", connectionId: drive },
    });

    const audited = await auditedDuring(async () => {
      await owner.api.apps.integrations.add(app, {
        source: "composio",
        id: "hubspot",
      });
      await owner.api.apps.integrations.add(app, {
        source: "native",
        id: "microsoft",
      });
      // Again: nothing changes, nothing is recorded.
      await owner.api.apps.integrations.add(app, {
        source: "composio",
        id: "hubspot",
      });
    });
    const listed = await user.api.apps.integrations.list(app);
    const refused = {
      user: await outcome(
        user.api.apps.integrations.add(app, { source: "composio", id: "slack" })
      ),
      outsider: await outcome(outsider.api.apps.integrations.list(app)),
      malformed: await outcome(
        owner.api.apps.integrations.add(app, {
          source: "composio",
          id: "../slack",
        })
      ),
      unknownSource: await outcome(
        // @ts-expect-error: not a catalog source, as a client could send it
        owner.api.apps.integrations.add(app, { source: "zapier", id: "slack" })
      ),
    };
    const removed = await auditedDuring(async () => {
      await owner.api.apps.integrations.remove(app, {
        source: "native",
        id: "microsoft",
      });
      await owner.api.apps.integrations.remove(app, {
        source: "composio",
        id: "salesforce",
      });
    });
    const after = await owner.api.apps.integrations.list(app);

    expect({
      audited: said(audited),
      listed,
      refused,
      removed: said(removed),
      after,
    }).toStrictEqual({
      audited: [
        {
          action: "app.integration.added",
          actor: { type: "person", userId: owner.userId },
          detail: { source: "composio", provider: "hubspot" },
        },
        {
          action: "app.integration.added",
          actor: { type: "person", userId: owner.userId },
          detail: { source: "native", provider: "microsoft" },
        },
      ],
      // The disconnected Google connection names nothing.
      listed: [
        { source: "composio", id: "hubspot", why: ["added"] },
        { source: "native", id: "microsoft", why: ["permission", "added"] },
      ],
      refused: {
        user: "role.forbidden",
        outsider: "app.not_found",
        malformed: "app.invalid",
        unknownSource: "app.invalid",
      },
      removed: [
        {
          action: "app.integration.removed",
          actor: { type: "person", userId: owner.userId },
          detail: { source: "native", provider: "microsoft" },
        },
      ],
      // Taking it off leaves the permission.
      after: [
        { source: "composio", id: "hubspot", why: ["added"] },
        { source: "native", id: "microsoft", why: ["permission"] },
      ],
    });
  });

  it(`are added by hand up to ${appLimits.addedIntegrations}`, async () => {
    const owner = await personApi("builder");
    const app = await newApp(owner);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: appLimits.addedIntegrations }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO app_integrations (app_id, source, connector_id, added_by, added_at) VALUES (?, 'composio', ?, ?, ?)"
        ).bind(app, `toolkit-${index}`, owner.userId, now)
      )
    );

    const refused = await outcome(
      owner.api.apps.integrations.add(app, { source: "composio", id: "slack" })
    );
    // One it has is no new one.
    const again = await outcome(
      owner.api.apps.integrations.add(app, {
        source: "composio",
        id: "toolkit-0",
      })
    );
    expect({ refused, again }).toStrictEqual({
      refused: "app.integrations_full",
      again: "ok",
    });
  });
});
