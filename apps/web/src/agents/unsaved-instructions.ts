import { failureText } from "@grasp-os/shared/errors";
import type {
  InstructionFileText,
  InstructionsApi,
} from "@grasp-os/shared/instruction-files";

import type { Session } from "../core.ts";
import { workOutQuietly } from "./agent-apps-card.tsx";

// Instructions typed for a new agent that couldn't be saved once the
// agent was made (manual-agent.tsx, new-agent.tsx), handed to the agent's page, which opens
// on Instructions with them as the editor's unsaved draft and why they
// weren't saved, so nothing typed is dropped. In this tab's memory alone,
// until the page's route takes them, which it does only along with the
// file it read for the editor (`agentInstructionsFor`): while the file
// can't be read, the editor isn't shown, and they wait for a read that
// shows them.

/** What was typed, the change its save was tried under, and why it failed. */
export interface UnsavedInstructions {
  text: string;
  change: string;
  failure: string;
}

const kept = new Map<string, UnsavedInstructions>();

/** Keeps `unsaved` for the agent `agentId`'s page. */
const keepUnsaved = (agentId: string, unsaved: UnsavedInstructions): void => {
  kept.set(agentId, unsaved);
};

/** What was kept for the agent `agentId`'s page, once: taken, it is gone. */
const takeUnsaved = (agentId: string): UnsavedInstructions | undefined => {
  const found = kept.get(agentId);
  kept.delete(agentId);
  return found;
};

/**
 * Saves `instructions` as the new agent `agentId`'s instruction file, and
 * then works out the apps they call for: whether they were saved. Not
 * saved, they are kept for its page with why (`keepUnsaved`).
 */
export const saveFirstInstructions = async (
  session: Session,
  agentId: string,
  instructions: string
): Promise<boolean> => {
  const change = crypto.randomUUID();
  try {
    await session.instructions.save({
      file: { scope: "agent", agentId },
      change,
      text: instructions,
      after: 0,
    });
  } catch (error) {
    keepUnsaved(agentId, {
      text: instructions,
      change,
      failure: failureText(error),
    });
    return false;
  }
  await workOutQuietly(session, agentId);
  return true;
};

/**
 * The agent `agentId`'s instruction file for its page's editor, and what
 * its New agent page couldn't save, taken only along with the file: the
 * file undefined where it isn't the person's to read (`readable` false)
 * or can't be read now, and what was typed then left waiting for the
 * next read, never dropped behind an editor that isn't shown.
 */
export const agentInstructionsFor = async (
  session: { instructions: Pick<InstructionsApi, "read"> },
  agentId: string,
  readable: boolean
): Promise<{
  instructions: InstructionFileText | null | undefined;
  unsaved: UnsavedInstructions | undefined;
}> => {
  if (!readable) {
    return { instructions: undefined, unsaved: undefined };
  }
  let instructions: InstructionFileText | null;
  try {
    instructions = await session.instructions.read({
      scope: "agent",
      agentId,
    });
  } catch {
    return { instructions: undefined, unsaved: undefined };
  }
  return { instructions, unsaved: takeUnsaved(agentId) };
};
