/**
 * Keeps migrations safe to apply. A migration that main already has is
 * applied somewhere, so it must never change: fix it with a new migration.
 * And each journal lists its migrations in order (index 0, 1, 2, … with
 * rising timestamps), so a migration regenerated on a branch can't land
 * behind one main already shipped.
 *
 * Compares with `origin/main`; CI fetches it first. What main gained after
 * the branch left it isn't the branch's doing: a migration main added since
 * reads as one the branch "deleted" when diffed against main's tip, so the
 * branch's own changes are read against where it left main (the merge
 * base). A journal the branch changed is still held to main's tip, so new
 * migrations are rebased behind the ones main shipped since; the merge
 * queue tests every pull request on the latest main besides.
 *
 * Last, no migration may break the release before it, which still runs
 * on the new schema for a while after a deploy and after a rollback
 * (scripts/migration-safety.ts). So each folder holds exactly its
 * journal's migrations (every `.sql` in it ships, and a Durable Object
 * applies what its `migrations.js` lists), and no cut-off of that check
 * covers a migration the branch adds. What each migration the branch adds
 * does to rows already written is judged on generated rows
 * (scripts/migration-data.ts), and how many tables take none is printed
 * and held to a recorded number.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { skippedErrors } from "./migration-data.ts";
import {
  checkDatabase,
  cutOffErrors,
  firstChecked,
  journalErrors,
} from "./migration-safety.ts";
import { ofRemovedDatabase, storageOf } from "./removed-databases.ts";
import type { BranchView } from "./removed-databases.ts";

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf-8" });

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

const isJournal = (value: unknown): value is Journal =>
  typeof value === "object" &&
  value !== null &&
  "entries" in value &&
  Array.isArray(value.entries);

const readJournal = (file: string, text: string): Journal => {
  const journal: unknown = JSON.parse(text);
  if (!isJournal(journal)) {
    throw new Error(`${file} is not a drizzle-kit journal`);
  }
  return journal;
};

/** The journal as main has it, or undefined when main has none yet. */
const mainJournal = (file: string): Journal | undefined => {
  try {
    return readJournal(file, git("show", `origin/main:${file}`));
  } catch {
    return undefined;
  }
};

const errors: string[] = [];

/** Where the branch left main: its own changes are read against this. */
const base = git("merge-base", "origin/main", "HEAD").trim();

/** Whether the branch changed `file` since it left main. */
const changedHere = (file: string): boolean =>
  git("diff", "--name-only", base, "--", file).trim() !== "";

/** `file` as `ref` has it; none where it has no such file. */
const fileAt = (ref: string, file: string): string | undefined => {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};

/** What every `wrangler.jsonc` deletes and applies at `ref`. */
const storageAt = (ref: string, configs: readonly string[]) =>
  configs.map((file) => storageOf(file, fileAt(ref, file)));

/** The `wrangler.jsonc` files at main or at HEAD. */
const wranglerConfigs = [
  ...new Set(
    [base, "HEAD"].flatMap((ref) =>
      git("ls-tree", "-r", "--name-only", ref)
        .split("\n")
        .filter((file) => file.endsWith("wrangler.jsonc"))
    )
  ),
];
const storageAtBase = storageAt(base, wranglerConfigs);
const storageAtHead = storageAt("HEAD", wranglerConfigs);
const deletedBefore = new Set(
  storageAtBase.flatMap(({ deletedClasses }) => deletedClasses)
);
const dirsNow = new Set(
  storageAtHead.flatMap(({ migrationDirs }) => migrationDirs)
);

/** What HEAD and the branch's diff say of a database removed whole. */
const branchView: BranchView = {
  deletedClasses: new Set(
    storageAtHead
      .flatMap(({ deletedClasses }) => deletedClasses)
      .filter((name) => !deletedBefore.has(name))
  ),
  removedMigrationDirs: new Set(
    storageAtBase
      .flatMap(({ migrationDirs }) => migrationDirs)
      .filter((dir) => !dirsNow.has(dir))
  ),
  deleted: new Set(
    git("diff", "--name-only", "--find-renames", "--diff-filter=D", base)
      .split("\n")
      .filter(Boolean)
  ),
  hasTree: (dir) => git("ls-tree", "HEAD", "--", dir).trim() !== "",
  configNames: (text) => {
    try {
      git(
        "grep",
        "-q",
        "-F",
        text,
        "HEAD",
        "--",
        "*wrangler.jsonc",
        "*package.json"
      );
      return true;
    } catch {
      // `git grep` exits 1 when nothing matches.
      return false;
    }
  },
};

// A migration moved unchanged with its app (a rename at 100% similarity)
// is still the one main shipped: only its path changed.
const changed = git(
  "diff",
  "--name-status",
  "--find-renames",
  "--diff-filter=MDR",
  base,
  "--",
  "*/migrations/*.sql"
)
  .split("\n")
  .filter(
    (line) =>
      line !== "" &&
      !line.startsWith("R100\t") &&
      // A migration of a database the branch removes whole.
      !(line.startsWith("D\t") && ofRemovedDatabase(line.slice(2), branchView))
  );
