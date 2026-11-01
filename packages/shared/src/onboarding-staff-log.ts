import { z } from "zod";

// The log's filters, apart from onboarding-staff.ts: the web app checks
// them in its address before the log's page loads, without the rest of
// the onboarding's records.

/** Who did something in the log. */
export const logActors = ["staff", "company", "person", "grasp"] as const;
export type LogActor = (typeof logActors)[number];

/** What the log can be narrowed to. */
export const logFilterSchema = z.strictObject({
  actor: z.enum(logActors).optional(),
  /** The start of what happened: `interview`, `onboarding.links`. */
  what: z
    .string()
    .regex(/^[a-z_.]{1,64}$/u)
    .optional(),
  team: z.string().max(64).optional(),
  /** An ISO day. */
  day: z.iso.date().optional(),
});
export type LogFilter = z.input<typeof logFilterSchema>;
