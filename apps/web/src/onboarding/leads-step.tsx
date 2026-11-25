import type { Roster } from "@grasp-os/shared/onboarding";
import { hrPlatforms } from "@grasp-os/shared/onboarding-choices";
import type {
  HrPlatform,
  SetupChoices,
} from "@grasp-os/shared/onboarding-choices";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { Combobox } from "@grasp-os/ui/components/combobox";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGrid,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Switch } from "@grasp-os/ui/components/switch";
import { Text } from "@grasp-os/ui/components/text";
import {
  ArrowRightIcon,
  Icon,
  MicIcon,
  PlusIcon,
  SendIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { CalmStep } from "./calm-frame.tsx";
import { WaitingNote } from "./company-step.tsx";
import { ConnectorSearch } from "./connector-search.tsx";
import { ForgetTeams } from "./forget-teams.tsx";
import { HrLeads } from "./hr-leads.tsx";
import { hrLogoOf } from "./source-logos.ts";
import { Logo, useIntegrations, useSaveChoices } from "./sources-step.tsx";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { SupportLink } from "./support-link.tsx";
import { orgConfirmed, orgDraft } from "./visit.ts";

// The leads: first which HR platform the company uses, a tile each with its
// logo, as the documents step has them, pressed
// to choose it, until the admin said; then, without a staff list, that
// Grasp's staff set the teams up with them; else the organization as Stephen
// will interview it, on one card: a row a team, who leads it, chosen from
// the team's own people, and whether it takes part. What the staff list
// guessed, the admin puts right here, or takes from the HR platform
// (hr-leads.tsx) and checks.

/** Where a team's row puts its name above its controls. */
const PHONE = "@media (max-width: 40rem)";

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  rows: { margin: 0, padding: 0, listStyle: "none" },
  // A team a row: its name, who leads it, and whether it takes part; on a phone the name above the two.
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) minmax(0, 14rem) auto",
      [PHONE]: "minmax(0, 1fr) auto",
    },
    alignItems: "center",
    columnGap: space[4],
    rowGap: space[2],
    paddingBlock: space[3],
    paddingInline: space[4],
    borderBlockStartWidth: { default: size.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  name: { gridColumn: { default: "auto", [PHONE]: "1 / -1" } },
});

