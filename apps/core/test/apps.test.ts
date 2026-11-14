import {
  definitionSources,
  definitionText,
} from "@grasp-os/runtime/definition";
import type { AppDefinition } from "@grasp-os/runtime/definition";
import { ownFiles } from "@grasp-os/runtime/host";
import { appLimits } from "@grasp-os/shared/app-limits";
import { appErrors } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { releaseMonthPrefix } from "@grasp-os/shared/release-id";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { definitionRefusal } from "../src/app-definition.ts";
import { reviewDraft } from "../src/app-review.ts";
import { findApp } from "../src/apps.ts";
import { memberOf } from "../src/auth/identity.ts";
import {
  appOf,
  definitionInput,
  definitionOf,
  publishApp,
  sourceParts,
  testApp,
  withFiles,
} from "./app-definitions.ts";
import {
  appVersionOf,
  appVersionsOf,
  publishDefined,
  racingDb,
} from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";

// An App's code is versioned as a whole: its builders write its draft and
// publish it as its next version, which never changes afterwards and goes
// live; one version runs (current), and any other can be made current
// again. Every version and every change of version is audited.

const idp = mockIdp();

/** A signed-in person's App API, on a connection of their own. */
const appsApi = async (role: Role) => {
  const person = await signedInApi(idp, role);
  return { ...person, apps: person.api.apps, versions: person.api.versions };
};

type Apps = Awaited<ReturnType<typeof appsApi>>["apps"];
type Api = Awaited<ReturnType<typeof appsApi>>["api"];

const refusalSchema = z.object({
  details: z.object({ issues: z.array(z.string()) }),
});

/** The issues an `app.invalid` gives, joined, or "ok" if it wasn't refused. */
const issuesOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    const refusal = refusalSchema.safeParse(error);
    return refusal.success
      ? refusal.data.details.issues.join("; ")
      : (appErrors.codeOf(error) ?? String(error));
  }
};

const newApp = async (apps: Apps) =>
  await apps.create({ name: "Invoice desk", description: "Invoices@" });

/**
 * Writes `changes` into App `app`'s draft over the revision read
 * (`drafts.write`), after `definition` whole when given (`apps.define`):
 * the draft as saved.
 */
const drafted = async (
  api: Api,
  app: string,
  changes: Record<string, string | null>,
  definition?: unknown
) => {
  if (definition !== undefined) {
    const defined = await api.apps.define(app, {
      op: "setDefinition",
      definition,
    });
    if (!defined.ok) {
      throw new Error(defined.problem);
    }
  }
  const subject = { kind: "app", id: app } as const;
  const { revision } = await api.drafts.get(subject);
  return await api.drafts.write(subject, revision, changes);
};

/** App `app`'s subject, as drafts and versions name it. */
const subjectOf = (app: string) => ({ kind: "app", id: app }) as const;

/**
 * Gives an App without versions a first one holding `files` exactly,
 * unchecked: committed before a check existed or a limit was lowered.
 * With `definition` null, one that holds none.
 */
const storedUnchecked = async (
  app: string,
  author: string,
  files: Readonly<Record<string, string>>,
  definition: string | null = definitionText(
    definitionOf({ name: "Invoice desk" })
  )
): Promise<void> => {
  const json = canonicalJson(files);
  const tree = await sha256Hex(json);
  await env.FILES.put(`apps/${app}/trees/${tree}.json`, json);
  await env.DB.prepare(
    "INSERT INTO app_versions (app_id, version, tree, definition, definition_hash, files, author_id, message, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, 'Earlier', 0)"
  )
    .bind(
      app,
      tree,
      definition,
      definition === null ? null : await sha256Hex(definition),
      Object.keys(files).length,
      author
    )
    .run();
};

/**
 * `files` as an App's limits count them: what Grasp generates under
 * `server/_generated/` apart.
 */

/** The App's definition, and the config and schema generated from it. */
const defined = testApp({ name: "Invoice desk" });

/** The test App's definition with one table, `table`, of a title. */
const withTable = (table: string) =>
  definitionOf({
    name: "Invoice desk",
    tables: { [table]: { fields: { title: "v.string()" } } },
  });

