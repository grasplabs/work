// Image well: one picture in a form (a logo, a team's or a person's picture), the picture itself the
// control. Not a circle with a button beside it: a square well with soft corners that shows the
// picture, or its initials while there is none. Pressing it, or Enter or Space on it, opens the
// picker; a picture dropped on it takes its place. A small remove stands at its corner on hover, on
// focus and always on touch. What it takes (its types, its size) is in a tooltip, not a line of text.
//
//   <SettingRow label="Logo" help="Shown on every shared report.">
//     {(field) => <ImageWell {...field} initials="Noordkade Finance" accept={["image/png"]} maxSize={2_000_000} hint="PNG, up to 2 MB" />}
//   </SettingRow>
//
// It is File upload's machinery (UI SDK's File Input): the same checks of type and size, the same
// refusals said with their reason. Given `upload`, a new picture is saved at once: the well shows it
// dimmed with a spinner while it saves, and a danger edge with Try again on it if the save failed;
// remove then puts the picture back as it was. Without `upload` the file goes with the form. Without
// script it is the browser's own file input, over the whole well. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createFileInputController,
  FileInput,
  FileInputDropzone,
} from "@ui-sdk/react/file-input";
import type { FileInputValueChangeDetails } from "@ui-sdk/react/file-input";
import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { initialsOf } from "../avatar/avatar";
import { useFieldName } from "../field/field";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Cross, Icon, Image as ImageMark, Retry, Upload } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { useRowProblem } from "../setting-row/line-context";
import { Spinner } from "../spinner/spinner";
import { grasp, media } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent } from "../tooltip";
import { useWords, withGiven } from "../words/words";
import { wellMarker } from "./markers.stylex";
import { imageWellWords } from "./words";

/** What a caller may style: where it sits. */
export type ImageWellLayoutStyle = LayoutStyle;

/** What it says, in the page's language. */
export interface ImageWellWords {
  /** The well's name while it holds a picture ("Change logo"). */
  change: string;
  /** The well's name while it is empty ("Add a logo"). */
  add: string;
  /** The remove's name ("Remove logo"). */
  remove: string;
  /** Said while a new picture saves. */
  saving: string;
  /** Said once it saved. */
  saved: string;
  /** Said, and shown in the tooltip, when the save failed. */
  failed: string;
  /** The name of the button that saves it again. */
  retry: string;
  /** Before the limits in the tooltip ("Click or drop a picture."). */
  how: string;
  /** Why a file was refused, from UI SDK's reason. */
  refused: (name: string, reason: string) => string;
  /**
   * Why, in a Setting row's line under its name: one short line, without the file's name (the
   * person has just picked it), so the row keeps its height. Without it, `refused`.
   */
  refusedInRow?: (reason: string) => string;
}

/** Every prop an ImageWell takes. */
export interface ImageWellProps {
  /** The picture now, as an address; `null` for none. Pass it with `onValueChange` to control it. */
  value?: string | null;
  /** The picture it starts with, when you do not control it. */
  defaultValue?: string | null;
  /** Runs with the new picture's address (`null` once removed), and the file it came from. */
  onValueChange?: (value: string | null, file: File | null) => void;
  /** Saves a new picture at once; resolve with its stored address, or with nothing to keep showing the file. */
  upload?: (file: File, signal: AbortSignal) => Promise<string | undefined>;
  /** The name whose initials stand in the well while it is empty ("Noordkade Finance": NF). Left out, a picture mark. */
  initials?: string;
  /**
   * The kinds of picture it takes, as types or endings.
   * @default ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]
   */
  accept?: string | readonly string[];
  /** The largest file it takes, in bytes. */
  maxSize?: number;
  /** The limits, in words, for the tooltip ("PNG or SVG, up to 2 MB"). */
  hint?: string;
  /**
   * How the picture fills the well: `cover` crops it to fill (a photo), `contain` shows it whole on
   * the well's ground (a logo).
   * @default "cover"
   */
  fit?: "cover" | "contain";
  /**
   * `sm` 40px, at home in a setting row (the row stays 56px); `lg` 96px, for a page of its own.
   * @default "sm"
   */
  size?: "sm" | "lg";
  /** The name the file is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** Out of use. @default false */
  disabled?: boolean;
  /** The id a label's `for` points at: a SettingRow's field passes it. */
  id?: string;
  /** Its name when no label names it. */
  "aria-label"?: string;
  /** What describes it: a SettingRow's field passes its help. */
  "aria-describedby"?: string;
  /** Any of its words replaced. */
  words?: Partial<ImageWellWords>;
  /** Layout only: where it sits. */
  layout?: ImageWellLayoutStyle;
}

