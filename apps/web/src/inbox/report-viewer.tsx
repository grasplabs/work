import { Button } from "@grasp-os/ui/components/button";
import {
  CodeBlock,
  CodeBlockContent,
} from "@grasp-os/ui/components/code-block";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import { Kbd, KbdGroup } from "@grasp-os/ui/components/kbd";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  EllipsisIcon,
  Icon,
  ScanIcon,
  SearchIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  radius,
  shadow,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";

import { formatPercent } from "../format.ts";
import { KeyboardIcon } from "./icons.ts";

// The weekly report in a file viewer, as #2503 shows it (its library's
// Artifact viewer): a quiet bar with the file's name and kind, Preview or
// Code, the zoom, find, download and the keyboard's shortcuts; under it,
// on the viewer's ground, the page in an inset card, or its code. Damsko
// has no file viewer (damsko-registry-gaps, 2026-11-25, Inbox): this one
// is composed of its parts for the report alone, which is one page of
// Grasp's own, so the preview is that page itself, drawn in the card, and
// not a frame. Find marks the matches with the browser's highlights.
// Below 35rem of the viewer's width the kind, the switch, the zoom, the
// download and the shortcuts fold into a menu, as #2503's do.

/** Narrower than this, the quiet controls fold into the menu. */
const NARROW = "@container report-viewer (width < 35rem)";

/** The zoom's steps, in percent, as #2503's viewer has them. */
const ZOOMS = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

/** The highlights find draws, by their names in the page's styles. */
const MATCHES = "report-viewer-match";
const CURRENT = "report-viewer-match-current";

const styles = stylex.create({
  root: {
    containerType: "inline-size",
    containerName: "report-viewer",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    width: "100%",
    height: "100%",
    minHeight: "20rem",
    overflow: "hidden",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    boxShadow: sizes.borderStrong,
    backgroundColor: colors.muted,
    outline: "none",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
    minHeight: sizes.controlLg,
    paddingInline: space["2"],
    backgroundColor: colors.card,
    boxShadow: `inset 0 calc(-1 * ${sizes.hairline}) 0 ${colors.border}`,
  },
  name: {
    display: "flex",
    alignItems: "baseline",
    gap: space["2"],
    minWidth: 0,
    flexGrow: 1,
    paddingInline: space["2"],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  file: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  kind: {
    display: { default: "inline", [NARROW]: "none" },
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  wide: {
    display: { default: "flex", [NARROW]: "none" },
    alignItems: "center",
    gap: space["1"],
    flexShrink: 0,
  },
  narrow: {
    display: { default: "none", [NARROW]: "flex" },
    flexShrink: 0,
  },
  words: {
    paddingInline: space["1"],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  rule: {
    width: sizes.hairline,
    height: space["5"],
    marginInline: space["1"],
    backgroundColor: colors.border,
    flexShrink: 0,
  },
  find: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
    flexShrink: 1,
    flexGrow: { default: 0, [NARROW]: 1 },
  },
  findField: {
    width: "14rem",
    minWidth: "6rem",
    flexShrink: 1,
    flexGrow: { default: 0, [NARROW]: 1 },
  },
  // The page or its code, on the viewer's ground, in from its sides.
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    minHeight: 0,
    padding: { default: space["6"], [NARROW]: space["2"] },
  },
  // The page in its card, scrolling inside it.
  page: {
    minHeight: 0,
    overflow: "auto",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
    "::highlight(report-viewer-match)": {
      backgroundColor: colors.warningSubtle,
      color: "inherit",
    },
    "::highlight(report-viewer-match-current)": {
      backgroundColor: `color-mix(in oklch, ${colors.warning} 40%, transparent)`,
      color: "inherit",
    },
  },
  zoomed: (zoom: number) => ({ zoom }),
  code: {
    minHeight: 0,
    overflow: "auto",
    "::highlight(report-viewer-match)": {
      backgroundColor: colors.warningSubtle,
    },
    "::highlight(report-viewer-match-current)": {
      backgroundColor: `color-mix(in oklch, ${colors.warning} 40%, transparent)`,
    },
  },
  centre: { display: "grid", placeItems: "center", minHeight: 0 },
  keys: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: `${space["2"]} ${space["4"]}`,
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  keyRow: { display: "contents" },
  keyName: { margin: 0, color: colors.bodyForeground },
  keyKeys: { margin: 0 },
});

type Zoom = number | "fit";

/** The next step of the zoom in `direction` from `from`, "fit" counting as 100%. */
export const zoomStep = (from: Zoom, direction: 1 | -1): number => {
  const now = from === "fit" ? 100 : from;
  if (direction > 0) {
    return ZOOMS.find((step) => step > now) ?? ZOOMS.at(-1) ?? now;
  }
  return ZOOMS.findLast((step) => step < now) ?? ZOOMS[0] ?? now;
};

/** Every place `query` stands in `root`'s words, case aside, within one run of text. */
export const matchesIn = (root: HTMLElement, query: string): Range[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") {
    return [];
  }
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? "").toLocaleLowerCase();
    for (
      let at = text.indexOf(needle);
      at !== -1;
      at = text.indexOf(needle, at + needle.length)
    ) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
};

