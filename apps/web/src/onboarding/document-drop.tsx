import { Button } from "@grasp-os/ui/components/button";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  PresentationIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

// Where documents are dropped in the onboarding (prototype
// `components/onboarding/document-drop.tsx`), modelled on uiarc's file
// dropzone. Its dashed edge is drawn, so a file over it closes the dashes
// into one line, and the target breathes while it waits. Three sheets fan
// open on hover and wider under a file. Dropped, each document comes into
// the list and fills a bar as it is read, then gets a check. A file Grasp
// cannot read shakes the target and says why. Pressed, it opens the file
// picker; with the pointer over it or focus in it, a paste adds what is on
// the clipboard. From three documents the prompt folds to a slim bar.

/** A document in the list: read and kept, still being read, or refused. */
export interface DocumentRow {
  key: string;
  name: string;
  /** Its size in bytes, while it is known: a kept document's isn't. */
  size: number | null;
  state: "reading" | "read" | "failed";
  /** What it is about, once read. */
  about?: string;
  /** Why it could not be read. */
  problem?: string;
  /** About how long reading it takes, in milliseconds, and when it began. */
  ms?: number;
  startedAt?: number;
}

/** What Grasp reads, by extension; anything else is refused with a shake. */
export const readable = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "md",
  "csv",
] as const;
/** From this many documents the prompt folds to a slim bar, so the list has room; a file dragged over opens it again. */
const compactAt = 3;

/** How round a box's corners are, in pixels. */
const cornerOf = (box: Element): number => {
  const corner = Number(
    getComputedStyle(box).borderTopLeftRadius.replace("px", "")
  );
  return Number.isNaN(corner) ? 0 : corner;
};

const extensionOf = (name: string): string =>
  name.toLowerCase().split(".").pop() ?? "";

/** Whether a drag carries files, rather than text or a link. */
const carries = (event: DragEvent): boolean =>
  [...event.dataTransfer.types].includes("Files");

/** Up and down move between documents; Delete or Backspace removes the one in focus. */
const onListKey = (event: KeyboardEvent<HTMLUListElement>): void => {
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-remove]"),
  ];
  const at =
    event.target instanceof HTMLButtonElement
      ? buttons.indexOf(event.target)
      : -1;
  if (at === -1) {
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    buttons[at]?.click();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    buttons[at + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  }
};

const sheetClass =
  "bg-card text-muted-foreground absolute inset-0 grid origin-bottom place-items-end justify-center rounded-md border pb-1.5 shadow-xs transition-transform duration-400 ease-out";

/** The fan of each pose: how far the back sheets turn and move out, and how far the front one lifts. */
const fan = {
  rest: {
    left: "-translate-x-2.25 translate-y-0.5 -rotate-10",
    right: "translate-x-2.25 translate-y-0.5 rotate-10",
    front: "",
  },
  hover: {
    left: "-translate-x-3.25 translate-y-0.5 -rotate-15",
    right: "translate-x-3.25 translate-y-0.5 rotate-15",
    front: "-translate-y-0.5",
  },
  drag: {
    left: "-translate-x-5 -translate-y-0.5 -rotate-22",
    right: "translate-x-5 -translate-y-0.5 rotate-22",
    front: "-translate-y-2",
  },
} as const;

const SheetLines = () => (
  <>
    <span className="absolute top-2 left-1.75 h-0.5 w-4 rounded-full bg-current opacity-30" />
    <span className="absolute top-3.25 left-1.75 h-0.5 w-2.75 rounded-full bg-current opacity-30" />
  </>
);

/**
 * Three sheets of paper, the target's one picture: slightly fanned at rest,
 * wider on hover, and wide open and lifted under a file, the front one's
 * arrow rising with it.
 */
const Sheets = ({ pose }: { pose: "rest" | "hover" | "drag" }) => (
  <span
    aria-hidden="true"
    className="relative mx-auto mt-2.5 mb-3.5 block h-11 w-9"
  >
    <span className={cn(sheetClass, fan[pose].left)}>
      <SheetLines />
    </span>
    <span className={cn(sheetClass, fan[pose].right)}>
      <SheetLines />
    </span>
    <span
      className={cn(
        sheetClass,
        fan[pose].front,
        pose === "drag" && "border-muted-foreground/40 text-foreground"
      )}
    >
      <SheetLines />
      <span
        className={cn(
          "transition-transform duration-400",
          pose === "drag" && "-translate-y-0.75"
        )}
      >
        <ArrowUpIcon className="size-3.5" strokeWidth={2} />
      </span>
    </span>
  </span>
);

