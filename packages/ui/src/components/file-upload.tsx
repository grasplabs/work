// FileUpload: a place in a form to drop or choose files, and the list of what was chosen, on UI SDK's
// File Input. Files are checked as they arrive (their type, their size, how many), and one that is
// refused is named with the reason. Given `onUpload`, each file is sent at once and its row shows how
// far it is, that it is done, or that it failed, with Try again. Without it, the files go with the
// form.
//
//   <Field name="files">
//     <FieldLabel>Contracts</FieldLabel>
//     <FileUpload multiple accept={[".pdf"]} maxFileSize={10_000_000} onUpload={send} />
//   </Field>
//
// The dropzone is a tinted ground with the system's edge, no dashed line. It works by keyboard (its
// button opens the picker; the arrow keys move through the list, Delete removes), and without
// script as a plain file input. Each file sent, not sent or refused is said once, politely. Every
// value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createFileInputController,
  FileInput,
  FileInputDropzone,
  FileInputItem,
  FileInputItemRemove,
  FileInputList,
  FileInputTrigger,
  formatFileSize,
} from "@ui-sdk/react/file-input";
import type { FileInputValueChangeDetails } from "@ui-sdk/react/file-input";
import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";

import { useI18n, useLocale } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import { FileIcon, Icon, UploadIcon, XIcon, fileMark } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { fadeIn, focusRing, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import { useFieldControl } from "./field";
import { useHandover } from "./file-upload-handover";
import { Progress } from "./progress";
import { Spinner } from "./spinner";

type Words = I18nCatalog["fileUpload"];

/** What the host says of a sent file, in place of "Uploaded": what it is doing with it. */
export interface FileUploadStatus {
  /** One short line ("Reading the text", "Ready", "Could not read"). */
  message: string;
  /**
   * `destructive` when it failed, in the destructive colour; otherwise muted.
   * @default "default"
   */
  variant?: "default" | "destructive";
  /** Still at work on it: a small turning mark before the line. */
  loading?: boolean;
}

/** Something to do with a sent file, at its row's end before Remove: Open, Download. */
export interface FileUploadAction {
  /** Its words, a verb ("Open", "Download"). */
  label: string;
  /** An icon; with one, the button is the icon alone, named by `label`. */
  icon?: IconData;
  /** Where it goes: the button is a link. */
  href?: string;
  /** What it does, for a button that is not a link. */
  onClick?: () => void;
}

/** Every prop a FileUpload takes. */
export interface FileUploadProps {
  /**
   * More than one file. Without it, a new file takes the place of the one there.
   * @default false
   */
  multiple?: boolean;
  /** The files it takes: MIME types, wildcards and endings, as `["image/*", ".pdf"]`. Any file without it. */
  accept?: string | readonly string[];
  /** The largest file it takes, in bytes. */
  maxFileSize?: number;
  /** The most files it takes. */
  maxFiles?: number;
  /**
   * What it takes, in words, said under the dropzone and with its button: "PDF or PNG, up to 10 MB".
   * @default `accept` and `maxFileSize` in the I18nProvider's `fileUpload.limits`
   */
  description?: string;
  /**
   * Sends one file. Call `progress` with 0 to 1 as it goes; throw, or reject, when it fails. Each
   * file is sent as it arrives; Try again sends it again. With it, the files are not sent with the
   * form as well: send what `onUpload` gave back. Without it, the files go with the form.
   */
  onUpload?: (
    file: File,
    progress: (done: number) => void,
    signal: AbortSignal
  ) => Promise<void>;
  /** The files, to keep them yourself; pass it with `onValueChange`. */
  value?: File[];
  /** Runs with the files whenever one is added or taken away. */
  onValueChange?: (files: File[]) => void;
  /** The name the files are sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /**
   * A file is needed before the form is sent.
   * @default false
   */
  required?: boolean;
  /**
   * Out of use.
   * @default false
   */
  disabled?: boolean;
  /**
   * What the host does with a file once it is sent (or chosen, without `onUpload`), said on its row
   * in place of "Uploaded": reading it, ready, could not read. The list is then the only list of
   * the files; nothing need be drawn again below it.
   */
  getFileStatus?: (file: File) => FileUploadStatus | undefined;
  /** What can be done with a sent file, at its row's end before Remove: Open, Download. */
  getFileActions?: (file: File) => FileUploadAction[];
  /**
   * `dropzone`, a place to drop files, with its button; `button`, the button alone (with an icon),
   * for a card's head, the list drawn below it or in `listContainer`.
   * @default "dropzone"
   */
  variant?: "dropzone" | "button";
  /** With `variant="button"`: where the list of files is drawn, an element of the host's. */
  listContainer?: HTMLElement | null;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

interface Sending {
  status: "uploading" | "done" | "failed";
  progress: number;
}

/** The kinds of file it takes, one by one, from `accept` as given. */
const typesOf = (accept: FileUploadProps["accept"]): readonly string[] =>
  (typeof accept === "string" ? accept.split(",") : (accept ?? []))
    .map((type) => type.trim())
    .filter((type) => type !== "");

const FORCED = media.forcedColors;

const styles = stylex.create({
  root: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    rowGap: space[3],
    minWidth: 0,
    fontFamily: font.sans,
  },
  // UI SDK's own root holds the dropzone and the list: the same room between them.
  inner: {
    display: "grid",
    rowGap: space[2],
    minWidth: 0,
  },
  // The dropzone: a soft tint with the system's edge. Files over it deepen the tint; a file it will
  // not take turns the edge red.
  zone: {
    position: "relative",
    display: "grid",
    justifyItems: "center",
    rowGap: space[2],
    boxSizing: "border-box",
    minWidth: 0,
    paddingBlock: space[6],
    paddingInline: space[4],
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: {
      default: colors.muted,
      ":is([data-dragging])": colors.accentActive,
    },
    boxShadow: {
      default: size.borderStrong,
      ":is([data-dragging])": `inset 0 0 0 1px ${colors.inputBorderHover}`,
      ":is([data-drag-reject])": shadow.smDestructive,
    },
    outline: {
      default: "none",
      [FORCED]: {
        default: "1px solid CanvasText",
        ":is([data-dragging])": "2px solid Highlight",
      },
    },
    textAlign: "center",
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    transitionProperty: "background-color, box-shadow",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  // The button form: the button, with the browser's own input over it until the script runs.
  buttonBox: {
    position: "relative",
    display: "inline-flex",
    justifySelf: "start",
  },
  // Without script: the browser's own file input, unseen over the whole dropzone (or the button),
  // takes a click or a drop.
  native: {
    position: "absolute",
    zIndex: 1,
    inset: 0,
    width: "100%",
    height: "100%",
    opacity: 0,
    cursor: "pointer",
  },
  zoneIcon: {
    display: "inline-flex",
    color: colors.mutedForeground,
  },
  zoneLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: space[2],
  },
  description: {
    margin: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.subtleForeground,
  },
  // The files: one row each, its name, its size or where its sending is, and its actions. With no
  // files it takes no row, so no gap stands between the dropzone and the field's description.
  list: {
    display: { default: "grid", ":empty": "none" },
    rowGap: space[1],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space[3],
    rowGap: space[1],
    minWidth: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
    // A border that only forced colours show: the focus ring keeps the outline to itself.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
  },
  fileIcon: {
    display: "inline-flex",
    color: colors.mutedForeground,
  },
  words: {
    display: "grid",
    minWidth: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
  },
  meta: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  failed: {
    color: colors.destructive,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space[1],
  },
  // How far a file has gone: a thin bar under its row.
  progress: {
    gridColumn: "1 / -1",
    display: "flex",
  },
  errors: {
    display: "grid",
    rowGap: space[1],
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.destructive,
  },
});

// One upload, start to end: `sent` once it resolves, `failed` once it rejects.
const runUpload = async (job: {
  start: () => Promise<void>;
  sent: () => void;
  failed: () => void;
}) => {
  try {
    await job.start();
  } catch {
    job.failed();
    return;
  }
  job.sent();
};

// The line under a file's name: how far it is sent, that it was, that it failed, or its size.
const metaLine = (
  file: File,
  state: Sending | undefined,
  words: Words,
  told: FileUploadStatus | undefined,
  locale: string | undefined
) => {
  if (state?.status === "uploading") {
    return words.uploading(Math.round(state.progress * 100));
  }
  // Sent (or chosen, with nothing to send): the host's own word on it, when it has one.
  if (told !== undefined && state?.status !== "failed") {
    return told.message;
  }
  if (state?.status === "done") {
    return words.doneLine(formatFileSize(file.size, locale));
  }
  if (state?.status === "failed") {
    return words.error;
  }
  return formatFileSize(file.size, locale);
};

/** One thing to do with a sent file: a ghost button, or a link; with an icon, the icon alone. */
const RowAction = ({ action }: { action: FileUploadAction }) => {
  const iconOnly = action.icon !== undefined;
  const inside = iconOnly ? (
    <Icon icon={action.icon ?? FileIcon} />
  ) : (
    action.label
  );
  const look = iconOnly
    ? ({ size: "icon-sm", "aria-label": action.label } as const)
    : ({ size: "sm" } as const);
  if (action.href !== undefined) {
    return (
      <Button variant="ghost" {...look} asChild>
        <a href={action.href}>{inside}</a>
      </Button>
    );
  }
  const handleClick = action.onClick;
  return (
    <Button variant="ghost" {...look} onClick={handleClick}>
      {inside}
    </Button>
  );
};

/** The browser's own file input, unseen over the dropzone or the button, until the script runs. */
interface NativeProps {
  native: { current: HTMLInputElement | null };
  name: string | undefined;
  accept: FileUploadProps["accept"];
  multiple: boolean;
  required: boolean | undefined;
  disabled: boolean | undefined;
  label: string;
}

const Native = ({
  native,
  name,
  accept,
  multiple,
  required,
  disabled,
  label,
}: NativeProps) => (
  <input
    ref={native}
    data-slot="file-upload-input"
    type="file"
    name={name}
    accept={typeof accept === "string" ? accept : accept?.join(",")}
    multiple={multiple}
    required={required}
    disabled={disabled}
    aria-label={label}
    {...stylex.props(styles.native)}
  />
);

/** The button that opens the picker: unseen to the keys and a screen reader until the script runs. */
const Trigger = ({
  mounted,
  icon,
  describedBy,
  label,
}: {
  mounted: boolean;
  icon: boolean;
  describedBy: string | undefined;
  label: string;
}) => (
  <FileInputTrigger
    render={
      <Button
        variant="outline"
        size="sm"
        aria-describedby={describedBy}
        aria-hidden={mounted ? undefined : true}
        tabIndex={mounted ? undefined : -1}
      >
        {icon ? <Icon icon={UploadIcon} /> : null}
        {label}
      </Button>
    }
  />
);

/** One file's row: its mark, its name and where its sending is, its actions, and its progress. */
const Row = ({
  file,
  state,
  words,
  told,
  actions,
  onRetry,
}: {
  file: File;
  state: Sending | undefined;
  words: Words;
  told: FileUploadStatus | undefined;
  actions: FileUploadAction[];
  onRetry: () => void;
}) => {
  const locale = useLocale();
  const status = state?.status;
  const nameId = useId();
  return (
    <>
      <span aria-hidden="true" {...stylex.props(styles.fileIcon)}>
        <Icon icon={fileMark(file.type === "" ? undefined : file.type)} />
      </span>
      <span {...stylex.props(styles.words)}>
        <span id={nameId} {...stylex.props(styles.name)} title={file.name}>
          {file.name}
        </span>
        <span
          {...stylex.props(
            styles.meta,
            (status === "failed" || told?.variant === "destructive") &&
              styles.failed
          )}
        >
          {told?.loading === true ? <Spinner /> : null}
          {metaLine(file, state, words, told, locale)}
        </span>
      </span>
      <span {...stylex.props(styles.actions)}>
        {status === "failed" ? (
          <Button
            variant="ghost"
            size="sm"
            // Try again for this file: its name describes the button, so each one is told apart.
            aria-describedby={nameId}
            onClick={(event: MouseEvent<HTMLElement>) => {
              // Try again goes as the file is sent again: focus stays on its row.
              event.currentTarget
                .closest<HTMLElement>("[data-slot=file-input-item]")
                ?.focus();
              onRetry();
            }}
          >
            {words.retry}
          </Button>
        ) : null}
        {actions.map((action) => (
          <RowAction key={action.label} action={action} />
        ))}
        <FileInputItemRemove
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={words.remove(file.name)}
            >
              <Icon icon={XIcon} />
            </Button>
          }
        />
      </span>
      {status === "uploading" ? (
        <span {...stylex.props(styles.progress)}>
          <Progress
            aria-label={words.uploadingName(file.name)}
            value={Math.round((state?.progress ?? 0) * 100)}
            size="sm"
          />
        </span>
      ) : null}
    </>
  );
};

