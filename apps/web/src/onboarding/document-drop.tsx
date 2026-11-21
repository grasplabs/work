import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Button } from "../grasp/button/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import {
  Alert,
  ArrowUp,
  Cross,
  Doc,
  File,
  Icon,
  Spreadsheet,
} from "../grasp/icons/index.ts";
import { Progress } from "../grasp/progress/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { extensionOf, filesToRead, readable } from "./document-files.ts";
import { comeIn, motion } from "./motion.ts";
import { useArrives } from "./setup-parts.tsx";

// While it waits for a file over it, the target breathes, slowly: the one long loop here.
const breathe = stylex.keyframes({
  "0%, 100%": { transform: "scale(1)" },
  "50%": { transform: "scale(1.012)" },
});

// A file it can't read shakes it, settling as it goes.
const shake = stylex.keyframes({
  "0%, 100%": { transform: "translateX(0)" },
  "16%": { transform: "translateX(-7px)" },
  "33%": { transform: "translateX(6px)" },
  "50%": { transform: "translateX(-4px)" },
  "66%": { transform: "translateX(3px)" },
  "83%": { transform: "translateX(-1.5px)" },
});

// A document read: the circle closes, then the tick draws through it.
const draw = stylex.keyframes({ to: { strokeDashoffset: 0 } });

// A document comes into the list from above.
const dropIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-1rem)" },
  to: { opacity: 1, transform: "none" },
});

/** A share of the ink, for the lines and light that follow a file over the target. */
const inkAt = (share: string): string =>
  `color-mix(in oklch, ${grasp.ink} ${share}, transparent)`;

