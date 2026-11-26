import { chatPlatformName as placeName } from "@grasp-os/shared/chat";
import type {
  CompanyToolClass,
  ToolClassAudience,
  ToolClassSetting,
} from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import type { StephenWeek } from "@grasp-os/shared/stephen-requests";
import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { Button } from "@grasp-os/ui/components/button";
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
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Switch } from "@grasp-os/ui/components/switch";
import {
  Icon,
  LayoutDashboardIcon,
  MessageCircleIcon,
  PlusIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { SectionCard } from "../agents/section-card.tsx";
import { SettingRow } from "../agents/setting-row.tsx";
import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatNumber } from "../format.ts";
import { brands, placeMarks } from "../frame/brands.ts";
import { useCoreAction } from "../use-core-action.ts";
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

/** The product's marks for the places and apps on this page, by their id. */
const marks: Readonly<Record<string, IconData>> = {
  ...placeMarks,
  microsoft: brands.microsoft.logo,
  google: brands.google.logo,
};

/** Whether the product has a mark for `key`. */
const isBrand = (key: string): boolean => Object.hasOwn(marks, key);

/** A place's mark as an icon, for a row that takes one: a chat's for a place Grasp has no mark for. */
const placeIcon = (place: string): IconData =>
  marks[place] ?? MessageCircleIcon;

const styles = stylex.create({
  // The fact under a row's name, after its dot.
  line: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
  },
  dot: {
    width: space["2"],
    height: space["2"],
    flexShrink: 0,
    borderRadius: radius.circle,
    borderStyle: "solid",
    borderWidth: size.hairline,
    borderColor: colors.mutedForeground,
  },
  dotOn: { backgroundColor: colors.foreground, borderColor: colors.foreground },
});

/** One setting's row: its name, what it means behind its info mark, then its control. */
const Row = ({
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
const OpenRow = ({
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
        <ItemMedia align="center">{logo}</ItemMedia>
      ) : (
        <ItemMedia variant="default">
          <Icon icon={icon} />
        </ItemMedia>
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
    <Item onClick={onOpen} size="sm">
      {parts}
    </Item>
  );
};

/** A brand's mark on a row, or nothing where Grasp has none. */
const markOf = (key: string): ReactNode => {
  const logo = marks[key];
  return logo === undefined ? undefined : (
    <BrandIcon decorative logo={logo} name={key} tile={false} />
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
      <SheetHeader>
        <SheetTitle>{name}</SheetTitle>
        <SheetDescription>{on ? t`On` : t`Off`}</SheetDescription>
      </SheetHeader>
      <SheetBody>
        <FieldGroup>
          <Row
            description={t`Off, he answers nobody here. A place only ever narrows who he reaches.`}
            name={t`On in ${name}`}
          >
            <Switch
              checked={on}
              disabled={!can}
              aria-label={t`On in ${name}`}
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
              aria-label={t`Does things for people in ${name}`}
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
        </FieldGroup>
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
      <SheetHeader>
        <SheetTitle>{appName}</SheetTitle>
        <SheetDescription>
          {t`What he may do in ${appName}, with each person's own sign-in: as for the whole company, or for fewer people.`}
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        <FieldGroup>
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
        </FieldGroup>
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
    <DropdownMenuTrigger asChild disabled={disabled}>
      <Button size="sm" variant="outline">
        <Icon icon={PlusIcon} />
        <Trans>Add a place</Trans>
      </Button>
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
      <SectionCard
        flush
        actions={
          editable && toAdd.length > 0 ? (
            <AddPlace change={change} disabled={!can} places={toAdd} />
          ) : undefined
        }
        info={t`Each place only narrows who reaches him there, and whether he does things for people there or only answers.`}
        title={t`Where people reach him`}
      >
        <ItemGroup separated aria-label={t`Where people reach him`}>
          <OpenRow
            key="grasp"
            icon={MessageCircleIcon}
            line={t`On · for everyone with Grasp`}
            name={t`Grasp's chat`}
            state="on"
          />
          {reach.places.map((place) => (
            <OpenRow
              key={place.place}
              icon={isBrand(place.place) ? undefined : placeIcon(place.place)}
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
      </SectionCard>
      <SectionCard
        flush
        info={t`Every tool he has is of one of these kinds. Each is on for whom you choose, in every app.`}
        title={t`What he may do`}
      >
        <FieldGroup controls="fit">
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
        </FieldGroup>
      </SectionCard>
      <SectionCard
        flush
        info={t`What he can do in each system, as one pack, with each person's own sign-in.`}
        title={t`Apps`}
      >
        <ItemGroup separated aria-label={t`Apps`}>
          {reach.apps.map(({ app }) => {
            const pack = packs.get(app);
            const done = formatNumber(pack?.done ?? 0);
            const failed = formatNumber(pack?.failed ?? 0);
            const appName = appNames[app] ?? app;
            return (
              <OpenRow
                key={app}
                icon={isBrand(app) ? undefined : LayoutDashboardIcon}
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
      </SectionCard>
      {workflows === null ? null : (
        <SectionCard
          flush
          info={t`People can start these by asking him. A workflow's owner opens it to asking on its page.`}
          title={t`Workflows`}
        >
          {workflows.length === 0 ? (
            <Empty size="default">
              <EmptyHeader>
                <EmptyDescription>
                  <Trans>No workflow is open to asking yet.</Trans>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup separated aria-label={t`Workflows`}>
              {workflows.map((workflow) => (
                <Item asChild key={workflow.id} size="sm">
                  <Link
                    params={{ workflow: workflow.id }}
                    to="/workflows/$workflow"
                  >
                    <ItemContent>
                      <ItemTitle>{workflow.name}</ItemTitle>
                    </ItemContent>
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          )}
        </SectionCard>
      )}
      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            setOpened(null);
          }
        }}
        open={openPlace !== undefined || openApp !== undefined}
      >
        <SheetContent size="lg">
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
