import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { isTimeZone } from "./workflows.ts";

/**
 * Where a deployment keeps its data. Every one is created in the EU
 * jurisdiction (R2 `jurisdiction`, Durable Object `jurisdiction("eu")`,
 * D1 location), so it is the one region there is.
 */
export const dataRegionSchema = z.enum(["eu"]);
export type DataRegion = z.infer<typeof dataRegionSchema>;

/** The organization's name: what people call it in Grasp. */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // No control characters or line and paragraph separators: it is shown
  // as one line.
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);

/** An IANA time zone the runtime knows, such as `Europe/Amsterdam`. */
export const organizationTimeZoneSchema = z.string().max(64).refine(isTimeZone);

/** The organization, as everyone in it sees it. */
export interface Organization {
  name: string;
  /** The time zone the organization works in, `UTC` until an admin sets one. */
  timeZone: string;
  /** Where its data lives, from the deployment. */
  dataRegion: DataRegion;
  /** The email domains people sign in with, from the deployment's config. */
  signInDomains: string[];
}

/** What an admin changes; what is left out stays as it is. */
export interface OrganizationChanges {
  name?: string;
  timeZone?: string;
}

/**
 * The organization's own settings, over `/rpc`. Everyone reads them;
 * only the organization's own admins (never Grasp staff) change them.
 */
export interface OrganizationApi {
  get: () => Promise<Organization>;
  /** Changes the name, the time zone or both, and returns the result. */
  update: (changes: OrganizationChanges) => Promise<Organization>;
}

/** Why a change to the organization was refused. */
export const organizationErrors = defineErrorFamily({
  "organization.name_invalid":
    "Give the organization a name of up to 80 characters, on one line.",
  "organization.time_zone_invalid": "That isn't a time zone Grasp knows.",
  "organization.changes_invalid":
    "Say what to change: the name, the time zone or both.",
});
