import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { Programme } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { formatDayMonth } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Download, File, Pdf } from "../grasp/icons/index.ts";
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
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { ReportView } from "./report-view.tsx";

// The weekly report as an item in the Inbox: it stands at the head of the
// list on the day the report on the week that closed is ready. Opening it
// shows the report (report-view.tsx), in a Sheet until the library's
// artifact viewer is installed, to download as the page itself, its fonts
// carried in it, or as a PDF through print.

const styles = stylex.create({
  sheet: {
    borderRadius: grasp.corner,
    overflow: "hidden",
  },
});

/** How many bytes go to `String.fromCodePoint` at once: well under any engine's argument limit. */
const CHUNK = 8192;

/** A font file the page loads, as data, so the file carries it. */
const asData = async (url: string): Promise<string> => {
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCodePoint(...bytes.subarray(at, at + CHUNK));
  }
  const type = response.headers.get("content-type") ?? "font/woff2";
  return `data:${type};base64,${btoa(binary)}`;
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
  const root = document.documentElement;
  // Light or dark as whatever opens it is: the tokens' light-dark() follow
  // the colour scheme, not the theme that was on when it was saved.
  return `<!doctype html><html lang="${root.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${css}\n:root{color-scheme:light dark}</style></head><body>${page.outerHTML}</body></html>`;
};

/** The report, made of the library's parts, with its downloads. */
const ReportArtifact = ({
  report,
  programme,
}: {
  report: BoardReport;
  programme: Programme;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [company, setCompany] = useState("");
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void core.withSession(async (session) => {
      const organization = await session.organization.get();
      setCompany(organization.name);
    });
  }, [core]);
  const name = `${company} week ${programme.week}`.trim();
  const file = async (): Promise<string> =>
    page.current === null ? "" : await snapshot(page.current, name);
  return (
    <>
      <SheetBody>
        {/* The artifact viewer stands round it once it is installed. */}
        <div {...stylex.props(styles.sheet)}>
          <ReportView
            company={company}
            programme={programme}
            ref={page}
            report={report}
          />
        </div>
      </SheetBody>
      <SheetFooter>
        <Button
          icon={Download}
          onClick={async () => {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(
              new Blob([await file()], { type: "text/html" })
            );
            link.download = `${name}.html`;
            link.click();
            URL.revokeObjectURL(link.href);
          }}
          variant="quiet"
        >
          {t`Download page`}
        </Button>
        <Button
          icon={Pdf}
          onClick={async () => {
            // Printed from a frame of its own, so only the report is on the paper.
            const frame = document.createElement("iframe");
            frame.hidden = true;
            frame.srcdoc = await file();
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
  const { week } = next;
  const day = formatDayMonth(today);
  const title = t`Your report on week ${week} is ready`;
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
            <ItemDescription>{t`Report · ${day}`}</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
      <Sheet onOpenChange={setOpen} open={open} size="wide">
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
