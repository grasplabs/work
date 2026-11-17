import { citedQuoteMax } from "@grasp-os/shared/chat";
import type { ChatCitedDocument } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Link } from "../grasp/link/index.ts";
import { Markdown } from "../grasp/markdown/index.ts";
import type { MarkdownLink } from "../grasp/markdown/index.ts";
import {
  Citation,
  Claim,
  SourceList,
  Sources,
} from "../grasp/sources/index.ts";
import type { Source } from "../grasp/sources/index.ts";
import { citedNoteLink } from "./cited-note.tsx";

// The agent's answer, as Grasp UI draws one: its Markdown (the library's,
// paced while it is written), and where it cites the company's documents,
// each cited span marked with its number, the documents listed under it
// (the library's Sources). The model's own links are the host's to draw
// (`renderLink`): a link to a note the answer cites is a citation; to any
// other note, its words alone, whatever the answer says; out of Grasp, a
// button that asks first and carries no address a middle click or the
// browser's own "open link" could follow past the question.

/** A link out of Grasp: opened in its own tab, once the person says so. */
const LeavingLink = ({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Link
        render={
          <button
            onClick={() => {
              setAsking(true);
            }}
            type="button"
          >
            {children}
          </button>
        }
      >
        {children}
      </Link>
      <AlertDialog
        onOpenChange={(open, { returnValue }) => {
          setAsking(open);
          if (returnValue === "open") {
            window.open(href, "_blank", "noopener,noreferrer");
          }
        }}
        open={asking}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t`Open external link?`}</AlertDialogTitle>
          <AlertDialogDescription>{href}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction value="open" variant="ink">
              {t`Open link`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** The links out of Grasp a click may open. */
const leavingSchemes = new Set(["http", "https", "mailto"]);

/** Whitespace aside, as core compares a quote with its document. */
const spaced = (words: string): string => words.replaceAll(/\s+/gu, " ").trim();

/**
 * The passage a citation rests on, for its hover card: the quote its link
 * gives as its title, but only as core checked it against the document
 * (a span's `quote`, which core keeps only while the document says it, cut
 * at `citedQuoteMax`). A quote core didn't keep shows nothing.
 */
const checkedQuote = (
  document: ChatCitedDocument | undefined,
  title: string | undefined
): string | undefined => {
  if (document === undefined || title === undefined) {
    return undefined;
  }
  const given = spaced(title);
  const same = (quote: string): boolean => {
    const kept = spaced(quote);
    // Cut at its longest, only its start is kept.
    return quote.length >= citedQuoteMax
      ? given.startsWith(kept)
      : given === kept;
  };
  return (
    document.spans.find(({ quote }) => quote !== null && same(quote))?.quote ??
    undefined
  );
};

/** One of the answer's links, drawn by what `cited` holds. */
const AnswerLink = ({
  link,
  cited,
}: {
  link: MarkdownLink;
  cited: readonly ChatCitedDocument[] | undefined;
}) => {
  const note = citedNoteLink.exec(link.href)?.groups?.id;
  if (note !== undefined) {
    const at = cited?.findIndex(({ documentId }) => documentId === note);
    // Not cited, or not read yet: its words alone.
    if (at === undefined || at < 0) {
      return <span>{link.children}</span>;
    }
    const quote = checkedQuote(cited?.[at], link.title);
    return (
      <>
        <Claim n={at + 1}>{link.children}</Claim>
        <Citation n={at + 1} {...(quote === undefined ? {} : { quote })} />
      </>
    );
  }
  if (link.kind !== "image" && leavingSchemes.has(link.scheme)) {
    return <LeavingLink href={link.href}>{link.children}</LeavingLink>;
  }
  // Anything else (a picture, a scheme of its own): its words alone.
  return <span>{link.children}</span>;
};

/**
 * A cited document, as Sources lists it: a document of the company's,
 * opened on its collection's page. No quote: Sources holds one a source,
 * and the document's `snippet` is its start, not the passage cited; each
 * citation's own quote comes with Grasp UI's Citation.
 */
const sourceOf = ({ title, path }: ChatCitedDocument): Source => ({
  kind: "file",
  title,
  origin: path,
});

/**
 * One answer's words. While it is `writing`, they come in paced. Where it
 * cites documents (`cited`, as core answered), each cited span is marked
 * and the documents are listed under it.
 */
export const AnswerWords = ({
  text,
  writing,
  cut = false,
  cited,
}: {
  text: string;
  writing: boolean;
  /** Stopped part way: a link it was still writing goes, an open mark closes. */
  cut?: boolean;
  cited?: readonly ChatCitedDocument[];
}) => {
  const navigate = useNavigate();
  const words = (
    <Markdown
      renderLink={(link) => <AnswerLink cited={cited} link={link} />}
      cut={cut}
      source={text}
      streaming={writing}
    />
  );
  if (cited === undefined || cited.length === 0) {
    return words;
  }
  return (
    <Sources
      items={cited.map(sourceOf)}
      onOpen={(_source, index) => {
        const document = cited[index];
        if (document !== undefined) {
          void navigate({
            to: "/knowledge/$collection",
            params: { collection: document.collectionId },
            search: { doc: document.documentId },
          });
        }
      }}
    >
      {words}
      <SourceList />
    </Sources>
  );
};
