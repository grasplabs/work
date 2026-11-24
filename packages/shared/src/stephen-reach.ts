import { z } from "zod";

import { toolClassTeamsMax } from "./connect.ts";
import type { CompanyToolClass, ToolClassAudience } from "./connect.ts";
import { identifierSchema } from "./ids.ts";

// Settings › Stephen: who can reach the company's assistant in its chat
// apps (Teams first), what each place lets him do, and how each app
// narrows the classes of tools the company turned on (connect.ts). Not
// the onboarding interviewer, who is also called Stephen
// (`StephenSetup`): this is the assistant people chat with. A place or an
// app only ever narrows what is set above it, never widens it.

const nobody = z.strictObject({ who: z.literal("nobody") });
const everyone = z.strictObject({ who: z.literal("everyone") });
const someTeams = z.strictObject({
  who: z.literal("teams"),
  teams: z.array(identifierSchema).min(1).max(toolClassTeamsMax),
});

/**
 * Who a place lets reach Stephen: as for Stephen as a whole
 * (`asStephen`), or fewer: nobody, or the people in some teams who may
 * reach him at all. `everyone` there is everyone Stephen reaches.
 */
export const placeAudienceSchema = z.discriminatedUnion("who", [
  z.strictObject({ who: z.literal("asStephen") }),
  nobody,
  everyone,
  someTeams,
]);
export type PlaceAudience = z.infer<typeof placeAudienceSchema>;

/**
 * For whom an app has a class on: as the company has the class
 * (`asClass`), or fewer: nobody, or the people in some teams it is on for.
 */
export const appClassAudienceSchema = z.discriminatedUnion("who", [
  z.strictObject({ who: z.literal("asClass") }),
  nobody,
  everyone,
  someTeams,
]);
export type AppClassAudience = z.infer<typeof appClassAudienceSchema>;

/**
 * The places Settings › Stephen always shows, set or not. A place is a
 * chat platform, by its Chat SDK adapter's name (`chatPlatformSchema`).
 */
export const stephenPlaces = ["teams"] as const;

/** A native app, by its connector's provider (`microsoft`). */
export const stephenAppSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

/** One place, as the company has it now. */
export interface StephenPlaceSetting {
  place: string;
  audience: PlaceAudience;
  /** Whether he does things for people here, or only answers. */
  acts: boolean;
  /** The admin who last changed it; `null` while it is the default. */
  changedBy: string | null;
  /** ISO 8601; `null` while it is the default. */
  changedAt: string | null;
}

/** One class of one app, as the company has it now. */
export interface StephenAppClassSetting {
  toolClass: CompanyToolClass;
  audience: AppClassAudience;
  changedBy: string | null;
  changedAt: string | null;
}

/** An app Stephen can act in, with each class its tools have. */
export interface StephenAppSetting {
  app: string;
  classes: StephenAppClassSetting[];
}

/** Settings › Stephen, as the company has it now. */
export interface StephenReach {
  /** Off, he answers nobody in any chat app; Grasp's own chat keeps working. */
  on: boolean;
  /** Who may reach him at all. */
  audience: ToolClassAudience;
  changedBy: string | null;
  changedAt: string | null;
  places: StephenPlaceSetting[];
  apps: StephenAppSetting[];
  /** The company's teams, by name: what an audience may name. */
  teams: { teamId: string; name: string }[];
}

/** What Stephen does for one person in one place, as the door asks it. */
export interface StephenFor {
  /** Whether he answers them there at all. */
  reaches: boolean;
  /** Whether he does things for them there, or only answers. */
  acts: boolean;
}

/** Settings › Stephen over `/rpc`, on `connections`: admins only, never Grasp staff for changes; every change audited. */
export interface StephenReachApi {
  stephenReach: () => Promise<StephenReach>;
  /** Turns him on or off in every chat app, and says who may reach him. */
  setStephenReach: (on: boolean, audience: ToolClassAudience) => Promise<void>;
  /** Narrows who reaches him in one place, and whether he acts there. */
  setStephenPlace: (
    place: string,
    audience: PlaceAudience,
    acts: boolean
  ) => Promise<void>;
  /** Narrows for whom one app has one class on. */
  setAppToolClass: (
    app: string,
    toolClass: CompanyToolClass,
    audience: AppClassAudience
  ) => Promise<void>;
}