const first = withFiles(defined, {
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Page = () => <p>Inbox</p>;

export const Route = createFileRoute("/")({ component: Page });
`,
  "AGENTS.md": "# Invoice desk — facturen, 請求書 🧾\n",
});

// Publishing checks, builds and seals each version, which takes seconds
// on a loaded runner, closer to the default five than the rest of this
// file. Nothing polls or sleeps; sixty seconds is room for a slow runner,
// as the other tests that release Apps give theirs.
describe("App code", { timeout: 60_000 }, () => {
  it("reads back every version exactly as it was published", async () => {
    const { api, userId, versions } = await appsApi("builder");
    const app = await newApp(api.apps);
    const subject = subjectOf(app.id);
    const second = {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Page = () => <p>Invoices</p>;

export const Route = createFileRoute("/")({ component: Page });
`,
      "src/components/row.tsx": "export const Row = () => null;\n",
      "AGENTS.md": null,
    };
    await publishApp(api, app.id, first);
    await publishApp(api, app.id, second);

    const [newestFirst, beforeTwo, one, two] = await Promise.all([
      versions.list(subject),
      versions.list(subject, 2),
      versions.get(subject, 1),
      versions.get(subject, 2),
    ]);
    expect({ one, two }).toMatchObject({
      // Its own four, and the four of server/_generated/.
      one: { version: 1, parent: null, files: 8, author: userId },
      two: { version: 2, parent: 1, files: 8, author: userId },
    });
    expect({
      files: await Promise.all([
        versions.files(subject, 1),
        versions.files(subject, 2),
      ]),
      newestFirst: appVersionsOf(newestFirst).map(({ version }) => version),
      beforeTwo,
    }).toStrictEqual({
      files: [first.files, withFiles(defined, second).files],
      newestFirst: [2, 1],
      beforeTwo: [one],
    });
  });

  it("reads the draft as the live version while it changes nothing, and publishes no draft that changes nothing", async () => {
    const { api, versions } = await appsApi("builder");
    const app = await newApp(api.apps);
    const subject = subjectOf(app.id);
    const none = await api.drafts.files(subject);
    await publishApp(api, app.id, first);
    const afterFirst = await api.drafts.files(subject);
    await publishApp(api, app.id, {
      "AGENTS.md": "# Second\n",
      "src/routes/index.tsx": null,
    });
    // What is already there, deleting what isn't, and deleting the
    // schema its definition generates back, change nothing.
    const nothing: string[] = [];
    const unchanging: Record<string, string | null>[] = [
      { "AGENTS.md": "# Second\n" },
      { "src/routes/index.tsx": null },
      { "server/schema.ts": null },
    ];
    for (const changes of unchanging) {
      // oxlint-disable-next-line no-await-in-loop -- each over the draft as the last left it
      nothing.push(await outcome(publishApp(api, app.id, changes)));
    }

    const listed = await versions.list(subject);
    expect({
      none,
      afterFirst,
      latest: await api.drafts.files(subject),
      one: await versions.files(subject, 1),
      nothing,
      versions: listed.length,
    }).toStrictEqual({
      none: {},
      afterFirst: first.files,
      latest: withFiles(defined, { "AGENTS.md": "# Second\n" }).files,
      one: first.files,
      nothing: ["draft.empty", "draft.empty", "draft.empty"],
      versions: 2,
    });
  });

  it("gives an App a definition with its first version, and keeps its config and schema as the definition generates them", async () => {
    const { api, versions } = await appsApi("builder");
    const app = await newApp(api.apps);
    const subject = subjectOf(app.id);
    const page = `import { createFileRoute } from "@tanstack/react-router";

const Page = () => null;

export const Route = createFileRoute("/")({ component: Page });
`;
    // Pages alone: the first version gets an empty definition, named as
    // the App is, and the config and schema generated from it.
    await publishApp(api, app.id, { "src/routes/index.tsx": page });
    const pagesOnly = await api.drafts.files(subject);
    // A config written by hand is generated over, whatever it held.
    await publishApp(api, app.id, {
      "grasp.config.ts": 'export default { name: "Mine" };\n',
      "AGENTS.md": "# Mine\n",
    });
    const handwritten = await api.drafts.files(subject);
    // A definition that isn't one: refused, nothing of it kept.
    const invalid = await api.apps.define(app.id, {
      op: "setDefinition",
      definition: { name: 1 },
    });
    const listed = await versions.list(subject);
    expect({
      pagesOnly,
      config: handwritten["grasp.config.ts"],
      invalid: invalid.ok,
      versions: listed.map(({ version }) => version),
    }).toStrictEqual({
      pagesOnly: withFiles(defined, { "src/routes/index.tsx": page }).files,
      config: defined.files["grasp.config.ts"],
      invalid: false,
      versions: [2, 1],
    });
  });

  it("holds each version's definition beside its files, never among them, and publishes a change of the definition alone", async () => {
    const { api } = await appsApi("builder");
    const app = await newApp(api.apps);
    const subject = subjectOf(app.id);
    const notes = definitionOf({
      name: "Invoice desk",
      tables: { notes: { fields: { title: "v.string()" } } },
    });
    await publishApp(api, app.id, first);
    // The same files, another definition: a version of its own, its code
    // generated from the definition it was published with.
    const unchanged = { "AGENTS.md": first.files["AGENTS.md"] ?? "" };
    await drafted(api, app.id, unchanged, definitionInput(notes));
    const { revision } = await api.drafts.get(subject);
    const redefined = await api.drafts.publish(subject, revision);
    const files = await api.drafts.files(subject);
    // The same files and definition again change nothing.
    await drafted(api, app.id, unchanged, definitionInput(notes));
    const { revision: again } = await api.drafts.get(subject);
    const unchangedAgain = await outcome(api.drafts.publish(subject, again));
    // A write that names no definition keeps the draft's.
    await publishApp(api, app.id, { "AGENTS.md": "# Notes\n" });
    const latest = await api.drafts.files(subject);
    expect({
      version: redefined.version,
      paths: Object.keys(files).toSorted(),
      generated: {
        "grasp.config.ts": files["grasp.config.ts"],
        "server/schema.ts": files["server/schema.ts"],
      },
      kept: latest["server/schema.ts"],
      unchangedAgain,
    }).toStrictEqual({
      version: 2,
      paths: Object.keys(first.files).toSorted(),
      generated: definitionSources(notes),
      kept: definitionSources(notes)["server/schema.ts"],
      unchangedAgain: "draft.empty",
    });
  });

  it("reviews a change of the definition in a draft as a change of the server code, with what it does to the records, renames included", async () => {
    const { api, userId } = await appsApi("admin");
    const app = await newApp(api.apps);
    const two = definitionOf({
      name: "Invoice desk",
      tables: {
        notes: { fields: { title: "v.string()", body: "v.string()" } },
      },
    });
    const [table] = two.tables;
    const [title, body] = table?.fields ?? [];
    if (table === undefined || title === undefined || body === undefined) {
      throw new Error("The notes table has no title and body");
    }
    // The same names, their IDs swapped: the same code, and on publish
    // each field's values move to the other.
    const swapped = {
      ...two,
      tables: [
        {
          ...table,
          fields: [
            { ...title, id: body.id },
            { ...body, id: title.id },
          ],
        },
      ],
    };
    await publishApp(api, app.id, appOf(two, first.files));
    // Drafts over the live version 1, each holding a change.
    const live = await findApp(env, app.id);
    const by = await memberOf(env.DB, userId);
    if (by === undefined) {
      throw new Error("Not a member");
    }
    const reviewOf = async (
      definition: AppDefinition,
      changes: Record<string, string> = {}
    ) =>
      await reviewDraft(env, by, live, {
        base: 1,
        changes,
        definition: definitionText(definition),
        revision: 0,
      });
    const [swappedReview, filesOnly, renamedReview] = await Promise.all([
      reviewOf(swapped),
      reviewOf(two, { "AGENTS.md": "# Notes\n" }),
      // A rename: the title's values move to the heading.
      reviewOf({
        ...two,
        tables: [{ ...table, fields: [{ ...title, name: "heading" }, body] }],
      }),
    ]);
    expect({
      serverFiles: swappedReview.serverFiles,
      server: swappedReview.server,
      // The store takes no swap of two fields' names: it needs a migration.
      refused: swappedReview.plan?.refused.map(({ reason }) => reason),
      filesOnly: [filesOnly.server, filesOnly.plan?.renamedFields],
      renamed: renamedReview.plan?.renamedFields,
    }).toStrictEqual({
      serverFiles: [],
      server: "modified",
      refused: ["name_taken", "name_taken"],
      filesOnly: [null, []],
      renamed: [{ table: "notes", from: "title", to: "heading" }],
    });
  });

  it("never changes a version's definition once published", async () => {
    const { api } = await appsApi("builder");
    const app = await newApp(api.apps);
    await publishApp(api, app.id, first);
    const other = definitionText(withTable("notes"));
    // Whether the database refuses to change `column` to `value`.
    const refused = async (column: string, value: string): Promise<boolean> => {
      const changed = await outcome(
        env.DB.prepare(
          `UPDATE app_versions SET ${column} = ? WHERE app_id = ? AND version = 1`
        )
          .bind(value, app.id)
          .run()
      );
      return changed.includes("never changes");
    };
    expect({
      definition: await refused("definition", other),
      hash: await refused("definition_hash", await sha256Hex(other)),
      files: await api.versions.files(subjectOf(app.id), 1),
    }).toStrictEqual({
      definition: true,
      hash: true,
      files: first.files,
    });
  });

  it("refuses to build on or run a version that holds no definition, saying so", async () => {
    const { api, userId, versions } = await appsApi("builder");
    const app = await newApp(api.apps);
    await storedUnchecked(app.id, userId, first.files, null);
    let refusal: unknown;
    try {
      await drafted(api, app.id, { "AGENTS.md": "# Again\n" });
    } catch (error) {
      refusal = error;
    }
    const seal = await outcome(versions.rollback(subjectOf(app.id), 1));
    const listed = await versions.list(subjectOf(app.id));
    expect({
      write: appErrors.codeOf(refusal),
      issues: definitionRefusal(refusal),
      seal,
      versions: listed.map(({ version }) => version),
    }).toStrictEqual({
      write: "app.definition_invalid",
      issues: "The App's version holds no definition.",
      seal: "app.definition_invalid",
      versions: [1],
    });
  });

  it("fails loudly when a version's files are missing or damaged", async () => {
    const { api } = await appsApi("builder");
    const app = await newApp(api.apps);
    const subject = subjectOf(app.id);
    await publishApp(api, app.id, first);
    const { tree } = appVersionOf(await api.versions.get(subject, 1));
    const key = `apps/${app.id}/trees/${tree}.json`;
    const object = await env.FILES.get(key);
    const stored = (await object?.text()) ?? "";

    await env.FILES.put(key, stored.replace("Inbox", "Outbox"));
    const damaged = await outcome(api.versions.files(subject, 1));
    await env.FILES.delete(key);
    const missing = await outcome(api.versions.files(subject, 1));
    expect({ damaged, missing }).toStrictEqual({
      damaged: "internal.unexpected",
      missing: "internal.unexpected",
    });
  });

  it("refuses paths that can't both exist: a file and its folder, or names differing only in case", async () => {
    const { api } = await appsApi("builder");
    const app = await newApp(api.apps);
    await drafted(api, app.id, { "src/components/card.tsx": "x" });
    const refusals: Record<string, string | null>[] = [
      { "src/components": "x" },
      { "src/components/card.tsx/x.ts": "x" },
      { "src/Components/Card.tsx": "x" },
      { "src/Components/list.tsx": "x" },
      { "a/b.ts": "x", a: "x" },
    ];
    const outcomes: string[] = [];
    // One after another, so each is refused for its paths alone.
    for (const changes of refusals) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      outcomes.push(await issuesOf(drafted(api, app.id, changes)));
    }
    // Replacing the file with a folder of its name, in one write, is fine.
    outcomes.push(
      await issuesOf(
        drafted(api, app.id, {
          "src/components/card.tsx": null,
          "src/components/card.tsx/index.ts": "x",
        })
      )
    );
    expect(outcomes).toStrictEqual([
      "src/components: A file and a folder of the same name, with src/components/card.tsx",
      "src/components/card.tsx/x.ts: A file and a folder of the same name, with src/components/card.tsx",
      "src/Components/Card.tsx: Differs only in case from src/components/card.tsx",
      "src/Components/list.tsx: Differs only in case from src/components/card.tsx",
      "a/b.ts: A file and a folder of the same name, with a",
      "ok",
    ]);
  });

  it("still takes other writes to an App whose paths already collide", async () => {
    const { api, userId } = await appsApi("builder");
    const app = await newApp(api.apps);
    await storedUnchecked(app.id, userId, { "lib/a.ts": "x", "Lib/b.ts": "x" });
    const outcomes: string[] = [];
    const changes: Record<string, string>[] = [
      { "other.ts": "x" },
      { "lib/a.ts": "y" },
      { "LIB/c.ts": "x" },
    ];
    for (const changed of changes) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      outcomes.push(await issuesOf(drafted(api, app.id, changed)));
    }
    expect(outcomes).toStrictEqual([
      "ok",
      "ok",
      "LIB/c.ts: Differs only in case from Lib/b.ts",
    ]);
  });

  it("keeps one of two publishes over the same version, and refuses the other whole", async () => {
    const { api, versions } = await appsApi("builder");
    const app = await newApp(api.apps);
    await publishApp(api, app.id, first);
    const theirs = { "AGENTS.md": "# Theirs\n" };
    // Someone else publishes after this publish read the version live,
    // and before its version lands.
    const racing: Env = {
      ...env,
      DB: racingDb(
        async () => await publishApp(api, app.id, theirs),
        /^insert into "app_versions"/iu
      ),
    };

    await expect(
      outcome(
        publishDefined(racing, await api.whoami(), app.id, {
          "AGENTS.md": "# Mine\n",
        })
      )
    ).resolves.toBe("draft.conflict");
    const listed = await versions.list(subjectOf(app.id));
    expect({
      versions: listed.map(({ version }) => version),
      live: await versions.files(subjectOf(app.id), 2),
    }).toStrictEqual({
      versions: [2, 1],
      live: withFiles(first, theirs).files,
    });
  });

  it("diffs two versions by path", async () => {
    const { api, versions } = await appsApi("builder");
    const app = await newApp(api.apps);
    await publishApp(api, app.id, first);
    await publishApp(api, app.id, {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Page = () => null;

export const Route = createFileRoute("/")({ component: Page });
`,
      "src/routes/detail.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Page = () => <p>Detail</p>;

export const Route = createFileRoute("/detail")({ component: Page });
`,
      "AGENTS.md": null,
    });

    await expect(versions.diff(subjectOf(app.id), 1, 2)).resolves.toStrictEqual(
      [
        {
          path: "AGENTS.md",
          change: "deleted",
          before: first.files["AGENTS.md"],
        },
        {
          path: "src/routes/detail.tsx",
          change: "added",
          after: `import { createFileRoute } from "@tanstack/react-router";

const Page = () => <p>Detail</p>;

export const Route = createFileRoute("/detail")({ component: Page });
`,
        },
        {
          path: "src/routes/index.tsx",
          change: "modified",
          before: first.files["src/routes/index.tsx"],
          after: `import { createFileRoute } from "@tanstack/react-router";

const Page = () => null;

export const Route = createFileRoute("/")({ component: Page });
`,
        },
      ]
    );
    await expect(versions.diff(subjectOf(app.id), 2, 2)).resolves.toStrictEqual(
      []
    );
  });

  it("runs the version published, labelled as it first goes live, without changing any version's files", async () => {
    const { api, apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    const subject = subjectOf(app.id);
    const one = await publishApp(api, app.id, first);
    const two = await publishApp(api, app.id, { "AGENTS.md": "# Changed\n" });
    const month = releaseMonthPrefix(new Date());
    expect({ app, one, two }).toMatchObject({
      app: { currentVersion: null, liveLabel: null },
      one: { version: 1, label: `${month}1` },
      two: { version: 2, label: `${month}2` },
    });
    // As its builder reads it: with their own role in it.
    await expect(apps.get(app.id)).resolves.toMatchObject({
      currentVersion: 2,
      liveLabel: `${month}2`,
      role: "builder",
    });

    // Rolling back is making an earlier version live again, under its
    // label.
    const rolledBack = await versions.rollback(subject, 1);
    expect(rolledBack).toMatchObject({ version: 1, label: `${month}1` });
    await expect(
      Promise.all([versions.files(subject, 1), versions.files(subject, 2)])
    ).resolves.toStrictEqual([
      first.files,
      withFiles(first, { "AGENTS.md": "# Changed\n" }).files,
    ]);
    await expect(
      Promise.all([
        outcome(versions.rollback(subject, 3)),
        outcome(versions.rollback(subject, 0)),
      ])
    ).resolves.toStrictEqual(["app.version_not_found", "draft.invalid"]);
  });

  it("names the pages of the version that runs, and only those", async () => {
    const { api, apps } = await appsApi("builder");
    const app = await newApp(apps);
    const none = await apps.contents(app.id);
    await publishApp(api, app.id, first);
    const one = await apps.contents(app.id);
    await publishApp(api, app.id, {
      "src/routes/archive.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Page = () => null;

export const Route = createFileRoute("/archive")({ component: Page });
`,
      // Not a page: code the pages share.
      "src/components/row.tsx": "export const Row = () => null;\n",
    });

    expect({
      none,
      one,
      two: await apps.contents(app.id),
    }).toStrictEqual({
      none: { version: null, pages: false },
      one: { version: 1, pages: true },
      two: { version: 2, pages: true },
    });
    await expect(outcome(apps.contents("no-such-app"))).resolves.toBe(
      "app.not_found"
    );
  });

  it("audits every version and change of version, by identifiers only", async () => {
    const aHash: unknown = expect.any(String);
    const { api, apps, userId, versions } = await appsApi("admin");
    const actor = { type: "person", userId };
    const recorded = await auditedDuring(async () => {
      const app = await newApp(apps);
      await publishApp(api, app.id, {
        ...sourceParts(first).files,
        "AGENTS.md": "# Secret plans\n",
      });
      // Already current: nothing changes, nothing is recorded.
      await versions.rollback(subjectOf(app.id), 1);
    });
    // The App's own events but its draft's; indexing it into the Apps
    // collection records its entry's (apps-collection.test.ts).
    const events = recorded.filter(
      ({ action, target: on }) =>
        on?.type === "app" && !action.startsWith("draft.")
    );
    expect(JSON.stringify(recorded)).not.toContain("Secret");

    const [created] = events;
    const target = { type: "app", id: created?.target?.id };
    const app = created?.target?.id ?? "";
    const { tree } = appVersionOf(await versions.get(subjectOf(app), 1));
    expect(
      events.map(({ actor: by, action, target: on, detail }) => ({
        by,
        action,
        on,
        detail,
      }))
    ).toStrictEqual([
      {
        by: actor,
        action: "app.created",
        on: target,
        detail: { blueprint: null },
      },
      {
        by: actor,
        action: "app.committed",
        on: target,
        detail: {
          version: 1,
          parent: null,
          tree,
          definition: aHash,
          files: 8,
        },
      },
      // Its server code, the config and schema its definition generates,
      // sealed as it builds.
      {
        by: actor,
        action: "app.release.sealed",
        on: target,
        detail: {
          version: 1,
          contractHash: aHash,
          manifestHash: aHash,
          schemaHash: aHash,
          verificationReportHash: aHash,
        },
      },
      // Published: sealed, its tests run (it has none), and marked
      // (app-publish.ts).
      {
        by: actor,
        action: "app.version.built",
        on: target,
        detail: { version: 1, manifestHash: aHash },
      },
      {
        by: actor,
        action: "version.published",
        on: target,
        // Its label, and what it replaced.
        detail: {
          version: 1,
          label: `${releaseMonthPrefix(new Date())}1`,
          previous: null,
        },
      },
    ]);
  });

  it("are made by builders and admins, and private to them", async () => {
    const { api, apps: builder } = await appsApi("builder");
    const {
      apps: user,
      versions: userVersions,
      api: userApi,
    } = await appsApi("user");
    const app = await newApp(builder);
    const subject = subjectOf(app.id);
    await publishApp(api, app.id, first);

    await expect(
      Promise.all([outcome(user.create({ name: "Mine" })), user.list()])
    ).resolves.toStrictEqual(["role.forbidden", []]);
    // The rest as for an App that isn't there (app-roles.test.ts).
    const refused = await Promise.all([
      outcome(user.get(app.id)),
      outcome(user.contents(app.id)),
      outcome(userVersions.files(subject, 1)),
      outcome(userApi.drafts.write(subject, 0, { "AGENTS.md": "# Mine\n" })),
      outcome(userApi.drafts.files(subject)),
      outcome(userVersions.list(subject)),
      outcome(userVersions.diff(subject, 1, 1)),
      outcome(userVersions.rollback(subject, 1)),
    ]);
    expect(new Set(refused)).toStrictEqual(new Set(["app.not_found"]));
    await expect(api.drafts.files(subject)).resolves.toStrictEqual(first.files);
  });

  it("refuses paths outside the App and files over its limits", async () => {
    const { api } = await appsApi("builder");
    const app = await newApp(api.apps);
    const paths = [
      "../server.ts",
      "pages/../../x.ts",
      "/etc/passwd",
      "pages//inbox.tsx",
      "pages\\inbox.tsx",
      "./AGENTS.md",
      ".env",
      "pages/",
      "__proto__",
      `${"a/".repeat(appLimits.pathDepth)}x.ts`,
    ];
    const refusedPaths = await Promise.all(
      paths.map(
        async (path) => await outcome(drafted(api, app.id, { [path]: "x" }))
      )
    );
    expect(refusedPaths).toStrictEqual(paths.map(() => "app.invalid"));

    const tooLong = "x".repeat(appLimits.fileLength + 1);
    // The App's definition counts too: its first version gets one.
    const room =
      appLimits.totalLength -
      Object.values(ownFiles(defined.files)).join("").length;
    const full = Object.fromEntries(
      Array.from(
        { length: Math.ceil(room / appLimits.fileLength) },
        (_, index) => [
          // Notes, not code: saved as written, never formatted.
          `notes/part-${index}.md`,
          "x".repeat(
            Math.min(appLimits.fileLength, room - index * appLimits.fileLength)
          ),
        ]
      )
    );
    // Exactly an App's limit is within it.
    await drafted(api, app.id, full);
    await expect(
      Promise.all([
        outcome(drafted(api, app.id, { "AGENTS.md": tooLong })),
        outcome(drafted(api, app.id, { "AGENTS.md": "x" })),
        outcome(drafted(api, app.id, {})),
        outcome(api.apps.create({ name: "" })),
      ])
    ).resolves.toStrictEqual([
      "app.invalid",
      "app.too_large",
      "app.invalid",
      "app.invalid",
    ]);
    // Deleting makes room.
    await expect(
      drafted(api, app.id, {
        "notes/part-0.md": null,
        "AGENTS.md": "x",
      })
    ).resolves.toMatchObject({ revision: 2 });
  });

  it("takes no write over a version past the limits that grows it, and those that shrink it", async () => {
    const { api, userId } = await appsApi("builder");
    const app = await newApp(api.apps);
    // More files than an App may have now: published when the limits were
    // higher, its definition among them.
    const count =
      appLimits.files + 2 - Object.keys(ownFiles(defined.files)).length;
    await storedUnchecked(
      app.id,
      userId,
      withFiles(
        defined,
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `src/components/part-${index}.ts`,
            "x",
          ])
        )
      ).files
    );

    // One after another: each over the draft as the last left it.
    const steps: [string, Record<string, string | null>][] = [
      ["add", { "src/components/new.ts": "x" }],
      ["grow", { "src/components/part-0.ts": "xx" }],
      // Still over them, but smaller.
      ["shrink", { "src/components/part-0.ts": null }],
      [
        "shrink to fit",
        { "src/components/part-0.ts": null, "src/components/part-1.ts": null },
      ],
    ];
    const outcomes: [string, string][] = [];
    for (const [step, changes] of steps) {
      // oxlint-disable-next-line no-await-in-loop -- steps are sequential by design
      outcomes.push([step, await outcome(drafted(api, app.id, changes))]);
    }
    expect(outcomes).toStrictEqual([
      ["add", "app.too_large"],
      ["grow", "app.too_large"],
      ["shrink", "ok"],
      ["shrink to fit", "ok"],
    ]);
  });

  it("refuses Apps and versions that don't exist", async () => {
    const { api, versions } = await appsApi("builder");
    const app = await newApp(api.apps);
    await expect(
      Promise.all([
        outcome(api.apps.get("no-such-app")),
        outcome(drafted(api, "no-such-app", { "AGENTS.md": "x" })),
        outcome(versions.files(subjectOf(app.id), 1)),
        outcome(versions.get(subjectOf(app.id), 1)),
        outcome(versions.diff(subjectOf(app.id), 1, 2)),
      ])
    ).resolves.toStrictEqual([
      "app.not_found",
      "app.not_found",
      "app.version_not_found",
      "app.version_not_found",
      "app.version_not_found",
    ]);
  });
});
