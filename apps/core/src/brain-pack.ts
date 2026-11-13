import type { BrainPack } from "@grasp-os/runtime/app";
import { z } from "zod";

/**
 * A pack, as code's recall answers one (`BrainPack`), and nothing more:
 * what the function host lets an App's recall hand back, and what a test
 * run's fixture may answer a workflow's recall with (workflows/
 * brain-calls.ts). Typed against the SDK's own, so neither can drift.
 */
export const brainPackSchema: z.ZodType<BrainPack> = z.strictObject({
  items: z.array(
    z.strictObject({
      source: z.strictObject({
        producer: z.enum(["upload", "chat", "run", "capture"]),
        id: z.string().min(1),
      }),
      version: z.int().positive(),
      position: z.int().nonnegative(),
      text: z.string(),
      whole: z.boolean(),
      found: z.enum(["exact", "words", "stop words", "meaning"]),
    })
  ),
  notFound: z.array(z.string()),
  truncated: z.boolean(),
});
