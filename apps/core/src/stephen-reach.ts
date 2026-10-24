import { actorOf } from "@grasp-os/shared/audit";
import { chatPlatformSchema } from "@grasp-os/shared/chat";
import {
  companyToolClassSchema,
  connectionErrors,
  toolClassAudienceSchema,
} from "@grasp-os/shared/connect";
import type { ToolClassAudience } from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  appClassAudienceSchema,
  placeAudienceSchema,
  stephenAppSchema,
  stephenPlaces as alwaysShown,
} from "@grasp-os/shared/stephen-reach";
import type {
  AppClassAudience,
  PlaceAudience,
  StephenAppSetting,
  StephenFor,
  StephenPlaceSetting,
  StephenReach,
} from "@grasp-os/shared/stephen-reach";
import { eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  appToolClasses,
  stephenPlaces,
  stephenReach,
  teams,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import {
  audienceOf,
  nativeClasses,
  off,
  storedOf,
  storedTeamsSchema,
  takesIn,
} from "./tool-classes.ts";

// Settings › Stephen (GRA-727): the one place that says who can reach the
// company's assistant in its chat apps and what he may do for whom. Not
// the onboarding interviewer, also called Stephen: this is the assistant
// people chat with in Teams and the other chat apps.
//
// Three layers, each only narrowing the one above it:
// - Stephen as a whole: on or off in every chat app, and who may reach
//   him (nobody, everyone, or some teams).
// - Each place (a chat platform, by its adapter's name): who reaches him
//   there, as for Stephen or fewer, and whether he does things there or
//   only answers.
// - Each app (a native connector's provider): for whom each class of its
//   tools is on, as the company has the class (tool-classes.ts) or fewer.
//   The class gate reads it on every call (`requireToolClassOn`).
//
// The chat door asks `stephenFor` on every message, before it reads it,
// so a change holds from the next message on. Admins change it, never
// Grasp staff, and every change is audited; one that changes nothing
// records nothing. The ways it can fail, which the tests start from: a
// place or an app reaching more people than Stephen or the class; someone
// outside the audience reaching him; a change left unaudited or made by
// someone who isn't the company's own admin.

/** The one row Stephen as a whole has. */
const stephenId = "stephen";

/** Stephen as a whole until an admin changes him: on, for everyone. */
const defaultReach = { on: true, audience: { who: "everyone" } } as const;

/** A place until an admin changes it: as for Stephen, and he acts there. */
const defaultPlace = { audience: { who: "asStephen" }, acts: true } as const;

/** An app's class until an admin changes it: as the class is. */
const asClass: AppClassAudience = { who: "asClass" };

/** A stored place or app class audience, or off when it can't be read. */
const narrowingOf = <Kept extends string>(
  row: { who: string; teams: string },
  kept: Kept
): ToolClassAudience | { who: Kept } =>
  row.who === kept ? { who: kept } : (audienceOf(row) ?? off);

/** Refuses a change by anyone but the company's own admins. */
const requireCompanyAdmin = (identity: Identity): void => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

/** Refuses teams the company doesn't have. */
const requireKnownTeams = async (env: Env, stored: string): Promise<void> => {
  const teamIds = storedTeamsSchema.parse(JSON.parse(stored));
  if (teamIds.length === 0) {
    return;
  }
  const known = await drizzle(env.DB)
    .select({ id: teams.id })
    .from(teams)
    .where(inList(teams.id, teamIds));
  if (known.length !== teamIds.length) {
    throw connectionErrors.create("connection.invalid");
  }
};

/** An audience as stored, `kept` (`asStephen`, `asClass`) as it is. */
const storedNarrowing = (
  audience: ToolClassAudience | { who: string }
): { who: string; teams: string } => {
  const parsed = toolClassAudienceSchema.safeParse(audience);
  return parsed.success
    ? storedOf(parsed.data)
    : { who: audience.who, teams: "[]" };
};

/** Each change's teams, as an audit event's flat detail. */
const teamsDetail = (stored: string): Record<string, string> =>
  Object.fromEntries(
    storedTeamsSchema
      .parse(JSON.parse(stored))
      .map((team, index) => [`team${index + 1}`, team])
  );

/** Settings › Stephen as the company has it now, for admins to read. */
export const readStephenReach = async (env: Env): Promise<StephenReach> => {
  const db = drizzle(env.DB);
  const [whole, places, apps] = await Promise.all([
    db.select().from(stephenReach).where(eq(stephenReach.id, stephenId)).get(),
    db.select().from(stephenPlaces),
    db.select().from(appToolClasses),
  ]);
  const storedPlaces = new Map(places.map((row) => [row.place, row]));
  const placeNames = [
    ...new Set([...alwaysShown, ...storedPlaces.keys()]),
  ].toSorted();
  const storedApps = new Map(
    apps.map((row) => [`${row.app}/${row.toolClass}`, row])
  );
  return {
    on: whole?.on ?? defaultReach.on,
    audience:
      whole === undefined ? defaultReach.audience : (audienceOf(whole) ?? off),
    changedBy: whole?.changedBy ?? null,
    changedAt: whole?.changedAt.toISOString() ?? null,
    places: placeNames.map((place): StephenPlaceSetting => {
      const row = storedPlaces.get(place);
      return row === undefined
        ? { place, ...defaultPlace, changedBy: null, changedAt: null }
        : {
            place,
            audience: narrowingOf(row, "asStephen"),
            acts: row.acts,
            changedBy: row.changedBy,
            changedAt: row.changedAt.toISOString(),
          };
    }),
    apps: [...nativeClasses.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([app, tools]): StephenAppSetting => {
        const classes = companyToolClassSchema.options.filter((toolClass) =>
          [...tools.values()].includes(toolClass)
        );
        return {
          app,
          classes: classes.map((toolClass) => {
            const row = storedApps.get(`${app}/${toolClass}`);
            return row === undefined
              ? {
                  toolClass,
                  audience: asClass,
                  changedBy: null,
                  changedAt: null,
                }
              : {
                  toolClass,
                  audience: narrowingOf(row, "asClass"),
                  changedBy: row.changedBy,
                  changedAt: row.changedAt.toISOString(),
                };
          }),
        };
      }),
  };
};

/**
 * Turns Stephen on or off in every chat app, and says who may reach him.
 * Throws `connection.invalid` for an audience that isn't one, or a team
 * the company doesn't have.
 */
export const setStephenReach = async (
  env: Env,
  identity: Identity,
  on: unknown,
  audience: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const parsed = toolClassAudienceSchema.safeParse(audience);
  if (!(typeof on === "boolean" && parsed.success)) {
    throw connectionErrors.create("connection.invalid");
  }
  const stored = storedOf(parsed.data);
  await requireKnownTeams(env, stored.teams);
  const now = new Date();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(stephenReach)
      .values({
        id: stephenId,
        on,
        ...stored,
        changedBy: identity.userId,
        changedAt: now,
      })
      .onConflictDoUpdate({
        target: stephenReach.id,
        set: { on, ...stored, changedBy: identity.userId, changedAt: now },
        setWhere: or(
          sql`${stephenReach.on} IS NOT ${on}`,
          sql`${stephenReach.who} IS NOT ${stored.who}`,
          sql`${stephenReach.teams} IS NOT ${stored.teams}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "stephen.reach.changed",
      target: { type: "stephen", id: stephenId },
      detail: {
        on: String(on),
        who: stored.who,
        ...teamsDetail(stored.teams),
      },
    }),
  ]);
};

/**
 * Narrows who reaches Stephen in `place`, and says whether he acts there.
 * Throws `connection.invalid` for a place, audience or team that isn't
 * one.
 */
export const setStephenPlace = async (
  env: Env,
  identity: Identity,
  place: unknown,
  audience: unknown,
  acts: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const parsedPlace = chatPlatformSchema.safeParse(place);
  const parsedAudience = placeAudienceSchema.safeParse(audience);
  if (
    !(
      parsedPlace.success &&
      parsedAudience.success &&
      typeof acts === "boolean"
    )
  ) {
    throw connectionErrors.create("connection.invalid");
  }
  const stored = storedNarrowing(parsedAudience.data);
  await requireKnownTeams(env, stored.teams);
  const { who } = parsedAudience.data;
  const now = new Date();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(stephenPlaces)
      .values({
        place: parsedPlace.data,
        who,
        teams: stored.teams,
        acts,
        changedBy: identity.userId,
        changedAt: now,
      })
      .onConflictDoUpdate({
        target: stephenPlaces.place,
        set: {
          who,
          teams: stored.teams,
          acts,
          changedBy: identity.userId,
          changedAt: now,
        },
        setWhere: or(
          sql`${stephenPlaces.who} IS NOT ${who}`,
          sql`${stephenPlaces.teams} IS NOT ${stored.teams}`,
          sql`${stephenPlaces.acts} IS NOT ${acts}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "stephen.place.changed",
      target: { type: "stephen_place", id: parsedPlace.data },
      detail: {
        place: parsedPlace.data,
        who,
        acts: String(acts),
        ...teamsDetail(stored.teams),
      },
    }),
  ]);
};

