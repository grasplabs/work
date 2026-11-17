// File upload: a place in a form to drop or choose files, and the list of what was chosen, on UI SDK's
// File Input. Files are checked as they arrive (their type, their size, how many), and one that is
// refused is named with the reason. Given `upload`, each file is sent at once and its row shows how
// far it is, that it is done, or that it failed, with Try again. Without it, the files go with the form.
//
//   <Field name="files">
//     <FieldLabel>Contracts</FieldLabel>
//     <FileUpload multiple accept={[".pdf"]} maxSize={10_000_000} upload={send} />
//   </Field>
//
// The drop zone is a tinted ground with the system's edge, no dashed line. It works by keyboard (its
// button opens the picker; the arrow keys move through the list, Delete removes), and without script
// as a plain file input. Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
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

import { Button } from "../button/button";
import { useFieldName } from "../field/field";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Cross, File as FileMark, Icon, Upload } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { arrive } from "../motion/arrive";
import { simply } from "../motion/simply.stylex";
import { Progress } from "../progress/progress";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { fileUploadWords } from "./words";

/** What a caller may style: where it sits and how wide it is. */
export type FileUploadLayoutStyle = LayoutStyle;

/** The words a file upload says, in the page's language. */
export interface FileUploadWords {
  drop: string;
  choose: string;
  uploading: string;
  done: string;
  failed: string;
  retry: string;
  /** The list's name. */
  files: string;
  /** A sent file's line: its size, and that it is done. */
  doneLine: (size: string) => string;
  /** What a screen reader hears when a file is sent, or not. */
  sent: (name: string) => string;
  notSent: (name: string) => string;
  remove: (name: string) => string;
  /** Why a file was refused: `file-type`, `file-too-large`, `file-too-small`, `too-many-files`, or your own. */
  refused: (name: string, reason: string) => string;
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
  maxSize?: number;
  /** The most files it takes. */
  maxFiles?: number;
  /** What it takes, said under the drop zone: "PDF or PNG, up to 10 MB". */
  hint?: string;
  /**
   * Sends one file. Call `progress` with 0 to 1 as it goes; throw, or reject, when it fails. Each
   * file is sent as it arrives; Try again sends it again. With it, the files are not sent with the form
   * as well: send what `upload` gave back. Without it, the files go with the form.
   */
  upload?: (
    file: File,
    progress: (done: number) => void,
    signal: AbortSignal
  ) => Promise<void>;
  /** Runs with the files whenever one is added or taken away. */
  onValueChange?: (files: File[]) => void;
  /** The name the files are sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** A file is needed before the form is sent. @default false */
  required?: boolean;
  /** Out of use. @default false */
  disabled?: boolean;
  /** Its words, in the page's language. */
  words?: Partial<FileUploadWords>;
  /** @deprecated Use `layout`. */
  style?: FileUploadLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: FileUploadLayoutStyle;
}

interface Sending {
  status: "uploading" | "done" | "failed";
  progress: number;
  controller?: AbortController;
}

const describe = (accept: FileUploadProps["accept"]) =>
  typeof accept === "string" ? accept : accept?.join(", ");

const FORCED = media.forced;