const styles = stylex.create({
  whole: { position: "relative", display: "grid", width: "100%", minWidth: 0 },
  zone: {
    position: "relative",
    display: "grid",
    minWidth: 0,
    borderRadius: grasp.corner,
    backgroundColor: {
      default: grasp.raised,
      ":hover": grasp.ghostFillHover,
      ":active": grasp.ghostFillHover,
    },
    transitionProperty: "background-color",
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
  },
  dragging: {
    backgroundColor: grasp.ghostFillHover,
    animationName: { default: breathe, [media.reduced]: "none" },
    animationDuration: "2.2s",
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
  },
  shaking: {
    animationName: { default: shake, [media.reduced]: "none" },
    animationDuration: grasp.durationOpen,
    animationTimingFunction: grasp.ease,
  },
  // Over the target, never in the pointer's way: shown while a file is over it.
  layer: {
    position: "absolute",
    inset: 0,
    borderRadius: grasp.corner,
    pointerEvents: "none",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
  },
  shown: { opacity: 1 },
  // A faint wash where the file is.
  wash: {
    backgroundImage: `radial-gradient(260px circle at 50% 50%, ${inkAt("5%")}, transparent 70%)`,
  },
  // A brighter stretch of the edge: only the ring between the padding and the edge shows.
  glow: {
    padding: "1.5px",
    backgroundImage: `radial-gradient(180px circle at 50% 50%, ${inkAt("45%")}, transparent 70%)`,
    maskImage:
      "linear-gradient(currentColor 0 0), linear-gradient(currentColor 0 0)",
    maskClip: "content-box, border-box",
    maskComposite: "exclude",
  },
  edgeBox: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    overflow: "visible",
    pointerEvents: "none",
  },
  // Drawn in dashes that close into one line under a file.
  edge: {
    stroke: grasp.line,
    strokeDasharray: "3.5 3.5",
    strokeDashoffset: 0,
    transitionProperty: "stroke-dasharray, stroke-dashoffset, stroke",
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
  },
  edgeHover: { stroke: grasp.muted },
  edgeClosed: {
    stroke: inkAt("40%"),
    strokeDasharray: "7 0",
    strokeDashoffset: 1.75,
  },
  // The whole target is one place to click or drop: what is in it ignores the pointer.
  trigger: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    width: "100%",
    margin: 0,
    paddingInline: grasp.space5,
    paddingBlockStart: grasp.space6,
    paddingBlockEnd: grasp.space6,
    borderWidth: 0,
    borderRadius: grasp.corner,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "center",
    cursor: "pointer",
    outline: "none",
    transitionProperty: "padding",
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
  },
  triggerCompact: { paddingBlock: grasp.space4 },
  inert: { pointerEvents: "none" },
  sheetsBox: { display: "flex", flexDirection: "column", overflow: "hidden" },
  prompt: {
    position: "relative",
    display: "block",
    fontWeight: grasp.weightMedium,
  },
  promptWords: {
    display: "inline-block",
    maxWidth: "100%",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    verticalAlign: "top",
  },
  or: { marginBlockStart: grasp.space1, color: grasp.muted },
  kinds: {
    paddingBlockStart: grasp.space2,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  file: { display: "none" },
  error: {
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    margin: 0,
    paddingBlockStart: grasp.space3,
    color: grasp.attention,
    textAlign: "start",
    [iconVars.size]: "0.875rem",
  },
  errorMark: { display: "flex", paddingBlockStart: "0.1875rem" },
  errorWords: { flexGrow: 1, minWidth: 0 },
  // Rows keep their own height: four and a bit, fewer where the window is low, so the step still fits on screen.
  list: {
    display: "grid",
    gridAutoRows: "max-content",
    minWidth: 0,
    maxHeight: "max(9rem, min(17.5rem, 100svh - 36rem))",
    margin: 0,
    padding: 0,
    overflow: "auto",
    listStyle: "none",
    textAlign: "start",
  },
  listFilled: { paddingBlockStart: grasp.space1 },
  row: { minWidth: 0, overflow: "hidden" },
  rowArrives: {
    animationName: { default: dropIn, [media.reduced]: "none" },
    animationDuration: grasp.durationOpen,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  },
  // Its icon, its name and state, its button.
  card: {
    display: "grid",
    gridTemplateColumns: "2.5rem minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: grasp.space3,
    minHeight: "3.5rem",
    marginBlockStart: grasp.space2,
    paddingBlock: grasp.space2,
    paddingInlineStart: grasp.space2,
    paddingInlineEnd: grasp.space2,
    borderRadius: grasp.corner,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
  },
  kind: {
    display: "grid",
    placeItems: "center",
    width: "2.5rem",
    height: "2.5rem",
    color: grasp.muted,
    [iconVars.size]: "1.25rem",
  },
  words: { display: "grid", minWidth: 0 },
  name: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    fontWeight: grasp.weightMedium,
  },
  about: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    marginBlockStart: "1px",
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  dot: { paddingInline: grasp.space2 },
  state: {
    position: "relative",
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    [iconVars.size]: "0.875rem",
  },
  failedMark: { display: "flex", flexShrink: 0, color: grasp.attention },
  cut: { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
  numbers: { fontVariantNumeric: "tabular-nums" },
  bar: {
    display: "block",
    marginBlockStart: grasp.space2,
    marginBlockEnd: "2px",
  },
  // The room a row's button takes, kept while it has none.
  noAction: { width: grasp.controlSm, height: grasp.controlSm },
  check: {
    flexShrink: 0,
    width: "0.875rem",
    height: "0.875rem",
    color: grasp.success,
  },
  drawing: {
    strokeDasharray: 1,
    strokeDashoffset: { default: 1, [media.reduced]: 0 },
    animationName: { default: draw, [media.reduced]: "none" },
    animationDuration: grasp.durationOpen,
    animationTimingFunction: grasp.ease,
    animationFillMode: "forwards",
  },
  late: { animationDelay: grasp.durationStagger },
});

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

/** From this many documents the prompt folds to a slim bar, so the list has room; a file dragged over opens it again. */
const compactAt = 3;

/** How round a box's corners are, in pixels. */
const cornerOf = (box: Element): number => {
  const corner = Number(
    getComputedStyle(box).borderTopLeftRadius.replace("px", "")
  );
  return Number.isNaN(corner) ? 0 : corner;
};

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

