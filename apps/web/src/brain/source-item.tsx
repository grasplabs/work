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
  ClipboardListIcon,
  FileIcon,
  GlobeIcon,
  Icon,
  MicIcon,
  TableIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

// One source of the Brain as a row, for its Sources page, where no answer
// numbers them: its kind's mark, its title, and where it lives and when,
// quiet, after it. One with a page of its own opens it (`noteId`, the
// router's link, in this tab); else `onOpen` runs (the inspector beside the
// page). The rows are grouped by kind (`sourcesByKind`), a section each.

/** What a source is, which chooses its mark and the section it is listed under. */
export type SourceKind =
  | "file"
  | "web"
  | "record"
  | "message"
  | "meeting"
  | "person"
  | "workflow"
  | "table"
  | "memory";

/** One source, as its row shows it. */
export interface SourceRow {
  kind: SourceKind;
  /** Its title, as the thing calls itself. */
  title: string;
  /** Where it lives, in a few quiet words. */
  origin: string;
  /** When it came in. */
  when?: string;
  /** Its own page in the brain, opened in this tab at its own address. */
  noteId?: string;
}

const kindIcons: Record<SourceKind, IconData> = {
  file: FileIcon,
  web: GlobeIcon,
  record: ClipboardListIcon,
  message: ClipboardListIcon,
  meeting: MicIcon,
  person: CircleUserIcon,
  workflow: WorkflowIcon,
  table: TableIcon,
  memory: BrainIcon,
};

// A side panel's card keeps an `xs` row's detail whole at its end and cuts the name to what is
// left, which on a phone is a few letters. Here the name and the detail are words of their own,
// laid out as the card does, so the name wraps, never cut; on a phone the detail is the line under
// the name, as in #2503.
const styles = stylex.create({
  words: {
    display: { default: "flex", [media.maxSm]: "block" },
    flexGrow: 1,
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
  },
  detail: { display: { default: null, [media.maxSm]: "block" } },
});

/** Where it lives and when, in one quiet line. */
const detailOf = (source: SourceRow): string =>
  [source.origin, source.when]
    .filter((words) => words !== undefined && words !== "")
    .join(" · ");

/** One source as a row: its link, else `onOpen`. */
export const SourceItem = ({
  source,
  onOpen,
}: {
  source: SourceRow;
  onOpen?: (() => void) | undefined;
}) => {
  const parts = (
    <>
      <ItemMedia>
        <Icon icon={kindIcons[source.kind]} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <span {...stylex.props(styles.words)}>
            {source.title}
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
    <Item size="xs" {...(onOpen === undefined ? {} : { onClick: onOpen })}>
      {parts}
    </Item>
  );
};

/** One source as an Item's parts: its mark, its title, and the line under it. */
export const SourceItemParts = ({ source }: { source: SourceRow }) => (
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
 * The sources by kind, for a section each: the kinds in the order they first come, each kind's
 * sources in the order given (newest first, as the page sorts them).
 */
export const sourcesByKind = (items: readonly SourceRow[]) => {
  const groups = new Map<SourceKind, SourceRow[]>();
  for (const source of items) {
    groups.set(source.kind, [...(groups.get(source.kind) ?? []), source]);
  }
  return [...groups.entries()].map(([kind, sources]) => ({ kind, sources }));
};
