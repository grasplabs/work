import type {
  DependenciesWaiting,
  DependencyRequest,
  DependencyReview,
} from "@grasp-os/shared/dependencies";
import { messageOf } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { PackagesDetails } from "../dashboard/dependency-requests.tsx";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// The npm packages the chat's agent asked for in this chat (core's
// dependencies/requests.ts), each on a card, as its connection requests
// are (connection-requests.tsx): the person, who builds the App or
// workflow, approves or denies them here with one click, on their own
// session. The agent can't reach this: it only asks, and is told how the
// person decided. The card shows the request as core stored it, and the
// decision names its graph and the policy it was read under, so core
// refuses it once either changed. Known malware is refused however the
// person decides.

/** What the page read of the chat's package requests. */
type Requests =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; waiting: DependenciesWaiting };

/** The chat's requests. Outside the component, as the React Compiler can't compile `try`. */
const readRequests = async (
  core: CoreConnection,
  chatId: string
): Promise<Requests> => {
  try {
    const waiting = await core.withSession(
      async (session) => await session.chats.packageRequests(chatId)
    );
    return { state: "ready", waiting };
  } catch (error) {
    return { state: "refused", message: messageOf(error) };
  }
};

const PackageRequest = ({
  request,
  policyGeneration,
  onDecided,
}: {
  request: DependencyRequest;
  policyGeneration: number;
  onDecided: () => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const router = useRouter();
  const { t } = useLingui();
  const [review, setReview] = useState<DependencyReview>();
  const engine = request.subject.name;
  // Read again however it went: a failed decision may have changed
  // something too (replaced, or decided elsewhere).
  const decide = async (approved: boolean): Promise<void> => {
    await run(async (session) => {
      await session.dependencies.decide(request.id, {
        approved,
        reviewed: { graphHash: request.graphHash, policyGeneration },
      });
    });
    onDecided();
    // Core notes the decision in the chat, which moves it up the chat
    // list: the list is read again so it shows under its new time.
    await router.invalidate();
  };
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <Trans>The agent asks to install packages for {engine}</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2 text-sm">
          <p className="break-words whitespace-pre-wrap">{request.purpose}</p>
          <PackagesDetails
            busy={busy}
            onShow={() => {
              void run(async (session) => {
                setReview(await session.dependencies.get(request.id));
              });
            }}
            request={request}
            review={review}
          />
          <p className="text-muted-foreground">
            <Trans>
              Only for {engine}, until a builder retires or revokes them. Grasp
              refuses known malware however you decide, and tells you if one is
              reported later.
            </Trans>
          </p>
          <ErrorText>{failure}</ErrorText>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex gap-2">
          <Button
            aria-label={t`Approve the packages for ${ph({ app: engine })}`}
            disabled={busy}
            onClick={() => {
              void decide(true);
            }}
          >
            <Trans>Approve</Trans>
          </Button>
          <Button
            aria-label={t`Deny the packages for ${ph({ app: engine })}`}
            disabled={busy}
            onClick={() => {
              void decide(false);
            }}
            variant="outline"
          >
            <Trans>Deny</Trans>
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
};

/**
 * The chat's package requests, each with its decision. Read again when
 * `version` changes (`ChatUpdate.held`: something waits, or no longer
 * does) and after each decision.
 */
export const PackageRequests = ({
  chatId,
  version,
}: {
  chatId: string;
  version: number;
}) => {
  const [read, setRead] = useState<Requests>({ state: "loading" });
  const core = useCore();
  const [reads, setReads] = useState(0);
  const { t } = useLingui();
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
  if (read.state === "loading" || read.waiting.requests.length === 0) {
    return null;
  }
  return (
    <section aria-label={t`Package requests`} className="flex flex-col gap-2">
      {read.waiting.requests.map((request) => (
        <PackageRequest
          key={request.id}
          onDecided={() => {
            setReads(reads + 1);
          }}
          policyGeneration={read.waiting.policyGeneration}
          request={request}
        />
      ))}
    </section>
  );
};
