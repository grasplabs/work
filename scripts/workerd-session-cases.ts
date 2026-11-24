/**
 * How the session tests (workerd-sandbox-session*.test.ts) run a case of
 * the stand-in core (apps/core/test/workerd/session-worker.ts), and what
 * it answers.
 */
import { z } from "zod";

export const outcomeSchema = z.object({
  status: z.enum(["ok", "refused", "unavailable"]),
  value: z.unknown().optional(),
  message: z.string().optional(),
  ms: z.number(),
  reachedAfter: z.number(),
  reachedInternal: z.number(),
  reachedAfterGivingUp: z.number(),
  pinged: z.number(),
  nestedRan: z.number(),
  nestedRefused: z.number(),
  refusedVerdict: z.string().nullable(),
  verdict: z.string().nullable().optional(),
  /** The status the sandbox host refused with, as core's error carries it. */
  refusedStatus: z.number().nullable().optional(),
  logged: z.array(z.unknown()),
});

/**
 * Runs case `name` as `owner` on the stand-in core at `url` (the one
 * `coreUrl` answers unless said), a child of `parent` if given.
 */
export const runIn =
  (coreUrl: () => string) =>
  async (
    name: string,
    owner = "app-stand-in",
    url = coreUrl(),
    parent?: string
  ) => {
    const response = await fetch(
      `${url}run?case=${name}&owner=${owner}${parent === undefined ? "" : `&parent=${parent}`}`
    );
    return outcomeSchema.parse(await response.json());
  };
