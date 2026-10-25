import type {
  CompanyToolClass,
  ToolClassAudience,
  ToolClassSetting,
} from "@grasp-os/shared/connect";
import type {
  AppClassAudience,
  PlaceAudience,
  StephenReach,
} from "@grasp-os/shared/stephen-reach";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Switch } from "@grasp-os/ui/components/switch";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SettingsSection } from "./settings-parts.tsx";

// Settings › Stephen, as in the prototype (`routes/settings/stephen.tsx`):
// the one place that says who can reach the company's assistant in its
// chat apps and what he may do for whom. Stephen himself, then the places
// people reach him, then the classes of what he does, company-wide and per
// app. Each layer only narrows the one above it; core keeps it and holds
// him to it from the next message (stephen-reach.ts, tool-classes.ts).
// Every control saves at once and reads the page again. The company's own
// admins change it; Grasp staff only read it.

/** Who a control may choose: as the layer above, everyone, some teams, or nobody. */
type Who = "same" | "everyone" | "teams" | "nobody";

/** An audience of any layer, as a control holds it. */
interface Chosen {
  who: Who;
  teams: string[];
}

const chosenOf = (
  audience: ToolClassAudience | PlaceAudience | AppClassAudience
): Chosen => {
  if (audience.who === "teams") {
    return { who: "teams", teams: audience.teams };
  }
  if (audience.who === "asStephen" || audience.who === "asClass") {
    return { who: "same", teams: [] };
  }
  return { who: audience.who, teams: [] };
};

const whoLabels = {
  everyone: msg`Everyone`,
  teams: msg`Chosen teams`,
  nobody: msg`Nobody`,
} as const satisfies Record<Exclude<Who, "same">, MessageDescriptor>;

/**
 * Who a setting reaches: a choice, then the teams when it is some teams.
 * It saves once it is whole: a choice of teams waits for its first team,
 * and taking the last one away leaves nobody.
 */
