import {
  definitionSources,
  definitionText,
} from "@grasp-os/runtime/definition";
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
import { findApp } from "../src/apps.ts";
import { memberOf } from "../src/auth/identity.ts";
import { reviewDraft } from "../src/version-review.ts";
import {
  commitApp,
  definitionInput,
  definitionOf,
  sourceParts,
  testApp,
  withFiles,
} from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { appVersionsOf, commitDefined, racingDb } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";

// An App's code is versioned as a whole: builders commit changes over its
// latest version as the next version, which never changes afterwards. One
// version runs (current) and another can wait for review (pending). Every
// commit and every change of version is audited. Gone with App
// workflows: the workflows an App's own version names.

const idp = mockIdp();

/** A signed-in person's App API, on a connection of their own. */
const appsApi = async (role: Role) => {
  const person = await signedInApi(idp, role);
  return { ...person, apps: person.api.apps, versions: person.api.versions };
};

type Apps = Awaited<ReturnType<typeof appsApi>>["apps"];

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

/** Commits `files` over the App's latest version. */
const commit = async (
  apps: Apps,
  app: string,
  files: TestSource,
  message = "Change"
) => await commitApp(apps.files, app, files, message);

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

// Making a version with workflows current compiles them and runs their
// tests, as "names the pages and workflows" does. That takes half a
// second locally, and several times that on a loaded runner, closer to
// the default five seconds than the rest of this file. Nothing polls or
// sleeps; sixty seconds is room for a slow runner, as the other tests
// that release Apps give theirs.
describe("App code", { timeout: 60_000 }, () => {
  it("reads back every version exactly as it was committed", async () => {
    const { apps, userId, versions } = await appsApi("builder");
    const app = await newApp(apps);
    const v1 = await commit(apps, app.id, first, "First page");
    const v2 = await commit(apps, app.id, {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => <p>Invoices</p>;

export const Route = createFileRoute("/")({ component: Page });
`,
      "src/components/row.tsx": "export const Row = () => null;\n",
      "AGENTS.md": null,
    });

    expect({ v1, v2 }).toMatchObject({
      // Its own four, and the four of server/_generated/.
      v1: { version: 1, parent: null, files: 8, author: userId },
      v2: { version: 2, parent: 1, files: 8, author: userId },
    });
    await expect(apps.files.read(app.id, 1)).resolves.toStrictEqual(
      first.files
    );
    await expect(apps.files.read(app.id, 2)).resolves.toStrictEqual(
      withFiles(defined, {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => <p>Invoices</p>;

export const Route = createFileRoute("/")({ component: Page });
`,
        "src/components/row.tsx": "export const Row = () => null;\n",
      }).files
    );
    // A version reads back as committed; the commit's answer adds how its
    // builds went (build-on-save.test.ts).
    const { builds: _builds, ...committedV1 } = v1;
    const [newestFirst, beforeTwo, one] = await Promise.all([
      versions.list({ kind: "app", id: app.id }),
      versions.list({ kind: "app", id: app.id }, 2),
      versions.get({ kind: "app", id: app.id }, 1),
    ]);
    expect({
      newestFirst: appVersionsOf(newestFirst).map(({ version, message }) => [
        version,
        message,
      ]),
      beforeTwo,
      one,
    }).toStrictEqual({
      newestFirst: [
        [2, "Change"],
        [1, "First page"],
      ],
      beforeTwo: [committedV1],
      one: committedV1,
    });
  });

  it("reads the latest version without a version, and refuses a commit that changes nothing", async () => {
    const { apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    const none = await apps.files.read(app.id);
    await commit(apps, app.id, first);
    const afterFirst = await apps.files.read(app.id);
    await commit(apps, app.id, {
      "AGENTS.md": "# Second\n",
      "src/routes/index.tsx": null,
    });

    expect({
      none,
      afterFirst,
      latest: await apps.files.read(app.id),
      one: await apps.files.read(app.id, 1),
    }).toStrictEqual({
      none: {},
      afterFirst: first.files,
      latest: withFiles(defined, {
        "AGENTS.md": "# Second\n",
      }).files,
      one: first.files,
    });
    // What is already there, deleting what isn't, and deleting the
    // schema its definition generates back, change nothing.
    await expect(
      Promise.all([
        outcome(commit(apps, app.id, { "AGENTS.md": "# Second\n" })),
        outcome(commit(apps, app.id, { "src/routes/index.tsx": null })),
        outcome(commit(apps, app.id, { "server/schema.ts": null })),
      ])
    ).resolves.toStrictEqual([
      "app.nothing_to_commit",
      "app.nothing_to_commit",
      "app.nothing_to_commit",
    ]);
    await expect(
      versions.list({ kind: "app", id: app.id })
    ).resolves.toHaveLength(2);
  });

  it("gives an App a definition with its first version, and keeps its config and schema as the definition generates them", async () => {
    const { apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    // Pages alone: the first version gets an empty definition, named as
    // the App is, and the config and schema generated from it.
    await commit(apps, app.id, {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => null;

export const Route = createFileRoute("/")({ component: Page });
`,
    });
    const pagesOnly = await apps.files.read(app.id);
    // A config written by hand is generated over, whatever it held.
    await commit(apps, app.id, {
      "grasp.config.ts": 'export default { name: "Mine" };\n',
      "AGENTS.md": "# Mine\n",
    });
    const handwritten = await apps.files.read(app.id);
    const invalid = await outcome(
      apps.files.commit(app.id, {}, "Invalid", { name: 1 })
    );
    const listed = await versions.list({ kind: "app", id: app.id });
    expect({
      pagesOnly,
      config: handwritten["grasp.config.ts"],
      // A definition that isn't one: refused, nothing of the commit kept.
      invalid,
      versions: listed.map(({ version }) => version),
    }).toStrictEqual({
      pagesOnly: withFiles(defined, {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => null;

export const Route = createFileRoute("/")({ component: Page });
`,
      }).files,
      config: defined.files["grasp.config.ts"],
      invalid: "app.definition_invalid",
      versions: [2, 1],
    });
  });

  it("holds each version's definition beside its files, never among them, and commits a change of the definition alone", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    const notes = definitionOf({
      name: "Invoice desk",
      tables: { notes: { fields: { title: "v.string()" } } },
    });
    await commit(apps, app.id, first);
    // The same files, another definition: a version of its own, its code
    // generated from the definition it was committed with.
    const unchanged = { "AGENTS.md": first.files["AGENTS.md"] ?? "" };
    const redefinedVersion = await apps.files.commit(
      app.id,
      unchanged,
      "Notes",
      definitionInput(notes)
    );
    const files = await apps.files.read(app.id);
    // The same files and definition again change nothing.
    const again = await outcome(
      apps.files.commit(app.id, unchanged, "Again", definitionInput(notes))
    );
    // A commit that names no definition keeps the latest version's.
    await commit(apps, app.id, { "AGENTS.md": "# Notes\n" });
    const latest = await apps.files.read(app.id);
    expect({
      version: redefinedVersion.version,
      paths: Object.keys(files).toSorted(),
      generated: {
        "grasp.config.ts": files["grasp.config.ts"],
        "server/schema.ts": files["server/schema.ts"],
      },
      kept: latest["server/schema.ts"],
      again,
    }).toStrictEqual({
      version: 2,
      paths: Object.keys(first.files).toSorted(),
      generated: definitionSources(notes),
      kept: definitionSources(notes)["server/schema.ts"],
      again: "app.nothing_to_commit",
    });
  });

  it("reviews a change of the definition in a draft as a change of the server code, with what it does to the records, renames included", async () => {
    const { apps, userId, versions } = await appsApi("admin");
    const app = await newApp(apps);
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
    const unchanged = { "AGENTS.md": first.files["AGENTS.md"] ?? "" };
    await apps.files.commit(
      app.id,
      sourceParts(first).files,
      "Notes",
      definitionInput(two)
    );
    await versions.rollback({ kind: "app", id: app.id }, 1);
    await apps.files.commit(
      app.id,
      unchanged,
      "Swapped",
      definitionInput(swapped)
    );
    await apps.files.commit(
      app.id,
      { "AGENTS.md": "# Notes\n" },
      "Docs",
      definitionInput(two)
    );
    // A rename: the title's values move to the heading.
    await apps.files.commit(
      app.id,
      unchanged,
      "Headings",
      definitionInput({
        ...two,
        tables: [{ ...table, fields: [{ ...title, name: "heading" }, body] }],
      })
    );
    // A draft holding each version, against version 1, live.
    const live = await findApp(env, app.id);
    const by = await memberOf(env.DB, userId);
    if (by === undefined) {
      throw new Error("Not a member");
    }
    const reviewOf = async (version: number) =>
      await reviewDraft(env, by, live, {
        base: version,
        changes: {},
        definition: null,
        revision: 0,
      });
    const [swappedReview, filesOnly, renamedReview] = await Promise.all([
      reviewOf(2),
      reviewOf(3),
      reviewOf(4),
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

  it("never changes a version's definition once committed", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
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
      files: await apps.files.read(app.id, 1),
    }).toStrictEqual({
      definition: true,
      hash: true,
      files: first.files,
    });
  });

  it("refuses to build on or run a version that holds no definition, saying so", async () => {
    const { apps, userId, versions } = await appsApi("builder");
    const app = await newApp(apps);
    await storedUnchecked(app.id, userId, first.files, null);
    let refusal: unknown;
    try {
      await commit(apps, app.id, { "AGENTS.md": "# Again\n" });
    } catch (error) {
      refusal = error;
    }
    const seal = await outcome(
      versions.rollback({ kind: "app", id: app.id }, 1)
    );
    const listed = await versions.list({ kind: "app", id: app.id });
    expect({
      commit: appErrors.codeOf(refusal),
      issues: definitionRefusal(refusal),
      seal,
      versions: listed.map(({ version }) => version),
    }).toStrictEqual({
      commit: "app.definition_invalid",
      issues: "The App's version holds no definition.",
      seal: "app.definition_invalid",
      versions: [1],
    });
  });

  it("fails loudly when a version's files are missing or damaged", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    const version = await commit(apps, app.id, first);
    const key = `apps/${app.id}/trees/${version.tree}.json`;
    const object = await env.FILES.get(key);
    const stored = (await object?.text()) ?? "";

    await env.FILES.put(key, stored.replace("Inbox", "Outbox"));
    const damaged = await outcome(apps.files.read(app.id, 1));
    await env.FILES.delete(key);
    const missing = await outcome(apps.files.read(app.id, 1));
    expect({ damaged, missing }).toStrictEqual({
      damaged: "internal.unexpected",
      missing: "internal.unexpected",
    });
  });

  it("refuses paths that can't both exist: a file and its folder, or names differing only in case", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, { "src/components/card.tsx": "x" });
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
      outcomes.push(await issuesOf(commit(apps, app.id, changes)));
    }
    // Replacing the file with a folder of its name, in one commit, is fine.
    outcomes.push(
      await issuesOf(
        commit(apps, app.id, {
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

  it("still takes other commits to an App whose paths already collide", async () => {
    const { apps, userId } = await appsApi("builder");
    const app = await newApp(apps);
    await storedUnchecked(app.id, userId, { "lib/a.ts": "x", "Lib/b.ts": "x" });
    const outcomes: string[] = [];
    const changes: Record<string, string>[] = [
      { "other.ts": "x" },
      { "lib/a.ts": "y" },
      { "LIB/c.ts": "x" },
    ];
    for (const changed of changes) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      outcomes.push(await issuesOf(commit(apps, app.id, changed)));
    }
    expect(outcomes).toStrictEqual([
      "ok",
      "ok",
      "LIB/c.ts: Differs only in case from Lib/b.ts",
    ]);
  });

  it("keeps one of two commits over the same version, and refuses the other whole", async () => {
    const { api, apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    const theirs = { "AGENTS.md": "# Theirs\n" };
    // Someone else commits after this commit read the latest version, and
    // before its batch lands.
    const racing: Env = {
      ...env,
      DB: racingDb(
        async () => await commit(apps, app.id, theirs, "Theirs"),
        /^insert into "app_versions"/iu
      ),
    };

    await expect(
      outcome(
        commitDefined(
          racing,
          await api.whoami(),
          app.id,
          { "AGENTS.md": "# Mine\n", "src/routes/mine.tsx": "x" },
          "Mine"
        )
      )
    ).resolves.toBe("app.conflict");
    const listed = await versions.list({ kind: "app", id: app.id });
    expect(
      appVersionsOf(listed).map(({ version, message }) => [version, message])
    ).toStrictEqual([
      [2, "Theirs"],
      [1, "Change"],
    ]);
    await expect(apps.files.read(app.id)).resolves.toStrictEqual(
      withFiles(first, {
        ...theirs,
      }).files
    );
  });

  it("diffs two versions by path", async () => {
    const { apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    await commit(apps, app.id, {
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

    await expect(
      versions.diff({ kind: "app", id: app.id }, 1, 2)
    ).resolves.toStrictEqual([
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
    ]);
    await expect(
      versions.diff({ kind: "app", id: app.id }, 2, 2)
    ).resolves.toStrictEqual([]);
  });

  it("runs the version published, labelled as it first goes live, without changing any version's files", async () => {
    const { apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    const one = await versions.rollback({ kind: "app", id: app.id }, 1);
    await commit(apps, app.id, { "AGENTS.md": "# Changed\n" });

    const approved = await versions.rollback({ kind: "app", id: app.id }, 2);
    const month = releaseMonthPrefix(new Date());
    expect({ app, one, approved }).toMatchObject({
      app: { currentVersion: null, liveLabel: null },
      one: { version: 1, label: `${month}1` },
      approved: { version: 2, label: `${month}2` },
    });
    // As its builder reads it: with their own role in it.
    await expect(apps.get(app.id)).resolves.toMatchObject({
      currentVersion: 2,
      liveLabel: `${month}2`,
      role: "builder",
    });

    // Rolling back is publishing an earlier version again, under its
    // label.
    const rolledBack = await versions.rollback({ kind: "app", id: app.id }, 1);
    expect(rolledBack).toMatchObject({ version: 1, label: `${month}1` });
    await expect(
      Promise.all([apps.files.read(app.id, 1), apps.files.read(app.id, 2)])
    ).resolves.toStrictEqual([
      first.files,
      withFiles(first, {
        "AGENTS.md": "# Changed\n",
      }).files,
    ]);
    await expect(
      Promise.all([
        outcome(versions.rollback({ kind: "app", id: app.id }, 3)),
        outcome(versions.rollback({ kind: "app", id: app.id }, 0)),
      ])
    ).resolves.toStrictEqual(["app.version_not_found", "draft.invalid"]);
  });

  it("names the pages of the version that runs, and only those", async () => {
    const { apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    const none = await apps.contents(app.id);
    await versions.rollback({ kind: "app", id: app.id }, 1);
    await commit(apps, app.id, {
      "src/routes/archive.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => null;

export const Route = createFileRoute("/archive")({ component: Page });
`,
      // Not a page: code the pages share.
      "src/components/row.tsx": "export const Row = () => null;\n",
    });
    // Committed, not yet current: what runs is still version 1.
    const beforeCurrent = await apps.contents(app.id);
    await versions.rollback({ kind: "app", id: app.id }, 2);

    expect({
      none,
      beforeCurrent,
      current: await apps.contents(app.id),
    }).toStrictEqual({
      none: { version: null, pages: false },
      beforeCurrent: { version: 1, pages: true },
      current: { version: 2, pages: true },
    });
    await expect(outcome(apps.contents("no-such-app"))).resolves.toBe(
      "app.not_found"
    );
  });

  it("audits every commit and version change, by identifiers only", async () => {
    const aHash: unknown = expect.any(String);
    const { apps, userId, versions } = await appsApi("admin");
    const actor = { type: "person", userId };
    let tree = "";
    const recorded = await auditedDuring(async () => {
      const app = await newApp(apps);
      ({ tree } = await apps.files.commit(
        app.id,
        sourceParts(first).files,
        "Secret plans in the message"
      ));
      await versions.rollback({ kind: "app", id: app.id }, 1);
      // Already current: nothing changes, nothing is recorded.
      await versions.rollback({ kind: "app", id: app.id }, 1);
    });
    // The App's own events; indexing it into the Apps collection records
    // its entry's (apps-collection.test.ts).
    const events = recorded.filter(({ target: on }) => on?.type === "app");
    expect(JSON.stringify(recorded)).not.toContain("Secret");

    const [created] = events;
    const target = { type: "app", id: created?.target?.id };
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
        action: "version.rolled_back",
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
    const { apps: builder } = await appsApi("builder");
    const { apps: user, versions: userVersions } = await appsApi("user");
    const app = await newApp(builder);
    await commit(builder, app.id, first);

    await expect(
      Promise.all([outcome(user.create({ name: "Mine" })), user.list()])
    ).resolves.toStrictEqual(["role.forbidden", []]);
    // The rest as for an App that isn't there (app-roles.test.ts).
    const refused = await Promise.all([
      outcome(user.get(app.id)),
      outcome(user.contents(app.id)),
      outcome(user.files.read(app.id, 1)),
      outcome(user.files.commit(app.id, { "AGENTS.md": "# Mine\n" }, "Mine")),
      outcome(userVersions.list({ kind: "app", id: app.id })),
      outcome(userVersions.diff({ kind: "app", id: app.id }, 1, 1)),
      outcome(userVersions.rollback({ kind: "app", id: app.id }, 1)),
    ]);
    expect(new Set(refused)).toStrictEqual(new Set(["app.not_found"]));
    await expect(builder.get(app.id)).resolves.toMatchObject({
      currentVersion: null,
    });
    await expect(builder.files.read(app.id)).resolves.toStrictEqual(
      first.files
    );
  });

  it("refuses paths outside the App and files over its limits", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
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
        async (path) => await outcome(commit(apps, app.id, { [path]: "x" }))
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
          `src/components/part-${index}.ts`,
          "x".repeat(
            Math.min(appLimits.fileLength, room - index * appLimits.fileLength)
          ),
        ]
      )
    );
    // Exactly an App's limit is within it.
    await commit(apps, app.id, full);
    await expect(
      Promise.all([
        outcome(commit(apps, app.id, { "AGENTS.md": tooLong })),
        outcome(commit(apps, app.id, { "AGENTS.md": "x" })),
        outcome(commit(apps, app.id, {})),
        outcome(commit(apps, app.id, { "AGENTS.md": "" }, " ")),
        outcome(apps.create({ name: "" })),
      ])
    ).resolves.toStrictEqual([
      "app.invalid",
      "app.too_large",
      "app.invalid",
      "app.invalid",
      "app.invalid",
    ]);
    // Deleting makes room.
    await expect(
      commit(apps, app.id, {
        "src/components/part-0.ts": null,
        "AGENTS.md": "x",
      })
    ).resolves.toMatchObject({ version: 2 });
  });

  it("commits over a version that is over the limits only what is within them", async () => {
    const { apps, userId } = await appsApi("builder");
    const app = await newApp(apps);
    // More files than an App may have now: committed when the limits were
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

    // One after another: each is over the same version.
    const steps: [string, Record<string, string | null>][] = [
      ["add", { "src/components/new.ts": "x" }],
      ["grow", { "src/components/part-0.ts": "xx" }],
      // Still over them: no version until it's within them.
      ["shrink", { "src/components/part-0.ts": null }],
      [
        "shrink to fit",
        { "src/components/part-0.ts": null, "src/components/part-1.ts": null },
      ],
    ];
    const outcomes: [string, string][] = [];
    for (const [step, changes] of steps) {
      // oxlint-disable-next-line no-await-in-loop -- steps are sequential by design
      outcomes.push([step, await outcome(commit(apps, app.id, changes))]);
    }
    expect(outcomes).toStrictEqual([
      ["add", "app.too_large"],
      ["grow", "app.too_large"],
      ["shrink", "app.too_large"],
      ["shrink to fit", "ok"],
    ]);
  });

  it("refuses Apps and versions that don't exist", async () => {
    const { apps, versions } = await appsApi("builder");
    const app = await newApp(apps);
    await expect(
      Promise.all([
        outcome(apps.get("no-such-app")),
        outcome(commit(apps, "no-such-app", { "AGENTS.md": "x" })),
        outcome(apps.files.read(app.id, 1)),
        outcome(versions.get({ kind: "app", id: app.id }, 1)),
        outcome(versions.diff({ kind: "app", id: app.id }, 1, 2)),
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
