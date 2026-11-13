import type { OwnAgentsUsage } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import { Card } from "@grasp-os/ui/components/card";
import { Switch } from "@grasp-os/ui/components/switch";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId } from "react";

import { ErrorText } from "../error-text.tsx";
import { dollars } from "../settings/money.ts";
import { Row } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";

// People's own agents, on the Agents page for the company's admins
// (agents-overview.tsx): whether people may have agents of their own
// (core's own-agents-switch.ts), and per person who has any, how many
// and what they cost this month. Never what they are called or told:
// those are their owners' alone.

/** What an admin reads of people's own agents. */
export interface OwnAgentsAdmin {
  /** Whether people may have agents of their own. */
  on: boolean;
  /** Per person with any, the most spent first; none where core didn't say. */
  usage: readonly OwnAgentsUsage[] | undefined;
  /** The company's people, by whom each row is named. */
  people: readonly Member[];
}

/** One row per person with agents of their own, or why there are none to show. */
const UsageRows = ({
  usage,
  nameOf,
}: {
  usage: readonly OwnAgentsUsage[] | undefined;
  nameOf: (personId: string) => string;
}) => {
  const { t } = useLingui();
  if (usage === undefined) {
    return (
      <li className="text-muted-foreground border-t px-5 py-4">
        {t`What they cost couldn't be loaded.`}
      </li>
    );
  }
  if (usage.length === 0) {
    return (
      <li className="text-muted-foreground border-t px-5 py-4">
        {t`Nobody has an agent of their own yet.`}
      </li>
    );
  }
  return usage.map((each) => {
    const spent = dollars(each.spent);
    const count = each.agents;
    return (
      <Row
        description={t`${spent} this month`}
        key={each.personId}
        name={nameOf(each.personId)}
      >
        <span className="text-muted-foreground text-sm">
          <Plural one="# agent" other="# agents" value={count} />
        </span>
      </Row>
    );
  });
};

/** The card of people's own agents; `editable` for the company's own admins. */
export const OwnAgentsCard = ({
  admin,
  editable,
}: {
  admin: OwnAgentsAdmin;
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const switchId = useId();
  const { busy, failure, run } = useCoreAction();
  const nameOf = (personId: string): string => {
    const found = admin.people.find(({ userId }) => userId === personId);
    if (found === undefined) {
      return t`Someone no longer in the company`;
    }
    return found.name === "" ? found.email : found.name;
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium">
          <Trans>People&apos;s own agents</Trans>
        </h2>
        <p className="text-muted-foreground text-sm">
          <Trans>
            Agents people make for themselves. Only their owner sees and asks
            them, and they do at most what Grasp may do for that person. You see
            how many each person has and what they cost, never what they are
            told.
          </Trans>
        </p>
      </div>
      <Card variant="panel">
        <ul className="[&>li:first-child]:border-t-0">
          <Row
            description={
              admin.on
                ? t`Anyone in the company can make agents of their own.`
                : t`Nobody can make one, and those people have don't answer until you turn this back on.`
            }
            name={t`Let people make agents of their own`}
          >
            <Switch
              aria-label={t`Let people make agents of their own`}
              checked={admin.on}
              disabled={!editable || busy}
              id={switchId}
              onCheckedChange={(next) => {
                void run(async (session) => {
                  await session.orgSettings.updateOwnAgents({ on: next });
                  await router.invalidate({ sync: true });
                });
              }}
            />
          </Row>
          <UsageRows nameOf={nameOf} usage={admin.usage} />
        </ul>
      </Card>
      <ErrorText>{failure}</ErrorText>
    </section>
  );
};
