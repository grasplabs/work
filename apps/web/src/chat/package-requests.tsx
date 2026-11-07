import type {
  DependencyFinding,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import { packageKey } from "@grasp-os/shared/dependencies";
import { messageOf } from "@grasp-os/shared/errors";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// The npm packages the chat's agent asked for (core's
// packages/requests.ts), each on a card: the App's or workflow's builder
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
    <ul className="flex flex-col gap-1">
      {findings.map((finding) => (
        <li
          className="flex flex-wrap items-baseline gap-2"
          key={`${packageKey(finding.package)}:${finding.id ?? finding.kind}`}
        >
          <Badge
            variant={
              finding.severity === "critical" || finding.severity === "high"
                ? "destructive"
                : "attention"
            }
          >
            {i18n._(severities[finding.severity])}
          </Badge>
          <span className="font-mono">{packageKey(finding.package)}</span>
          <span className="break-words">{finding.summary}</span>
        </li>
      ))}
    </ul>
  );
};

const PackageRequest = ({
  request,
  onDecided,
}: {
  request: DependencyRequest;
  onDecided: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const router = useRouter();
  const decide = async (approved: boolean): Promise<void> => {
    await run(async (session) => {
      await session.dependencies.decide(request.id, {
        approved,
        graphHash: request.graphHash,
      });
    });
    // Read again however it went: a failed decision may have changed
    // something too (decided elsewhere, say).
    onDecided();
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
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <Trans>The agent asks for npm packages for {subject}</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2 text-sm">
          <p className="break-words whitespace-pre-wrap">{request.purpose}</p>
          <dl className="flex flex-col gap-2">
            <div className="flex flex-col">
              <dt className="text-muted-foreground">
                <Trans>Packages</Trans>
              </dt>
              <dd className="font-mono break-words">{direct}</dd>
            </div>
            {request.removed.length === 0 ? null : (
              <div className="flex flex-col">
                <dt className="text-muted-foreground">
                  <Trans>Takes out</Trans>
                </dt>
                <dd className="font-mono break-words">{removed}</dd>
              </div>
            )}
            <div className="flex flex-col">
              <dt className="text-muted-foreground">
                <Trans>With what they bring</Trans>
              </dt>
              <dd>
                {plural(count, { one: "# package", other: "# packages" })}
              </dd>
            </div>
          </dl>
          <Findings findings={request.findings} />
          <p className="text-muted-foreground">
            <Trans>
              Nothing uses them until you approve. Known malware is always
              refused.
            </Trans>
          </p>
          <ErrorText>{failure}</ErrorText>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex gap-2">
          <Button
            aria-label={t`Approve the packages for ${subject}`}
            disabled={busy}
            onClick={() => {
              void decide(true);
            }}
          >
            <Trans>Approve</Trans>
          </Button>
          <Button
            aria-label={t`Deny the packages for ${subject}`}
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
    <section aria-label={t`Package requests`} className="flex flex-col gap-2">
      {read.requests.map((request) => (
        <PackageRequest
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
