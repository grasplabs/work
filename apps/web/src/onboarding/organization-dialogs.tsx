import type {
  OrganizationChangeInput,
  OrganizationPerson,
  StaffOrganization,
} from "@grasp-os/shared/onboarding-organization";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { PencilIcon, SendIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { stateTitles } from "./organization-words.ts";

// Putting the organization's list right (prototype
// `components/admin/structure-dialogs.tsx` and `person-dialog.tsx`): a
// team added or changed, someone added, changed or moved, or taken off,
// and one person with where they stand, what Stephen asks them about,
// their link sent now, and away or back. Every change is one call to core,
// in the log as the staff member who made it; the page reads again after.

/** No piece of work picked: Stephen asks which work they do. */
const noWork = "";

/** Makes one change to the organization, then reads the page again. */
export const useOrganizationChange = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const change = async (made: OrganizationChangeInput): Promise<boolean> => {
    const done = await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.onboardingStaff.changeOrganization(made);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return true;
    });
    return done === true;
  };
  return { busy, failure, change };
};

/** A dialog that is only there while open, so each opening starts afresh. */
const Shell = ({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className="max-h-svh overflow-y-auto sm:max-w-md"
        closeLabel={t`Close`}
      >
        {open ? children : null}
      </DialogContent>
    </Dialog>
  );
};

const TeamForm = ({
  team,
  onClose,
}: {
  team?: { id: string; name: string; does: string };
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const id = useId();
  const { busy, failure, change } = useOrganizationChange();
  const [name, setName] = useState(team?.name ?? "");
  const [does, setDoes] = useState(team?.does ?? "");
  const save = async () => {
    const done = await change(
      team === undefined
        ? { kind: "addTeam", name, does }
        : { kind: "editTeam", team: team.id, name, does }
    );
    if (done) {
      onClose();
    }
  };
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="flex flex-col gap-1">
        <DialogTitle>
          {team === undefined ? t`Add a team` : t`Change this team`}
        </DialogTitle>
        <DialogDescription>
          {team === undefined
            ? t`It takes part from the start. Add its people next and pick its lead: the lead talks first.`
            : t`Its name, and what it does. Its lead says what it does in more words, in their interview.`}
        </DialogDescription>
      </header>
      <div className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>
            <Trans context="field: the name of a team">Name</Trans>
          </FieldLabel>
          <Input
            id={`${id}-name`}
            maxLength={80}
            onChange={(event) => {
              setName(event.target.value);
            }}
            value={name}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-does`}>
            <Trans>What it does, in a few words</Trans>
          </FieldLabel>
          <Input
            id={`${id}-does`}
            maxLength={200}
            onChange={(event) => {
              setDoes(event.target.value);
            }}
            placeholder={t`For example: answers customers' questions`}
            value={does}
          />
        </Field>
      </div>
      <ErrorText>{failure}</ErrorText>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || name.trim() === ""} type="submit">
          {team === undefined ? (
            <Trans>Add the team</Trans>
          ) : (
            <Trans context="button: save a team's or a person's details">
              Save
            </Trans>
          )}
        </Button>
        <Button onClick={onClose} type="button" variant="outline">
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
};

/** A team added to the list, or one changed: its name and what it does. */
export const TeamFormDialog = ({
  open,
  team,
  onClose,
}: {
  open: boolean;
  team?: { id: string; name: string; does: string };
  onClose: () => void;
}) => (
  <Shell onClose={onClose} open={open}>
    <TeamForm onClose={onClose} team={team} />
  </Shell>
);

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const spaces = /\s+/u;

/** Someone's first name, as a sentence calls them. */
const firstOf = (name: string): string => name.trim().split(spaces)[0] ?? "";

interface PersonFields {
  name: string;
  email: string;
  title: string;
  team: string;
}

