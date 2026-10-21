import {
  admissionErrors,
  topicExampleSchema,
  topicInputSchema,
  topicLeadMs,
  topicRetireSchema,
} from "@grasp-os/shared/admission";
import type {
  AdmissionTopic,
  AdmissionTopicState,
} from "@grasp-os/shared/admission";
import { actorOf } from "@grasp-os/shared/audit";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { admissionTopics } from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import { platformTopics } from "./admission-topics.ts";
import { normalized, topicRows } from "./admission.ts";

// Knowledge admission's topic records, for admins: every topic's revision
// in effect and the next one to come, and a company's own topics saved,
// revised and retired. Each change is a new revision, never an edit of one
// (the table refuses updates), effective `topicLeadMs` after it's saved
// at the earliest, and recorded in the audit log by topic and revision:
// a topic's name and terms may themselves say what a company keeps quiet,
// so they stay out of the log. Grasp's own topics can't be changed here:
// their detectors are code.

type TopicRow = typeof admissionTopics.$inferSelect;

const examplesSchema = z.array(topicExampleSchema);
const termsSchema = z.array(z.string());

const toTopic = (row: TopicRow): AdmissionTopic => ({
  id: row.id,
  revision: row.revision,
  name: row.name,
  coverage: row.coverage,
  examples: examplesSchema.parse(JSON.parse(row.examples)),
  terms: termsSchema.parse(JSON.parse(row.terms)),
  owner: row.owner,
  effectiveAt: row.effectiveAt.toISOString(),
  retired: row.retired,
  createdBy: row.createdBy,
});

/** Refuses anyone but the company's own admins: never Grasp staff. */
const requireCompanyAdmin = (person: Identity): void => {
  requireAdmin(person);
  // Staff are admins, but never decide what a client keeps out of its brain.
  if (person.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

/** Each topic's revision in effect at `now`, and the latest still to come. */
const statesOf = (rows: TopicRow[], now: Date): AdmissionTopicState[] => {
  const states = new Map<string, AdmissionTopicState>();
  for (const row of rows) {
    const state = states.get(row.id) ?? { current: null, upcoming: null };
    const topic = toTopic(row);
    if (row.effectiveAt <= now) {
      if (state.current === null || row.revision > state.current.revision) {
        state.current = topic;
      }
    } else if (
      state.upcoming === null ||
      row.revision > state.upcoming.revision
    ) {
      state.upcoming = topic;
    }
    states.set(row.id, state);
  }
  const platform = new Set(platformTopics.map(({ record }) => record.id));
  return [...states.entries()]
    .toSorted(([a], [b]) => {
      const order = Number(platform.has(b)) - Number(platform.has(a));
      return order === 0 ? a.localeCompare(b) : order;
    })
    .map(([, state]) => state);
};

/** Every topic, for an admin (Grasp staff included: they may look). */
export const listTopics = async (
  env: Env,
  person: Identity
): Promise<AdmissionTopicState[]> => {
  requireAdmin(person);
  return statesOf(await topicRows(env), new Date());
};

/** The latest revision of the company topic `id`, if there is one. */
const latestOf = async (env: Env, id: string): Promise<TopicRow | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(admissionTopics)
    .where(eq(admissionTopics.id, id))
    .orderBy(desc(admissionTopics.revision))
    .limit(1)
    .get();

/**
 * A term as admission matches it: normalized, its trailing `*` kept
 * (normalizing drops Markdown's `*`).
 */
const matchedAs = (term: string): string =>
  term.endsWith("*") ? `${normalized(term.slice(0, -1))}*` : normalized(term);

/** From when a revision saved now takes effect: never sooner than the lead. */
const effectiveFrom = (asked: string | undefined, now: Date): Date => {
  const earliest = now.getTime() + topicLeadMs;
  const wanted = asked === undefined ? earliest : Date.parse(asked);
  return new Date(Math.max(wanted, earliest));
};

/**
 * Writes `row`, the next revision of its topic, with its audit event:
 * `admission.conflict` if another revision took its number first.
 */
const writeRevision = async (
  env: Env,
  person: Identity,
  row: TopicRow,
  action:
    | "knowledge.admission.topic_saved"
    | "knowledge.admission.topic_retired"
): Promise<AdmissionTopic> => {
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(admissionTopics).values(row),
      outboxed(db, {
        actor: actorOf(person),
        action,
        target: { type: "admission_topic", id: row.id },
        detail: {
          revision: row.revision,
          effectiveAt: row.effectiveAt.toISOString(),
        },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw admissionErrors.create("admission.conflict");
    }
    throw error;
  }
  return toTopic(row);
};

/**
 * The topic `id` at revision `ifRevision`, a company's, so its next
 * revision can be written: refused if it's Grasp's, missing or moved on.
 */
const companyTopicAt = async (
  env: Env,
  id: string,
  ifRevision: number
): Promise<TopicRow> => {
  const latest = await latestOf(env, id);
  if (latest === undefined) {
    throw admissionErrors.create("admission.not_found");
  }
  if (latest.owner !== "company") {
    throw admissionErrors.create("admission.platform");
  }
  if (latest.revision !== ifRevision) {
    throw admissionErrors.create("admission.conflict");
  }
  return latest;
};

/**
 * Saves a company topic (`ifRevision` 0) or its next revision, effective
 * from `effectiveAt`, never sooner than `topicLeadMs` from now. Its terms
 * are kept as admission matches them: lowercased, accents removed.
 */
export const saveTopic = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<AdmissionTopic> => {
  requireCompanyAdmin(person);
  const parsed = admissionErrors.parse(
    "admission.invalid",
    topicInputSchema,
    input
  );
  if (
    parsed.effectiveAt !== undefined &&
    Number.isNaN(Date.parse(parsed.effectiveAt))
  ) {
    throw admissionErrors.create("admission.invalid");
  }
  if ((parsed.id === undefined) !== (parsed.ifRevision === 0)) {
    throw admissionErrors.create("admission.invalid");
  }
  const id = parsed.id ?? `company-${crypto.randomUUID()}`;
  if (parsed.id !== undefined) {
    await companyTopicAt(env, parsed.id, parsed.ifRevision);
  }
  const now = new Date();
  const terms = [...new Set(parsed.terms.map((term) => matchedAs(term)))];
  return await writeRevision(
    env,
    person,
    {
      id,
      revision: parsed.ifRevision + 1,
      name: parsed.name,
      coverage: parsed.coverage,
      examples: JSON.stringify(parsed.examples),
      owner: "company",
      effectiveAt: effectiveFrom(parsed.effectiveAt, now),
      createdAt: now,
      terms: JSON.stringify(terms),
      retired: false,
      createdBy: person.userId,
    },
    "knowledge.admission.topic_saved"
  );
};

/**
 * Retires a company topic from its next revision, `topicLeadMs` from now:
 * until then, the revision in effect still applies.
 */
export const retireTopic = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<AdmissionTopic> => {
  requireCompanyAdmin(person);
  const { id, ifRevision } = admissionErrors.parse(
    "admission.invalid",
    topicRetireSchema,
    input
  );
  const latest = await companyTopicAt(env, id, ifRevision);
  if (latest.retired) {
    throw admissionErrors.create("admission.retired");
  }
  const now = new Date();
  return await writeRevision(
    env,
    person,
    {
      ...latest,
      revision: ifRevision + 1,
      effectiveAt: effectiveFrom(undefined, now),
      createdAt: now,
      retired: true,
      createdBy: person.userId,
    },
    "knowledge.admission.topic_retired"
  );
};
