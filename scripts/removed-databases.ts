/**
 * Which deleted migrations belong to a database a branch removes whole, so
 * check-migrations.ts lets them go: a database whose objects are deleted
 * with their storage (a Durable Object class's `deleted_classes` step) has
 * nothing left to apply its migrations to. Only a removal that leaves no
 * trace counts, never a move or a journal deleted on its own.
 */

/** What HEAD and the branch's diff say, as the rule reads them. */
export interface BranchView {
  /** The files the branch deleted since it left main. */
  deleted: ReadonlySet<string>;
  /** Whether HEAD has anything under `dir`. */
  hasTree: (dir: string) => boolean;
  /** Whether a `wrangler.jsonc` or `package.json` at HEAD has `text` in it. */
  configNames: (text: string) => boolean;
}

/**
 * Whether deleted migration `file` is one of a database removed whole: its
 * folder (`src/db/<name>/`) gone at HEAD, its journal deleted in the same
 * branch, and no Worker config or package script still naming it.
 */
export const ofRemovedDatabase = (file: string, view: BranchView): boolean => {
  const at = file.lastIndexOf("/migrations/");
  if (at === -1 || !view.deleted.has(file)) {
    return false;
  }
  const dir = file.slice(0, at);
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  return (
    !view.hasTree(dir) &&
    view.deleted.has(`${dir}/migrations/meta/_journal.json`) &&
    !view.configNames(`db/${name}/`)
  );
};
