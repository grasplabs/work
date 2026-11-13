import { definitionText } from "@grasp-os/runtime/definition";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { releaseMonthPrefix } from "@grasp-os/shared/release-id";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appKind } from "../src/apps.ts";
import { readDraft, saveDraft } from "../src/drafts.ts";
import { sourceParts, testApp } from "./app-definitions.ts";
import type { TestApp, TestSource } from "./app-definitions.ts";
import { appVersionOf, appVersionsOf, commitApp } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { agentWriting } from "./draft-writers.ts";
import { mockIdp } from "./idp.ts";
import { storedGrant } from "./knowledge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// An App's draft published by one of its builders
// (`drafts.publish`): checked, committed as the App's next version,
// sealed, verified and made live in one step, as the person. What could
// go wrong: a draft that fails its check, or a version that fails its
// seal or its tests, going live, or leaving a version behind that never
// was live; a publish over a draft that moved since the person read it;
// two publishes at once both going live; someone who doesn't build the
// App publishing it; the App open to its users before anything of it is
// live; the draft left holding what went live.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A page whose button is restyled, which the design system's class checks refuse. */
const restyled = `import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@grasp-os/ui/components/button";

const Desk = () => (
  <main className="flex flex-col gap-4 p-6">
    <Button className="rounded-full">Approve</Button>
  </main>
);

export const Route = createFileRoute("/")({ component: Desk });
`;

/** The same page with the button's own variant: what the lint asks for. */
const fixed = restyled.replace(
  '<Button className="rounded-full">',
  '<Button variant="outline">'
);

/** The page, saying `word` on its button. */
const deskSaying = (word: string): Record<string, string> => ({
  "src/routes/index.tsx": fixed.replace("Approve", word),
});

/** The labels this month's versions take: `YY.MM.`, then their count. */
const month = releaseMonthPrefix(new Date());

/** A new App of `builder`'s, with no version yet. */
const appOf = async (builder: Person): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: `Desk ${unique()}` });
  return appIdSchema.parse(id);
};

/**
 * Writes `changes` into `app`'s draft as the agent of `person`'s chat for
 * the App writes them, over the draft as it is now; the draft's revision
 * after it.
 */
const writeDraft = async (
  person: Person,
  app: AppId,
  changes: TestSource
): Promise<number> => {
  const { id: chatId } = await person.api.chats.create("App changes");
  const { files, definition } = sourceParts(changes);
  const written = await saveDraft(
    env,
    appKind,

    app,
    await readDraft(env, { kind: "app", id: app }),
    {
      changes: { ...files },
      unchanged: [],
      ...(definition === undefined
        ? {}
        : { definition: definitionText(definition) }),
    },
    await agentWriting(person, chatId)
  );
  return written.revision;
};

/** Writes `changes` into `app`'s draft and publishes it, as `builder`. */
const publishing = async (builder: Person, app: AppId, changes: TestSource) => {
  const revision = await writeDraft(builder, app, changes);
  return await builder.api.drafts.publish({ kind: "app", id: app }, revision);
};

/** The version of `app` live now. */
const liveOf = async (builder: Person, app: AppId): Promise<number | null> => {
  const { currentVersion } = await builder.api.apps.get(app);
  return currentVersion;
};

/** The paths `app`'s draft changes. */
const changedOf = async (builder: Person, app: AppId): Promise<string[]> => {
  const { changed } = await builder.api.drafts.get({ kind: "app", id: app });
  return changed;
};

/** The numbers of `app`'s versions, newest first. */
const versionsOf = async (builder: Person, app: AppId): Promise<number[]> => {
  const versions = await builder.api.versions.list({ kind: "app", id: app });
  return versions.map(({ version }) => version);
};

/** An App test that takes a second. */
const aSecondsSuite = `import { appTest } from "@grasp-os/sdk/testing";
import schema from "../server/schema.ts";

export default appTest(schema, {
  "takes a second": async () => {
    // oxlint-disable-next-line promise/avoid-new -- a timer, to take a second
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  },
});
`;

