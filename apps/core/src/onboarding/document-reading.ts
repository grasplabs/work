import { z } from "zod";

// A shared document's reading as the onboarding's store keeps it
// (documents.ts made it): read back with a schema, never trusted as JSON.

export const storedDocumentReadingSchema = z.object({
  about: z.string(),
  tools: z.array(z.string()),
  teams: z.array(z.string()),
  unclear: z.array(z.string()),
  ask: z
    .object({ question: z.string(), options: z.array(z.string()) })
    .nullable(),
});