/** Someone's name, email, job and team, as the form edits them. */
const PersonInputs = ({
  organization,
  fields,
  onChange,
}: {
  organization: StaffOrganization;
  fields: PersonFields;
  onChange: (fields: PersonFields) => void;
}) => {
  const id = useId();
  return (
    <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>
          <Trans context="field: someone's full name">Name</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          id={`${id}-name`}
          maxLength={80}
          onChange={(event) => {
            onChange({ ...fields, name: event.target.value });
          }}
          value={fields.name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-email`}>
          <Trans>Email</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          id={`${id}-email`}
          maxLength={120}
          onChange={(event) => {
            onChange({ ...fields, email: event.target.value });
          }}
          type="email"
          value={fields.email}
        />
        <FieldDescription>
          <Trans>To send them their link. It can stay empty.</Trans>
        </FieldDescription>
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-title`}>
            <Trans>Job</Trans>
          </FieldLabel>
          <Input
            autoComplete="off"
            id={`${id}-title`}
            maxLength={80}
            onChange={(event) => {
              onChange({ ...fields, title: event.target.value });
            }}
            value={fields.title}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-team`}>
            <Trans context="field: the team someone is in">Team</Trans>
          </FieldLabel>
          <NativeSelect
            className="w-full"
            id={`${id}-team`}
            onChange={(event) => {
              onChange({ ...fields, team: event.target.value });
            }}
            value={fields.team}
          >
            {organization.teams.map((each) => (
              <NativeSelectOption key={each.id} value={each.id}>
                {each.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
    </div>
  );
};

/** Takes someone off the list, once asked again. */
const TakeOff = ({
  person,
  onDone,
}: {
  person: OrganizationPerson;
  onDone: () => void;
}) => {
  const { busy, failure, change } = useOrganizationChange();
  const [sure, setSure] = useState(false);
  const remove = async () => {
    if (!sure) {
      setSure(true);
      return;
    }
    if (await change({ kind: "removePerson", person: person.id })) {
      onDone();
    }
  };
  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        disabled={busy}
        onClick={() => {
          void remove();
        }}
        type="button"
        variant={sure ? "destructive" : "ghost"}
      >
        {sure ? (
          <Trans>Yes, take them off the list</Trans>
        ) : (
          <Trans>Take off the list</Trans>
        )}
      </Button>
      {sure ? (
        <p className="text-muted-foreground text-xs">
          <Trans>
            Their link stops working, and what they said goes with them.
          </Trans>
        </p>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** What the form starts from: someone's details, or a new person's in `team`. */
const fieldsOf = (
  organization: StaffOrganization,
  person: OrganizationPerson | undefined,
  team: string | undefined
): PersonFields =>
  person === undefined
    ? {
        name: "",
        email: "",
        title: "",
        team: team ?? organization.teams[0]?.id ?? "",
      }
    : {
        name: person.name,
        email: person.email,
        title: person.title,
        team: person.team,
      };

const PersonFormHeader = ({
  adding,
  first,
}: {
  adding: boolean;
  first: string;
}) => {
  const { t } = useLingui();
  return (
    <header className="flex flex-col gap-1">
      <DialogTitle>
        {adding ? t`Add a person` : t`Change ${first}'s details`}
      </DialogTitle>
      <DialogDescription>
        {adding
          ? t`They get a link of their own when their team's links are due.`
          : t`As the company's list should have them. Their link stays the same.`}
      </DialogDescription>
    </header>
  );
};

const PersonForm = ({
  organization,
  person,
  team,
  onClose,
}: {
  organization: StaffOrganization;
  person?: OrganizationPerson;
  team?: string;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const saveLabel = t({
    message: "Save",
    context: "button: save a team's or a person's details",
  });
  const { busy, failure, change } = useOrganizationChange();
  const [fields, setFields] = useState(() =>
    fieldsOf(organization, person, team)
  );
  const email = fields.email.trim();
  const ready =
    fields.name.trim() !== "" &&
    fields.team !== "" &&
    (email === "" || emailPattern.test(email));
  const off =
    organization.teams.find(({ id }) => id === fields.team)?.off === true;
  const moved = person !== undefined && fields.team !== person.team;
  const first = firstOf(person?.name ?? fields.name);
  const save = async () => {
    const made = { ...fields, email };
    const done = await change(
      person === undefined
        ? { kind: "addPerson", ...made }
        : { kind: "editPerson", person: person.id, ...made }
    );
    if (done) {
      onClose();
    }
  };
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <PersonFormHeader first={first} adding={person === undefined} />
      <PersonInputs
        fields={fields}
        onChange={setFields}
        organization={organization}
      />
      {off ? (
        <p className="text-muted-foreground">
          {t`This team doesn't take part: nobody in it gets a link until it is asked in.`}
        </p>
      ) : null}
      {moved ? (
        <p className="text-muted-foreground">
          {t`In another team, ${first} is asked about that team's work from now on. What they already said stays with the work it was about.`}
        </p>
      ) : null}
      <ErrorText>{failure}</ErrorText>
      <div className="flex flex-wrap items-start gap-2">
        <Button disabled={busy || !ready} type="submit">
          {person === undefined ? t`Add the person` : saveLabel}
        </Button>
        <Button onClick={onClose} type="button" variant="outline">
          <Trans>Cancel</Trans>
        </Button>
        {person === undefined ? null : (
          <div className="ml-auto">
            <TakeOff onDone={onClose} person={person} />
          </div>
        )}
      </div>
    </form>
  );
};

/**
 * Someone added to the list, or their details changed: name, email, job
 * and team. Moved to another team, they are asked about its work.
 */
