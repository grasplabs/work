/** A migration D1 refused, by its file's name, with why (`cause`). */
export class D1MigrationError extends Error {
  readonly migration: string;

  constructor(migration: string, cause: unknown) {
    super(`D1 refused migration ${migration}`, { cause });
    this.name = "D1MigrationError";
    this.migration = migration;
  }
}
