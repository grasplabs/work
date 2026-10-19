import type { AppId } from "@grasp-os/shared/ids";
import type {
  BacklinkPage,
  DocumentPage,
  DocumentRead,
  FollowResult,
  HistoryPage,
  KnowledgeRead,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { callerOf, handedBack } from "../app-bindings.ts";
import type { AttemptFence } from "../workflows/attempt-fence.ts";
import { collectionReads } from "./binding.ts";
import type { CollectionGrant } from "./binding.ts";

/**
 * A collection, as an App's server code holds it:
 * `await this.env.HANDBOOK.getDocument(caller, id)`. Like the App's
 * connection stubs (app-bindings.ts), it acts for no one on its own: each
 * read passes the caller of the App method it runs in, and the App's host
 * says who that is. So a read gets the App's grant intersected with what
 * that person may read, never a personal collection (access.ts), and a
 * read of restricted data puts the App in restricted mode first, for
 * everyone using it.
 *
 * It only reads: an App keeps the records it writes in its own business
 * store, never in a collection.
 */
export class AppCollectionBinding extends WorkerEntrypoint<
  Env,
  CollectionGrant & { app: AppId }
> {
  /**
   * What `read` read, given who `caller` is as the App's host knows them
   * once the read needs it (`callerOf`), handed on as `handedBack` says:
   * for a workflow run's step, only while its attempt still holds and its
   * call's token is still good, whatever the read awaited on the way.
   */
  async #leaving<T>(
    caller: unknown,
    read: (authorityOf: () => Promise<Authority>) => Promise<T>
  ): Promise<T> {
    const { app } = this.ctx.props;
    let fence: AttemptFence | undefined;
    const authorityOf = async (): Promise<Authority> => {
      const resolved = await callerOf(this.env, app, caller, "read");
      ({ fence } = resolved);
      return resolved.authority;
    };
    return await handedBack(
      this.env,
      app,
      caller,
      "read",
      () => fence,
      read(authorityOf)
    );
  }

  /** The collection's reads, for whoever `authorityOf` says. */
  #reads(authorityOf: () => Promise<Authority>) {
    const { app: _app, ...grant } = this.ctx.props;
    return collectionReads(this.env, authorityOf, grant);
  }

  async listDocuments(
    caller: unknown,
    options?: unknown
  ): Promise<DocumentPage> {
    return await this.#leaving(
      caller,
      async (authorityOf) =>
        await this.#reads(authorityOf).listDocuments(options)
    );
  }

  async getDocument(
    caller: unknown,
    documentId: unknown,
    version?: unknown
  ): Promise<DocumentRead> {
    return await this.#leaving(
      caller,
      async (authorityOf) =>
        await this.#reads(authorityOf).getDocument(documentId, version)
    );
  }

  async history(
    caller: unknown,
    documentId: unknown,
    options?: unknown
  ): Promise<HistoryPage> {
    return await this.#leaving(
      caller,
      async (authorityOf) =>
        await this.#reads(authorityOf).history(documentId, options)
    );
  }

  async backlinks(
    caller: unknown,
    documentId: unknown,
    options?: unknown
  ): Promise<BacklinkPage> {
    return await this.#leaving(
      caller,
      async (authorityOf) =>
        await this.#reads(authorityOf).backlinks(documentId, options)
    );
  }

  async search(
    caller: unknown,
    query: unknown,
    options?: unknown
  ): Promise<SearchResults> {
    return await this.#leaving(
      caller,
      async (authorityOf) =>
        await this.#reads(authorityOf).search(query, options)
    );
  }

  async read(
    caller: unknown,
    documentId: unknown,
    options?: unknown
  ): Promise<KnowledgeRead> {
    return await this.#leaving(
      caller,
      async (authorityOf) =>
        await this.#reads(authorityOf).read(documentId, options)
    );
  }

  async follow(caller: unknown, documentId: unknown): Promise<FollowResult> {
    return await this.#leaving(
      caller,
      async (authorityOf) => await this.#reads(authorityOf).follow(documentId)
    );
  }
}