const AudienceControl = ({
  label,
  value,
  offers,
  same,
  teams,
  editable,
  onSave,
}: {
  label: string;
  value: Chosen;
  offers: readonly Who[];
  /** What "as the layer above" is called here, when it is offered. */
  same?: string;
  teams: StephenReach["teams"];
  editable: boolean;
  onSave: (chosen: Chosen) => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const id = useId();
  const [who, setWho] = useState<Who>(value.who);
  const save = async (chosen: Chosen): Promise<void> => {
    await onSave(
      chosen.who === "teams" && chosen.teams.length === 0
        ? { who: "nobody", teams: [] }
        : chosen
    );
  };
  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <NativeSelect
        aria-label={label}
        disabled={!editable}
        id={id}
        size="sm"
        value={who}
        onChange={(event) => {
          const next = offers.find((one) => one === event.target.value);
          if (next === undefined) {
            return;
          }
          setWho(next);
          if (next !== "teams") {
            void save({ who: next, teams: [] });
          }
        }}
      >
        {offers.map((one) => (
          <NativeSelectOption key={one} value={one}>
            {one === "same" ? same : i18n._(whoLabels[one])}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {who === "teams" ? (
        <ul aria-label={t`Teams for ${label}`} className="flex flex-col gap-1">
          {teams.map(({ teamId, name }) => (
            <li key={teamId}>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={value.teams.includes(teamId)}
                  disabled={!editable}
                  onCheckedChange={(checked) => {
                    const rest = value.teams.filter((one) => one !== teamId);
                    void save({
                      who: "teams",
                      teams: checked ? [...rest, teamId] : rest,
                    });
                  }}
                />
                {name}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** A company-wide audience as core takes it. */
const audienceOf = ({ who, teams }: Chosen): ToolClassAudience => {
  if (who === "teams") {
    return { who, teams };
  }
  return { who: who === "everyone" ? "everyone" : "nobody" };
};

/** A place's audience as core takes it. */
const placeAudienceOf = (chosen: Chosen): PlaceAudience =>
  chosen.who === "same" ? { who: "asStephen" } : audienceOf(chosen);

/** An app's audience for a class as core takes it. */
const appAudienceOf = (chosen: Chosen): AppClassAudience =>
  chosen.who === "same" ? { who: "asClass" } : audienceOf(chosen);

const classNames = {
  "read-own": msg`Read their own`,
  "read-company": msg`Read the company's`,
  "change-own": msg`Change their own`,
  "change-company": msg`Change the company's`,
  "reach-others": msg`Reach others`,
  "read-others": msg`Read others' words`,
} as const satisfies Record<CompanyToolClass, MessageDescriptor>;

const classDescriptions = {
  "read-own": msg`Their own mail, calendar and files. Runs at once.`,
  "read-company": msg`Shared mailboxes, colleagues' calendars and the company's files.`,
  "change-own": msg`Drafts, events and files of their own, after they press a card.`,
  "change-company": msg`Shared mailboxes, registers and the company's records, after they press a card.`,
  "reach-others": msg`Mail and messages to other people, after they press a card with every recipient.`,
  "read-others": msg`What others wrote and said in their own Teams chats and meetings, summarised for them alone.`,
} as const satisfies Record<CompanyToolClass, MessageDescriptor>;

/** Apps by their connector's provider, as people know them. */
const appNames: Readonly<Record<string, string>> = {
  microsoft: "Microsoft 365",
  google: "Google Workspace",
};

/** Places by their chat platform, as people know them. */
const placeNames: Readonly<Record<string, string>> = {
  teams: "Microsoft Teams",
  slack: "Slack",
  whatsapp: "WhatsApp",
};

/** One setting's row: its name and what it means, then its control. */
const Row = ({
  name,
  description,
  children,
}: {
  name: string;
  description?: string;
  children: ReactNode;
}) => (
  <li className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
    <span className="flex min-w-0 flex-col gap-0.5">
      <span>{name}</span>
      {description === undefined ? null : (
        <span className="text-muted-foreground">{description}</span>
      )}
    </span>
    <span className="flex flex-none flex-col gap-3 sm:items-end">
      {children}
    </span>
  </li>
);

/**
 * Settings › Stephen: Stephen himself, his places, and what he may do,
 * company-wide and per app; `editable` for the company's own admins.
 */
export const StephenSettings = ({
  reach,
  classes,
  editable,
}: {
  reach: StephenReach;
  classes: ToolClassSetting[];
  editable: boolean;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const change = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const can = editable && !busy;
  const { teams } = reach;
  return (
    <>
      <SettingsSection
        description={t`The assistant people chat with in Microsoft Teams and the other chat apps. What is set here is all he may do: a place or an app only narrows it.`}
        title="Stephen"
      >
        <ul>
          <Row
            description={t`Off, he answers nobody in any chat app. Grasp's own chat keeps working.`}
            name={t`On in chat apps`}
          >
            <Switch
              aria-label={t`On in chat apps`}
              checked={reach.on}
              disabled={!can}
              onCheckedChange={(on) => {
                void change(async (session) => {
                  await session.connections.setStephenReach(on, reach.audience);
                });
              }}
            />
          </Row>
          <Row name={t`Who can talk to him`}>
            <AudienceControl
              editable={can}
              key={JSON.stringify(reach.audience)}
              label={t`Who can talk to him`}
              offers={["everyone", "teams", "nobody"]}
              teams={teams}
              value={chosenOf(reach.audience)}
              onSave={async (chosen) => {
                await change(async (session) => {
                  await session.connections.setStephenReach(
                    reach.on,
                    audienceOf(chosen)
                  );
                });
              }}
            />
          </Row>
        </ul>
        <ErrorText>{failure}</ErrorText>
      </SettingsSection>
      <SettingsSection
        description={t`Who reaches him in each place, as above or fewer, and whether he does things for people there or only answers.`}
        title={t`Where people reach him`}
      >
        <ul>
          {reach.places.map((place) => {
            const name = placeNames[place.place] ?? place.place;
            return (
              <Row key={place.place} name={name}>
                <AudienceControl
                  editable={can}
                  key={JSON.stringify(place.audience)}
                  label={t`Who reaches him in ${name}`}
                  offers={["same", "teams", "nobody"]}
                  same={t`As for Stephen`}
                  teams={teams}
                  value={chosenOf(place.audience)}
                  onSave={async (chosen) => {
                    await change(async (session) => {
                      await session.connections.setStephenPlace(
                        place.place,
                        placeAudienceOf(chosen),
                        place.acts
                      );
                    });
                  }}
                />
                <span className="flex items-center gap-2">
                  <Switch
                    aria-label={t`Does things for people in ${name}`}
                    checked={place.acts}
                    disabled={!can}
                    onCheckedChange={(acts) => {
                      void change(async (session) => {
                        await session.connections.setStephenPlace(
                          place.place,
                          place.audience,
                          acts
                        );
                      });
                    }}
                  />
                  <span aria-hidden="true">
                    <Trans>Does things for people here</Trans>
                  </span>
                </span>
              </Row>
            );
          })}
        </ul>
      </SettingsSection>
      <SettingsSection
        description={t`Every tool he has is of one of these kinds. Each is on for whom you choose, in every app.`}
        title={t`What he may do`}
      >
        <ul>
          {classes.map(({ toolClass, audience }) => {
            const name = i18n._(classNames[toolClass]);
            return (
              <Row
                description={i18n._(classDescriptions[toolClass])}
                key={toolClass}
                name={name}
              >
                <AudienceControl
                  editable={can}
                  key={JSON.stringify(audience)}
                  label={name}
                  offers={["everyone", "teams", "nobody"]}
                  teams={teams}
                  value={chosenOf(audience)}
                  onSave={async (chosen) => {
                    await change(async (session) => {
                      await session.connections.setToolClass(
                        toolClass,
                        audienceOf(chosen)
                      );
                    });
                  }}
                />
              </Row>
            );
          })}
        </ul>
      </SettingsSection>
      {reach.apps.map(({ app, classes: appClasses }) => {
        const appName = appNames[app] ?? app;
        return (
          <SettingsSection
            description={t`What he may do in ${appName}: as for the whole company, or for fewer people.`}
            key={app}
            title={appName}
          >
            <ul>
              {appClasses.map(({ toolClass, audience }) => {
                const name = i18n._(classNames[toolClass]);
                return (
                  <Row key={toolClass} name={name}>
                    <AudienceControl
                      editable={can}
                      key={JSON.stringify(audience)}
                      label={t`${name} in ${appName}`}
                      offers={["same", "teams", "nobody"]}
                      same={t`As for the whole company`}
                      teams={teams}
                      value={chosenOf(audience)}
                      onSave={async (chosen) => {
                        await change(async (session) => {
                          await session.connections.setAppToolClass(
                            app,
                            toolClass,
                            appAudienceOf(chosen)
                          );
                        });
                      }}
                    />
                  </Row>
                );
              })}
            </ul>
          </SettingsSection>
        );
      })}
    </>
  );
};
