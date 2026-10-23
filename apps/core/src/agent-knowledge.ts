import type { AuditDetailValue } from "@grasp-os/shared/audit";
import type { MemoryPack } from "@grasp-os/shared/brain-api";
import type {
  FollowResult,
  KnowledgeCatalog,
  KnowledgeRead,
  KnowledgeTools,
  Provenance,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import {
  questionWindowDays,
  unreadDays,
} from "@grasp-os/shared/knowledge-signals";
import type { KnowledgeSignals } from "@grasp-os/shared/knowledge-signals";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import {
  auditedCall,
  chatAuthority,
  chatContext,
  endedBy,
  recordRunReads,
  recordSources,
  recordToolCall,
  requireOpenRun,
} from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import type { Reader } from "./knowledge/access.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { brainOf } from "./knowledge/ports.ts";
import { recallWithSources } from "./knowledge/recall.ts";
import { search } from "./knowledge/search.ts";
import { agentKnowledgeSignals } from "./knowledge/signals.ts";
import { catalog, follow, read } from "./knowledge/tools.ts";

// Knowledge for a chat's code: `await env.knowledge.search("leave policy")`.
// The agent's Knowledge tools (knowledge/tools.ts), read as the chat's
// agent acting for its person: only the collections the agent was granted
// to read that the person may read too, checked again on every call
// (knowledge/access.ts). Every read but the catalog is recorded in the
// audit log there, and puts the chat in restricted mode when it read a
// sensitive collection. Here it is also recorded with the chat, which
// every later model request carries as provenance. The catalog and the
// usage signals of the person's own collections hold nothing of a
// sensitive collection, and are recorded as the chat's calls.

/** Knowledge, as a chat's code calls it. */
export class KnowledgeApi
  extends WorkerEntrypoint<Env, AgentScope>
  implements KnowledgeTools
{
  /** Runs one read as the chat's agent. */
  async #asAgent<T>(run: (reader: Reader) => Promise<T>): Promise<T> {
    const scope = this.ctx.props;
    return await readAsDelegate(
      this.env,
      chatAuthority(scope),
      chatContext(scope),
      undefined,
      run
    );
  }

  /**
   * Runs one read after the run's check, and shows it in the chat however
   * it ends (`recordToolCall`), with what `summaryOf` says of what it
   * found. Knowledge records the read in the audit log itself.
   */
  async #shown<T>(
    method: string,
    summaryOf: (result: T) => Record<string, AuditDetailValue>,
    call: () => Promise<T>
  ): Promise<T> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope, method);
    let result: T;
    try {
      result = await call();
    } catch (error) {
      await recordToolCall(this.env, scope, { method }, endedBy(error));
      throw error;
    }
    await recordToolCall(this.env, scope, {
      method,
      detail: summaryOf(result),
    });
    return result;
  }

  /**
   * Hands over what a read returned once the chat has recorded its sources
   * and the documents it hands over (`given`), which its answers may cite.
   */
  async #recorded<T extends { provenance: Provenance }>(
    result: T,
    given: readonly string[]
  ): Promise<T> {
    await recordSources(
      this.env,
      this.ctx.props,
      result.provenance.collectionIds,
      given
    );
    return result;
  }

  /**
   * The catalog names what may be read, and holds nothing of a sensitive
   * collection (knowledge/tools.ts): no source to record with the chat.
   * Knowledge doesn't record it; the call is, as every call of the chat's.
   */
  async catalog(): Promise<KnowledgeCatalog> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope, "knowledge.catalog");
    return await auditedCall(
      this.env,
      scope,
      {
        method: "knowledge.catalog",
        detailOf: (listed: KnowledgeCatalog) => ({
          collections: listed.collections.length,
          skills: listed.skills.length,
        }),
      },
      async () =>
        await readAsDelegate(
          this.env,
          chatAuthority(scope),
          chatContext(scope),
          undefined,
          async (reader) => {
            const listed = await catalog(brainOf(this.env), reader);
            // What it names rests on those collections: withheld once
            // they can't be read (history-access.ts), never provenance.
            await recordRunReads(this.env, scope, [
              ...listed.collections.map(({ id }) => id),
              ...listed.skills.map(({ collectionId }) => collectionId),
            ]);
            return listed;
          }
        )
    );
  }

  async search(query: unknown, options?: unknown): Promise<SearchResults> {
    return await this.#shown(
      "knowledge.search",
      (found) => ({ hits: found.hits.length }),
      async () => {
        const found = await this.#asAgent(
          async (reader) =>
            await search(brainOf(this.env), reader, query, options)
        );
        return await this.#recorded(
          found,
          found.hits.map(({ documentId }) => documentId)
        );
      }
    );
  }

  /**
   * The Brain's recall, as the chat's agent under its `brain` grant: the
   * same service and checks as every caller's (knowledge/recall.ts), with
   * what it handed over recorded with the chat, as a search's is.
   */
  async recall(input: unknown): Promise<MemoryPack> {
    return await this.#shown(
      "knowledge.recall",
      (pack) => ({ sources: pack.sourceVersions.length }),
      async () => {
        const { pack, sources } = await this.#asAgent(
          async (reader) =>
            await recallWithSources(brainOf(this.env), reader, input)
        );
        // Every collection it read from, found or not, as a search records.
        await recordSources(this.env, this.ctx.props, sources, [
          ...new Set(
            pack.sourceVersions.flatMap((ref) =>
              ref.kind === "document" ? [ref.documentId] : []
            )
          ),
        ]);
        return pack;
      }
    );
  }

  async read(documentId: unknown, options?: unknown): Promise<KnowledgeRead> {
    return await this.#shown(
      "knowledge.read",
      (document) => ({ document: document.id }),
      async () => {
        const document = await this.#asAgent(
          async (reader) =>
            await read(brainOf(this.env), reader, documentId, options)
        );
        return await this.#recorded(document, [document.id]);
      }
    );
  }

  async follow(documentId: unknown): Promise<FollowResult> {
    return await this.#shown(
      "knowledge.follow",
      (followed) => ({
        document: typeof documentId === "string" ? documentId : null,
        links: followed.links.length,
        backlinks: followed.backlinks.length,
      }),
      async () => {
        const followed = await this.#asAgent(
          async (reader) => await follow(brainOf(this.env), reader, documentId)
        );
        return await this.#recorded(followed, [
          ...followed.links.flatMap(({ documentId: linked }) =>
            linked === null ? [] : [linked]
          ),
          ...followed.backlinks.map(({ documentId: linking }) => linking),
          ...followed.files.map(({ documentId: file }) => file),
        ]);
      }
    );
  }

  /**
   * The usage signals of the collections the chat's person owns, for the
   * agent to bring up with them: only of collections it may read, none of
   * a sensitive one (knowledge/signals.ts), so there's no source to record
   * with the chat. Recorded as the chat's call, as the catalog is.
   */
  async signals(): Promise<KnowledgeSignals> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope, "knowledge.signals");
    return await auditedCall(
      this.env,
      scope,
      {
        method: "knowledge.signals",
        detailOf: (found: KnowledgeSignals) => ({
          signals: found.signals.length,
        }),
      },
      async () =>
        await readAsDelegate(
          this.env,
          chatAuthority(scope),
          chatContext(scope),
          undefined,
          async (reader) => {
            const found = await agentKnowledgeSignals(
              this.env,
              reader,
              scope.personId
            );
            await recordRunReads(
              this.env,
              scope,
              found.signals.map(({ collection }) => collection.id)
            );
            return found;
          }
        )
    );
  }
}

