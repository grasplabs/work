// ImageUpload: one picture in a form (a logo, a team's or a person's picture), the picture itself
// the control. Not a circle with a button beside it: a square well with soft corners that shows the
// picture, or its fallback (initials) while there is none. Pressing it, or Enter or Space on it,
// opens the picker; a picture dropped on it takes its place. A small remove stands at its corner on
// hover, on focus and always on touch. What it takes (its types, its size) is in a tooltip.
//
//   <Field orientation="responsive">
//     <FieldContent><FieldLabel>Logo</FieldLabel></FieldContent>
//     <ImageUpload fallback="NF" accept={["image/png"]} maxFileSize={2_000_000} description="PNG, up to 2 MB" />
//   </Field>
//
// It is FileUpload's machinery (UI SDK's File Input): the same checks of type and size, the same
// refusals said with their reason. Given `onUpload`, a new picture is saved at once: the well shows
// it dimmed with a spinner while it saves, and a destructive edge with Try again on it if the save
// failed; remove then puts the picture back as it was. Without `onUpload` the file goes with the
// form. Without script it is the browser's own file input, over the whole well. Every value is a
// token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createFileInputController,
  FileInput,
  FileInputDropzone,
} from "@ui-sdk/react/file-input";
import type { FileInputValueChangeDetails } from "@ui-sdk/react/file-input";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { useI18n } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import {
  Icon,
  ImageIcon,
  RefreshCwIcon,
  UploadIcon,
  XIcon,
} from "../lib/icons";
import { focusRing, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { useFieldControl } from "./field";
import { useHandover } from "./file-upload-handover";
import { wellMarker } from "./file-upload.stylex";
import { Spinner } from "./spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type Words = I18nCatalog["imageUpload"];

/** Every prop an ImageUpload takes. */
export interface ImageUploadProps {
  /** The picture now, as an address; `null` for none. Pass it with `onValueChange` to control it. */
  value?: string | null;
  /** The picture it starts with, when you do not control it. */
  defaultValue?: string | null;
  /** Runs with the new picture's address (`null` once removed), and the file it came from. */
  onValueChange?: (value: string | null, file: File | null) => void;
  /** Saves a new picture at once; resolve with its stored address, or with nothing to keep showing the file. */
  onUpload?: (file: File, signal: AbortSignal) => Promise<string | undefined>;
  /** What stands in the well while it is empty: initials ("NF"). Left out, a picture mark. */
  fallback?: ReactNode;
  /**
   * The kinds of picture it takes, as types or endings.
   * @default ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]
   */
  accept?: string | readonly string[];
  /** The largest file it takes, in bytes. */
  maxFileSize?: number;
  /** What it takes, in words, for the tooltip ("PNG or SVG, up to 2 MB"). */
  description?: string;
  /**
   * How the picture fills the well: `cover` crops it to fill (a photo), `contain` shows it whole on
   * the card's ground (a logo).
   * @default "cover"
   */
  fit?: "cover" | "contain";
  /**
   * `default` 40px, at home in a setting's row; `lg` 96px, for a page of its own.
   * @default "default"
   */
  size?: "default" | "lg";
  /** The name the file is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /**
   * Out of use.
   * @default false
   */
  disabled?: boolean;
  /** The id a label's `for` points at. Inside a Field, the Field's serves. */
  id?: string;
  /** Its name when no label names it. */
  "aria-label"?: string;
  /** What describes it. Inside a Field, the Field's description serves. */
  "aria-describedby"?: string;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

const pictures = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

const FORCED = media.forcedColors;
const HOVER = media.hover;
const COARSE = media.pointerCoarse;
// The well's own states, read from the root, so every layer follows them.
const SAVING = ":is([data-state=saving])";
const FAILED = ":is([data-state=failed])";
// UI SDK marks its dropzone, inside the root, while a file is over it.
const DRAGGING = ":has([data-dragging])";

const styles = stylex.create({
  root: {
    display: "inline-grid",
    // As wide as the well, even where a Field's grid would stretch it.
    justifySelf: "start",
    rowGap: space[2],
    justifyItems: "start",
    fontFamily: font.sans,
  },
  // The dropzone is the well's square: everything else stands in it.
  zone: {
    position: "relative",
    display: "grid",
    boxSizing: "border-box",
    borderRadius: `min(${radius.xl}, 28%)`,
    cornerShape: radius.shape,
  },
  // The initials at the size an Avatar gives them at that size. `default` stands in a setting's
  // control column without making the row taller: 40px.
  default: {
    width: space[10],
    height: space[10],
    fontSize: font.headingSm,
    [iconVars.size]: sizes.iconSm,
  },
  lg: {
    width: space[24],
    height: space[24],
    fontSize: font.headingXl,
    [iconVars.size]: sizes.iconDefault,
  },
  // The well: a button the size of the zone, the picture or the fallback inside, the system's edge.
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
    cornerShape: "inherit",
    backgroundColor: colors.muted,
    boxShadow: {
      default: sizes.borderStrong,
      [stylex.when.ancestor(DRAGGING, wellMarker)]:
        `inset 0 0 0 1px ${colors.inputBorderHover}`,
      [stylex.when.ancestor(FAILED, wellMarker)]:
        `inset 0 0 0 ${sizes.hairline} ${colors.destructive}`,
    },
    color: colors.mutedForeground,
    fontFamily: "inherit",
    fontWeight: font.weightMedium,
    lineHeight: 1,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": sizes.opacityDisabled },
    transitionProperty: "box-shadow",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  picture: {
    gridArea: "1 / 1",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    // While it saves, the new picture is there but dimmed: it is not kept yet.
    opacity: {
      default: 1,
      [stylex.when.ancestor(SAVING, wellMarker)]: sizes.opacityDisabled,
    },
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
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
    backgroundColor: colors.dialogScrim,
    color: colors.brandPaper,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", wellMarker)]: { default: 0, [HOVER]: 1 },
      [stylex.when.ancestor(":has(:focus-visible)", wellMarker)]: 1,
      [stylex.when.ancestor(DRAGGING, wellMarker)]: 1,
      [stylex.when.ancestor(SAVING, wellMarker)]: 0,
      [stylex.when.ancestor(FAILED, wellMarker)]: 0,
    },
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
    pointerEvents: "none",
  },
  // The fallback gives way to the upload mark whenever the veil would show.
  fallback: {
    gridArea: "1 / 1",
    opacity: {
      default: 1,
      [stylex.when.ancestor(":hover", wellMarker)]: { default: 1, [HOVER]: 0 },
      [stylex.when.ancestor(":has(:focus-visible)", wellMarker)]: 0,
      [stylex.when.ancestor(DRAGGING, wellMarker)]: 0,
    },
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
  },
  // Empty, there is no picture to veil: the mark alone, in the well's quiet ink.
  veilBare: { backgroundColor: "transparent", color: colors.bodyForeground },
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
  // The small round buttons on the well: remove at its corner, Try again over it.
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
    borderRadius: radius.circle,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
    color: {
      default: colors.bodyForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    cursor: "pointer",
  },
  // Its centre on the middle of the well's rounded corner, so it sits on the corner, never over the
  // picture's middle.
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
    transitionDuration: motionVars.hover,
  },
  // The smallest round button that keeps a 24px target on a fine pointer, and a 44px one on touch.
  // On touch the target grows away from the well, up and out from its corner, so it never takes a
  // press on the picture.
  removeDefault: {
    [iconVars.size]: 10,
    width: 16,
    height: 16,
    "::before": {
      content: "''",
      position: "absolute",
      top: { default: -4, [COARSE]: `calc(16px - ${sizes.tapTarget})` },
      insetInlineEnd: {
        default: -4,
        [COARSE]: `calc(16px - ${sizes.tapTarget})`,
      },
      bottom: { default: -4, [COARSE]: 0 },
      insetInlineStart: { default: -4, [COARSE]: 0 },
    },
  },
  removeLg: {
    [iconVars.size]: space[3],
    width: 20,
    height: 20,
    "::before": {
      content: "''",
      position: "absolute",
      top: { default: -2, [COARSE]: `calc(20px - ${sizes.tapTarget})` },
      insetInlineEnd: {
        default: -2,
        [COARSE]: `calc(20px - ${sizes.tapTarget})`,
      },
      bottom: { default: -2, [COARSE]: 0 },
      insetInlineStart: { default: -2, [COARSE]: 0 },
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
    cornerShape: "inherit",
    backgroundColor: { default: colors.dialogScrim, [FORCED]: "Canvas" },
    // The destructive edge drawn again over the veil, as the well's own lies under it.
    boxShadow: `inset 0 0 0 ${sizes.hairline} ${colors.destructive}`,
    outline: { default: null, [FORCED]: "2px dashed CanvasText" },
    outlineOffset: { default: null, [FORCED]: -2 },
    color: { default: colors.brandPaper, [FORCED]: "CanvasText" },
    cursor: "pointer",
  },
  // Why a file was refused, under the well; a screen reader hears it too.
  error: {
    margin: 0,
    maxWidth: "20rem",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.destructive,
  },
});

/** A new picture while it is saved, or after its save failed; with no preview when it could not be read. */
interface Pending {
  file: File;
  preview: string | null;
  status: "saving" | "failed";
}

type Status = "idle" | "saving" | "failed";
type Size = "default" | "lg";

/** The picture or the fallback, the veil and the spinner: what the well holds. */
const Inside = ({
  shown,
  fit,
  fallback,
  status,
  size,
}: {
  shown: string | null;
  fit: "cover" | "contain";
  fallback?: ReactNode;
  status: Status;
  size: Size;
}) => (
  <>
    {shown === null ? (
      <span aria-hidden="true" {...stylex.props(styles.fallback)}>
        {fallback ?? <Icon icon={ImageIcon} />}
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
      <Icon icon={UploadIcon} />
    </span>
    {status === "saving" ? (
      <span aria-hidden="true" {...stylex.props(styles.busy)}>
        <Spinner size={size === "lg" ? "default" : "sm"} />
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

// A new picture's preview as a data: URL, read off the page's thread. Not a blob: URL: a page whose
// policy takes pictures only from itself and data: refuses those.
const readPreview = async (file: File) =>
  // oxlint-disable-next-line promise/avoid-new -- FileReader has no promise of its own
  await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("unreadable"));
    });
    reader.readAsDataURL(file);
  });

/** The picture's state: what is kept, what is new and saving or failed, and how to change them. */
const usePicture = (
  props: Pick<
    ImageUploadProps,
    "value" | "defaultValue" | "onValueChange" | "onUpload"
  >,
  words: Words
) => {
  const { value, defaultValue = null, onValueChange, onUpload } = props;
  const [own, setOwn] = useState<string | null>(defaultValue);
  const kept = value === undefined ? own : value;
  const [pending, setPending] = useState<Pending | null>(null);
  const [said, setSaid] = useState("");
  const running = useRef<AbortController | null>(null);
  // The picture last picked: a preview read after another was picked, after remove, or after the
  // well unmounts, is dropped.
  const picked = useRef(0);

  const commit = (next: string | null, file: File | null) => {
    if (value === undefined) {
      setOwn(next);
    }
    onValueChange?.(next, file);
  };

  const save = (file: File, preview: string) => {
    if (!onUpload) {
      commit(preview, file);
      return;
    }
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setPending({ file, preview, status: "saving" });
    setSaid(words.saving);
    void runSave({
      start: async () => await onUpload(file, controller.signal),
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
        setSaid(words.error);
      },
    });
  };

  // A picked file: its preview read, then saved as any new picture is.
  const pick = async (file: File) => {
    picked.current += 1;
    const turn = picked.current;
    let preview: string;
    try {
      preview = await readPreview(file);
    } catch {
      if (picked.current === turn) {
        running.current?.abort();
        running.current = null;
        setPending({ file, preview: null, status: "failed" });
        setSaid(words.error);
      }
      return;
    }
    if (picked.current === turn) {
      save(file, preview);
    }
  };

  // Remove: a new picture not yet kept is dropped, and the one before shows again; else the kept one goes.
  const remove = () => {
    picked.current += 1;
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
      picked.current += 1;
      running.current?.abort();
    },
    []
  );

  // Try again, after a failed save: the same picture saved again (read again if it could not be).
  const retry =
    pending?.status === "failed"
      ? () => {
          if (pending.preview === null) {
            void pick(pending.file);
            return;
          }
          save(pending.file, pending.preview);
        }
      : undefined;

  return { kept, pending, said, setSaid, pick, remove, retry };
};