const sheetStyles = stylex.create({
  // The three sheets' room, the target's one picture.
  sheets: {
    position: "relative",
    display: "block",
    width: "2.25rem",
    height: "2.75rem",
    marginInline: "auto",
    marginBlockStart: "0.625rem",
    marginBlockEnd: "0.875rem",
  },
  sheet: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "end center",
    paddingBlockEnd: "0.375rem",
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
    color: grasp.muted,
    transformOrigin: "bottom",
    transitionProperty: "transform",
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
    [iconVars.size]: "0.875rem",
  },
  frontDrag: { color: grasp.ink },
  line: {
    position: "absolute",
    insetInlineStart: "0.4375rem",
    height: "0.125rem",
    borderRadius: grasp.cornerPill,
    backgroundColor: "currentColor",
    opacity: 0.3,
  },
  lineLong: { insetBlockStart: "0.5rem", width: "1rem" },
  lineShort: { insetBlockStart: "0.8125rem", width: "0.6875rem" },
  arrow: {
    display: "flex",
    transitionProperty: "transform",
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
  },
  arrowDrag: { transform: "translateY(-0.1875rem)" },
});

/** The fan of each pose: how far the back sheets turn and move out, and how far the front one lifts. */
const fan = stylex.create({
  restLeft: { transform: "translate(-0.5625rem, 0.125rem) rotate(-10deg)" },
  restRight: { transform: "translate(0.5625rem, 0.125rem) rotate(10deg)" },
  restFront: { transform: "none" },
  hoverLeft: { transform: "translate(-0.8125rem, 0.125rem) rotate(-15deg)" },
  hoverRight: { transform: "translate(0.8125rem, 0.125rem) rotate(15deg)" },
  hoverFront: { transform: "translateY(-0.125rem)" },
  dragLeft: { transform: "translate(-1.25rem, -0.125rem) rotate(-22deg)" },
  dragRight: { transform: "translate(1.25rem, -0.125rem) rotate(22deg)" },
  dragFront: { transform: "translateY(-0.5rem)" },
});

const fans = {
  rest: { left: fan.restLeft, right: fan.restRight, front: fan.restFront },
  hover: { left: fan.hoverLeft, right: fan.hoverRight, front: fan.hoverFront },
  drag: { left: fan.dragLeft, right: fan.dragRight, front: fan.dragFront },
} as const;

const SheetLines = () => (
  <>
    <span {...stylex.props(sheetStyles.line, sheetStyles.lineLong)} />
    <span {...stylex.props(sheetStyles.line, sheetStyles.lineShort)} />
  </>
);

/**
 * Three sheets of paper, the target's one picture: slightly fanned at rest,
 * wider on hover, and wide open and lifted under a file, the front one's
 * arrow rising with it.
 */
const Sheets = ({ pose }: { pose: "rest" | "hover" | "drag" }) => (
  <span aria-hidden="true" {...stylex.props(sheetStyles.sheets)}>
    <span {...stylex.props(sheetStyles.sheet, fans[pose].left)}>
      <SheetLines />
    </span>
    <span {...stylex.props(sheetStyles.sheet, fans[pose].right)}>
      <SheetLines />
    </span>
    <span
      {...stylex.props(
        sheetStyles.sheet,
        fans[pose].front,
        pose === "drag" && sheetStyles.frontDrag
      )}
    >
      <SheetLines />
      <span
        {...stylex.props(
          sheetStyles.arrow,
          pose === "drag" && sheetStyles.arrowDrag
        )}
      >
        <Icon icon={ArrowUp} />
      </span>
    </span>
  </span>
);

/** The icon for a document, by what kind of file it is. */
const TypeIcon = ({ name }: { name: string }) => {
  const extension = extensionOf(name);
  if (["xls", "xlsx", "csv"].includes(extension)) {
    return <Icon icon={Spreadsheet} />;
  }
  if (["pdf", "doc", "docx", "txt", "md"].includes(extension)) {
    return <Icon icon={Doc} />;
  }
  return <Icon icon={File} />;
};