const pictures = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

const FORCED = media.forced;
const HOVER = media.hover;
const COARSE = media.coarse;
// The well's own states, read from the root, so every layer follows them.
const SAVING = ":is([data-state=saving])";
const FAILED = ":is([data-state=failed])";
// UI SDK marks its drop zone, inside the root, while a file is over it.
const DRAGGING = ":has([data-dragging])";

const styles = stylex.create({
  root: {
    display: "inline-grid",
    // As wide as the well, even where a Field's grid would stretch it.
    justifySelf: "start",
    rowGap: grasp.space2,
    justifyItems: "start",
    fontFamily: grasp.fontSans,
  },
  // The drop zone is the well's square: everything else stands in it.
  zone: {
    position: "relative",
    display: "grid",
    boxSizing: "border-box",
    borderRadius: `min(${grasp.corner}, 28%)`,
    cornerShape: grasp.cornerShape,
  },
  // The initials at the size Grasp's Avatar gives them at that size.
  // sm stands in a setting row's control column without making the row taller: 40px, the row 56.
  sm: {
    width: grasp.space10,
    height: grasp.space10,
    fontSize: grasp.titleSm,
    [iconVars.size]: grasp.iconSm,
  },
  lg: {
    width: grasp.space24,
    height: grasp.space24,
    fontSize: grasp.titleXl,
    [iconVars.size]: grasp.iconMd,
  },
  // The well: a button the size of the zone, the picture or the initials inside, the system's edge.
  well: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: "100%",
    height: "100%",
    margin: 0,
    padding: 0,
    overflow: "hidden",
    appearance: "none",
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: {
      default: "solid",
      [FORCED]: {
        default: "solid",
        [stylex.when.ancestor(FAILED, wellMarker)]: "dashed",
      },
    },
    borderColor: "currentColor",
    borderRadius: "inherit",
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: {
      default: grasp.edge,
      [stylex.when.ancestor(DRAGGING, wellMarker)]:
        `inset 0 0 0 1px ${grasp.fieldEdgeHover}`,
      [stylex.when.ancestor(FAILED, wellMarker)]:
        `inset 0 0 0 ${grasp.hairline} ${grasp.danger}`,
    },
    color: grasp.muted,
    fontFamily: "inherit",
    fontWeight: grasp.weightMedium,
    lineHeight: 1,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": grasp.dim },
    transitionProperty: "box-shadow",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  picture: {
    gridArea: "1 / 1",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    // While it saves, the new picture is there but dimmed: it is not kept yet.
    opacity: {
      default: 1,
      [stylex.when.ancestor(SAVING, wellMarker)]: grasp.dim,
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
  },
  contain: { objectFit: "contain", padding: "15%", boxSizing: "border-box" },
  // A logo stands on the card's own ground, not the soft tint, so its own colours read as they are.
  wellContain: { backgroundColor: "transparent" },
  // Over the picture on hover, on keyboard focus and while a file is over it: a veil and the upload
  // mark, so the well says it can be changed. Not while it saves or failed: those show their own.
  veil: {
    gridArea: "1 / 1",
    display: "grid",
    placeItems: "center",
    width: "100%",
    height: "100%",
    backgroundColor: grasp.dialogScrim,
    color: grasp.lightPaper,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", wellMarker)]: { default: 0, [HOVER]: 1 },
      [stylex.when.ancestor(":has(:focus-visible)", wellMarker)]: 1,
      [stylex.when.ancestor(DRAGGING, wellMarker)]: 1,
      [stylex.when.ancestor(SAVING, wellMarker)]: 0,
      [stylex.when.ancestor(FAILED, wellMarker)]: 0,
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    pointerEvents: "none",
  },
  // The initials give way to the upload mark whenever the veil would show.
  initials: {
    gridArea: "1 / 1",
    opacity: {
      default: 1,
      [stylex.when.ancestor(":hover", wellMarker)]: { default: 1, [HOVER]: 0 },
      [stylex.when.ancestor(":has(:focus-visible)", wellMarker)]: 0,
      [stylex.when.ancestor(DRAGGING, wellMarker)]: 0,
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
  },
  // Empty, there is no picture to veil: the mark alone, in the well's quiet ink.
  veilBare: { backgroundColor: "transparent", color: grasp.text },
  // While it saves: the spinner in the middle of the dimmed picture.
  busy: {
    gridArea: "1 / 1",
    display: "grid",
    placeItems: "center",
    pointerEvents: "none",
  },
  // Without script: the browser's own file input, unseen over the whole well.
  native: {
    position: "absolute",
    zIndex: 1,
    inset: 0,
    width: "100%",
    height: "100%",
    opacity: 0,
    cursor: "pointer",
  },
  // The small round buttons on the well: remove at its corner, Try again in its middle.
  mark: {
    position: "absolute",
    zIndex: 2,
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    appearance: "none",
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
    color: {
      default: grasp.text,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    cursor: "pointer",
  },
  // Its centre on the middle of the well's rounded corner (about a third of the corner in from the
  // box's), so it sits on the corner, never over the picture's middle.
  remove: {
    top: -4,
    insetInlineEnd: -4,
    // Shown on hover and on focus within the well, always on touch.
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", wellMarker)]: { default: 0, [HOVER]: 1 },
      [stylex.when.ancestor(":focus-within", wellMarker)]: 1,
      [stylex.when.ancestor(FAILED, wellMarker)]: 1,
      [COARSE]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
  },
  // The smallest round button that keeps a 24px target on a fine pointer, and a 44px one on touch.
  removeSm: {
    [iconVars.size]: 10,
    width: 16,
    height: 16,
    "::before": {
      content: "''",
      position: "absolute",
      inset: { default: -4, [COARSE]: -14 },
    },
  },
  removeLg: {
    [iconVars.size]: grasp.space3,
    width: 20,
    height: 20,
    "::before": {
      content: "''",
      position: "absolute",
      inset: { default: -2, [COARSE]: -12 },
    },
  },
  // A failed save: the whole well is Try again, the picture under a veil with the retry mark, so a
  // press anywhere on it saves again. The remove at its corner drops the new picture instead.
  retry: {
    position: "absolute",
    zIndex: 1,
    inset: 0,
    display: "grid",
    placeItems: "center",
    margin: 0,
    padding: 0,
    appearance: "none",
    borderWidth: 0,
    borderRadius: "inherit",
    cornerShape: grasp.cornerShape,
    backgroundColor: { default: grasp.dialogScrim, [FORCED]: "Canvas" },
    // The danger edge drawn again over the veil, as the well's own lies under it.
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.danger}`,
    outline: { default: null, [FORCED]: "2px dashed CanvasText" },
    outlineOffset: { default: null, [FORCED]: -2 },
    color: { default: grasp.lightPaper, [FORCED]: "CanvasText" },
    cursor: "pointer",
  },
  // Why a file was refused, under the well; a screen reader hears it too.
  refusal: {
    margin: 0,
    maxWidth: "20rem",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    // The danger colour for words on the page's own ground (as a field's error); `dangerText` is
    // the white for words on a red fill, and was invisible here.
    color: grasp.danger,
  },
});

/** A new picture while it is saved, or after its save failed. */
interface Pending {
  file: File;
  preview: string;
  status: "saving" | "failed";
}

type Status = "idle" | "saving" | "failed";

/** The picture or the initials, the veil and the spinner: what the well holds. */
const Inside = ({
  shown,
  fit,
  initials,
  status,
  size,
}: {
  shown: string | null;
  fit: "cover" | "contain";
  initials?: string;
  status: Status;
  size: "sm" | "lg";
}) => (
  <>
    {shown === null ? (
      <span aria-hidden="true" {...stylex.props(styles.initials)}>
        {initials === undefined ? (
          <Icon icon={ImageMark} />
        ) : (
          initialsOf(initials)
        )}
      </span>
    ) : (
      <img
        src={shown}
        alt=""
        {...stylex.props(styles.picture, fit === "contain" && styles.contain)}
      />
    )}
    <span
      aria-hidden="true"
      {...stylex.props(styles.veil, shown === null && styles.veilBare)}
    >
      <Icon icon={Upload} />
    </span>
    {status === "saving" ? (
      <span aria-hidden="true" {...stylex.props(styles.busy)}>
        <Spinner size={size === "lg" ? "md" : "sm"} />
      </span>
    ) : null}
  </>
);

// One save, start to end, so the caller's late answer can be dropped once it is no longer current.
const runSave = async (job: {
  start: () => Promise<string | undefined>;
  saved: (url: string | undefined) => void;
  failed: () => void;
}) => {
  let url: string | undefined;
  try {
    url = await job.start();
  } catch {
    job.failed();
    return;
  }
  job.saved(url);
};

/** The picture's state: what is kept, what is new and saving or failed, and how to change them. */
const usePicture = (
  props: Pick<
    ImageWellProps,
    "value" | "defaultValue" | "onValueChange" | "upload"
  >,
  words: ImageWellWords
) => {
  const { value, defaultValue = null, onValueChange, upload } = props;
  const [own, setOwn] = useState<string | null>(defaultValue);
  const kept = value === undefined ? own : value;
  const [pending, setPending] = useState<Pending | null>(null);
  const [said, setSaid] = useState("");
  const running = useRef<AbortController | null>(null);

  const commit = (next: string | null, file: File | null) => {
    if (value === undefined) {
      setOwn(next);
    }
    onValueChange?.(next, file);
  };

  const save = (file: File, preview: string) => {
    if (!upload) {
      commit(preview, file);
      return;
    }
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setPending({ file, preview, status: "saving" });
    setSaid(words.saving);
    void runSave({
      start: async () => await upload(file, controller.signal),
      saved: (url) => {
        if (running.current !== controller) {
          return;
        }
        setPending(null);
        setSaid(words.saved);
        commit(url ?? preview, file);
      },
      failed: () => {
        if (running.current !== controller || controller.signal.aborted) {
          return;
        }
        setPending({ file, preview, status: "failed" });
        setSaid(words.failed);
      },
    });
  };

  // Remove: a new picture not yet kept is dropped, and the one before shows again; else the kept one goes.
  const remove = () => {
    running.current?.abort();
    running.current = null;
    if (pending) {
      setPending(null);
      setSaid("");
      return;
    }
    commit(null, null);
  };

  useEffect(
    () => () => {
      running.current?.abort();
    },
    []
  );

  return { kept, pending, said, setSaid, save, remove };
};

/** What the tooltip says: how to change it and its limits, or that the save failed. */
const tipFor = (
  status: Status,
  words: ImageWellWords,
  hint: string | undefined
) =>
  status === "failed"
    ? `${words.failed}. ${words.retry}?`
    : [words.how, hint].filter(Boolean).join(" ");

/** Ids joined for aria-describedby, or nothing. */
const joined = (ids: (string | undefined)[]) =>
  ids.filter(Boolean).join(" ") || undefined;

/** The tooltip's own props on the well, its click among them. */
type TipProps = Record<string, unknown> & {
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

interface WellProps {
  mounted: boolean;
  look: {
    shown: string | null;
    fit: "cover" | "contain";
    initials?: string;
    status: Status;
    size: "sm" | "lg";
  };
  tip: string;
  control: {
    id?: string;
    label: string;
    describedBy?: string;
    name?: string;
    accept: string | readonly string[];
    disabled?: boolean;
  };
  onOpen: () => void;
}

/** A logo shown whole stands on the card's ground; a photo, or an empty well, on the soft tint. */
const onGround = (look: WellProps["look"]) =>
  look.fit === "contain" && look.shown !== null;

/** The well: a button that opens the picker, its tooltip the limits; without script, the browser's own file input over it. */
const Well = ({ mounted, look, tip, control, onOpen }: WellProps) => {
  if (!mounted) {
    return (
      <span
        {...stylex.props(styles.well, onGround(look) && styles.wellContain)}
      >
        <Inside {...look} />
        <input
          id={control.id}
          data-slot="image-well-native"
          type="file"
          name={control.name}
          accept={
            typeof control.accept === "string"
              ? control.accept
              : control.accept.join(",")
          }
          disabled={control.disabled}
          aria-label={control.label}
          {...stylex.props(styles.native)}
        />
      </span>
    );
  }
  return (
    <Tooltip>
      <TriggerPrimitive
        render={(trigger: TipProps) => (
          <button
            {...trigger}
            id={control.id}
            type="button"
            disabled={control.disabled}
            aria-label={control.label}
            aria-describedby={control.describedBy}
            aria-busy={look.status === "saving" ? true : undefined}
            data-slot="image-well-button"
            onClick={(event) => {
              trigger.onClick?.(event);
              onOpen();
            }}
            {...stylex.props(
              styles.well,
              onGround(look) && styles.wellContain,
              focus.ring
            )}
          >
            <Inside {...look} />
          </button>
        )}
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
};

/** The well's small buttons: Try again over it after a failed save, remove at its corner. */
const Marks = ({
  size,
  words,
  onRetry,
  onRemove,
}: {
  size: "sm" | "lg";
  words: ImageWellWords;
  onRetry?: () => void;
  onRemove?: () => void;
}) => (
  <>
    {onRetry ? (
      <button
        type="button"
        aria-label={words.retry}
        data-slot="image-well-retry"
        onClick={onRetry}
        {...stylex.props(styles.retry, focus.ring)}
      >
        <Icon icon={Retry} />
      </button>
    ) : null}
    {onRemove ? (
      <button
        type="button"
        aria-label={words.remove}
        data-slot="image-well-remove"
        onClick={onRemove}
        {...stylex.props(
          styles.mark,
          styles.remove,
          size === "lg" ? styles.removeLg : styles.removeSm,
          focus.ring
        )}
      >
        <Icon icon={Cross} />
      </button>
    ) : null}
  </>
);

/** A picture in a form, the well itself the control: click or drop to change it. */
export const ImageWell = ({
  initials,
  accept = pictures,
  maxSize,
  hint,
  fit = "cover",
  size = "sm",
  name,
  disabled,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  words: given,
  layout,
  ...picture
}: ImageWellProps) => {
  // Its words: the product's, by its catalogue, else English; the caller's `words` still win.
  const words = withGiven(useWords("imageWell", imageWellWords), given ?? {});
  const { kept, pending, said, setSaid, save, remove } = usePicture(
    picture,
    words
  );
  const [refusalHere, setRefusalHere] = useState("");
  // In a Setting row the refusal goes in the row's line under its name, where a failed save's
  // sentence goes, so the row keeps its height; standing alone it is drawn under the well.
  const toRow = useRowProblem();
  const setRefusal = (line: string) => {
    if (toRow === null) {
      setRefusalHere(line);
    } else {
      toRow(line);
    }
  };
  // Until the page runs its script, the browser's own file input does the work.
  const [mounted, setMounted] = useState(false);
  // oxlint-disable-next-line react/hook-use-state -- a controller made once, never replaced
  const [files] = useState(createFileInputController);
  const refusalId = useId();
  const fieldName = useFieldName();
  const sentAs = name ?? fieldName;

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the browser's own input hands over only once the page runs its script
    setMounted(true);
  }, []);

  const shown = pending?.preview ?? kept;
  const status: Status = pending?.status ?? "idle";

  const change = (next: File[], details: FileInputValueChangeDetails) => {
    const file = details.added[0] ?? next[0];
    if (file === undefined) {
      return;
    }
    setRefusal("");
    save(file, URL.createObjectURL(file));
  };
  const reject = (rejected: { file: File; reasons: string[] }[]) => {
    const [first] = rejected;
    if (first === undefined) {
      return;
    }
    const reason = first.reasons[0] ?? "";
    // The row's line is a live region of its own and says it there; once is enough.
    if (toRow === null) {
      const line = words.refused(first.file.name, reason);
      setRefusal(line);
      setSaid(line);
    } else {
      setRefusal(
        words.refusedInRow?.(reason) ?? words.refused(first.file.name, reason)
      );
    }
  };
  const label = ariaLabel ?? (shown === null ? words.add : words.change);
  const tipWords = tipFor(status, words, hint);
  const describedByAll = joined([
    describedBy,
    refusalHere ? refusalId : undefined,
  ]);

  return (
    <div
      data-slot="image-well"
      data-state={status}
      {...stylex.props(styles.root, wellMarker, layout)}
    >
      <FileInput
        accept={accept}
        maxSize={maxSize}
        name={mounted ? sentAs : undefined}
        disabled={disabled}
        controller={files}
        onValueChange={change}
        onReject={reject}
        announcement={() => null}
      >
        <FileInputDropzone
          className={stylex.props(styles.zone, styles[size]).className}
        >
          <Well
            mounted={mounted}
            look={{ shown, fit, initials, status, size }}
            tip={tipWords}
            control={{
              id,
              label,
              describedBy: describedByAll,
              name: sentAs,
              accept,
              disabled,
            }}
            onOpen={() => {
              files.open();
            }}
          />
          {mounted ? (
            <Marks
              size={size}
              words={words}
              onRetry={
                pending && status === "failed"
                  ? () => {
                      save(pending.file, pending.preview);
                    }
                  : undefined
              }
              onRemove={
                shown !== null && disabled !== true
                  ? () => {
                      files.clear();
                      setRefusal("");
                      remove();
                    }
                  : undefined
              }
            />
          ) : null}
        </FileInputDropzone>
      </FileInput>
      {refusalHere ? (
        <p
          id={refusalId}
          data-slot="image-well-refusal"
          {...stylex.props(styles.refusal)}
        >
          {refusalHere}
        </p>
      ) : null}
      <span
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
        role="status"
        data-slot="image-well-said"
        {...stylex.props(visuallyHidden)}
      >
        {said}
      </span>
    </div>
  );
};
