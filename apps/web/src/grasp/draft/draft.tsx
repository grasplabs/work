// Draft: the frame every draft in an answer shares (an event, an email, and the kinds after them).
// The agent made something the person can still change and then make real: it stands in the
// answer's column, in the chat's words (chat-text), on the raised ground with one edge, and no
// card inside it. A head (the kind's icon, or the host's own mark for the service, and its title),
// the kind's fields, then a foot: the quiet way out at its start, the one main action at its end.
//
//   <Draft icon={CalendarIcon} title={…} main={{ label: "Create event", onPress: create }} onDismiss={dismiss}>
//     …the kind's fields…
//   </Draft>
//
// A kind (EventDraft, EmailDraft) is its fields on this frame and its main action's words. Every
// value is a token (src/tokens); every word comes from the catalogue (words.ts) or the caller.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { Button } from "../button";
import { visuallyHidden } from "../hidden/hidden";
import { Cross, Icon, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { draftWords } from "./words";
import type { DraftWords } from "./words";

/** A person in a draft: an event's guest, an email's addressee. */
export interface DraftPerson {
  /** Their name, as it is shown ("Jerry van der Horst"). */
  name: string;
  /** Their address, when the draft needs one. */
  email?: string;
  /** Their picture's address; left out, their initials. */
  picture?: string;
  /** The person looking: shown as "You" where it names a lane. */
  you?: boolean;
}

/** The one main action at the foot's end. */
export interface DraftMain {
  label: string;
  onPress: () => unknown;
}

/** Every prop a Draft takes. */
export interface DraftProps {
  /** The kind's icon in the head. */
  icon?: IconData;
  /** The service's own mark in the icon's place (a BrandIcon), when the draft goes there. */
  mark?: ReactNode;
  /** The head's title: the draft's name, often a quiet field the person can change. */
  title: ReactNode;
  /** The kind's fields. */
  children: ReactNode;
  /** The one main action, at the foot's end (Create event, Send). */
  main: DraftMain;
  /** Quiet actions after Discard, at the foot's start (Open in calendar). */
  secondary?: ReactNode;
  /** Discard, the quiet way out at the foot's start (a cross at a phone's width, the same name). Left out, none. */
  onDismiss?: () => void;
  /**
   * Where the draft is: `drafting` while the agent still writes it (its fields as they come, the
   * main action off), `ready`, `sending` (the main action works in place), `sent` (the ways out
   * give way to one line: `done`, then Undo while `onUndo` is given), `failed` (said on the main
   * action, press again), or `dismissed` (folded to one line, with Restore while `onRestore` is
   * given). The frame keeps its height from ready through sending and sent.
   * @default "ready"
   */
  status?: DraftStatus;
  /** The line once made ("Added to the calendar · 14:02"), from the kind. */
  done?: string;
  /** Undo, on the sent line: given for as long as the host can undo. The frame never pretends it can. */
  onUndo?: () => void;
  /** Restore, on the dismissed line: given for as long as the host can bring it back. */
  onRestore?: () => void;
  /** The draft's name for a screen reader: the kind and the title ("Event: Ruben and Jerry"). */
  "aria-label": string;
}

/** Where a draft is. */
export type DraftStatus =
  | "drafting"
  | "ready"
  | "sending"
  | "sent"
  | "failed"
  | "dismissed";

/** Whether the person can still change the draft: ready, or failed and to be sent again. */
export const draftEditable = (status: DraftStatus) =>
  status === "ready" || status === "failed";

/** The main action's life, from the draft's status. */
const lifeOf = (status: DraftStatus) => {
  if (status === "sending") {
    return "working";
  }
  return status === "failed" ? "failed" : "idle";
};

/**
 * One field's change, for a kind's draft: undefined while the draft cannot change, so the field
 * is read only; else a setter that hands the whole draft on with that field changed.
 */
export const fieldOf =
  <T extends object>(
    draft: T,
    onDraftChange: ((draft: T) => void) | undefined,
    status: DraftStatus
  ) =>
  <K extends keyof T>(key: K): ((value: T[K]) => void) | undefined =>
    onDraftChange === undefined || !draftEditable(status)
      ? undefined
      : (value) => {
          onDraftChange({ ...draft, [key]: value });
        };

const NARROW = "@container draft (width < 30rem)";

const styles = stylex.create({
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    containerType: "inline-size",
    containerName: "draft",
    display: "grid",
    width: "100%",
    maxWidth: grasp.draftWidth,
    boxSizing: "border-box",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    overflow: "clip",
    fontFamily: grasp.fontSans,
    fontSize: grasp.chatText,
    lineHeight: grasp.chatTextLine,
    color: grasp.ink,
  },
  // The title may wrap: the icon stays on its first line.
  head: {
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    minWidth: 0,
    paddingBlockStart: grasp.space3,
    paddingInline: { default: grasp.space4, [NARROW]: grasp.space3 },
  },
  mark: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    height: grasp.chatTextLine,
    color: grasp.muted,
  },
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: grasp.space3,
    paddingBlock: grasp.space3,
    paddingInline: { default: grasp.space4, [NARROW]: grasp.space3 },
  },
  foot: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space2,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  // The main action never gives way: its words stay on one line; the quiet ones beside it give way first.
  main: { flexShrink: 0, marginInlineStart: "auto" },
  mainButton: { minWidth: "fit-content" },
  // Discard in words where there is room; in a narrow draft (a phone) a small cross, its name kept.
  wide: { display: { default: "inline-flex", [NARROW]: "none" } },
  narrow: { display: { default: "none", [NARROW]: "inline-flex" } },
  // Dismissed: one quiet line where the draft stood.
  folded: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
    paddingBlock: grasp.space2,
    paddingInlineStart: grasp.space4,
    paddingInlineEnd: grasp.space2,
  },
  line: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    color: grasp.muted,
  },
  // The sent line keeps the foot's height and its start inset (a ghost button's own inset).
  doneFoot: {
    minHeight: `calc(${grasp.controlSm} + 2 * ${grasp.space2})`,
    boxSizing: "border-box",
    paddingInlineStart: grasp.space4,
  },
  done: { color: grasp.ink },
  // A row of fields: its icon, then what it holds, on the chat's line.
  row: {
    display: "grid",
    gridTemplateColumns: `${grasp.iconSm} minmax(0, 1fr)`,
    alignItems: "start",
    columnGap: grasp.space3,
    minWidth: 0,
    color: grasp.ink,
  },
  rowIcon: {
    display: "flex",
    alignItems: "center",
    height: grasp.chatTextLine,
    color: grasp.muted,
  },
  rowBody: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
  },
  // A person: a pill (the plain full radius) with their face, their name and a round remove, as
  // Share access picks them.
  person: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    maxWidth: "100%",
    height: grasp.controlXs,
    boxSizing: "border-box",
    paddingInlineStart: grasp.space1,
    paddingInlineEnd: grasp.space2,
    borderRadius: grasp.cornerPill,
    cornerShape: "round",
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.ink,
  },
  personRemovable: { paddingInlineEnd: 0 },
  personName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  remove: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.controlXs,
    height: grasp.controlXs,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: { default: "transparent", ":hover": grasp.ghostFillHover },
    color: grasp.muted,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `${grasp.ringWidth} solid ${grasp.ring}`,
    },
  },
  // A quiet field: words on the card that can be changed in place, with no box until it is used.
  field: {
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    outline: "none",
    appearance: "none",
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: { default: "inherit", [media.typing]: grasp.fieldTextTouch },
    lineHeight: "inherit",
    color: grasp.ink,
    caretColor: grasp.ink,
    borderRadius: grasp.cornerMark,
    boxShadow: {
      default: "none",
      ":focus-visible": `0 0 0 ${grasp.ringWidth} ${grasp.ring}`,
    },
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  title: { fontWeight: grasp.weightMedium },
  // A field that grows with its words (a description), never scrolling inside.
  grows: {
    resize: "none",
    fieldSizing: "content",
    minHeight: grasp.chatTextLine,
  },
});

