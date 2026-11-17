import type {
  ChatPlanKind,
  ChatPlanned,
  ChatPlanNeed,
} from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { integrationKey } from "../connections/integrations.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { AppPanels, Cycle, People } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// The plan Grasp's agent proposes before it makes anything new
// (`proposePlan`), in the chat's thread: what Grasp will make in plain
// words, each part by what it is to the person, never by Grasp's own words
// for it: a page the team opens (an App), and what runs on its own (a
// workflow), then who gets it. A part that needs a connection the person
// doesn't have yet says so, with the way to connect it (the integration's
// own page), so the plan never promises what can't be built. What it lists
// is the model's plain text, shown as text. Build it and Change the plan
// are the thread's (`actions`), only while the plan waits for the person.

const styles = stylex.create({
  need: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    marginBlockStart: grasp.space1,
  },
});

/** No connections needed, or none missing. */
const noNeeds: readonly ChatPlanNeed[] = [];

/** A connection a part needs and the person lacks, with the way to connect it. */
const Need = ({ need }: { need: ChatPlanNeed }) => {
  const { t } = useLingui();
  const { name } = need;
  return (
    <span {...stylex.props(styles.need)}>
      <Badge tone="attention">{t`Needs ${name} connected`}</Badge>
      <Button
        render={
          <Link
            params={{
              integration: integrationKey(need.source, need.provider),
            }}
            to="/integrations/$integration"
          />
        }
        size="xs"
        variant="quiet"
      >
        {t`Connect`}
      </Button>
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
  icon: IconData;
  kind: string;
  name: string;
  does: string;
  needs?: readonly ChatPlanNeed[];
}) => (
  <Item size="sm">
    <ItemMedia icon={icon} />
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
  // What each kind of part is, to someone who never built anything.
  const kinds: Record<ChatPlanKind, string> = {
    app: t`A page your team opens`,
    workflow: t`Runs on its own`,
  };
  return (
    <SectionCard
      description={t`Nothing is made until you say Build it. You can change any of it first.`}
      footer={actions}
      headingLevel={2}
      title={t`Here's what Grasp will make`}
    >
      <ItemGroup>
        {parts.map((part) => (
          <Part
            does={part.does}
            icon={part.kind === "app" ? AppPanels : Cycle}
            key={part.kind}
            kind={kinds[part.kind]}
            name={part.name}
            needs={(part.needs ?? []).filter((need) => isUnmet(need, unmet))}
          />
        ))}
        <Part
          does={t`Only you see it while you try it. You share it when it's right.`}
          icon={People}
          kind={t`Who gets it`}
          name={plan.who}
        />
      </ItemGroup>
    </SectionCard>
  );
};
