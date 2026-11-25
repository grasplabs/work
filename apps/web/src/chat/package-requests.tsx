import type {
  DependencyFinding,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import { packageKey } from "@grasp-os/shared/dependencies";
import { messageOf } from "@grasp-os/shared/errors";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Confirmation,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@grasp-os/ui/components/confirmation";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { PauseNote } from "../answer-pause.tsx";
import type { AnswersPause } from "../answer-pause.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { DecisionButton } from "./decision-button.tsx";
import { FailureLine } from "./failure-line.tsx";

const styles = stylex.create({
  details: {
    display: "grid",
    justifyItems: "start",
    gap: space["2"],
    // A line of its own in the confirmation, under its title.
    flexBasis: "100%",
    minWidth: 0,
  },
  findings: {
    display: "grid",
    gap: space["1"],
    margin: 0,
    paddingInlineStart: 0,
    listStyleType: "none",
  },
  finding: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space["2"],
  },
  list: { display: "grid", gap: space["2"] },
});

// The npm packages the chat's agent asked for (core's
// packages/requests.ts), each on a card: the App's builder
// approves or denies them here, in their own session, which the agent
// can't reach. The card shows the request as stored, and a decision names
// the graph it showed, so what is approved is what was shown.

/** What the page read of the chat's requests. */
type Requests =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; requests: DependencyRequest[] };

/** The chat's requests. Outside the component, as the React Compiler can't compile `try`. */
const readRequests = async (
  core: CoreConnection,
  chatId: string
): Promise<Requests> => {
  try {
    const requests = await core.withSession(
      async (session) => await session.chats.packageRequests(chatId)
    );
    return { state: "ready", requests };
  } catch (error) {
    return { state: "refused", message: messageOf(error) };
  }
};

const severities: Record<DependencyFinding["severity"], MessageDescriptor> = {
  critical: msg({ message: "Critical", context: "an advisory's severity" }),
  high: msg({ message: "High", context: "an advisory's severity" }),
  moderate: msg({ message: "Moderate", context: "an advisory's severity" }),
  low: msg({ message: "Low", context: "an advisory's severity" }),
  info: msg({ message: "Info", context: "an advisory's severity" }),
};

/** What was found of the packages, gravest first, as text: a package's own words. */
const Findings = ({ findings }: { findings: readonly DependencyFinding[] }) => {
  const { i18n } = useLingui();
  if (findings.length === 0) {
    return null;
  }
  return (
    <ul {...stylex.props(styles.findings)}>
      {findings.map((finding) => (
        <li
          key={`${packageKey(finding.package)}:${finding.id ?? finding.kind}`}
          {...stylex.props(styles.finding)}
        >
          <Badge
            variant={
              finding.severity === "critical" || finding.severity === "high"
                ? "destructive"
                : "warning"
            }
          >
            {i18n._(severities[finding.severity])}
          </Badge>
          <Text as="span" size="sm" wrap="anywhere">
            {packageKey(finding.package)}
          </Text>
          <Text as="span" size="sm" wrap="anywhere">
            {finding.summary}
          </Text>
        </li>
      ))}
    </ul>
  );
};

const PackageRequest = ({
  request,
  pause,
  onDecided,
  onApproved,
}: {
  request: DependencyRequest;
  /** Held a moment after an answer in the chat moved this card into place. */
  pause: AnswersPause;
  onDecided: () => void;
  onApproved: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const router = useRouter();
  const pauseId = useId();
  const pausedBy = pause.held ? pauseId : undefined;
  const decide = async (approved: boolean): Promise<void> => {
    const decided = await run(async (session) => {
      await session.dependencies.decide(request.id, {
        approved,
        graphHash: request.graphHash,
      });
      return true;
    });
    // Read again however it went: a failed decision may have changed
    // something too (decided elsewhere, say).
    onDecided();
    if (decided === true && approved) {
      onApproved();
    }
    await router.invalidate();
  };
  const subject = request.subject.name;
  const direct = formatList(
    Object.entries(request.lock.direct).map(([name, version]) =>
      packageKey({ name, version })
    )
  );
  const count = Object.keys(request.lock.packages).length;
  const removed = formatList(request.removed);
  return (
    <Confirmation approval={{ id: request.id }} state="approval-requested">
      {pause.held ? <PauseNote id={pauseId} /> : null}
      <ConfirmationTitle>
        <ConfirmationRequest>
          <Trans>The agent asks for npm packages for {subject}</Trans>
        </ConfirmationRequest>
      </ConfirmationTitle>
      <div {...stylex.props(styles.details)}>
        <Text size="sm" wrap="anywhere">
          {request.purpose}
        </Text>
        <KeyValueList
          items={[
            { id: "packages", label: t`Packages`, value: direct, mono: true },
            ...(request.removed.length === 0
              ? []
              : [
                  {
                    id: "removed",
                    label: t`Takes out`,
                    value: removed,
                    mono: true,
                  },
                ]),
            {
              id: "count",
              label: t`With what they bring`,
              value: plural(count, { one: "# package", other: "# packages" }),
            },
          ]}
        />
        <Findings findings={request.findings} />
        <Text color="muted" size="sm">
          <Trans>
            Nothing uses them until you approve. Known malware is always
            refused.
          </Trans>
        </Text>
        <FailureLine>{failure}</FailureLine>
      </div>
      <ConfirmationActions>
        <DecisionButton
          disabled={busy}
          label={t`Deny the packages for ${subject}`}
          onPress={async () => {
            await decide(false);
          }}
          pausedBy={pausedBy}
          variant="outline"
        >
          <Trans>Deny</Trans>
        </DecisionButton>
        <DecisionButton
          disabled={busy}
          label={t`Approve the packages for ${subject}`}
          onPress={async () => {
            await decide(true);
          }}
          pausedBy={pausedBy}
        >
          <Trans>Approve</Trans>
        </DecisionButton>
      </ConfirmationActions>
    </Confirmation>
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
  pause,
  onApproved,
}: {
  chatId: string;
  version: number;
  /** The pause the chat's answers share (`WaitingForYou`): each decision here holds them all. */
  pause: AnswersPause;
  /**
   * Once packages are approved: the agent's turn ended asking for them,
   * and only a new one carries on (core's notice starts none).
   */
  onApproved: () => void;
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
    <section aria-label={t`Package requests`} {...stylex.props(styles.list)}>
      {read.requests.map((request) => (
        <PackageRequest
          key={request.id}
          onApproved={onApproved}
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
