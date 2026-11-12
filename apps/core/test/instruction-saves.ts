import type {
  InstructionFileRef,
  InstructionsApi,
} from "@grasp-os/shared/instruction-files";
import { env } from "cloudflare:workers";

// Instruction files as the tests write them: through the session, as a
// page does, from the version the page would have read; and agents the
// company has, whose files an admin may write.

/**
 * Saves `text` as `file`'s next version through `api`, from its version
 * now, as an editor that just read it. Returns the version saved.
 */
export const saveInstructions = async (
  api: { instructions: InstructionsApi },
  file: InstructionFileRef,
  text: string
): Promise<number> => {
  const now = await api.instructions.read(file);
  const { version } = await api.instructions.save({
    file,
    change: crypto.randomUUID(),
    text,
    after: now?.version ?? 0,
  });
  return version;
};

/**
 * Keeps an agent of the company's under `id`, as an admin's making one
 * does (agent-builder.ts), with no reach or tools: for tests whose
 * subject is its instruction file. Returns `id`.
 */
export const keptAgent = async (id = `agent-${crypto.randomUUID()}`) => {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO agents (id, name, name_key, face, job, instructions, model_role, model, state, made_by, made_at, changed_by, changed_at) VALUES (?, ?, ?, 'stephen', 'Tests.', '', NULL, NULL, 'on', 'test', ?, 'test', ?)"
  )
    .bind(id, `Agent ${id}`, `agent ${id}`.toLowerCase(), now, now)
    .run();
  return id;
};
