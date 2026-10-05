import { packageKey } from "@grasp-os/shared/dependencies";
import type {
  DependenciesWaiting,
  DependencyFinding,
  DependencyRequest,
  DependencyReview,
  DependencyTarget,
} from "@grasp-os/shared/dependencies";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { PackageIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// npm packages proposed for an engine, waiting on someone who was given
// the permission to approve them: each request with who asks, why, where
// the packages would run and what was reported of them, the whole graph
// on asking, and the decision. Core lists them only to those who hold the
// permission, and checks it again as the decision lands. What a package
// says of itself (a licence, a finding) is shown as text.

const targetNames: Record<DependencyTarget, MessageDescriptor> = {
  browser: msg({ message: "Browser", context: "where a package runs" }),
  server: msg({ message: "Server", context: "where a package runs" }),
  workflow: msg({ message: "Workflows", context: "where a package runs" }),
  computation: msg({
    message: "Computations",
    context: "where a package runs",
  }),
};

const findingKinds: Record<DependencyFinding["kind"], MessageDescriptor> = {
  license: msg({ message: "Licence", context: "kind of finding" }),
  security: msg({ message: "Security", context: "kind of finding" }),
};

const severities: Record<DependencyFinding["severity"], MessageDescriptor> = {
  info: msg({ message: "Note", context: "severity of a finding" }),
  low: msg({ message: "Low", context: "severity of a finding" }),
  moderate: msg({ message: "Moderate", context: "severity of a finding" }),
  high: msg({ message: "High", context: "severity of a finding" }),
  critical: msg({ message: "Critical", context: "severity of a finding" }),
};

/** Every package of a request, with what the registry says of each. */
const Packages = ({ review }: { review: DependencyReview }) => {
  const { t } = useLingui();
  const { previous } = review;
  const added = formatList((previous?.added ?? []).map(packageKey));
  const removed = formatList((previous?.removed ?? []).map(packageKey));
  return (
    <div className="flex flex-col gap-3">
      {previous === null ? (
        <p className="text-muted-foreground">
          <Trans>No packages were approved for this engine before.</Trans>
        </p>
      ) : (
        <div className="text-muted-foreground flex flex-col gap-1">
          {previous.added.length === 0 ? null : (
            <p>
              <Trans>New since the last approval: {added}</Trans>
            </p>
          )}
          {previous.removed.length === 0 ? null : (
            <p>
              <Trans>No longer used: {removed}</Trans>
            </p>
          )}
        </div>
      )}
      {review.findings.length === 0 ? null : (
        <ul aria-label={t`Findings`} className="flex flex-col gap-1">
          {review.findings.map((finding) => {
            const kind = i18n._(findingKinds[finding.kind]);
            const severity = i18n._(severities[finding.severity]);
            const about = packageKey(finding.package);
            const { summary } = finding;
            return (
              <li key={`${finding.kind} ${about} ${finding.id} ${summary}`}>
                <Trans>
                  {kind}, {severity}, {about}: {summary}
                </Trans>
              </li>
            );
          })}
        </ul>
      )}
      {review.refused.length === 0 ? null : (
        <ul
          aria-label={t`What Grasp refuses to run`}
          className="flex flex-col gap-1"
        >
          {review.refused.map((refusal) => {
            const about = packageKey(refusal.package);
            const { requirement } = refusal;
            return (
              <li key={`${about} ${requirement}`}>
                <Trans>
                  Grasp won&apos;t run what {about} needs: {requirement}
                </Trans>
              </li>
            );
          })}
        </ul>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Package</Trans>
            </TableHead>
            <TableHead>
              <Trans>Licence</Trans>
            </TableHead>
            <TableHead>
              <Trans>Depends on</Trans>
            </TableHead>
            <TableHead>
              <Trans>Registry and hash</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {review.graph.packages.map((node) => (
            <TableRow key={packageKey(node)}>
              <TableCell>{packageKey(node)}</TableCell>
              <TableCell>{node.license ?? t`None stated`}</TableCell>
              <TableCell className="whitespace-normal">
                {formatList([
                  ...node.dependencies.map(packageKey),
                  ...node.peers.map(({ name, resolved }) =>
                    resolved === null
                      ? name
                      : packageKey({ name, version: resolved })
                  ),
                ])}
              </TableCell>
              <TableCell className="whitespace-normal">
                {node.origin}
                <span className="text-muted-foreground block font-mono text-xs break-all">
                  {node.integrity}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

const RequestCard = ({
  request,
  policyGeneration,
  onDecided,
}: {
  request: DependencyRequest;
  policyGeneration: number;
  onDecided: () => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const [review, setReview] = useState<DependencyReview>();
  const { t } = useLingui();
  const engine = request.app.name;
  const requester = request.requestedBy.name;
  const targets = formatList(
    request.targets.map((target) => i18n._(targetNames[target]))
  );
  const asked = formatDateTime(request.requestedAt);
  // Read again however it went: a refused decision says the request
  // changed, and the list shows how it stands now.
  const decide = async (approved: boolean): Promise<void> => {
    await run(
      async (session) =>
        await session.dependencies.decide(request.id, {
          approved,
          reviewed: { graphHash: request.graphHash, policyGeneration },
        })
    );
    onDecided();
  };
  return (
    <article
      aria-label={t`Packages for ${engine}`}
      className="bg-card flex w-full flex-col gap-4 rounded-xl border p-4 text-sm"
    >
      <h3 className="flex items-start gap-2 font-medium">
        <PackageIcon
          aria-hidden="true"
          className="text-status-attention mt-0.5 size-4 flex-none"
        />
        <span>
          <Trans>Packages for {engine}</Trans>
        </span>
      </h3>
      <div className="flex flex-col gap-2">
        <p>{request.purpose}</p>
        <p className="text-muted-foreground">
          <Plural
            value={request.counts.direct}
            one={`${requester} asks for # package`}
            other={`${requester} asks for # packages`}
          />
        </p>
        <p className="text-muted-foreground">
          <Plural
            value={request.counts.packages}
            one={`# package in all, to run in: ${targets}`}
            other={`# packages in all, to run in: ${targets}`}
          />
        </p>
        <p className="text-muted-foreground">
          {request.requestedVia === null ? (
            <Trans>
              Asked for <time dateTime={request.requestedAt}>{asked}</time>
            </Trans>
          ) : (
            <Trans>
              Proposed by the agent, in their chat,{" "}
              <time dateTime={request.requestedAt}>{asked}</time>
            </Trans>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {request.counts.findings === 0 ? null : (
            <Badge variant="destructive">
              <Plural
                value={request.counts.findings}
                one="# finding reported"
                other="# findings reported"
              />
            </Badge>
          )}
          {request.counts.refused === 0 ? null : (
            <Badge variant="outline">
              <Plural
                value={request.counts.refused}
                one="Needs # thing Grasp refuses to run"
                other="Needs # things Grasp refuses to run"
              />
            </Badge>
          )}
        </div>
      </div>
      {review === undefined ? null : <Packages review={review} />}
      <div className="flex flex-wrap gap-2">
        {review === undefined ? (
          <Button
            aria-label={t`Show the packages for ${engine}`}
            disabled={busy}
            onClick={() => {
              void run(async (session) => {
                setReview(await session.dependencies.get(request.id));
              });
            }}
            variant="outline"
          >
            <Trans>Show every package</Trans>
          </Button>
        ) : null}
        <Button
          aria-label={t`Approve the packages for ${engine}`}
          disabled={busy}
          onClick={() => {
            void decide(true);
          }}
        >
          <Trans>Approve</Trans>
        </Button>
        <Button
          aria-label={t`Deny the packages for ${engine}`}
          disabled={busy}
          onClick={() => {
            void decide(false);
          }}
          variant="destructive"
        >
          <Trans>Deny</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </article>
  );
};

/** The requests waiting on the person, each with its decision. */
export const DependencyRequests = ({
  waiting: { requests, policyGeneration },
  onDecided,
}: {
  waiting: DependenciesWaiting;
  onDecided: () => void;
}) => (
  <div className="flex flex-col gap-3 border-t px-4 py-3">
    {requests.map((request) => (
      <RequestCard
        key={request.id}
        onDecided={onDecided}
        policyGeneration={policyGeneration}
        request={request}
      />
    ))}
  </div>
);