/** The files sent, failed or on their way, and how to send one, stopping what a removed one runs. */
const useSending = (
  onUpload: FileUploadProps["onUpload"],
  words: Words,
  say: (line: string) => void
) => {
  const [sending, setSending] = useState<Map<File, Sending>>(new Map());
  // The upload running for each file, so a removed or replaced one is stopped and its late news dropped.
  const running = useRef(new Map<File, AbortController>());

  useEffect(() => {
    const all = running.current;
    return () => {
      for (const controller of all.values()) {
        controller.abort();
      }
    };
  }, []);

  const send = (file: File) => {
    if (!onUpload) {
      return;
    }
    running.current.get(file)?.abort();
    const controller = new AbortController();
    running.current.set(file, controller);
    // Only the upload that is current for a file may change its row.
    const set = (next: Partial<Sending>) => {
      if (running.current.get(file) !== controller) {
        return;
      }
      setSending((all) =>
        new Map(all).set(file, {
          ...(all.get(file) ?? { status: "uploading", progress: 0 }),
          ...next,
        })
      );
    };
    set({ status: "uploading", progress: 0 });
    void runUpload({
      start: async () => {
        await onUpload(
          file,
          (done) => {
            set({ progress: Math.min(1, Math.max(0, done)) });
          },
          controller.signal
        );
      },
      sent: () => {
        set({ status: "done", progress: 1 });
        if (running.current.get(file) === controller) {
          say(words.sent(file.name));
        }
      },
      failed: () => {
        if (controller.signal.aborted) {
          return;
        }
        set({ status: "failed" });
        if (running.current.get(file) === controller) {
          say(words.notSent(file.name));
        }
      },
    });
  };

  const drop = (removed: File[]) => {
    for (const file of removed) {
      running.current.get(file)?.abort();
      running.current.delete(file);
    }
    if (removed.length > 0) {
      setSending((all) => {
        const kept = new Map(all);
        for (const file of removed) {
          kept.delete(file);
        }
        return kept;
      });
    }
  };

  return { sending, send, drop };
};

