import type {
  CompanyToolClass,
  ToolClassAudience,
  ToolClassSetting,
} from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import type { StephenWeek } from "@grasp-os/shared/stephen-requests";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Switch } from "@grasp-os/ui/components/switch";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Mark } from "../brain/region-marks.tsx";
import { changeThenRefresh } from "../change-then-refresh.ts";
import { AppLogo } from "../connections/app-logo.tsx";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatNumber } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { PlaceLogo, placeName } from "../workflows/requests/request-parts.tsx";
import { SettingsSection } from "./settings-parts.tsx";
import {
  AudienceControl,
  appAudienceOf,
  audienceOf,
  chosenOf,
  placeAudienceOf,
} from "./stephen-audience.tsx";
import { StephenCard } from "./stephen-card.tsx";

// Settings › Stephen, as in the prototype (`routes/settings/stephen.tsx`,
// `components/stephen/*`): the one place that says who can reach the
// company's assistant in its chat apps and what he may do for whom.
// Stephen's card on top (stephen-card.tsx): on or paused, who can talk to
// him, how he is doing. Then the places people reach him, each opening
// the same panel: on or off there, who reaches him there, and whether he
// does things for people there. Then what he may do, company-wide, and
// per app as a pack, each opening its panel, with its done and failed
// counts; and the workflows people may start by asking him. Each layer
// only narrows the one above it; core keeps it and holds him to it from
// the next message (stephen-reach.ts, tool-classes.ts). Every control
// saves at once and reads the page again. The company's own admins change
// it; Grasp staff only read it. The prototype's Microsoft 365 demo (its
// register, leave and expenses) stays behind.

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
  "read-others": msg`Teams chats and meetings they were in: what others wrote and said there, summarised for them alone.`,
} as const satisfies Record<CompanyToolClass, MessageDescriptor>;

/** Apps by their connector's provider, as people know them. */
const appNames: Readonly<Record<string, string>> = {
  microsoft: "Microsoft 365",
  google: "Google Workspace",
};

/** Places Stephen can be added to, by their chat platform. */
const addable = ["teams", "slack", "whatsapp", "telegram", "gmail"] as const;

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
 * A row that opens its panel: a logo, a name, one fact, and the chevron.
 * A place's fact has the brain's mark before it, as the prototype's
 * places: filled where he is on there, hollow where he is off.
 */
const OpenRow = ({
  logo,
  name,
  line,
  mark,
  onOpen,
}: {
  logo: ReactNode;
  name: string;
  line: string;
  mark?: "known" | "waiting";
  onOpen?: () => void;
}) => {
  const body = (
    <>
      {logo}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
          {mark === undefined ? null : <Mark state={mark} />}
          <span className="truncate">{line}</span>
        </span>
      </span>
    </>
  );
  if (onOpen === undefined) {
    return (
      <li className="flex items-center gap-3 border-t px-5 py-3">{body}</li>
    );
  }
  return (
    <li className="border-t">
      <button
        className="hover:bg-accent focus-visible:bg-accent flex w-full items-center gap-3 px-5 py-3 text-left outline-none"
        onClick={onOpen}
        type="button"
      >
        {body}
        <ChevronRightIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 flex-none"
        />
      </button>
    </li>
  );
};

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

/** A workflow people may start by asking him. */
export interface AskableWorkflow {
  id: string;
  name: string;
}

/** One place, opened beside the page: on or off there, who reaches him there, whether he acts there. */
const PlacePanel = ({
  place,
  reach,
  can,
  change,
}: {
  place: StephenReach["places"][number];
  reach: StephenReach;
  can: boolean;
  change: Change;
}) => {
  const { t } = useLingui();
  const name = placeName(place.place);
  const on = place.audience.who !== "nobody";
  return (
    <>
      <SheetHeader className="mr-8">
        <SheetTitle>{name}</SheetTitle>
        <SheetDescription>{on ? t`On` : t`Off`}</SheetDescription>
      </SheetHeader>
      <ul>
        <Row
          description={t`Off, he answers nobody here. A place only ever narrows who he reaches.`}
          name={t`On in ${name}`}
        >
          <Switch
            aria-label={t`On in ${name}`}
            checked={on}
            disabled={!can}
            onCheckedChange={(next) => {
              void change(async (session) => {
                await session.connections.setStephenPlace(
                  place.place,
                  next ? { who: "asStephen" } : { who: "nobody" },
                  place.acts
                );
              });
            }}
          />
        </Row>
        <Row name={t`Who reaches him here`}>
          <AudienceControl
            editable={can}
            key={JSON.stringify(place.audience)}
            label={t`Who reaches him in ${name}`}
            offers={["same", "teams", "nobody"]}
            same={t`As for Stephen`}
            teams={reach.teams}
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
        </Row>
        <Row
          description={t`Off, he only answers here: he holds no change for people to confirm.`}
          name={t`Does things for people here`}
        >
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
        </Row>
      </ul>
    </>
  );
};