/** The HR platform: one named, which Grasp sets up with them; another asked for by name; or none. */
const HrPlatformChoice = ({
  choices,
  named,
  onDone,
}: {
  choices: SetupChoices;
  /** The HR platform Grasp's kickoff call named, if any: offered first, marked as said there. */
  named: string | null;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const { save, busy, failure } = useSaveChoices();
  const integrations = useIntegrations();
  const [searching, setSearching] = useState(false);
  // A platform picked is said and done: the step goes straight on, no screen to confirm it (Ruben).
  const choose = async (next: SetupChoices["hr"]) => {
    if (!busy && (await save({ ...choices, hr: next }))) {
      onDone();
    }
  };
  // Six tiles with the + one: the platform the kickoff named first, then those offered, the last
  // giving way when the one named is none of them.
  const namedOffered = hrPlatforms.find((each) => each === named);
  const tiles: { name: string; platform: HrPlatform | null }[] = [
    ...(named === null
      ? []
      : [{ name: named, platform: namedOffered ?? null }]),
    ...hrPlatforms
      .filter((each) => each !== named)
      .map((each) => ({ name: each, platform: each })),
  ].slice(0, hrPlatforms.length);
  return (
    <CalmStep
      body={t`It knows who leads which team, so I can talk to the leads first. We connect it with you.`}
      end={
        <Button
          onClick={() => {
            void (async () => {
              if (await save({ ...choices, hr: { kind: "none" } })) {
                onDone();
              }
            })();
          }}
          size="lg"
          variant="outline"
        >
          {t`We don’t use an HR platform`}
        </Button>
      }
      also={
        <SupportLink page="hr">{t`More about this connection`}</SupportLink>
      }
      spoken={t`Now, about the people I’ll be talking to. I like to start with the team leads, so they hear from me before their team does. Your HR platform knows who leads which team, so tell me which one you use, and we’ll connect it together.`}
      title={t`Which HR platform do you use?`}
    >
      <div {...stylex.props(styles.stack)}>
        <ItemGrid aria-label={t`HR platforms`} columns={3}>
          {tiles.map(({ name, platform }) => {
            const logo = hrLogoOf(name);
            const said = name === named;
            return (
              <Item
                done={said}
                key={name}
                onClick={() => {
                  void choose(
                    platform === null
                      ? { kind: "asked", name }
                      : { kind: "platform", name: platform }
                  );
                }}
                variant="outline"
              >
                {logo === null ? (
                  <ItemMedia variant="icon">
                    <Icon icon={UsersIcon} />
                  </ItemMedia>
                ) : (
                  <Logo src={logo} />
                )}
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                  {said ? (
                    <ItemDescription>{t`From our call`}</ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            );
          })}
          <Item
            onClick={() => {
              setSearching(true);
            }}
            variant="outline"
          >
            <ItemMedia variant="icon">
              <Icon icon={PlusIcon} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t`Another platform`}</ItemTitle>
            </ItemContent>
          </Item>
        </ItemGrid>
        <ErrorText>{failure}</ErrorText>
      </div>
      {/* The catalog's HR apps; one offered as a row is chosen as that platform, any other asked for. */}
      <ConnectorSearch
        integrations={integrations.filter(({ group }) => group === "HR")}
        onAsk={async (name) => {
          await choose({ kind: "asked", name });
        }}
        onOpenChange={setSearching}
        onPick={async ({ name }) => {
          const offered = hrPlatforms.find(
            (each) => each.toLocaleLowerCase() === name.toLocaleLowerCase()
          );
          await choose(
            offered === undefined
              ? { kind: "asked", name }
              : { kind: "platform", name: offered }
          );
        }}
        open={searching}
        placeholder={t`Search HR platforms, for example Workday`}
      />
    </CalmStep>
  );
};

/**
 * The organization on one card: every team, who leads it, and whether it
 * takes part. A team that is off gets no links.
 */
const ConfirmOrg = ({
  data,
  onward,
  roster,
}: StepProps & { roster: Roster }) => {
  const { t } = useLingui();
  const { run, busy, failure } = useCoreAction();
  const refresh = useRefresh();
  // Confirmed, it stays busy until every step reads what core now has, so it can't be pressed twice.
  const [refreshing, setRefreshing] = useState(false);
  const from = JSON.stringify(roster);
  // Changed and not confirmed yet, it is as they left it.
  const [draft, setDraft] = useState<Roster>(() => orgDraft.of(from) ?? roster);
  const redraft = (next: Roster) => {
    orgDraft.keep(from, next);
    setDraft(next);
  };
  // Confirmed as it stands: on this visit, or before on this page with nothing changed since.
  const [saved, setSaved] = useState(
    () => orgDraft.of(from) === undefined && orgConfirmed.of(from) === true
  );
  const [said, setSaid] = useState<string | null>(null);
  const teams = draft.teams
    .map((team) => ({
      team,
      people: draft.people.filter((person) => person.team === team.id),
    }))
    .toSorted((a, b) => b.people.length - a.people.length);
  const leads = draft.teams.filter(
    (team) => !team.off && team.lead !== null
  ).length;
  const missing = draft.teams.filter(
    (team) => !team.off && team.lead === null
  ).length;
  const change = (id: string, next: Partial<Roster["teams"][number]>) => {
    setSaved(false);
    setSaid(null);
    redraft({
      ...draft,
      teams: draft.teams.map((team) =>
        team.id === id ? { ...team, ...next } : team
      ),
    });
  };
  const confirm = async () => {
    if (busy || refreshing) {
      return;
    }
    const kept = await run(
      async (session) => await session.onboarding.confirmRoster(draft)
    );
    if (kept !== undefined) {
      // Coming back while it stands as confirmed, it still is.
      orgConfirmed.keep(JSON.stringify(kept.roster), true);
      setRefreshing(true);
      await refresh();
      setRefreshing(false);
      setSaved(true);
      setSaid(
        plural(leads, {
          one: "Thank you. I’ll start with this lead.",
          other: "Thank you. I’ll start with these # leads.",
        })
      );
    }
  };
  return (
    <CalmStep
      also={
        <ForgetTeams onErased={refresh} teamsInBrain={data.view.teamsInBrain} />
      }
      body={t`I talk to each team lead first, so they hear about me before their team does. Check who leads which team, and which teams take part.`}
      end={
        saved ? (
          <Button
            onClick={() => {
              void onward();
            }}
            size="lg"
          >
            {t`Continue`}
            <Icon icon={ArrowRightIcon} />
          </Button>
        ) : (
          <Button
            onClick={() => {
              void confirm();
            }}
            size="lg"
            status={busy || refreshing ? "loading" : "idle"}
          >
            {t`This is right`}
          </Button>
        )
      }
      spoken={t`This is how I understand your organization. I’ll talk to each team lead first, so nobody is caught off guard. Have a quick look whether the right people lead the right teams, and which teams should take part.`}
      title={t`Is this your organization?`}
    >
      <div {...stylex.props(styles.stack)}>
        <Card padding="none">
          <ul aria-label={t`Your teams`} {...stylex.props(styles.rows)}>
            {teams.map(({ team, people }) => {
              const { name } = team;
              const options = people.map((person) => ({
                value: person.id,
                // Someone erased stays in their team, without a name.
                label: person.name === "" ? t`Erased` : person.name,
              }));
              return (
                <li key={team.id} {...stylex.props(styles.row)}>
                  <Text style={styles.name}>{name}</Text>
                  <Combobox
                    aria-label={t`Lead of ${name}`}
                    disabled={team.off}
                    items={options}
                    onValueChange={(value) => {
                      change(team.id, {
                        lead: value === null || value === "" ? null : value,
                      });
                    }}
                    placeholder={t`Who leads it?`}
                    value={team.lead}
                  />
                  <Switch
                    aria-label={t`${name} takes part`}
                    checked={!team.off}
                    onCheckedChange={(on: boolean) => {
                      change(team.id, { off: !on });
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
        {missing > 0 ? (
          <Text>
            {t`A team without a lead gets its links on the first day, and I ask each person what they do.`}
          </Text>
        ) : null}
        {said === null ? null : (
          <output aria-live="polite">
            <Text as="span">{said}</Text>
          </output>
        )}
        <WaitingNote waiting={data.view.waiting} />
        <ErrorText>{failure}</ErrorText>
        <HrLeads
          hr={data.hr}
          onRoster={(next) => {
            setSaved(false);
            redraft(next);
          }}
          onSaid={setSaid}
          roster={draft}
        />
      </div>
    </CalmStep>
  );
};

export const LeadsStep = (props: StepProps) => {
  const { t } = useLingui();
  const { roster } = props.data.view;
  // The HR platform comes first, until the admin said which; then, on this visit, the organization.
  const [hrSaid, setHrSaid] = useState(props.data.choices.hr !== null);
  if (!hrSaid) {
    return (
      <HrPlatformChoice
        choices={props.data.choices}
        named={props.data.view.context.hr}
        onDone={() => {
          setHrSaid(true);
        }}
      />
    );
  }
  // No staff list: the company step was skipped, and Grasp's staff go through the teams with the
  // admin in their conversations. Nothing to check here yet; a list shared after all brings the rows.
  if (roster === null) {
    return (
      <CalmStep
        body={t`Without a staff list I don’t know your teams yet. That’s fine, this is how it goes:`}
        end={
          <>
            <Button
              onClick={() => {
                void props.onward();
              }}
              size="lg"
            >
              {t`Continue`}
              <Icon icon={ArrowRightIcon} />
            </Button>
            <Button
              onClick={() => {
                props.go("company");
              }}
              size="lg"
              variant="outline"
            >
              {t`Share a staff list`}
            </Button>
          </>
        }
        spoken={t`Since I don’t have a staff list yet, I don’t know your teams. That’s perfectly fine. Here’s how we’ll do it instead.`}
        title={t`We’ll set up your teams together`}
      >
        {/* What happens without a list, so the step isn't left empty under its line. */}
        <ItemGroup aria-label={t`What happens next`}>
          {[
            {
              icon: UsersIcon,
              said: t`Grasp’s team goes through your teams with you`,
            },
            { icon: MicIcon, said: t`I talk to each team lead first` },
            { icon: SendIcon, said: t`Then everyone gets their link` },
          ].map(({ icon, said }) => (
            <Item key={said} variant="outline">
              <ItemMedia variant="icon">
                <Icon icon={icon} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{said}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </CalmStep>
    );
  }
  return <ConfirmOrg {...props} roster={roster} />;
};