/** The browser's highlights, where it has them (not every test's document does). */
const highlights = (): HighlightRegistry | undefined =>
  typeof CSS !== "undefined" && "highlights" in CSS
    ? CSS.highlights
    : undefined;

/**
 * Marks `ranges` as find's matches, `current` the one shown, and brings it
 * into view; clears them when the viewer goes.
 */
const useMarks = (ranges: readonly Range[], current: number): void => {
  useEffect(() => {
    const registry = highlights();
    const shown = ranges[current];
    if (registry !== undefined) {
      registry.set(MATCHES, new Highlight(...ranges));
      registry.set(
        CURRENT,
        shown === undefined ? new Highlight() : new Highlight(shown)
      );
    }
    shown?.startContainer.parentElement?.scrollIntoView({ block: "center" });
    return () => {
      registry?.delete(MATCHES);
      registry?.delete(CURRENT);
    };
  }, [ranges, current]);
};

/** Whether a key press was typed into a field, where it is the field's. */
const typing = (event: KeyboardEvent): boolean =>
  event.target instanceof HTMLElement &&
  event.target.closest("input, textarea, [contenteditable=true]") !== null;

/** The keyboard's shortcuts, and what each does, for the shortcuts dialog. */
const useShortcuts = (): { keys: string[]; does: string }[] => {
  const { t } = useLingui();
  return [
    { keys: ["="], does: t`Zoom in` },
    { keys: ["-"], does: t`Zoom out` },
    { keys: ["0"], does: t`Zoom to fit` },
    { keys: ["/"], does: t`Find in the file` },
    { keys: ["V"], does: t`Switch between preview and code` },
    { keys: ["Esc"], does: t`Close find` },
    { keys: ["?"], does: t`Show these shortcuts` },
  ];
};

