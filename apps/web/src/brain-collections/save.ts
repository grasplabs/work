import { collectionErrors } from "@grasp-os/shared/brain-documents";
import type {
  DocumentRead,
  DocumentSummary,
  SaveInput,
} from "@grasp-os/shared/brain-documents";

import type { Session } from "../core.ts";

/** A save that went through, or the newer version it would have overwritten. */
export type SaveOutcome = { saved: DocumentSummary } | { newer: DocumentRead };

/**
 * Saves `input` as the document's next version. When someone saved one
 * after the version it was edited from, core saves nothing
 * (`brain.conflict`), and this reads the version that is current now,
 * to show instead. Outside components, as the React Compiler can't
 * compile `try`/`catch` around a value it returns.
 */
export const saveOrNewer = async (
  session: Session,
  documentId: string,
  input: SaveInput
): Promise<SaveOutcome> => {
  try {
    return { saved: await session.brain.saveDocument(input) };
  } catch (error) {
    if (collectionErrors.codeOf(error) !== "brain.conflict") {
      throw error;
    }
  }
  return { newer: await session.brain.getDocument(documentId) };
};
