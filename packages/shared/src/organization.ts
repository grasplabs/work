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
  /**
   * Where its logo is shown from (`organizationLogoPath`), to signed-in
   * members only; null while it has none, and its initials stand in.
   */
  logo: string | null;
}

/**
 * The image types a logo may be, told by its first bytes, never by a name
 * or a type anyone gives. No SVG: it can carry script.
 */
export const organizationLogoTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type OrganizationLogoType = (typeof organizationLogoTypes)[number];

/** The largest logo core takes, in bytes: a mark in a sidebar, not a photograph. */
export const organizationLogoMaxBytes = 512 * 1024;

/**
 * The most pixels a logo may be on either side: every member's browser
 * decodes it on every page, and a small file can declare a huge image.
 */
export const organizationLogoMaxPixels = 4096;

/** The path every logo is served under (`organizationLogoPath`). */
export const organizationLogoPrefix = "/api/organization/logo/";

/**
 * Where the logo whose content hashes to `hash` (SHA-256, in hex) is
 * served from. A new logo is a new address, so a browser may keep each
 * one for good.
 */
export const organizationLogoPath = (hash: string): string =>
  `${organizationLogoPrefix}${hash}`;

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
  /**
   * Sets the organization's logo from an image's bytes: a PNG, JPEG or
   * WebP of at most {@link organizationLogoMaxBytes} and
   * {@link organizationLogoMaxPixels} pixels a side, and returns the
   * result. Its own admins only.
   */
  setLogo: (image: Uint8Array) => Promise<Organization>;
  /** Takes the logo away, so the initials stand in again. Its own admins only. */
  removeLogo: () => Promise<Organization>;
  /**
   * The organization's teams, by name, for choosing one (a collection's,
   * a person's); for admins and builders, never Grasp staff.
   */
  teams: () => Promise<{ id: string; name: string }[]>;
}

/** Why a change to the organization was refused. */
export const organizationErrors = defineErrorFamily({
  "organization.name_invalid":
    "Give the organization a name of up to 80 characters, on one line.",
  "organization.time_zone_invalid": "That isn't a time zone Grasp knows.",
  "organization.logo_invalid": "Choose a PNG, JPEG or WebP image.",
  "organization.logo_too_large": "Choose an image of at most 512 KB.",
  "organization.logo_too_wide":
    "Choose an image of at most 4096 by 4096 pixels.",
  "organization.changes_invalid":
    "Say what to change: the name, the time zone or both.",
});
