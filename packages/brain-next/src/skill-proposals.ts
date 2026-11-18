import { log } from "@grasp-os/shared/log";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import {
  instructionsTextSchema,
  proposalKeySchema,
  proposeKind,
  proposalRequestSchema,
  tokensOf,
} from "./contract.ts";
import type {
  ProposalRequest,
  ProposalSettle,
  Reader,
  SkillProposal,
  SourceVersionRef,
} from "./contract.ts";
import { pieceOf } from "./extraction.ts";
import { readableSql } from "./reader-sets.ts";
import { skillFrontmatterOf } from "./skills.ts";
import { readCurrent } from "./sources.ts";
import { WorkError } from "./work-error.ts";
import { defineWork, enqueueWork, workRequestMaxLength } from "./work.ts";
import type { WorkContext } from "./work.ts";

// Skill proposals: a draft of a skill for the person whose own store this
// is, written by the host's model from sources of theirs that keep ending
// the same way (the host decides which, and says what they have in
// common). The Brain's dreaming, in the person's own space:
//
// - Asked only when the host says something changed (`enqueueProposal`),
//   once per key: a key drafted before, open or settled, is never drafted
//   again, so the model is asked once for what the sources have in common.
// - Drawn only from what the person may read: the current versions of the
//   sources, as their own reader reads them, at the moment of the call;
//   none missing (a source gone, out of use or never handed over drafts
//   nothing). What the model writes is kept here alone, readable by them.
// - Listed only while every version it rests on is still current and
//   theirs to read, in the statement that lists it (`listProposals`); an
//   erasure of one of its sources deletes it (erasure.ts `apply`).
// - Not a skill: nothing lists, selects or reads it as one. The host
//   writes the person's own skill from it once they accept, then settles
//   it (`settleProposal`), which keeps the key alone.

/**
 * The part of the model's window the routine and its runs may take: the
 * answer may take a quarter (core's gateway), and the instructions are in
 * the rest.
 */
const windowShareOfRuns = 2;

/** What the model is asked: generic, naming no product. */
const instructions = `You draft a skill for one person: a SKILL.md document in the Agent Skills format that tells their assistant how this routine of theirs is done, so it can help them do it the same way next time.
You are given what the routine is, and the results of the person's latest runs of it, which all succeeded.
Answer with the SKILL.md alone, nothing before or after it:
- First a YAML frontmatter block between two lines of three dashes, holding "name" (lowercase letters, digits and single hyphens, at most 64 characters) and "description" (one line: when to use the skill).
- Then the instructions, in Markdown: when to use it, what to ask for or check first, and what a good result looks like, as the runs show it.
Never copy personal data, credentials, people's names or one-off values from the results: describe their shape instead.
Write in the language the routine and its results are written in.`;

const payloadSchema = proposalRequestSchema.omit({ person: true }).extend({
  /**
   * The model's answer, kept before it is written (`WorkContext.keep`): a
   * rerun writes it and asks the model nothing.
   */
  drafted: z
    .strictObject({
      text: z.string(),
      restsOn: z.array(
        z.strictObject({ source: z.string(), version: z.int().positive() })
      ),
    })
    .optional(),
});
type Payload = z.infer<typeof payloadSchema>;

/** Whether a proposal was drafted under `key`, open or settled. */
const draftedBefore = (sql: SqlStorage, key: string): boolean =>
  sql.exec("SELECT 1 FROM skill_proposals WHERE key = ?", key).toArray()
    .length > 0;

/**
 * `?1` the versions (JSON `[{ source, version }]`), `?2` the reader's
 * person, `?3` their groups (JSON): how many of the versions are their
 * source's current one and readable by the reader.
 */
const currentReadableSql = `
WITH ${readableSql}
SELECT count(*) AS count FROM json_each(?1) AS rested
WHERE EXISTS (
  SELECT 1 FROM current_versions
  JOIN source_versions ON source_versions.row = current_versions.version_row
  WHERE current_versions.source = json_extract(rested.value, '$.source')
    AND source_versions.version = json_extract(rested.value, '$.version')
    AND source_versions.reader_set IN (SELECT reader_set FROM readable)
)`;

/** Whether every one of `versions` is current and readable by the store's person. */
const allCurrent = (
  sql: SqlStorage,
  owner: string,
  versions: readonly SourceVersionRef[]
): boolean =>
  sql
    .exec<{ count: number }>(
      currentReadableSql,
      JSON.stringify(versions),
      owner,
      "[]"
    )
    .one().count === versions.length;

/** What a draft's frontmatter may hold: its card alone. */
const draftKeys: ReadonlySet<string> = new Set(["name", "description"]);

/**
 * The SKILL.md the model answered, its one surrounding code fence taken
 * off; null when it isn't one a person could add as their own: a skill in
 * the Agent Skills format whose frontmatter holds its card alone (`name`
 * and `description`: anything else, such as what it needs, is the host's
 * to judge, and a draft has no call to declare it), as an instruction
 * file's text (`instructionsTextSchema`, as the host's add takes it).
 * Such an answer doesn't fit: the item fails as `invalid_answer`.
 */
const draftSkillOf = (answer: string): string | null => {
  const fenced = /^```[a-z]*\r?\n(?<body>[\s\S]*?)\r?\n```$/u.exec(
    answer.trim()
  );
  const text = `${(fenced?.groups?.body ?? answer).trim()}\n`;
  const frontmatter = skillFrontmatterOf(text);
  return instructionsTextSchema.safeParse(text).success &&
    frontmatter !== null &&
    Object.keys(frontmatter).every((key) => draftKeys.has(key))
    ? text
    : null;
};

