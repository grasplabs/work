import type { Collection } from "@grasp-os/shared/knowledge";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

/** What Knowledge's navigation shows, as the page read it. */
export interface KnowledgeNavData {
  collections: Loaded<Collection[]>;
}

/**
 * The collections the person may read. Not sent once the page was
 * `left`: nobody asked for them.
 */
export const loadKnowledgeNav = async (
  core: CoreConnection,
  left: AbortSignal
): Promise<KnowledgeNavData> => {
  const collections = await loadFromCore(
    core,
    async (session) => await session.knowledge.listCollections(),
    left
  );
  return { collections };
};
