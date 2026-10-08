import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import {
  interviewPagePath,
  interviewProgressSchema,
} from "@grasp-os/shared/interview-links";
import type {
  InterviewElsewhere,
  InterviewProgress,
  InterviewSaved,
  InterviewSession,
} from "@grasp-os/shared/interview-links";
import { agreementsSchema, planSchema } from "@grasp-os/shared/onboarding";
import type {
  Agreements,
  OnboardingView,
  Plan,
  Roster,
} from "@grasp-os/shared/onboarding";
import { DurableObject } from "cloudflare:workers";
import { asc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import { drainObjectOutbox } from "../audit-outbox.ts";
import { migrateOnWake } from "../db/migrate.ts";
import migrations from "../db/onboarding/migrations/migrations.js";
import {
  auditOutbox,
  countedPeople,
  events,
  interviewStates,
  interviews,
  linkCodes,
  links,
  onboarding,
  people,
  teamCounts,
  teams,
  usage,
} from "../db/onboarding/schema.ts";
import { inJurisdiction } from "../durable-objects.ts";
import { linkSecretOf } from "./link-secret.ts";
import {
  agreementsIn,
  closesOn,
  dayOf,
  dueLinks,
  leads,
  progressOf,
  sendsFrom,
  takingPart,
} from "./rules.ts";
import type { InterviewState, TeamCount } from "./rules.ts";

// The onboarding's store: one Durable Object per deployment holds who works
// where, the plan, everyone's link and where each interview stands, the log
// and the AI used. It is the only place any of it is kept. Each side reads
// only what it may (rpc.ts): the company's admin numbers per team, never
// anyone's words; Grasp's staff more, as their issues come. What it can't
// let happen, from the threat model (GRA-307), and what stops it here:
//
// - A link going out before its moment, while the interviews are paused,
//   or before the agreements are in: the alarm releases links, and only
//   while `isOpen()`, by the plan's moments (`dueLinks`).
// - The admin's numbers singling someone out: `view()` returns numbers
//   only, none for a team until five were asked, moving once a day, from
//   tallies that editing the roster doesn't move (`progressOf`).
// - A roster past its limits: refused by `rosterSchema` before it reaches
//   here (rpc.ts).
// - A change without a trace: every change by the admin or staff is in the
//   audit log, with ids and counts, never names or words.
// - A link opening what isn't its own (GRA-287, links.ts): the store is
//   given only the hashes of a link's secret and a device's key, and opens
//   one person's interview for the one device that opened it first.
//   What each person does on their link is in the onboarding's own log,
//   which only staff read, never in the audit log, which the company's
//   admin reads: it would tell them who talked, and when.

/** The one store of a deployment, by the name it is reached under. */
const storeName = "onboarding";

/** The deployment's onboarding store. */
export const onboardingStore = (
  env: Pick<Env, "ONBOARDING" | "DURABLE_OBJECT_JURISDICTION">
) => inJurisdiction(env, env.ONBOARDING).getByName(storeName);

/** What the audit log names as acted on. */
const target = { type: "onboarding", id: storeName } as const;

/** Most calls one link makes in a minute: a person talks far slower. */
const linkCallsPerMinute = 60;

/** Why a link refused a request, as links.ts answers it. */
export type LinkRefusal =
  | "interview.link_invalid"
  | "interview.not_yet"
  | "interview.paused"
  | "interview.closed"
  | "interview.elsewhere"
  | "interview.deleted"
  | "interview.limited";

/** What a link's request gets from the store: an answer, or why not. */
export type LinkAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; code: LinkRefusal };

const refused = (code: LinkRefusal) => ({ ok: false, code }) as const;
const answered = <T>(value: T) => ({ ok: true, value }) as const;

/** A person's first name, as Stephen calls them. */
const firstName = (name: string): string => name.trim().split(/\s+/u)[0] ?? "";

/** How long the alarm waits, at most, before it looks for due links again. */
const linkCheckMs = 60 * 60 * 1000;
/** And how long before it retries delivering audit events, first and at most. */
const auditRetryMs = { first: 5000, most: 15 * 60 * 1000 };

