import type { AppDraft } from "@grasp-os/shared/app-drafts";
import type { AppMember, ViewedApp } from "@grasp-os/shared/apps";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { formatList } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  ChevronRight,
  Done,
  Edit,
  Link as LinkIcon,
  People,
} from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { userNames } from "./app-status.tsx";

// CONCEPT ONLY (branch concept/apps-bar): three ways the end of an App's
// bar could make its draft live and share it, drawn for Ruben to pick
// from, chosen by `?concept=a|b|c`. Never merged as it stands.
//
// A: Share opens sharing alone; Publish (ink) opens a popover with the
//    state, the address, who can open it, the checks and Publish.
// B: one ink action opens one popover that picks who gets it and makes
//    it live in one step, as today's sheet does.
// C: the state itself is the way in: a quiet "Live · 26.11.1" opens the
//    details (address, who, checks, Share); Publish beside it goes live
//    at once, with Undo in its toast.

export type Concept = "a" | "b" | "c";

/** The concept the address asks for, if any. */
export const conceptOf = (): Concept | undefined => {
  const asked = new URLSearchParams(window.location.search).get("concept");
  return asked === "a" || asked === "b" || asked === "c" ? asked : undefined;
};

const styles = stylex.create({
  facts: { display: "grid", gap: grasp.space1, minWidth: grasp.space24 },
  end: { display: "flex", alignItems: "center", gap: grasp.space2 },
  // Share folds into the main action's popover on a phone.
  wide: { display: { default: "flex", [media.belowPhone]: "none" } },
});

/** Where the App stands, in one line with a dot. */
const StateLine = ({
  app,
  draft,
}: {
  app: ViewedApp;
  draft: AppDraft | undefined;
}) => {
  const { t } = useLingui();
  const label = app.liveLabel ?? "";
  const live = app.currentVersion !== null;
  const changing = draft !== undefined && draft.revision > 0;
  let words = t`Not live`;
  if (live) {
    words = changing
      ? t`Live, ${label}; changes not live yet`
      : t`Live, ${label}`;
  }
  return (
    <Badge tone={live ? "success" : "attention"} variant="dot">
      {words}
    </Badge>
  );
};

/** The address, who can open it, and the checks. */
const Facts = ({
  app,
  members,
  picking,
}: {
  app: ViewedApp;
  members: readonly AppMember[];
  /** B: who gets it is picked here rather than in Sharing. */
  picking: boolean;
}) => {
  const { t } = useLingui();
  const who = userNames(members);
  const address = app.link ?? t`No address yet`;
  const whom = who.length === 0 ? t`Only its builders` : formatList(who);
  return (
    <div {...stylex.props(styles.facts)}>
      <Item size="sm">
        <ItemMedia icon={LinkIcon} />
        <ItemContent>
          <ItemTitle>{address}</ItemTitle>
          <ItemDescription>{t`Address`}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            aria-label={t`Change the address`}
            icon={Edit}
            size="xs"
            variant="ghost"
          />
        </ItemActions>
      </Item>
      <Item size="sm">
        <ItemMedia icon={People} />
        <ItemContent>
          <ItemTitle>{whom}</ItemTitle>
          <ItemDescription>
            {picking
              ? t`Who gets it: pick teams and people`
              : t`Who can open it`}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            aria-label={t`Sharing`}
            icon={ChevronRight}
            render={
              <Link
                params={{ app: app.id }}
                search={{ section: "sharing" }}
                to="/apps/$app/settings"
              />
            }
            size="xs"
            variant="ghost"
          />
        </ItemActions>
      </Item>
      <Item size="sm">
        <ItemMedia icon={Done} />
        <ItemContent>
          <ItemTitle>{t`Checks pass`}</ItemTitle>
        </ItemContent>
      </Item>
    </div>
  );
};

/** The end of the bar, as concept `concept` draws it. */
export const ConceptEnd = ({
  concept,
  app,
  draft,
  members,
}: {
  concept: Concept;
  app: ViewedApp;
  draft: AppDraft | undefined;
  members: readonly AppMember[];
}) => {
  const { t } = useLingui();
  if (concept === "a") {
    return (
      <span {...stylex.props(styles.end)}>
        <span {...stylex.props(styles.wide)}>
          <Button
            icon={People}
            render={
              <Link
                params={{ app: app.id }}
                search={{ section: "sharing" }}
                to="/apps/$app/settings"
              />
            }
            size="sm"
            variant="quiet"
          >
            {t`Share`}
          </Button>
        </span>
        <Popover>
          <PopoverTrigger size="sm" variant="ink">
            {t`Publish`}
          </PopoverTrigger>
          <PopoverContent align="end">
            <PopoverTitle>
              <StateLine app={app} draft={draft} />
            </PopoverTitle>
            <Facts app={app} members={members} picking={false} />
            <PopoverFooter>
              <Button variant="ink">{t`Publish`}</Button>
            </PopoverFooter>
          </PopoverContent>
        </Popover>
      </span>
    );
  }
  if (concept === "b") {
    return (
      <Popover>
        <PopoverTrigger icon={People} size="sm" variant="ink">
          {t`Share with your team`}
        </PopoverTrigger>
        <PopoverContent align="end">
          <PopoverTitle>
            <StateLine app={app} draft={draft} />
          </PopoverTitle>
          <Facts app={app} members={members} picking />
          <PopoverFooter>
            <Button variant="ink">{t`Share and publish`}</Button>
          </PopoverFooter>
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <span {...stylex.props(styles.end)}>
      <span {...stylex.props(styles.wide)}>
        <Popover>
          <PopoverTrigger size="sm" variant="ghost">
            {app.currentVersion === null
              ? t`Not live`
              : t`Live, ${app.liveLabel ?? ""}`}
          </PopoverTrigger>
          <PopoverContent align="end">
            <PopoverTitle>
              <StateLine app={app} draft={draft} />
            </PopoverTitle>
            <Facts app={app} members={members} picking={false} />
          </PopoverContent>
        </Popover>
      </span>
      <Button size="sm" variant="ink">
        {t`Publish`}
      </Button>
    </span>
  );
};
