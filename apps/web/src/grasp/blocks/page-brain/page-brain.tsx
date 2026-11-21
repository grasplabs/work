// Page brain: a Brain page, Grasp's draft that people own: its title, its properties one quiet press
// away (Page properties: the facts and the questions waiting for an answer), then its body, editable
// in place as a page (DocumentEditor's page variant: the gutter, the block menus, the slash menu, and
// Ask again for a section or an Ask block), with its History in a sheet the host opens from its "…"
// menu. The body is Markdown in and out, so every block of it still reads as Markdown elsewhere.
//
//   <PageBrain title="Expense policy 2026" facts={facts} questions={questions} value={markdown} onValueChange={save}
//     onAskAgain={ask} versions={versions} historyOpen={open} onHistoryOpenChange={setOpen} onRestore={restore} />
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { DocumentEditor } from "../../document-editor";
import type { AskAgainRequest } from "../../document-editor";
import { Heading } from "../../heading";
import { PageHistory } from "../../page-history";
import type { PageVersion } from "../../page-history";
import { PageProperties } from "../../page-properties";
import type { PageFact, PageOpenQuestion } from "../../page-properties";
import { grasp, media } from "../../tokens/tokens.stylex";

export interface PageBrainProps {
  title: string;
  /** Grasp's facts: read only, behind the Properties button. */
  facts: readonly PageFact[];
  /** Questions waiting for an answer, counted on the button. */
  questions?: readonly PageOpenQuestion[];
  /** The body as Markdown, kept by the host. */
  value: string;
  onValueChange: (markdown: string) => void;
  /** Read, not edited: for someone who may not change the page, or an earlier version. @default false */
  readOnly?: boolean;
  /** Grasp writes a section or an Ask block again; resolves with its new Markdown. */
  onAskAgain?: (request: AskAgainRequest) => Promise<string>;
  /** Properties open at first. @default false */
  propertiesOpen?: boolean;
  /** The saved versions, the newest first. Without them there is no History. */
  versions?: readonly PageVersion[];
  historyOpen?: boolean;
  onHistoryOpenChange?: (open: boolean) => void;
  /** Brings a version back; the host saves it as a new version. */
  onRestore?: (version: PageVersion) => void;
}

const styles = stylex.create({
  // The reading column, about 44rem, with room before it for the gutter's handle and `+` (none on a
  // phone, where the gutter gives way).
  page: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: {
      default: `calc(44rem + ${grasp.space16})`,
      [media.belowPhone]: "44rem",
    },
    marginInline: "auto",
    paddingBlockStart: {
      default: grasp.space8,
      [media.belowPhone]: grasp.space2,
    },
    paddingBlockEnd: grasp.space16,
    paddingInlineStart: { default: grasp.space16, [media.belowPhone]: 0 },
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  body: { marginBlockStart: grasp.space3 },
});

/** No open questions, and no versions. */
const noQuestions: readonly PageOpenQuestion[] = [];
const noVersions: readonly PageVersion[] = [];

export const PageBrain = ({
  title,
  facts,
  questions = noQuestions,
  value,
  onValueChange,
  onAskAgain,
  readOnly = false,
  propertiesOpen = false,
  versions = noVersions,
  historyOpen = false,
  onHistoryOpenChange,
  onRestore,
}: PageBrainProps) => {
  const titleId = useId();
  return (
    <article
      aria-labelledby={titleId}
      data-slot="page-brain"
      {...stylex.props(styles.page)}
    >
      <Heading level={1} id={titleId}>
        {title}
      </Heading>
      <PageProperties
        facts={facts}
        questions={questions}
        defaultOpen={propertiesOpen}
      />
      <div {...stylex.props(styles.body)}>
        <DocumentEditor
          variant="page"
          aria-label={title}
          value={value}
          onValueChange={onValueChange}
          onAskAgain={onAskAgain}
          readOnly={readOnly}
        />
      </div>
      {versions.length === 0 || onHistoryOpenChange === undefined ? null : (
        <PageHistory
          open={historyOpen}
          onOpenChange={onHistoryOpenChange}
          versions={versions}
          current={value}
          onRestore={(version) => {
            onRestore?.(version);
          }}
        />
      )}
    </article>
  );
};
