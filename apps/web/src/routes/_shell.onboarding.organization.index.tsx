import type {
  OrganizationTeam,
  StaffOrganization,
} from "@grasp-os/shared/onboarding-organization";
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Stat } from "@grasp-os/ui/components/stat";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  PlusIcon,
  SearchIcon,
  UserPlusIcon,
} from "lucide-react";
import { useState } from "react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  PersonDialog,
  PersonFormDialog,
  TeamFormDialog,
  useOrganizationChange,
} from "../onboarding/organization-dialogs.tsx";
import {
  PeopleDots,
  StateDot,
  WorkBar,
} from "../onboarding/organization-parts.tsx";
import {
  filterCounts,
  filterTitles,
  flagText,
  peopleFound,
  stateTitles,
  teamFilters,
  teamsShown,
  turnText,
} from "../onboarding/organization-words.ts";
import type { TeamFilter } from "../onboarding/organization-words.ts";
import { SettingsError } from "../settings/settings-parts.tsx";

// The organization as Grasp knows it (prototype
// `components/admin/org-organization.tsx`): every team as a card with
// what it does, its lead, its people as dots by where they stand, its
// work as a bar split by each piece's part of its time, and the one thing
// that stands out there. Found by a search and a filter; a card opens the
// team. The list is put right here too: a team or a person added. Reading
// it names people, so core puts each read in the audit log.

/** The most people a search lists; the rest are a number. */
const mostFound = 6;