/** What the tooltip says: how to change it and its limits, or that the save failed. */
const tipFor = (
  status: Status,
  words: Words,
  description: string | undefined
) =>
  status === "failed"
    ? words.retryTip
    : [words.how, description].filter(Boolean).join(" ");

/** Ids joined for aria-describedby, or nothing. */
const joined = (ids: (string | undefined)[]) =>
  ids.filter(Boolean).join(" ") || undefined;

interface WellProps {
  mounted: boolean;
  /** The browser's own input, while it is drawn. */
  native: RefObject<HTMLInputElement | null>;
  look: {
    shown: string | null;
    fit: "cover" | "contain";
    fallback?: ReactNode;
    status: Status;
    size: Size;
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
const Well = ({ mounted, native, look, tip, control, onOpen }: WellProps) => {
  if (!mounted) {
    return (
      <span
        {...stylex.props(styles.well, onGround(look) && styles.wellContain)}
      >
        <Inside {...look} />
        <input
          ref={native}
          id={control.id}
          data-slot="image-upload-input"
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
      <TooltipTrigger asChild>
        <button
          id={control.id}
          type="button"
          disabled={control.disabled}
          aria-label={control.label}
          aria-describedby={control.describedBy}
          aria-busy={look.status === "saving" ? true : undefined}
          data-slot="image-upload-button"
          onClick={onOpen}
          {...stylex.props(
            styles.well,
            onGround(look) && styles.wellContain,
            focusRing
          )}
        >
          <Inside {...look} />
        </button>
      </TooltipTrigger>
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
  size: Size;
  words: Words;
  onRetry?: () => void;
  onRemove?: () => void;
}) => (
  <>
    {onRetry ? (
      <button
        type="button"
        aria-label={words.retry}
        data-slot="image-upload-retry"
        onClick={onRetry}
        {...stylex.props(styles.retry, focusRing)}
      >
        <Icon icon={RefreshCwIcon} />
      </button>
    ) : null}
    {onRemove ? (
      <button
        type="button"
        aria-label={words.remove}
        data-slot="image-upload-remove"
        onClick={onRemove}
        {...stylex.props(
          styles.mark,
          styles.remove,
          size === "lg" ? styles.removeLg : styles.removeDefault,
          focusRing
        )}
      >
        <Icon icon={XIcon} />
      </button>
    ) : null}
  </>
);

/** The well's wiring: its own, or the Field's round it, and its name from what a press does. */
const controlOf = ({
  field,
  id,
  label,
  shown,
  words,
  describedBy,
  errorId,
}: {
  field: ReturnType<typeof useFieldControl>;
  id: string | undefined;
  label: string | undefined;
  shown: string | null;
  words: Words;
  describedBy: string | undefined;
  errorId: string | undefined;
}) => ({
  id: id ?? field?.id,
  // Its own name says what a press does: add a picture, or change the one there.
  label: label ?? (shown === null ? words.add : words.change),
  describedBy: joined([describedBy ?? field?.["aria-describedby"], errorId]),
});

/** A picture in a form, the well itself the control: click or drop to change it. */
export const ImageUpload = ({
  fallback,
  accept = pictures,
  maxFileSize,
  description,
  fit = "cover",
  size = "default",
  name,
  disabled,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  style,
  ...picture
}: ImageUploadProps) => {
  const words = useI18n().imageUpload;
  const { kept, pending, said, setSaid, pick, remove, retry } = usePicture(
    picture,
    words
  );
  const [error, setError] = useState("");
  // oxlint-disable-next-line react/hook-use-state -- a controller made once, never replaced
  const [files] = useState(createFileInputController);
  const errorId = useId();
  const root = useRef<HTMLDivElement>(null);
  const native = useRef<HTMLInputElement>(null);
  // Until the page runs its script, the browser's own file input does the work.
  const mounted = useHandover(native, () => {
    root.current
      ?.querySelector<HTMLElement>("[data-slot=image-upload-button]")
      ?.focus();
  });
  // Inside a Field: its id (the label's `for`), its description, its name and whether it is out of use.
  const field = useFieldControl();
  const sentAs = name ?? field?.name;
  const off = disabled ?? field?.disabled;

  const shown = pending?.preview ?? kept;
  const status: Status = pending?.status ?? "idle";

  const change = (next: File[], details: FileInputValueChangeDetails) => {
    const file = details.added[0] ?? next[0];
    if (file === undefined) {
      return;
    }
    setError("");
    void pick(file);
  };
  const reject = (rejected: { file: File; reasons: string[] }[]) => {
    const [first] = rejected;
    if (first === undefined) {
      return;
    }
    const reason = first.reasons[0] ?? "";
    // In a setting's row (a responsive Field) the person has just picked the file: its line leaves
    // the name out, so it stays short. Standing alone it names the file.
    const inRow = Boolean(
      root.current?.closest("[data-orientation=responsive]")
    );
    const line = inRow
      ? words.refusedInRow(reason)
      : words.refused(first.file.name, reason);
    setError(line);
    setSaid(line);
  };
  const removable = shown !== null && off !== true;
  const wiring = controlOf({
    field,
    id,
    label: ariaLabel,
    shown,
    words,
    describedBy,
    errorId: error ? errorId : undefined,
  });

  return (
    <div
      ref={root}
      data-slot="image-upload"
      data-state={status}
      {...stylex.props(styles.root, wellMarker, style)}
    >
      <FileInput
        accept={accept}
        maxSize={maxFileSize}
        name={mounted ? sentAs : undefined}
        disabled={off}
        controller={files}
        onValueChange={change}
        onReject={reject}
        announcement={() => null}
      >
        <FileInputDropzone className={className(styles.zone, styles[size])}>
          <Well
            mounted={mounted}
            native={native}
            look={{ shown, fit, fallback, status, size }}
            tip={tipFor(status, words, description)}
            control={{ ...wiring, name: sentAs, accept, disabled: off }}
            onOpen={() => {
              files.open();
            }}
          />
          {mounted ? (
            <Marks
              size={size}
              words={words}
              onRetry={retry}
              onRemove={
                removable
                  ? () => {
                      files.clear();
                      setError("");
                      remove();
                    }
                  : undefined
              }
            />
          ) : null}
        </FileInputDropzone>
      </FileInput>
      {error ? (
        <p
          id={errorId}
          data-slot="image-upload-error"
          {...stylex.props(styles.error)}
        >
          {error}
        </p>
      ) : null}
      <span
        // Not every screen reader treats <output> as a live region; role="status" is.
        role="status"
        data-slot="image-upload-live-region"
        {...stylex.props(visuallyHidden)}
      >
        {said}
      </span>
    </div>
  );
};
