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
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// npm packages proposed for an engine, waiting on someone who was given
// the permission to approve them: each request with who asks, why, where
// the packages would run and what core's resolver found of them, the
// whole graph on asking, and the decision. Core lists them only to those
// who hold the permission, and checks it again as the decision lands.
// What a package says of itself (a licence, a finding) is shown as text.

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

/** What was reported of a request's packages, each as text. */
const Findings = ({ findings }: { findings: readonly DependencyFinding[] }) => {
  const { t } = useLingui();
  return (
    <ul aria-label={t`Findings`} className="flex flex-col gap-1">
      {findings.map((finding) => {
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
  );
};

/** Every package of a request, as core's resolver read each from the registry. */
const Packages = ({ review }: { review: DependencyReview }) => {
  const { t } = useLingui();
  const { previous } = review;
  const changed = formatList((previous?.changed ?? []).map(packageKey));
  const provided = formatList(
    Object.entries(review.graph.platformPeers).map(([name, version]) =>
      packageKey({ name, version })
    )
  );
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
          {previous.changed.length === 0 ? null : (
            <p>
              <Trans>Same version, different contents: {changed}</Trans>
            </p>
          )}
        </div>
      )}
      {review.findings.length === 0 ? null : (
        <Findings findings={review.findings} />
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
      {provided === "" ? null : (
        <p className="text-muted-foreground">
          <Trans>Provided by Grasp, not installed again: {provided}</Trans>
        </p>
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
              <Trans>Needs alongside it</Trans>
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
                {formatList(node.dependencies.map(packageKey))}
              </TableCell>
              <TableCell className="whitespace-normal">
                {node.peers.map(({ name, range, resolved }) => (
                  <span className="block" key={name}>
                    {resolved === null ? (
                      <Trans>
                        {name} {range}, not met
                      </Trans>
                    ) : (
                      <Trans>
                        {name} {range}, met by {resolved}
                      </Trans>
                    )}
                  </span>
                ))}
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
  const hintId = useId();
  const { t } = useLingui();
  const engine = request.app.name;
  const requester = request.requestedBy.name;
  const targets = formatList(
    request.targets.map((target) => i18n._(targetNames[target]))
  );
  const asked = formatDateTime(request.requestedAt);
  const shown = formatList(request.summary.direct);
  const more = request.counts.direct - request.summary.direct.length;
  const moreFindings =
    request.counts.findings - request.summary.findings.length;
  // Read again once it is decided. A refused decision stays, with why:
  // reading again would take the card, and the reason, away.
  const decide = async (approved: boolean): Promise<void> => {
    const decided = await run(
      async (session) =>
        await session.dependencies.decide(request.id, {
          approved,
          // The graph the person was shown in full, once they were.
          reviewed: {
            graphHash: review?.graphHash ?? request.graphHash,
            policyGeneration,
          },
        })
    );
    if (decided !== undefined) {
      onDecided();
    }
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
        <p>
          {more > 0 ? (
            <Plural
              value={more}
              one={`${shown} and # more`}
              other={`${shown} and # more`}
            />
          ) : (
            shown
          )}
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
        <p className="text-muted-foreground">
          <Trans>
            Grasp resolved these packages from the npm registry and checked each
            one&apos;s files against the registry&apos;s hash. A licence is as
            the package states it.
          </Trans>
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
      {review === undefined && request.summary.findings.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Findings findings={request.summary.findings} />
          {moreFindings > 0 ? (
            <p className="text-muted-foreground">
              <Plural
                value={moreFindings}
                one="And # more finding: show every package to read it."
                other="And # more findings: show every package to read them."
              />
            </p>
          ) : null}
        </div>
      ) : null}
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
          aria-describedby={review === undefined ? hintId : undefined}
          aria-label={t`Approve the packages for ${engine}`}
          disabled={busy || review === undefined}
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
      {review === undefined ? (
        <p className="text-muted-foreground" id={hintId}>
          <Trans>Show every package before you approve them.</Trans>
        </p>
      ) : null}
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
