import { z } from "zod";

import { modelRoles } from "./deployment-config.ts";
import { modelEfforts } from "./models.ts";

// The Stephen Lab's way into a local core (core's onboarding/lab.ts,
// scripts/lab/): the lab plays the people Stephen interviews, and judges
// what he got them to say, with models, and those calls go through core's
// model gateway like every other, never with a provider key of the lab's
// own. It answers on a local stack only (`vp run dev`), and only Grasp's
// staff: a deployed core has no such route.

export const labPath = "/api/lab";

/** The most bytes one request may carry: a whole interview and its notes, for the judge. */
export const labMaxBytes = 512 * 1024;

/** The longest instructions and input of one call, in characters. */
const systemMax = 64 * 1024;
const inputMax = 256 * 1024;
/** The most tokens one answer of the lab's may take. */
export const labAnswerTokensMax = 16_000;

/** A JSON Schema, as plain JSON: core turns it into the schema the answer is checked by. */
export const labJsonSchema = z.record(z.string(), z.json());

/** What the lab asks of core. */
export const labRequestSchema = z.discriminatedUnion("action", [
  /** One model call through the gateway, by the model of `role`. */
  z.strictObject({
    action: z.literal("ask"),
    role: z.enum(modelRoles),
    system: z.string().max(systemMax),
    input: z.string().min(1).max(inputMax),
    schema: labJsonSchema,
    maxTokens: z.int().positive().max(labAnswerTokensMax),
    effort: z.enum(modelEfforts).optional(),
  }),
  /** Everyone's interview link, as the onboarding would send it. */
  z.strictObject({ action: z.literal("links") }),
  /** How the models are reached: the gateway, and the model of each role. */
  z.strictObject({ action: z.literal("via") }),
]);
export type LabRequest = z.output<typeof labRequestSchema>;

/** How a local core reaches its models: its AI Gateway, and the model each role goes to. */
export const labViaSchema = z.strictObject({
  gateway: z.string(),
  quick: z.string().nullable(),
  careful: z.string().nullable(),
});
export type LabVia = z.output<typeof labViaSchema>;

/** What one call answered. */
export const labAnswerSchema = z.strictObject({
  output: z.json(),
  model: z.string(),
  usage: z.strictObject({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  /** In US dollars, at the provider's list prices. */
  cost: z.number(),
});
export type LabAnswer = z.output<typeof labAnswerSchema>;

/** Someone's link: the interview page with its secret after the `#`. */
export const labLinksSchema = z.strictObject({
  links: z.array(z.strictObject({ person: z.string(), link: z.string() })),
});
export type LabLinks = z.output<typeof labLinksSchema>;
