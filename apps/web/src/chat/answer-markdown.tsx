import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Table } from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components, Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { useCopy } from "../copy.ts";
import { downloadText } from "../export/export-file.tsx";
import { plainComponents } from "../markdown.tsx";
import {
  cellsOf,
  codeOf,
  landWords,
  languageOf,
  tableAs,
  textOf,
} from "./answer-blocks.ts";
import type { TableFormat } from "./answer-blocks.ts";

// The agent's answers, as the prototype renders them with Streamdown
// (grasplabs/prototype `components/ai-elements/message.tsx`): a code block
// highlighted, with its language and a copy button; a table that copies
// as Markdown, CSV or TSV and downloads as CSV or Markdown; and a link
// out of Grasp that asks first. Otherwise as safely as `PlainMarkdown`,
// whose components these extend: no raw HTML, safe links only, no images.
//
// Highlighting is by class (rehype-highlight), coloured from the theme's
// tokens in styles.css, so it needs no inline style (the `no-inline-styles`
// lint rule), and dark mode comes with the theme. Only a block that
// names its language is highlighted: guessing one would cost each render
// and often guess wrong.

/** A code block: its language over it, highlighted, and a copy button. */
const CodeBlock = ({
  code,
  language,
  children,
}: {
  code: string;
  language: string | undefined;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const { copied, copy } = useCopy();
  return (
    <figure className="bg-muted flex min-w-0 flex-col rounded-xl text-sm">
      <figcaption className="text-muted-foreground flex items-center justify-between gap-2 py-1 pr-1 pl-3 text-xs">
        <span>{language ?? t`Code`}</span>
        <Button
          aria-label={copied ? t`Copied` : t`Copy code`}
          onClick={() => {
            void copy(code);
          }}
          size="icon-xs"
          variant="ghost"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </figcaption>
      <pre className="overflow-x-auto px-3 pb-3">{children}</pre>
    </figure>
  );
};

/** A table, with its copy and download menus over it. */
const AnswerTable = ({
  rows,
  children,
}: {
  rows: string[][];
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const { copied, copy } = useCopy();
  const download = (format: TableFormat): void => {
    const [extension, type] =
      format === "csv" ? ["csv", "text/csv"] : ["md", "text/markdown"];
    downloadText(`table.${extension}`, tableAs(rows, format), type);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex justify-end gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`Copy table`}
            render={<Button size="icon-xs" variant="ghost" />}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              onClick={() => {
                void copy(tableAs(rows, "markdown"));
              }}
            >
              <Trans>Copy table as Markdown</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void copy(tableAs(rows, "csv"));
              }}
            >
              <Trans>Copy table as CSV</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void copy(tableAs(rows, "tsv"));
              }}
            >
              <Trans>Copy table as TSV</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`Download table`}
            render={<Button size="icon-xs" variant="ghost" />}
          >
            <DownloadIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              onClick={() => {
                download("csv");
              }}
            >
              <Trans>Download table as CSV</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                download("markdown");
              }}
            >
              <Trans>Download table as Markdown</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Table>{children}</Table>
    </div>
  );
};

/**
 * A link out of Grasp, which asks first: an answer may repeat whatever
 * the agent read, a link to anywhere among it. It is a button until the
 * person says yes, with no address a middle click or the browser's own
 * "open link" could follow past the question. Opened in a tab of its own
 * without this page as its opener. An address the transform emptied was
 * unsafe: the text stays, as text.
 */
const LeavingLink = ({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) => {
  const [asking, setAsking] = useState(false);
  if (href === undefined || href === "") {
    return <span>{children}</span>;
  }
  return (
    <>
      <button
        className="cursor-pointer underline"
        onClick={() => {
          setAsking(true);
        }}
        type="button"
      >
        {children}
      </button>
      <AlertDialog onOpenChange={setAsking} open={asking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Open external link?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>You’re about to visit an external website.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="bg-muted rounded-md p-2 font-mono text-xs break-all">
            {href}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setAsking(false);
                window.open(href, "_blank", "noopener,noreferrer");
              }}
            >
              <Trans>Open link</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** The answer's components: the plain ones, with these in their place. */
const answerComponents: Components = {
  ...plainComponents(LeavingLink),
  pre: ({ node, children }) => {
    const code = codeOf(node);
    return (
      <CodeBlock
        code={textOf(code).replace(/\n$/u, "")}
        language={languageOf(code)}
      >
        {children}
      </CodeBlock>
    );
  },
  table: ({ node, children }) => (
    <AnswerTable rows={cellsOf(node)}>{children}</AnswerTable>
  ),
};

/** Highlighting only a block that names its language. */
const rehypePlugins: Options["rehypePlugins"] = [
  [rehypeHighlight, { detect: false }],
];
const remarkPlugins: Options["remarkPlugins"] = [remarkGfm];

/**
 * While the answer is written: each word fades in where it lands
 * (`landWords`), the code it holds as it is.
 */
const writingPlugins: Options["rehypePlugins"] = [
  ...rehypePlugins,
  () => landWords,
];

/**
 * An answer's Markdown. While it is being `written`, each new word fades
 * in where it lands.
 */
export const AnswerMarkdown = ({
  text,
  written = false,
}: {
  text: string;
  written?: boolean;
}) => (
  <div className="flex min-w-0 flex-col gap-3">
    <Markdown
      components={answerComponents}
      rehypePlugins={written ? writingPlugins : rehypePlugins}
      remarkPlugins={remarkPlugins}
      skipHtml
    >
      {text}
    </Markdown>
  </div>
);
