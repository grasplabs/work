import type { BoardReport } from "@grasp-os/shared/board-report";
import type { Programme } from "@grasp-os/shared/onboarding";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  DownloadIcon,
  FileIcon,
  FilePdfIcon,
  Icon,
} from "@grasp-os/ui/lib/icons";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Await, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { downloadText } from "../export/export-file.tsx";
import { formatDayMonth } from "../format.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { ReportView } from "./report-view.tsx";

// The weekly report as a row of the Inbox: it stands at the head of the
// list on the day the report on the week that closed is ready, and on
// every other day as a quiet row at the list's foot, opening the week so
// far. Opening it shows the report's page (report-view.tsx) in a sheet;
// Download saves that page as one HTML file, with its styles and fonts
// carried in it, and Save as PDF prints the same page, its fonts loaded
// from this origin.

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

/** Every font file the page's styles name, by its address. */
const fontUrl = /url\("?(?<path>[^")]+\.woff2)"?\)/gu;

/** Selectors that style the document itself, which the page sits in. */
const documentWide = /(?:^|[\s,(])(?::root|html|body|\*)(?=$|[\s,.:[)])/u;

/** A selector's states the snapshot never shows (hover, focus), dropped with it. */
const pseudo = /::?[a-z-]+(?:\([^)]*\))?/gu;

/** Whether a selector picks anything in the page, or styles the document it stands in. */
const picks = (selector: string, page: HTMLElement): boolean => {
  if (documentWide.test(selector)) {
    return true;
  }
  const plain = selector.replaceAll(pseudo, "");
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

/** A typeface family's name as a style writes it, without its quotes. */
const unquoted = (family: string): string =>
  family.trim().replaceAll(/^["']|["']$/gu, "");

/** The typeface families the page's text is set in. */
const familiesOf = (page: HTMLElement): Set<string> => {
  const families = new Set<string>();
  for (const element of [page, ...page.querySelectorAll("*")]) {
    for (const family of getComputedStyle(element).fontFamily.split(",")) {
      families.add(unquoted(family));
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
    const family = unquoted(rule.style.getPropertyValue("font-family"));
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
 * written in. Downloaded (`embed`), its fonts are carried as data, so it
 * opens the same offline; printed here, they are named by their address
 * on this origin, as a `srcdoc` frame keeps the page's policy, which loads
 * fonts from nowhere else (font-src is default-src, 'self'; core's
 * security-headers.ts).
 */
const snapshot = async (
  page: HTMLElement,
  title: string,
  embed: boolean
): Promise<string> => {
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
  const data: ReadonlyMap<string, string | undefined> = embed
    ? new Map(
        await Promise.all(
          [...fonts].map(
            async ([url, href]) => [url, await asData(href)] as const
          )
        )
      )
    : fonts;
  const css = sheets
    .map(({ css: text }) =>
      text.replaceAll(fontUrl, (whole: string, url: string) => {
        const source = data.get(url);
        return source === undefined ? whole : `url("${source}")`;
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

/** How long a printed frame stays once its dialog is up: the browser has the page by then. */
const printKeptMs = 1000;

/** Prints `html` from a frame of its own, so only the report is on the paper. */
const print = (html: string): void => {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.srcdoc = html;
  frame.addEventListener("load", () => {
    frame.contentWindow?.print();
    setTimeout(() => {
      frame.remove();
    }, printKeptMs);
  });
  document.body.append(frame);
};

/** The company's name, for the report's eyebrow and its file; empty when it can't be read. */
const useCompany = (): string | undefined => {
  const core = useCore();
  const [company, setCompany] = useState<string>();
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
  return company;
};

/** The report's page in the sheet, and what saves it: Download and Save as PDF. */
const ReportSheetBody = ({
  report,
  programme,
}: {
  report: BoardReport;
  programme: Programme;
}) => {
  const { t } = useLingui();
  const company = useCompany();
  const page = useRef<HTMLDivElement>(null);
  // Named by the week it is on, the one that closed, as its row and the sheet say.
  const week = String(programme.nextReport.week).padStart(2, "0");
  const fileOf = async (embed: boolean): Promise<string | undefined> => {
    const drawn = page.current;
    if (drawn === null || company === undefined) {
      return undefined;
    }
    return await snapshot(
      drawn,
      `${company} week ${programme.nextReport.week}`.trim(),
      embed
    );
  };
  return (
    <>
      <SheetBody>
        {company === undefined ? (
          <Spinner aria-label={t`Loading the report`} size="lg" />
        ) : (
          <ReportView
            company={company}
            programme={programme}
            ref={page}
            report={report}
          />
        )}
      </SheetBody>
      <SheetFooter>
        <Button
          disabled={company === undefined}
          onClick={async () => {
            const html = await fileOf(true);
            if (html !== undefined) {
              downloadText(
                `weekly-report-week-${week}.html`,
                html,
                "text/html"
              );
            }
          }}
          variant="outline"
        >
          <Icon icon={DownloadIcon} />
          {t`Download`}
        </Button>
        <Button
          disabled={company === undefined}
          onClick={async () => {
            const html = await fileOf(false);
            if (html !== undefined) {
              print(html);
            }
          }}
        >
          <Icon icon={FilePdfIcon} />
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
  /** The weekly report, as core reads it in one call: the sheet waits for it. */
  report: Promise<Loaded<BoardReport>>;
}) => {
  const { t, i18n } = useLingui();
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
        {/* A button of its own, so the row has the chevron a list's rows have. */}
        <Item asChild size="xs">
          <button
            onClick={() => {
              // Read again first, so the report is as it stands now.
              void (async () => {
                await router.invalidate({ sync: true });
                setOpen(true);
              })();
            }}
            type="button"
          >
            <ItemMedia>
              <Icon icon={FileIcon} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{title}</ItemTitle>
              <ItemDescription>{detail}</ItemDescription>
            </ItemContent>
          </button>
        </Item>
      </ItemGroup>
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent side="end" size="full">
          <SheetHeader>
            <SheetTitle>{t`Week ${week}`}</SheetTitle>
          </SheetHeader>
          <Await promise={report}>
            {(loaded) =>
              loaded.state === "ready" ? (
                <ReportSheetBody programme={programme} report={loaded.data} />
              ) : (
                // Never an empty sheet: why the report couldn't be read.
                <SheetBody>
                  <Alert variant="destructive">
                    <AlertDescription>
                      {notLoadedText(loaded, i18n)}
                    </AlertDescription>
                  </Alert>
                </SheetBody>
              )
            }
          </Await>
        </SheetContent>
      </Sheet>
    </>
  );
};
