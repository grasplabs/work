import type { ChatCitedDocument, ChatProvenance } from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { createContext, use, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Badge } from "../grasp/badge/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Folder } from "../grasp/icons/index.ts";
import { SourceList, Sources } from "../grasp/sources/index.ts";
import type { Source, SourcesLabels } from "../grasp/sources/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// What the chat's answers may hold, on Grasp UI's parts: the
// collections and connections core says the chat read from, as the
// library's SourceList, each opening where Grasp shows it; and what each
// stored answer cites (`AnswerCited`), which chat/answer-words.tsx lists
// under it. Only what core reports: the page never guesses a source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
  /**
   * A collection opens in Knowledge, and so does Memory, the company's
   * memory files; a connection opens on its integration's page.
   */
  kind: "collection" | "memory" | "connection";
  /** A connection's integration, as the address names it (`native:microsoft`); none for an HTTP connection. */
  integration?: string;
  /** A connection's app, whose mark it wears. */
  brand?: Brand;
}

const styles = stylex.create({
  // What the chat read, under its last answer, before the box.
  sources: {
    display: "grid",
    gap: grasp.space2,
  },
  // The badge at its own width, over the list's full one.
  restricted: { display: "flex" },
});

/**
 * What the chat's answers drew on, as core says: whether the chat's agent
 * was restricted, and the collections and connections it read, as the
 * library's pile of sources, opened into its list.
 */
export const ChatSources = ({
  provenance,
  names,
  sourcesShown = true,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
  /** Whether the sources show: not where something nearer says it, or wants the eye. */
  sourcesShown?: boolean;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { restricted } = provenance;
  const read = (sourcesShown ? provenance.sources : []).map((id) => ({
    id,
    name: names.get(id) ?? { name: id, kind: "connection" as const },
  }));
  if (read.length === 0 && !restricted) {
    return null;
  }
  const items = read.map(({ name }): Source => {
    if (name.kind === "connection") {
      return {
        kind: "record",
        title: name.name,
        origin: t`Connection`,
        ...(name.brand === undefined ? {} : { brand: name.brand }),
      };
    }
    return {
      kind: name.kind === "memory" ? "memory" : "file",
      title: name.name,
      origin: t`Knowledge`,
      ...(name.kind === "memory" ? {} : { icon: Folder }),
    };
  });
  // What the chat reads are collections and connections, not single
  // files and records: the pile and the groups say so.
  const labels: Partial<SourcesLabels> = {
    kind: (kind, count) => {
      if (kind === "memory") {
        return t`${plural(count, { one: "# memory", other: "# memories" })}`;
      }
      if (kind === "record") {
        return t`${plural(count, { one: "# connection", other: "# connections" })}`;
      }
      return t`${plural(count, { one: "# collection", other: "# collections" })}`;
    },
  };
  return (
    <div {...stylex.props(styles.sources)}>
      {restricted ? (
        <div {...stylex.props(styles.restricted)}>
          <Badge tone="attention">{t`Restricted`}</Badge>
        </div>
      ) : null}
      {items.length === 0 ? null : (
        <Sources
          items={items}
          labels={labels}
          onOpen={(_source, index) => {
            const source = read[index];
            if (source === undefined) {
              return;
            }
            if (source.name.kind !== "connection") {
              void navigate({
                to: "/knowledge/$collection",
                params: { collection: source.id },
                search: {},
              });
            } else if (source.name.integration === undefined) {
              void navigate({ to: "/integrations", search: {} });
            } else {
              void navigate({
                to: "/integrations/$integration",
                params: { integration: source.name.integration },
                search: {},
              });
            }
          }}
        >
          <SourceList />
        </Sources>
      )}
    </div>
  );
};

/**
 * The documents a stored answer cites (`cited`: its chat and message), as
 * core looks them up as the chat's agent for the person when the answer
 * shows, each with the spans of the answer that cite it: a document either
 * can no longer read isn't among them. None until core answers, or when it
 * can't.
 */
export const useCited = ({
  chatId,
  messageId,
}: {
  chatId: string;
  messageId: number;
}): ChatCitedDocument[] => {
  const core = useCore();
  const [documents, setDocuments] = useState<ChatCitedDocument[]>([]);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await session.chats.cited(chatId, messageId)
      );
      if (current && found.state === "ready") {
        setDocuments(found.data);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [core, chatId, messageId]);
  return documents;
};

/** No document cited. */
const noneCited: readonly ChatCitedDocument[] = [];

/**
 * What the answer being shown cites (`useCited`), for its words and its
 * row of actions alike; none for an answer that cites nothing, which never
 * asks core.
 */
const CitedDocuments = createContext<readonly ChatCitedDocument[]>(noneCited);

/** The documents the answer being shown cites (`AnswerCited`). */
export const useCitedDocuments = (): readonly ChatCitedDocument[] =>
  use(CitedDocuments);

/** A stored answer that cites documents (`cited`), with what it cites. */
export const AnswerCited = ({
  cited,
  children,
}: {
  cited: { chatId: string; messageId: number };
  children?: ReactNode;
}) => {
  const documents = useCited(cited);
  return <CitedDocuments value={documents}>{children}</CitedDocuments>;
};
