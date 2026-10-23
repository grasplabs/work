/**
 * The onboarding's Durable Object SQLite (onboarding/store.ts): one per
 * deployment. Migrates itself on first wake-up after a release.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * The onboarding as a whole, one row: the plan, the agreements, and
 * whether Grasp paused the interviews. A plan, once saved, is what links
 * go out by.
 */
export const onboarding = sqliteTable(
  "onboarding",
  {
    id: integer().primaryKey(),
    /** The plan as JSON (`planSchema`), or `null` before there is one. */
    plan: text(),
    /** The agreements as JSON (`agreementsSchema`), or `null` before any. */
    agreements: text(),
    /** When Grasp paused the interviews (ISO 8601); `null` while they run. */
    pausedAt: text("paused_at"),
    /**
     * How Stephen is set up, as JSON (`stephenSetupSchema`), or `null`
     * while he is as the kickoff suggests.
     */
    stephen: text(),
    /**
     * When the first link went out (ISO 8601): the team is told, and the
     * agreements stay as they were. Never cleared, whoever leaves the
     * roster with their link; `null` before any link went out.
     */
    toldAt: text("told_at"),
    /**
     * What the admin chose about what Grasp may connect, as JSON
     * (`setupChoicesSchema`), or `null` before anything.
     */
    choices: text(),
  },
  (table) => [check("onboarding_one_row", sql`${table.id} = 1`)]
);

/** The teams, in the order the admin gave them. */
export const teams = sqliteTable("teams", {
  id: text().primaryKey(),
  position: integer().notNull(),
  name: text().notNull(),
  /** Its lead, by person. */
  lead: text(),
  does: text().notNull(),
  off: integer({ mode: "boolean" }).notNull(),
  /**
   * When its lead's map of the team's work was drawn (ISO 8601): its links
   * wait for that, or for `leadWaitWorkingDays`.
   */
  mappedAt: text("mapped_at"),
});

/** The people, in the order the admin gave them. */
export const people = sqliteTable("people", {
  id: text().primaryKey(),
  position: integer().notNull(),
  name: text().notNull(),
  email: text().notNull(),
  team: text().notNull(),
  title: text().notNull(),
  away: integer({ mode: "boolean" }).notNull(),
});

/**
 * Each person's link, once it went out: when, and when it was opened and
 * reminded about. A person without a row has no link out yet.
 */
export const links = sqliteTable("links", {
  person: text().primaryKey(),
  sentAt: text("sent_at").notNull(),
  openedAt: text("opened_at"),
  remindedAt: text("reminded_at"),
  /**
   * The SHA-256 (hex) of the key of the device that opened the link
   * first: only that device opens the interview after. None before any
   * did, or since staff gave them a new start.
   */
  keyMark: text("key_mark"),
  /** When they deleted their interview: a copy left open can't save it back. */
  deletedAt: text("deleted_at"),
  /**
   * The team they led when their link went out; none when they led none.
   * Only this makes theirs a lead's interview (rules.ts, `leadsTalked`):
   * making someone a lead afterwards tells nobody about their interview.
   */
  ledTeam: text("led_team"),
  /**
   * The version of what their interview holds: a save goes up by one, and
   * so does a delete or a new start, so no copy from before either ever
   * matches again. A save from a copy of another version is refused.
   */
  version: integer().notNull().default(0),
});

/**
 * What each person's link is made from: a random id of its own, which
 * core's key turns into the link's secret (onboarding/links.ts), and the
 * SHA-256 (hex) of that secret, which a request's is looked up by. The
 * secret itself is kept nowhere. Made when someone is added to the
 * roster, gone when they leave it, so someone added back gets a new link.
 */
export const linkCodes = sqliteTable("link_codes", {
  person: text().primaryKey(),
  linkId: text("link_id").notNull(),
  mark: text().notNull().unique(),
});

/**
 * What was said in each interview, as the person's page last saved it
 * (its version is the link's). Only the device the link opened on
 * reads it back, and Grasp's staff.
 */
