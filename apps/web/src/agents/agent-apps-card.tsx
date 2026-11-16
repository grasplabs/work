import { agentAppOf } from "@grasp-os/shared/agents";
import type {
  Agent,
  AgentApp,
  AgentAppsWorkedOut,
} from "@grasp-os/shared/agents";
import type { CatalogEntry } from "@grasp-os/shared/connect";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { classNames, Row } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";

// An agent's apps (core's agent-app-access.ts), on its Instructions tab:
// the apps it may use, which whoever manages it takes off or adds by
// hand, and works out from its instructions. An agent with none listed
// uses any app its kinds of work allow, as before agents had apps; with
// some, only those. What working them out turned on and suggests is said
// under it: kinds of work that change or send things only with a press.

/** An agent's apps and the apps the company offers, as its page reads them. */
export interface AgentAppsShown {
  apps: readonly AgentApp[] | undefined;
  offered: readonly Offered[];
}

/**
 * Works out `agentId`'s apps from its instructions, as they are saved:
 * nothing said where no model answers, as the card offers it again.
 */
export const workOutQuietly = async (
  session: Session,
  agentId: string
): Promise<void> => {
  try {
    await session.connections.workOutAgentApps(agentId);
  } catch {
    // Its apps stay as they were; the card works them out on a press.
  }
};

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

/** An app the company offers, as the catalog has it. */
type Offered = Pick<CatalogEntry, "source" | "id" | "name">;

/** What working the apps out said, under the card. */
const WorkedOut = ({
  worked,
  agent,
  change,
  can,
}: {
  worked: AgentAppsWorkedOut;
  agent: Agent;
  change: Change;
  can: boolean;
}) => {
  const { t, i18n } = useLingui();
  const { name } = agent;
  const added = worked.added.map((each) => each.name).join(", ");
  const turned = worked.turnedOn
    .map((each) => i18n._(classNames[each]))
    .join(", ");
  const missing = worked.missing.join(", ");
  return (
    <li className="flex flex-col gap-2 border-t px-5 py-4 text-sm">
      <span>
        {added === ""
          ? t`No new app from its instructions.`
          : t`Added from its instructions: ${added}.`}
      </span>
      {turned === "" ? null : (
        <span>{t`Turned on, as it only reads: ${turned}.`}</span>
      )}
      {missing === "" ? null : (
        <span className="text-muted-foreground">
          {t`Its instructions name apps your company doesn't offer: ${missing}.`}
        </span>
      )}
      {worked.suggested.map((toolClass) => {
        const kind = i18n._(classNames[toolClass]);
        return (
          <span
            className="flex items-center justify-between gap-3"
            key={toolClass}
          >
            <span>{t`${name} also needs “${kind}”, which changes or sends things.`}</span>
            <Button
              disabled={!can}
              onClick={() => {
                void change(async (session) => {
                  await session.connections.setAgentToolClass(
                    agent.id,
                    toolClass,
                    {
                      who: "asClass",
                    }
                  );
                });
              }}
              size="sm"
              variant="outline"
            >
              <Trans>Turn on</Trans>
            </Button>
          </span>
        );
      })}
    </li>
  );
};

