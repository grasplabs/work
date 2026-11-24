import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  BrainIcon,
  CircleUserIcon,
  CodeIcon,
  FileIcon,
  Globe2Icon,
  Icon,
  MicIcon,
  TableIcon,
  WandSparklesIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { InvoiceIcon } from "../frame/sidebar-icons.ts";

// One source of the Brain as a row, from the reference's library (#2503's
// `sources/item.tsx`, SourceItem and SourceItemParts): its kind's mark bare
// at the icon's size, its title, and where it lives and when at the end. A
// note of the Brain opens its page (the router's link), else `onOpen` runs (the inspector beside the page). Damsko's Sources is an
// answer's folded list and has no row of a source page: the Brain's own,
// on Damsko's Item.

/** What kind of thing a source is: its mark, and the section it is listed in. */
export type SourceKind =
  | "file"
  | "web"
  | "record"
  | "message"
  | "meeting"
  | "person"
  | "agent"
  | "workflow"
  | "table"
  | "memory"
  | "code";

/** One source as its row shows it. */
export interface Source {
  kind: SourceKind;
  title: string;
  /** Where it lives, quiet after the title. */
  origin?: string;
  /** When it came, after where it lives. */
  when?: string;
  /** The Brain's note it is, whose page the row opens, in this tab. */
  noteId?: string;
}

const styles = stylex.create({
  // The name and where it lives, as the row's one line: the name gives
  // way with an ellipsis, the detail whole at the end. On a phone the
  // detail goes on a line under the name and the name wraps, as the
  // reference's stacking row list has it (Damsko's xs row keeps one line:
  // the registry gap "an xs row in a side panel's card cuts its name").
  words: {
    display: { default: "flex", [media.maxSm]: "block" },
    alignItems: "center",
    gap: space["2"],
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: { default: 0, [media.maxSm]: space["2"] },
  },
  name: {
    display: { default: null, [media.maxSm]: "block" },
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: { default: "nowrap", [media.maxSm]: "normal" },
  },
  // Stacked, the mark stands on the name's line.
  media: {
    alignSelf: { default: null, [media.maxSm]: "flex-start" },
    height: { default: null, [media.maxSm]: size.sidePanelTextLine },
    marginBlockStart: { default: null, [media.maxSm]: space["2"] },
  },
  detail: {
    display: { default: null, [media.maxSm]: "block" },
    marginInlineStart: { default: "auto", [media.maxSm]: 0 },
  },
});

const kindIcons: Record<SourceKind, IconData> = {
  file: FileIcon,
  web: Globe2Icon,
  record: InvoiceIcon,
  message: InvoiceIcon,
  meeting: MicIcon,
  person: CircleUserIcon,
  agent: WandSparklesIcon,
  workflow: WorkflowIcon,
  table: TableIcon,
  memory: BrainIcon,
  code: CodeIcon,
};

/** Where it lives and when. */
const detailOf = (source: Source): string =>
  [source.origin, source.when]
    .filter((words) => words !== undefined && words !== "")
    .join(" · ");

/** One source as a row: its link, else `onOpen`. */
export const SourceItem = ({
  source,
  onOpen,
}: {
  source: Source;
  onOpen?: (() => void) | undefined;
}) => {
  const parts = (
    <>
      <ItemMedia style={styles.media}>
        <Icon icon={kindIcons[source.kind]} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <span {...stylex.props(styles.words)}>
            <span {...stylex.props(styles.name)}>{source.title}</span>
            <ItemDetail style={styles.detail}>{detailOf(source)}</ItemDetail>
          </span>
        </ItemTitle>
      </ItemContent>
    </>
  );
  if (source.noteId !== undefined) {
    return (
      <Item asChild size="xs">
        <Link params={{ noteId: source.noteId }} to="/brain/$noteId">
          {parts}
        </Link>
      </Item>
    );
  }
  return (
    <Item onClick={onOpen} size="xs">
      {parts}
    </Item>
  );
};

/** One source as an Item's parts: its mark bare, its title, and the line under it. */
export const SourceItemParts = ({ source }: { source: Source }) => (
  <>
    <ItemMedia>
      <Icon icon={kindIcons[source.kind]} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{source.title}</ItemTitle>
      <ItemDescription>{detailOf(source)}</ItemDescription>
    </ItemContent>
  </>
);

/**
 * The sources of a page by kind, a section each: the kinds in the order
 * they first come, each kind's sources in the order given.
 */
export const sourcesByKind = (items: readonly Source[]) => {
  const groups = new Map<SourceKind, Source[]>();
  for (const source of items) {
    groups.set(source.kind, [...(groups.get(source.kind) ?? []), source]);
  }
  return [...groups.entries()].map(([kind, sources]) => ({ kind, sources }));
};