for (const line of changed) {
  errors.push(
    `${line.split("\t").at(-1)} is on main already: add a new migration instead of changing it.`
  );
}

/** Where main has each journal that moved with its app, by its path now. */
const movedJournals = new Map(
  git(
    "diff",
    "--name-status",
    "--find-renames",
    "--diff-filter=R",
    base,
    "--",
    "*/migrations/meta/_journal.json"
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, from = "", to = ""] = line.split("\t");
      return [to, from] as const;
    })
);

/**
 * Every index the release before names with `INDEXED BY`, where SQLite
 * fails rather than scans when the index is gone.
 */
const indexedByMatches = (): string => {
  try {
    return git(
      "grep",
      "-h",
      "-o",
      "-i",
      "-I",
      "-E",
      "indexed by +[a-z_][a-z0-9_]*",
      base,
      "--",
      "*.ts",
      "*.tsx"
    );
  } catch {
    // `git grep` exits 1 when nothing matches.
    return "";
  }
};
const indexedBy = new Set(
  indexedByMatches()
    .split("\n")
    .filter(Boolean)
    .map((match) => match.replace(/^indexed by +/iu, "").toLowerCase())
);

/** How many migrations a database had where the branch left main. */
const countAtBase = (dir: string): number => {
  const atBase = fileAt(base, `${dir}/meta/_journal.json`);
  return atBase === undefined ? 0 : readJournal(dir, atBase).entries.length;
};

const journals = git("ls-files", "*/migrations/meta/_journal.json")
  .split("\n")
  .filter(Boolean);
for (const file of journals) {
  const { entries } = readJournal(file, readFileSync(file, "utf-8"));
  // Objects record each applied migration by index and tag, so the entries
  // main has must stay exactly as they are, in front of any new ones. A
  // journal the branch left alone is main's as it was: nothing to hold.
  const shippedEntries = changedHere(file)
    ? (mainJournal(movedJournals.get(file) ?? file)?.entries ?? [])
    : [];
  for (const [position, shipped] of shippedEntries.entries()) {
    const entry = entries[position];
    if (
      entry?.idx !== shipped.idx ||
      entry.tag !== shipped.tag ||
      entry.when !== shipped.when
    ) {
      errors.push(
        `${file}: migration ${shipped.idx} (${shipped.tag}) is on main already; keep its journal entry as it is.`
      );
    }
  }
  for (const [position, entry] of entries.entries()) {
    const previous = entries[position - 1];
    if (entry.idx !== position) {
      errors.push(`${file}: entry ${position} has index ${entry.idx}.`);
    }
    if (previous !== undefined && entry.when <= previous.when) {
      errors.push(
        `${file}: migration ${entry.idx} is older than the one before it; rebase on main and generate it again.`
      );
    }
  }
  // And none breaks the release before it (scripts/migration-safety.ts),
  // nor ships unjudged beside its journal. A database added since that
  // check was is judged whole.
  const dir = path.dirname(path.dirname(file));
  const tags = entries.map(({ tag }) => tag);
  const folderErrors = journalErrors(
    dir,
    tags,
    readdirSync(dir).filter((name) => name.endsWith(".sql")),
    existsSync(`${dir}/migrations.js`)
      ? readFileSync(`${dir}/migrations.js`, "utf-8")
      : undefined
  );
  errors.push(...folderErrors);
  if (folderErrors.length === 0) {
    const migrations = entries.map(({ idx, tag }) => ({
      idx,
      tag,
      sql: readFileSync(`${dir}/${tag}.sql`, "utf-8"),
    }));
    const { errors: found, skipped } = checkDatabase(dir, migrations, {
      from: firstChecked[dir] ?? 0,
      now: new Date(),
      indexedBy,
      added: countAtBase(dir),
    });
    errors.push(...found, ...skippedErrors(dir, skipped));
    console.info(
      [
        `${dir}: ${skipped.length} tables take no generated row`,
        ...skipped.map(({ table, reason }) => `  ${table}: ${reason}`),
      ].join("\n")
    );
  }
}

const journalDirs = new Set(
  journals.map((file) => path.dirname(path.dirname(file)))
);
// A migration folder without a journal would ship its SQL unjudged.
const sqlDirs = new Set(
  git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    ":(glob)**/src/db/**/migrations/*.sql"
  )
    .split("\n")
    .filter((file) => file !== "" && existsSync(file))
    .map((file) => path.dirname(file))
);
for (const dir of sqlDirs) {
  if (!journalDirs.has(dir)) {
    errors.push(
      `${dir} has migrations but no journal (meta/_journal.json): generate them with \`vp run -r db:generate\`.`
    );
  }
}
errors.push(
  ...cutOffErrors(
    firstChecked,
    journalDirs,
    new Map([...journalDirs].map((dir) => [dir, countAtBase(dir)] as const))
  )
);

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
