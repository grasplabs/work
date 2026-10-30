import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { MigrationSample } from "@grasp-os/shared/stores";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A dry run of a version's explicit migration on a sample of the real
// records it would transform (core's migration-samples.ts), from the
// version's review: what core runs before the version may be made current,
// as a failed sample blocks it until a newer one passes. Only the
// organization's own admins may take one, never Grasp staff (it reads
// real records), so only they see the way to.

/** Whether `identity`, if the page has one, may take a sample: an admin of the organization, not Grasp staff. */
export const takesSamples = (
  identity: Pick<Identity, "role" | "staff"> | undefined
): boolean => identity !== undefined && isMemberAdmin(identity);

const isIdentity = (
  value: unknown
): value is Pick<Identity, "role" | "staff"> =>
  typeof value === "object" &&
  value !== null &&
  "role" in value &&
  "staff" in value;

/** What a sample found, in the words of its outcome. */
const SampleOutcome = ({ sample }: { sample: MigrationSample }) => {
  const { t } = useLingui();
  const { rows, failure } = sample;
  if (sample.outcome === "empty") {
    return (
      <p className="text-muted-foreground">
        <Trans>No records are left for it to transform.</Trans>
      </p>
    );
  }
  if (sample.outcome === "passed") {
    return (
      <Badge variant="secondary">
        <Plural
          one="Passed on # real record"
          other="Passed on # real records"
          value={rows}
        />
      </Badge>
    );
  }
  const record = failure?.record ?? null;
  return (
    <div className="flex flex-col gap-1">
      <Badge variant="destructive">
        {record === null
          ? t`It failed as a whole: its code failed, not a record. This version can't be made current until a newer sample passes.`
          : t`It failed on the record ${record}. This version can't be made current until a newer sample passes.`}
      </Badge>
      {failure === null || failure.issues.length === 0 ? null : (
        <code className="font-mono whitespace-pre-wrap">
          {failure.issues.join("\n")}
        </code>
      )}
    </div>
  );
};

/**
 * The way to dry-run migration `migration` of version `version` of App
 * `app` on a sample of its real records, and what the latest sample
 * found; nothing for anyone but the organization's own admins.
 */
export const MigrationSampleControl = ({
  app,
  version,
  migration,
}: {
  app: string;
  version: number;
  migration: string;
}) => {
  const context: unknown = useRouteContext({ strict: false });
  const identity =
    typeof context === "object" && context !== null && "identity" in context
      ? context.identity
      : undefined;
  const { busy, failure, run } = useCoreAction();
  const [sample, setSample] = useState<MigrationSample>();
  if (!takesSamples(isIdentity(identity) ? identity : undefined)) {
    return null;
  }
  const take = async (): Promise<void> => {
    const taken = await run(
      async (session) =>
        await session.stores.sampleMigration({ app, version, migration })
    );
    if (taken !== undefined) {
      setSample(taken);
    }
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        disabled={busy}
        onClick={() => {
          void take();
        }}
        size="sm"
        variant="outline"
      >
        {sample === undefined ? (
          <Trans>Try it on real records</Trans>
        ) : (
          <Trans>Try it again</Trans>
        )}
      </Button>
      {sample === undefined ? null : <SampleOutcome sample={sample} />}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
