import type {
  ChatPlanKind,
  ChatPlanned,
  ChatPlanNeed,
} from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LayoutGridIcon, RepeatIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { integrationKey } from "../connections/integrations.ts";

// The plan Grasp's agent proposes before it makes anything new
// (`proposePlan`), in the chat's thread: what Grasp will make in plain
// words, each part by what it is to the person, never by Grasp's own words
// for it: a page the team opens (an App), and what runs on its own (a
// workflow), then who gets it. A part that needs a connection the person
// doesn't have yet says so, with the way to connect it (the integration's
// own page), so the plan never promises what can't be built. What it lists
// is the model's plain text, shown as text. Build it and Change the plan
// are the thread's (`actions`), only while the plan waits for the person.

/** No connections needed, or none missing. */
const noNeeds: readonly ChatPlanNeed[] = [];

/** What each kind of part is, to someone who never built anything. */
const KindWords = ({ kind }: { kind: ChatPlanKind }) =>
  kind === "app" ? (
    <Trans>A page your team opens</Trans>
  ) : (
    <Trans>Runs on its own</Trans>
  );

/** A connection a part needs and the person lacks, with the way to connect it. */
const Need = ({ need }: { need: ChatPlanNeed }) => {
  const { name } = need;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge variant="attention">
        <Trans>Needs {name} connected</Trans>
      </Badge>
      <Link
        className={buttonVariants({ size: "xs", variant: "outline" })}
        params={{ integration: integrationKey(need.source, need.provider) }}
        to="/integrations/$integration"
      >
        <Trans>Connect</Trans>
      </Link>
    </span>
  );
};

/** One part of the plan: what it is, its name, what it does and what it still needs. */
const Part = ({
  icon,
  kind,
  name,
  does,
  needs = noNeeds,
}: {
  icon: ReactNode;
  kind: ReactNode;
  name: string;
  does: ReactNode;
  needs?: readonly ChatPlanNeed[];
}) => (
  <Item render={<li />} size="sm">
    <ItemMedia variant="tile">{icon}</ItemMedia>
    <ItemContent>
      <ItemDescription>{kind}</ItemDescription>
      <ItemTitle>{name}</ItemTitle>
      <ItemDescription>{does}</ItemDescription>
      {needs.map((need) => (
        <Need key={`${need.source}:${need.provider}`} need={need} />
      ))}
    </ItemContent>
  </Item>
);

/** The App first, then the workflow. */
const kindOrder: Readonly<Record<ChatPlanKind, number>> = {
  app: 0,
  workflow: 1,
};

/** Whether `need` is among `unmet`. */
const isUnmet = (need: ChatPlanNeed, unmet: readonly ChatPlanNeed[]): boolean =>
  unmet.some(
    ({ source, provider }) =>
      source === need.source && provider === need.provider
  );

/**
 * The plan, as a card: its parts, with the connections each still needs
 * (`unmet`), who gets it, and `actions` while it waits.
 */
export const PlanCard = ({
  plan,
  unmet = noNeeds,
  actions,
}: {
  plan: ChatPlanned;
  unmet?: readonly ChatPlanNeed[];
  actions?: ReactNode;
}) => {
  const { t } = useLingui();
  const parts = plan.parts.toSorted(
    (one, other) => kindOrder[one.kind] - kindOrder[other.kind]
  );
  return (
    <Card aria-label={t`Here's what Grasp will make`} render={<section />}>
      <CardHeader>
        <CardTitle>
          <h2 className="type-display">
            <Trans>Here&apos;s what Grasp will make</Trans>
          </h2>
        </CardTitle>
        <CardDescription>
          <Trans>
            Nothing is made until you say Build it. You can change any of it
            first.
          </Trans>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ItemGroup render={<ul />}>
          {parts.map((part) => (
            <Part
              does={part.does}
              icon={part.kind === "app" ? <LayoutGridIcon /> : <RepeatIcon />}
              key={part.kind}
              kind={<KindWords kind={part.kind} />}
              name={part.name}
              needs={(part.needs ?? []).filter((need) => isUnmet(need, unmet))}
            />
          ))}
          <Part
            does={
              <Trans>
                Only you see it while you try it. You share it when it&apos;s
                right.
              </Trans>
            }
            icon={<UsersIcon />}
            kind={<Trans>Who gets it</Trans>}
            name={plan.who}
          />
        </ItemGroup>
      </CardContent>
      {actions === undefined ? null : <CardFooter>{actions}</CardFooter>}
    </Card>
  );
};