export const FileUpload = ({
  multiple = false,
  accept,
  maxFileSize,
  maxFiles,
  description,
  onUpload,
  value,
  onValueChange,
  name,
  required,
  disabled,
  getFileStatus,
  getFileActions,
  variant = "dropzone",
  listContainer,
  style,
}: FileUploadProps) => {
  const words = useI18n().fileUpload;
  const locale = useLocale();
  const [errors, setErrors] = useState<string[]>([]);
  // One quiet place for what a screen reader hears: each file sent or not, and each refusal.
  const [said, setSaid] = useState("");
  const { sending, send, drop } = useSending(onUpload, words, setSaid);
  // oxlint-disable-next-line react/hook-use-state -- a controller made once, never replaced
  const [files] = useState(createFileInputController);
  const native = useRef<HTMLInputElement>(null);
  // Until the page runs its script, the browser's own file input does the work.
  const mounted = useHandover(native, () => {
    files.focus();
  });
  const descriptionId = useId();
  // The name it is sent under: its own, or its Field's.
  const field = useFieldControl();
  const sentAs = name ?? field?.name;

  useEffect(() => {
    // Files chosen before the script ran move over to the live field.
    const early = native.current?.files;
    if (early && early.length > 0) {
      files.addFiles(early);
    }
  }, [files]);

  const change = (next: File[], details: FileInputValueChangeDetails) => {
    drop(details.removed);
    for (const file of details.added) {
      send(file);
    }
    if (details.rejected.length === 0) {
      setErrors([]);
    }
    onValueChange?.(next);
  };

  // Refusals come here even when no file was taken, so a drop of only refused files still says why.
  const reject = (rejected: { file: File; reasons: string[] }[]) => {
    const lines = rejected.map((rejection) =>
      words.refused(rejection.file.name, rejection.reasons[0] ?? "")
    );
    setErrors(lines);
    setSaid(lines.join(" "));
  };

  const types = typesOf(accept);
  const limits =
    description ??
    (types.length > 0 || maxFileSize !== undefined
      ? words.limits(
          types,
          maxFileSize === undefined
            ? undefined
            : formatFileSize(maxFileSize, locale)
        )
      : undefined);
  const hasLimits = limits !== undefined && limits !== "";
  const fallback = mounted ? null : (
    <Native
      native={native}
      name={onUpload ? undefined : sentAs}
      accept={accept}
      multiple={multiple}
      required={required}
      disabled={disabled}
      label={words.select}
    />
  );
  const trigger = (icon: boolean) => (
    <Trigger
      mounted={mounted}
      icon={icon}
      describedBy={hasLimits ? descriptionId : undefined}
      label={words.select}
    />
  );

  const list = (
    <FileInputList aria-label={words.files} {...stylex.props(styles.list)}>
      <FileInputItem {...stylex.props(styles.item, fadeIn, focusRing)}>
        {({ file }: { file: File }) => {
          const state = sending.get(file);
          // The host's word on a file it has (sent, or chosen with nothing to send), and its actions.
          const settled =
            state?.status === "done" ||
            (onUpload === undefined && state === undefined);
          return (
            <Row
              file={file}
              state={state}
              words={words}
              told={settled ? getFileStatus?.(file) : undefined}
              actions={settled ? (getFileActions?.(file) ?? []) : []}
              onRetry={() => {
                send(file);
              }}
            />
          );
        }}
      </FileInputItem>
    </FileInputList>
  );

  return (
    <div data-slot="file-upload" {...stylex.props(styles.root, style)}>
      <FileInput
        multiple={multiple}
        accept={accept}
        maxSize={maxFileSize}
        maxFiles={maxFiles}
        // With `onUpload` the files are sent by it, not with the form; and until the script runs,
        // the browser's own input carries the name.
        name={onUpload || !mounted ? undefined : sentAs}
        required={required}
        disabled={disabled}
        value={value}
        controller={files}
        onValueChange={change}
        onReject={reject}
        // Refusals are said with their reasons in the live region below.
        announcement={({ reason, added, removed }) => {
          if (reason === "reset") {
            return null;
          }
          if (added.length > 0) {
            return words.added(added.length);
          }
          return removed.length > 0
            ? words.removed(removed.map((file) => file.name))
            : null;
        }}
        {...stylex.props(styles.inner)}
      >
        {variant === "button" ? (
          <span {...stylex.props(styles.buttonBox)}>
            {fallback}
            {trigger(true)}
            {hasLimits ? (
              <span id={descriptionId} {...stylex.props(visuallyHidden)}>
                {limits}
              </span>
            ) : null}
          </span>
        ) : (
          <FileInputDropzone className={className(styles.zone)}>
            {fallback}
            <span aria-hidden="true" {...stylex.props(styles.zoneIcon)}>
              <Icon icon={UploadIcon} />
            </span>
            <span {...stylex.props(styles.zoneLine)}>
              <span>{words.drop}</span>
              {trigger(false)}
            </span>
            {hasLimits ? (
              <p id={descriptionId} {...stylex.props(styles.description)}>
                {limits}
              </p>
            ) : null}
          </FileInputDropzone>
        )}
        {/* The button form draws its list where the host puts it (a card's body); the context goes along. */}
        {variant === "button" && listContainer
          ? createPortal(list, listContainer)
          : list}
      </FileInput>
      {errors.length > 0 ? (
        <ul data-slot="file-upload-errors" {...stylex.props(styles.errors)}>
          {errors.map((line, index) => (
            <li key={`${String(index)}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      <span
        // Not every screen reader treats <output> as a live region; role="status" is.
        role="status"
        data-slot="file-upload-live-region"
        {...stylex.props(visuallyHidden)}
      >
        {said}
      </span>
    </div>
  );
};