/** The rows of `agent`'s apps, and the ways to change them. */
export const AgentApps = ({
  agent,
  apps,
  offered,
  editable,
  can,
  change,
}: {
  agent: Agent;
  /** Its apps; undefined where core didn't say. */
  apps: readonly AgentApp[] | undefined;
  /** The apps the company offers, which it can be given. */
  offered: readonly Offered[];
  /** Whether the person may change it at all. */
  editable: boolean;
  /** Whether they may now: not while a change is on its way to core. */
  can: boolean;
  change: Change;
}) => {
  const { t } = useLingui();
  const whereFrom = (each: AgentApp): string => {
    if (each.state === "removed") {
      return t`Taken off: never added back from its instructions`;
    }
    return each.source === "instructions"
      ? t`Added from its instructions`
      : t`Added by hand`;
  };
  const { busy, failure, run } = useCoreAction();
  const [worked, setWorked] = useState<AgentAppsWorkedOut>();
  const [picked, setPicked] = useState("");
  const { name } = agent;
  const on = new Set(
    (apps ?? []).filter(({ state }) => state === "on").map(({ app }) => app)
  );
  // Core limits it once it has any row, one taken off included.
  const limitWords = (): string => {
    if ((apps ?? []).length === 0) {
      return t`${name} may use any app its kinds of work allow. Give it apps, and it uses only those.`;
    }
    return on.size === 0
      ? t`${name} may use no app: each was taken off. Give one back, or add one.`
      : t`${name} uses only these apps, as far as its kinds of work allow.`;
  };
  const addable = offered.filter(
    ({ source, id }) => !on.has(agentAppOf(source, id))
  );
  const set = (app: string, next: boolean): void => {
    void change(async (session) => {
      await session.connections.setAgentApp(agent.id, app, next);
    });
  };
  return (
    <>
      <li className="flex flex-col gap-0.5 border-t px-5 py-4">
        <span className="font-medium">
          <Trans>Apps</Trans>
        </span>
        <span className="text-muted-foreground">{limitWords()}</span>
      </li>
      {apps === undefined ? (
        <li className="text-muted-foreground border-t px-5 py-4">
          {t`Its apps couldn't be loaded. Reload the page.`}
        </li>
      ) : (
        apps.map((each) => {
          const app = each.name;
          return (
            <Row description={whereFrom(each)} key={each.app} name={app}>
              {editable ? (
                <Button
                  aria-label={
                    each.state === "on"
                      ? t`Take ${app} off`
                      : t`Give ${app} back`
                  }
                  disabled={!can}
                  onClick={() => {
                    set(each.app, each.state !== "on");
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {each.state === "on" ? t`Take off` : t`Give back`}
                </Button>
              ) : null}
            </Row>
          );
        })
      )}
      {editable ? (
        <li className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <NativeSelect
              aria-label={t`An app to give ${name}`}
              disabled={!can || addable.length === 0}
              onChange={(event) => {
                setPicked(event.target.value);
              }}
              value={picked}
            >
              <NativeSelectOption value="">{t`Choose an app`}</NativeSelectOption>
              {addable.map(({ source, id, name: appName }) => (
                <NativeSelectOption
                  key={agentAppOf(source, id)}
                  value={agentAppOf(source, id)}
                >
                  {appName}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              disabled={!can || picked === ""}
              onClick={() => {
                set(picked, true);
                setPicked("");
              }}
              size="sm"
              variant="outline"
            >
              <Trans>Add</Trans>
            </Button>
          </span>
          <Button
            disabled={!can || busy}
            onClick={() => {
              void run(async (session) => {
                // Read again however it ends: core may have added some.
                await changeThenRefresh(
                  async () => {
                    setWorked(
                      await session.connections.workOutAgentApps(agent.id)
                    );
                  },
                  async () => {
                    await change(async () => {
                      // Only the page read again.
                    });
                  }
                );
              });
            }}
            size="sm"
          >
            {busy
              ? t`Reading its instructions…`
              : t`Work out from its instructions`}
          </Button>
        </li>
      ) : null}
      {worked === undefined ? null : (
        <WorkedOut agent={agent} can={can} change={change} worked={worked} />
      )}
      {failure === undefined ? null : (
        <li className="text-destructive border-t px-5 py-4 text-sm">
          {failure}
        </li>
      )}
    </>
  );
};

/**
 * The Apps card of an agent's page: none for the company's first agent,
 * whose apps are the company's (Access).
 */
export const AgentAppsPanel = ({
  agent,
  apps,
  first,
  editable,
  can,
  change,
}: {
  agent: Agent;
  apps: AgentAppsShown | undefined;
  first: boolean;
  editable: boolean;
  can: boolean;
  change: Change;
}) =>
  first ? null : (
    <Card variant="panel">
      <ul className="[&>li:first-child]:border-t-0">
        <AgentApps
          agent={agent}
          apps={apps?.apps}
          can={can}
          change={change}
          editable={editable}
          offered={apps?.offered ?? []}
        />
      </ul>
    </Card>
  );
