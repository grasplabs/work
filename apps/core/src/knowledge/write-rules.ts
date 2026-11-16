import { knowledgeErrors } from "@grasp-os/shared/knowledge";

/**
 * Knowledge's `onWrite` port (ports.ts): refuses what core never lets be
 * saved, whoever saves it. The Grasp skills are the release's: no save
 * or restore changes them, an admin's neither, but their sync (`sync`).
 */
export const checkWrite = ({
  collection,
  sync,
}: {
  collection: { id: string; owner: string; source: string };
  path: string;
  text: string;
  sync: boolean;
}): void => {
  if (collection.source === "grasp" && !sync) {
    throw knowledgeErrors.create("knowledge.read_only");
  }
};
