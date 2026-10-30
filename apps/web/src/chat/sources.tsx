import type { ChatCitedDocument, ChatProvenance } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  BookIcon,
  BookOpenIcon,
  CableIcon,
  ChevronDownIcon,
  FileTextIcon,
} from "lucide-react";
import { createContext, use, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { MessageActions } from "./message.tsx";

// What the chat's answers may hold, in the prototype's sources look
// (grasplabs/prototype `components/ai-elements/sources.tsx`): the
// collections and connections core says the chat read from, each
// collection one link away in Knowledge; and under each answer, the
// documents it cites, behind "Based on N sources" in the answer's quiet
// row of actions (`components/chat/citations.tsx` `AnswerSources`). Only
// what core reports: the page never guesses a source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
  /** A collection opens in Knowledge; a connection is only named. */
  kind: "collection" | "connection";
}

export const ChatSources = ({
  provenance,
  names,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
}) => {
  const { sources, restricted } = provenance;
  const count = sources.length;
  if (count === 0 && !restricted) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-start gap-2 text-xs">
      {restricted ? (
        <Badge variant="attention">
          <Trans>Restricted</Trans>
        </Badge>
      ) : null}
      {count === 0 ? null : (
        <details className="group text-primary">
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <BookOpenIcon aria-hidden="true" className="size-3.5" />
            <span className="font-medium">
              <Plural
                one="Answers draw on # source"
                other="Answers draw on # sources"
                value={count}
              />
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 transition-transform group-open:rotate-180"
            />
          </summary>

          <ul className="mt-3 flex w-fit flex-col gap-2">
            {sources.map((id) => {
              const source = names.get(id);
              const name = source?.name ?? id;
              return (
                <li key={id}>
                  {source?.kind === "collection" ? (
                    <Link
                      className="flex items-center gap-2 font-medium hover:underline"
                      params={{ collection: id }}
                      search={{}}
                      to="/knowledge/$collection"
                    >
                      <BookIcon aria-hidden="true" className="size-4" />
                      {name}
                    </Link>
                  ) : (
                    <span className="flex items-center gap-2 font-medium">
                      <CableIcon aria-hidden="true" className="size-4" />
                      {name}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
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

/**
 * Under a stored answer: its quiet row of actions (`children`), with
 * "Based on N sources" beside them, which opens the documents it cites
 * (`useCited`), numbered in the order it first links to them, as its
 * inline citations number them, each with its path and the start of what
 * it says, and each opening on its collection's page (`?doc=`). Until
 * core answers, or when it can't or lists none, the row holds only the
 * actions: the answer's own links still open each document.
 */
export const AnswerSources = ({
  cited,
  children,
}: {
  cited: readonly ChatCitedDocument[];
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  // The same elements before and after core answers, so the actions keep
  // their focus and state (Copied) while the trigger joins them.
  return (
    <Collapsible>
      <MessageActions>
        {children}
        {cited.length === 0 ? null : (
          <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
            <BookOpenIcon data-icon="inline-start" />
            <Plural
              one="Based on # source"
              other="Based on # sources"
              value={cited.length}
            />
          </CollapsibleTrigger>
        )}
      </MessageActions>
      <CollapsibleContent>
        <ol
          aria-label={t`Sources`}
          className="flex flex-col gap-2 pt-2 text-xs"
        >
          {cited.map(
            ({ documentId, collectionId, title, path, snippet }, index) => (
              <li key={documentId}>
                <Link
                  className="group flex items-start gap-2"
                  params={{ collection: collectionId }}
                  search={{ doc: documentId }}
                  to="/knowledge/$collection"
                >
                  <span className="text-muted-foreground w-4 flex-none text-right tabular-nums">
                    {index + 1}
                  </span>
                  <FileTextIcon
                    aria-hidden="true"
                    className="text-muted-foreground mt-px size-3.5 flex-none"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-primary font-medium group-hover:underline">
                      {title}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {path}
                    </span>
                    {snippet === "" ? null : (
                      <span className="text-muted-foreground line-clamp-2">
                        {snippet}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            )
          )}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
};
