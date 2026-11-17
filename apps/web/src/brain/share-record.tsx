import { failureText } from "@grasp-os/shared/errors";
import { rememberTextMaxLength } from "@grasp-os/shared/knowledge";
import type { SharedChat } from "@grasp-os/shared/knowledge";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
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
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { People } from "../grasp/icons/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { keyOf, recordOf } from "./memory-parts.tsx";

// Sharing one of the person's own records with a team they are in, a chat
// others share that they are in (`sharedChats`: only one Grasp knows
// everyone in), or, for an admin of the organization, with the company
// (`memoriesPublish`):
// a new record in that scope, accepted, which rests on theirs. They may
// reword it first: what is shared is what the form says. Core decides who
// may publish where, and refuses one resting on what the scope's whole
// audience may not read; the form offers only the scopes it would take.
// A chat is named by who else is in it: platforms give Grasp no name for
// a channel.

type Knowledge = Session["knowledge"];
type Shown = Awaited<ReturnType<Knowledge["memoriesLineage"]>>["record"];

/** Where a record can be shared: a team, a shared chat, or the company. */
type Target =
  | { scope: "team"; teamId: string }
  | { scope: "session"; chat: SharedChat }
  | { scope: "company" };

const targetKey = (target: Target): string => {
  if (target.scope === "team") {
    return `team:${target.teamId}`;
  }
  return target.scope === "session" ? `chat:${target.chat.chatId}` : "company";
};

/** Where the person may share a record, as core would take it. */
const shareTargets = (
  teams: readonly { id: string }[],
  chats: readonly SharedChat[],
  admin: boolean
): Target[] => [
  ...teams.map(({ id }): Target => ({ scope: "team", teamId: id })),
  ...chats.map((chat): Target => ({ scope: "session", chat })),
  ...(admin ? [{ scope: "company" } as const] : []),
];

/** The shared chats the person is in: read when the form opens. */
type Chats =
  | { state: "loading" }
  | { state: "ready"; chats: SharedChat[] }
  | { state: "failed"; reason: string };

const useSharedChats = (): Chats => {
  const core = useCore();
  const [chats, setChats] = useState<Chats>({ state: "loading" });
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      let next: Chats;
      try {
        next = {
          state: "ready",
          chats: await core.withSession(
            async (session) => await session.knowledge.sharedChats()
          ),
        };
      } catch (error) {
        next = { state: "failed", reason: failureText(error) };
      }
      if (!left) {
        setChats(next);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core]);
  return chats;
};

/** A shared chat, by who else is in it. */
const ChatLabel = ({ chat }: { chat: SharedChat }) => {
  const { t } = useLingui();
  if (chat.others.length === 0) {
    return t`A shared chat with only you in it`;
  }
  const people = formatList(chat.others);
  return t`A shared chat with ${people}`;
};

/** A target as `memoriesPublish` takes it. */
const scopeOf = (
  to: Target
): { scope: "company" } | { scope: "team" | "session"; scopeId: string } => {
  if (to.scope === "company") {
    return { scope: "company" };
  }
  return to.scope === "team"
    ? { scope: "team", scopeId: to.teamId }
    : { scope: "session", scopeId: to.chat.chatId };
};

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
  const { failure, run } = useCoreAction();
  const chats = useSharedChats();
  const targets = shareTargets(
    teams,
    chats.state === "ready" ? chats.chats : [],
    admin
  );
  const [chosen, setChosen] = useState(
    targets[0] === undefined ? "" : targetKey(targets[0])
  );
  const [text, setText] = useState(record.statement);
  const idempotencyKey = useRef<string>(null);
  const target = targets.find((one) => targetKey(one) === chosen);
  const ready = target !== undefined && text.trim() !== "";
  const teamName = (teamId: string): string =>
    teams.find(({ id }) => id === teamId)?.name ?? teamId;

  const share = async (): Promise<void> => {
    if (target === undefined) {
      throw new Error("Nowhere is chosen.");
    }
    const receipt = await run(
      async (session) =>
        await session.knowledge.memoriesPublish(
          {
            ...scopeOf(target),
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
    if (receipt === undefined) {
      // The dialog stays open, with core's reason under the fields.
      throw new Error("It wasn't shared.");
    }
    onShared(recordOf(receipt));
  };

  return (
    <>
      <DialogBody>
        <Field>
          <FieldLabel>{t`Share with`}</FieldLabel>
          <RadioGroup
            onValueChange={(value) => {
              setChosen(value ?? "");
            }}
            value={chosen}
          >
            {targets.map((one) => (
              <Field key={targetKey(one)} orientation="horizontal">
                <RadioGroupItem value={targetKey(one)} />
                <FieldLabel>
                  {one.scope === "company" ? t`The whole company` : null}
                  {one.scope === "team" ? teamName(one.teamId) : null}
                  {one.scope === "session" ? (
                    <ChatLabel chat={one.chat} />
                  ) : null}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
          {chats.state === "failed" ? (
            <ErrorText>{chats.reason}</ErrorText>
          ) : null}
          {chats.state === "ready" && targets.length === 0 ? (
            <FieldDescription>
              {t`There's nowhere to share it yet: you're in no team, and in no chat others share.`}
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <FieldLabel>{t`What it says`}</FieldLabel>
          <Textarea
            maxLength={rememberTextMaxLength}
            onValueChange={(value) => {
              setText(value);
            }}
            rows={4}
            value={text}
          />
          <FieldDescription>
            {t`Reword it for them if you like. It can't rest on documents they may not read.`}
          </FieldDescription>
        </Field>
        <ErrorText>{failure}</ErrorText>
      </DialogBody>
      <DialogFooter>
        <DialogAction>{t`Cancel`}</DialogAction>
        <DialogAction
          action={share}
          disabled={!ready}
          failedLabel={t`Not shared`}
          variant="ink"
          workingLabel={t`Sharing`}
        >
          {t`Share it`}
        </DialogAction>
      </DialogFooter>
    </>
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
      <DialogTrigger icon={People} size="xs">
        {t`Share it`}
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Share this record`}</DialogTitle>
        <DialogDescription>
          {t`Everyone it is shared with, and their agents, read it as accepted. Yours stays as it is.`}
        </DialogDescription>
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