/** One team as a card; the whole card opens it. */
const TeamCard = ({
  organization,
  team,
}: {
  organization: StaffOrganization;
  team: OrganizationTeam;
}) => {
  const { t, i18n } = useLingui();
  const { busy, failure, change } = useOrganizationChange();
  const people = organization.people.filter(({ team: of }) => of === team.id);
  const lead = people.find(({ id }) => id === team.lead);
  const count = people.length;
  const works = team.works.length;
  const nobody = team.works.filter(({ doers }) => doers.length === 0).length;
  // No lead is said where the lead stands; the foot says what else stands out.
  const flag = team.flags.find(({ kind }) => kind !== "noLead");
  const more = team.flags.filter(({ kind }) => kind !== "noLead").length - 1;
  const { name } = team;
  return (
    <li
      className={cn(
        "hover:border-foreground/25 relative flex flex-col rounded-xl border transition-colors",
        team.off ? "bg-transparent" : "bg-card"
      )}
    >
      <div className="flex flex-1 flex-col gap-3 px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* The whole card opens the team: the name is the link, stretched over the card. */}
            <Link
              aria-label={t`Open ${name}`}
              className={cn(
                "focus-visible:after:ring-ring/50 truncate rounded-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3",
                team.off && "text-muted-foreground"
              )}
              params={{ team: team.id }}
              to="/onboarding/organization/$team"
            >
              {name}
            </Link>
            {team.does === "" ? null : (
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {team.does}
              </span>
            )}
          </div>
          <span className="text-muted-foreground flex-none text-xs tabular-nums">
            {plural(count, { one: "# person", other: "# people" })}
          </span>
        </div>
        <div className="flex min-w-0 flex-col">
          <span
            className={cn(
              "truncate",
              lead === undefined &&
                (team.off ? "text-muted-foreground" : "text-status-attention")
            )}
          >
            {lead === undefined ? t`No team lead named` : lead.name}
          </span>
          <span className="text-muted-foreground text-xs">
            {lead === undefined
              ? t`Its people are each asked what they do`
              : i18n._(stateTitles[lead.state])}
          </span>
        </div>
        {count > 0 ? <PeopleDots people={people} /> : null}
        {works > 0 ? (
          <div className="mt-auto flex flex-col gap-1.5">
            <WorkBar works={team.works} />
            <span className="text-muted-foreground flex items-baseline justify-between gap-3 text-xs tabular-nums">
              <span>
                {plural(works, {
                  one: "# piece of work",
                  other: "# pieces of work",
                })}
              </span>
              {nobody > 0 ? (
                <span className="text-status-attention">
                  {plural(nobody, {
                    one: "# with nobody asked",
                    other: "# with nobody asked",
                  })}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex min-h-10 items-center justify-between gap-3 border-t px-4 py-2 text-xs">
        {team.off ? (
          <>
            <span className="text-muted-foreground">{t`Doesn't take part`}</span>
            {/* Above the stretched name, so it is its own button. */}
            <Button
              className="relative z-10"
              disabled={busy}
              onClick={() => {
                void change({ kind: "takesPart", team: team.id, takes: true });
              }}
              size="xs"
              variant="outline"
            >
              <Trans>Ask it in</Trans>
            </Button>
          </>
        ) : null}
        {!team.off && flag !== undefined ? (
          <span className="text-status-attention flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="bg-status-attention size-1.5 flex-none rounded-full"
            />
            <span className="truncate">{flagText(i18n, flag)}</span>
            {more > 0 ? (
              <span className="text-muted-foreground flex-none tabular-nums">
                +{more}
              </span>
            ) : null}
          </span>
        ) : null}
        {!team.off && flag === undefined ? (
          <span className="text-muted-foreground truncate">
            {turnText(i18n, team.turn)}
          </span>
        ) : null}
        {team.off ? null : (
          <ArrowRightIcon
            aria-hidden="true"
            className="text-muted-foreground size-3.5 flex-none"
          />
        )}
      </div>
      {failure === undefined ? null : (
        <p className="text-status-attention px-4 pb-2 text-xs" role="alert">
          {failure}
        </p>
      )}
    </li>
  );
};

/** The company as a whole: how many teams, people, leads and pieces of work. */
const Figures = ({ organization }: { organization: StaffOrganization }) => {
  const { t } = useLingui();
  const taking = organization.teams.filter(({ off }) => !off);
  const teams = organization.teams.length;
  const takingPart = taking.length;
  const people = organization.people.length;
  const talked = organization.people.filter(
    ({ state }) => state === "talked"
  ).length;
  const leads = taking.filter(({ lead }) => lead !== null).length;
  const unled = takingPart - leads;
  const works = organization.teams.reduce(
    (sum, team) => sum + team.works.length,
    0
  );
  const figures = [
    {
      key: "teams",
      value: teams,
      label: <Trans context="figure: how many teams there are">Teams</Trans>,
      sub: plural(takingPart, { one: "# takes part", other: "# take part" }),
    },
    {
      key: "people",
      value: people,
      label: <Trans context="figure: how many people there are">People</Trans>,
      sub: plural(talked, { one: "# has talked", other: "# have talked" }),
    },
    {
      key: "leads",
      value: leads,
      label: <Trans>Team leads</Trans>,
      sub: plural(unled, {
        one: "# team without a lead",
        other: "# teams without a lead",
      }),
    },
    {
      key: "works",
      value: works,
      label: <Trans>Pieces of work</Trans>,
      sub: t`As each team's lead named them`,
    },
  ];
  return (
    <div className="bg-border grid grid-cols-2 gap-px border-t sm:grid-cols-4">
      {figures.map((figure) => (
        <div
          className="bg-card flex flex-col gap-0.5 px-5 py-3"
          key={figure.key}
        >
          <span className="text-muted-foreground text-xs">{figure.label}</span>
          <Stat>{figure.value}</Stat>
          <span className="text-muted-foreground text-xs">{figure.sub}</span>
        </div>
      ))}
    </div>
  );
};

type Adding = "team" | "person" | null;

const Organization = ({
  organization,
}: {
  organization: StaffOrganization;
}) => {
  const { t, i18n } = useLingui();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TeamFilter>("all");
  const [adding, setAdding] = useState<Adding>(null);
  const [person, setPerson] = useState<string | null>(null);
  const counts = filterCounts(organization);
  const shown = teamsShown(organization, filter, search);
  const found = peopleFound(organization, search);
  const moreFound = found.length - mostFound;
  const close = () => {
    setAdding(null);
  };
  return (
    <>
      <section className="bg-card overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 py-4">
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
            <h2 className="font-medium">
              <Trans>The organization</Trans>
            </h2>
            <p className="text-muted-foreground">
              {t`The list as the company's admin shared it, team by team. Put it right here: every change goes into the log.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={organization.teams.length === 0}
              onClick={() => {
                setAdding("person");
              }}
              size="sm"
              variant="outline"
            >
              <UserPlusIcon data-icon="inline-start" />
              <Trans>Add a person</Trans>
            </Button>
            <Button
              disabled={organization.teams.length === 0}
              onClick={() => {
                setAdding("team");
              }}
              size="sm"
              variant="outline"
            >
              <PlusIcon data-icon="inline-start" />
              <Trans>Add a team</Trans>
            </Button>
          </div>
        </div>
        {organization.teams.length === 0 ? (
          <p className="text-muted-foreground border-t px-5 py-4">
            {t`Nobody is on the list yet. The company's admin shares its staff list in their onboarding.`}
          </p>
        ) : (
          <Figures organization={organization} />
        )}
      </section>

      {organization.teams.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={t`Which teams to show`}
            onValueChange={(value) => {
              const [next] = value;
              setFilter(teamFilters.find((each) => each === next) ?? "all");
            }}
            size="sm"
            spacing={0}
            value={[filter]}
            variant="outline"
          >
            {teamFilters.map((each) => (
              <ToggleGroupItem key={each} value={each}>
                {i18n._(filterTitles[each])}
                <span className="text-muted-foreground tabular-nums">
                  {counts[each]}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="w-full sm:ml-auto sm:w-64">
            <InputGroup>
              <InputGroupInput
                aria-label={t`Find a team or a person`}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder={t`Find a team or a person`}
                value={search}
              />
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
            </InputGroup>
          </div>
        </div>
      )}

      {found.length > 0 ? (
        <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
          {found.slice(0, mostFound).map((each) => {
            const team = organization.teams.find(({ id }) => id === each.team);
            return (
              <li className="border-t first:border-t-0" key={each.id}>
                <button
                  className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 px-4 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
                  onClick={() => {
                    setPerson(each.id);
                  }}
                  type="button"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{each.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {team?.name ?? ""}
                    </span>
                  </span>
                  <span className="text-muted-foreground flex flex-none items-center gap-2 text-xs">
                    <StateDot state={each.state} />
                    <span className="max-sm:hidden">
                      {i18n._(stateTitles[each.state])}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {moreFound > 0 ? (
            <li className="text-muted-foreground border-t px-4 py-2 text-xs">
              {t`And ${moreFound} more: type more of the name.`}
            </li>
          ) : null}
        </ul>
      ) : null}

      {organization.teams.length === 0 ? null : (
        <div className="@container">
          <ul className="grid gap-3 @2xl:grid-cols-2 @4xl:grid-cols-3">
            {shown.map((team) => (
              <TeamCard key={team.id} organization={organization} team={team} />
            ))}
          </ul>
          {shown.length === 0 ? (
            <p className="text-muted-foreground">
              <Trans>No team matches.</Trans>
            </p>
          ) : null}
        </div>
      )}

      <TeamFormDialog onClose={close} open={adding === "team"} />
      <PersonFormDialog
        onClose={close}
        open={adding === "person"}
        organization={organization}
      />
      <PersonDialog
        onClose={() => {
          setPerson(null);
        }}
        organization={organization}
        person={person}
      />
    </>
  );
};

const OrganizationPage = () => {
  const page = Route.useLoaderData();
  return page.state === "ready" ? (
    <Organization organization={page.data} />
  ) : (
    <NotLoadedState heading="h2" page={page} />
  );
};

export const Route = createFileRoute("/_shell/onboarding/organization/")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.organization()
    ),
  errorComponent: SettingsError,
  component: OrganizationPage,
});
