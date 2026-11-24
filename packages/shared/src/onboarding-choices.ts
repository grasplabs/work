import { z } from "zod";

// What the company's admin chose in the onboarding about what Grasp may
// connect (core's onboarding store keeps it): where the documents live,
// whether Pulse goes on the work laptops, and which HR platform they use.
// Grasp connects what it can through Integrations; the rest is noted, for
// Grasp to set up with them. Each choice counts in how much Grasp knows
// (core's onboarding/gate.ts). From the prototype's `ClientRecord`.

/** The places where a company's documents live, as the onboarding offers them. */
export const documentSourceIds = [
  "sharepoint",
  "onedrive",
  "teams",
  "drive",
  "confluence",
  "notion",
] as const;
export const documentSourceIdSchema = z.enum(documentSourceIds);
export type DocumentSourceId = z.infer<typeof documentSourceIdSchema>;

/** The HR platforms the onboarding offers by name. */
export const hrPlatforms = ["Personio", "AFAS", "HiBob", "Nmbrs"] as const;
export const hrPlatformSchema = z.enum(hrPlatforms);
export type HrPlatform = z.infer<typeof hrPlatformSchema>;

/** The most places the admin can ask for by name. */
export const sourcesWantedMax = 10;

/** A place or platform Grasp can't connect to yet, as the admin typed it. */
const wantedSchema = z.string().trim().min(1).max(60);

/**
 * The HR platform: one of those offered, one asked for by name, or none.
 * Meanwhile the leads come from the organization the admin confirms.
 */
export const hrChoiceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("platform"), name: hrPlatformSchema }),
  z.strictObject({ kind: z.literal("asked"), name: wantedSchema }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type HrChoice = z.infer<typeof hrChoiceSchema>;

export const setupChoicesSchema = z.strictObject({
  /** The places where documents live, noted or connected, each once. */
  sources: z
    .array(documentSourceIdSchema)
    .max(documentSourceIds.length)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "A place is named twice",
    }),
  /** Places Grasp can't connect to yet, asked for by name. */
  sourcesWanted: z.array(wantedSchema).max(sourcesWantedMax),
  /** Pulse: set up with Grasp, or skipped; null before either. */
  pulse: z.enum(["wanted", "skipped"]).nullable(),
  /** Null before the admin said. */
  hr: hrChoiceSchema.nullable(),
});
export type SetupChoices = z.output<typeof setupChoicesSchema>;
export type SetupChoicesInput = z.input<typeof setupChoicesSchema>;

/** Before the admin chose anything. */
export const noChoices: SetupChoices = {
  sources: [],
  sourcesWanted: [],
  pulse: null,
  hr: null,
};

/** The admin's choices over `/rpc`. */
export interface OnboardingChoicesApi {
  choices: () => Promise<SetupChoices>;
  /** Replaces what the admin chose. */
  saveChoices: (choices: SetupChoicesInput) => Promise<SetupChoices>;
}
