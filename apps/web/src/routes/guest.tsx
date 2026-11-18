import { guestMessageMaxLength } from "@grasp-os/shared/guests";
import type { GuestView } from "@grasp-os/shared/guests";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { ChatComposer } from "../chat/chat-composer.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { Button } from "../grasp/button/index.ts";
import { ChatMessage } from "../grasp/chat-message/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { guestCall, linkSecret } from "../guest/api.ts";

// Where a guest link leads (`/guest#<secret>`): someone who isn't a member,
// invited to a short chat about their work. No sign-in, no session: the
// secret after the `#`, which the browser never sends anywhere but in the
// requests below, is all the page has, and all it can do is this chat.
// What the model answers is shown as plain text.

const styles = stylex.create({
  messages: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // Plain text, its line breaks kept: never Markdown.
  plain: { whiteSpace: "pre-wrap" },
  intro: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space2,
    textAlign: "center",
  },
  ended: { alignSelf: "flex-start" },
  box: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    width: "100%",
  },
  finish: { alignSelf: "flex-end" },
});

/** What the page shows, and the link's secret it was opened with. */
type Page =
  | { state: "loading"; secret: string }
  | { state: "refused"; secret: string; message: string }
  | { state: "ready"; secret: string; view: GuestView };

/** What the chat says once it can take no more. */
const endedText = (view: GuestView): string | undefined => {
  switch (view.status) {
    case "finished": {
      return i18n._(msg`You finished this chat. Thank you for your time.`);
    }
    case "revoked": {
      return i18n._(
        msg`This chat has been closed by whoever sent you the link.`
      );
    }
    case "expired": {
      return i18n._(
        msg`This link has expired. Ask whoever sent it for a new one.`
      );
    }
    case "open": {
      return view.turnsLeft === 0
        ? i18n._(msg`This chat has reached its length. Press Finish to end it.`)
        : undefined;
    }
    default: {
      return view.status satisfies never;
    }
  }
};

/**
 * The messages so far as Grasp UI's Chat message draws them: theirs on the
 * right, Grasp's answers as plain text, never Markdown; while one is read,
 * Grasp thinking.
 */
const Messages = ({
  view,
  reading,
}: {
  view: GuestView;
  /** Whether a message is on its way, to be answered. */
  reading: boolean;
}) => {
  const { t } = useLingui();
  return (
    <ol aria-label={t`Messages`} {...stylex.props(styles.messages)}>
      {view.messages.map((message) => (
        <li key={`${message.at}-${message.role}`}>
          <ChatMessage
            dateTime={message.at}
            from={message.role === "guest" ? "person" : "agent"}
            name="Grasp"
          >
            <span {...stylex.props(styles.plain)}>{message.text}</span>
          </ChatMessage>
        </li>
      ))}
      {reading ? (
        <li>
          <ChatMessage
            from="agent"
            name="Grasp"
            status="thinking"
            thinkingLabel={t`Reading what you wrote`}
          />
        </li>
      ) : null}
    </ol>
  );
};

/**
 * The chat `secret` opened, open for the guest's next message until it
 * ends. Every message and the finish go with that same secret, never
 * with whatever the URL holds by then.
 */
const Chat = ({ secret, first }: { secret: string; first: GuestView }) => {
  const [view, setView] = useState(first);
  const [text, setText] = useState("");
  // What is on its way to core: a message, or the finish.
  const [pending, setPending] = useState<"send" | "finish">();
  const [failure, setFailure] = useState<string | undefined>();
  const ended = endedText(view);
  const open = view.status === "open";
  const { t } = useLingui();
  const { name } = view;
  const until = formatDateTime(view.expiresAt);

  const call = async (
    request: { action: "send"; text: string } | { action: "finish" }
  ): Promise<boolean> => {
    setPending(request.action);
    const answer = await guestCall({ ...request, token: secret });
    setPending(undefined);
    if ("error" in answer) {
      setFailure(answer.error);
      return false;
    }
    setFailure(undefined);
    setView(answer.ok);
    return true;
  };

  return (
    <>
      <GraspBuddy />
      <div {...stylex.props(styles.intro)}>
        <Heading level={1}>{t`Hi ${name}`}</Heading>
        <Text tone="muted">
          <Trans>
            This chat asks how your work is done. Everything you write is kept
            and read by the people who invited you, who may copy it into their
            own records and keep it there. Please don&apos;t share passwords,
            bank details or anything you wouldn&apos;t put in an email.
          </Trans>
          {open ? ` ${t`The link works until ${until}.`}` : ""}
        </Text>
      </div>
      <Messages reading={pending === "send"} view={view} />
      {ended === undefined ? null : (
        <output {...stylex.props(styles.ended)}>
          <Text element="span" tone="muted">
            {ended}
          </Text>
        </output>
      )}
      {open ? (
        <div {...stylex.props(styles.box)}>
          {view.turnsLeft > 0 ? (
            <ChatComposer
              busy={pending === "send"}
              compact
              // Not while the chat is being finished.
              disabled={pending === "finish"}
              failure={failure}
              label={t`Your message`}
              maxLength={guestMessageMaxLength}
              onSend={() => {
                const sent = text;
                void (async () => {
                  if (await call({ action: "send", text: sent })) {
                    // What they typed while it was sent stays.
                    setText((typed) => (typed === sent ? "" : typed));
                  }
                })();
              }}
              onText={setText}
              placeholder={t`Write your answer`}
              running={false}
              text={text}
            />
          ) : (
            <ErrorText>{failure}</ErrorText>
          )}
          <Button
            disabled={pending !== undefined}
            layout={styles.finish}
            onClick={() => {
              void call({ action: "finish" });
            }}
            variant="quiet"
          >
            {t`Finish`}
          </Button>
        </div>
      ) : null}
    </>
  );
};

const Guest = () => {
  const { t } = useLingui();
  // The link's secret, read from the URL once, and again only when the
  // URL's fragment changes (another link pasted over this one): the chat
  // shown, and the one every message goes to, are the one this opened.
  const [secret, setSecret] = useState(linkSecret);
  const [page, setPage] = useState<Page>({ state: "loading", secret });
  useEffect(() => {
    const changed = (): void => {
      setSecret(linkSecret());
    };
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const answer =
        secret === ""
          ? {
              error: i18n._(
                msg`This link doesn't work. Ask whoever sent it for a new one.`
              ),
            }
          : await guestCall({ action: "open", token: secret });
      if (!current) {
        return;
      }
      setPage(
        "error" in answer
          ? { state: "refused", secret, message: answer.error }
          : { state: "ready", secret, view: answer.ok }
      );
    };
    void load();
    return () => {
      current = false;
    };
  }, [secret]);
  // What was opened with another secret is never shown for this one.
  const shown: Page =
    page.secret === secret ? page : { state: "loading", secret };
  return (
    <OnboardingFrame wide>
      {shown.state === "loading" ? (
        <>
          <GraspBuddy />
          <output>
            <Text element="span" tone="muted">
              {t`Opening the chat…`}
            </Text>
          </output>
        </>
      ) : null}
      {shown.state === "refused" ? (
        <>
          <GraspBuddy />
          <div {...stylex.props(styles.intro)}>
            <Heading level={1}>{t`This chat can't be opened`}</Heading>
            <ErrorText>{shown.message}</ErrorText>
          </div>
        </>
      ) : null}
      {shown.state === "ready" ? (
        <Chat key={shown.secret} secret={shown.secret} first={shown.view} />
      ) : null}
    </OnboardingFrame>
  );
};

export const Route = createFileRoute("/guest")({ component: Guest });
