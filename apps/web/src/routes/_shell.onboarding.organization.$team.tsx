import type {
  OrganizationPerson,
  OrganizationTeam,
  StaffOrganization,
} from "@grasp-os/shared/onboarding-organization";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Switch } from "@grasp-os/ui/components/switch";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  RefreshCwIcon,
  UserPlusIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList, formatPercent } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  PersonDialog,
  PersonFormDialog,
  TeamFormDialog,
  useOrganizationChange,
} from "../onboarding/organization-dialogs.tsx";
import { StateDot, WorkBar } from "../onboarding/organization-parts.tsx";
import {
  flagHelp,
  flagText,
  stateTitles,
  turnText,
} from "../onboarding/organization-words.ts";
import { SettingsError, SettingsSection } from "../settings/settings-parts.tsx";

// One team, whole (prototype `components/admin/org-team.tsx`): who leads
// it, when its links go out, what needs a look there, everyone in it with
// what each is asked about and where they stand, and its work as its
// lead's map has it, with who does which piece. The list is put right
// here: the team's name, its lead, whether it takes part, a person added,
// and its map drawn again from what its lead agreed to.

/** Nobody leads the team. */
const noLead = "";

/** What someone in the team is asked about, in a few words. */
const askedText = (
  i18n: I18n,
  team: OrganizationTeam,
  person: OrganizationPerson
): string => {
  if (person.lead) {
    return i18n._(msg`The team's work, and who to ask`);
  }
  const work = team.works.find(({ id }) => id === person.work);
  if (work !== undefined) {
    return work.name;
  }
  return team.works.length > 0
    ? i18n._(msg`Asked which work they do`)
    : i18n._(msg`Asked about the team's work once its lead has named it`);
};

