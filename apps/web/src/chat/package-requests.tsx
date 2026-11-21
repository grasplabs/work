import type {
  DependencyFinding,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import { packageKey } from "@grasp-os/shared/dependencies";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import {
  ApprovalRequest,
  ApprovalRequestApprove,
} from "../grasp/approval-request/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useApprovalWords } from "./approval-words.ts";
import { useChatRequests } from "./chat-requests.ts";

// The npm packages the chat's agent asked for (core's
// packages/requests.ts), each on a card: the App's builder
// approves or denies them here, in their own session, which the agent
// can't reach. The card shows the request as stored, and a decision names
// the graph it showed, so what is approved is what was shown.

/** The chat's package requests. */
const listPackageRequests = async (
  session: Session,
  chatId: string
): Promise<DependencyRequest[]> => await session.chats.packageRequests(chatId);

const severities: Record<DependencyFinding["severity"], MessageDescriptor> = {
  critical: msg({ message: "Critical", context: "an advisory's severity" }),
  high: msg({ message: "High", context: "an advisory's severity" }),
  moderate: msg({ message: "Moderate", context: "an advisory's severity" }),
  low: msg({ message: "Low", context: "an advisory's severity" }),
  info: msg({ message: "Info", context: "an advisory's severity" }),
};

const styles = stylex.create({
  list: { display: "grid", gap: grasp.space3 },
  details: { display: "grid", gap: grasp.space2 },
  findings: {
    display: "grid",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  finding: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: grasp.space2,
  },
});

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
            tone={
              finding.severity === "critical" || finding.severity === "high"
                ? "danger"
                : "attention"
            }
          >
            {i18n._(severities[finding.severity])}
          </Badge>
          <Text element="span" size="sm" weight="medium">
            {packageKey(finding.package)}
          </Text>
          <Text element="span" size="sm">
            {finding.summary}
          </Text>
        </li>
      ))}
    </ul>
  );
};

/** One request, on Grasp UI's Approval request: the builder approves or denies it. */
const PackageRequest = ({
  request,
  onDecided,
  onApproved,
}: {
  request: DependencyRequest;
  onDecided: () => void;
  onApproved: () => void;
}) => {
  const { t } = useLingui();
  const words = useApprovalWords();
  const { run } = useCoreAction();
  const router = useRouter();
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
    await router.invalidate({ sync: true });
    // A refusal reaches the card, which says it could not.
    if (decided !== true) {
      throw new Error("The decision was not taken");
    }
  };
  const subject = request.subject.name;
  const direct = Object.entries(request.lock.direct).map(([name, version]) =>
    packageKey({ name, version })
  );
  const count = Object.keys(request.lock.packages).length;
  return (
    <ApprovalRequest
      affects={[
        ...direct.map((label) => ({ kind: "system" as const, label })),
        ...request.removed.map((label) => ({
          kind: "system" as const,
          label,
          detail: t`Taken out`,
        })),
      ]}
      onApprove={async () => {
        await decide(true);
      }}
      onDecline={async () => {
        await decide(false);
      }}
      title={t`Add npm packages to ${subject}`}
      words={{ ...words, decline: t`Deny` }}
    >
      <ApprovalRequestApprove>{t`Approve the packages`}</ApprovalRequestApprove>
      <div {...stylex.props(styles.details)}>
        <Text size="sm">{request.purpose}</Text>
        <KeyValueList
          items={[
            {
              id: "count",
              key: t`With what they bring`,
              value: plural(count, { one: "# package", other: "# packages" }),
            },
          ]}
        />
        <Findings findings={request.findings} />
        <Text size="sm" tone="muted">
          {t`Nothing uses them until you approve. Known malware is always refused.`}
        </Text>
      </div>
    </ApprovalRequest>
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
  onApproved,
}: {
  chatId: string;
  version: number;
  /**
   * Once packages are approved: the agent's turn ended asking for them,
   * and only a new one carries on (core's notice starts none).
   */
  onApproved: () => void;
}) => {
  const { t } = useLingui();
  const { read, again } = useChatRequests(chatId, version, listPackageRequests);
  if (read.state === "refused") {
    return <ErrorText>{read.message}</ErrorText>;
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
          onDecided={again}
          request={request}
        />
      ))}
    </section>
  );
};
