import { failureText } from "@grasp-os/shared/errors";
import { collectionMaxTeams } from "@grasp-os/shared/knowledge";
import type { CollectionAccess } from "@grasp-os/shared/knowledge";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import { Checkbox, CheckboxGroup } from "../grasp/checkbox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Plus } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
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
        async (session) => await session.organization.teams()
      );
      setTeams({ state: "ready", teams: listed });
    } catch (error) {
      setTeams({ state: "failed", reason: failureText(error) });
    }
  };
  return { teams, read };
};

/** The audience `value` names, if the form offers it. */
const audienceOf = (
  offered: readonly Audience[],
  value: string | null
): Audience | undefined => offered.find((one) => one === value);

/** The teams to share it with, each a checkbox; at most `collectionMaxTeams`. */
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
  if (teams.state === "loading") {
    return <Spinner aria-label={t`Reading the teams`} />;
  }
  if (teams.state === "failed") {
    return <ErrorText>{teams.reason}</ErrorText>;
  }
  if (teams.teams.length === 0) {
    return (
      <Text size="sm" tone="muted">
        {t`The organization has no teams yet.`}
      </Text>
    );
  }
  const full = chosen.length >= collectionMaxTeams;
  return (
    <Field>
      <FieldLabel>{t`Teams`}</FieldLabel>
      <CheckboxGroup
        disabled={disabled}
        onValueChange={(next) => {
          onChange(next);
        }}
        value={[...chosen]}
      >
        {teams.teams.map(({ id, name }) => (
          <Field key={id} orientation="horizontal">
            <Checkbox disabled={full && !chosen.includes(id)} value={id} />
            <FieldLabel>{name}</FieldLabel>
          </Field>
        ))}
      </CheckboxGroup>
    </Field>
  );
};

/** The form, a fresh one each time the dialog opens. */
const CollectionForm = ({ admin }: { admin: boolean }) => {
  const { t, i18n } = useLingui();
  const formId = useId();
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
    <>
      <DialogBody>
        <Form
          aria-label={t`New collection`}
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (complete && !busy) {
              void create();
            }
          }}
        >
          <Field>
            <FieldLabel>{t`Name`}</FieldLabel>
            <Input
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              disabled={busy}
              maxLength={nameMaxLength}
              onValueChange={setName}
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel>{t`When to use it`}</FieldLabel>
            <Textarea
              disabled={busy}
              maxLength={descriptionMaxLength}
              onValueChange={setDescription}
              rows={3}
              value={description}
            />
            <FieldDescription>
              {t`Agents read this before they look inside.`}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>{t`Who may read it`}</FieldLabel>
            <RadioGroup
              disabled={busy}
              onValueChange={(value) => {
                const next = audienceOf(offered, value);
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
                  <RadioGroupItem value={one} />
                  <FieldContent>
                    <FieldLabel>{i18n._(audienceLabels[one].label)}</FieldLabel>
                    <FieldDescription>
                      {i18n._(audienceLabels[one].description)}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
            {admin ? null : (
              <FieldDescription>
                {t`Only an admin makes a collection for everyone or for teams.`}
              </FieldDescription>
            )}
          </Field>
          {access === "teams" ? (
            <>
              <TeamChoices
                chosen={teamIds}
                disabled={busy}
                onChange={setTeamIds}
                teams={teams}
              />
              <Switch
                checked={sensitive}
                description={t`The model gateway treats what agents read from it as sensitive.`}
                disabled={busy}
                label={t`Sensitive`}
                onCheckedChange={(checked) => {
                  setSensitive(checked);
                }}
              />
            </>
          ) : null}
          <ErrorText>{failure}</ErrorText>
        </Form>
      </DialogBody>
      <DialogFooter>
        <DialogAction disabled={busy}>{t`Cancel`}</DialogAction>
        <Button
          disabled={!complete || busy}
          form={formId}
          size="sm"
          type="submit"
          variant="ink"
        >
          {t`Create collection`}
        </Button>
      </DialogFooter>
    </>
  );
};

/** "New collection", opening the form. */
export const NewCollection = ({ identity }: { identity: Identity }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger icon={Plus} size="sm">
        {t`New collection`}
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`New collection`}</DialogTitle>
        <DialogDescription>
          {t`A collection holds documents Grasp and its agents may read.`}
        </DialogDescription>
        {open ? <CollectionForm admin={isAdmin(identity.role)} /> : null}
      </DialogContent>
    </Dialog>
  );
};
