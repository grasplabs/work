import { search } from "@grasp-os/brain/search";
import { follow, read } from "@grasp-os/brain/tools";
import type {
  FollowResult,
  BrainCatalog,
  BrainRead,
  BrainTools,
  SearchResults,
} from "@grasp-os/shared/brain-documents";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { WorkContext } from "../restricted.ts";
import type { Reader } from "./access.ts";
import { readAsDelegate } from "./binding.ts";
import { catalog } from "./catalog.ts";
import { brainOf } from "./ports.ts";

/**
 * Brain as an agent holds it, across every collection it may read:
 * `await env.BRAIN_DB.catalog()`. A loopback entrypoint like a collection
 * stub (binding.ts), acting for the one person in its props, but under all
 * of its permissions to read a collection, read again on each call: one
 * granted later counts from the next call, one revoked stops there. It
 * still reads only what that person may read too (access.ts).
 */
export class BrainCollectionBinding
  extends WorkerEntrypoint<Env, { authority: Authority; context: WorkContext }>
  implements BrainTools
{
  async #asDelegate<T>(run: (reader: Reader) => Promise<T>): Promise<T> {
    const { authority, context } = this.ctx.props;
    return await readAsDelegate(this.env, authority, context, undefined, run);
  }

  async catalog(): Promise<BrainCatalog> {
    return await this.#asDelegate(
      async (reader) => await catalog(brainOf(this.env), reader)
    );
  }

  async search(query: unknown, options?: unknown): Promise<SearchResults> {
    return await this.#asDelegate(
      async (reader) => await search(brainOf(this.env), reader, query, options)
    );
  }

  async read(documentId: unknown, options?: unknown): Promise<BrainRead> {
    return await this.#asDelegate(
      async (reader) =>
        await read(brainOf(this.env), reader, documentId, options)
    );
  }

  async follow(documentId: unknown): Promise<FollowResult> {
    return await this.#asDelegate(
      async (reader) => await follow(brainOf(this.env), reader, documentId)
    );
  }
}
