import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import type {
  ArtifactTrust,
  DecidedBuild,
  ScreenTrustReview,
} from "@grasp-os/shared/screen-trust";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Whether an engine's apps get its data (core's screen-trust.ts): an
// admin reads the code of the current version's apps and approves exactly
// that here, and takes an approval back, of this version's or an earlier
// one's. Core decides who may (the organization's own admins) and what is
// approved (what it builds, named by what this page was shown); the page
// only offers it to those core lets decide.

const trustLabels: Readonly<Record<ArtifactTrust, MessageDescriptor>> = {
  unreviewed: msg`Not approved`,
  approved: msg`Approved`,
  revoked: msg`Approval taken back`,
};

/** A change to what core holds, then the page read again. */
type Decide = (
  change: (trust: Session["screenTrust"]) => Promise<unknown>
) => Promise<void>;

/**
 * The source a version's apps are built from, read when asked for: what
 * an approval of that version's code stands for.
 */
const VersionSource = ({ app, version }: { app: string; version: number }) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [files, setFiles] = useState<[string, string][]>();
  const read = async (): Promise<void> => {
    const source = await run(
      async (session) => await session.screenTrust.source(app, version)
    );
    if (source !== undefined) {
      setFiles(Object.entries(source));
    }
  };
  if (files === undefined) {
    return (
      <div className="flex flex-col gap-1">
        <div>
          <Button
            disabled={busy}
            onClick={() => {
              void read();
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Read the code of version {version}</Trans>
          </Button>
        </div>
        <ErrorText>{failure}</ErrorText>
      </div>
    );
  }
  return (
    <section
      aria-label={t`The code of version ${version}`}
      className="flex flex-col gap-2"
    >
      <h3 className="text-sm font-medium">
        <Trans>The code of version {version}</Trans>
      </h3>
      {files.map(([path, code]) => (
        <details key={path}>
          <summary className="font-mono text-xs">{path}</summary>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
            <code className="font-mono">{code}</code>
          </pre>
        </details>
      ))}
    </section>
  );
};

/** A button that takes back the approval of `artifact`. */
const TakeBack = ({
  app,
  artifact,
  screen,
  busy,
  decide,
}: {
  app: string;
  artifact: string;
  screen: string;
  busy: boolean;
  decide: Decide;
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-label={t`Take back the approval of ${screen}`}
      disabled={busy}
      onClick={() => {
        void decide(async (screenTrust) => {
          await screenTrust.revoke(app, artifact);
        });
      }}
      size="xs"
      variant="outline"
    >
      <Trans>Take back</Trans>
    </Button>
  );
};

/** Decisions on earlier versions' apps, any approval of which can be taken back. */
const EarlierDecisions = ({
  app,
  decided,
  busy,
  decide,
}: {
  app: string;
  decided: DecidedBuild[];
  busy: boolean;
  decide: Decide;
}) => {
  const { i18n } = useLingui();
  const versions = [...new Set(decided.map(({ version }) => version))];
  return (
    <section
      aria-labelledby="engine-earlier-approvals"
      className="flex flex-col gap-3"
    >
      <h3 className="text-sm font-medium" id="engine-earlier-approvals">
        <Trans>Earlier versions</Trans>
      </h3>
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">
                <Trans>App</Trans>
              </TableHead>
              <TableHead className="w-24" variant="card">
                <Trans>Version</Trans>
              </TableHead>
              <TableHead className="w-48" variant="card">
                <Trans>Status</Trans>
              </TableHead>
              <TableHead className="w-40" variant="card" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {decided.map(({ artifact, screen, version, trust }) => (
              <TableRow key={artifact}>
                <TableCell variant="card">{screen}</TableCell>
                <TableCell variant="card">{version}</TableCell>
                <TableCell variant="card">
                  {i18n._(trustLabels[trust])}
                </TableCell>
                <TableCell className="text-right" variant="card">
                  {trust === "approved" ? (
                    <TakeBack
                      app={app}
                      artifact={artifact}
                      busy={busy}
                      decide={decide}
                      screen={screen}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {versions.map((version) => (
        <VersionSource app={app} key={version} version={version} />
      ))}
    </section>
  );
};

/**
 * The current version's apps, each with what core holds about its code,
 * the code itself, and the decisions; then earlier versions' decisions.
 */
export const ScreenApproval = ({ review }: { review: ScreenTrustReview }) => {
  const router = useRouter();
  const { i18n } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const { app, version, generation, screens } = review;
  const decide: Decide = async (change) => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await change(session.screenTrust),
        async () => {
          // `sync` waits for the loader, so the controls stay off until
          // what they act on is back.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const current = new Set(builtArtifacts(screens));
  const earlier = review.decided.filter(
    ({ artifact }) => !current.has(artifact)
  );
  const waiting = screens.some(({ trust }) => trust !== "approved");
  // Approving names every screen's build: only once all of them build.
  const allBuild = screens.every(({ artifact }) => artifact !== null);
  if (screens.length === 0 && earlier.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="engine-approval" className="flex flex-col gap-3">
      <h2 className="font-medium" id="engine-approval">
        <Trans>Approval</Trans>
      </h2>
      {review.output === "ordinary" ? (
        <p className="text-muted-foreground max-w-prose">
          <Trans>
            An admin said this engine&apos;s data may go to apps nobody
            approved, so its apps run without approval, unless their approval
            was taken back.
          </Trans>
        </p>
      ) : (
        <p className="text-muted-foreground max-w-prose">
          <Trans>
            An app is code that runs in people&apos;s browsers. It gets this
            engine&apos;s data only once an admin has approved exactly that
            code, and a change to the code needs a new approval. Read the code
            first: approved code can still send what it gets somewhere else, so
            approving says you trust it.
          </Trans>
        </p>
      )}
      {screens.length === 0 ? null : (
        <>
          <div className="bg-card overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead variant="card">
                    <Trans>App</Trans>
                  </TableHead>
                  <TableHead className="w-48" variant="card">
                    <Trans>Status</Trans>
                  </TableHead>
                  <TableHead className="w-40" variant="card" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {screens.map(({ screen, artifact, trust }) => (
                  <TableRow key={screen}>
                    <TableCell variant="card">{screen}</TableCell>
                    <TableCell variant="card">
                      {artifact === null ? (
                        <Trans>Doesn&apos;t build now</Trans>
                      ) : (
                        i18n._(trustLabels[trust])
                      )}
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      {trust === "approved" && artifact !== null ? (
                        <TakeBack
                          app={app}
                          artifact={artifact}
                          busy={busy}
                          decide={decide}
                          screen={screen}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <VersionSource app={app} key={version} version={version} />
        </>
      )}
      {waiting && allBuild ? (
        <div>
          <Button
            disabled={busy}
            onClick={() => {
              void decide(
                async (screenTrust) =>
                  await screenTrust.approve(app, {
                    version,
                    generation,
                    artifacts: builtArtifacts(screens),
                  })
              );
            }}
            size="sm"
          >
            <Trans>Approve the apps of version {version}</Trans>
          </Button>
        </div>
      ) : null}
      {earlier.length === 0 ? null : (
        <EarlierDecisions
          app={app}
          busy={busy}
          decide={decide}
          decided={earlier}
        />
      )}
      <ErrorText>{failure}</ErrorText>
    </section>
  );
};
