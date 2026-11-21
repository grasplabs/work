// The viewer's toolbar: the file's name and kind, where you are, zoom, find, download and the
// shortcuts. Quiet, on one line. The name has the room first: before it is cut short, the kind
// goes, then where you are, then the zoom, into a menu; below 560px of the viewer's width the
// rest of the quiet controls go there too, so every action keeps a named control.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { Button } from "../button/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import {
  ChevronDown,
  ChevronUp,
  Comment,
  CommentAdd,
  Cross,
  Download,
  Fit,
  Keyboard,
  ListView,
  More,
  Search,
  ZoomIn,
  ZoomOut,
} from "../icons";
import { Input } from "../input/input";
import { Toggle, ToggleGroup } from "../toggle";
import { grasp, media } from "../tokens/tokens.stylex";
import type { ArtifactViewerLabels } from "./types";

const NARROW = "@container viewer (max-width: 560px)";

const styles = stylex.create({
  // The controls after the name: a box for the bar's layout only, its parts laid out as before.
  controls: {
    display: "contents",
  },
  // Until the file says its sections: unseen, in place.
  settling: {
    visibility: "hidden",
  },
  head: { display: "grid", minWidth: 0 },
  // Under the bar while find is open, where find works differently: one quiet line.
  hint: {
    margin: 0,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space4,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    backgroundColor: grasp.raised,
    boxShadow: `inset 0 calc(-1 * ${grasp.hairline}) 0 ${grasp.line}`,
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    minHeight: grasp.viewerToolbarHeight,
    paddingInline: grasp.space2,
    backgroundColor: grasp.raised,
    // A hairline below, with clear space on both sides: nothing in the bar touches it. Forced
    // colours drop the shadow, so a real border draws it there.
    boxShadow: `inset 0 calc(-1 * ${grasp.hairline}) 0 ${grasp.line}`,
    borderBlockEndWidth: { default: 0, [media.forced]: grasp.hairline },
    borderBlockEndStyle: "solid",
    borderBlockEndColor: "CanvasText",
  },
  // With find open in a narrow viewer, find takes the whole bar.
  nameAway: { display: { default: "flex", [NARROW]: "none" } },
  name: {
    display: "flex",
    alignItems: "baseline",
    gap: grasp.space2,
    minWidth: 0,
    flexGrow: 1,
    paddingInline: grasp.space2,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  file: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  kind: { flexShrink: 0, color: grasp.muted },
  // Where you are gives way before the buttons: a long heading ends in an ellipsis.
  position: {
    minWidth: 0,
    flexShrink: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // With the preview and code switch in a narrow viewer, the kind gives way (the name's title says it).
  kindAway: { display: { default: "inline", [NARROW]: "none" } },
  // With the switch, where you are gives way before the name does.
  positionAway: {
    display: {
      default: "inline",
      "@container viewer (max-width: 760px)": "none",
    },
  },
  viewSlot: { display: "flex", alignItems: "center", flexShrink: 0 },
  // A note on the file (a table's rows that did not read cleanly): quiet, and the first to go.
  note: {
    display: { default: "inline", [NARROW]: "none" },
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.muted,
  },
  group: {
    display: { default: "flex", [NARROW]: "none" },
    minWidth: 0,
    alignItems: "center",
    gap: grasp.space1,
  },
  // Never squeezed: the name gives way first.
  narrowOnly: { display: { default: "none", [NARROW]: "flex" }, flexShrink: 0 },
  // Folded into the menu so the name is not cut, or shown because something is folded into it.
  folded: { display: "none" },
  unfolded: { display: "flex" },
  words: {
    paddingInline: grasp.space1,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  find: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    flexShrink: 1,
    flexGrow: { default: 0, [NARROW]: 1 },
  },
  input: {
    width: "14rem",
    minWidth: "6rem",
    flexShrink: 1,
    flexGrow: { default: 0, [NARROW]: 1 },
  },
  count: { flexShrink: 0 },
  // The comments button, with how many are open on it.
  counted: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
  },
  // How many comments are open: in the comments' own mint, so it reads as theirs.
  commentCount: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: grasp.space5,
    height: grasp.space5,
    paddingInline: grasp.space1,
    boxSizing: "border-box",
    borderRadius: grasp.cornerMark,
    backgroundColor: { default: grasp.viewerComment, [media.forced]: "Mark" },
    color: { default: grasp.ink, [media.forced]: "MarkText" },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  rule: {
    width: grasp.hairline,
    height: grasp.space5,
    marginInline: grasp.space1,
    backgroundColor: grasp.line,
    flexShrink: 0,
  },
});

// The file, saved as its name: what the Download button's link does, from the menu.
const download = (href: string | null, name: string) => {
  if (href === null || href === "") {
    return;
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
};

type ViewMode = "preview" | "code";

/** The outline: open or not, and its switch. */
interface OutlineToggle {
  open: boolean;
  onToggle: () => void;
}

/** Comments: the panel open or not, how many are open, and its switch. */
interface CommentsToggle {
  open: boolean;
  count: number;
  onToggle: () => void;
}

/** Whether a page's preview or its source shows, and the switch. */
interface ViewSwitch {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export interface ToolbarProps {
  /** The file is opening, or its renderer has not yet said its sections: the controls hold their room unseen. */
  settling?: boolean;
  /** The words it shows and says. */
  labels: ArtifactViewerLabels;
  name: string;
  kind: string;
  /** A short note on the file, after its kind. */
  note?: string;
  /** A line under find, while it is open: where its matches are marked, when not in the file. */
  findNote?: string;
  /** With comments on: comment on the match find is on, so a comment can be made by keyboard alone. */
  onCommentMatch?: () => void;
  /** The outline: open or not. Only when the file has headings or pages. */
  outline?: OutlineToggle;
  /** Comments: the panel open or not, and how many are open. Only when comments are on. */
  comments?: CommentsToggle;
  /** For a web page or Markdown: whether its preview or its source shows, and the switch. */
  view?: ViewSwitch;
  position: string;
  canJump: boolean;
  onPrevious: () => void;
  onNext: () => void;
  zoom: number | "fit";
  zoomLabel: string;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  findOpen: boolean;
  find: string;
  matches: number;
  /** More matches than were counted. */
  capped: boolean;
  match: number;
  onFindOpen: () => void;
  onFind: (value: string) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onFindClose: () => void;
  findField: RefObject<HTMLInputElement | null>;
  /** The file's object URL, once it has opened. */
  download: string | null;
  onHelp: () => void;
}

/** What a string holds, if anything. */
const filled = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== "";

// Where find is: which match of how many, or none, or nothing while there are no words.
const countWords = (
  find: string,
  matches: number,
  match: number,
  capped: boolean,
  labels: ArtifactViewerLabels
) => {
  if (find.trim() === "") {
    return "";
  }
  if (matches === 0) {
    return labels.noMatches;
  }
  return labels.matchCount(match + 1, matches, capped);
};

// Finds the fold again whenever the bar's width changes. A web font that arrives after the bar was
// measured changes the name's width and not the bar's: the fold is found again then too, so a name
// measured in the fallback font is not left cut, nor the kind left folded away with room to spare.
const watchBar = (element: HTMLElement, again: () => void) => {
  let width = element.clientWidth;
  const watcher = new ResizeObserver(() => {
    if (element.clientWidth === width) {
      return;
    }
    width = element.clientWidth;
    again();
  });
  watcher.observe(element);
  document.fonts.addEventListener("loadingdone", again);
  return () => {
    watcher.disconnect();
    document.fonts.removeEventListener("loadingdone", again);
  };
};

// The next step of the fold, from the name as it is drawn now: one more while the name is cut, and
// the switch too while the name is still cut: a whole name tells which file this is, and the switch
// stays in the More menu. While find is open, nothing more folds.
const foldFor = (
  name: HTMLElement | null,
  fold: number,
  canSwitch: boolean,
  findOpen: boolean
) => {
  if (name === null || findOpen) {
    return fold;
  }
  if (fold < 3 && name.scrollWidth > name.clientWidth + 1) {
    return fold + 1;
  }
  if (fold === 3 && canSwitch && name.scrollWidth > name.clientWidth + 1) {
    return 4;
  }
  return fold;
};

interface FileNameProps {
  name: string;
  kind: string;
  note: string | undefined;
  view: ViewSwitch | undefined;
  findOpen: boolean;
  fold: number;
  fileRef: RefObject<HTMLSpanElement | null>;
}

const FileName = ({
  name,
  kind,
  note,
  view,
  findOpen,
  fold,
  fileRef,
}: FileNameProps) => (
  <div {...stylex.props(styles.name, findOpen && styles.nameAway)}>
    <span
      ref={fileRef}
      {...stylex.props(styles.file)}
      title={[name, view ? kind : "", note ?? ""].filter(Boolean).join(", ")}
    >
      {name}
    </span>
    <span
      {...stylex.props(
        styles.kind,
        view && styles.kindAway,
        fold >= 1 && styles.folded
      )}
    >
      {kind}
    </span>
    {filled(note) ? (
      <span title={note} {...stylex.props(styles.note)}>
        {note}
      </span>
    ) : null}
  </div>
);

interface ViewToggleProps {
  view: ViewSwitch;
  findOpen: boolean;
  fold: number;
  labels: ArtifactViewerLabels;
}

// Preview or code: its own slot, so the name gives way first.
const ViewToggle = ({ view, findOpen, fold, labels }: ViewToggleProps) => (
  <div
    {...stylex.props(
      styles.viewSlot,
      findOpen && styles.nameAway,
      fold >= 4 && styles.folded
    )}
  >
    <ToggleGroup
      aria-label={labels.view}
      size="sm"
      value={[view.mode]}
      deselectable={false}
      onValueChange={(values) => {
        const [next] = values;
        if (next === "preview" || next === "code") {
          view.onChange(next);
        }
      }}
    >
      <Toggle value="preview" aria-keyshortcuts="v">
        {labels.preview}
      </Toggle>
      <Toggle value="code" aria-keyshortcuts="v">
        {labels.code}
      </Toggle>
    </ToggleGroup>
  </div>
);

type FindBarProps = Pick<
  ToolbarProps,
  | "labels"
  | "find"
  | "matches"
  | "onCommentMatch"
  | "onFind"
  | "onFindNext"
  | "onFindPrevious"
  | "onFindClose"
  | "findField"
> & {
  counted: string;
  hintId: string | undefined;
};

const FindBar = ({ findField, counted, hintId, ...props }: FindBarProps) => (
  <search {...stylex.props(styles.find)}>
    <div {...stylex.props(styles.input)}>
      <Input
        ref={findField}
        size="sm"
        type="search"
        aria-label={props.labels.find}
        aria-describedby={hintId}
        value={props.find}
        onValueChange={(value) => {
          props.onFind(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              props.onFindPrevious();
            } else {
              props.onFindNext();
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onFindClose();
          }
        }}
      />
    </div>
    <span aria-live="polite" {...stylex.props(styles.words, styles.count)}>
      {counted}
    </span>
    <Button
      variant="ghost"
      size="sm"
      icon={ChevronUp}
      aria-label={props.labels.previousMatch}
      onClick={props.onFindPrevious}
      disabled={props.matches === 0}
    />
    <Button
      variant="ghost"
      size="sm"
      icon={ChevronDown}
      aria-label={props.labels.nextMatch}
      onClick={props.onFindNext}
      disabled={props.matches === 0}
    />
    {props.onCommentMatch ? (
      <Button
        variant="ghost"
        size="sm"
        icon={CommentAdd}
        aria-label={props.labels.commentOnMatch}
        aria-keyshortcuts="c"
        onClick={props.onCommentMatch}
        disabled={props.matches === 0}
      />
    ) : null}
    <Button
      variant="ghost"
      size="sm"
      icon={Cross}
      aria-label={props.labels.closeFind}
      onClick={props.onFindClose}
    />
  </search>
);

type MoveGroupProps = Pick<
  ToolbarProps,
  "labels" | "position" | "canJump" | "onPrevious" | "onNext" | "view"
> & { fold: number };

// Nothing to move through and nothing to say (a web page, an image): no buttons.
const MoveGroup = ({ fold, ...props }: MoveGroupProps) =>
  props.canJump || props.position !== "" ? (
    <div {...stylex.props(styles.group, fold >= 2 && styles.folded)}>
      <Button
        variant="ghost"
        size="sm"
        icon={ChevronUp}
        aria-label={props.labels.previousSection}
        onClick={props.onPrevious}
        disabled={!props.canJump}
      />
      <span
        title={filled(props.position) ? props.position : undefined}
        {...stylex.props(
          styles.words,
          styles.position,
          props.view && styles.positionAway
        )}
      >
        {props.position}
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={ChevronDown}
        aria-label={props.labels.nextSection}
        onClick={props.onNext}
        disabled={!props.canJump}
      />
      <span aria-hidden="true" {...stylex.props(styles.rule)} />
    </div>
  ) : null;

type ZoomGroupProps = Pick<
  ToolbarProps,
  "labels" | "zoomLabel" | "onZoomIn" | "onZoomOut" | "onZoomReset"
> & { fold: number };

const ZoomGroup = ({ fold, ...props }: ZoomGroupProps) => (
  <div {...stylex.props(styles.group, fold >= 3 && styles.folded)}>
    <Button
      variant="ghost"
      size="sm"
      icon={ZoomOut}
      aria-label={props.labels.zoomOut}
      onClick={props.onZoomOut}
    />
    <span {...stylex.props(styles.words)}>{props.zoomLabel}</span>
    <Button
      variant="ghost"
      size="sm"
      icon={ZoomIn}
      aria-label={props.labels.zoomIn}
      onClick={props.onZoomIn}
    />
    <Button
      variant="ghost"
      size="sm"
      icon={Fit}
      aria-label={props.labels.zoomToFit}
      onClick={props.onZoomReset}
    />
    <span aria-hidden="true" {...stylex.props(styles.rule)} />
  </div>
);

const OutlineButton = ({
  outline,
  labels,
}: {
  outline: OutlineToggle;
  labels: ArtifactViewerLabels;
}) => {
  const { open, onToggle: handleToggle } = outline;
  return (
    <div {...stylex.props(styles.group)}>
      <Button
        variant="ghost"
        size="sm"
        icon={ListView}
        aria-label={open ? labels.hideOutline : labels.showOutline}
        aria-pressed={open}
        aria-keyshortcuts="o"
        onClick={handleToggle}
      />
    </div>
  );
};

const CommentsButton = ({
  comments,
  labels,
}: {
  comments: CommentsToggle;
  labels: ArtifactViewerLabels;
}) => {
  const { open, count, onToggle: handleToggle } = comments;
  return (
    <div {...stylex.props(styles.counted)}>
      <Button
        variant="ghost"
        size="sm"
        icon={Comment}
        aria-label={labels.commentsButton(open, count)}
        aria-pressed={open}
        aria-keyshortcuts="shift+c"
        onClick={handleToggle}
      />
      {count > 0 ? (
        <span
          aria-hidden="true"
          data-slot="artifact-viewer-comment-count"
          {...stylex.props(styles.commentCount)}
        >
          {count}
        </span>
      ) : null}
    </div>
  );
};

const DownloadButton = ({
  href,
  name,
  labels,
}: {
  href: string | null;
  name: string;
  labels: ArtifactViewerLabels;
}) => (
  <div {...stylex.props(styles.group)}>
    {filled(href) ? (
      <Button
        variant="ghost"
        size="sm"
        icon={Download}
        aria-label={labels.download(name)}
        render={
          <a href={href} download={name} aria-label={labels.download(name)} />
        }
      />
    ) : (
      <Button
        variant="ghost"
        size="sm"
        icon={Download}
        aria-label={labels.download(name)}
        disabled
      />
    )}
  </div>
);

type MoreMenuProps = Pick<
  ToolbarProps,
  | "labels"
  | "name"
  | "note"
  | "outline"
  | "view"
  | "canJump"
  | "onPrevious"
  | "onNext"
  | "onZoomIn"
  | "onZoomOut"
  | "onZoomReset"
  | "download"
  | "onHelp"
> & {
  fold: number;
};

// In a narrow viewer, in the menu: with the preview switch and comments, the bar has no room.
const MoreMenu = ({ fold, outline, view, labels, ...props }: MoreMenuProps) => (
  <div {...stylex.props(styles.narrowOnly, fold >= 2 && styles.unfolded)}>
    <DropdownMenu>
      <DropdownMenuTrigger
        variant="ghost"
        size="sm"
        icon={More}
        aria-label={labels.more}
      />
      {/* Its end on the trigger's, the bar's last control: centred, it hung past the card. */}
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={ChevronUp}
          onSelect={props.onPrevious}
          disabled={!props.canJump}
        >
          {labels.previousSection}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={ChevronDown}
          onSelect={props.onNext}
          disabled={!props.canJump}
        >
          {labels.nextSection}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={ZoomIn}
          onSelect={props.onZoomIn}
          closeOnSelect={false}
        >
          {labels.zoomIn}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={ZoomOut}
          onSelect={props.onZoomOut}
          closeOnSelect={false}
        >
          {labels.zoomOut}
        </DropdownMenuItem>
        <DropdownMenuItem icon={Fit} onSelect={props.onZoomReset}>
          {labels.zoomToFit}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {filled(props.note) ? (
          <>
            <DropdownMenuItem disabled>{props.note}</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {outline ? (
          <DropdownMenuItem
            icon={ListView}
            onSelect={() => {
              outline.onToggle();
            }}
          >
            {outline.open ? labels.hideOutline : labels.showOutline}
          </DropdownMenuItem>
        ) : null}
        {view && fold >= 4 ? (
          <DropdownMenuItem
            onSelect={() => {
              view.onChange(view.mode === "preview" ? "code" : "preview");
            }}
          >
            {view.mode === "preview" ? labels.showCode : labels.showPreview}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          icon={Download}
          onSelect={() => {
            download(props.download, props.name);
          }}
          disabled={!filled(props.download)}
        >
          {labels.download(props.name)}
        </DropdownMenuItem>
        <DropdownMenuItem icon={Keyboard} onSelect={props.onHelp}>
          {labels.shortcuts}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

type ControlsProps = Omit<ToolbarProps, "findField"> & { fold: number };

// The bar's controls while find is closed.
const Controls = (props: ControlsProps) => (
  <>
    <MoveGroup {...props} />
    <ZoomGroup {...props} />
    {props.outline ? (
      <OutlineButton outline={props.outline} labels={props.labels} />
    ) : null}
    <Button
      variant="ghost"
      size="sm"
      icon={Search}
      aria-label={props.labels.find}
      onClick={props.onFindOpen}
    />
    {props.comments ? (
      <CommentsButton comments={props.comments} labels={props.labels} />
    ) : null}
    <DownloadButton
      href={props.download}
      name={props.name}
      labels={props.labels}
    />
    <div {...stylex.props(styles.group)}>
      <Button
        variant="ghost"
        size="sm"
        icon={Keyboard}
        aria-label={props.labels.shortcuts}
        onClick={props.onHelp}
      />
    </div>
    <MoreMenu {...props} />
  </>
);

export const Toolbar = ({ findField, ...props }: ToolbarProps) => {
  const counted = countWords(
    props.find,
    props.matches,
    props.match,
    props.capped,
    props.labels
  );
  const hint = props.findOpen && filled(props.findNote) ? props.findNote : "";
  const hintId = useId();
  // How much is folded away so the name is whole: 0 nothing, 1 the kind, 2 also where you are, 3
  // also the zoom; 4, when even then the name has almost no room, also the preview and code switch.
  // Found again whenever the bar's width or its words change, before it is drawn: each step is
  // tried and the name measured, from nothing folded up.
  const bar = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLSpanElement>(null);
  const [measure, setMeasure] = useState(0);
  useLayoutEffect(() => {
    const element = bar.current;
    const again = () => {
      setMeasure((count) => count + 1);
    };
    return element === null ? undefined : watchBar(element, again);
  }, []);
  // What the fold was found for: a new width or new words start from nothing folded. Where you are
  // counts by its length only: it changes at every frame of a scroll, and measuring the bar each
  // time cost a 100,000-row table its frame rate.
  const key = `${measure}|${props.name}|${props.kind}|${props.note ?? ""}|${props.position.length}|${props.zoomLabel}|${props.view?.mode ?? ""}|${props.comments?.count ?? ""}|${props.findOpen}`;
  const [found, setFound] = useState({ key: "", fold: 0 });
  const fold = found.key === key ? found.fold : 0;
  const settled = found.key === key;
  const canSwitch = props.view !== undefined;
  const { findOpen } = props;
  useLayoutEffect(() => {
    const next = foldFor(file.current, fold, canSwitch, findOpen);
    if (next !== fold || !settled) {
      setFound({ key, fold: next });
    }
  }, [key, fold, settled, canSwitch, findOpen]);
  return (
    <div {...stylex.props(styles.head)}>
      <div ref={bar} {...stylex.props(styles.bar)}>
        <FileName
          name={props.name}
          kind={props.kind}
          note={props.note}
          view={props.view}
          findOpen={props.findOpen}
          fold={fold}
          fileRef={file}
        />
        <span
          data-slot="artifact-viewer-controls"
          data-settling={props.settling === true ? "" : undefined}
          {...stylex.props(
            styles.controls,
            props.settling === true && styles.settling
          )}
        >
          {props.view ? (
            <ViewToggle
              view={props.view}
              findOpen={props.findOpen}
              fold={fold}
              labels={props.labels}
            />
          ) : null}
          {props.findOpen ? (
            <FindBar
              {...props}
              findField={findField}
              counted={counted}
              hintId={hint === "" ? undefined : hintId}
            />
          ) : (
            <Controls {...props} fold={fold} />
          )}
        </span>
      </div>
      {hint === "" ? null : (
        <p id={hintId} {...stylex.props(styles.hint)}>
          {hint}
        </p>
      )}
    </div>
  );
};