/** The types `env.knowledge` returns, as the model reads them. */
const knowledgeTypes = `/** Where what a read returned came from. */
interface Provenance {
  collectionIds: string[];
  /** Some of it is from a sensitive collection. */
  sensitive: boolean;
  /** Some of it is restricted: this chat now asks the person before acting outside Grasp. */
  restricted: boolean;
}

/** A document in Knowledge, without its text. */
interface KnowledgeDocument {
  id: string;
  collectionId: string;
  path: string;
  title: string;
  /** \`doc\`, \`skill\`, \`memory\`, \`decision\` or \`file\`. */
  type: string;
  /** When to use it. */
  description: string;
  owner: string;
  tags: string[];
  /** YYYY-MM-DD, if set. */
  reviewDate: string | null;
  currentVersion: number;
  updatedAt: string;
}

/** One piece of evidence a recall found, cited at its exact version. */
interface MemoryItem {
  id: string;
  /** The section's own text around the match: evidence, not an answer. */
  statement: string;
  sourceRefs: { kind: "document"; documentId: string; collectionId: string; version: number; section?: number }[];
  /** Its document's title and the section's headings. */
  citationLocator: string[];
}

/** What a recall answers: bounded evidence, and how far the read got. */
interface MemoryPack {
  items: MemoryItem[];
  /** Every source version the items cite, once each. */
  sourceVersions: MemoryItem["sourceRefs"];
  /** What the question needs that nothing read holds. */
  gaps: { about: string }[];
  /** \`complete\`: the bounded read finished (never proof nothing else exists); \`bounded\`: a budget cut it; \`degraded\`: it ran out of time. */
  coverage: { state: "complete" | "bounded" | "degraded" };
  truncated: boolean;
}

/** A section a search matched. */
interface KnowledgeHit {
  documentId: string;
  collectionId: string;
  path: string;
  title: string;
  type: string;
  description: string;
  /** The section's place in its document, from 0: read it with \`read(documentId, { section })\`. */
  section: number;
  headings: string[];
  snippet: string;
}

/**
 * What the person should look at in a collection they own, computed daily.
 * A question's words are never kept: only a key that the same words share.
 */
type KnowledgeSignal = { id: string; collection: { id: string; name: string } } & (
  | {
      kind: "unanswered_question";
      /** Searches by others in the last ${questionWindowDays} days that found nothing, in the collection or closest to it. */
      value: number;
      evidence: { queryKey: string; searches: number; askers: number; terms: number; lastAt: string };
    }
  | {
      kind: "unread_document";
      /** Days since it changed; nobody read it for \`evidence.days\` days (${unreadDays}, or fewer where the audit log keeps less) either. */
      value: number;
      evidence: { document: { id: string; path: string; title: string }; updatedAt: string; days: number };
    }
  | {
      kind: "overdue_review";
      /** Days past its review date. */
      value: number;
      evidence: { document: { id: string; path: string; title: string }; reviewDate: string };
    }
);`;

