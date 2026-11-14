import { env } from "cloudflare:workers";

/** Which hand-overs' sources a refusal names: by id, by how their id starts, or every one. */
export type Refused = { id: string } | { prefix: string } | "all";

/** `text` as an SQL string literal: a trigger binds no values. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * Has core's database refuse every note of a hand-over whose source
 * `refused` names, until the returned function lifts it: a trigger, so
 * every writer that reaches the database meets it, a Durable Object's own
 * binding as much as core's. Each note of such a source fails, alone or
 * with others. Not by a LIKE or GLOB pattern: D1 refuses one as long as a
 * chat turn's id as too complex.
 */
export const refusingNotes = async (
  refused: Refused = "all"
): Promise<() => Promise<void>> => {
  const name = `refuse_notes_${crypto.randomUUID().replaceAll("-", "")}`;
  let when = "";
  if (refused !== "all") {
    when =
      "id" in refused
        ? `WHEN NEW.source_id = ${literal(refused.id)}`
        : `WHEN substr(NEW.source_id, 1, ${refused.prefix.length}) = ${literal(refused.prefix)}`;
  }
  await env.DB.prepare(
    `CREATE TRIGGER ${name} BEFORE INSERT ON brain_hand_overs ${when} BEGIN SELECT RAISE(ABORT, 'Refused for the test'); END`
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  };
};