const styles = stylex.create({
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    rowGap: grasp.space3,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // UI SDK's own root holds the zone and the list: the same room between them.
  inner: {
    display: "grid",
    rowGap: grasp.space2,
    minWidth: 0,
  },
  // The drop zone: a soft tint with the system's edge. Files over it deepen the tint; a file it will
  // not take turns the edge red.
  zone: {
    position: "relative",
    display: "grid",
    justifyItems: "center",
    rowGap: grasp.space2,
    boxSizing: "border-box",
    minWidth: 0,
    paddingBlock: grasp.space6,
    paddingInline: grasp.space4,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: grasp.soft,
      ":is([data-dragging])": grasp.ghostFillPress,
    },
    boxShadow: {
      default: grasp.edge,
      ":is([data-dragging])": `inset 0 0 0 1px ${grasp.fieldEdgeHover}`,
      ":is([data-drag-reject])": grasp.liftLowDanger,
    },
    outline: {
      default: "none",
      [FORCED]: {
        default: "1px solid CanvasText",
        ":is([data-dragging])": "2px solid Highlight",
      },
    },
    textAlign: "center",
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    transitionProperty: "background-color, box-shadow",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // Without script: the browser's own file input, unseen over the whole zone, takes a click or a drop.
  native: {
    position: "absolute",
    // Over the zone and its button, so a press anywhere on it opens the picker.
    zIndex: 1,
    inset: 0,
    width: "100%",
    height: "100%",
    opacity: 0,
    cursor: "pointer",
  },
  zoneIcon: {
    display: "inline-flex",
    color: grasp.muted,
  },
  zoneLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space2,
  },
  hint: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.quiet,
  },
  // The files: one row each, its name, its size or where its sending is, and its actions.
  // With no files it takes no row, so no gap stands between the zone and the field's description.
  list: {
    display: { default: "grid", ":empty": "none" },
    rowGap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
    minWidth: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    // A border that only forced colours show: the focus ring keeps the outline to itself.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
  },
  fileIcon: {
    display: "inline-flex",
    color: grasp.muted,
  },
  words: {
    display: "grid",
    minWidth: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
  },
  meta: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  failed: {
    color: grasp.danger,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
  },
  // How far a file has gone: a thin bar under its row.
  progress: {
    gridColumn: "1 / -1",
  },
  refusals: {
    display: "grid",
    rowGap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.danger,
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

// What UI SDK says when files are added or removed; refusals are said by our own region.
const announceChange = ({
  added,
  removed,
}: {
  added: File[];
  removed: File[];
}) => {
  if (added.length > 0) {
    return `Added ${added.map((file) => file.name).join(", ")}.`;
  }
  if (removed.length > 0) {
    return `Removed ${removed.map((file) => file.name).join(", ")}.`;
  }
  return null;
};

// The line under a file's name: how far it is sent, that it was, that it failed, or its size.
const metaLine = (
  file: File,
  state: Sending | undefined,
  words: FileUploadWords
) => {
  if (state?.status === "uploading") {
    return `${words.uploading}, ${Math.round(state.progress * 100)}%`;
  }
  if (state?.status === "done") {
    return words.doneLine(formatFileSize(file.size));
  }
  if (state?.status === "failed") {
    return words.failed;
  }
  return formatFileSize(file.size);
};

export const FileUpload = ({
  multiple = false,
  accept,
  maxSize,
  maxFiles,
  hint,
  upload,
  onValueChange,
  name,
  required,
  disabled,
  words: given,
  style: styleProp,
  layout,
}: FileUploadProps) => {
  // Its words: the product's, by its catalogue, else English; the caller's `words` still win.
  const words = withGiven(useWords("fileUpload", fileUploadWords), given ?? {});
  const [sending, setSending] = useState<Map<File, Sending>>(new Map());
  const [refused, setRefused] = useState<string[]>([]);
  // One quiet place for what a screen reader hears: each file sent or not, and each refusal.
  const [said, setSaid] = useState("");
  // Until the page runs its script, the browser's own file input does the work.
  const [mounted, setMounted] = useState(false);
  // oxlint-disable-next-line react/hook-use-state -- a controller made once, never replaced
  const [files] = useState(createFileInputController);
  const native = useRef<HTMLInputElement>(null);
  // The upload running for each file, so a removed or replaced one is stopped and its late news dropped.
  const running = useRef(new Map<File, AbortController>());
  const hintId = useId();
  // The name it is sent under: its own, or its Field's.
  const fieldName = useFieldName();
  const sentAs = name ?? fieldName;

  useEffect(() => {
    // Files chosen before the script ran move over to the live field.
    const early = native.current?.files;
    // oxlint-disable-next-line react/set-state-in-effect -- the browser's own input hands over only once the page runs its script
    setMounted(true);
    if (early && early.length > 0) {
      files.addFiles(early);
    }
    const all = running.current;
    return () => {
      for (const controller of all.values()) {
        controller.abort();
      }
    };
  }, [files]);

  const send = (file: File) => {
    if (!upload) {
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
        await upload(
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
          setSaid(words.sent(file.name));
        }
      },
      failed: () => {
        if (controller.signal.aborted) {
          return;
        }
        set({ status: "failed" });
        if (running.current.get(file) === controller) {
          setSaid(words.notSent(file.name));
        }
      },
    });
  };

  const change = (next: File[], details: FileInputValueChangeDetails) => {
    for (const file of details.removed) {
      running.current.get(file)?.abort();
      running.current.delete(file);
    }
    if (details.removed.length) {
      setSending((all) => {
        const kept = new Map(all);
        for (const file of details.removed) {
          kept.delete(file);
        }
        return kept;
      });
    }
    for (const file of details.added) {
      send(file);
    }
    if (details.rejected.length === 0) {
      setRefused([]);
    }
    onValueChange?.(next);
  };

  // Refusals come here even when no file was taken, so a drop of only refused files still says why.
  const reject = (rejected: { file: File; reasons: string[] }[]) => {
    const lines = rejected.map((rejection) =>
      words.refused(rejection.file.name, rejection.reasons[0] ?? "")
    );
    setRefused(lines);
    setSaid(lines.join(" "));
  };

  const limits = hint ?? describe(accept);
  const hasLimits = limits !== undefined && limits !== "";

  return (
    <div
      data-slot="file-upload"
      {...stylex.props(styles.root, layout ?? styleProp)}
    >
      <FileInput
        multiple={multiple}
        accept={accept}
        maxSize={maxSize}
        maxFiles={maxFiles}
        // With `upload` the files are sent by it, not with the form; and until the script runs, the
        // browser's own input below carries the name.
        name={upload || !mounted ? undefined : name}
        required={required}
        disabled={disabled}
        controller={files}
        onValueChange={change}
        onReject={reject}
        // Added and removed files are said by UI SDK; refusals, with their reasons, by our own region.
        announcement={announceChange}
        {...stylex.props(styles.inner)}
      >
        <FileInputDropzone className={stylex.props(styles.zone).className}>
          {mounted ? null : (
            <input
              ref={native}
              data-slot="file-upload-native"
              type="file"
              name={upload ? undefined : sentAs}
              accept={typeof accept === "string" ? accept : accept?.join(",")}
              multiple={multiple}
              required={required}
              disabled={disabled}
              aria-label={words.choose}
              {...stylex.props(styles.native)}
            />
          )}
          <span aria-hidden="true" {...stylex.props(styles.zoneIcon)}>
            <Icon icon={Upload} />
          </span>
          <span {...stylex.props(styles.zoneLine)}>
            <span>{words.drop}</span>
            <FileInputTrigger
              render={(props: Record<string, unknown>) => (
                <Button
                  {...props}
                  aria-describedby={hasLimits ? hintId : undefined}
                  aria-hidden={mounted ? undefined : true}
                  tabIndex={mounted ? undefined : -1}
                  variant="quiet"
                  size="sm"
                >
                  {words.choose}
                </Button>
              )}
            />
          </span>
          {hasLimits ? (
            <p id={hintId} {...stylex.props(styles.hint)}>
              {limits}
            </p>
          ) : null}
        </FileInputDropzone>
        <FileInputList aria-label={words.files} {...stylex.props(styles.list)}>
          <FileInputItem {...stylex.props(styles.item, arrive.in, focus.ring)}>
            {({ file }: { file: File }) => {
              const state = sending.get(file);
              const status = state?.status;
              return (
                <>
                  <span aria-hidden="true" {...stylex.props(styles.fileIcon)}>
                    <Icon icon={FileMark} />
                  </span>
                  <span {...stylex.props(styles.words)}>
                    <span {...stylex.props(styles.name)} title={file.name}>
                      {file.name}
                    </span>
                    <span
                      {...stylex.props(
                        styles.meta,
                        status === "failed" && styles.failed
                      )}
                    >
                      {metaLine(file, state, words)}
                    </span>
                  </span>
                  <span {...stylex.props(styles.actions)}>
                    {status === "failed" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          // Try again goes as the file is sent again: focus stays on its row.
                          event.currentTarget
                            .closest<HTMLElement>("[data-slot=file-input-item]")
                            ?.focus();
                          send(file);
                        }}
                      >
                        {words.retry}
                      </Button>
                    ) : null}
                    <FileInputItemRemove
                      render={(props: Record<string, unknown>) => (
                        <Button
                          {...props}
                          variant="ghost"
                          size="sm"
                          icon={Cross}
                          aria-label={words.remove(file.name)}
                        />
                      )}
                    />
                  </span>
                  {status === "uploading" ? (
                    <Progress
                      label={`${words.uploading} ${file.name}`}
                      value={Math.round((state?.progress ?? 0) * 100)}
                      size="sm"
                      showLabel={false}
                      layout={styles.progress}
                    />
                  ) : null}
                </>
              );
            }}
          </FileInputItem>
        </FileInputList>
      </FileInput>
      {refused.length > 0 ? (
        <ul data-slot="file-upload-refusals" {...stylex.props(styles.refusals)}>
          {refused.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      <span
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
        role="status"
        data-slot="file-upload-said"
        {...stylex.props(visuallyHidden)}
      >
        {said}
      </span>
    </div>
  );
};
