import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Button } from "../grasp/button/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Desktop,
  External,
  More,
  Phone,
  Retry,
  Tablet,
} from "../grasp/icons/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreRead } from "./use-core-read.ts";

// The preview's own controls, in the bar's middle beside the views while
// the App's preview shows (app-workspace.tsx): how wide it is drawn, a
// Reload, which of the App's pages it shows, and Open in a new tab. On a
// phone they fold into one menu, without the width, which a phone has
// already.
//
// Core names no pages of an App (its contents say only whether it has
// any), so the pages are read from its route files, as TanStack Router's
// file routes name them: `src/routes/index.tsx` is "/", `orders.tsx` and
// `orders/index.tsx` are "/orders". A route with a parameter (`$id`)
// can't be offered without a value, a layout (`_layout`, `__root`) is no
// page of its own, and an excluded file (`-parts.tsx`) is no route: none
// of them is listed. A pathless segment (`_layout/`) and a group
// (`(admin)/`) add nothing to the path.

/** How wide the preview is drawn. */
export type PreviewWidth = "desktop" | "tablet" | "phone";

const widths: readonly PreviewWidth[] = ["desktop", "tablet", "phone"];

const routeFile = /^src\/routes\/(?<route>.+)\.(?:tsx|ts|jsx|js)$/u;

/** The path a route file serves, or undefined for one that is no page. */
export const pathOfRoute = (file: string): string | undefined => {
  const route = routeFile.exec(file)?.groups?.route;
  if (route === undefined) {
    return undefined;
  }
  const segments = route.split(/[/.]/u);
  const last = segments.at(-1) ?? "";
  if (
    last.startsWith("_") ||
    segments.some(
      (segment) => segment.startsWith("$") || segment.startsWith("-")
    )
  ) {
    return undefined;
  }
  const kept = segments
    .filter(
      (segment, at) =>
        !segment.startsWith("_") &&
        !(segment.startsWith("(") && segment.endsWith(")")) &&
        !(segment === "index" && at === segments.length - 1)
    )
    .map((segment) => (segment.endsWith("_") ? segment.slice(0, -1) : segment));
  return `/${kept.join("/")}`;
};

/** The first route first, then the rest by path. */
const byPage = (a: string, b: string): number => {
  if (a === "/" || b === "/") {
    return a === "/" ? -1 : 1;
  }
  return a.localeCompare(b);
};

/** The pages of `files`, by path, the first route first. */
export const pagesOf = (files: readonly string[]): string[] =>
  [
    ...new Set(
      files.flatMap((file) => {
        const path = pathOfRoute(file);
        return path === undefined ? [] : [path];
      })
    ),
  ].toSorted(byPage);

/**
 * The pages of what the preview shows: the draft's files while it changes
 * the App (`revision`), else the live version's. None while they are read.
 */
export const useAppPages = (
  app: string,
  draft: { revision: number } | undefined,
  version: number | null
): string[] => {
  const read = useCoreRead(
    `${app}/${draft === undefined ? `v${version ?? ""}` : `r${draft.revision}`}`,
    async (session) => {
      if (draft !== undefined) {
        return Object.keys(await session.apps.drafts.files(app));
      }
      return version === null
        ? []
        : Object.keys(await session.apps.files.read(app, version));
    },
    app
  );
  return read?.state === "ready" ? pagesOf(read.data) : [];
};

/**
 * The preview's controls as the workspace holds them: how wide it is
 * drawn, which page it shows, and each Reload, which starts it afresh
 * (`reloads`, a key). `theirs` when it shows what the team sees, else the
 * builders' draft.
 */
export const usePreviewControls = (
  app: { id: string; currentVersion: number | null },
  theirs: boolean,
  draft: { revision: number } | undefined
) => {
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  const [page, setPage] = useState<string>();
  const [reloads, setReloads] = useState(0);
  const pages = useAppPages(
    app.id,
    theirs ? undefined : draft,
    app.currentVersion
  );
  const controls: PreviewControlsProps = {
    opens: theirs ? `/apps/${app.id}/full` : `/apps/${app.id}/draft`,
    pages,
    page,
    onPage: setPage,
    width,
    onWidth: setWidth,
    onReload: () => {
      setReloads((before) => before + 1);
    },
  };
  return { controls, width, page, reloads };
};

