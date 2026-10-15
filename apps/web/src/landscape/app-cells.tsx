import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@grasp-os/ui/components/hover-card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Progress } from "@grasp-os/ui/components/progress";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  BanIcon,
  CircleHelpIcon,
  SparkleIcon,
  SparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  aiTypeDescription,
  aiTypeLabel,
  appSourceDescription,
  appSourceLabel,
  exposureMeta,
  sortedExposure,
} from "./landscape.ts";
import type { AiType, AppUse, DataExposureType } from "./landscape.ts";
import { hoverDelay } from "./toolbar.tsx";

// The cells of the Landscape's table, as the prototype draws them
// (`components/landscape/app-cells.tsx`).

const aiTypeIcon: Record<AiType, LucideIcon> = {
  Core: SparklesIcon,
  Embed: SparkleIcon,
  None: BanIcon,
  Unknown: CircleHelpIcon,
};

/** Core, embedded or no AI, explained on hover. */
export const AiTypeBadge = ({ aiType }: { aiType: AiType }) => {
  const { i18n } = useLingui();
  const Icon = aiTypeIcon[aiType];
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={hoverDelay.open}
        render={
          <Badge
            className="relative z-10"
            variant={aiType === "Core" ? "secondary" : "outline"}
          />
        }
      >
        <Icon data-icon="inline-start" />
        {i18n._(aiTypeLabel[aiType])}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{i18n._(aiTypeLabel[aiType])}</span>
          <span className="text-muted-foreground">
            {i18n._(aiTypeDescription[aiType])}
          </span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};