export const PersonFormDialog = ({
  open,
  organization,
  person,
  team,
  onClose,
}: {
  open: boolean;
  organization: StaffOrganization;
  person?: OrganizationPerson;
  team?: string;
  onClose: () => void;
}) => (
  <Shell onClose={onClose} open={open}>
    <PersonForm
      onClose={onClose}
      organization={organization}
      person={person}
      team={team}
    />
  </Shell>
);

/** What Stephen asks someone about: a piece of their team's map, or which they do. */
const AskedAbout = ({
  organization,
  person,
}: {
  organization: StaffOrganization;
  person: OrganizationPerson;
}) => {
  const { t } = useLingui();
  const id = useId();
  const { busy, failure, change } = useOrganizationChange();
  const works =
    organization.teams.find(({ id: of }) => of === person.team)?.works ?? [];
  if (works.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <label className="font-medium" htmlFor={id}>
        <Trans>What Stephen asks about</Trans>
      </label>
      <NativeSelect
        className="w-full"
        disabled={busy}
        id={id}
        onChange={(event) => {
          const work = event.target.value;
          void change({
            kind: "askAbout",
            person: person.id,
            work: work === noWork ? null : work,
          });
        }}
        value={person.work ?? noWork}
      >
        {works.map((work) => (
          <NativeSelectOption key={work.id} value={work.id}>
            {work.name}
          </NativeSelectOption>
        ))}
        <NativeSelectOption value={noWork}>
          {t`The work they do most, as they say`}
        </NativeSelectOption>
      </NativeSelect>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

const PersonView = ({
  organization,
  person,
  onEdit,
  onClose,
}: {
  organization: StaffOrganization;
  person: OrganizationPerson;
  onEdit: () => void;
  onClose: () => void;
}) => {
  const { t, i18n } = useLingui();
  const { busy, failure, change } = useOrganizationChange();
  const team = organization.teams.find(({ id }) => id === person.team);
  const work = team?.works.find(({ id }) => id === person.work);
  const first = firstOf(person.name);
  const about = [
    team?.name ?? "",
    person.lead ? t`Team lead` : "",
    person.title,
    work?.name ?? "",
  ].filter((part) => part !== "");
  const mayBeAway = person.state !== "talked" && person.state !== "out";
  const maySend =
    person.state === "waiting" && organization.open && team?.off === false;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <DialogTitle>{person.name}</DialogTitle>
        <DialogDescription>{about.join(" · ")}</DialogDescription>
        {person.email === "" ? null : (
          <span className="text-muted-foreground">{person.email}</span>
        )}
      </header>
      <p>
        {person.state === "away"
          ? t`Away these weeks. Nothing waits for ${first}.`
          : i18n._(stateTitles[person.state])}
      </p>
      {person.lead ? null : (
        <AskedAbout organization={organization} person={person} />
      )}
      <ErrorText>{failure}</ErrorText>
      <div className="flex flex-wrap items-center gap-2">
        {maySend ? (
          <Button
            disabled={busy}
            onClick={() => {
              void change({ kind: "send", person: person.id });
            }}
            variant="outline"
          >
            <SendIcon data-icon="inline-start" />
            <Trans>Send the link now</Trans>
          </Button>
        ) : null}
        {mayBeAway ? (
          <Button
            disabled={busy}
            onClick={() => {
              void change({
                kind: "away",
                person: person.id,
                away: !person.away,
              });
            }}
            variant="outline"
          >
            {person.away ? t`They're back` : t`Away these weeks`}
          </Button>
        ) : null}
        <Button onClick={onEdit} variant="outline">
          <PencilIcon data-icon="inline-start" />
          <Trans context="button: change someone's name, email, job or team">
            Change details
          </Trans>
        </Button>
        <Button onClick={onClose} variant="ghost">
          <Trans context="button: close a dialog">Close</Trans>
        </Button>
      </div>
    </div>
  );
};

/**
 * One person: where they stand, what Stephen asks them about, and what
 * Grasp can do for them; their details to change from here.
 */
export const PersonDialog = ({
  organization,
  person,
  onClose,
}: {
  organization: StaffOrganization;
  /** Whose, by id; null while closed. */
  person: string | null;
  onClose: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const found = organization.people.find(({ id }) => id === person);
  const close = () => {
    setEditing(false);
    onClose();
  };
  if (editing && found !== undefined) {
    return (
      <PersonFormDialog
        onClose={close}
        open
        organization={organization}
        person={found}
      />
    );
  }
  return (
    <Shell onClose={close} open={found !== undefined}>
      {found === undefined ? null : (
        <PersonView
          onClose={close}
          onEdit={() => {
            setEditing(true);
          }}
          organization={organization}
          person={found}
        />
      )}
    </Shell>
  );
};