/** What one model call took, to count for the onboarding. */
export interface Took {
  purpose: "reading" | "interviews" | "drawing";
  /** The model, or `voice` for Stephen's. */
  model: string;
  tokensIn?: number;
  tokensCached?: number;
  tokensOut?: number;
  seconds?: number;
}

/** Who did something, as the onboarding's log names them: never by name. */
const whoIs = (by: AuditActor): string => {
  if (by.type === "person" || by.type === "staff") {
    return `${by.type}:${by.userId}`;
  }
  return by.type === "system" ? "grasp" : by.type;
};

/** A count as given, when it is one: a number from nothing up. */
const counted = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export class Onboarding extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);
  #auditRetryMs = auditRetryMs.first;
  /** Calls per link in the current minute: the store counts per link, never per address. */
  readonly #calls = new Map<string, { minute: string; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    // The one row everything else updates, there before anything asks.
    this.#db.insert(onboarding).values({ id: 1 }).onConflictDoNothing().run();
  }

  /** The onboarding as its admin sees it. */
  view(now: string = new Date().toISOString()): OnboardingView {
    const roster = this.#roster();
    const row = this.#row();
    return {
      roster,
      plan: row.plan,
      progress:
        roster === null
          ? null
          : progressOf(roster, this.#interviews(), this.#counts(), now),
      agreed: agreementsIn(row.agreements),
      paused: row.pausedAt !== null,
    };
  }

  /** Whether interviews may happen now: not paused, and the agreements in. */
  isOpen(): boolean {
    const row = this.#row();
    return row.pausedAt === null && agreementsIn(row.agreements);
  }

  /**
   * Replaces who works where. People who are no longer in it keep nothing
   * here: their link, what they said and where their interview stood go
   * with them. Everyone new gets a link of their own.
   */
  async saveRoster(roster: Roster, by: AuditActor): Promise<OnboardingView> {
    const coded = new Set(
      this.#db
        .select({ person: linkCodes.person })
        .from(linkCodes)
        .all()
        .map(({ person }) => person)
    );
    const fresh = await Promise.all(
      roster.people
        .filter(({ id }) => !coded.has(id))
        .map(async ({ id }) => {
          const linkId = randomToken();
          const mark = await sha256Hex(await linkSecretOf(this.env, linkId));
          return { person: id, linkId, mark };
        })
    );
    this.ctx.storage.transactionSync(() => {
      const kept = new Set(roster.people.map((person) => person.id));
      const gone = this.#db
        .select({ id: people.id })
        .from(people)
        .all()
        .filter(({ id }) => !kept.has(id))
        .map(({ id }) => id);
      const mapped = new Map(
        this.#db
          .select({ id: teams.id, mappedAt: teams.mappedAt })
          .from(teams)
          .all()
          .map(({ id, mappedAt }) => [id, mappedAt])
      );
      this.#db.delete(teams).run();
      this.#db.delete(people).run();
      for (const [position, team] of roster.teams.entries()) {
        this.#db
          .insert(teams)
          .values({ ...team, position, mappedAt: mapped.get(team.id) ?? null })
          .run();
      }
      for (const [position, person] of roster.people.entries()) {
        this.#db
          .insert(people)
          .values({ ...person, position })
          .run();
      }
      for (const code of fresh) {
        this.#db.insert(linkCodes).values(code).onConflictDoNothing().run();
      }
      // Whoever left keeps nothing: no link, nothing said, no state.
      const stale = this.#db
        .select({ person: linkCodes.person })
        .from(linkCodes)
        .all()
        .map(({ person }) => person)
        .filter((person) => !kept.has(person));
      for (const person of new Set([...gone, ...stale])) {
        this.#db.delete(linkCodes).where(eq(linkCodes.person, person)).run();
        this.#db.delete(links).where(eq(links.person, person)).run();
        this.#db.delete(interviews).where(eq(interviews.person, person)).run();
        this.#db
          .delete(interviewStates)
          .where(eq(interviewStates.person, person))
          .run();
      }
      this.#changed(by, "onboarding.roster.saved", {
        teams: roster.teams.length,
        people: roster.people.length,
        removed: gone.length,
      });
    });
    this.#deliverAudit();
    this.ctx.waitUntil(this.#armLinks());
    return this.view();
  }

  /** Sets when the interviews run. Links go out by it, once the interviews are open. */
  savePlan(plan: Plan, by: AuditActor): OnboardingView {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(onboarding)
        .set({ plan: JSON.stringify(plan) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(by, "onboarding.plan.saved", {
        start: plan.start,
        days: plan.days,
      });
    });
    this.#deliverAudit();
    this.ctx.waitUntil(this.#armLinks());
    return this.view();
  }

  /** Pauses the interviews, or lets them run again. */
  setPaused(paused: boolean, by: AuditActor): OnboardingView {
    const was = this.#row().pausedAt !== null;
    if (was !== paused) {
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(onboarding)
          .set({ pausedAt: paused ? new Date().toISOString() : null })
          .where(eq(onboarding.id, 1))
          .run();
        this.#changed(
          by,
          paused ? "onboarding.paused" : "onboarding.resumed",
          {}
        );
      });
      this.#deliverAudit();
      this.ctx.waitUntil(this.#armLinks());
    }
    return this.view();
  }

  /** Records where the agreements stand. */
  setAgreements(agreements: Agreements, by: AuditActor): OnboardingView {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(onboarding)
        .set({ agreements: JSON.stringify(agreements) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(by, "onboarding.agreements.set", { ...agreements });
    });
    this.#deliverAudit();
    this.ctx.waitUntil(this.#armLinks());
    return this.view();
  }

  /**
   * Records where someone's interview stands, without anything said in it:
   * the interviews (GRA-289, GRA-290) report each change here.
   */
  noteInterview(state: {
    person: string;
    kind: "own" | "lead";
    startedAt: string | null;
    completedAt: string | null;
  }): void {
    this.ctx.storage.transactionSync(() => {
      this.#noteState(state);
    });
  }

  /**
   * The path of someone's link, its secret after the `#`; none for anyone
   * not on the roster. Someone on it without a code yet (on the roster
   * before links were, or added by a save that raced another) gets one now.
   */
  async linkOf(person: string): Promise<string | null> {
    if (!this.#onRoster(person)) {
      return null;
    }
    const codeOf = () =>
      this.#db
        .select({ linkId: linkCodes.linkId })
        .from(linkCodes)
        .where(eq(linkCodes.person, person))
        .all()[0];
    let code = codeOf();
    if (code === undefined) {
      const linkId = randomToken();
      const mark = await sha256Hex(await linkSecretOf(this.env, linkId));
      // Unless someone made one meanwhile, or they left the roster.
      this.ctx.storage.transactionSync(() => {
        if (this.#onRoster(person)) {
          this.#db
            .insert(linkCodes)
            .values({ person, linkId, mark })
            .onConflictDoNothing()
            .run();
        }
      });
      code = codeOf();
    }
    return code === undefined
      ? null
      : `${interviewPagePath}#${await linkSecretOf(this.env, code.linkId)}`;
  }

  /**
   * What a link opens, for the device whose key's mark is `keyMark`. The
   * first device to open it is the one `issue` (a new key's mark) is
   * kept for, and the answer says so; anyone else gets `elsewhere`, with
   * nothing that was said.
   */
  openLink(
    secretMark: string,
    keyMark: string | null,
    issue: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<
    (Omit<InterviewSession, "key"> & { issued: boolean }) | InterviewElsewhere
  > {
    const found = this.#onLink(secretMark, now, "open");
    if (!found.ok) {
      return found;
    }
    const { person, link, roster, plan } = found.value;
    const issued = link.keyMark === null;
    if (!issued && link.keyMark !== keyMark) {
      return answered({ state: "elsewhere" });
    }
    if (issued || link.openedAt === null) {
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(links)
          .set({
            openedAt: link.openedAt ?? now,
            keyMark: issued ? issue : link.keyMark,
          })
          .where(eq(links.person, person.id))
          .run();
        if (link.openedAt === null) {
          this.#noted(person.id, "interview.opened", now);
        }
      });
    }
    const team = roster.teams.find(({ id }) => id === person.team);
    const lead = roster.people.find(
      ({ id }) => id === team?.lead && id !== person.id
    );
    const closes = closesOn(plan);
    return answered({
      state: "open",
      issued,
      name: firstName(person.name),
      team: team?.name ?? "",
      lead: lead === undefined ? null : firstName(lead.name),
      kind: leads(roster, person.id) ? "lead" : "own",
      closes,
      closed: dayOf(now) > closes,
      progress: this.#held(person.id),
      version: link.version,
    });
  }

  /**
   * Keeps where someone's interview is, from the device it is on. A save
   * from an older copy than the one kept is refused with the one kept, so
   * two tabs never quietly overwrite each other. Deleting moves the version
   * on too: only a copy opened since the delete saves again.
   */
  saveInterview(
    secretMark: string,
    keyMark: string,
    version: number,
    progress: InterviewProgress,
    now: string = new Date().toISOString()
  ): LinkAnswer<InterviewSaved> {
    const found = this.#onLink(secretMark, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link, roster } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    if (version !== link.version) {
      const held = this.#held(person.id);
      if (held === null && link.deletedAt !== null) {
        return refused("interview.deleted");
      }
      return answered({ saved: false, version: link.version, progress: held });
    }
    const next = link.version + 1;
    const [state] = this.#db
      .select()
      .from(interviewStates)
      .where(eq(interviewStates.person, person.id))
      .all();
    const startedAt =
      state?.startedAt ?? (progress.startedAt === null ? null : now);
    const completedAt =
      state?.completedAt ?? (progress.person === "completed" ? now : null);
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(links)
        .set({ version: next })
        .where(eq(links.person, person.id))
        .run();
      this.#db
        .insert(interviews)
        .values({
          person: person.id,
          progress: JSON.stringify(progress),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: interviews.person,
          set: { progress: JSON.stringify(progress), updatedAt: now },
        })
        .run();
      this.#noteState(
        {
          person: person.id,
          kind: leads(roster, person.id) ? "lead" : "own",
          startedAt,
          completedAt,
        },
        now
      );
      if (startedAt !== null && (state?.startedAt ?? null) === null) {
        this.#noted(person.id, "interview.started", now);
      }
      if (completedAt !== null && (state?.completedAt ?? null) === null) {
        this.#noted(person.id, "interview.completed", now);
      }
    });
    return answered({ saved: true, version: next });
  }

  /**
   * Deletes someone's interview, from the device it is on, at any time
   * their link opens there: what they said is gone at once, and a copy
   * left open elsewhere can't save it back. What was drawn from it goes
   * with GRA-314.
   */
  deleteInterview(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<{ deleted: true }> {
    const found = this.#onLink(secretMark, now, "delete");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    this.ctx.storage.transactionSync(() => {
      this.#forget(person.id, now, "interview.deleted");
      this.#db
        .update(links)
        .set({ deletedAt: now, version: link.version + 1 })
        .where(eq(links.person, person.id))
        .run();
    });
    return answered({ deleted: true });
  }

  /**
   * A new start for someone who lost the device their interview was on:
   * what they said goes, and the link opens again for the next device to
   * open it. Staff do it; the audit log has that they did, not for whom.
   */
  newStart(person: string, by: AuditActor): boolean {
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined) {
      return false;
    }
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.#forget(person, now, "interview.new_start");
      this.#db
        .update(links)
        .set({ keyMark: null, deletedAt: null, version: link.version + 1 })
        .where(eq(links.person, person))
        .run();
      this.#changed(by, "onboarding.interview.restarted", {});
    });
    this.#deliverAudit();
    return true;
  }

  /** People whose link went out, and when: for the links themselves (GRA-287) and the admin's list. */
  sentLinks(): { person: string; sentAt: string }[] {
    return this.#db
      .select({ person: links.person, sentAt: links.sentAt })
      .from(links)
      .orderBy(asc(links.sentAt), asc(links.person))
      .all();
  }

  /** Counts one model call for the day it ends on. */
  meter(took: Took, at: string = new Date().toISOString()): void {
    const day = at.slice(0, 10);
    const add = {
      calls: 1,
      tokensIn: counted(took.tokensIn),
      tokensCached: counted(took.tokensCached),
      tokensOut: counted(took.tokensOut),
      seconds: counted(took.seconds),
    };
    this.#db
      .insert(usage)
      .values({ day, purpose: took.purpose, model: took.model, ...add })
      .onConflictDoUpdate({
        target: [usage.day, usage.purpose, usage.model],
        set: {
          calls: sql`${usage.calls} + 1`,
          tokensIn: sql`${usage.tokensIn} + ${add.tokensIn}`,
          tokensCached: sql`${usage.tokensCached} + ${add.tokensCached}`,
          tokensOut: sql`${usage.tokensOut} + ${add.tokensOut}`,
          seconds: sql`${usage.seconds} + ${add.seconds}`,
        },
      })
      .run();
  }

  /** The AI used, by day, purpose and model. */
  usage(): (typeof usage.$inferSelect)[] {
    return this.#db
      .select()
      .from(usage)
      .orderBy(asc(usage.day), asc(usage.purpose), asc(usage.model))
      .all();
  }

  /**
   * Delivers audit events the log didn't take yet, and releases every link
   * that is due while the interviews are open; then sets itself again for
   * the next.
   */
  override async alarm(): Promise<void> {
    await this.#drainAudit();
    this.releaseDue();
    await this.#armLinks();
  }

  /** Releases every link due by `now`, while the interviews are open. Returns whose. */
  releaseDue(now: string = new Date().toISOString()): string[] {
    const roster = this.#roster();
    const { plan } = this.#row();
    if (roster === null || plan === null || !this.isOpen()) {
      return [];
    }
    const due = dueLinks(roster, plan, this.#linkFacts(), now);
    if (due.length === 0) {
      return [];
    }
    this.ctx.storage.transactionSync(() => {
      for (const person of due) {
        this.#db.insert(links).values({ person, sentAt: now }).run();
        const team = roster.people.find(({ id }) => id === person)?.team;
        const lead = roster.teams.some(({ lead: led }) => led === person);
        if (team !== undefined && !lead) {
          // Asked once ever: a person taken off and on again isn't asked twice.
          const added = this.#db
            .insert(countedPeople)
            .values({ person, team, talked: false })
            .onConflictDoNothing()
            .returning()
            .all();
          if (added.length > 0) {
            this.#count(team, now, { asked: 1 });
          }
        }
      }
      this.#changed({ type: "system" }, "onboarding.links.sent", {
        count: due.length,
      });
    });
    this.#deliverAudit();
    return due;
  }

  #linkFacts() {
    return {
      sent: new Set(
        this.#db
          .select({ person: links.person })
          .from(links)
          .all()
          .map(({ person }) => person)
      ),
      interviews: this.#interviews(),
      mapped: new Set(
        this.#db
          .select({ id: teams.id })
          .from(teams)
          .where(isNotNull(teams.mappedAt))
          .all()
          .map(({ id }) => id)
      ),
    };
  }

  /**
   * Sets the alarm for the next team moment still to come, and at most an
   * hour out while anyone's link is still to go: a lead's map can make a
   * team's links due at any time.
   */
  async #armLinks(): Promise<void> {
    const roster = this.#roster();
    const { plan } = this.#row();
    if (roster === null || plan === null || !this.isOpen()) {
      return;
    }
    const { sent } = this.#linkFacts();
    const waiting = roster.people.filter(
      (person) => takingPart(roster, person) && !sent.has(person.id)
    );
    if (waiting.length === 0) {
      return;
    }
    const now = Date.now();
    const moments = waiting
      .map((person) => sendsFrom(plan, person.team))
      .filter((moment) => moment !== null)
      .map((moment) => Date.parse(moment))
      .filter((moment) => moment > now);
    await this.#alarmBy(Math.min(now + linkCheckMs, ...moments));
  }

  /** Sets the alarm to go at `time` at the latest, never later than it was. */
  async #alarmBy(time: number): Promise<void> {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > time) {
      await this.ctx.storage.setAlarm(time);
    }
  }

  /**
   * The person a link's secret is theirs, when the link may be used for
   * `use` now: on the roster, sent, counted within its limit; to open or
   * save, also while the interviews run; to save, also before they close.
   * An unknown link and a removed person's answer the same.
   */
  #onLink(
    secretMark: string,
    now: string,
    use: "open" | "save" | "delete"
  ): LinkAnswer<{
    person: Roster["people"][number];
    link: typeof links.$inferSelect;
    roster: Roster;
    plan: Plan;
  }> {
    const [code] = this.#db
      .select({ person: linkCodes.person })
      .from(linkCodes)
      .where(eq(linkCodes.mark, secretMark))
      .all();
    const roster = this.#roster();
    const person = roster?.people.find(({ id }) => id === code?.person);
    if (roster === null || person === undefined) {
      return refused("interview.link_invalid");
    }
    if (!this.#withinLimit(person.id, now)) {
      return refused("interview.limited");
    }
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person.id))
      .all();
    const row = this.#row();
    if (link === undefined || row.plan === null) {
      return refused("interview.not_yet");
    }
    if (use !== "delete") {
      if (row.pausedAt !== null) {
        return refused("interview.paused");
      }
      if (!agreementsIn(row.agreements)) {
        return refused("interview.not_yet");
      }
    }
    if (use === "save" && dayOf(now) > closesOn(row.plan)) {
      return refused("interview.closed");
    }
    return answered({ person, link, roster, plan: row.plan });
  }

  /** Counts a call on someone's link; false past `linkCallsPerMinute`. */
  #withinLimit(person: string, now: string): boolean {
    const minute = now.slice(0, 16);
    const calls = this.#calls.get(person);
    const count = calls?.minute === minute ? calls.count + 1 : 1;
    this.#calls.set(person, { minute, count });
    return count <= linkCallsPerMinute;
  }

  /** What someone's interview holds now; none before a save. */
  #held(person: string): InterviewProgress | null {
    const [row] = this.#db
      .select({ progress: interviews.progress })
      .from(interviews)
      .where(eq(interviews.person, person))
      .all();
    return row === undefined
      ? null
      : interviewProgressSchema.parse(JSON.parse(row.progress));
  }

  #onRoster(person: string): boolean {
    return this.#db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, person))
      .all()
      .some(({ id }) => id === person);
  }

  /** Removes what someone said and where their interview stood, and notes why. */
  #forget(person: string, now: string, what: string): void {
    this.#db.delete(interviews).where(eq(interviews.person, person)).run();
    this.#db
      .delete(interviewStates)
      .where(eq(interviewStates.person, person))
      .run();
    this.#noted(person, what, now);
  }

  /**
   * Records what someone did on their link in the onboarding's own log,
   * which only Grasp's staff read: never in the audit log.
   */
  #noted(person: string, what: string, at: string): void {
    this.#db
      .insert(events)
      .values({ at, by: "interviewee", what, about: person })
      .run();
  }

  #noteState(
    state: {
      person: string;
      kind: "own" | "lead";
      startedAt: string | null;
      completedAt: string | null;
    },
    updatedAt: string = new Date().toISOString()
  ): void {
    this.#db
      .insert(interviewStates)
      .values({ ...state, updatedAt })
      .onConflictDoUpdate({
        target: interviewStates.person,
        set: {
          kind: state.kind,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          updatedAt,
        },
      })
      .run();
    // Their agreement counts once ever, in the team they were asked in.
    const [asked] = this.#db
      .select()
      .from(countedPeople)
      .where(eq(countedPeople.person, state.person))
      .all();
    const { completedAt } = state;
    if (asked !== undefined && !asked.talked && completedAt !== null) {
      this.#db
        .update(countedPeople)
        .set({ talked: true })
        .where(eq(countedPeople.person, state.person))
        .run();
      this.#count(asked.team, completedAt, { talked: 1 });
    }
  }

  #row(): {
    plan: Plan | null;
    agreements: Agreements | null;
    pausedAt: string | null;
  } {
    const [row] = this.#db
      .select()
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const plan = row?.plan ?? null;
    const agreements = row?.agreements ?? null;
    return {
      plan: plan === null ? null : planSchema.parse(JSON.parse(plan)),
      agreements:
        agreements === null
          ? null
          : agreementsSchema.parse(JSON.parse(agreements)),
      pausedAt: row?.pausedAt ?? null,
    };
  }

  #roster(): Roster | null {
    const teamRows = this.#db
      .select()
      .from(teams)
      .orderBy(asc(teams.position))
      .all();
    if (teamRows.length === 0) {
      return null;
    }
    return {
      teams: teamRows.map(({ id, name, lead, does, off }) => ({
        id,
        name,
        lead,
        does,
        off,
      })),
      people: this.#db
        .select()
        .from(people)
        .orderBy(asc(people.position))
        .all()
        .map(({ id, name, email, team, title, away }) => ({
          id,
          name,
          email,
          team,
          title,
          away,
        })),
    };
  }

  /** Adds to a team's tally for the day `at` falls on. */
  #count(
    team: string,
    at: string,
    add: { asked?: number; talked?: number }
  ): void {
    const asked = add.asked ?? 0;
    const talked = add.talked ?? 0;
    this.#db
      .insert(teamCounts)
      .values({ team, day: at.slice(0, 10), asked, talked })
      .onConflictDoUpdate({
        target: [teamCounts.team, teamCounts.day],
        set: {
          asked: sql`${teamCounts.asked} + ${asked}`,
          talked: sql`${teamCounts.talked} + ${talked}`,
        },
      })
      .run();
  }

  #counts(): TeamCount[] {
    return this.#db.select().from(teamCounts).all();
  }

  #interviews(): Map<string, InterviewState> {
    return new Map(
      this.#db
        .select()
        .from(interviewStates)
        .all()
        .map(({ person, startedAt, completedAt }) => [
          person,
          { person, startedAt, completedAt },
        ])
    );
  }

  /**
   * Records a change in the log and stores its audit event in the outbox:
   * call it in the change's transaction, so both are kept or neither, then
   * `#deliverAudit`.
   */
  #changed(
    by: AuditActor,
    action: string,
    detail: Record<string, AuditDetailValue>
  ): void {
    const at = new Date().toISOString();
    this.#db
      .insert(events)
      .values({ at, by: whoIs(by), what: action })
      .run();
    const event = createAuditEvent(
      { actor: by, action, target, detail },
      "core"
    );
    this.#db
      .insert(auditOutbox)
      .values({
        id: event.id,
        event: JSON.stringify(event),
        createdAt: new Date(),
      })
      .run();
  }

  /** Delivers the outbox's events now, in the background; the alarm retries what is left. */
  #deliverAudit(): void {
    this.ctx.waitUntil(this.#drainAudit());
  }

  async #drainAudit(): Promise<void> {
    const left = await drainObjectOutbox(this.env, this.ctx.storage.sql);
    if (left === 0) {
      this.#auditRetryMs = auditRetryMs.first;
      return;
    }
    const retryMs = this.#auditRetryMs;
    this.#auditRetryMs = Math.min(retryMs * 2, auditRetryMs.most);
    await this.#alarmBy(Date.now() + retryMs);
  }
}
