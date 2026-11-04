import type {
  DependencyApprover,
  DependencyApproverSubject,
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
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import {
  PeopleTeamsPicker,
  readPeopleAndTeams,
  subjectKey,
} from "../people/people-teams-picker.tsx";
import type { PeopleAndTeams } from "../people/people-teams-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SettingsSection } from "./settings-parts.tsx";

// Settings › Packages › Who approves packages: the members and
// teams an admin gave `dependencies.approve`, the one permission that
// decides an App's or a workflow's npm packages. No role includes it, an
// admin's neither, so until someone is given it here every package
// request waits. Admins see who holds it and give or take it away; Grasp
// staff only see. Core checks all of it on every call (that the caller is
// still an admin, never staff; that the member or team is there) and
// records each grant and revoke in the audit log; the page only offers.

/** The key of a member or team, the same for a grant and a candidate. */
const keyOf = (subject: DependencyApproverSubject): string =>
  subjectKey(
    subject.type === "person"
      ? { type: "person", id: subject.userId }
      : { type: "team", id: subject.teamId }
  );

/** Who approves packages, for an admin; `editable` for one who isn't Grasp staff. */
export const PackageApprovers = ({
  approvers,
  editable,
}: {
  /** Every grant core returned, revoked ones included. */
  approvers: readonly DependencyApprover[];
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [candidates, setCandidates] = useState<PeopleAndTeams | null>(null);
  const active = approvers.filter(({ status }) => status === "active");
  const holding = new Set(active.map(({ subject }) => keyOf(subject)));
  const readCandidates = async (): Promise<void> => {
    if (candidates !== null) {
      return;
    }
    const read = await run(readPeopleAndTeams);
    if (read !== undefined) {
      setCandidates(read);
    }
  };
  const refresh = async (): Promise<void> => {
    await router.invalidate({ sync: true });
  };
  const grant = async (subject: DependencyApproverSubject): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await session.dependencies.grantApprover(subject),
        refresh
      );
    });
  };
  const revoke = async (id: string): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await session.dependencies.revokeApprover(id),
        refresh
      );
    });
  };
  return (
    <SettingsSection
      action={
        editable ? (
          <PeopleTeamsPicker
            candidates={candidates}
            disabled={busy}
            holding={holding}
            label={<Trans>Add approver</Trans>}
            onOpen={() => {
              void readCandidates();
            }}
            onPick={({ type, id }) => {
              // Offered no roles: no role approves packages.
              if (type === "person") {
                void grant({ type: "person", userId: id });
              } else if (type === "team") {
                void grant({ type: "team", teamId: id });
              }
            }}
          />
        ) : undefined
      }
      description={
        <Trans>
          The people and teams who approve or deny the npm packages Apps and
          workflows ask for. No role includes this, not even admin: add yourself
          to approve packages.
        </Trans>
      }
      title={t`Who approves packages`}
    >
      {failure === undefined ? null : (
        <div className="border-t px-5 py-3">
          <ErrorText>{failure}</ErrorText>
        </div>
      )}
      {active.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>
            Nobody approves packages yet, so every package request waits.
          </Trans>
        </p>
      ) : (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Name</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Kind</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Added</Trans>
                </TableHead>
                {editable ? (
                  <TableHead>
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map(({ id, subject, name, grantedAt }) => {
                const named = name ?? t`Removed`;
                return (
                  <TableRow key={id}>
                    <TableCell>{named}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {subject.type === "team" ? t`Team` : t`Person`}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <time dateTime={grantedAt}>
                        {formatDateTime(grantedAt)}
                      </time>
                    </TableCell>
                    {editable ? (
                      <TableCell className="text-right">
                        <Button
                          aria-label={t`Remove ${named} as an approver`}
                          disabled={busy}
                          onClick={() => {
                            void revoke(id);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          <Trans>Remove</Trans>
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsSection>
  );
};
