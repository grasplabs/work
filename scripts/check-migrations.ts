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
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  .filter((line) => line !== "" && !line.startsWith("R100\t"));
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
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
