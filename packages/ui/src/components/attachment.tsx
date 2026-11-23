// Attachment: a file or picture that goes with a message, in
// StyleX: a small card with its picture or a mark for its kind, its name and a line
// about it, and its actions. A prompt input shows them above its text and a message under its
// words; neither is known here.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <AttachmentGroup aria-label="Files to send">
//     {files.map((file) => (
//       <Attachment key={file.id}>
//         <AttachmentMedia src={file.preview} type={file.type} />
//         <AttachmentContent>
//           <AttachmentTitle>{file.name}</AttachmentTitle>
//           <AttachmentDescription>{formatFileSize(file.size, locale)}</AttachmentDescription>
//         </AttachmentContent>
//         <AttachmentActions>
//           <AttachmentAction aria-label={`Remove ${file.name}`} onClick={() => remove(file.id)}>
//             <Icon icon={XIcon} />
//           </AttachmentAction>
//         </AttachmentActions>
//       </Attachment>
//     ))}
//   </AttachmentGroup>
//
// A group is a list of files, said as one. More files than room scroll sideways in the row, which
// takes no Tab stop of its own: each action is one, and the keyboard brings it into view. Actions
// show under a pointer or focus, and always on a touch screen; an icon-only one is named for its
// file ("Remove brief.pdf"). When an action takes its file off, focus goes on to the next file's
// first action, or the one before, and after the last to the group itself, or, when the group
// goes with it, to the nearest stop where it stood. A picture shows as itself, and a file with
// none, or one that will not load or may not (a remote address, unless allowed), wears a mark for
// its media type. A name too long for the card is cut in the middle, so its extension stays. Every
// value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import { mergeProps } from "@ui-sdk/react/primitive";
import {
  createContext,
  createElement,
  isValidElement,
  use,
  useState,
} from "react";
import type {
  ComponentPropsWithRef,
  MouseEventHandler,
  ReactElement,
  ReactNode,
} from "react";

import { placeNear } from "../hooks/use-return-focus";
import { useScrollEdges } from "../hooks/use-scroll-edges";
import { Icon, fileMark } from "../lib/icons";
import {
  edgeFade,
  focusRing,
  focusRingInset,
  scrollbarHidden,
  tapTarget,
  tileEdge,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { safeMediaSrc } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, ringInsetMarker } from "../lib/vars.stylex";

/** Where the file is on its way: `done` once it is there. */
export type AttachmentState =
  | "idle"
  | "uploading"
  | "processing"
  | "error"
  | "done";
