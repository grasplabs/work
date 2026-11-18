import type {
  CompanyToolClass,
  ToolClassAudience,
  ToolClassSetting,
} from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import type { StephenWeek } from "@grasp-os/shared/stephen-requests";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatNumber } from "../format.ts";
import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Empty, EmptyDescription, EmptyHeader } from "../grasp/empty/index.ts";
import { AppPanels, Chat, Plus } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { placeIcon, placeName } from "../workflows/requests/request-parts.tsx";
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
// the next message (stephen-reach.ts, tool-classes.ts). On the library:
// each part a compact, flush Section card of rows; what a row means sits
// behind its info mark; a place or an app opens in a sheet. Every control
// saves at once and reads the page again. The company's own admins change
// it; Grasp staff only read it. The prototype's Microsoft 365 demo (its
// register, leave and expenses) stays behind.

export const classNames = {
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
const addable = ["teams", "slack"] as const;

/** Whether Grasp's library has a mark for `key`. */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);

const styles = stylex.create({
  // The fact under a row's name, after its dot.
  line: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  dot: {
    width: grasp.space2,
    height: grasp.space2,
    flexShrink: 0,
    borderRadius: grasp.cornerCircle,
    borderStyle: "solid",
    borderWidth: grasp.hairline,
    borderColor: grasp.muted,
  },
  dotOn: { backgroundColor: grasp.ink, borderColor: grasp.ink },
});

/** One setting's row: its name, what it means behind its info mark, then its control. */
export const Row = ({
  name,
  description,
  children,
}: {
  name: string;
  description?: string;
  children: ReactNode;
}) => (
  <SettingRow info={description} label={name}>
    {children}
  </SettingRow>
);

/** Whether he is on in a place, as a dot before its line, as the prototype's places have it. */
const stateDot = {
  on: [styles.dot, styles.dotOn],
  off: [styles.dot],
} as const;

/**
 * A row that opens its panel: a mark, a name, one fact, and the chevron.
 * A place's fact has a dot before it: filled where he is on there, hollow
 * where he is off. The mark is `logo`, or `icon` where Grasp has no logo.
 */
export const OpenRow = ({
  logo,
  icon,
  name,
  line,
  state,
  onOpen,
}: {
  logo?: ReactNode;
  icon?: IconData;
  name: string;
  line: string;
  state?: keyof typeof stateDot;
  onOpen?: () => void;
}) => {
  const parts = (
    <>
      {icon === undefined ? (
        <ItemMedia>{logo}</ItemMedia>
      ) : (
        <ItemMedia icon={icon} iconLook="inline" />
      )}
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>
          <span {...stylex.props(styles.line)}>
            {state === undefined ? null : (
              <span aria-hidden="true" {...stylex.props(stateDot[state])} />
            )}
            {line}
          </span>
        </ItemDescription>
      </ItemContent>
    </>
  );
  return onOpen === undefined ? (
    <Item size="sm">{parts}</Item>
  ) : (
    <Item
      render={
        // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the row's name and line are its words, as the Item's children
        <button onClick={onOpen} type="button" />
      }
      size="sm"
    >
      {parts}
    </Item>
  );
};

/** A brand's mark on a row, or nothing where Grasp has none. */
const markOf = (key: string): ReactNode =>
  isBrand(key) ? (
    <BrandIcon brand={key} decorative size="md" tile={false} />
  ) : undefined;

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
      <SheetTitle>{name}</SheetTitle>
      <SheetDescription>{on ? t`On` : t`Off`}</SheetDescription>
      <SheetBody>
        <SettingsRows>
          <Row
            description={t`Off, he answers nobody here. A place only ever narrows who he reaches.`}
            name={t`On in ${name}`}
          >
            <Switch
              checked={on}
              disabled={!can}
              label={t`On in ${name}`}
              labelHidden
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
              checked={place.acts}
              disabled={!can}
              label={t`Does things for people in ${name}`}
              labelHidden
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
        </SettingsRows>
      </SheetBody>
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
      <SheetTitle>{appName}</SheetTitle>
      <SheetDescription>
        {t`What he may do in ${appName}, with each person's own sign-in: as for the whole company, or for fewer people.`}
      </SheetDescription>
      <SheetBody>
        <SettingsRows>
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
        </SettingsRows>
      </SheetBody>
    </>
  );
};

