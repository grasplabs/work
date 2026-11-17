import type { ChatConnectionRequest } from "@grasp-os/shared/chat";
import { messageOf } from "@grasp-os/shared/errors";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { ApprovalRequest } from "../grasp/approval-request/index.ts";
import { Button } from "../grasp/button/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useApprovalWords } from "./approval-words.ts";

// The connections the chat's agent asked to use in this chat (core's
// chat-connections.ts): the person grants or denies their own personal
// connection on Grasp UI's Approval request; a shared one waits for an
// admin, said in a quiet note, and they may withdraw it. The card shows the request exactly as stored, and
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
  list: { display: "grid", gap: grasp.space3 },
  details: { display: "grid", gap: grasp.space2 },
  start: { justifySelf: "start" },
});

/** A connection by the names the person knows it by, else its ID. */
const nameOf = (request: ChatConnectionRequest): string => {
  const connection = [request.provider, request.accountName]
    .filter((part) => part !== null)
    .join(", ");
  return connection === "" ? request.connectionId : connection;
};

/** What a request holds exactly as stored: what it may do, as whom, and on what. */
const RequestDetails = ({ request }: { request: ChatConnectionRequest }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.details)}>
      {request.reason === null ? null : <Text size="sm">{request.reason}</Text>}
      <KeyValueList
        items={[
          {
            id: "actions",
            key: t`It may`,
            value: request.actions.join(", "),
            mono: true,
          },
          { id: "binding", key: t`As`, value: request.binding, mono: true },
          ...(request.resource === null
            ? []
            : [{ id: "resource", key: t`Only`, value: request.resource }]),
        ]}
      />
      <Text size="sm" tone="muted">
        {t`In this chat only, until you delete it. Anything it sends or changes still waits for you to confirm.`}
      </Text>
    </div>
  );
};

/** One request: the person's own to grant or deny, or a shared one that waits for an admin. */
const ConnectionRequest = ({
  chatId,
  request,
  onDecided,
}: {
  chatId: string;
  request: ChatConnectionRequest;
  onDecided: () => void;
}) => {
  const { t } = useLingui();
  const words = useApprovalWords();
  const { busy, failure, run } = useCoreAction();
  const router = useRouter();
  // Read again however it went: a failed decision may have changed
  // something too (decided elsewhere, say). A refusal reaches the card,
  // which says it could not.
  const decide = async (
    decision: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    const done = await run(async (session) => {
      await decision(session);
      return true;
    });
    onDecided();
    // Core notes the decision in the chat, which moves it up the chat
    // list: the list is read again so it shows under its new time.
    await router.invalidate();
    if (done !== true) {
      throw new Error("The decision was not taken");
    }
  };
  const name = nameOf(request);
  const deny = async (): Promise<void> => {
    await decide(async (session) => {
      await session.chats.denyConnection(chatId, request.id);
    });
  };
  if (request.decidedBy === "you") {
    return (
      <ApprovalRequest
        affects={[
          { kind: "system", label: name, detail: request.actions.join(", ") },
        ]}
        approveLabel={t`Grant`}
        onApprove={async () => {
          await decide(async (session) => {
            await session.chats.grantConnection(chatId, request.id);
          });
        }}
        onDecline={deny}
        title={t`Use ${name} in this chat`}
        words={{ ...words, decline: t`Deny` }}
      >
        <RequestDetails request={request} />
      </ApprovalRequest>
    );
  }
  return (
    <Alert title={t`The agent asked an admin for ${name}`}>
      <div {...stylex.props(styles.details)}>
        <Text size="sm">{t`An admin decides. It holds in this chat only.`}</Text>
        <Button
          aria-label={t`Withdraw ${name}`}
          disabled={busy}
          layout={styles.start}
          onClick={() => {
            void (async () => {
              try {
                await deny();
              } catch {
                // Said under it (`failure`).
              }
            })();
          }}
          size="xs"
          variant="quiet"
        >
          {t`Withdraw`}
        </Button>
        <ErrorText>{failure}</ErrorText>
      </div>
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
}: {
  chatId: string;
  version: number;
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
    return <ErrorText>{read.message}</ErrorText>;
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
            setReads(reads + 1);
          }}
          request={request}
        />
      ))}
    </section>
  );
};
