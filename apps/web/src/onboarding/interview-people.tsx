import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { LINK_STATES } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  LinkState,
  OrgView,
  PersonView,
} from "@grasp-os/shared/admin/onboarding-admin";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  CheckIcon,
  CopyIcon,
  LinkIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";
import {
  askedAboutText,
  besideText,
  lastText,
  linkTitles,
  stateText,
} from "./interview-words.ts";
import { useInterviewAction } from "./use-interview-action.ts";

// The interviews person by person (prototype `org-people.tsx` and
// `person-dialog.tsx`): everyone by name, with where their link stands,
// found by name, team and where the link stands; and one person opened:
// their link to send by hand, what Stephen asks them about, their details,
// how they rated their interview and who held it, the one reminder, and
// their interview deleted when they ask. The company never sees this
// list: it gets numbers per team.

/** What a person's link stands at, as the dot beside it. */
const dotClass = (state: LinkState): string => {
  if (state === "completed") {
    return "bg-foreground";
  }
  if (state === "progress" || state === "incomplete" || state === "opened") {
    return "bg-muted-foreground";
  }
  return "border-muted-foreground border";
};

const Dot = ({ state }: { state: LinkState }) => (
  <span
    aria-hidden="true"
    className={cn("size-2 flex-none rounded-full", dotClass(state))}
  />
);

/** One filter: its label above its control. */
const Filter = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-muted-foreground text-xs">{label}</span>
    {children}
  </label>
);

/** One fact about someone in the dialog: what it is, and what it says. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 border-t py-2">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

/**
 * Someone's own link, read from core only when staff ask for it (each read
 * is on record): to send them by hand, when it went missing or when the
 * one reminder goes.
 */
const OwnLink = ({ person, first }: { person: string; first: string }) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (link === null) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button
          disabled={busy}
          onClick={() => {
            void run(async (session) => {
              const path = await session.onboardingStaff.link(person);
              setLink(new URL(path, window.location.origin).href);
            });
          }}
          size="sm"
          variant="outline"
        >
          <LinkIcon data-icon="inline-start" />
          <Trans>Show the link</Trans>
        </Button>
        <ErrorText>{failure}</ErrorText>
      </div>
    );
  }
  const label = t`${first}'s own link`;
  return (
    <div className="flex flex-col gap-1">
      <InputGroup>
        <InputGroupInput
          aria-label={label}
          onFocus={(event) => {
            event.target.select();
          }}
          readOnly
          value={link}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={copied ? t`Copied` : t`Copy the link`}
            onClick={() => {
              void navigator.clipboard.writeText(link);
              setCopied(true);
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span className="text-muted-foreground text-xs">
        {t`Whoever has it is ${first}: send it to them only.`}
      </span>
    </div>
  );
};

/** Deletes someone's interview because they asked, once staff say so twice. */
const DeleteOnRequest = ({
  person,
  first,
  onDeleted,
}: {
  person: string;
  first: string;
  onDeleted: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, act } = useInterviewAction();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        onClick={() => {
          setAsking(true);
        }}
        variant="ghost"
      >
        <Trash2Icon data-icon="inline-start" />
        <Trans>Delete, on their request</Trans>
      </Button>
    );
  }
  return (
    <div className="flex basis-full flex-col gap-2">
      <p>{t`Delete ${first}'s interview for good, with all they said?`}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            act(async (staff) => {
              await staff.deleteInterview(person);
              onDeleted();
            });
          }}
          variant="destructive"
        >
          <Trans context="button: delete an interview for good">Delete</Trans>
        </Button>
        <Button
          onClick={() => {
            setAsking(false);
          }}
          variant="ghost"
        >
          <Trans>Keep it</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** What is known of one person: their link, what they are asked about, their details, their interview. */
const PersonFacts = ({
  each,
  kept,
  interview,
}: {
  each: PersonView;
  kept: NonNullable<AdminSnapshot["roster"]>["people"][number] | undefined;
  interview: AdminSnapshot["interviews"][number] | undefined;
}) => {
  const { t, i18n } = useLingui();
  const beside = besideText(i18n, each);
  const email = kept?.email ?? "";
  const interviewer = interview?.interviewer ?? null;
  const rating = interview?.rating ?? null;
  return (
    <dl className="flex flex-col">
      <Fact label={t`Where the link stands`}>
        {stateText(i18n, each)}
        {beside === "" ? null : (
          <span className="text-muted-foreground block text-xs">{beside}</span>
        )}
      </Fact>
      <Fact label={t`Stephen asks about`}>
        {askedAboutText(i18n, each.person.lead)}
      </Fact>
      <Fact label={t`Email`}>{email === "" ? "–" : email}</Fact>
      <Fact label={t`Held by`}>
        {interviewer === null ? "–" : interviewerNames[interviewer]}
      </Fact>
      <Fact label={t`Their rating`}>
        {rating === null ? t`Not given` : t`${rating} of 5`}
      </Fact>
    </dl>
  );
};

