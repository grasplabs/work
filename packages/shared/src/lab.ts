import { z } from "zod";

import { modelRoles } from "./deployment-config.ts";
import { interviewTurnRequestSchema } from "./interview-turn.ts";
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

/** The longest name, team, lead or work a turn is given. */
const nameMax = 200;

/**
 * Who one of Stephen's turns is with, as the store would tell him
 * (core's TurnContext): the benches give it with their fixed input, so a
 * turn needs no link. Always someone's own interview, not a lead's.
 */
export const labWhoSchema = z.strictObject({
  company: z.string().max(nameMax),
  name: z.string().max(nameMax),
  team: z.string().max(nameMax),
  lead: z.string().max(nameMax).nullable(),
  /** The piece of work he learns about; empty when the team's map named none. */
  work: z.string().max(nameMax),
  /** What Stephen knows beforehand. */
  known: z.string().max(inputMax),
});
export type LabWho = z.output<typeof labWhoSchema>;

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
  /**
   * One of Stephen's turns on fixed input, with who it is with given: the
   * same turn a link gets, as the same events.
   */
  z.strictObject({
    action: z.literal("turn"),
    who: labWhoSchema,
    turn: interviewTurnRequestSchema.omit({ secret: true, key: true }),
  }),
  /** Who someone on the roster is, as a turn of theirs would know it. */
  z.strictObject({
    action: z.literal("context"),
    person: z.string().max(nameMax),
  }),
  /** Every piece of work drawn again from what its people agreed to, kept nowhere. */
  z.strictObject({ action: z.literal("draw") }),
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

/** Who someone is, as a turn of theirs would know it; null when they aren't on the roster. */
export const labContextSchema = z.strictObject({
  who: labWhoSchema.nullable(),
});
export type LabContext = z.output<typeof labContextSchema>;

/** Every piece of work, drawn again: as core's drawing keeps it, read by the lab as far as it needs. */
export const labDrawingsSchema = z.strictObject({
  drawings: z.array(
    z.strictObject({ work: z.string(), name: z.string(), drawn: z.json() })
  ),
});
export type LabDrawings = z.output<typeof labDrawingsSchema>;