/**
 * The drafts' words for one group: the product's catalogue (GraspWords), each key over its English
 * on its own, so a catalogue written before a group gained a key still has it.
 */
export const useDraftWords = <G extends keyof DraftWords>(
  group: G
): DraftWords[G] => {
  const given: Partial<DraftWords[G]> = useWords("draft", draftWords)[group];
  // oxlint-disable-next-line unicorn/prefer-object-spread, prefer-object-spread -- each group's type is its own object, which a generic spread cannot know
  return Object.assign({}, draftWords[group], given);
};

/** A person's face: their picture, else their initials; their name stands beside it. */
export const DraftFace = ({ person }: { person: DraftPerson }) => (
  <Avatar name={person.name} size="2xs" decorative>
    {person.picture === undefined ? null : <AvatarImage src={person.picture} />}
    <AvatarFallback />
  </Avatar>
);

/** A row of a draft's fields: its icon, then what it holds. Its name is said before what it holds. */
export const DraftRow = ({
  icon,
  label,
  children,
}: {
  icon: IconData;
  label: string;
  children: ReactNode;
}) => (
  <div data-slot="draft-row" {...stylex.props(styles.row)}>
    <span {...stylex.props(styles.rowIcon)}>
      <Icon icon={icon} />
      <span {...stylex.props(visuallyHidden)}>{label}</span>
    </span>
    <div {...stylex.props(styles.rowBody)}>{children}</div>
  </div>
);