/** Waits until `query`, over `app`, finds a row: at most 30 seconds. */
const until = async (query: string, app: AppId): Promise<void> => {
  const by = Date.now() + 30_000;
  // oxlint-disable-next-line no-await-in-loop -- polled until it does
  while ((await env.DB.prepare(query).bind(app).first()) === null) {
    if (Date.now() > by) {
      throw new Error(`Never found: ${query}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- polled until it does
    await scheduler.wait(5);
  }
};

/** A Notes App of spec 8's layout, with its App tests in `suite`. */
const notesWithTests = (suite: string): TestApp =>
  testApp(
    {
      name: "Notes",
      tables: {
        notes: {
          fields: { title: "v.string().min(1).max(200)" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    {
      "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const notes = await ctx.db.query("notes").take(100);
    return notes.map((note) => note.title);
  },
});
`,
      "tests/notes.test.ts": suite,
    }
  );

/** An App test that expects `titles` of the note it creates. */
const suiteExpecting = (
  titles: string[]
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";
import schema from "../server/schema.ts";

export default appTest(schema, {
  "reads back the note it creates": async (t) => {
    const writer = t.withIdentity({ name: "writer" });
    await writer.mutation(api.notes.create, { title: "First" });
    const titles = await writer.query(api.notes.titles, {});
    if (JSON.stringify(titles) !== ${JSON.stringify(JSON.stringify(titles))}) {
      throw new Error(\`Read back \${JSON.stringify(titles)}\`);
    }
  },
});
`;

describe("publishing an App's draft", { timeout: 180_000 }, () => {
  it("makes it live in one step, as the person, and empties the draft over the new version with a checkpoint", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    const revision = await writeDraft(builder, app, deskSaying("Approve"));

    const live = await builder.api.drafts.publish(
      { kind: "app", id: app },
      revision
    );
    const [version] = appVersionsOf(
      await builder.api.versions.list({ kind: "app", id: app })
    );
    const [point] = await builder.api.drafts.checkpoints({
      kind: "app",
      id: app,
    });
    const events = await allEvents();

    expect({
      live: live.version,
      liveLabel: live.label,
      version: {
        version: version?.version,
        label: version?.label,
        author: version?.author,
      },
      draft: await builder.api.drafts.get({ kind: "app", id: app }),
      point: {
        base: point?.base,
        personId: point?.personId,
        chatId: point?.chatId,
      },
      recorded: events
        .filter(
          ({ action, target }) =>
            action === "version.published" && target?.id === app
        )
        .map(({ actor, detail }) => ({ actor, detail })),
    }).toMatchObject({
      live: 1,
      liveLabel: `${month}1`,
      version: {
        version: 1,
        label: `${month}1`,
        author: builder.userId,
      },
      draft: {
        subject: { kind: "app", id: app },
        base: 1,
        changed: [],
        revision: revision + 1,
      },
      point: { base: 1, personId: builder.userId, chatId: null },
      recorded: [
        {
          actor: { type: "person", userId: builder.userId },
          detail: { version: 1, label: `${month}1`, previous: null },
        },
      ],
    });
  });

  it("publishes nothing that fails its check, and keeps the draft", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    const revision = await writeDraft(builder, app, {
      "src/routes/index.tsx": restyled,
    });

    const refused = await outcome(
      builder.api.drafts.publish({ kind: "app", id: app }, revision)
    );
    const draft = await builder.api.drafts.get({ kind: "app", id: app });

    expect({
      refused,
      live: await liveOf(builder, app),
      versions: await versionsOf(builder, app),
      draft: { changed: draft.changed, revision: draft.revision },
    }).toStrictEqual({
      refused: "app.draft_failed",
      live: null,
      versions: [],
      draft: { changed: ["src/routes/index.tsx"], revision },
    });
  });

  it("publishes nothing from a draft that changes nothing", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    await publishing(builder, app, deskSaying("Approve"));
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });

    const refused = await outcome(
      builder.api.drafts.publish({ kind: "app", id: app }, revision)
    );

    expect({ refused, versions: await versionsOf(builder, app) }).toStrictEqual(
      { refused: "draft.empty", versions: [1] }
    );
  });

  it("publishes nothing over a revision the draft moved past", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    const read = await writeDraft(builder, app, deskSaying("Approve"));
    // Another write lands after the person read the draft.
    await writeDraft(builder, app, deskSaying("Sign"));

    const refused = await outcome(
      builder.api.drafts.publish({ kind: "app", id: app }, read)
    );

    expect({ refused, versions: await versionsOf(builder, app) }).toStrictEqual(
      { refused: "draft.conflict", versions: [] }
    );
  });

  it("is any builder's, and never someone's who only uses the App", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    await publishing(builder, app, deskSaying("Approve"));
    const [other, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    for (const [member, role] of [
      [other, "builder"],
      [user, "user"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await builder.api.apps.members.add(app, {
        type: "person",
        id: member.userId,
        role,
      });
    }
    const revision = await writeDraft(builder, app, deskSaying("Sign"));

    const notBuilding = await outcome(
      user.api.drafts.publish({ kind: "app", id: app }, revision)
    );
    const anotherBuilder = await outcome(
      other.api.drafts.publish({ kind: "app", id: app }, revision)
    );

    expect({
      notBuilding,
      anotherBuilder,
      versions: await versionsOf(builder, app),
    }).toStrictEqual({
      notBuilding: "role.forbidden",
      anotherBuilder: "ok",
      versions: [2, 1],
    });
  });

  it("opens the App to the people it is shared with once its first version is live", async () => {
    const [builder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const app = await appOf(builder);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const before = await outcome(user.api.apps.get(app));

    await publishing(builder, app, deskSaying("Approve"));

    expect({
      before,
      after: await user.api.apps.get(app),
    }).toMatchObject({
      before: "app.not_found",
      after: { id: app, currentVersion: 1 },
    });
  });

  it("never makes live a version whose App tests fail, which takes no label, and the next publish takes the next label", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    await publishing(builder, app, notesWithTests(suiteExpecting(["First"])));

    const failing = await outcome(
      publishing(builder, app, {
        "tests/notes.test.ts": suiteExpecting(["Something else"]),
      })
    );
    const afterFailure = {
      live: await liveOf(builder, app),
      versions: await versionsOf(builder, app),
      changed: await changedOf(builder, app),
    };
    // Fixed: the failed version's number stays its own.
    const fixedSuite = `${suiteExpecting(["First"])}// Fixed.\n`;
    const live = await publishing(builder, app, {
      "tests/notes.test.ts": fixedSuite,
    });

    const listed = await builder.api.versions.list({ kind: "app", id: app });
    expect({
      failing,
      afterFailure,
      live: live.version,
      versions: await versionsOf(builder, app),
      labels: listed.map(({ label }) => label),
    }).toStrictEqual({
      failing: "version.tests_failed",
      // Its version stays, failed, never live: what was tried.
      afterFailure: {
        live: 1,
        versions: [2, 1],
        changed: ["tests/notes.test.ts"],
      },
      live: 3,
      versions: [3, 2, 1],
      labels: [`${month}2`, null, `${month}1`],
    });
  });

  it("brings back nothing of a draft whose publish failed once a builder discarded it", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    const passing = suiteExpecting(["First"]);
    await publishing(builder, app, notesWithTests(passing));
    const failing = await outcome(
      publishing(builder, app, {
        "tests/notes.test.ts": suiteExpecting(["Discarded"]),
      })
    );
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });
    await builder.api.drafts.discard({ kind: "app", id: app }, revision);

    const live = await publishing(builder, app, { "notes.md": "Notes\n" });

    const files = await builder.api.versions.files({ kind: "app", id: app }, 3);
    const version = appVersionOf(
      await builder.api.versions.get({ kind: "app", id: app }, 3)
    );
    expect({
      failing,
      live: live.version,
      parent: version.parent,
      suite: files["tests/notes.test.ts"],
      notes: files["notes.md"],
    }).toStrictEqual({
      failing: "version.tests_failed",
      live: 3,
      parent: 1,
      suite: passing,
      notes: "Notes\n",
    });
  });

  it("publishes over the version a builder rolled back to, the draft's changes discarded with the roll back, audited", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    await publishing(builder, app, deskSaying("Approve"));
    await publishing(builder, app, deskSaying("Sign"));
    const unpublished = await writeDraft(builder, app, { "notes.md": "Old\n" });
    await builder.api.versions.rollback(
      { kind: "app", id: app },
      1,
      unpublished,
      2
    );
    const rolledBack = await builder.api.drafts.get({ kind: "app", id: app });

    const live = await publishing(builder, app, { "notes.md": "New\n" });

    const files = await builder.api.versions.files({ kind: "app", id: app }, 3);
    const version = appVersionOf(
      await builder.api.versions.get({ kind: "app", id: app }, 3)
    );
    const events = await allEvents();
    expect({
      rolledBack: { base: rolledBack.base, changed: rolledBack.changed },
      live: live.version,
      parent: version.parent,
      desk: files["src/routes/index.tsx"],
      notes: files["notes.md"],
      discarded: events
        .filter(
          ({ action, target }) =>
            action === "draft.discarded" && target?.id === app
        )
        .map(({ detail }) => detail),
    }).toStrictEqual({
      rolledBack: { base: 1, changed: [] },
      live: 3,
      parent: 1,
      desk: deskSaying("Approve")["src/routes/index.tsx"],
      notes: "New\n",
      discarded: [{ version: 1 }],
    });
  });

  it("audits the draft's changes discarded by a roll back to the version live already", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    await publishing(builder, app, deskSaying("Approve"));
    const unpublished = await writeDraft(builder, app, { "notes.md": "Old\n" });

    await builder.api.versions.rollback(
      { kind: "app", id: app },
      1,
      unpublished,
      1
    );

    const events = await allEvents();
    expect({
      changed: await changedOf(builder, app),
      discarded: events
        .filter(
          ({ action, target }) =>
            action === "draft.discarded" && target?.id === app
        )
        .map(({ actor, detail }) => ({ actor, detail })),
    }).toStrictEqual({
      changed: [],
      discarded: [
        {
          actor: { type: "person", userId: builder.userId },
          detail: { revision: unpublished + 1 },
        },
      ],
    });
  });

  it("makes one of two publishes at once live, and refuses the other", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    await publishing(builder, app, deskSaying("Approve"));
    const revision = await writeDraft(builder, app, deskSaying("Sign"));

    const outcomes = await Promise.all([
      outcome(builder.api.drafts.publish({ kind: "app", id: app }, revision)),
      outcome(builder.api.drafts.publish({ kind: "app", id: app }, revision)),
    ]);

    const [refused, published] = outcomes.toSorted();
    expect({
      refused,
      published,
      live: await liveOf(builder, app),
      versions: await versionsOf(builder, app),
    }).toStrictEqual({
      refused: "draft.conflict",
      published: "ok",
      live: 2,
      versions: [2, 1],
    });
  });

  it("keeps a write that lands while the draft goes live, and publishes it next over the new version", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    // Its App test takes a second: the time between committing a version
    // and making it live.
    await publishing(builder, app, notesWithTests(aSecondsSuite));
    const revision = await writeDraft(builder, app, { "notes.md": "One\n" });
    const { id: chatId } = await builder.api.chats.create("App changes");
    const writer = await agentWriting(builder, chatId);

    const going = builder.api.drafts.publish(
      { kind: "app", id: app },
      revision
    );
    // Once version 2 is committed, before it goes live, an agent writes.
    await until(
      "SELECT 1 FROM app_versions WHERE app_id = ? AND version = 2",
      app
    );
    await saveDraft(
      env,
      appKind,

      app,
      await readDraft(env, { kind: "app", id: app }),
      { changes: { "later.md": "Two\n" }, unchanged: [] },
      writer
    );
    await going;
    const left = await builder.api.drafts.get({ kind: "app", id: app });
    const points = await builder.api.drafts.checkpoints({
      kind: "app",
      id: app,
    });
    const raced = points.find(
      ({ chatId: by, touched }) => by === chatId && touched.includes("later.md")
    );
    const live = await builder.api.drafts.publish(
      { kind: "app", id: app },
      left.revision
    );

    const files = await builder.api.versions.files({ kind: "app", id: app }, 3);
    const version = appVersionOf(
      await builder.api.versions.get({ kind: "app", id: app }, 3)
    );
    expect({
      raced: raced?.base,
      left: { base: left.base, changed: left.changed },
      live: live.version,
      parent: version.parent,
      notes: files["notes.md"],
      later: files["later.md"],
    }).toStrictEqual({
      // The write landed over version 1, which publishing 2 couldn't
      // empty: the draft is moved onto 2, only the write left unshared.
      raced: 1,
      left: { base: 2, changed: ["later.md"] },
      live: 3,
      parent: 2,
      notes: "One\n",
      later: "Two\n",
    });
  });

  it("rolls back over a write that lands during it, a change of the store's schema and all, discarding the write, audited, its checkpoint kept to restore", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    const notes = notesWithTests(aSecondsSuite);
    await publishing(builder, app, notes);
    // Version 2, committed and never published, with a table more: rolling
    // back to it seals and tests it first, which takes a second, then
    // gives the store its schema.
    await commitApp(
      builder.api,
      app,
      testApp(
        {
          name: "Notes",
          tables: {
            notes: {
              fields: { title: "v.string().min(1).max(200)" },
              access: { read: "appMembers", write: "appMembers" },
            },
            tags: {
              fields: { name: "v.string().min(1).max(50)" },
              access: { read: "appMembers", write: "appMembers" },
            },
          },
        },
        notes.files
      )
    );
    await publishing(builder, app, { "notes.md": "Three\n" });
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });
    const { id: chatId } = await builder.api.chats.create("App changes");
    const writer = await agentWriting(builder, chatId);
    const before = await allEvents();
    const earlier = new Set(before.map(({ id }) => id));

    const rolling = builder.api.versions.rollback(
      { kind: "app", id: app },
      2,
      revision,
      3
    );
    // Once version 2 is sealed, before it goes live, an agent writes.
    await until(
      "SELECT 1 FROM sdk_release_manifests WHERE app_id = ? AND version = 2",
      app
    );
    const written = await saveDraft(
      env,
      appKind,
      app,
      await readDraft(env, { kind: "app", id: app }),
      { changes: { "later.md": "Later\n" }, unchanged: [] },
      writer
    );
    const rolled = await rolling;
    const after = await builder.api.drafts.get({ kind: "app", id: app });
    const events = await allEvents();
    const discarded = events
      .filter(
        ({ id, action, target }) =>
          !earlier.has(id) && action === "draft.discarded" && target?.id === app
      )
      .map(({ detail }) => detail);
    // The write is still there to step back to, over the version live.
    const [kept] = await builder.api.drafts.checkpoints({
      kind: "app",
      id: app,
    });
    const writes = await builder.api.drafts.checkpoints({
      kind: "app",
      id: app,
    });
    const own = writes.find((each) => each.revision === written.revision);
    await builder.api.drafts.restore(
      { kind: "app", id: app },
      own?.number ?? 0,
      after.revision
    );
    const restored = await builder.api.drafts.get({ kind: "app", id: app });

    expect({
      live: rolled.version,
      after: { base: after.base, changed: after.changed },
      discarded,
      kept: kept?.changes,
      restored: {
        base: restored.base,
        later: restored.changed.includes("later.md"),
      },
    }).toStrictEqual({
      live: 2,
      // Over version 2, with nothing of version 3 or the write as its own.
      after: { base: 2, changed: [] },
      discarded: [{ version: 2 }],
      kept: 0,
      restored: { base: 2, later: true },
    });
  });

  it("restores a checkpoint from before a publish over the version live, and publishes it", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appOf(builder);
    await publishing(builder, app, deskSaying("Approve"));
    await writeDraft(builder, app, { "notes.md": "Old\n" });
    const [old] = await builder.api.drafts.checkpoints({
      kind: "app",
      id: app,
    });
    await publishing(builder, app, { "notes.md": "New\n" });
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });

    await builder.api.drafts.restore(
      { kind: "app", id: app },
      old?.number ?? 0,
      revision
    );
    const restored = await builder.api.drafts.get({ kind: "app", id: app });
    const live = await builder.api.drafts.publish(
      { kind: "app", id: app },
      restored.revision
    );

    const files = await builder.api.versions.files({ kind: "app", id: app }, 3);
    const version = appVersionOf(
      await builder.api.versions.get({ kind: "app", id: app }, 3)
    );
    expect({
      restored: { base: restored.base, changed: restored.changed },
      live: live.version,
      parent: version.parent,
      notes: files["notes.md"],
      desk: files["src/routes/index.tsx"],
    }).toStrictEqual({
      restored: { base: 2, changed: ["notes.md"] },
      live: 3,
      parent: 2,
      notes: "Old\n",
      desk: deskSaying("Approve")["src/routes/index.tsx"],
    });
  });
});

