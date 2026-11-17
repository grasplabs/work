import type { ChatCitedDocument } from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
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
import type { Source, SourcesLabels } from "../grasp/sources/index.ts";
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
    return (
      <>
        <Claim n={at + 1}>{link.children}</Claim>
        <Citation n={at + 1} />
      </>
    );
  }
  if (link.kind !== "image" && leavingSchemes.has(link.scheme)) {
    return <LeavingLink href={link.href}>{link.children}</LeavingLink>;
  }
  // Anything else (a picture, a scheme of its own): its words alone.
  return <span>{link.children}</span>;
};

/** What Sources says, in the page's language. */
const useSourcesLabels = (): Partial<SourcesLabels> => {
  const { t } = useLingui();
  return {
    source: (number) => t`Source ${number}`,
    mention: (index) => t`mention ${index}`,
    gone: t`Could not be opened`,
    locked: t`You cannot open this`,
    goneInName: t`could not be opened`,
    lockedInName: t`you cannot open it`,
    count: (count) =>
      t`${plural(count, { 0: "No sources", one: "# source", other: "# sources" })}`,
    kind: (_kind, count) =>
      t`${plural(count, { 0: "No documents", one: "# document", other: "# documents" })}`,
    showMore: (count) => t`Show ${count} more`,
    showFewer: t`Show fewer`,
    order: t`Order`,
    byRelevance: t`By relevance`,
    byKind: t`By kind`,
    open: t`Show them`,
    close: t`Fold them away`,
    openRun: t`Open the run`,
    correct: t`Correct it`,
  };
};

/** A cited document, as Sources lists it: a document of the company's, opened on its collection's page. */
const sourceOf = ({ title, path, snippet }: ChatCitedDocument): Source => ({
  kind: "file",
  title,
  origin: path,
  ...(snippet === "" ? {} : { quote: snippet }),
});

/**
 * One answer's words. While it is `writing`, they come in paced. Where it
 * cites documents (`cited`, as core answered), each cited span is marked
 * and the documents are listed under it.
 */
export const AnswerWords = ({
  text,
  writing,
  cited,
}: {
  text: string;
  writing: boolean;
  cited?: readonly ChatCitedDocument[];
}) => {
  const { t } = useLingui();
  const labels = useSourcesLabels();
  const navigate = useNavigate();
  const words = (
    <Markdown
      backLabel={(number) => t`Back to reference ${number}`}
      doneLabel={t`Done`}
      footnoteLabel={(number) => t`Footnote ${number}`}
      notDoneLabel={t`Not done`}
      renderLink={(link) => <AnswerLink cited={cited} link={link} />}
      source={text}
      streaming={writing}
      tableLabel={t`Table`}
    />
  );
  if (cited === undefined || cited.length === 0) {
    return words;
  }
  return (
    <Sources
      items={cited.map(sourceOf)}
      labels={labels}
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
      <SourceList heading={t`Sources`} />
    </Sources>
  );
};