/**
 * Narrows for whom `app` has `toolClass` on. Throws `connection.invalid`
 * for an app Grasp has no native connector for, a class none of its tools
 * has, an audience that isn't one, or a team the company doesn't have.
 */
export const setAppToolClass = async (
  env: Env,
  identity: Identity,
  app: unknown,
  toolClass: unknown,
  audience: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const parsedApp = stephenAppSchema.safeParse(app);
  const parsedClass = companyToolClassSchema.safeParse(toolClass);
  const parsedAudience = appClassAudienceSchema.safeParse(audience);
  const tools = parsedApp.success
    ? nativeClasses.get(parsedApp.data)
    : undefined;
  if (
    !(parsedClass.success && parsedAudience.success) ||
    tools === undefined ||
    ![...tools.values()].includes(parsedClass.data)
  ) {
    throw connectionErrors.create("connection.invalid");
  }
  const stored = storedNarrowing(parsedAudience.data);
  await requireKnownTeams(env, stored.teams);
  const { who } = parsedAudience.data;
  const appName = parsedApp.data ?? "";
  const now = new Date();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(appToolClasses)
      .values({
        app: appName,
        toolClass: parsedClass.data,
        who,
        teams: stored.teams,
        changedBy: identity.userId,
        changedAt: now,
      })
      .onConflictDoUpdate({
        target: [appToolClasses.app, appToolClasses.toolClass],
        set: {
          who,
          teams: stored.teams,
          changedBy: identity.userId,
          changedAt: now,
        },
        setWhere: or(
          sql`${appToolClasses.who} IS NOT ${who}`,
          sql`${appToolClasses.teams} IS NOT ${stored.teams}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "connection.app_class.changed",
      target: { type: "tool_class", id: `${appName}/${parsedClass.data}` },
      detail: {
        app: appName,
        toolClass: parsedClass.data,
        who,
        ...teamsDetail(stored.teams),
      },
    }),
  ]);
};

/**
 * What Stephen does for `userId` in `place`, as Settings › Stephen has it
 * now: for the chat door to ask on every message, before it reads it. He
 * reaches them only while he is on, they are in his audience and in the
 * place's; he acts for them only where the place lets him.
 */
export const stephenFor = async (
  env: Env,
  userId: string,
  place: string
): Promise<StephenFor> => {
  const db = drizzle(env.DB);
  const [whole, row] = await Promise.all([
    db.select().from(stephenReach).where(eq(stephenReach.id, stephenId)).get(),
    db.select().from(stephenPlaces).where(eq(stephenPlaces.place, place)).get(),
  ]);
  const on = whole?.on ?? defaultReach.on;
  const audience: ToolClassAudience =
    whole === undefined ? defaultReach.audience : (audienceOf(whole) ?? off);
  const placeAudience: PlaceAudience =
    row === undefined ? defaultPlace.audience : narrowingOf(row, "asStephen");
  const reaches =
    on &&
    (await takesIn(env, audience, userId)) &&
    (placeAudience.who === "asStephen" ||
      (await takesIn(env, placeAudience, userId)));
  return { reaches, acts: reaches && (row?.acts ?? defaultPlace.acts) };
};