/** What is open beside the page: a place or an app. */
type Opened = { kind: "place" | "app"; id: string } | null;

/** The places he can still be added to, in a menu at the head of their card. */
const AddPlace = ({
  places,
  disabled,
  change,
}: {
  places: readonly (typeof addable)[number][];
  disabled: boolean;
  change: Change;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      disabled={disabled}
      icon={Plus}
      size="sm"
      variant="quiet"
    >
      <Trans>Add a place</Trans>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {places.map((place) => (
        <DropdownMenuItem
          icon={placeIcon(place)}
          key={place}
          onSelect={() => {
            void change(async (session) => {
              await session.connections.setStephenPlace(
                place,
                { who: "asStephen" },
                true
              );
            });
          }}
        >
          {placeName(place)}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

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
        action={
          editable && toAdd.length > 0 ? (
            <AddPlace change={change} disabled={!can} places={toAdd} />
          ) : undefined
        }
        info={t`Each place only narrows who reaches him there, and whether he does things for people there or only answers.`}
        title={t`Where people reach him`}
      >
        <ItemGroup aria-label={t`Where people reach him`} separated>
          <OpenRow
            icon={Chat}
            line={t`On · for everyone with Grasp`}
            name={t`Grasp's chat`}
            state="on"
          />
          {reach.places.map((place) => (
            <OpenRow
              icon={isBrand(place.place) ? undefined : placeIcon(place.place)}
              key={place.place}
              line={place.audience.who === "nobody" ? t`Off` : t`On`}
              logo={markOf(place.place)}
              name={placeName(place.place)}
              onOpen={() => {
                setOpened({ kind: "place", id: place.place });
              }}
              state={place.audience.who === "nobody" ? "off" : "on"}
            />
          ))}
        </ItemGroup>
      </SettingsSection>
      <SettingsSection
        info={t`Every tool he has is of one of these kinds. Each is on for whom you choose, in every app.`}
        title={t`What he may do`}
      >
        <SettingsRows>
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
        </SettingsRows>
      </SettingsSection>
      <SettingsSection
        info={t`What he can do in each system, as one pack, with each person's own sign-in.`}
        title={t`Apps`}
      >
        <ItemGroup aria-label={t`Apps`} separated>
          {reach.apps.map(({ app }) => {
            const pack = packs.get(app);
            const done = formatNumber(pack?.done ?? 0);
            const failed = formatNumber(pack?.failed ?? 0);
            const appName = appNames[app] ?? app;
            return (
              <OpenRow
                icon={isBrand(app) ? undefined : AppPanels}
                key={app}
                line={
                  pack === undefined
                    ? t`Not used in the last 30 days`
                    : t`${done} done · ${failed} failed · 30 days`
                }
                logo={markOf(app)}
                name={appName}
                onOpen={() => {
                  setOpened({ kind: "app", id: app });
                }}
              />
            );
          })}
        </ItemGroup>
      </SettingsSection>
      {workflows === null ? null : (
        <SettingsSection
          info={t`People can start these by asking him. A workflow's owner opens it to asking on its page.`}
          title={t`Workflows`}
        >
          {workflows.length === 0 ? (
            <Empty size="section">
              <EmptyHeader>
                <EmptyDescription>
                  <Trans>No workflow is open to asking yet.</Trans>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup aria-label={t`Workflows`} separated>
              {workflows.map((workflow) => (
                <Item
                  key={workflow.id}
                  render={
                    <Link
                      params={{ workflow: workflow.id }}
                      to="/workflows/$workflow"
                    />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>{workflow.name}</ItemTitle>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
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
        size="lg"
      >
        <SheetContent closeLabel={t`Close`}>
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