/** The icon for a document, by what kind of file it is. */
const TypeIcon = ({ name }: { name: string }) => {
  const extension = extensionOf(name);
  const props = {
    className: "size-5",
    strokeWidth: 1.75,
    "aria-hidden": true,
  } as const;
  if (["xls", "xlsx", "csv"].includes(extension)) {
    return <FileSpreadsheetIcon {...props} />;
  }
  if (["ppt", "pptx"].includes(extension)) {
    return <PresentationIcon {...props} />;
  }
  if (["pdf", "doc", "docx", "txt", "md"].includes(extension)) {
    return <FileTextIcon {...props} />;
  }
  return <FileIcon {...props} />;
};

/** The circle closes, then the tick draws through it. */
const DrawnCheck = () => (
  <svg
    aria-hidden="true"
    className="text-status-agreed size-3.5 flex-none"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2.25}
    viewBox="0 0 24 24"
  >
    <path
      className="drawn-check"
      d="M12 2.5a9.5 9.5 0 1 1 0 19a9.5 9.5 0 1 1 0-19"
      pathLength={1}
    />
    <path
      className="drawn-check drawn-check-late"
      d="m8.2 12.4 2.6 2.6 5-5.2"
      pathLength={1}
    />
  </svg>
);

/** How far a document's reading has come, 0 to 92, at a reader's pace, slowing towards the end. */
const useReading = (row: DocumentRow): number => {
  const started = row.startedAt ?? 0;
  const [now, setNow] = useState(started);
  const reading = row.state === "reading";
  useEffect(() => {
    const id = reading
      ? window.setInterval(() => {
          setNow(Date.now());
        }, 100)
      : undefined;
    return () => {
      window.clearInterval(id);
    };
  }, [reading]);
  const share = Math.min(1, (now - started) / (row.ms ?? 4500));
  return Math.round(92 * (1 - (1 - share) ** 3));
};

/**
 * One document. While it is read, a bar fills and a count goes up, both
 * from one value, so they always agree; read, the label turns and the
 * check draws.
 */