/** One app as a pack, opened beside the page: for whom each class of its tools is on. */
const AppPanel = ({
  app,
  reach,
  can,
  change,
}: {
  app: StephenReach["apps"][number];
  reach: StephenReach;
  can: boolean;
  change: Change;
}) => {
  const { t, i18n } = useLingui();
  const appName = appNames[app.app] ?? app.app;
  return (
    <>
      <SheetHeader className="mr-8">
        <SheetTitle>{appName}</SheetTitle>
        <SheetDescription>
          {t`What he may do in ${appName}, with each person's own sign-in: as for the whole company, or for fewer people.`}
        </SheetDescription>
      </SheetHeader>
      <ul>
        {app.classes.map(({ toolClass, audience }) => {
          const name = i18n._(classNames[toolClass]);
          return (
            <Row key={toolClass} name={name}>
              <AudienceControl
                editable={can}
                key={JSON.stringify(audience)}
                label={t`${name} in ${appName}`}
                offers={["same", "teams", "nobody"]}
                same={t`As for the whole company`}
                teams={reach.teams}
                value={chosenOf(audience)}
                onSave={async (chosen) => {
                  await change(async (session) => {
                    await session.connections.setAppToolClass(
                      app.app,
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
    </>
  );
};

/** What is open beside the page: a place or an app. */
type Opened = { kind: "place" | "app"; id: string } | null;

/**
 * Settings › Stephen: his card, his places, and what he may do,
 * company-wide and per app; `editable` for the company's own admins.
 */
export const StephenSettings = ({
  reach,
  classes,
  editable,
  week = null,
  workflows = null,
}: {
  reach: StephenReach;
  classes: ToolClassSetting[];
  editable: boolean;
  week?: StephenWeek | null;
  workflows?: AskableWorkflow[] | null;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [opened, setOpened] = useState<Opened>(null);
  const change: Change = async (action) => {
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
  const shownPlaces = new Set(reach.places.map(({ place }) => place));
  const toAdd = addable.filter((place) => !shownPlaces.has(place));
  const openPlace = reach.places.find(
    ({ place }) => opened?.kind === "place" && opened.id === place
  );
  const openApp = reach.apps.find(
    ({ app }) => opened?.kind === "app" && opened.id === app
  );
  const packs = new Map((week?.packs ?? []).map((each) => [each.pack, each]));
  return (
    <>
      <StephenCard
        can={can}
        onReach={async (on, audience: ToolClassAudience) => {
          await change(async (session) => {
            await session.connections.setStephenReach(on, audience);
          });
        }}
        reach={reach}
        week={week}
      />
      <ErrorText>{failure}</ErrorText>
      <SettingsSection
        description={t`Each place only narrows who reaches him there, and whether he does things for people there or only answers.`}
        title={t`Where people reach him`}
      >
        <ul>
          <OpenRow
            line={t`On · for everyone with Grasp`}
            logo={<AppLogo logo="/favicon.svg" name="Grasp" />}
            mark="known"
            name={t`Grasp's chat`}
          />
          {reach.places.map((place) => (
            <OpenRow
              key={place.place}
              line={place.audience.who === "nobody" ? t`Off` : t`On`}
              logo={<PlaceLogo place={place.place} size="default" />}
              mark={place.audience.who === "nobody" ? "waiting" : "known"}
              name={placeName(place.place)}
              onOpen={() => {
                setOpened({ kind: "place", id: place.place });
              }}
            />
          ))}
          {editable && toAdd.length > 0 ? (
            <li className="border-t">
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!can}
                  render={
                    // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the trigger gives it its words, "Add a place", as children
                    <button
                      className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent flex w-full items-center gap-3 px-5 py-3 text-left outline-none disabled:opacity-50"
                      type="button"
                    />
                  }
                >
                  <span className="flex size-9 flex-none items-center justify-center rounded-md border border-dashed">
                    <PlusIcon aria-hidden="true" className="size-4" />
                  </span>
                  <Trans>Add a place</Trans>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {toAdd.map((place) => (
                    <DropdownMenuItem
                      key={place}
                      onClick={() => {
                        void change(async (session) => {
                          await session.connections.setStephenPlace(
                            place,
                            { who: "asStephen" },
                            true
                          );
                        });
                      }}
                    >
                      <PlaceLogo place={place} />
                      {placeName(place)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ) : null}
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
                  teams={reach.teams}
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
      <SettingsSection
        description={t`What he can do in each system, as one pack, with each person's own sign-in.`}
        title={t`Apps`}
      >
        <ul>
          {reach.apps.map(({ app }) => {
            const pack = packs.get(app);
            const done = formatNumber(pack?.done ?? 0);
            const failed = formatNumber(pack?.failed ?? 0);
            const appName = appNames[app] ?? app;
            return (
              <OpenRow
                key={app}
                line={
                  pack === undefined
                    ? t`Not used in the last 30 days`
                    : t`${done} done · ${failed} failed · 30 days`
                }
                logo={<AppLogo logo={`/logos/${app}.svg`} name={appName} />}
                name={appName}
                onOpen={() => {
                  setOpened({ kind: "app", id: app });
                }}
              />
            );
          })}
        </ul>
      </SettingsSection>
      {workflows === null ? null : (
        <SettingsSection
          description={t`People can start these by asking him. A workflow's owner opens it to asking on its page.`}
          title={t`Workflows`}
        >
          {workflows.length === 0 ? (
            <div className="border-t">
              <Empty size="xs">
                <EmptyHeader>
                  <EmptyDescription>
                    <Trans>No workflow is open to asking yet.</Trans>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <ul>
              {workflows.map((workflow) => (
                <li className="border-t px-5 py-3" key={workflow.id}>
                  <Link
                    className="hover:underline"
                    params={{ workflow: workflow.id }}
                    to="/workflows/$workflow"
                  >
                    {workflow.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}
      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            setOpened(null);
          }
        }}
        open={openPlace !== undefined || openApp !== undefined}
      >
        <SheetContent
          className="overflow-y-auto"
          closeLabel={t`Close`}
          size="wide"
        >
          {openPlace === undefined ? null : (
            <PlacePanel
              can={can}
              change={change}
              place={openPlace}
              reach={reach}
            />
          )}
          {openApp === undefined ? null : (
            <AppPanel app={openApp} can={can} change={change} reach={reach} />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
};