/** What the model reads of `env.knowledge`. */
const knowledgeDeclaration = `/**
 * The company's Knowledge: the collections this chat may read, and their
 * documents. Search, then read what you need, and cite the documents you
 * answer from by title and path. Every read is recorded.
 */
knowledge: {
  /** The collections this chat may read, and the skills in them, cut to fit (\`truncated\` says so). */
  catalog(): Promise<{
    collections: { id: string; name: string; description: string; sensitive: boolean }[];
    skills: { documentId: string; collectionId: string; name: string; description: string }[];
    truncated: boolean;
  }>;
  /** Sections that match \`query\`, best first: 20, or \`limit\` up to 50. Pass \`collectionId\` when you know which collection should hold the answer. */
  search(
    query: string,
    options?: { collectionId?: string; type?: string; limit?: number }
  ): Promise<{ hits: KnowledgeHit[]; provenance: Provenance }>;
  /** A whole document, or one section of it, at its current version. */
  read(
    documentId: string,
    options?: { section?: number }
  ): Promise<KnowledgeDocument & {
    /** The section read, or null for the whole document. */
    section: { position: number; headings: string[] } | null;
    text: string;
    provenance: Provenance;
  }>;
  /** Where a document leads: its [[links]], the documents that link to it, and for a skill, the files in its folder. */
  follow(documentId: string): Promise<{
    links: { path: string; label: string | null; documentId: string | null; title: string | null }[];
    backlinks: { documentId: string; collectionId: string; path: string; title: string; label: string | null }[];
    files: { documentId: string; path: string; title: string; type: string; description: string }[];
    truncated: boolean;
    provenance: Provenance;
  }>;
  /** Evidence for a question from the company Brain, cited at exact versions: needs the Brain permission, and reads only what this chat may read. Name \`collectionIds\` to narrow it. */
  recall(input: {
    query: string;
    filters?: { collectionIds?: string[] };
    budget?: { maxItems?: number; maxTokens?: number; deadlineMs?: number };
  }): Promise<MemoryPack>;
  /** For your person: questions nothing answered, unread and overdue documents in collections they own that you may read. Bring them up when it helps. */
  signals(): Promise<{ computedAt: string | null; signals: KnowledgeSignal[] }>;
};`;

/** `env.knowledge`. */
export const knowledgeApi: AgentApi = {
  name: "knowledge",
  types: knowledgeTypes,
  declaration: knowledgeDeclaration,
  stub: (scope) => exports.KnowledgeApi({ props: scope }),
};
