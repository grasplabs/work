import { rememberTextMaxLength } from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
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
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { UsersIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { keyOf, recordOf } from "./memory-parts.tsx";

// Sharing one of the person's own records with a team they are in, or,
// for an admin of the organization, with the company (`memoriesPublish`):
// a new record in that scope, accepted, which rests on theirs. They may
// reword it first: what is shared is what the form says. Core decides who
// may publish where, and refuses one resting on what the scope's whole
// audience may not read; the form offers only the scopes it would take.
// Sharing into a chat waits for a way to list the shared chats a person is
// in.

type Knowledge = Session["knowledge"];
type Shown = Awaited<ReturnType<Knowledge["memoriesLineage"]>>["record"];

/** Where a record can be shared: a team, by its ID, or the company. */
type Target = { scope: "team"; teamId: string } | { scope: "company" };

const targetKey = (target: Target): string =>
  target.scope === "company" ? "company" : `team:${target.teamId}`;

/** Where the person may share a record, as core would take it. */
export const shareTargets = (
  teams: readonly { id: string }[],
  admin: boolean
): Target[] => [
  ...teams.map(({ id }): Target => ({ scope: "team", teamId: id })),
  ...(admin ? [{ scope: "company" } as const] : []),
];

const ShareForm = ({
  record,
  teams,
  admin,
  onShared,
}: {
  record: Shown;
  teams: readonly { id: string; name: string }[];
  admin: boolean;
  onShared: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
  const targets = shareTargets(teams, admin);
  const [chosen, setChosen] = useState(
    targets[0] === undefined ? "" : targetKey(targets[0])
  );
  const [text, setText] = useState(record.statement);
  const idempotencyKey = useRef<string>(null);
  const target = targets.find((one) => targetKey(one) === chosen);
  const ready = target !== undefined && text.trim() !== "";
  const teamName = (teamId: string): string =>
    teams.find(({ id }) => id === teamId)?.name ?? teamId;

  const share = async (to: Target): Promise<void> => {
    const receipt = await run(
      async (session) =>
        await session.knowledge.memoriesPublish(
          {
            ...(to.scope === "company"
              ? { scope: "company" }
              : { scope: "team", scopeId: to.teamId }),
            kind: record.kind,
            text: text.trim(),
            // It rests on the person's own record, at the revision shared.
            sourceRefs: [
              {
                kind: "memory",
                memoryId: record.id,
                revision: record.revision,
              },
            ],
          },
          { idempotencyKey: keyOf(idempotencyKey) }
        )
    );
    if (receipt !== undefined) {
      onShared(recordOf(receipt));
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (target !== undefined && ready && !busy) {
          void share(target);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>Share this record</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Everyone it is shared with, and their agents, read it as accepted.
            Yours stays as it is.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <FieldSet>
        <FieldLegend variant="label">
          <Trans>Share with</Trans>
        </FieldLegend>
        <RadioGroup disabled={busy} onValueChange={setChosen} value={chosen}>
          {targets.map((one) => {
            const key = targetKey(one);
            return (
              <Field key={key} orientation="horizontal">
                <RadioGroupItem id={`${ids}-${key}`} value={key} />
                <FieldLabel htmlFor={`${ids}-${key}`}>
                  {one.scope === "company"
                    ? t`The whole company`
                    : teamName(one.teamId)}
                </FieldLabel>
              </Field>
            );
          })}
        </RadioGroup>
      </FieldSet>
      <Field>
        <FieldLabel htmlFor={`${ids}-text`}>
          <Trans>What it says</Trans>
        </FieldLabel>
        <Textarea
          disabled={busy}
          id={`${ids}-text`}
          maxLength={rememberTextMaxLength}
          onChange={(event) => {
            setText(event.target.value);
          }}
          rows={4}
          value={text}
        />
        <FieldDescription>
          <Trans>
            Reword it for them if you like. It can&apos;t rest on documents they
            may not read.
          </Trans>
        </FieldDescription>
      </Field>
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={!ready || busy} type="submit">
          <Trans>Share it</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/**
 * "Share it" for one of the person's own records, opening the form;
 * `onShared` gets the shared record.
 */
export const ShareRecord = ({
  record,
  teams,
  admin,
  onShared,
}: {
  record: Shown;
  teams: readonly { id: string; name: string }[];
  admin: boolean;
  onShared: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <div>
        <DialogTrigger render={<Button variant="outline" />}>
          <UsersIcon data-icon="inline-start" />
          <Trans>Share it</Trans>
        </DialogTrigger>
      </div>
      <DialogContent closeLabel={t`Close`}>
        {open ? (
          <ShareForm
            admin={admin}
            onShared={(memoryId) => {
              setOpen(false);
              onShared(memoryId);
            }}
            record={record}
            teams={teams}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
