import type { MemoryPack } from "@grasp-os/brain/contract";
import { recall } from "@grasp-os/brain/recall";
import { search } from "@grasp-os/brain/search";
import { follow, read } from "@grasp-os/brain/tools";
import type {
  FollowResult,
  KnowledgeCatalog,
  KnowledgeRead,
  KnowledgeTools,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { WorkContext } from "../restricted.ts";
import type { Reader } from "./access.ts";
import { readAsDelegate } from "./binding.ts";
import { catalog } from "./catalog.ts";
import { brainOf } from "./ports.ts";

/**
 * Knowledge as an agent holds it, across every collection it may read:
 * `await env.KNOWLEDGE.catalog()`. A loopback entrypoint like a collection
 * stub (binding.ts), acting for the one person in its props, but under all
 * of its permissions to read a collection, read again on each call: one
 * granted later counts from the next call, one revoked stops there. It
 * still reads only what that person may read too (access.ts).
 */
export class KnowledgeBinding
  extends WorkerEntrypoint<Env, { authority: Authority; context: WorkContext }>
  implements KnowledgeTools
{
  async #asDelegate<T>(run: (reader: Reader) => Promise<T>): Promise<T> {
    const { authority, context } = this.ctx.props;
    return await readAsDelegate(this.env, authority, context, undefined, run);
  }

  async catalog(): Promise<KnowledgeCatalog> {
    return await this.#asDelegate(
      async (reader) => await catalog(brainOf(this.env), reader)
    );
  }

  async search(query: unknown, options?: unknown): Promise<SearchResults> {
    return await this.#asDelegate(
      async (reader) => await search(brainOf(this.env), reader, query, options)
    );
  }

  async read(documentId: unknown, options?: unknown): Promise<KnowledgeRead> {
    return await this.#asDelegate(
      async (reader) =>
        await read(brainOf(this.env), reader, documentId, options)
    );
  }

  /** The Brain's recall, across every collection the agent may read. */
  async recall(input: unknown): Promise<MemoryPack> {
    return await this.#asDelegate(
      async (reader) => await recall(brainOf(this.env), reader, input)
    );
  }

  async follow(documentId: unknown): Promise<FollowResult> {
    return await this.#asDelegate(
      async (reader) => await follow(brainOf(this.env), reader, documentId)
    );
  }
}
