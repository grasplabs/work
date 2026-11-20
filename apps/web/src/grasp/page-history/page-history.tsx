// Page history: a page's saved versions in a Sheet, the newest first, each with who made it, when and
// what they changed. Choose one to see what changed since, as people read the page (a table row as
// its cells, a section as its words, a link as its title, no Markdown marks), and Restore brings it
// back as a new version, so nothing is lost.
//
//   <PageHistory open={open} onOpenChange={setOpen} versions={versions} current={markdown} onRestore={(version) => save(version.markdown)} />
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Button } from "../button";
import { Diff } from "../diff";
import { focus } from "../focus/focus";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetTitle,
} from "../sheet";
import { Text } from "../text";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { pageHistoryWords } from "./words";
import type { PageHistoryWords } from "./words";

/** One saved version: who made it, when, what changed, and the page's Markdown then. */
export interface PageVersion {
  id: string;
  who: string;
  when: string;
  what: string;
  markdown: string;
}

export interface PageHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The newest first; the first is the page as it stands. */
  versions: readonly PageVersion[];
  /** The page's Markdown now, which the changes are shown against. */
  current: string;
  /** Brings a version back; the host saves it as a new version. */
  onRestore: (version: PageVersion) => void;
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<PageHistoryWords>;
}

const styles = stylex.create({
  history: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 15rem) minmax(0, 1fr)",
      [media.belowPhone]: "minmax(0, 1fr)",
    },
    gap: grasp.space4,
    alignItems: "start",
  },
  versions: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  version: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderWidth: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    color: grasp.ink,
    fontFamily: "inherit",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "start",
    cursor: "pointer",
  },
  chosen: { backgroundColor: grasp.alertFillNeutral },
  who: { fontWeight: grasp.weightMedium },
  what: { color: grasp.muted },
  changes: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    minWidth: 0,
  },
});

/**
 * A page's Markdown as people read it, for the changes: a table row as its cells, a callout and a
 * section as their words, a link or an embed as its title, no Markdown marks.
 */
export const readableText = (markdown: string) =>
  markdown
    .split("\n")
    .filter(
      (line) =>
        !/^\|[\s|:-]+\|$/u.test(line) &&
        !/^> ?\[!\w+\]$/u.test(line) &&
        !/^<\/?details[^>]*>$/u.test(line)
    )
    .map((line) =>
      line
        .replace(/^\|(?<cells>.*)\|$/u, (_row, cells: string) =>
          cells
            .split("|")
            .map((cell) => cell.trim())
            .join(" · ")
        )
        .replace(/^> ?/u, "")
        .replaceAll(/<\/?summary>/gu, "")
        .replaceAll(/\[(?<words>[^\]]+)\]\([^)]*\)/gu, "$<words>")
        .replaceAll("**", "")
    )
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

export const PageHistory = ({
  open,
  onOpenChange,
  versions,
  current,
  onRestore,
  words: own,
}: PageHistoryProps) => {
  const words = useWords("pageHistory", pageHistoryWords, own);
  const [chosenId, setChosenId] = useState<string | undefined>(versions[1]?.id);
  const chosen =
    versions.find((version) => version.id === chosenId) ?? versions[0];
  const latest = chosen === versions[0];
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent initialFocus="content">
        <SheetTitle>{words.title}</SheetTitle>
        <SheetDescription>{words.description}</SheetDescription>
        <SheetBody>
          <div data-slot="page-history" {...stylex.props(styles.history)}>
            <ul aria-label={words.versions} {...stylex.props(styles.versions)}>
              {versions.map((version, at) => (
                <li key={version.id}>
                  <button
                    type="button"
                    aria-pressed={version.id === chosen?.id}
                    onClick={() => {
                      setChosenId(version.id);
                    }}
                    {...stylex.props(
                      styles.version,
                      version.id === chosen?.id && styles.chosen,
                      focus.ring
                    )}
                  >
                    <span {...stylex.props(styles.who)}>
                      {at === 0 ? `${version.who} · ${words.now}` : version.who}
                    </span>
                    <span {...stylex.props(styles.what)}>
                      {version.when} · {version.what}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {chosen === undefined ? null : (
              <div {...stylex.props(styles.changes)}>
                <Text size="sm" weight="medium">
                  {latest ? words.isNow : words.since(chosen.who, chosen.when)}
                </Text>
                <Diff
                  mode="inline"
                  head={false}
                  aria-label={words.changes}
                  before={readableText(chosen.markdown)}
                  after={readableText(current)}
                />
              </div>
            )}
          </div>
        </SheetBody>
        {/* Restore stands in the foot, in reach however long the changes run. */}
        <SheetFooter>
          <Button
            size="sm"
            disabled={latest}
            focusableWhenDisabled
            onClick={() => {
              if (chosen !== undefined) {
                onRestore(chosen);
              }
            }}
          >
            {words.restore}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