const styles = stylex.create({
  // Drawn inline from a phone's width on; one menu below it.
  inline: {
    display: { default: "flex", [media.belowPhone]: "none" },
    alignItems: "center",
    gap: grasp.space1,
  },
  folded: { display: { default: "none", [media.belowPhone]: "flex" } },
  page: { minWidth: grasp.space24 },
});

/** The width a preview is drawn at: the token Grasp UI's App preview uses. */
export const previewWidths = stylex.create({
  desktop: { maxWidth: "none" },
  tablet: { maxWidth: grasp.appPreviewTablet },
  phone: { maxWidth: grasp.appPreviewPhone },
});

/** The preview's controls, as the workspace holds them. */
export interface PreviewControlsProps {
  /** Where Open in a new tab goes, before the page's path. */
  opens: string;
  pages: readonly string[];
  /** The page shown; the first while none was picked. */
  page: string | undefined;
  onPage: (page: string) => void;
  width: PreviewWidth;
  onWidth: (width: PreviewWidth) => void;
  onReload: () => void;
}

/** The preview's width, Reload, page and Open in a new tab. */
export const PreviewControls = ({
  opens,
  pages,
  page,
  onPage,
  width,
  onWidth,
  onReload,
}: PreviewControlsProps) => {
  const { t } = useLingui();
  const shown = page ?? pages[0] ?? "/";
  const href = `${opens}${shown === "/" ? "" : shown}`;
  const widthLabels: Record<PreviewWidth, string> = {
    desktop: t`Desktop`,
    tablet: t`Tablet`,
    phone: t`Phone`,
  };
  const icons = { desktop: Desktop, tablet: Tablet, phone: Phone };
  return (
    <>
      <div {...stylex.props(styles.inline)}>
        <ToggleGroup
          aria-label={t`Preview width`}
          onValueChange={(chosen: unknown[]) => {
            const picked = widths.find((each) => each === chosen[0]);
            if (picked !== undefined) {
              onWidth(picked);
            }
          }}
          size="sm"
          value={[width]}
        >
          {widths.map((each) => (
            <Toggle
              aria-label={widthLabels[each]}
              icon={icons[each]}
              key={each}
              title={widthLabels[each]}
              value={each}
            />
          ))}
        </ToggleGroup>
        <Button
          aria-label={t`Reload`}
          icon={Retry}
          onClick={onReload}
          size="sm"
          title={t`Reload`}
          variant="ghost"
        />
        {pages.length > 1 ? (
          <Select
            items={pages.map((each) => ({ value: each, label: each }))}
            layout={styles.page}
            onValueChange={(value) => {
              if (typeof value === "string") {
                onPage(value);
              }
            }}
            value={shown}
          >
            <SelectTrigger aria-label={t`Page`} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
        ) : null}
        <Button
          aria-label={t`Open in a new tab`}
          icon={External}
          render={
            <a
              aria-label={t`Open in a new tab`}
              href={href}
              rel="noreferrer"
              target="_blank"
            />
          }
          size="sm"
          title={t`Open in a new tab`}
          variant="ghost"
        />
      </div>
      <div {...stylex.props(styles.folded)}>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`Preview`}
            icon={More}
            size="sm"
            variant="ghost"
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={Retry} onSelect={onReload}>
              {t`Reload`}
            </DropdownMenuItem>
            <DropdownMenuItem href={href} icon={External}>
              {t`Open in a new tab`}
            </DropdownMenuItem>
            {pages.length > 1 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  onValueChange={(value: unknown) => {
                    if (typeof value === "string") {
                      onPage(value);
                    }
                  }}
                  value={shown}
                >
                  {pages.map((each) => (
                    <DropdownMenuRadioItem key={each} value={each}>
                      {each}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
};
