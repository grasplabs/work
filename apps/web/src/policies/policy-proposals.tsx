import type { RuleProposal } from "@grasp-os/shared/policies";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, RotateCcwIcon } from "lucide-react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// What an admin decides about what Grasp read in a policy (core's
// policy-reading.ts): keeping a proposed rule, which core makes a watching
// rule from the policy, or leaving it out; and having a policy read again
// whose reading failed. Each is core's own call, which takes it from the
// organization's own admins alone and audits it; the page is read again
// after it, whatever core answered.

/** Runs `change` on core, then reads the page again: `busy` meanwhile, and why core refused. */
const useChangeThenRefresh = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const change = (action: (session: Session) => Promise<unknown>): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => await action(session),
        async () => {
          await router.invalidate();
        }
      );
    });
  };
  return { busy, failure, change };
};

/** What was decided about a proposal, once it was. */
export const ProposalDecided = ({
  decision,
}: {
  decision: RuleProposal["decision"];
}) => {
  if (decision === "accepted") {
    return (
      <Badge variant="secondary">
        <CheckIcon data-icon="inline-start" />
        <Trans context="a proposed rule an admin kept">Kept</Trans>
      </Badge>
    );
  }
  if (decision === "rejected") {
    return (
      <Badge variant="outline">
        <Trans context="a proposed rule an admin left out">Left out</Trans>
      </Badge>
    );
  }
  return null;
};

/** An admin's choice on an open proposal: keep it as a watching rule, or leave it out. */
export const ProposalChoice = ({
  policyId,
  proposal,
}: {
  policyId: string;
  proposal: RuleProposal;
}) => {
  const { busy, failure, change } = useChangeThenRefresh();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            change(
              async (session) =>
                await session.policies.acceptProposal(policyId, proposal.id)
            );
          }}
          size="sm"
        >
          {busy ? <Spinner data-icon="inline-start" /> : null}
          <Trans context="keep a proposed rule">Keep</Trans>
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            change(
              async (session) =>
                await session.policies.rejectProposal(policyId, proposal.id)
            );
          }}
          size="sm"
          variant="outline"
        >
          <Trans context="leave out a proposed rule">Leave out</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** Has Grasp read a policy again whose reading failed. */
export const ReadAgain = ({ policyId }: { policyId: string }) => {
  const { busy, failure, change } = useChangeThenRefresh();
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        disabled={busy}
        onClick={() => {
          change(async (session) => await session.policies.readAgain(policyId));
        }}
        size="sm"
        variant="outline"
      >
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RotateCcwIcon data-icon="inline-start" />
        )}
        {busy ? <Trans>Reading…</Trans> : <Trans>Read it again</Trans>}
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
