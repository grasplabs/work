import type { OwnAgentsUsage } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { FieldGroup } from "@grasp-os/ui/components/field";
import { Switch } from "@grasp-os/ui/components/switch";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { formatDollars } from "../format.ts";
import { orNull } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { FactRow, SettingRow, SettingsCard } from "./settings-card.tsx";

// People's own agents, for the company's admins: whether people may have
// agents of their own (core's own-agents-switch.ts), and per person who
// has any, how many and what they cost this month. Never what they are
// called or told: those are their owners' alone. A settings card of rows:
// the switch first, then a fact row per person.

/** What an admin reads of people's own agents. */
export interface OwnAgentsAdmin {
  /** Whether people may have agents of their own. */
  on: boolean;
  /** Per person with any, the most spent first; none where core didn't say. */
  usage: readonly OwnAgentsUsage[] | undefined;
  /** The company's people, by whom each row is named; undefined where core didn't say them. */
  people: readonly Member[] | undefined;
}

/**
 * Reads what an admin sees of people's own agents: the switch, what each
 * person's cost, and the people to name them by. The cost and the people
 * are left out where core won't say them, and the card still shows the
 * rest.
 */
export const readOwnAgentsAdmin = async (
  session: Session
): Promise<OwnAgentsAdmin> => {
  const [setting, usage, people] = await Promise.all([
    session.orgSettings.ownAgents(),
    orNull(async () => await session.connections.ownAgentsUsage()),
    orNull(async () => await session.members.list()),
  ]);
  return {
    on: setting.on,
    usage: usage ?? undefined,
    people: people ?? undefined,
  };
};

/** A row per person with agents of their own, or why there are none to show. */
const UsageRows = ({
  usage,
  nameOf,
}: {
  usage: readonly OwnAgentsUsage[] | undefined;
  nameOf: (personId: string) => string;
}) => {
  const { t } = useLingui();
  if (usage === undefined || usage.length === 0) {
    return (
      <Empty
        size="sm"
        variant={usage === undefined ? "destructive" : "default"}
      >
        <EmptyHeader>
          <EmptyDescription>
            {usage === undefined
              ? t`What they cost couldn't be loaded.`
              : t`Nobody has an agent of their own yet.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      {usage.map((each) => {
        const spent = formatDollars(each.spent);
        const count = each.agents;
        return (
          <FactRow
            help={t`${spent} this month`}
            key={each.personId}
            label={nameOf(each.personId)}
          >
            {plural(count, { one: "# agent", other: "# agents" })}
          </FactRow>
        );
      })}
    </>
  );
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
  const { busy, failure, run } = useCoreAction();
  const nameOf = (personId: string): string => {
    // Without the company's people, nobody is said to have left.
    if (admin.people === undefined) {
      return t`Name not shown`;
    }
    const found = admin.people.find(({ userId }) => userId === personId);
    if (found === undefined) {
      return t`Someone no longer in the company`;
    }
    return found.name === "" ? found.email : found.name;
  };
  return (
    <>
      <SettingsCard
        // Behind the info mark: what an admin sees of them, and never.
        info={t`Agents people make for themselves. Only their owner sees and asks them, and they do at most what Grasp may do for that person. You see how many each person has and what they cost, never what they are told.`}
        title={t`People's own agents`}
      >
        <FieldGroup>
          <SettingRow
            info={
              admin.on
                ? t`Anyone in the company can make agents of their own.`
                : t`Nobody can make one, and those people have don't answer until you turn this back on.`
            }
            label={t`Let people make agents of their own`}
          >
            <Switch
              checked={admin.on}
              disabled={!editable || busy}
              // A spinner while it saves; failed, it stays and says so.
              onSave={async (next) => {
                const done = await run(async (session) => {
                  await session.orgSettings.updateOwnAgents({ on: next });
                  await router.invalidate({ sync: true });
                  return true;
                });
                if (done !== true) {
                  throw new Error("The setting wasn't saved.");
                }
              }}
            />
          </SettingRow>
          <UsageRows nameOf={nameOf} usage={admin.usage} />
        </FieldGroup>
      </SettingsCard>
      <AgentFailure>{failure}</AgentFailure>
    </>
  );
};