/** One person: their link, what they are asked about, their details and their interview. */
const Person = ({
  view,
  snapshot,
  each,
  onClose,
}: {
  view: OrgView;
  snapshot: AdminSnapshot;
  each: PersonView;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, act } = useInterviewAction();
  const { person } = each;
  const { first } = person;
  const team = view.teams.find((one) => one.team.id === person.team);
  const kept = snapshot.roster?.people.find((one) => one.id === person.id);
  const interview = snapshot.interviews.find((one) => one.person === person.id);
  const link = snapshot.links.find((one) => one.person === person.id);
  const held = view.interviews.some((one) => one.id === person.id);
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <DialogTitle>{person.name}</DialogTitle>
        <DialogDescription>
          {[
            team?.team.name ?? "",
            person.lead ? t`Team lead` : "",
            kept?.title ?? "",
          ]
            .filter((part) => part !== "")
            .join(" · ")}
        </DialogDescription>
      </header>
      <PersonFacts each={each} interview={interview} kept={kept} />
      {link === undefined || link.sentAt === null ? (
        <p className="text-muted-foreground">
          {t`No link out yet: it waits for its day, or for their team lead.`}
        </p>
      ) : (
        <OwnLink first={first} person={person.id} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {each.mayRemind ? (
          <Button
            disabled={busy}
            onClick={() => {
              act(async (staff) => {
                await staff.remind([person.id]);
              });
            }}
            variant="outline"
          >
            <BellIcon data-icon="inline-start" />
            <Trans context="button: note the one reminder as sent">
              Mark reminded
            </Trans>
          </Button>
        ) : null}
        {held ? (
          <Button
            render={
              <Link
                params={{ person: person.id }}
                to="/onboarding/interviews/$person"
              />
            }
            variant="outline"
          >
            <Trans>Read the transcript</Trans>
          </Button>
        ) : null}
        {interview === undefined ? null : (
          <DeleteOnRequest
            first={first}
            onDeleted={onClose}
            person={person.id}
          />
        )}
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

const Filters = ({
  view,
  query,
  team,
  state,
  onChange,
}: {
  view: OrgView;
  query: string;
  team: string;
  state: string;
  onChange: (change: { query?: string; team?: string; state?: string }) => void;
}) => {
  const { t, i18n } = useLingui();
  return (
    <div className="flex flex-wrap items-end gap-3 border-t px-5 py-3">
      <InputGroup className="w-56">
        <InputGroupInput
          aria-label={t`Search people`}
          onChange={(event) => {
            onChange({ query: event.target.value });
          }}
          placeholder={t`Search by name`}
          value={query}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
      <Filter label={t({ message: "Team", context: "people filter" })}>
        <NativeSelect
          onChange={(event) => {
            onChange({ team: event.target.value });
          }}
          value={team}
        >
          <NativeSelectOption value="">
            {t({ message: "Any team", context: "people filter: team" })}
          </NativeSelectOption>
          {view.teams.map((one) => (
            <NativeSelectOption key={one.team.id} value={one.team.id}>
              {one.team.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Filter>
      <Filter label={t`Where the link stands`}>
        <NativeSelect
          onChange={(event) => {
            onChange({ state: event.target.value });
          }}
          value={state}
        >
          <NativeSelectOption value="">
            {t({ message: "Anywhere", context: "people filter: link" })}
          </NativeSelectOption>
          {LINK_STATES.map((one) => (
            <NativeSelectOption key={one} value={one}>
              {i18n._(linkTitles[one])}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Filter>
    </div>
  );
};

/** One person in the list. */
const PersonRow = ({
  view,
  each,
  onOpen,
}: {
  view: OrgView;
  each: PersonView;
  onOpen: () => void;
}) => {
  const { t, i18n } = useLingui();
  const { busy, act } = useInterviewAction();
  const { name } = each.person;
  const team = view.teams.find((one) => one.team.id === each.person.team);
  const beside = besideText(i18n, each);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-t px-5 py-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,9rem)_minmax(0,8rem)]">
      <span className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <button
            aria-label={t`Open ${name}`}
            className="focus-visible:ring-ring/50 rounded-sm text-left outline-none hover:underline focus-visible:ring-3"
            onClick={onOpen}
            type="button"
          >
            {name}
          </button>
          {each.person.lead && team?.lead ? (
            <Badge variant="outline">{t`Team lead`}</Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {team?.team.name ?? ""}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <Dot state={each.state} />
        <span className="flex min-w-0 flex-col">
          <span
            className={
              each.state === "completed" ? undefined : "text-muted-foreground"
            }
          >
            {stateText(i18n, each)}
          </span>
          {beside === "" ? null : (
            <span className="text-muted-foreground hidden truncate text-xs md:block">
              {beside}
            </span>
          )}
        </span>
      </span>
      <span className="text-muted-foreground hidden min-w-0 truncate md:block">
        {lastText(i18n, view, each)}
      </span>
      <span className="hidden flex-wrap items-center justify-end gap-1 md:flex">
        {each.mayRemind ? (
          <Button
            aria-label={t`Note the reminder for ${name}`}
            disabled={busy}
            onClick={() => {
              act(async (staff) => {
                await staff.remind([each.person.id]);
              });
            }}
            size="sm"
            variant="ghost"
          >
            <BellIcon data-icon="inline-start" />
            <Trans context="button: note the one reminder as sent">
              Mark reminded
            </Trans>
          </Button>
        ) : null}
        {view.interviews.some((one) => one.id === each.person.id) ? (
          <Button
            aria-label={t`Read the transcript of ${name}`}
            render={
              <Link
                params={{ person: each.person.id }}
                to="/onboarding/interviews/$person"
              />
            }
            size="sm"
            variant="ghost"
          >
            <Trans context="button: read a transcript">Read</Trans>
          </Button>
        ) : null}
      </span>
    </li>
  );
};

/**
 * Everyone by name, with where their link stands: what Grasp needs to
 * send links and the one reminder, and to see whom to follow up.
 */
export const InterviewPeople = ({
  view,
  snapshot,
  open,
}: {
  view: OrgView;
  snapshot: AdminSnapshot;
  /** The person whose dialog is open, from the address. */
  open: string | undefined;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/onboarding/interviews/" });
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState("");
  const [state, setState] = useState("");
  const setOpen = (person: string | undefined): void => {
    void navigate({ search: (last) => ({ ...last, person }) });
  };
  if (view.people.length === 0) {
    return (
      <SettingsSection
        description={t`Names come with the company's own list. Until it is in, nobody is known here.`}
        title={t`People`}
      >
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>No people yet.</Trans>
        </p>
      </SettingsSection>
    );
  }
  const wanted = query.trim().toLowerCase();
  const shown = view.people.filter(
    (each) =>
      (wanted === "" || each.person.name.toLowerCase().includes(wanted)) &&
      (team === "" || each.person.team === team) &&
      (state === "" || each.state === state)
  );
  const opened = view.people.find((each) => each.person.id === open);
  const count = shown.length;
  const all = view.people.length;
  return (
    <SettingsSection
      action={
        <span
          aria-live="polite"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {plural(all, {
            one: `${count} of # person`,
            other: `${count} of # people`,
          })}
        </span>
      }
      description={t`By name, for Grasp only. A name opens that person: their link, what Stephen asks them about and their interview.`}
      title={t`People`}
    >
      <Filters
        onChange={(change) => {
          setQuery(change.query ?? query);
          setTeam(change.team ?? team);
          setState(change.state ?? state);
        }}
        query={query}
        state={state}
        team={team}
        view={view}
      />
      <ul className="flex flex-col">
        {shown.map((each) => (
          <PersonRow
            each={each}
            key={each.person.id}
            onOpen={() => {
              setOpen(each.person.id);
            }}
            view={view}
          />
        ))}
      </ul>
      {shown.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>Nobody matches.</Trans>
        </p>
      ) : null}
      <Dialog
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setOpen(undefined);
          }
        }}
        open={opened !== undefined}
      >
        <DialogContent closeLabel={t`Close`}>
          {opened === undefined ? null : (
            <Person
              each={opened}
              onClose={() => {
                setOpen(undefined);
              }}
              snapshot={snapshot}
              view={view}
            />
          )}
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};