export const interviews = sqliteTable("interviews", {
  person: text().primaryKey(),
  progress: text().notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Where each interview stands, without anything that was said in it: all
 * the plan, the links and the numbers need, so a change never reads every
 * interview.
 */
export const interviewStates = sqliteTable("interview_states", {
  person: text().primaryKey(),
  kind: text({ enum: ["own", "lead"] }).notNull(),
  /**
   * The team they gave a lead's interview for, as the roster said before
   * they agreed; none for an employee's interview. Settled, with `kind`,
   * once they agree.
   */
  leadOf: text("lead_of"),
  startedAt: text("started_at"),
  /** When they first agreed to what was read back (ISO 8601). */
  completedAt: text("completed_at"),
  /**
   * When they last agreed to something new (ISO 8601): their first
   * agreement, or what they added and agreed to after. What they agreed to
   * is drawn from then on.
   */
  agreedAt: text("agreed_at"),
  /** When what they agreed to was last drawn (ISO 8601); null before it ever was. */
  drawnAt: text("drawn_at"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * The interviewer's texts each interview was held with, by their mark
 * (onboarding/interviewer-text.ts), and when each first spoke in it: so
 * staff, and the lab, know which Stephen they read. Gone with what was said.
 */
export const interviewTexts = sqliteTable(
  "interview_texts",
  {
    person: text().notNull(),
    mark: text().notNull(),
    at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.person, table.mark] })]
);

/**
 * Everyone ever counted in the admin's numbers (`teamCounts`), once: the
 * team they were asked in, and whether their talking was counted. Kept when
 * they leave the roster, so taking someone off and on again can't count
 * them twice. Leads aren't here: they are counted apart.
 */
export const countedPeople = sqliteTable("counted", {
  person: text().primaryKey(),
  team: text().notNull(),
  talked: integer({ mode: "boolean" }).notNull(),
});

/**
 * How many were asked and how many talked, by team and by the day it
 * happened: what the company's admin reads, as numbers that only ever grow.
 * A person is counted once (`countedPeople`), in the team they were in when
 * their link first went out, and stays counted whatever the roster says
 * later, so editing it (someone marked away, moved, removed or added
 * again) can't tell the admin whether they talked.
 */
export const teamCounts = sqliteTable(
  "team_counts",
  {
    team: text().notNull(),
    day: text().notNull(),
    asked: integer().notNull(),
    talked: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.team, table.day] })]
);

/**
 * What happened in the onboarding, and who did it: Grasp's staff, the
 * company's admin, or Grasp itself. Ids and counts only, never anyone's
 * words.
 */
export const events = sqliteTable("events", {
  seq: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  by: text().notNull(),
  what: text().notNull(),
  about: text(),
});

/**
 * Grasp's staff's own notes on the onboarding: who wrote them and when.
 * Only staff read them.
 */
export const notes = sqliteTable("notes", {
  id: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  by: text().notNull(),
  text: text().notNull(),
});

/**
 * The kickoff, one row: Grasp's first conversation with the sponsor, as
 * staff brought it in, Stephen's reading of it (JSON, `KickoffReading`),
 * and the sponsor's answers to what it left open (JSON, by field). Only
 * staff read it; Stephen's context is made from it.
 */
export const kickoff = sqliteTable(
  "kickoff",
  {
    id: integer().primaryKey(),
    at: text().notNull(),
    by: text().notNull(),
    fileName: text("file_name"),
    transcript: text().notNull(),
    reading: text().notNull(),
    answers: text().notNull().default("{}"),
  },
  (table) => [check("kickoff_one_row", sql`${table.id} = 1`)]
);

/**
 * Documents the company's admin shared (onboarding/documents.ts), by their
 * upload in Knowledge: Stephen's reading of each (JSON, `DocumentReading`),
 * and the admin's answer to its question. The file itself is Knowledge's.
 */
export const documents = sqliteTable("documents", {
  id: text().primaryKey(),
  name: text().notNull(),
  at: text().notNull(),
  by: text().notNull(),
  reading: text().notNull(),
  answer: text(),
});

/**
 * The teams' pieces of work, from their leads' maps (team-map.ts): a whole
 * job that comes back, named in English and in the team's language. Drawn
 * again, a piece keeps its id while its name stays.
 */
export const works = sqliteTable("works", {
  id: text().primaryKey(),
  team: text().notNull(),
  position: integer().notNull(),
  name: text().notNull(),
  local: text().notNull(),
  /** What one of them is called, and several. */
  one: text().notNull(),
  many: text().notNull(),
  /** Who does it, by person, as JSON. */
  doers: text().notNull(),
  /** Roughly how much of the team's time it takes, 0 to 1. */
  share: real().notNull(),
});

/**
 * Which piece of work each person is asked about. Apart from the roster,
 * so saving who works where keeps it; it goes with the person.
 */
export const askedAbout = sqliteTable("asked_about", {
  person: text().primaryKey(),
  work: text().notNull(),
});

/**
 * Each piece of work as drawn from what its people agreed to
 * (work-drawing.ts), apart from `works`, which a map draws again. `agreed`
 * is whose agreements it was drawn from, and when each last agreed, as
 * JSON: someone agreeing to more since makes it due again.
 */