/** How big the card is. */
export type AttachmentSize = "default" | "sm" | "xs";
/** The picture beside the words, or above them. */
export type AttachmentOrientation = "horizontal" | "vertical";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop an AttachmentGroup takes. */
export interface AttachmentGroupProps {
  /** Its Attachments, one per file. */
  children: ReactNode;
  /** The list's name, said before its files ("Files to send"). */
  "aria-label"?: string;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop an Attachment takes. */
export interface AttachmentProps {
  /** Its parts: AttachmentMedia, AttachmentContent, AttachmentActions and AttachmentTrigger. */
  children: ReactNode;
  /**
   * Where the file is on its way: `idle` not yet sent (a dashed edge), `uploading` and
   * `processing` on its way (its name quiet, its picture faint, and busy to a screen reader),
   * `error` failed (in the destructive colour; say why in its AttachmentDescription), `done` there.
   * @default "done"
   */
  state?: AttachmentState;
  /**
   * How big the card is: `default` a 36px picture with the name in small type, `sm` a 32px picture
   * and `xs` a 28px one, both with the name in the smallest type.
   * @default "default"
   */
  size?: AttachmentSize;
  /**
   * The picture beside the words (`horizontal`) or above them, filling the card's width
   * (`vertical`), its actions over the picture's corner.
   * @default "horizontal"
   */
  orientation?: AttachmentOrientation;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop an AttachmentMedia takes. */
export interface AttachmentMediaProps {
  /**
   * What it holds: `icon` a mark, `image` a picture. A picture from `src` sets `image` itself.
   * @default "icon"
   */
  variant?: "icon" | "image";
  /**
   * The address of a picture of the file: an image's own, or a video's (with a video `type`). It
   * shows as itself; when it will not load, the mark shows in its place. It loads when it is
   * written into the address (`data:` of a picture or video type, never SVG), made by the page
   * (`blob:`) or a path on this site; an `http(s)` address only with `allowRemote`.
   */
  src?: string;
  /**
   * Loads an `http(s)` `src` too. Turn it on only for a source you trust: a picture's address that
   * a model or another person wrote tells its site who looked at it, and when.
   * @default false
   */
  allowRemote?: boolean;
  /** The file's media type ("image/png", "application/pdf"): it chooses the mark a file without a picture wears. */
  type?: string;
  /**
   * The mark in place of the one for its media type, such as the product's own for a kind of file
   * (`<Icon icon={SheetIcon} />`). A picture from `src` still shows over it.
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AttachmentContent takes. */
export interface AttachmentContentProps {
  /** Its AttachmentTitle and AttachmentDescription. */
  children: ReactNode;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop an AttachmentTitle takes. */
export interface AttachmentTitleProps {
  /** The file's name, as the person knows it ("brief.pdf"). Given as words, a name too long is cut in the middle. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AttachmentDescription takes. */
export interface AttachmentDescriptionProps {
  /** A line about the file: its size as people say it (`formatFileSize`), its kind, or why it failed. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AttachmentActions takes. */
export interface AttachmentActionsProps {
  /** Its AttachmentAction buttons. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AttachmentAction takes. */
export interface AttachmentActionProps {
  /** Its icon (`<Icon icon={XIcon} />`). */
  children: ReactNode;
  /** Its name, the action and its file ("Remove brief.pdf"). */
  "aria-label": string;
  /** What it does. When that takes the file off, focus goes on to the next file's first action. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /**
   * Out of use.
   * @default false
   */
  disabled?: boolean;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AttachmentTrigger takes: these, and the rest of a <button>'s. */
export interface AttachmentTriggerProps extends Omit<
  ComponentPropsWithRef<"button">,
  "className" | "style" | "children"
> {
  /** Its name: what pressing the card does ("Open brief.pdf"). */
  "aria-label": string;
  /**
   * Draw the one element given as the child (`<a href>`) in its place, over the whole card. Inside
   * a trigger of another part, put it in that part's `asChild` instead
   * (`<DialogTrigger asChild><AttachmentTrigger aria-label="Preview brief.pdf" /></DialogTrigger>`).
   * @default false
   */
  asChild?: boolean;
  /** With `asChild`, the one element to draw. */
  children?: ReactElement;
}

const HOVER = media.hover;
const FORCED = media.forcedColors;
const COARSE = media.pointerCoarse;

const styles = stylex.create({
  group: {
    display: "flex",
    gap: space["2"],
    minWidth: 0,
    margin: 0,
    // Room for a card's edge and focus ring inside the sideways scroll.
    padding: space["1"],
    listStyle: "none",
    overflowX: "auto",
    overflowY: "hidden",
    overscrollBehaviorX: "contain",
    // A card's widest is the row's own width, so a long name never runs past it. A size container
    // takes no width from its cards: in a row it is given a width (a prompt input gives it the
    // header's whole line).
    containerType: "inline-size",
    fontFamily: font.sans,
  },
  // A card is at most as wide as the row. With more than one file the first leaves the room of a
  // fade at each side, so at rest a long name never puts its actions under the fade at the row's
  // end; the cards after it come into view by scrolling, where the row's scroll padding keeps a
  // focused action clear. (The fade's reach is edgeFade's, space-10.)
  item: {
    display: "flex",
    flexShrink: 0,
    maxWidth: {
      default: "100%",
      ":first-child:not(:only-child)": `calc(100% - 2 * ${space["10"]})`,
    },
  },
  card: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    // As wide as its name, up to a sensible most or the row's own width: only a name that truly
    // does not fit is cut, in the middle.
    maxWidth: `min(${sizes.attachmentMaxWidth}, 100cqi, 100%)`,
    padding: space["1"],
    paddingInlineEnd: space["2"],
    overflow: "hidden",
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
    fontFamily: font.sans,
  },
  // The corner is the system's, or half the card's height when that is less.
  cardDefault: {
    borderRadius: `min(${radius.base}, calc((${sizes.attachmentThumb} + 2 * ${space["1"]}) / 2))`,
  },
  cardSm: {
    borderRadius: `min(${radius.base}, calc((${sizes.controlSm} + 2 * ${space["1"]}) / 2))`,
  },
  cardXs: {
    borderRadius: `min(${radius.base}, calc((${sizes.controlXs} + 2 * ${space["1"]}) / 2))`,
  },
  vertical: {
    flexDirection: "column",
    alignItems: "stretch",
    width: `calc(${sizes.attachmentThumb} * 3)`,
    paddingInlineEnd: space["1"],
    paddingBottom: space["2"],
    borderRadius: radius.base,
  },
  idle: {
    boxShadow: "none",
    outline: `${sizes.hairline} dashed ${colors.borderStrongColor}`,
    outlineOffset: `calc(-1 * ${sizes.hairline})`,
  },
  error: {
    boxShadow: `inset 0 0 0 ${sizes.hairline} ${colors.destructiveBorder}`,
  },
  thumb: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: sizes.attachmentThumb,
    height: sizes.attachmentThumb,
    overflow: "hidden",
    borderRadius: `calc(${radius.base} / 2)`,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: sizes.borderStrong,
    color: colors.mutedForeground,
  },
  thumbSm: {
    width: sizes.controlSm,
    height: sizes.controlSm,
  },
  thumbXs: {
    width: sizes.controlXs,
    height: sizes.controlXs,
  },
  thumbVertical: {
    width: "100%",
    height: "auto",
    aspectRatio: "1",
  },
  thumbBusy: {
    opacity: 0.6,
  },
  thumbError: {
    backgroundColor: colors.destructiveSubtle,
    color: colors.destructive,
  },
  picture: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  content: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  contentVertical: {
    paddingInline: space["1"],
  },
  title: {
    display: "flex",
    minWidth: 0,
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    whiteSpace: "nowrap",
  },
  titleSmall: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  titleBusy: {
    color: colors.mutedForeground,
  },
  titleStart: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  titleEnd: {
    flexShrink: 0,
  },
  description: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  descriptionError: {
    color: colors.destructive,
  },
  // Actions: under a pointer or focus on their card, and always on a touch screen; above the
  // trigger, so each stays its own press.
  actions: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    // Two small actions keep a finger's room each: on a touch screen their targets, wider than
    // the circles, stand side by side and never over one another.
    gap: {
      default: space["1"],
      [COARSE]: `calc(${sizes.tapTarget} - ${sizes.badgeHeight})`,
    },
    flexShrink: 0,
    opacity: {
      default: 1,
      [HOVER]: {
        default: 0,
        [stylex.when.ancestor(":hover")]: 1,
        [stylex.when.ancestor(":focus-within")]: 1,
      },
    },
    transitionProperty: "opacity",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  actionsVertical: {
    position: "absolute",
    top: space["2"],
    insetInlineEnd: space["2"],
  },
  // An action: a small circle, quiet until a pointer is on it, with a finger's room round it on
  // a touch screen (tapTarget).
  action: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: sizes.badgeHeight,
    height: sizes.badgeHeight,
    margin: 0,
    padding: 0,
    // No edge: the fill under a pointer is its bound. Forced colours drop fills, so a real edge
    // draws it there, as a Button's does.
    borderWidth: { default: 0, [FORCED]: sizes.hairline },
    borderStyle: "solid",
    borderColor: "ButtonText",
    borderRadius: radius.circle,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
      ":active": colors.accentActive,
    },
    color: colors.mutedForeground,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": sizes.opacityDisabled },
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  trigger: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
    backgroundColor: "transparent",
    cursor: "pointer",
  },
});

interface Card {
  state: AttachmentState;
  size: AttachmentSize;
  orientation: AttachmentOrientation;
}

// The card a part is in; a part outside one draws as a default, finished, horizontal card's.
const CardContext = createContext<Card>({
  state: "done",
  size: "default",
  orientation: "horizontal",
});
// Whether an Attachment stands in an AttachmentGroup's list.
const InGroup = createContext(false);

/** A name cut in the middle: its start, and its last few characters with the extension. */
const splitName = (name: string): [string, string] => {
  const dot = name.lastIndexOf(".");
  const keep = Math.max(dot === -1 ? 6 : name.length - dot + 3, 6);
  return name.length <= keep + 4
    ? [name, ""]
    : [name.slice(0, name.length - keep), name.slice(name.length - keep)];
};

/** The files that go with a message, as a list that scrolls sideways. */
export const AttachmentGroup = ({
  children,
  "aria-label": label,
  style,
}: AttachmentGroupProps) => {
  // The sides with files beyond them are marked for the fade there.
  const edges = useScrollEdges();
  return (
    // Out of the tab order: Firefox makes a box that scrolls a Tab stop of its own, with no ring;
    // each file's actions take the keys and scroll it into view. Focus comes to the list itself when
    // its last file is taken off.
    <InGroup value>
      <ul
        // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops a list's role once its markers are hidden
        role="list"
        aria-label={label}
        ref={edges}
        tabIndex={-1}
        data-slot="attachment-group"
        {...stylex.props(styles.group, scrollbarHidden, edgeFade, style)}
      >
        {children}
      </ul>
    </InGroup>
  );
};

/** One file: its picture or mark, its name and a line about it, and its actions. */
export const Attachment = ({
  children,
  state = "done",
  size = "default",
  orientation = "horizontal",
  style,
}: AttachmentProps) => {
  const inGroup = use(InGroup);
  const vertical = orientation === "vertical";
  const card = (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      aria-busy={state === "uploading" || state === "processing" || undefined}
      {...stylex.props(
        styles.card,
        size === "default" && styles.cardDefault,
        size === "sm" && styles.cardSm,
        size === "xs" && styles.cardXs,
        tileEdge,
        vertical && styles.vertical,
        state === "idle" && styles.idle,
        state === "error" && styles.error,
        stylex.defaultMarker(),
        !inGroup && style
      )}
    >
      {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
      <CardContext value={{ state, size, orientation }}>{children}</CardContext>
    </div>
  );
  // In a group, a row of its list. The list item is its root there, so the caller's layout is the
  // list item's.
  return inGroup ? <li {...stylex.props(styles.item, style)}>{card}</li> : card;
};

/** The file's picture, or a mark for its media type when it has none or it will not load. */
export const AttachmentMedia = ({
  variant = "icon",
  src,
  allowRemote = false,
  type,
  children,
  style,
}: AttachmentMediaProps) => {
  const { state, size, orientation } = use(CardContext);
  // The address that would not load: another file's picture is tried afresh.
  const [broken, setBroken] = useState<string | null>(null);
  const safe = safeMediaSrc(src, { remote: allowRemote });
  const picture = safe !== null && safe !== broken ? safe : null;
  const video = type?.startsWith("video/") === true;
  return (
    <span
      aria-hidden="true"
      data-slot="attachment-media"
      data-variant={picture === null ? variant : "image"}
      {...stylex.props(
        styles.thumb,
        size === "sm" && styles.thumbSm,
        size === "xs" && styles.thumbXs,
        orientation === "vertical" && styles.thumbVertical,
        (state === "uploading" || state === "processing") && styles.thumbBusy,
        state === "error" && styles.thumbError,
        style
      )}
    >
      {picture === null && (children ?? <Icon icon={fileMark(type)} />)}
      {picture !== null && video && (
        <video
          src={picture}
          muted
          preload="metadata"
          onError={() => {
            setBroken(picture);
          }}
          {...stylex.props(styles.picture)}
        />
      )}
      {picture !== null && !video && (
        <img
          src={picture}
          alt=""
          loading="lazy"
          // A picture that failed before the page came alive sent its error to no one.
          ref={(node) => {
            if (node?.complete === true && node.naturalWidth === 0) {
              setBroken(picture);
            }
          }}
          onError={() => {
            setBroken(picture);
          }}
          {...stylex.props(styles.picture)}
        />
      )}
    </span>
  );
};

/** The file's name and the line about it. */
export const AttachmentContent = ({
  children,
  style,
}: AttachmentContentProps) => {
  const vertical = use(CardContext).orientation === "vertical";
  return (
    <span
      data-slot="attachment-content"
      {...stylex.props(
        styles.content,
        vertical && styles.contentVertical,
        style
      )}
    >
      {children}
    </span>
  );
};

/** The file's name, whole when there is room and else cut in the middle so its extension stays. */
export const AttachmentTitle = ({ children, style }: AttachmentTitleProps) => {
  const { state, size } = use(CardContext);
  const words = typeof children === "string" ? splitName(children) : null;
  return (
    // A name reads in its own direction, so in a right-to-left page a Latin name still runs from
    // its start to its extension, the cut between them.
    <span
      data-slot="attachment-title"
      title={typeof children === "string" ? children : undefined}
      dir="auto"
      {...stylex.props(
        styles.title,
        size !== "default" && styles.titleSmall,
        (state === "uploading" || state === "processing") && styles.titleBusy,
        style
      )}
    >
      {words === null ? (
        <span {...stylex.props(styles.titleStart)}>{children}</span>
      ) : (
        <>
          <span {...stylex.props(styles.titleStart)}>{words[0]}</span>
          {words[1] !== "" && (
            <span {...stylex.props(styles.titleEnd)}>{words[1]}</span>
          )}
        </>
      )}
    </span>
  );
};

/** A line about the file: its size, its kind, or why it failed. */
export const AttachmentDescription = ({
  children,
  style,
}: AttachmentDescriptionProps) => {
  const failed = use(CardContext).state === "error";
  return (
    <span
      data-slot="attachment-description"
      dir="auto"
      {...stylex.props(
        styles.description,
        failed && styles.descriptionError,
        style
      )}
    >
      {children}
    </span>
  );
};

/** The file's actions, at the end of its card. */
export const AttachmentActions = ({
  children,
  style,
}: AttachmentActionsProps) => {
  const vertical = use(CardContext).orientation === "vertical";
  return (
    <span
      data-slot="attachment-actions"
      {...stylex.props(
        styles.actions,
        vertical && styles.actionsVertical,
        ringInsetMarker,
        style
      )}
    >
      {children}
    </span>
  );
};

/**
 * Where focus goes when a file's action takes the file off: the next file's first action, or the
 * one before; after the last, the group, while it stays, and when the caller takes the group off
 * with its last file, the nearest stop where it stood (`placeNear`): never back to the page. Read
 * before the action runs, while every file is still there.
 */
const neighbourOf = (
  button: HTMLElement
): (() => HTMLElement | undefined) | null => {
  const item = button.closest("li");
  for (const other of [
    item?.nextElementSibling,
    item?.previousElementSibling,
  ]) {
    const next = other?.querySelector<HTMLElement>(
      '[data-slot="attachment-action"]'
    );
    if (next) {
      return () => next;
    }
  }
  const group = item?.closest<HTMLElement>('[data-slot="attachment-group"]');
  return group ? placeNear(group) : null;
};

/** One of the file's actions: a small round icon button named for what it does to the file. */
export const AttachmentAction = ({
  children,
  "aria-label": label,
  onClick,
  disabled = false,
  style,
}: AttachmentActionProps) => (
  <button
    type="button"
    data-slot="attachment-action"
    aria-label={label}
    disabled={disabled}
    onClick={(event) => {
      const button = event.currentTarget;
      const neighbour =
        button === document.activeElement ? neighbourOf(button) : null;
      onClick?.(event);
      if (neighbour === null) {
        return;
      }
      // Once the press has drawn, a file taken off has taken its focused button with it: focus
      // goes on to the neighbour, unless something else has taken it.
      requestAnimationFrame(() => {
        const place = neighbour();
        if (
          !button.isConnected &&
          place?.isConnected === true &&
          (document.activeElement === null ||
            document.activeElement === document.body)
        ) {
          place.focus();
        }
      });
    }}
    {...stylex.props(styles.action, focusRing, style)}
  >
    <span aria-hidden="true" {...stylex.props(tapTarget)} />
    {children}
  </button>
);

/** The whole card as one press, behind its actions: it opens the file, a link or a dialog. */
export const AttachmentTrigger = ({
  asChild = false,
  children,
  ...props
}: AttachmentTriggerProps) => {
  const own = {
    "data-slot": "attachment-trigger",
    ...props,
    ...stylex.props(styles.trigger, focusRingInset),
  };
  if (asChild && isValidElement<Record<string, unknown>>(children)) {
    return createElement(children.type, mergeProps(own, children.props));
  }
  return <button type="button" {...own} />;
};
