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
import { useId } from "react";
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
  /**
   * Holds the main action back until the host clears it, with the reason ("Read the whole email
   * first"), as ApprovalRequest's `approveHeld`: the main action is drawn out of use but stays in
   * the Tab order, the reason stands beside it and is its description (said with it), and Discard
   * stays usable. Shown while the draft is ready or failed.
   */
  mainHeld?: string;
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
  /** The kind is locked (its `readOnly`): marked on the frame as `data-read-only`. @default false */
  readOnly?: boolean;
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

/**
 * A kind's change handler once its lock is applied: none while `readOnly`, else the host's
 * `onDraftChange`. A kind with none is locked: it shows no way to change it and no empty
 * optional row, so `readOnly` and leaving out `onDraftChange` mean the same.
 */
export const changeOf = <T,>(
  readOnly: boolean | undefined,
  onDraftChange: ((draft: T) => void) | undefined
) => (readOnly === true ? undefined : onDraftChange);

/**
 * Each person's React key in a list: their address, else their name, and for the same address (or
 * name) again, its place among those that share it ("jerry@example.com", "jerry@example.com#2"). A
 * person keeps their key when someone before them with another address is taken off.
 */
export const draftKeys = (people: readonly DraftPerson[]) => {
  const seen = new Map<string, number>();
  return people.map((person) => {
    const base = person.email ?? person.name;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
};

/** The people without the one at `index`: the one pressed, even when the same person is listed twice. */
export const withoutAt = <T,>(people: readonly T[], index: number) =>
  people.filter((_, at) => at !== index);

/** Whether an optional value holds anything: a locked draft drops the rows that do not. */
export const filled = (value: string | undefined) =>
  value !== undefined && value.trim() !== "";

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
  // Held: the reason takes the room before the main action, its words against it; it wraps first.
  held: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    marginInlineStart: "auto",
    paddingInlineStart: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textAlign: "end",
    textWrap: "pretty",
  },
  mainHeld: { marginInlineStart: 0 },
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
  // Whole (a locked draft): a long name wraps inside the chip, never cut. One line is the pill as
  // ever (half its height for a corner); more lines round the same corner, the face on the first.
  personWhole: {
    alignItems: "flex-start",
    height: "auto",
    minHeight: grasp.controlXs,
    paddingBlock: `calc((${grasp.controlXs} - ${grasp.textXsLine}) / 2)`,
    borderRadius: `calc(${grasp.controlXs} / 2)`,
  },
  personStruck: { textDecorationLine: "line-through", color: grasp.muted },
  personNameWhole: {
    overflow: "visible",
    textOverflow: "clip",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  // Whole, the address it goes to, quiet after the name: it moves to the next line whole, and only
  // an address longer than a line breaks (after its "@" first).
  address: { display: "inline-block", maxWidth: "100%", color: grasp.muted },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    height: grasp.textXsLine,
  },
  face: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    height: grasp.textXsLine,
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
  // A locked value: words, not a field. Every line break kept, a long word broken at the edge,
  // nothing cut; it grows as text does, in every engine.
  value: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    color: grasp.ink,
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

/** An address after a name, quiet; an address longer than a line breaks after its "@" first. */
const DraftAddress = ({
  email,
  struck,
}: {
  email: string;
  struck: boolean;
}) => {
  const at = email.indexOf("@");
  return (
    <>
      {" · "}
      <span
        data-slot="draft-person-address"
        {...stylex.props(styles.address, struck && styles.personStruck)}
      >
        {at === -1 ? (
          email
        ) : (
          <>
            {email.slice(0, at + 1)}
            <wbr />
            {email.slice(at + 1)}
          </>
        )}
      </span>
    </>
  );
};

/**
 * A person as a chip: their face and name, and a remove when the draft can still lose them. `whole`
 * (a locked draft) wraps a long name rather than ending it in "…", and shows the address it goes
 * to, quiet after the name; otherwise the address is on hover. `struck` (a guest a change takes
 * off) strikes the name and the address, never the face. `badge` stands at the chip's end, before
 * the remove (a guest a change adds: "New").
 */
export const DraftPersonChip = ({
  person,
  onRemove,
  whole = false,
  struck = false,
  badge,
}: {
  person: DraftPerson;
  onRemove?: () => void;
  whole?: boolean;
  struck?: boolean;
  badge?: ReactNode;
}) => {
  const words = useDraftWords("frame");
  return (
    <span
      data-slot="draft-person"
      title={person.email}
      {...stylex.props(
        styles.person,
        onRemove !== undefined && styles.personRemovable,
        whole && styles.personWhole
      )}
    >
      <span {...stylex.props(styles.face)}>
        <DraftFace person={person} />
      </span>
      <span
        {...stylex.props(
          styles.personName,
          whole && styles.personNameWhole,
          struck && styles.personStruck
        )}
      >
        {person.name}
        {whole && person.email !== undefined ? (
          <DraftAddress email={person.email} struck={struck} />
        ) : null}
      </span>
      {badge === undefined ? null : (
        <span {...stylex.props(styles.badge)}>{badge}</span>
      )}
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

/** A locked value, whole: its words as text, every line break kept. */
const DraftValue = ({
  value,
  title = false,
}: {
  value: string;
  title?: boolean;
}) => (
  <p
    data-slot="draft-value"
    {...stylex.props(styles.value, title && styles.title)}
  >
    {value}
  </p>
);

/**
 * A quiet one-line field: the draft's title, an email's subject. `readOnly` (a locked draft) shows
 * its value whole as text: wrapped, its line breaks kept, nothing cut.
 */
export const DraftInput = ({
  value,
  onValueChange,
  label,
  placeholder,
  title = false,
  readOnly = false,
}: {
  value: string;
  onValueChange?: (value: string) => void;
  label: string;
  placeholder?: string;
  title?: boolean;
  readOnly?: boolean;
}) => {
  if (readOnly) {
    return <DraftValue value={value} title={title} />;
  }
  return title ? (
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
};

/**
 * A quiet field that grows with its words: a description, an email's body. `readOnly` (a locked
 * draft) shows its value whole as text, which grows in every engine.
 */
export const DraftText = ({
  value,
  onValueChange,
  label,
  placeholder,
  readOnly = false,
}: {
  value: string;
  onValueChange?: (value: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
}) =>
  readOnly ? (
    <DraftValue value={value} />
  ) : (
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
  mainHeld,
  secondary,
  onDismiss,
  status = "ready",
  done,
  onUndo,
  onRestore,
  "aria-label": label,
  readOnly = false,
}: DraftProps) => {
  const words = useDraftWords("frame");
  const heldId = useId();
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
  // Held only where the main action could be pressed: ready, or failed and to be sent again.
  const held = draftEditable(status) ? mainHeld : undefined;
  return (
    <section
      aria-label={label}
      aria-busy={busy || undefined}
      data-slot="draft"
      data-status={status}
      data-read-only={readOnly ? "" : undefined}
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
          {held === undefined ? null : (
            <p
              id={heldId}
              data-slot="draft-held"
              {...stylex.props(styles.held)}
            >
              {held}
            </p>
          )}
          <span
            {...stylex.props(
              styles.main,
              held !== undefined && styles.mainHeld
            )}
          >
            <Button
              variant="ink"
              size="sm"
              layout={styles.mainButton}
              disabled={status === "drafting" || held !== undefined}
              // Held: out of use but still reached by Tab, so its reason can be heard from it.
              focusableWhenDisabled={held !== undefined}
              aria-describedby={held === undefined ? undefined : heldId}
              data-held={held === undefined ? undefined : ""}
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