// What a builder reviews before publishing (`apps.review`): the
// draft against the live version, worked out by core, never by whoever
// wrote it. What could go wrong: a review that shows other files than a
// publish commits, a check that passes where publishing refuses, a
// revision other than the one the review showed published, access the
// publish asks an admin for again left unsaid, or someone who only uses
// the App reading its draft.
describe(
  "reviewing an App's draft before publishing it",
  { timeout: 180_000 },
  () => {
    it("compares the draft with the live version, file by file, at the revision it publishes", async () => {
      const builder = await signedInApi(idp, "builder");
      const app = await appOf(builder);
      await publishing(builder, app, {
        ...deskSaying("Approve"),
        "src/routes/old.tsx": deskSaying("Old")["src/routes/index.tsx"] ?? "",
      });
      const revision = await writeDraft(builder, app, {
        ...deskSaying("Sign"),
        "src/routes/old.tsx": null,
        "src/routes/new.tsx": deskSaying("New")["src/routes/index.tsx"] ?? "",
      });

      const changes = await builder.api.apps.review(app);
      const checked = await builder.api.drafts.check({ kind: "app", id: app });
      const published = await builder.api.drafts.publish(
        { kind: "app", id: app },
        changes.revision
      );

      expect({
        revision: changes.revision,
        live: changes.live,
        liveLabel: changes.liveLabel,
        next: changes.next,
        files: changes.files.map(({ path, change }) => ({ path, change })),
        signs: changes.files.some(
          (file) => file.change === "modified" && file.after.includes("Sign")
        ),
        check: checked,
        published: published.version,
      }).toStrictEqual({
        revision,
        live: 1,
        liveLabel: `${month}1`,
        next: `${month}2`,
        files: [
          { path: "src/routes/index.tsx", change: "modified" },
          { path: "src/routes/new.tsx", change: "added" },
          { path: "src/routes/old.tsx", change: "deleted" },
        ],
        signs: true,
        check: { revision, passed: true, problems: [] },
        published: 2,
      });
    });

    it("says the draft fails its check, with where, as publishing refuses it", async () => {
      const builder = await signedInApi(idp, "builder");
      const app = await appOf(builder);
      const revision = await writeDraft(builder, app, {
        "src/routes/index.tsx": restyled,
      });

      const { live, next } = await builder.api.apps.review(app);
      const check = await builder.api.drafts.check({ kind: "app", id: app });
      const refused = await outcome(
        builder.api.drafts.publish({ kind: "app", id: app }, revision)
      );

      expect({
        live,
        next,
        passed: check.passed,
        atThePage: check.problems.some(
          ({ at }) => at === "src/routes/index.tsx"
        ),
        refused,
      }).toStrictEqual({
        live: null,
        next: `${month}1`,
        passed: false,
        atThePage: true,
        refused: "app.draft_failed",
      });
    });

    it("names the access the App waits for, the same for a builder and an admin, and nothing it holds already", async () => {
      const [builder, admin] = await Promise.all([
        signedInApi(idp, "builder"),
        signedInApi(idp, "admin"),
      ]);
      const app = await appOf(builder);
      await builder.api.apps.members.add(app, {
        type: "person",
        id: admin.userId,
        role: "builder",
      });
      await storedGrant(
        { type: "app", id: app },
        { type: "connection", id: crypto.randomUUID() },
        ["send"],
        "MAIL"
      );
      const calendar = await storedGrant(
        { type: "app", id: app },
        { type: "connection", id: crypto.randomUUID() },
        ["list"],
        "CALENDAR",
        "requested"
      );
      await writeDraft(builder, app, deskSaying("Approve"));

      const waiting = async (by: Person) => {
        const { permissions } = await by.api.apps.review(app);
        return permissions.map(({ id }) => id);
      };

      expect({
        builder: await waiting(builder),
        admin: await waiting(admin),
      }).toStrictEqual({ builder: [calendar], admin: [calendar] });
    });

    it("is for the App's builders, never someone who only uses it", async () => {
      const [builder, user] = await Promise.all([
        signedInApi(idp, "builder"),
        signedInApi(idp, "user"),
      ]);
      const app = await appOf(builder);
      await builder.api.apps.members.add(app, {
        type: "person",
        id: user.userId,
        role: "user",
      });
      await publishing(builder, app, deskSaying("Approve"));
      await writeDraft(builder, app, deskSaying("Sign"));

      await expect(outcome(user.api.apps.review(app))).resolves.toBe(
        "role.forbidden"
      );
    });
  }
);