const Row = ({ row, onRemove }: { row: DocumentRow; onRemove: () => void }) => {
  const { t, i18n } = useLingui();
  const file = row.name;
  const percent = useReading(row);
  let size: string | null = null;
  if (row.size !== null) {
    size =
      row.size >= 1_000_000
        ? new Intl.NumberFormat(i18n.locale, {
            style: "unit",
            unit: "megabyte",
            maximumFractionDigits: 1,
          }).format(row.size / 1_000_000)
        : new Intl.NumberFormat(i18n.locale, {
            style: "unit",
            unit: "kilobyte",
            maximumFractionDigits: 0,
          }).format(Math.max(1, row.size / 1000));
  }
  let status = (
    <>
      <DrawnCheck />
      <span className="truncate" title={row.about}>
        {row.about ??
          t({ message: "Read", context: "a document, done reading" })}
      </span>
    </>
  );
  if (row.state === "reading") {
    status = (
      <span>
        {t`Reading`} <span className="tabular-nums">{percent}%</span>
      </span>
    );
  } else if (row.state === "failed") {
    status = (
      <>
        <CircleAlertIcon
          aria-hidden="true"
          className="text-status-attention size-3.5 flex-none"
        />
        <span className="truncate">{row.problem}</span>
      </>
    );
  }
  return (
    <li className="animate-in fade-in slide-in-from-top-4 min-w-0 overflow-hidden duration-400">
      <div className="bg-card document-row mt-2 grid min-h-14 items-center gap-x-3 rounded-lg border py-2 pr-2 pl-2.25">
        <span className="text-muted-foreground grid size-10 place-items-center">
          <TypeIcon name={row.name} />
        </span>
        <span className="grid min-w-0">
          <span className="truncate font-medium" title={row.name}>
            {row.name}
          </span>
          <span className="text-muted-foreground mt-px flex min-w-0 items-center text-xs whitespace-nowrap tabular-nums">
            {size === null ? null : (
              <>
                <span>{size}</span>
                <span aria-hidden="true" className="px-1.5">
                  ·
                </span>
              </>
            )}
            <span
              className="animate-in fade-in relative flex min-w-0 flex-1 items-center gap-1.25"
              key={row.state}
            >
              {status}
            </span>
          </span>
          {/* The bar opens with the reading, fills, then folds away once it is read. */}
          {row.state === "reading" ? (
            <span aria-hidden="true" className="mt-1.75 mb-0.5 block">
              <Progress value={percent} />
            </span>
          ) : null}
        </span>
        {row.state === "failed" ? (
          <Button
            aria-label={t`Remove ${file}`}
            data-remove
            onClick={onRemove}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : (
          <span aria-hidden="true" className="size-8" />
        )}
      </div>
    </li>
  );
};

export const DocumentDrop = ({
  rows,
  onAdd,
  onRemove,
}: {
  rows: DocumentRow[];
  onAdd: (files: File[]) => void;
  onRemove: (row: DocumentRow) => void;
}) => {
  const { t } = useLingui();
  const zone = useRef<HTMLDivElement>(null);
  const edge = useRef<SVGRectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shaking, setShaking] = useState(0);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const compact = rows.length >= compactAt;

  // The dashes are fitted to the measured edge, so every dash is the same length and the seam never shows.
  useLayoutEffect(() => {
    const fit = () => {
      const box = zone.current;
      const line = edge.current;
      if (box === null || line === null) {
        return;
      }
      const width = box.offsetWidth - 1;
      const height = box.offsetHeight - 1;
      const radius = Math.max(
        0,
        Math.min(cornerOf(box) - 0.5, width / 2, height / 2)
      );
      const perimeter =
        2 * (width + height) - 8 * radius + 2 * Math.PI * radius;
      line.setAttribute("width", String(Math.max(0, width)));
      line.setAttribute("height", String(Math.max(0, height)));
      line.setAttribute("rx", String(radius));
      line.setAttribute(
        "pathLength",
        String(Math.max(8, Math.round(perimeter / 7)) * 7)
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (zone.current !== null) {
      observer.observe(zone.current);
    }
    return () => {
      observer.disconnect();
    };
  }, []);

  const add = (incoming: FileList | File[]) => {
    const files = [...incoming];
    const known = files.filter((file) =>
      readable.some((extension) => extension === extensionOf(file.name))
    );
    const fresh = known.filter(
      (file, at, all) =>
        all.findIndex(
          (other) => other.name === file.name && other.size === file.size
        ) === at &&
        !rows.some(
          (row) =>
            row.name === file.name && (row.size ?? file.size) === file.size
        )
    );
    const refused = files.length - known.length;
    const only = files[0]?.name ?? "";
    if (refused === 0) {
      setError("");
    } else if (refused === 1 && files.length === 1) {
      setError(t`${only} isn’t a file I can read.`);
    } else {
      setError(
        t`Some files weren’t added. I can read PDF, Word, Excel, PowerPoint and text.`
      );
    }
    if (refused > 0) {
      setShaking((now) => now + 1);
    }
    if (fresh.length === 0) {
      return;
    }
    onAdd(fresh);
    const count = fresh.length;
    setAnnouncement(
      plural(count, {
        one: "# document added. I’m reading it.",
        other: "# documents added. I’m reading them.",
      })
    );
  };

  // Focus stays in the list: the next document's remove button, else the target.
  const remove = (row: DocumentRow) => {
    onRemove(row);
    setError("");
    const file = row.name;
    setAnnouncement(t`${file} removed`);
    requestAnimationFrame(() => {
      trigger.current?.focus();
    });
  };

  // A paste adds what is on the clipboard while the pointer is over the target or focus is in it.
  const latest = useRef(add);
  useLayoutEffect(() => {
    latest.current = add;
  });
  const armed = hovered || focused;
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = event.clipboardData?.files;
      const { target } = event;
      const typing =
        target instanceof Element &&
        target.closest(
          'input:not([type=file]), textarea, [contenteditable="true"]'
        ) !== null;
      if (files === undefined || files.length === 0 || typing) {
        return;
      }
      event.preventDefault();
      latest.current(files);
    };
    if (armed) {
      document.addEventListener("paste", onPaste);
    }
    return () => {
      document.removeEventListener("paste", onPaste);
    };
  }, [armed]);

  let pose: "rest" | "hover" | "drag" = "rest";
  if (dragging) {
    pose = "drag";
  } else if (hovered) {
    pose = "hover";
  }
  let prompt = t`Drop files here`;
  if (dragging) {
    prompt = t`Let go to add them`;
  }

  return (
    <div
      className="relative grid w-full min-w-0"
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setFocused(false);
        }
      }}
      onFocus={() => {
        setFocused(true);
      }}
    >
      <div
        className={cn(
          "group bg-card hover:bg-muted/50 active:bg-muted/50 has-focus-visible:ring-ring/50 relative grid min-w-0 rounded-2xl transition-colors duration-300 has-focus-visible:ring-3",
          dragging && "drop-breathe bg-muted/30",
          shaking > 0 && "drop-shake"
        )}
        key={shaking}
        onDragEnter={(event) => {
          if (!carries(event)) {
            return;
          }
          event.preventDefault();
          depth.current += 1;
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!carries(event)) {
            return;
          }
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) {
            setDragging(false);
          }
        }}
        onDragOver={(event) => {
          if (!carries(event)) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          if (event.dataTransfer.files.length > 0) {
            add(event.dataTransfer.files);
          }
        }}
        onPointerEnter={(event) => {
          setHovered(event.pointerType === "mouse");
        }}
        onPointerLeave={() => {
          setHovered(false);
        }}
        ref={zone}
      >
        <span
          aria-hidden="true"
          className={cn(
            "drop-wash pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300",
            dragging && "opacity-100"
          )}
        />
        {/* Drawn rather than bordered, so a file over it can close the dashes into one line. */}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          <rect
            className={cn(
              "drop-edge transition-colors duration-150",
              dragging
                ? "drop-edge-closed stroke-foreground/40"
                : "stroke-border group-hover:stroke-muted-foreground"
            )}
            fill="none"
            ref={edge}
            x={0.5}
            y={0.5}
          />
        </svg>
        <span
          aria-hidden="true"
          className={cn(
            "drop-glow pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300",
            dragging && "opacity-100"
          )}
        />
        {/* Its parts ignore the pointer, so the whole target is one place to click or drop. */}
        <button
          className={cn(
            "flex w-full cursor-pointer flex-col items-stretch justify-center rounded-2xl px-5 text-center transition-all duration-300 outline-none *:pointer-events-none",
            compact ? "py-3.5" : "pt-5.5 pb-6.5"
          )}
          onClick={() => {
            input.current?.click();
          }}
          ref={trigger}
          type="button"
        >
          {!compact || dragging ? (
            <span className="animate-in fade-in flex flex-col overflow-hidden">
              <Sheets pose={pose} />
            </span>
          ) : null}
          <span className="relative block font-medium">
            <span
              className="animate-in fade-in slide-in-from-bottom-1 inline-block max-w-full truncate align-top duration-300"
              key={prompt}
            >
              {prompt}
            </span>
          </span>
          <span className="text-muted-foreground mt-1">{t`or choose them from your computer`}</span>
          {compact ? null : (
            <span className="flex flex-col overflow-hidden">
              <span className="text-muted-foreground pt-1.5 text-xs">{t`PDF, Word, Excel, PowerPoint or text`}</span>
            </span>
          )}
        </button>
      </div>
      <input
        accept={readable.map((extension) => `.${extension}`).join(",")}
        aria-hidden="true"
        className="hidden"
        multiple
        onChange={(event) => {
          if (event.target.files !== null) {
            add(event.target.files);
          }
          event.target.value = "";
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      {error === "" ? null : (
        <p
          className="text-status-attention animate-in fade-in slide-in-from-bottom-1 flex items-start gap-1.5 pt-3 text-left"
          role="alert"
        >
          <CircleAlertIcon
            aria-hidden="true"
            className="mt-0.75 size-3.5 flex-none"
            strokeWidth={2.25}
          />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}
      {/* Rows keep their own height and the list scrolls past four and a bit, rather than squeezing them. */}
      {/* The arrow keys move between its rows' buttons, and Delete takes one out. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the keys act on the buttons inside it */}
      <ul
        aria-hidden={rows.length > 0 ? undefined : true}
        aria-label={t`Documents`}
        className={cn(
          "grid max-h-70 min-w-0 auto-rows-max overflow-auto text-left transition-all",
          rows.length > 0 && "pt-1"
        )}
        onKeyDown={onListKey}
      >
        {rows.map((row) => (
          <Row
            key={row.key}
            onRemove={() => {
              remove(row);
            }}
            row={row}
          />
        ))}
      </ul>
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>
    </div>
  );
};
