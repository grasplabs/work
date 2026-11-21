// SourceItem: one source as a RowList row (src/components/row-list), for a page of sources such as
// the Brain's Sources, where no answer numbers them: its mark bare at the icon's size, its title, a lock when it is not the
// reader's, whether it may no longer hold, and where it lives and when at the end. A page in the
// product opens through `render` (the router's link, in this tab), an address through `href` in a
// new tab, else `onOpen` runs (the inspector beside the page). Group them by kind in PanelSection.
//
//   <PanelSection label="Meetings" headingLevel={2}>
//     <RowList>{meetings.map((source) => <SourceItem key={source.title} source={source} />)}</RowList>
//   </PanelSection>
"use client";

import * as stylex from "@stylexjs/stylex";

import { Icon, Lock } from "../icons";
import {
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemMedia,
  ItemTitle,
} from "../item";
import { RowListItem } from "../row-list";
import { useWords, withGiven } from "../words/words";
import { Face } from "./mark";
import { accessOf, hasWords, kindOf } from "./source";
import { sourceStyles as styles } from "./styles";
import type { Source, SourceKind, SourcesLabels } from "./types";
import { sourcesWords } from "./words";

/** Every prop a SourceItem takes. */
export interface SourceItemProps {
  /** The source, as Sources takes it: `render` or `href` makes the row its link. */
  source: Source;
  /** Runs when the row is pressed and the source has no link: open it beside the page. */
  onOpen?: (source: Source) => void;
  /** Any of Sources' words, in place of the product's own (the lock's name). */
  labels?: Partial<SourcesLabels>;
}

/**
 * Where a source's row leads, for a RowListItem or an Item: the router's link (`render`), else its
 * address in a new tab; null for one with neither, or one the reader cannot open.
 */
export const sourceLinkOf = (source: Source) => {
  if (accessOf(source) !== "open") {
    return null;
  }
  if (source.render !== undefined) {
    return { render: source.render, href: source.href };
  }
  return hasWords(source.href)
    ? {
        href: source.href,
        render: (
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer"
            aria-label={source.title}
          />
        ),
      }
    : null;
};

/** The row's one press: its link, else `onOpen`. Nothing for a source the reader cannot open. */
const pressOf = (source: Source, onOpen: SourceItemProps["onOpen"]) => {
  const link = sourceLinkOf(source);
  if (link !== null || accessOf(source) !== "open") {
    return link ?? {};
  }
  return onOpen === undefined
    ? {}
    : {
        onPress: () => {
          onOpen(source);
        },
      };
};

/** Where it lives and when, after whether it may no longer hold. */
const Detail = ({ source }: { source: Source }) =>
  hasWords(source.stale) ? (
    <>
      <span data-slot="source-stale" {...stylex.props(styles.stale)}>
        {source.stale}
      </span>
      {[" ", source.origin, source.when].filter(hasWords).join(" · ")}
    </>
  ) : (
    [source.origin, source.when].filter(hasWords).join(" · ")
  );

/** One source as a row. */
export const SourceItem = ({ source, onOpen, labels }: SourceItemProps) => {
  const words = withGiven(useWords("sources", sourcesWords), labels ?? {});
  const access = accessOf(source);
  return (
    <RowListItem
      media={<Face source={source} size="pile" />}
      name={source.title}
      mark={
        access === "locked" ? (
          <Icon icon={Lock} label={words.locked} />
        ) : undefined
      }
      detail={<Detail source={source} />}
      {...pressOf(source, onOpen)}
    />
  );
};

/** Every prop SourceItemParts takes. */
export interface SourceItemPartsProps {
  source: Source;
  /** Any of Sources' words, in place of the product's own (the lock's name). */
  labels?: Partial<SourcesLabels>;
}

/**
 * One source as an Item's parts: its mark bare, its title (and a lock), and the line under it. The
 * Item around it takes the link: `<Item {...sourceLinkOf(source)}>`.
 */
export const SourceItemParts = ({ source, labels }: SourceItemPartsProps) => {
  const words = withGiven(useWords("sources", sourcesWords), labels ?? {});
  return (
    <>
      <ItemMedia iconLook="inline">
        <Face source={source} size="pile" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {source.title}
          {accessOf(source) === "locked" ? (
            <ItemDetail>
              <span {...stylex.props(styles.lock)}>
                <Icon icon={Lock} label={words.locked} />
              </span>
            </ItemDetail>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          <Detail source={source} />
        </ItemDescription>
      </ItemContent>
    </>
  );
};

/**
 * The sources of a page by kind, for a PanelSection each: the kinds in the order they first come,
 * each kind's sources in the order given (newest first, as the host sorts them).
 */
export const sourcesByKind = (items: readonly Source[]) => {
  const groups = new Map<SourceKind, Source[]>();
  for (const source of items) {
    const kind = kindOf(source);
    groups.set(kind, [...(groups.get(kind) ?? []), source]);
  }
  return [...groups.entries()].map(([kind, sources]) => ({ kind, sources }));
};
