import { failureText } from "@grasp-os/shared/errors";
import { collectionMaxTeams } from "@grasp-os/shared/knowledge";
import type { CollectionAccess } from "@grasp-os/shared/knowledge";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Making a collection: its name, when to use it, and who may read it. Anyone
// makes one only they read; an admin also one for everyone, or for chosen
// teams, which may be marked sensitive. Core checks all of it again
// (collection-rules.ts); the form offers only what core would take.

/** Who may read the new collection, as the form offers it. */
type Audience = Exclude<CollectionAccess, "admins">;

const audienceLabels: Readonly<
  Record<Audience, { label: MessageDescriptor; description: MessageDescriptor }>
> = {
  me: {
    label: msg`Only me`,
    description: msg`A private collection: nobody else reads it, nor their agents.`,
  },
  teams: {
    label: msg`Chosen teams`,
    description: msg`The members of the teams you choose, and their agents.`,
  },
  everyone: {
    label: msg`Everyone`,
    description: msg`Everyone in the organization, and their agents.`,
  },
};

const nameMaxLength = 100;
const descriptionMaxLength = 1024;

interface TeamChoice {
  id: string;
  name: string;
}

/** The organization's teams to choose from, read once teams are offered. */
type Teams =
  | { state: "loading" }
  | { state: "ready"; teams: TeamChoice[] }
  | { state: "failed"; reason: string };

/**
 * The organization's teams, read the first time they are offered: a
 * failure says why, and choosing teams again reads them again.
 */
const useTeams = () => {
  const core = useCore();
  const [teams, setTeams] = useState<Teams>({ state: "loading" });
  const read = async (): Promise<void> => {
    if (teams.state === "ready") {
      return;
    }
    setTeams({ state: "loading" });
    try {
      const listed = await core.withSession(
        async (session) => await session.workflows.teams()
      );
      setTeams({ state: "ready", teams: listed });
    } catch (error) {
      setTeams({ state: "failed", reason: failureText(error) });
    }
  };
  return { teams, read };
};

/** The teams to share it with, each a checkbox. */
const TeamChoices = ({
  teams,
  chosen,
  disabled,
  onChange,
}: {
  teams: Teams;
  chosen: readonly string[];
  disabled: boolean;
  onChange: (chosen: string[]) => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  if (teams.state === "loading") {
    return <Spinner aria-label={t`Reading the teams`} />;
  }
  if (teams.state === "failed") {
    return <ErrorText>{teams.reason}</ErrorText>;
  }
  if (teams.teams.length === 0) {
    return (
      <FieldDescription>
        <Trans>The organization has no teams yet.</Trans>
      </FieldDescription>
    );
  }
  const full = chosen.length >= collectionMaxTeams;
  return (
    <FieldSet>
      <FieldLegend variant="label">
        <Trans>Teams</Trans>
      </FieldLegend>
      <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
        {teams.teams.map(({ id, name }) => {
          const checked = chosen.includes(id);
          return (
            <li key={id}>
              <Field orientation="horizontal">
                <Checkbox
                  checked={checked}
                  disabled={disabled || (full && !checked)}
                  id={`${ids}-${id}`}
                  onCheckedChange={(next) => {
                    const rest = chosen.filter((one) => one !== id);
                    onChange(next ? [...rest, id] : rest);
                  }}
                />
                <FieldLabel htmlFor={`${ids}-${id}`}>{name}</FieldLabel>
              </Field>
            </li>
          );
        })}
      </ul>
    </FieldSet>
  );
};

/** The form, a fresh one each time the dialog opens. */
const CollectionForm = ({ admin }: { admin: boolean }) => {
  const { i18n } = useLingui();
  const ids = useId();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<Audience>("me");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [sensitive, setSensitive] = useState(false);
  const { teams, read: readTeams } = useTeams();
  const offered: readonly Audience[] = admin
    ? ["me", "teams", "everyone"]
    : ["me"];
  const complete =
    name.trim() !== "" && (access !== "teams" || teamIds.length > 0);

  const create = async (): Promise<void> => {
    const made = await run(
      async (session) =>
        await session.knowledge.createCollection({
          name,
          description,
          access,
          teams: access === "teams" ? teamIds : [],
          sensitive: access === "teams" && sensitive,
        })
    );
    if (made !== undefined) {
      await navigate({
        to: "/knowledge/$collection",
        params: { collection: made.id },
        search: {},
      });
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) {
          void create();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>New collection</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            A collection holds documents Grasp and its agents may read.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`${ids}-name`}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
          id={`${ids}-name`}
          maxLength={nameMaxLength}
          onChange={(event) => {
            setName(event.target.value);
          }}
          value={name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-description`}>
          <Trans>When to use it</Trans>
        </FieldLabel>
        <Textarea
          disabled={busy}
          id={`${ids}-description`}
          maxLength={descriptionMaxLength}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
          rows={3}
          value={description}
        />
        <FieldDescription>
          <Trans>Agents read this before they look inside.</Trans>
        </FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">
          <Trans>Who may read it</Trans>
        </FieldLegend>
        <RadioGroup
          disabled={busy}
          onValueChange={(value) => {
            const next = offered.find((one) => one === value);
            if (next === undefined) {
              return;
            }
            setAccess(next);
            if (next === "teams") {
              void readTeams();
            }
          }}
          value={access}
        >
          {offered.map((one) => (
            <Field key={one} orientation="horizontal">
              <RadioGroupItem id={`${ids}-${one}`} value={one} />
              <FieldContent>
                <FieldLabel htmlFor={`${ids}-${one}`}>
                  {i18n._(audienceLabels[one].label)}
                </FieldLabel>
                <FieldDescription>
                  {i18n._(audienceLabels[one].description)}
                </FieldDescription>
              </FieldContent>
            </Field>
          ))}
        </RadioGroup>
        {admin ? null : (
          <FieldDescription>
            <Trans>
              Only an admin makes a collection for everyone or for teams.
            </Trans>
          </FieldDescription>
        )}
      </FieldSet>
      {access === "teams" ? (
        <>
          <TeamChoices
            chosen={teamIds}
            disabled={busy}
            onChange={setTeamIds}
            teams={teams}
          />
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${ids}-sensitive`}>
                <Trans>Sensitive</Trans>
              </FieldLabel>
              <FieldDescription>
                <Trans>
                  The model gateway treats what agents read from it as
                  sensitive.
                </Trans>
              </FieldDescription>
            </FieldContent>
            <Switch
              checked={sensitive}
              disabled={busy}
              id={`${ids}-sensitive`}
              onCheckedChange={setSensitive}
            />
          </Field>
        </>
      ) : null}
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={!complete || busy} type="submit">
          <Trans>Create collection</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/** "New collection", opening the form. */
export const NewCollection = ({ identity }: { identity: Identity }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon data-icon="inline-start" />
        <Trans>New collection</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        {open ? <CollectionForm admin={isAdmin(identity.role)} /> : null}
      </DialogContent>
    </Dialog>
  );
};
