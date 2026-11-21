/** A migration D1 refused, by its file's name, with why (`cause`). */
import "@tanstack/react-start/server-only";

export class D1MigrationError extends Error {
  readonly migration: string;

  constructor(migration: string, cause: unknown) {
    super(`D1 refused migration ${migration}`, { cause });
    this.name = "D1MigrationError";
    this.migration = migration;
  }
}