/** The circle closes, then the tick draws through it; or, `drawn` already, it is there. */
const DrawnCheck = ({ drawn }: { drawn: boolean }) => (
  <svg
    aria-hidden="true"
    data-arrives={drawn ? undefined : ""}
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2.25}
    viewBox="0 0 24 24"
    {...stylex.props(styles.check)}
  >
    <path
      d="M12 2.5a9.5 9.5 0 1 1 0 19a9.5 9.5 0 1 1 0-19"
      pathLength={1}
      {...stylex.props(!drawn && styles.drawing)}
    />
    <path
      d="m8.2 12.4 2.6 2.6 5-5.2"
      pathLength={1}
      {...stylex.props(!drawn && styles.drawing, !drawn && styles.late)}
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
 * Removes a document that was read, once confirmed: it can't be undone.
 * Stephen forgets what he read in it, and the file goes from the Brain of
 * the admin who shared it, when that is who removes it.
 */
const RemoveRead = ({
  file,
  onRemove,
}: {
  file: string;
  onRemove: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // While core removes it: pressed again, it would remove it twice.
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Button
        aria-label={t`Remove ${file}`}
        data-remove
        disabled={removing}
        icon={Cross}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="ghost"
      />
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogTitle>{t`Remove ${file}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`I forget what I read in it, and draw again what I drew with it. If you shared it, its file in your Brain, if there is one, is deleted too; if another admin did, the file stays in theirs until they delete it. This can’t be undone.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              action={() => {
                setRemoving(true);
                void (async () => {
                  await onRemove();
                  setRemoving(false);
                })();
              }}
              variant="danger"
            >
              {t`Remove`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/**
 * One document. While it is read, a bar fills and a count goes up, both
 * from one value, so they always agree; read, the label turns and the
 * check draws.
 */
const Row = ({
  row,
  onRemove,
}: {
  row: DocumentRow;
  onRemove: () => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const file = row.name;
  const percent = useReading(row);
  // Read before, as the step opens again: in the list, read, at once.
  const rowArrives = useArrives("row");
  const stateArrives = useArrives(row.state);
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
      <DrawnCheck drawn={!stateArrives} />
      <span title={row.about} {...stylex.props(styles.cut)}>
        {row.about ??
          t({ message: "Read", context: "a document, done reading" })}
      </span>
    </>
  );
  if (row.state === "reading") {
    status = (
      <span>
        {t`Reading`} <span {...stylex.props(styles.numbers)}>{percent}%</span>
      </span>
    );
  } else if (row.state === "failed") {
    status = (
      <>
        <span {...stylex.props(styles.failedMark)}>
          <Icon icon={Alert} />
        </span>
        <span {...stylex.props(styles.cut)}>{row.problem}</span>
      </>
    );
  }
  // A failed row goes at once; a read one, once confirmed.
  let action = <span aria-hidden="true" {...stylex.props(styles.noAction)} />;
  if (row.state === "failed") {
    action = (
      <Button
        aria-label={t`Remove ${file}`}
        data-remove
        icon={Cross}
        onClick={() => {
          void onRemove();
        }}
        size="sm"
        variant="ghost"
      />
    );
  } else if (row.state === "read") {
    action = <RemoveRead file={file} onRemove={onRemove} />;
  }
  return (
    <li {...comeIn(rowArrives, styles.rowArrives, styles.row)}>
      <div {...stylex.props(styles.card)}>
        <span {...stylex.props(styles.kind)}>
          <TypeIcon name={row.name} />
        </span>
        <span {...stylex.props(styles.words)}>
          <span title={row.name} {...stylex.props(styles.name)}>
            {row.name}
          </span>
          <span {...stylex.props(styles.about)}>
            {size === null ? null : (
              <>
                <span>{size}</span>
                <span aria-hidden="true" {...stylex.props(styles.dot)}>
                  ·
                </span>
              </>
            )}
            <span
              key={row.state}
              {...comeIn(stateArrives, motion.fade, styles.state)}
            >
              {status}
            </span>
          </span>
          {/* The bar opens with the reading, fills, then folds away once it is read. */}
          {row.state === "reading" ? (
            <span aria-hidden="true" {...stylex.props(styles.bar)}>
              <Progress
                label={row.name}
                showLabel={false}
                size="sm"
                value={percent}
              />
            </span>
          ) : null}
        </span>
        {action}
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
  /** Whether it was removed: one read is removed in core, which may fail. */
  onRemove: (row: DocumentRow) => Promise<boolean>;
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

  // Each refusal shakes the target again: its animation starts over in place, so the target, and the edge fitted to it, stay.
  useEffect(() => {
    if (shaking === 0) {
      return;
    }
    for (const animation of zone.current?.getAnimations() ?? []) {
      if (
        animation instanceof CSSAnimation &&
        animation.animationName === shake
      ) {
        animation.currentTime = 0;
        animation.play();
      }
    }
  }, [shaking]);

  const add = (incoming: FileList | File[]) => {
    const files = [...incoming];
    const { fresh, refused } = filesToRead(files);
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

  // Said once it is removed, or that it wasn't; focus goes to the target.
  const remove = async (row: DocumentRow) => {
    setError("");
    const file = row.name;
    const removed = await onRemove(row);
    setAnnouncement(
      removed ? t`${file} removed` : t`${file} couldn’t be removed`
    );
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
  const sheets = !compact || dragging;
  const sheetsArrive = useArrives(String(sheets));
  const promptArrives = useArrives(prompt);

  return (
    <div
      {...stylex.props(styles.whole)}
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
        {...stylex.props(
          styles.zone,
          focus.within,
          dragging && styles.dragging,
          shaking > 0 && styles.shaking
        )}
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
          {...stylex.props(styles.layer, styles.wash, dragging && styles.shown)}
        />
        {/* Drawn rather than bordered, so a file over it can close the dashes into one line. */}
        <svg aria-hidden="true" {...stylex.props(styles.edgeBox)}>
          <rect
            fill="none"
            ref={edge}
            x={0.5}
            y={0.5}
            {...stylex.props(
              styles.edge,
              hovered && styles.edgeHover,
              dragging && styles.edgeClosed
            )}
          />
        </svg>
        <span
          aria-hidden="true"
          {...stylex.props(styles.layer, styles.glow, dragging && styles.shown)}
        />
        {/* Its parts ignore the pointer, so the whole target is one place to click or drop. */}
        <button
          onClick={() => {
            input.current?.click();
          }}
          ref={trigger}
          type="button"
          {...stylex.props(styles.trigger, compact && styles.triggerCompact)}
        >
          {sheets ? (
            <span
              {...comeIn(
                sheetsArrive,
                motion.fade,
                styles.sheetsBox,
                styles.inert
              )}
            >
              <Sheets pose={pose} />
            </span>
          ) : null}
          <span {...stylex.props(styles.prompt, styles.inert)}>
            <span
              key={prompt}
              {...comeIn(promptArrives, motion.rise, styles.promptWords)}
            >
              {prompt}
            </span>
          </span>
          <span {...stylex.props(styles.or, styles.inert)}>
            {t`or choose them from your computer`}
          </span>
          {compact ? null : (
            <span {...stylex.props(styles.sheetsBox, styles.inert)}>
              <span {...stylex.props(styles.kinds)}>
                {t`PDF, Word, Excel, PowerPoint or text`}
              </span>
            </span>
          )}
        </button>
      </div>
      <input
        accept={readable.map((extension) => `.${extension}`).join(",")}
        aria-hidden="true"
        multiple
        {...stylex.props(styles.file)}
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
        <p role="alert" {...comeIn(true, motion.rise, styles.error)}>
          <span {...stylex.props(styles.errorMark)}>
            <Icon icon={Alert} />
          </span>
          <span {...stylex.props(styles.errorWords)}>{error}</span>
        </p>
      )}
      {/* Rows keep their own height and the list scrolls past four and a bit, or fewer where the window is low, rather than squeezing them or the page scrolling. */}
      {/* The arrow keys move between its rows' buttons, and Delete takes one out. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the keys act on the buttons inside it */}
      <ul
        aria-hidden={rows.length > 0 ? undefined : true}
        aria-label={t`Documents`}
        onKeyDown={onListKey}
        {...stylex.props(styles.list, rows.length > 0 && styles.listFilled)}
      >
        {rows.map((row) => (
          <Row
            key={row.key}
            onRemove={async () => {
              await remove(row);
            }}
            row={row}
          />
        ))}
      </ul>
      <output aria-live="polite" {...stylex.props(visuallyHidden)}>
        {announcement}
      </output>
    </div>
  );
};
