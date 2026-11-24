/**
 * The onboarding's mail outbox in the stack's local state, for end-to-end
 * tests. A local stack sends no mail anyone receives, so what Grasp meant
 * to send is read where the store queued it (apps/core/src/mail-outbox.ts):
 * once by its key, which starts with its kind (`link/<person>/<sentAt>`).
 * The secret of a link is never there: it is filled in as the mail goes.
 */
import { DatabaseSync } from "node:sqlite";

import { storeFiles } from "./interview-link.ts";

/** A mail as the outbox holds it, as far as the tests read it. */
export interface QueuedMail {
  /** Its kind: `link`, `reminder` or `update`. */
  kind: string;
  /** Whom it is about, by person; null for the admin's update. */
  about: string | null;
  to: string;
  subject: string;
  /** Its text, slots and all. */
  text: string;
}

const hasOutbox = (database: DatabaseSync): boolean =>
  database
    .prepare(
      "select 1 from sqlite_master where type = 'table' and name = 'mail_outbox'"
    )
    .get() !== undefined;

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** The words of a queued mail, as its row keeps them (JSON). */
const wordsOf = (mail: string): { subject: string; text: string } => {
  const parsed: unknown = JSON.parse(mail);
  return typeof parsed === "object" && parsed !== null
    ? {
        subject: "subject" in parsed ? textOf(parsed.subject) : "",
        text: "text" in parsed ? textOf(parsed.text) : "",
      }
    : { subject: "", text: "" };
};

/** The mail one store's database queued, oldest first. */
const queuedIn = (file: string): QueuedMail[] => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    if (!hasOutbox(database)) {
      return [];
    }
    return database
      .prepare(
        "select key, about, to_address, mail from mail_outbox order by rowid"
      )
      .all()
      .map((row) => ({
        kind: textOf(row.key).split("/")[0] ?? "",
        about: typeof row.about === "string" ? row.about : null,
        to: textOf(row.to_address),
        ...wordsOf(textOf(row.mail)),
      }));
  } finally {
    database.close();
  }
};

/** Every mail the onboarding store queued, oldest first, whatever became of it. */
export const queuedMail = async (): Promise<QueuedMail[]> => {
  const files = await storeFiles();
  return files.flatMap(queuedIn);
};
