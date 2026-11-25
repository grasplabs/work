import type { ChatConnectionRequest } from "@grasp-os/shared/chat";
import { messageOf } from "@grasp-os/shared/errors";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Confirmation,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@grasp-os/ui/components/confirmation";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { PauseNote } from "../answer-pause.tsx";
import type { AnswersPause } from "../answer-pause.tsx";
import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { DecisionButton } from "./decision-button.tsx";
import { FailureLine } from "./failure-line.tsx";

// The connections the chat's agent asked to use in this chat (core's
// chat-connections.ts), each on a card: the person grants or denies their
// own personal connection here; a shared one waits for an admin, and they
// may withdraw it. The card shows the request exactly as stored, and
// granting names only its ID: what is granted is what it shows.

/** What the page read of the chat's requests. */
type Requests =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; requests: ChatConnectionRequest[] };

/** The chat's requests. Outside the component, as the React Compiler can't compile `try`. */
const readRequests = async (
  core: CoreConnection,
  chatId: string
): Promise<Requests> => {
  try {
    const requests = await core.withSession(
      async (session) => await session.chats.connectionRequests(chatId)
    );
    return { state: "ready", requests };
  } catch (error) {
    return { state: "refused", message: messageOf(error) };
  }
};

const styles = stylex.create({
  details: {
    display: "grid",
    justifyItems: "start",
    gap: space["2"],
    // A line of its own in the confirmation, under its title.
    flexBasis: "100%",
    minWidth: 0,
  },
  list: { display: "grid", gap: space["2"] },
});

/** The connection a request names: its provider and account, else its ID. */
const nameOf = (request: ChatConnectionRequest): string => {
  const connection = [request.provider, request.accountName]
    .filter((part) => part !== null)
    .join(", ");
  return connection === "" ? request.connectionId : connection;
};

/** What the agent asks to do with it, as the person reads it before granting it. */
const RequestDetails = ({ request }: { request: ChatConnectionRequest }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.details)}>
      {request.reason === null ? null : (
        <Text size="sm" wrap="anywhere">
          {request.reason}
        </Text>
      )}
      <KeyValueList
        items={[
          {
            id: "actions",
            label: t`It may`,
            value: request.actions.join(", "),
            mono: true,
          },
          { id: "binding", label: t`As`, value: request.binding, mono: true },
          ...(request.resource === null
            ? []
            : [{ id: "resource", label: t`Only`, value: request.resource }]),
        ]}
      />
      <Text color="muted" size="sm">
        {t`In this chat only, until you delete it. Anything it sends or changes still waits for you to confirm.`}
      </Text>
    </div>
  );
};

const ConnectionRequest = ({
  chatId,
  request,
  pause,
  onDecided,
}: {
  chatId: string;
  request: ChatConnectionRequest;
  /** Held a moment after an answer in the chat moved this card into place. */
  pause: AnswersPause;
  onDecided: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const router = useRouter();
  const pauseId = useId();
  const pausedBy = pause.held ? pauseId : undefined;
  const note = pause.held ? <PauseNote id={pauseId} /> : null;
  // Read again however it went: a failed decision may have changed
  // something too (decided elsewhere, say).
  const decide = async (
    decision: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await run(decision);
    onDecided();
    // Core notes the decision in the chat, which moves it up the chat
    // list: the list is read again so it shows under its new time.
    await router.invalidate();
  };
  const name = nameOf(request);
  const deny = async (): Promise<void> => {
    await decide(async (session) => {
      await session.chats.denyConnection(chatId, request.id);
    });
  };
  if (request.decidedBy === "you") {
    return (
      <Confirmation approval={{ id: request.id }} state="approval-requested">
        {note}
        <ConfirmationTitle>
          <ConfirmationRequest>{t`Use ${name} in this chat`}</ConfirmationRequest>
        </ConfirmationTitle>
        <RequestDetails request={request} />
        <FailureLine>{failure}</FailureLine>
        <ConfirmationActions>
          {/* Named for what each decides, so several requests read apart. */}
          <DecisionButton
            disabled={busy}
            label={t`Deny ${name}`}
            onPress={deny}
            pausedBy={pausedBy}
            variant="outline"
          >
            {t`Deny`}
          </DecisionButton>
          <DecisionButton
            disabled={busy}
            label={t`Grant ${name}`}
            onPress={async () => {
              await decide(async (session) => {
                await session.chats.grantConnection(chatId, request.id);
              });
            }}
            pausedBy={pausedBy}
          >
            {t`Grant`}
          </DecisionButton>
        </ConfirmationActions>
      </Confirmation>
    );
  }
  return (
    <Alert>
      <AlertTitle>{t`The agent asked an admin for ${name}`}</AlertTitle>
      <AlertDescription>
        <span {...stylex.props(styles.details)}>
          {note}
          {t`An admin decides. It holds in this chat only.`}
          <Button
            asChild
            disabled={busy || pause.held}
            focusableWhenDisabled={pause.held}
            size="xs"
            variant="outline"
          >
            <button
              aria-describedby={pausedBy}
              aria-label={t`Withdraw ${name}`}
              onClick={() => {
                if (!busy && !pause.held) {
                  void deny();
                }
              }}
              type="button"
            >
              {t`Withdraw`}
            </button>
          </Button>
          <FailureLine>{failure}</FailureLine>
        </span>
      </AlertDescription>
    </Alert>
  );
};

/**
 * The chat's connection requests, each with its decision. Read again when
 * `version` changes (`ChatUpdate.held`: something waits, or no longer
 * does) and after each decision.
 */
export const ConnectionRequests = ({
  chatId,
  version,
  pause,
}: {
  chatId: string;
  version: number;
  /** The pause the chat's answers share (`WaitingForYou`): each decision here holds them all. */
  pause: AnswersPause;
}) => {
  const { t } = useLingui();
  const [read, setRead] = useState<Requests>({ state: "loading" });
  const core = useCore();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const found = await readRequests(core, chatId);
      // A read for another chat, or an older one, doesn't show.
      if (current) {
        setRead(found);
      }
    };
    void load();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `version` and `reads` say when to read again
  }, [core, chatId, version, reads]);
  if (read.state === "refused") {
    return <FailureLine>{read.message}</FailureLine>;
  }
  if (read.state === "loading" || read.requests.length === 0) {
    return null;
  }
  return (
    <section aria-label={t`Connection requests`} {...stylex.props(styles.list)}>
      {read.requests.map((request) => (
        <ConnectionRequest
          chatId={chatId}
          key={request.id}
          onDecided={() => {
            pause.hold();
            setReads(reads + 1);
          }}
          pause={pause}
          request={request}
        />
      ))}
    </section>
  );
};