/** How Grasp knows the app is in use, each way explained on hover. */
export const SourceText = ({
  appName,
  use,
}: {
  appName: string;
  use: AppUse;
}) => {
  const { i18n } = useLingui();
  if (use.sources.length === 0) {
    return (
      <span className="text-muted-foreground">
        <Trans context="how Grasp knows an app is used">Unknown</Trans>
      </span>
    );
  }
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={hoverDelay.open}
        render={<span className="relative z-10 cursor-default" />}
      >
        {use.sources
          .map((source) => i18n._(appSourceLabel[source]))
          .join(" · ")}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <div className="flex flex-col gap-2">
          <span className="font-medium">
            <Trans>How Grasp knows about {appName}</Trans>
          </span>
          {use.sources.map((source) => (
            <div className="flex flex-col" key={source}>
              <span>{i18n._(appSourceLabel[source])}</span>
              <span className="text-muted-foreground">
                {i18n._(appSourceDescription[source])}
              </span>
            </div>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};

/** A count badge that opens a popover with the rest of a list. */
const MoreBadge = ({
  count,
  title,
  description,
  children,
}: {
  count: number;
  title: string;
  description: string;
  children: ReactNode;
}) => (
  <Popover>
    <PopoverTrigger
      closeDelay={hoverDelay.close}
      delay={hoverDelay.open}
      openOnHover
      render={<Button className="relative z-10" size="xs" variant="outline" />}
    >
      +{count}
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80">
      <PopoverHeader>
        <PopoverTitle>{title}</PopoverTitle>
        <PopoverDescription>{description}</PopoverDescription>
      </PopoverHeader>
      {children}
    </PopoverContent>
  </Popover>
);

/**
 * The engines that use the app: one shows, the rest behind "+N". The
 * prototype lists the processes it came up in and the workflows that use
 * it; in Grasp an app is used by the engines holding a permission on it.
 * Engines that couldn't be read are unknown, which isn't the same as none.
 */
export const ProcessesCell = ({ use }: { use: AppUse }) => {
  const { t } = useLingui();
  if (use.engines === null) {
    return (
      <span className="text-muted-foreground">
        <Trans context="domains that use an app, which couldn't be read">
          Unknown
        </Trans>
      </span>
    );
  }
  const { engines } = use;
  const [first, ...rest] = engines;
  if (first === undefined) {
    return (
      <span className="text-muted-foreground">
        <Trans>None yet</Trans>
      </span>
    );
  }
  const kind = t`Domain`;
  const detail = t`Holds a permission on one of its connections. Opens the domain.`;
  return (
    <div className="flex items-center gap-1">
      <HoverCard>
        <HoverCardTrigger
          delay={hoverDelay.open}
          render={
            <Badge
              className="relative z-10 max-w-32"
              render={
                <Link params={{ engine: first.id }} to="/domains/$engine" />
              }
              variant="outline"
            />
          }
        >
          <span className="truncate">{first.name}</span>
        </HoverCardTrigger>
        <HoverCardContent align="start" className="w-72">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{first.name}</span>
            <span className="text-muted-foreground">{kind}</span>
            <span className="text-muted-foreground">{detail}</span>
          </div>
        </HoverCardContent>
      </HoverCard>
      {rest.length > 0 ? (
        <MoreBadge
          count={rest.length}
          description={t`Where this app comes up`}
          title={t`Domains`}
        >
          <ItemGroup spacing="tight">
            {engines.map((engine) => (
              <Item
                key={engine.id}
                render={
                  <Link params={{ engine: engine.id }} to="/domains/$engine" />
                }
                size="xs"
              >
                <ItemContent>
                  <ItemTitle>{engine.name}</ItemTitle>
                  <ItemDescription>
                    {kind} · {detail}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </MoreBadge>
      ) : null}
    </div>
  );
};

const ExposureLabel = ({ type }: { type: DataExposureType }) => {
  const { i18n } = useLingui();
  return (
    <>
      <span
        aria-hidden="true"
        className={
          exposureMeta[type].sensitive
            ? "bg-status-attention size-1.5 rounded-full"
            : "bg-faint size-1.5 rounded-full"
        }
      />
      {i18n._(exposureMeta[type].label)}
    </>
  );
};

/**
 * The most sensitive category shows, with why it was flagged; the rest sit
 * behind "+N". Data nothing has said anything about yet is unknown, which
 * isn't the same as none.
 */
export const ExposureCell = ({
  types,
  reason,
}: {
  types: DataExposureType[] | null;
  reason: string;
}) => {
  const { t, i18n } = useLingui();
  if (types === null) {
    return (
      <span className="text-muted-foreground">
        <Trans context="data exposure of an app">Unknown</Trans>
      </span>
    );
  }
  const [first, ...rest] = sortedExposure(types);
  if (first === undefined) {
    return (
      <span className="text-muted-foreground">
        <Trans context="no data exposure">None</Trans>
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger
          closeDelay={hoverDelay.close}
          delay={hoverDelay.open}
          openOnHover
          render={
            <Button className="relative z-10" size="xs" variant="outline" />
          }
        >
          <ExposureLabel type={first} />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <PopoverHeader>
            <PopoverTitle>{i18n._(exposureMeta[first].label)}</PopoverTitle>
            <PopoverDescription>
              {i18n._(exposureMeta[first].definition)}
            </PopoverDescription>
          </PopoverHeader>
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">
              <Trans>Why it shows</Trans>
            </span>
            <span>{reason}</span>
          </div>
        </PopoverContent>
      </Popover>
      {rest.length > 0 ? (
        <MoreBadge
          count={rest.length}
          description={t`The other kinds of data this app touches`}
          title={t`Data exposure`}
        >
          <ItemGroup spacing="tight">
            {rest.map((type) => (
              <Item key={type} size="xs" variant="muted">
                <ItemContent>
                  <ItemTitle>
                    <ExposureLabel type={type} />
                  </ItemTitle>
                  <ItemDescription>
                    {i18n._(exposureMeta[type].definition)}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </MoreBadge>
      ) : null}
    </div>
  );
};

/** A team's share of an app's users. */
export interface Team {
  name: string;
  count: number;
}

/** The user count, with the biggest teams on hover; unknown while nothing measures it. */
export const UsersCell = ({
  users,
  teams,
  onOpen,
}: {
  users: number | null;
  teams: readonly Team[];
  onOpen: () => void;
}) => {
  const { t } = useLingui();
  if (users === null) {
    return (
      <span className="text-muted-foreground">
        <Trans context="usage of an app, which nothing measures yet">
          Unknown
        </Trans>
      </span>
    );
  }
  const total = teams.reduce((sum, team) => sum + team.count, 0) || users;
  const teamCount = Math.max(teams.length, 1);
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Button
            className="relative z-10 -ml-2"
            onClick={onOpen}
            size="xs"
            variant="link"
          />
        }
      >
        {users}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">
              <Trans>Usage</Trans>
            </span>
            <span className="text-muted-foreground">
              {total === 0
                ? t`No usage seen`
                : t`${plural(total, { one: "# user", other: "# users" })} across ${plural(teamCount, { one: "# team", other: "# teams" })}`}
            </span>
          </div>
          {teams.slice(0, 4).map((team) => {
            const teamName = team.name;
            return (
              <div className="flex flex-col gap-1.5" key={team.name}>
                <div className="flex justify-between gap-3">
                  <span className="truncate">{team.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {team.count}
                  </span>
                </div>
                <Progress
                  aria-label={t`${teamName} share of users`}
                  value={(team.count / Math.max(total, 1)) * 100}
                />
              </div>
            );
          })}
          <span className="text-muted-foreground">
            <Trans>Click to open Usage</Trans>
          </span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};