const Header = ({
  organization,
  team,
  onEdit,
}: {
  organization: StaffOrganization;
  team: OrganizationTeam;
  onEdit: () => void;
}) => {
  const { t, i18n } = useLingui();
  const id = useId();
  const { busy, failure, change } = useOrganizationChange();
  const people = organization.people.filter(({ team: of }) => of === team.id);
  const { name } = team;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          className="-ml-2"
          render={<Link to="/onboarding/organization" />}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          <Trans>All teams</Trans>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <Switch
              checked={!team.off}
              disabled={busy}
              onCheckedChange={(takes) => {
                void change({ kind: "takesPart", team: team.id, takes });
              }}
            />
            <span className={team.off ? "text-muted-foreground" : undefined}>
              {t`Takes part in the interviews`}
            </span>
          </label>
          <Button onClick={onEdit} size="sm" variant="outline">
            <PencilIcon data-icon="inline-start" />
            <Trans context="button: change a team's name and what it does">
              Change
            </Trans>
          </Button>
        </div>
      </div>
      <section className="bg-card overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4 px-5 py-4">
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
            <h2 className="type-title">{name}</h2>
            {team.does === "" ? null : (
              <p className="text-muted-foreground">{team.does}</p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="text-muted-foreground text-xs" htmlFor={id}>
              <Trans>Team lead</Trans>
            </label>
            <NativeSelect
              className="w-56 max-w-full"
              disabled={busy}
              id={id}
              onChange={(event) => {
                const person = event.target.value;
                void change({
                  kind: "lead",
                  team: team.id,
                  person: person === noLead ? null : person,
                });
              }}
              size="sm"
              value={team.lead ?? noLead}
            >
              <NativeSelectOption value={noLead}>
                {t`Nobody leads it`}
              </NativeSelectOption>
              {people.map((one) => (
                <NativeSelectOption key={one.id} value={one.id}>
                  {one.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        <p className="border-t px-5 py-3">{turnText(i18n, team.turn)}</p>
        {failure === undefined ? null : (
          <div className="border-t px-5 py-3">
            <ErrorText>{failure}</ErrorText>
          </div>
        )}
      </section>
    </>
  );
};

const Flags = ({ team }: { team: OrganizationTeam }) => {
  const { i18n } = useLingui();
  const { busy, failure, change } = useOrganizationChange();
  if (team.off || team.flags.length === 0) {
    return null;
  }
  return (
    <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
      {team.flags.map((flag) => (
        <li
          className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-5 py-3 first:border-t-0"
          key={`${flag.kind}-${"work" in flag ? flag.work : ""}`}
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-status-attention flex items-center gap-2">
              <span
                aria-hidden="true"
                className="bg-status-attention size-1.5 flex-none rounded-full"
              />
              {flagText(i18n, flag)}
            </span>
            <span className="text-muted-foreground">
              {flagHelp(i18n, flag)}
            </span>
          </span>
          {flag.kind === "noMap" && team.drawable ? (
            <Button
              disabled={busy}
              onClick={() => {
                void change({ kind: "draw", team: team.id });
              }}
              size="sm"
              variant="outline"
            >
              <RefreshCwIcon data-icon="inline-start" />
              <Trans>Draw the map again</Trans>
            </Button>
          ) : null}
        </li>
      ))}
      {failure === undefined ? null : (
        <li className="border-t px-5 py-3">
          <ErrorText>{failure}</ErrorText>
        </li>
      )}
    </ul>
  );
};

const People = ({
  organization,
  team,
  onOpen,
  onAdd,
}: {
  organization: StaffOrganization;
  team: OrganizationTeam;
  onOpen: (person: string) => void;
  onAdd: () => void;
}) => {
  const { t, i18n } = useLingui();
  const people = organization.people.filter(({ team: of }) => of === team.id);
  return (
    <SettingsSection
      action={
        <Button onClick={onAdd} size="sm" variant="outline">
          <UserPlusIcon data-icon="inline-start" />
          <Trans>Add a person</Trans>
        </Button>
      }
      description={t`By name, for Grasp only. A name opens that person.`}
      title={t({ message: "People", context: "heading: the people in a team" })}
    >
      {people.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>Nobody is in this team yet.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col">
          {people.map((person) => {
            const about = [person.title, askedText(i18n, team, person)]
              .filter((part) => part !== "")
              .join(" · ");
            const { name } = person;
            return (
              <li className="border-t" key={person.id}>
                <button
                  aria-label={t`Open ${name}`}
                  className="hover:bg-muted/50 focus-visible:ring-ring/50 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-5 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
                  onClick={() => {
                    onOpen(person.id);
                  }}
                  type="button"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{name}</span>
                      {person.lead ? (
                        <Badge variant="outline">{t`Team lead`}</Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {about}
                    </span>
                  </span>
                  <span className="text-muted-foreground flex flex-none items-center gap-2 text-xs">
                    <StateDot state={person.state} />
                    <span className="max-sm:hidden">
                      {i18n._(stateTitles[person.state])}
                    </span>
                    <ChevronRightIcon aria-hidden="true" className="size-3.5" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
};

const Work = ({
  organization,
  team,
}: {
  organization: StaffOrganization;
  team: OrganizationTeam;
}) => {
  const { t } = useLingui();
  const { busy, failure, change } = useOrganizationChange();
  const nameOf = (person: string) =>
    organization.people.find(({ id }) => id === person)?.name ?? "";
  return (
    <SettingsSection
      action={
        team.drawable ? (
          <Button
            disabled={busy}
            onClick={() => {
              void change({ kind: "draw", team: team.id });
            }}
            size="sm"
            variant="outline"
          >
            <RefreshCwIcon data-icon="inline-start" />
            <Trans>Draw again</Trans>
          </Button>
        ) : undefined
      }
      description={
        team.works.length === 0
          ? t`Its lead names the team's work in their interview: what there is, how much of it, and who does which.`
          : t`As its lead named it, with each piece's part of the team's time and who does it.`
      }
      title={t`The work it does`}
    >
      {failure === undefined ? null : (
        <div className="border-t px-5 py-3">
          <ErrorText>{failure}</ErrorText>
        </div>
      )}
      {team.works.length > 0 ? (
        <>
          <div className="px-5 pb-4">
            <WorkBar works={team.works} />
          </div>
          <ul className="flex flex-col">
            {team.works.map((work) => {
              const doers = formatList(work.doers.map(nameOf));
              return (
                <li
                  className="flex flex-col gap-1 border-t px-5 py-3"
                  key={work.id}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">{work.name}</span>
                    <span className="text-muted-foreground flex-none text-xs tabular-nums">
                      {formatPercent(work.share)}
                    </span>
                  </span>
                  <span
                    className={
                      work.doers.length === 0
                        ? "text-status-attention text-xs"
                        : "text-muted-foreground text-xs"
                    }
                  >
                    {work.doers.length === 0
                      ? t`Nobody is asked about it`
                      : t`Done by ${doers}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </SettingsSection>
  );
};

type Open = "team" | "person" | null;

const Team = ({
  organization,
  team,
}: {
  organization: StaffOrganization;
  team: OrganizationTeam;
}) => {
  const [open, setOpen] = useState<Open>(null);
  const [person, setPerson] = useState<string | null>(null);
  const close = () => {
    setOpen(null);
  };
  return (
    <>
      <Header
        onEdit={() => {
          setOpen("team");
        }}
        organization={organization}
        team={team}
      />
      <Flags team={team} />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <People
          onAdd={() => {
            setOpen("person");
          }}
          onOpen={setPerson}
          organization={organization}
          team={team}
        />
        <Work organization={organization} team={team} />
      </div>
      <TeamFormDialog onClose={close} open={open === "team"} team={team} />
      <PersonFormDialog
        onClose={close}
        open={open === "person"}
        organization={organization}
        team={team.id}
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

const TeamPage = () => {
  const page = Route.useLoaderData();
  const { team: id } = Route.useParams();
  if (page.state !== "ready") {
    return <NotLoadedState heading="h2" page={page} />;
  }
  const team = page.data.teams.find((each) => each.id === id);
  return team === undefined ? (
    <p className="text-muted-foreground">
      <Trans>
        This team is no longer on the list.{" "}
        <Link className="underline" to="/onboarding/organization">
          All teams
        </Link>
      </Trans>
    </p>
  ) : (
    <Team organization={page.data} team={team} />
  );
};

export const Route = createFileRoute("/_shell/onboarding/organization/$team")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.organization()
    ),
  errorComponent: SettingsError,
  component: TeamPage,
});
