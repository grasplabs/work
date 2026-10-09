import type { PendingAction } from "@grasp-os/shared/connect";
import type { Permission } from "@grasp-os/shared/permissions";
import { useLingui, Trans } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";

import {
  askedAgain,
  grantReviewed,
  objectOf,
  RecordTypeClaims,
  reviewedVersion,
  reviewedVersionText,
  subjectOf,
} from "../activity/pending.tsx";
import type { PendingRequests } from "../activity/pending.tsx";
import { changeThenRefresh } from "../change-then-refresh.ts";
import {
  confirmHeld,
  declineHeld,
  HeldWriteDetails,
  useHeldName,
  useShown,
} from "../chat/held-writes.tsx";
import type { Session } from "../core.ts";
import { formatTime, personName } from "../directory.ts";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { PileCard } from "./pile-card.tsx";
import type { Pile } from "./pile-card.tsx";

// The cards of the dashboard's pile besides packages
// (`dependency-requests.tsx`): a change an agent wants to make, held until
// the person approves or rejects it, and a permission an App or agent
// asked for, which an admin decides. Each answer goes to core with the
// same calls the chat's held writes and the approvals always made, and the
// pile is read again however it went: a failed answer may have changed
// something too.

/**
 * A held write: approving it is for what the person was shown, all of it,
 * so the card shows what will be sent, and its yes waits while part of
 * that is cut short.
 */
export const HeldCard = ({
  action,
  pile,
}: {
  action: PendingAction;
  pile: Pile;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const shown = useShown(action);
  const who = useHeldName(action);
  const connection = action.connectionName ?? action.connectionId;
  const decide = async (
    decision: (session: Session) => Promise<unknown>,
    said: string
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await decision(session);
          pile.answered(said);
        },
        async () => {
          // `sync` waits for the read, so the buttons stay off until the card goes.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const { context } = action;
  return (
    <PileCard
      busy={busy}
      details={<HeldWriteDetails action={action} shown={shown} />}
      failure={failure}
      name={
        context.type === "chat" ? (
          <Link
            className="hover:underline focus-visible:underline"
            search={{ chat: context.chatId }}
            to="/"
          >
            {who}
          </Link>
        ) : (
          who
        )
      }
      no={{
        label: t`Reject`,
        name: t`Reject ${who}`,
        does: t`Nothing is sent or changed on ${connection}.`,
        onPress: () => {
          void decide(declineHeld(action), t`Rejected: ${who}.`);
        },
      }}
      pile={pile}
      yes={{
        label: t`Approve`,
        name: t`Approve ${who}`,
        does: t`Grasp makes this change on ${connection}, with exactly what is shown.`,
        disabled: shown.unseen,
        describedBy: shown.unseen ? shown.unseenId : undefined,
        onPress: () => {
          void decide(confirmHeld(action), t`Approved: ${who}.`);
        },
      }}
    />
  );
};

/**
 * A permission request: what asks for what, as which binding, the version
 * of its App the grant trusts, and who asked. Approving grants it for that
 * version; core refuses once another is current, and the card shows that
 * one. Rejecting is asked once more: it can't be granted later.
 */
export const RequestCard = ({
  request,
  pending: { directory, exports },
  pile,
}: {
  request: Permission;
  pending: PendingRequests;
  pile: Pile;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const subject = subjectOf(request, directory);
  const object = objectOf(request, directory, exports);
  const actions = formatList(request.actions);
  const who = t`${subject}: ${actions} on ${object}`;
  const { binding } = request;
  const version = reviewedVersionText(request, directory);
  const again = askedAgain(request, directory);
  const requester = personName(directory, request.requestedBy);
  const date = formatTime(request.requestedAt);
  const decide = async (
    change: (permissions: Session["permissions"]) => Promise<unknown>,
    said: string
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await change(session.permissions);
          pile.answered(said);
        },
        async () => {
          // `sync` waits for the read, so the buttons stay off until the list is back.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <PileCard
      busy={busy}
      details={
        <div className="text-muted-foreground flex flex-col gap-1">
          <p>
            <Trans>as {binding}</Trans>
          </p>
          {request.chat === null ? null : (
            <p>
              <Trans>In one chat only, for {requester}</Trans>
            </p>
          )}
          <RecordTypeClaims directory={directory} request={request} />
          <p>
            <Trans>Version to review: {version}</Trans>
          </p>
          <p>
            <Trans>
              Asked by {requester} on {date}
            </Trans>
          </p>
          {request.requestedVia === null ? null : (
            <p>
              <Trans>asked for by the agent, in their chat</Trans>
            </p>
          )}
          {again === undefined ? null : <p>{again}</p>}
        </div>
      }
      failure={failure}
      name={who}
      no={{
        label: t`Reject`,
        name: t`Reject ${who}`,
        does: t`${who} can't be granted later: it has to ask again.`,
        confirm: {
          title: t`Reject this request?`,
          description: t`${who} can't be granted later: it has to ask again.`,
        },
        onPress: () => {
          void decide(
            async (permissions) => await permissions.revoke(request.id),
            t`Rejected: ${who}.`
          );
        },
      }}
      pile={pile}
      yes={{
        label: t`Approve`,
        name: t`Approve ${who}`,
        does: t`${subject} gets this permission from now on.`,
        onPress: () => {
          void decide(
            async (permissions) =>
              await grantReviewed(
                permissions,
                request,
                reviewedVersion(request, directory)
              ),
            t`Approved: ${who}.`
          );
        },
      }}
    />
  );
};
