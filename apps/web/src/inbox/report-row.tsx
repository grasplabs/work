import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { Programme } from "@grasp-os/shared/onboarding";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { formatDayMonth } from "../format.ts";
import { ArtifactViewer } from "../grasp/artifact-viewer/index.ts";
import { Button } from "../grasp/button/index.ts";
import { File, Pdf } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { ReportView } from "./report-view.tsx";

// The weekly report as an item in the Inbox: it stands at the head of the
// list on the day the report on the week that closed is ready, and on every
// other day as a quiet row at the list's foot, opening the week so far. Opening it
// shows the report in the library's artifact viewer, as the file it is: the
// report's page (report-view.tsx) is drawn out of sight, read into one HTML
// file with its styles and fonts carried in it, and that file is what the
// viewer shows and downloads. Save as PDF prints the same file.

const styles = stylex.create({
  // The viewer has what the sheet has between its title and its foot.
  viewer: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    placeItems: "center",
    flexGrow: 1,
    minHeight: 0,
    paddingBlockStart: grasp.space4,
    paddingInline: grasp.space6,
  },
  // The report's page, drawn only to be read into the file: laid out at its
  // own width so its charts measure and draw, never seen or reached.
  source: {
    position: "fixed",
    insetBlockStart: 0,
    insetInlineStart: "-200vw",
    width: "48rem",
    visibility: "hidden",
    pointerEvents: "none",
  },
});

/** How many bytes go to `String.fromCodePoint` at once: well under any engine's argument limit. */
const CHUNK = 8192;

/**
 * A font file the page loads, as data, so the file carries it; none when it
 * can't be read, and the file then names the font by its address.
 */
const asData = async (url: string): Promise<string | undefined> => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return undefined;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += CHUNK) {
      binary += String.fromCodePoint(...bytes.subarray(at, at + CHUNK));
    }
    const type = response.headers.get("content-type") ?? "font/woff2";
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
};

/** The next frame the browser draws. */
const nextFrame = async (): Promise<number> => {
  const { promise, resolve } = Promise.withResolvers<number>();
  requestAnimationFrame(resolve);
  return await promise;
};

/** Every font file the page's styles name, by its address. */
const fontUrl = /url\("?(?<path>[^")]+\.woff2)"?\)/gu;

/** Selectors that style the document itself, which the page sits in. */
const documentWide = /(?:^|[\s,(])(?::root|html|body|\*)(?=$|[\s,.:[)])/u;

/** Whether a selector picks anything in the page, or styles the document it stands in. */
const picks = (selector: string, page: HTMLElement): boolean => {
  if (documentWide.test(selector)) {
    return true;
  }
  // State the snapshot never shows (hover, focus) is dropped with its selector.
  const plain = selector.replaceAll(/::?[a-z-]+(?:\([^)]*\))?/gu, "");
  try {
    return (
      plain.trim() === "" ||
      page.matches(plain) ||
      page.querySelector(plain) !== null
    );
  } catch {
    return true;
  }
};

