/**
 * `vp run seed:supplier-changes`: while `vp run dev` runs, adds the
 * Supplier changes App (scripts/seed/supplier-changes.ts) as the admin
 * (admin@acme.test), with a made-up manufacturer's data. Run again, it
 * publishes the App's code anew and fills only tables that are empty.
 *
 * `vp run seed:supplier-changes --data <folder>` imports a folder of CSVs
 * instead, a company's own exports: `articles.csv` or `articles-*.csv` (in name order, as one
 * import takes at most 2,000 rows), `assemblies.csv`, `bomLines.csv`,
 * `drawingLines.csv` and `notices.csv`, each headed by the table's field
 * names. They go only to the local stack, through the App's data import.
 *
 * The App reads letters with AI: once an admin added an AI provider in
 * Settings, the App's AI is bound to one of its models, Claude's first.
 * Without one, the App says so when it reads a letter.
 *
 * Present it signed in as Sam Jansen (sam@acme.test), whom it is shared
 * with: Grasp shows it as a page of its own, in the sidebar.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  definitionText as appDefinitionText,
  applyOperation,
  definitionSources,
  emptyDefinition,
} from "@grasp-os/runtime/definition";

import { people } from "./seed/company.ts";
import { localD1, origin, sessionOf } from "./seed/local.ts";
import type { Session } from "./seed/local.ts";
import {
  appDescription,
  appName,
  demoData,
  files,
  operations,
  tables,
} from "./seed/supplier-changes.ts";
import type { TableName } from "./seed/supplier-changes.ts";

const { values } = parseArgs({ options: { data: { type: "string" } } });

const [admin] = people;

/** The CSVs of each table: from `folder`, or the made-up company's. */
const csvsOf = (
  folder: string | undefined
): Readonly<Record<TableName, readonly string[]>> => {
  if (folder === undefined) {
    return demoData;
  }
  const names = readdirSync(folder).toSorted();
  const own = (table: TableName): string[] =>
    names
      .filter(
        (name) =>
          name === `${table}.csv` ||
          (name.startsWith(`${table}-`) && name.endsWith(".csv"))
      )
      .map((name) => readFileSync(path.join(folder, name), "utf-8"));
  return {
    articles: own("articles"),
    assemblies: own("assemblies"),
    bomLines: own("bomLines"),
    drawingLines: own("drawingLines"),
    notices: own("notices"),
  };
};

/** The App's definition and every file of it, generated code included. */
let definition = emptyDefinition(appName);
for (const operation of operations) {
  definition = applyOperation(definition, operation);
}
const changes = { ...definitionSources(definition), ...files };

/**
 * The App: made and published with its definition the first time, its
 * code published anew after (a definition built again gives its tables
 * new IDs, which their records' store refuses).
 */
const publishApp = async (session: Session): Promise<string> => {
  const all = await session.api.apps.list();
  const found = all.find(({ name }) => name === appName);
  const app =
    found ??
    (await session.api.apps.create({
      name: appName,
      description: appDescription,
    }));
  const subject = { kind: "app", id: app.id } as const;
  let { revision } = await session.api.drafts.get(subject);
  if (found === undefined) {
    const whole: unknown = JSON.parse(appDefinitionText(definition));
    const defined = await session.api.apps.define(app.id, revision, {
      op: "setDefinition",
      definition: whole,
    });
    if (!defined.ok) {
      throw new Error(defined.problem);
    }
    revision += 1;
  }
  const drafted = await session.api.drafts.write(subject, revision, changes);
  if (drafted.changed.length === 0 && !drafted.definitionChanged) {
    return app.id;
  }
  const checked = await session.api.drafts.check(subject);
  if (!checked.passed) {
    const problems = checked.problems.map(
      ({ at, line, message }) =>
        `${at ?? appName}${line === null ? "" : `:${line}`}: ${message}`
    );
    throw new Error(
      `${appName} doesn't pass its checks:\n${problems.join("\n")}`
    );
  }
  await session.api.drafts.publish(subject, drafted.revision);
  return app.id;
};

/** The App's AI bound to a model an admin's provider offers, Claude's first. */
const bindAi = async (session: Session, app: string): Promise<void> => {
  const { version, resources } = await session.api.resourceBindings.review(app);
  const ai = resources.find(({ alias }) => alias === "ai");
  if (ai === undefined || ai.binding !== null || version === null) {
    return;
  }
  const models = ai.choices?.kind === "model" ? ai.choices.models : [];
  const model = models.find((name) => name.includes("claude")) ?? models.at(0);
  if (model === undefined) {
    console.warn(
      "No AI provider yet: add one in Settings as the admin, then run this again to bind the App's AI."
    );
    return;
  }
  await session.api.resourceBindings.approve({
    app,
    alias: "ai",
    target: { kind: "model", model },
    reviewed: { version },
  });
  console.log(`The App reads letters with ${model}.`);
};

/** Each table's CSVs, imported while the table holds no records. */
const importData = async (
  session: Session,
  app: string,
  csvs: Readonly<Record<TableName, readonly string[]>>
): Promise<void> => {
  const { currentVersion } = await session.api.apps.get(app);
  if (currentVersion === null) {
    throw new Error(`${appName} has no published version.`);
  }
  for (const table of tables) {
    // oxlint-disable-next-line no-await-in-loop -- one table at a time
    const { records } = await session.api.apps.data.records(
      app,
      table,
      currentVersion,
      null
    );
    if (records.length > 0) {
      continue;
    }
    for (const csv of csvs[table]) {
      // Each column into the field of its name, as core's own CSV parser reads the header.
      // oxlint-disable-next-line no-await-in-loop -- one import at a time
      const { mapping } = await session.api.apps.data.previewImport(
        app,
        table,
        csv
      );
      // oxlint-disable-next-line no-await-in-loop -- one import at a time
      const result = await session.api.apps.data.import(app, table, {
        version: currentVersion,
        csv,
        mapping,
      });
      if (!result.ok) {
        throw new Error(
          `${table} didn't import: ${result.errors.map(({ message }) => message).join("; ")}`
        );
      }
    }
  }
};

/**
 * Who presents the App: someone it is shared with as its user, so Grasp
 * opens it as a page among the others, in its sidebar, rather than as the
 * workspace its builders (every admin) get. Made up, as every seeded name.
 */
const presenter = { email: "sam@acme.test", name: "Sam Jansen" };

/** The presenter signed in once (which makes them a member), named, and given the App. */
const sharePresenter = async (owner: Session, app: string): Promise<void> => {
  const presenting = await sessionOf(presenter.email);
  presenting.close();
  // The fake sign-in names people by their email's first word (seed.ts does the same).
  localD1("users")
    .prepare("UPDATE users SET name = ? WHERE id = ?")
    .run(presenter.name, presenting.userId);
  const shared = await owner.api.apps.members.list(app);
  if (
    !shared.some(
      ({ type, id }) => type === "person" && id === presenting.userId
    )
  ) {
    await owner.api.apps.members.add(app, {
      type: "person",
      id: presenting.userId,
      role: "user",
    });
  }
};

const session = await sessionOf(admin.email);
try {
  const app = await publishApp(session);
  await bindAi(session, app);
  await importData(session, app, csvsOf(values.data));
  await sharePresenter(session, app);
  console.log(`${appName}: ${new URL(`/apps/${app}`, origin).href}`);
} finally {
  session.close();
}
