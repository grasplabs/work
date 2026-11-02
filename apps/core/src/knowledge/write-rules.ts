import { knowledgeErrors } from "@grasp-os/shared/knowledge";

import { memoryFileOf, requireWithinLimit } from "./memory-files.ts";

/**
 * Knowledge's `onWrite` port (ports.ts): refuses what core never lets be
 * saved, whoever saves it. The Grasp skills are the release's
 * (grasp-skills.ts): no save, restore or purge changes them, an admin's
 * neither, but their sync (`sync`); the next sync would only put the
 * release's text back. A memory file stays within its size limit.
 */
export const checkWrite = async ({
  collection,
  path,
  text,
  sync,
}: {
  collection: { id: string; owner: string; source: string };
  path: string;
  text: string;
  sync: boolean;
}): Promise<void> => {
  if (collection.source === "grasp" && !sync) {
    throw knowledgeErrors.create("knowledge.read_only");
  }
  const memoryFile = await memoryFileOf(collection, path);
  if (memoryFile !== undefined) {
    requireWithinLimit(memoryFile, text);
  }
};