/** The typeface families the page's text is set in. */
const familiesOf = (page: HTMLElement): Set<string> => {
  const families = new Set<string>();
  for (const element of [page, ...page.querySelectorAll("*")]) {
    for (const family of getComputedStyle(element).fontFamily.split(",")) {
      families.add(family.trim().replaceAll(/^["']|["']$/gu, ""));
    }
  }
  return families;
};

/** One `U+a-b` or `U+a` range of a font's unicode-range. */
const unicodeSpan = /U\+(?<from>[0-9a-f?]+)(?:-(?<to>[0-9a-f]+))?/giu;

/** Whether a font's unicode-range covers any character of the page's text. */
const coversText = (range: string, text: ReadonlySet<number>): boolean => {
  if (range === "") {
    return true;
  }
  for (const { groups } of range.matchAll(unicodeSpan)) {
    const from = Number.parseInt(groups?.from?.replaceAll("?", "0") ?? "0", 16);
    const to = Number.parseInt(
      groups?.to ?? groups?.from?.replaceAll("?", "f") ?? "0",
      16
    );
    for (const point of text) {
      if (point >= from && point <= to) {
        return true;
      }
    }
  }
  return false;
};

/** What the page needs to draw its text: the families it uses and the characters it holds. */
interface Need {
  families: ReadonlySet<string>;
  text: ReadonlySet<number>;
}

/**
 * A style rule as the page needs it: kept when it picks something in the
 * page, or styles the document; an at-rule with only its rules that do; a
 * font only in a family the page uses, for characters its text holds;
 * animations and custom properties whole. Empty when none is needed.
 */
const usedRule = (rule: CSSRule, page: HTMLElement, need: Need): string => {
  if (rule instanceof CSSFontFaceRule) {
    const family = rule.style
      .getPropertyValue("font-family")
      .trim()
      .replaceAll(/^["']|["']$/gu, "");
    const range = rule.style.getPropertyValue("unicode-range");
    return need.families.has(family) && coversText(range, need.text)
      ? rule.cssText
      : "";
  }
  if (rule instanceof CSSStyleRule) {
    return picks(rule.selectorText, page) ? rule.cssText : "";
  }
  if (rule instanceof CSSGroupingRule) {
    const inner = [...rule.cssRules]
      .map((each) => usedRule(each, page, need))
      .filter((css) => css !== "");
    if (inner.length === 0) {
      return "";
    }
    const head = rule.cssText.slice(0, rule.cssText.indexOf("{"));
    return `${head}{${inner.join("\n")}}`;
  }
  return rule.cssText;
};

/**
 * The page as a file of its own: its markup, with the styles it uses
 * written in and its fonts carried as data, so it opens the same offline.
 */
const snapshot = async (page: HTMLElement, title: string): Promise<string> => {
  // The characters the page shows, by code point: the fonts' ranges are in them.
  const shown = new Set<number>();
  for (const character of page.textContent ?? "") {
    shown.add(character.codePointAt(0) ?? 0);
  }
  const need: Need = { families: familiesOf(page), text: shown };
  const sheets = [...document.styleSheets].flatMap((sheet) => {
    try {
      return [...sheet.cssRules].flatMap((rule) => {
        const css = usedRule(rule, page, need);
        return css === "" ? [] : [{ css, base: sheet.href ?? location.href }];
      });
    } catch {
      return [];
    }
  });
  const fonts = new Map<string, string>();
  for (const { css, base } of sheets) {
    for (const match of css.matchAll(fontUrl)) {
      const url = match.groups?.path;
      if (url !== undefined && !url.startsWith("data:")) {
        fonts.set(url, new URL(url, base).href);
      }
    }
  }
  const data = new Map(
    await Promise.all(
      [...fonts].map(async ([url, href]) => [url, await asData(href)] as const)
    )
  );
  const css = sheets
    .map(({ css: text }) =>
      text.replaceAll(fontUrl, (whole: string, url: string) => {
        const inline = data.get(url);
        return inline === undefined ? whole : `url("${inline}")`;
      })
    )
    .join("\n");
  // Built as a document, not glued from strings, so the title (the
  // company's name, which may hold `<` or `&`) is text in the file that is
  // shared, never markup.
  const file = document.implementation.createHTMLDocument();
  file.documentElement.lang = document.documentElement.lang;
  const meta = (attributes: Record<string, string>): HTMLMetaElement => {
    const element = file.createElement("meta");
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    return element;
  };
  const named = file.createElement("title");
  named.textContent = title;
  const style = file.createElement("style");
  // Light or dark as whatever opens it is: the tokens' light-dark() follow
  // the colour scheme, not the theme that was on when it was saved.
  style.textContent = `${css}\n:root{color-scheme:light dark}`;
  file.head.prepend(
    meta({ charset: "utf-8" }),
    meta({ name: "viewport", content: "width=device-width, initial-scale=1" }),
    meta({ name: "color-scheme", content: "light dark" })
  );
  file.head.append(named, style);
  file.body.append(file.importNode(page, true));
  return `<!doctype html>${file.documentElement.outerHTML}`;
};

/** The report's file, read from its page once the company's name is in and the charts have drawn. */
const useReportFile = (
  week: number
): {
  company: string;
  page: RefObject<HTMLDivElement | null>;
  html: string | undefined;
} => {
  const core = useCore();
  // Null until read; empty when it can't be: the report then names no company.
  const [company, setCompany] = useState<string | null>(null);
  const [html, setHtml] = useState<string>();
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void (async () => {
      try {
        const organization = await core.withSession(
          async (session) => await session.organization.get()
        );
        setCompany(organization.name);
      } catch {
        setCompany("");
      }
    })();
  }, [core]);
  useEffect(() => {
    const drawn = page.current;
    let stale = false;
    const read = async (from: HTMLElement, title: string) => {
      // The charts measure their box in one frame and draw in the next.
      await nextFrame();
      await nextFrame();
      const file = await snapshot(from, title);
      if (!stale) {
        setHtml(file);
      }
    };
    if (company !== null && drawn !== null) {
      void read(drawn, `${company} week ${week}`.trim());
    }
    return () => {
      stale = true;
    };
  }, [company, week]);
  return { company: company ?? "", page, html };
};

/** The report in the artifact viewer, which downloads it, and Save as PDF. */
const ReportArtifact = ({
  report,
  programme,
}: {
  report: BoardReport;
  programme: Programme;
}) => {
  const { t } = useLingui();
  const { week } = programme;
  const { company, page, html } = useReportFile(week);
  return (
    <>
      <div aria-hidden inert {...stylex.props(styles.source)}>
        <ReportView
          company={company}
          programme={programme}
          ref={page}
          report={report}
        />
      </div>
      <div {...stylex.props(styles.viewer)}>
        {html === undefined ? (
          <Spinner aria-label={t`Loading the report`} size="lg" />
        ) : (
          // No scripts: the report is a still page. Its place is not in the
          // address: the sheet is no place a link leads to.
          <ArtifactViewer
            location="none"
            // Named by the week it is on, the one that closed, as its row and the sheet say.
            name={`weekly-report-week-${String(programme.nextReport.week).padStart(2, "0")}.html`}
            text={html}
            type="text/html"
          />
        )}
      </div>
      <SheetFooter>
        <Button
          disabled={html === undefined}
          icon={Pdf}
          onClick={() => {
            if (html === undefined) {
              return;
            }
            // Printed from a frame of its own, so only the report is on the paper.
            const frame = document.createElement("iframe");
            frame.hidden = true;
            frame.srcdoc = html;
            frame.addEventListener("load", () => {
              frame.contentWindow?.print();
              setTimeout(() => {
                frame.remove();
              }, 1000);
            });
            document.body.append(frame);
          }}
          variant="ink"
        >
          {t`Save as PDF`}
        </Button>
      </SheetFooter>
    </>
  );
};

export const ReportItem = ({
  programme,
  report,
}: {
  programme: Programme;
  /** The weekly report, as core reads it in one call: the page waits for it. */
  report: Promise<Loaded<BoardReport>>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { nextReport: next, today } = programme;
  const { week, inDays } = next;
  const day = formatDayMonth(today);
  // On the day a week closes, its report is ready; on any other day the
  // row opens the week so far, and says when the report is ready.
  const ready = inDays === 0;
  const title = ready
    ? t`Your report on week ${week} is ready`
    : t`Week ${week} so far`;
  const detail = ready
    ? t`Report · ${day}`
    : t`Next report ${plural(inDays, { one: "tomorrow", other: "in # days" })}`;
  return (
    <>
      <ItemGroup aria-label={t`Your weekly report`}>
        <Item
          render={
            <button
              aria-label={title}
              onClick={() => {
                // Read again first, so the report is as it stands now.
                void (async () => {
                  await router.invalidate();
                  setOpen(true);
                })();
              }}
              type="button"
            />
          }
          size="xs"
        >
          <ItemMedia icon={File} iconLook="inline" />
          <ItemContent>
            <ItemTitle>{title}</ItemTitle>
            <ItemDescription>{detail}</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
      <Sheet onOpenChange={setOpen} open={open} size="full">
        <SheetContent>
          <SheetTitle>{t`Week ${week}`}</SheetTitle>
          <Await promise={report}>
            {(loaded) =>
              loaded.state === "ready" ? (
                <ReportArtifact programme={programme} report={loaded.data} />
              ) : null
            }
          </Await>
        </SheetContent>
      </Sheet>
    </>
  );
};