/** The shortcuts, in a dialog of their own. */
const ShortcutsDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const shortcuts = useShortcuts();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Keyboard shortcuts`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <dl {...stylex.props(styles.keys)}>
            {shortcuts.map(({ keys, does }) => (
              <div key={does} {...stylex.props(styles.keyRow)}>
                <dt {...stylex.props(styles.keyName)}>{does}</dt>
                <dd {...stylex.props(styles.keyKeys)}>
                  <KbdGroup>
                    {keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </KbdGroup>
                </dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

/** Find, in the bar's place of the controls: the words, how many, the way between them, and close. */
const FindBar = ({
  value,
  count,
  current,
  field,
  onChange,
  onMove,
  onClose,
}: {
  value: string;
  count: number;
  current: number;
  field: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onMove: (direction: 1 | -1) => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const shown = current + 1;
  let counted = "";
  if (value.trim() !== "") {
    counted = count === 0 ? t`No matches` : t`${shown} of ${count}`;
  }
  return (
    <div {...stylex.props(styles.find)}>
      <Input
        aria-label={t`Find in the file`}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onMove(event.shiftKey ? -1 : 1);
          }
        }}
        onValueChange={onChange}
        placeholder={t`Find in the file`}
        ref={field}
        size="sm"
        style={styles.findField}
        type="search"
        value={value}
      />
      <output aria-live="polite" {...stylex.props(styles.words)}>
        {counted}
      </output>
      <Button
        aria-label={t`Previous match`}
        disabled={count === 0}
        onClick={() => {
          onMove(-1);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={ChevronUpIcon} />
      </Button>
      <Button
        aria-label={t`Next match`}
        disabled={count === 0}
        onClick={() => {
          onMove(1);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={ChevronDownIcon} />
      </Button>
      <Button
        aria-label={t`Close find`}
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={XIcon} />
      </Button>
    </div>
  );
};

type View = "preview" | "code";

/** The file's code, once it is read; a turning mark until then. */
const CodeView = ({
  code,
  name,
  box,
}: {
  code: string | undefined;
  name: string;
  box: RefObject<HTMLDivElement | null>;
}) => {
  const { t } = useLingui();
  if (code === undefined) {
    return (
      <div {...stylex.props(styles.centre)}>
        <Spinner aria-label={t`Loading the code`} />
      </div>
    );
  }
  return (
    <div ref={box} {...stylex.props(styles.code)}>
      <CodeBlock aria-label={t`Code of ${name}`} language="html">
        <CodeBlockContent lineNumbers maxLines={false} wrap>
          {code}
        </CodeBlockContent>
      </CodeBlock>
    </div>
  );
};

/**
 * A file in the viewer: `name` and `kind` in its bar, `children` the page
 * its preview shows, `readCode` its code once Code is chosen, and
 * `onDownload` saving it.
 */
export const ReportViewer = ({
  name,
  kind,
  children,
  readCode,
  onDownload,
}: {
  name: string;
  kind: string;
  children: ReactNode;
  readCode: () => Promise<string | undefined>;
  onDownload: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [view, setView] = useState<View>("preview");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [code, setCode] = useState<string>();
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [current, setCurrent] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [help, setHelp] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const codeBox = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useMarks(ranges, current);
  // The matches, found again whenever the words, the view or the code change.
  useEffect(() => {
    // The code's box is there once its code is read.
    const codeShown = code === undefined ? null : codeBox.current;
    const where = view === "preview" ? page.current : codeShown;
    setRanges(where === null ? [] : matchesIn(where, find));
    setCurrent(0);
  }, [find, view, code]);
  // Focus goes to find as it opens.
  useEffect(() => {
    if (findOpen) {
      field.current?.select();
    }
  }, [findOpen]);
  const showView = (next: View) => {
    setView(next);
    if (next === "code" && code === undefined) {
      void (async () => {
        setCode((await readCode()) ?? "");
      })();
    }
  };
  const closeFind = () => {
    setFindOpen(false);
    setFind("");
    root.current?.focus();
  };
  const moveMatch = (direction: 1 | -1) => {
    if (ranges.length > 0) {
      setCurrent(
        (before) => (before + direction + ranges.length) % ranges.length
      );
    }
  };
  const zoomIn = () => {
    setZoom(zoomStep(zoom, 1));
  };
  const zoomOut = () => {
    setZoom(zoomStep(zoom, -1));
  };
  const zoomToFit = () => {
    setZoom("fit");
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && findOpen) {
      event.preventDefault();
      closeFind();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFindOpen(true);
      field.current?.select();
      return;
    }
    if (typing(event) || mod || event.altKey) {
      return;
    }
    const actions: Record<string, () => void> = {
      "=": zoomIn,
      "+": zoomIn,
      "-": zoomOut,
      "0": zoomToFit,
      "/": () => {
        setFindOpen(true);
      },
      v: () => {
        showView(view === "preview" ? "code" : "preview");
      },
      "?": () => {
        setHelp(true);
      },
    };
    const action = actions[event.key];
    if (action !== undefined) {
      event.preventDefault();
      action();
    }
  };
  const zoomLabel = zoom === "fit" ? t`Fit` : formatPercent(zoom / 100);
  return (
    // The viewer takes the keys while focus is in it: a section, named by its file.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the keys are the toolbar's own, each also a control
    <section
      aria-label={name}
      onKeyDown={onKey}
      ref={root}
      tabIndex={-1}
      {...stylex.props(styles.root)}
    >
      <div {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.name)}>
          <span title={name} {...stylex.props(styles.file)}>
            {name}
          </span>
          <span {...stylex.props(styles.kind)}>{kind}</span>
        </span>
        <span {...stylex.props(styles.wide)}>
          <ToggleGroup
            aria-label={t`Preview or code`}
            onValueChange={(chosen: unknown[]) => {
              const [next] = chosen;
              if (next === "preview" || next === "code") {
                showView(next);
              }
            }}
            value={[view]}
          >
            <ToggleGroupItem value="preview">{t`Preview`}</ToggleGroupItem>
            <ToggleGroupItem value="code">{t`Code`}</ToggleGroupItem>
          </ToggleGroup>
        </span>
        {findOpen ? (
          <FindBar
            count={ranges.length}
            current={current}
            field={field}
            onChange={setFind}
            onClose={closeFind}
            onMove={moveMatch}
            value={find}
          />
        ) : (
          <>
            <span {...stylex.props(styles.wide)}>
              <Button
                aria-label={t`Zoom out`}
                disabled={view === "code"}
                onClick={zoomOut}
                size="icon-sm"
                variant="ghost"
              >
                <Icon icon={ZoomOutIcon} />
              </Button>
              <span {...stylex.props(styles.words)}>{zoomLabel}</span>
              <Button
                aria-label={t`Zoom in`}
                disabled={view === "code"}
                onClick={zoomIn}
                size="icon-sm"
                variant="ghost"
              >
                <Icon icon={ZoomInIcon} />
              </Button>
              <Button
                aria-label={t`Zoom to fit`}
                disabled={view === "code"}
                onClick={zoomToFit}
                size="icon-sm"
                variant="ghost"
              >
                <Icon icon={ScanIcon} />
              </Button>
              <span aria-hidden="true" {...stylex.props(styles.rule)} />
            </span>
            <Button
              aria-label={t`Find in the file`}
              onClick={() => {
                setFindOpen(true);
              }}
              size="icon-sm"
              variant="ghost"
            >
              <Icon icon={SearchIcon} />
            </Button>
            <span {...stylex.props(styles.wide)}>
              <Button
                aria-label={t`Download ${name}`}
                onClick={onDownload}
                size="icon-sm"
                variant="ghost"
              >
                <Icon icon={DownloadIcon} />
              </Button>
              <Button
                aria-label={t`Keyboard shortcuts`}
                onClick={() => {
                  setHelp(true);
                }}
                size="icon-sm"
                variant="ghost"
              >
                <Icon icon={KeyboardIcon} />
              </Button>
            </span>
            <span {...stylex.props(styles.narrow)}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label={t`More`} size="icon-sm" variant="ghost">
                    <Icon icon={EllipsisIcon} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      showView(view === "preview" ? "code" : "preview");
                    }}
                  >
                    {view === "preview"
                      ? t`Show the code`
                      : t`Show the preview`}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={view === "code"}
                    icon={ZoomInIcon}
                    onSelect={zoomIn}
                  >
                    {t`Zoom in`}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={view === "code"}
                    icon={ZoomOutIcon}
                    onSelect={zoomOut}
                  >
                    {t`Zoom out`}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={view === "code"}
                    icon={ScanIcon}
                    onSelect={zoomToFit}
                  >
                    {t`Zoom to fit`}
                  </DropdownMenuItem>
                  <DropdownMenuItem icon={DownloadIcon} onSelect={onDownload}>
                    {t`Download ${name}`}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={KeyboardIcon}
                    onSelect={() => {
                      setHelp(true);
                    }}
                  >
                    {t`Keyboard shortcuts`}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </>
        )}
      </div>
      <div {...stylex.props(styles.body)}>
        {/* The page stays drawn under the code: it is what is saved and printed. */}
        <div
          aria-label={t`Preview of ${name}`}
          hidden={view !== "preview"}
          ref={page}
          role="document"
          // The keys scroll it, as a page's own scroller.
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroller the keys move
          tabIndex={0}
          {...stylex.props(styles.page)}
        >
          <div
            {...stylex.props(styles.zoomed(zoom === "fit" ? 1 : zoom / 100))}
          >
            {children}
          </div>
        </div>
        {view === "code" ? (
          <CodeView box={codeBox} code={code} name={name} />
        ) : null}
      </div>
      <ShortcutsDialog onOpenChange={setHelp} open={help} />
    </section>
  );
};