/** What the model is given: the routine, then each run, each cut to its share. */
const inputOf = (
  about: string,
  runs: readonly string[],
  contextTokens: number | null
): string => {
  const head = `The routine: ${about}`;
  const tokens =
    contextTokens === null
      ? null
      : Math.floor(
          (Math.floor(contextTokens / windowShareOfRuns) -
            tokensOf(instructions) -
            tokensOf(head)) /
            runs.length
        );
  if (tokens !== null && tokens <= 0) {
    throw new WorkError("window_too_small");
  }
  const chars = Math.floor(
    (workRequestMaxLength - instructions.length - head.length) / runs.length
  );
  return [
    head,
    ...runs.map(
      (text, index) =>
        `Run ${index + 1}:\n${pieceOf(text, 0, tokens, chars).text}`
    ),
  ].join("\n\n");
};

/** The draft of `payload`: the model's answer kept with it, or asked now. */
const draftOf = async (
  context: WorkContext,
  payload: Payload,
  owner: string
): Promise<Payload["drafted"] | undefined> => {
  if (payload.drafted !== undefined) {
    return payload.drafted;
  }
  const read = await readCurrent(
    {
      storage: context.storage,
      db: drizzle(context.storage),
      bucket: context.bucket,
      groups: true,
    },
    { sources: payload.sources, reader: { person: owner, groups: [] } }
  );
  // One missing (gone, out of use, never handed over, or not theirs):
  // nothing is drafted from the rest.
  if (read.length !== new Set(payload.sources).size) {
    return undefined;
  }
  const { text } = await context.ask({
    system: instructions,
    input: inputOf(
      payload.about,
      read.map((version) => version.text),
      context.contextTokens
    ),
  });
  const skill = draftSkillOf(text);
  if (skill === null) {
    throw new WorkError("invalid_answer");
  }
  const drafted = {
    text: skill,
    restsOn: read.map(({ source, version }) => ({ source, version })),
  };
  context.keep({ ...payload, drafted });
  return drafted;
};

const proposeWork = defineWork({
  kind: proposeKind,
  payload: payloadSchema,
  run: async (payload, context) => {
    const { owner, storage } = context;
    // Only a person's own store drafts for its person.
    if (owner === undefined || draftedBefore(storage.sql, payload.key)) {
      return;
    }
    const drafted = await draftOf(context, payload, owner);
    if (drafted === undefined) {
      return;
    }
    // Written only while every version is still current and theirs, and
    // nothing was drafted under the key meanwhile, in one transaction.
    const written = storage.transactionSync(() => {
      if (
        draftedBefore(storage.sql, payload.key) ||
        !allCurrent(storage.sql, owner, drafted.restsOn)
      ) {
        return false;
      }
      storage.sql.exec(
        `INSERT INTO skill_proposals (key, state, text, rests_on, drafted_at)
        VALUES (?, 'open', ?, ?, ?)`,
        payload.key,
        drafted.text,
        JSON.stringify(drafted.restsOn),
        Date.now()
      );
      return true;
    });
    log.info("brain.skill_proposed", {
      sources: drafted.restsOn.length,
      written: written ? 1 : 0,
    });
  },
});

/**
 * Puts a draft of `request` on the queue in `storage`, a person's own
 * store, unless one was drafted under its key already (open or settled).
 * An item of the key still waiting is replaced.
 */
export const enqueueProposal = (
  storage: DurableObjectStorage,
  { key, about, sources }: Omit<ProposalRequest, "person">
): void => {
  if (draftedBefore(storage.sql, key)) {
    return;
  }
  enqueueWork(storage, proposeWork, {
    key: `proposal:${key}`,
    payload: { key, about, sources },
    priority: "conversation",
  });
};

const restsOnSchema = z.array(
  z.strictObject({ source: z.string(), version: z.int().positive() })
);

/**
 * `?1` the open state, `?2` the reader's person, `?3` their groups
 * (JSON): the open proposals every version of which is its source's
 * current one and readable by the reader, oldest first.
 */
const listSql = `
WITH ${readableSql}
SELECT key, text, rests_on, drafted_at FROM skill_proposals AS p
WHERE p.state = ?1 AND NOT EXISTS (
  SELECT 1 FROM json_each(p.rests_on) AS rested
  WHERE NOT EXISTS (
    SELECT 1 FROM current_versions
    JOIN source_versions ON source_versions.row = current_versions.version_row
    WHERE current_versions.source = json_extract(rested.value, '$.source')
      AND source_versions.version = json_extract(rested.value, '$.version')
      AND source_versions.reader_set IN (SELECT reader_set FROM readable)
  )
)
ORDER BY p.drafted_at, p.key`;

/** The open proposals `reader` may read now: one statement. */
export const listProposals = (
  sql: SqlStorage,
  reader: Reader
): SkillProposal[] =>
  sql
    .exec<{
      key: string;
      text: string;
      rests_on: string;
      drafted_at: number;
    }>(listSql, "open", reader.person, JSON.stringify(reader.groups))
    .toArray()
    .map((row) => ({
      key: row.key,
      text: row.text,
      restsOn: restsOnSchema.parse(JSON.parse(row.rests_on)),
      draftedAt: new Date(row.drafted_at),
    }));

/**
 * Settles the open proposal `key`, accepted or dismissed alike (nothing
 * reads which), keeping its key alone, so
 * nothing is drafted under it again; one settled before stays as it was.
 */
export const settleProposal = (
  sql: SqlStorage,
  { key }: Omit<ProposalSettle, "person">
): void => {
  sql.exec(
    `UPDATE skill_proposals SET state = 'settled', text = NULL, rests_on = NULL
    WHERE key = ? AND state = 'open'`,
    proposalKeySchema.parse(key)
  );
};