export const drawnWorks = sqliteTable("drawn_works", {
  work: text().primaryKey(),
  /** The drawing as JSON (`DrawnWork`); null when it was given up before any. */
  drawn: text(),
  agreed: text().notNull(),
  at: text().notNull(),
});

/**
 * Each team on its way into the brain (onboarding/brain-intake.ts): when
 * something new of it waits to be given to the brain (`dueAt`), and when
 * the brain first had any of it (`sentAt`), both ISO 8601.
 */
export const brainTeams = sqliteTable("brain_teams", {
  team: text().primaryKey(),
  dueAt: text("due_at"),
  sentAt: text("sent_at"),
});

/**
 * Who each record the onboarding gave the brain rests on: a statement on
 * whoever agreed to its fact, a drawing on whom it was drawn from. The
 * brain's records never name a person; this is how deleting an interview
 * finds what it is in (GRA-368). Goes with nothing else.
 */
export const brainSent = sqliteTable(
  "brain_sent",
  {
    record: text().notNull(),
    type: text().notNull(),
    team: text().notNull(),
    person: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.record, table.person] }),
    index("brain_sent_person").on(table.person),
  ]
);

/**
 * Drawings that failed and wait to be tried again: what (`team:<id>` or
 * `work:<id>`), how often it failed, and when it may be tried again (ISO 8601).
 */
export const drawFailures = sqliteTable("draw_failures", {
  item: text().primaryKey(),
  tries: integer().notNull(),
  after: text().notNull(),
});

/**
 * The AI the onboarding used, by day, purpose and model: calls, tokens
 * read new and from a cache, tokens written, and seconds of voice.
 */
export const usage = sqliteTable(
  "usage",
  {
    day: text().notNull(),
    purpose: text().notNull(),
    model: text().notNull(),
    calls: integer().notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensCached: integer("tokens_cached").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    seconds: real().notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.purpose, table.model] })]
);

/**
 * Seconds of voice said today (`/api/speech`, onboarding/speech.ts), by
 * whom they were said for: `link:<person>` for someone's interview link,
 * `admin:<user>` for an admin. Only today's are kept: each count deletes
 * the days before it.
 */
export const voiceUse = sqliteTable(
  "voice_use",
  {
    who: text().notNull(),
    day: text().notNull(),
    seconds: real().notNull(),
  },
  (table) => [primaryKey({ columns: [table.who, table.day] })]
);

/**
 * The text each interview ran on (onboarding/interviewer-text.ts), as its
 * last turn had it: the text's mark, who held it, and in which language.
 * Nothing that was said. Goes with the interview.
 */
export const interviewSettings = sqliteTable("interview_settings", {
  person: text().primaryKey(),
  mark: text().notNull(),
  interviewer: text({ enum: ["stephen", "claire"] }).notNull(),
  locale: text().notNull(),
});

/**
 * How long people waited for Stephen's voice, from the end of what they
 * said to his first sound, as their page measured it: by day, how many
 * answers took up to each tenth of a second (`upTo`, in ms). Whose
 * answers they were isn't kept.
 */
export const answerWaits = sqliteTable(
  "answer_waits",
  {
    day: text().notNull(),
    upTo: integer("up_to").notNull(),
    answers: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.upTo] })]
);

/**
 * Audit events of changes here, each stored in the same transaction as its
 * change, until the object has delivered it to the audit log
 * (`drainObjectOutbox` in audit-outbox.ts).
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Mail the onboarding sends (mail-outbox.ts), each once, by its key: a mail
 * queued again under a key it holds already is not sent again. A mail with
 * someone's link names whose (`fill`) and holds a slot for it, filled in
 * only as it is sent, so the link's secret is kept here no more than
 * anywhere else (link-secret.ts).
 */
export const mailOutbox = sqliteTable(
  "mail_outbox",
  {
    key: text().primaryKey(),
    /** Whom it is about, by person, for the log; null for nobody in particular. */
    about: text(),
    to: text("to_address").notNull(),
    /** Subject, bodies and headers as JSON (`queuedMailSchema`), slots unfilled. */
    mail: text().notNull(),
    /** What fills its slots as it is sent: for a link's mail, whose link. */
    fill: text(),
    state: text({ enum: ["queued", "sent", "failed"] }).notNull(),
    attempts: integer().notNull().default(0),
    /** When it is tried next (ms since the epoch), while queued. */
    nextAt: integer("next_at").notNull(),
    queuedAt: text("queued_at").notNull(),
    /** When it was sent, or ended failed (ISO 8601). */
    settledAt: text("settled_at"),
    /** Why its last try didn't send it: Email Sending's code, or core's. */
    reason: text(),
    messageId: text("message_id"),
  },
  (table) => [index("mail_outbox_due").on(table.state, table.nextAt)]
);
