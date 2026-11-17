import type { ChatCitedDocument, ChatProvenance } from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink } from "@tanstack/react-router";
import { createContext, use, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Badge } from "../grasp/badge/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { Cable, Folder, Icon } from "../grasp/icons/index.ts";
import { Link } from "../grasp/link/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// What the chat's answers may hold, on Grasp UI's parts: the
// collections and connections core says the chat read from, each
// collection one link away in Knowledge; and what each stored answer
// cites (`AnswerCited`), which chat/answer-words.tsx lists under it. Only
// what core reports: the page never guesses a source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
  /** A collection opens in Knowledge; a connection is only named. */
  kind: "collection" | "connection";
}

const styles = stylex.create({
  // What the chat read, under its last answer, before the box.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: grasp.space2,
  },
  list: {
    display: "grid",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
  },
});

/**
 * What the chat's answers drew on, as core says: whether the chat's agent
 * was restricted, and the collections and connections it read, folded, a
 * collection one link away in Knowledge.
 */
export const ChatSources = ({
  provenance,
  names,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
}) => {
  const { t } = useLingui();
  const { sources, restricted } = provenance;
  const count = sources.length;
  if (count === 0 && !restricted) {
    return null;
  }
  return (
    <div {...stylex.props(styles.row)}>
      {restricted ? <Badge tone="attention">{t`Restricted`}</Badge> : null}
      {count === 0 ? null : (
        <Collapsible
          fit
          title={t`${plural(count, { one: "Answers draw on # source", other: "Answers draw on # sources" })}`}
        >
          <ul {...stylex.props(styles.list)}>
            {sources.map((id) => {
              const source = names.get(id);
              const name = source?.name ?? id;
              return (
                <li key={id} {...stylex.props(styles.item)}>
                  <Icon icon={source?.kind === "collection" ? Folder : Cable} />
                  {source?.kind === "collection" ? (
                    <Link
                      render={
                        <RouterLink
                          params={{ collection: id }}
                          search={{}}
                          to="/knowledge/$collection"
                        />
                      }
                      variant="standalone"
                    >
                      {name}
                    </Link>
                  ) : (
                    <Text size="sm">{name}</Text>
                  )}
                </li>
              );
            })}
          </ul>
        </Collapsible>
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