/** A person as a chip: their face and name, and a remove when the draft can still lose them. */
export const DraftPersonChip = ({
  person,
  onRemove,
}: {
  person: DraftPerson;
  onRemove?: () => void;
}) => {
  const words = useDraftWords("frame");
  return (
    <span
      data-slot="draft-person"
      title={person.email}
      {...stylex.props(
        styles.person,
        onRemove !== undefined && styles.personRemovable
      )}
    >
      <DraftFace person={person} />
      <span {...stylex.props(styles.personName)}>{person.name}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          aria-label={words.remove(person.name)}
          onClick={onRemove}
          {...stylex.props(styles.remove)}
        >
          <Icon icon={Cross} />
        </button>
      )}
    </span>
  );
};

/** A quiet one-line field: the draft's title, an email's subject. */
export const DraftInput = ({
  value,
  onValueChange,
  label,
  placeholder,
  title = false,
}: {
  value: string;
  onValueChange?: (value: string) => void;
  label: string;
  placeholder?: string;
  title?: boolean;
}) =>
  title ? (
    // A title wraps when it is long, and stays one line of words: Enter does not break it.
    <textarea
      value={value}
      aria-label={label}
      placeholder={placeholder}
      readOnly={onValueChange === undefined}
      rows={1}
      onChange={(event) =>
        onValueChange?.(event.currentTarget.value.replaceAll("\n", " "))
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
        }
      }}
      {...stylex.props(styles.field, styles.grows, styles.title)}
    />
  ) : (
    <input
      type="text"
      value={value}
      aria-label={label}
      placeholder={placeholder}
      readOnly={onValueChange === undefined}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
      {...stylex.props(styles.field)}
    />
  );

/** A quiet field that grows with its words: a description, an email's body. */
export const DraftText = ({
  value,
  onValueChange,
  label,
  placeholder,
}: {
  value: string;
  onValueChange?: (value: string) => void;
  label: string;
  placeholder?: string;
}) => (
  <textarea
    value={value}
    aria-label={label}
    placeholder={placeholder}
    readOnly={onValueChange === undefined}
    rows={1}
    onChange={(event) => onValueChange?.(event.currentTarget.value)}
    {...stylex.props(styles.field, styles.grows)}
  />
);

/** The frame: the head, the kind's fields, and the foot with its ways out. */
export const Draft = ({
  icon,
  mark,
  title,
  children,
  main,
  secondary,
  onDismiss,
  status = "ready",
  done,
  onUndo,
  onRestore,
  "aria-label": label,
}: DraftProps) => {
  const words = useDraftWords("frame");
  if (status === "dismissed") {
    // Folded to one quiet line, with Restore while the host can bring it back.
    return (
      <section
        aria-label={label}
        data-slot="draft"
        data-status={status}
        {...stylex.props(styles.root, styles.folded)}
      >
        <p {...stylex.props(styles.line)}>{words.dismissed}</p>
        {onRestore === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={onRestore}>
            {words.restore}
          </Button>
        )}
      </section>
    );
  }
  const busy = status === "drafting" || status === "sending";
  return (
    <section
      aria-label={label}
      aria-busy={busy || undefined}
      data-slot="draft"
      data-status={status}
      {...stylex.props(styles.root)}
    >
      <div data-slot="draft-head" {...stylex.props(styles.head)}>
        <span aria-hidden="true" {...stylex.props(styles.mark)}>
          {mark ?? (icon === undefined ? null : <Icon icon={icon} />)}
        </span>
        {title}
      </div>
      <div data-slot="draft-body" {...stylex.props(styles.body)}>
        {children}
      </div>
      {status === "sent" ? (
        // Made: the ways out give way to one line where they stood, at the foot's own height.
        <div
          data-slot="draft-foot"
          {...stylex.props(styles.foot, styles.doneFoot)}
        >
          <output {...stylex.props(styles.line, styles.done)}>
            <Icon icon={Tick} />
            <span>{done}</span>
          </output>
          {secondary}
          {onUndo === undefined ? null : (
            <span {...stylex.props(styles.main)}>
              <Button variant="ghost" size="sm" onClick={onUndo}>
                {words.undo}
              </Button>
            </span>
          )}
        </div>
      ) : (
        <div data-slot="draft-foot" {...stylex.props(styles.foot)}>
          {onDismiss === undefined ? null : (
            <>
              <Button
                variant="ghost"
                size="sm"
                layout={styles.wide}
                onClick={onDismiss}
                disabled={busy}
              >
                {words.dismiss}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={Cross}
                aria-label={words.dismiss}
                layout={styles.narrow}
                onClick={onDismiss}
                disabled={busy}
              />
            </>
          )}
          {secondary}
          <span {...stylex.props(styles.main)}>
            <Button
              variant="ink"
              size="sm"
              layout={styles.mainButton}
              disabled={status === "drafting"}
              status={lifeOf(status)}
              workingLabel={words.working}
              // The sent line takes the whole foot's place, so the button never shows a done word of
              // its own: its own label, so it keeps no room for a longer one.
              doneLabel={main.label}
              failedLabel={words.failed}
              onClick={() => {
                void main.onPress();
              }}
            >
              {main.label}
            </Button>
          </span>
        </div>
      )}
    </section>
  );
};
