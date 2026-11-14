import type {
  InstructionFileRef,
  InstructionsApi,
} from "@grasp-os/shared/instruction-files";
import { env } from "cloudflare:workers";

import {
  addInstructionFile,
  readInstructionFilesAs,
} from "../src/brain-next.ts";
import type { InstructionFile } from "../src/brain-next.ts";

// Instruction files as the tests write them: through the session, as a
// page does, from the version the page would have read; straight to the
// Brain, over the version it has; and agents the company has, whose files
// an admin may write.

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

/**
 * Adds `text` as the next version of the company's or an agent's file
 * `file` straight to the Brain, with no check of who writes, over the
 * version it has now (other tests of the file may have written it).
 */
export const addedSharedFile = async (
  file: Extract<InstructionFile, { scope: "company" | "agent" }>,
  text: string
) => {
  const [now] = await readInstructionFilesAs(env, { userId: "reader" }, [file]);
  return await addInstructionFile(env, {
    file,
    change: crypto.randomUUID(),
    text,
    after: now?.version ?? 0,
  });
};
