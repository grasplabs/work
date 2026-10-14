import type {
  ResolutionChoice,
  UnknownOutcome,
} from "@grasp-os/shared/connect";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { Described, ExactInput, useShown } from "../chat/held-writes.tsx";
import type { Shown } from "../chat/held-writes.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { PileCard } from "./pile-card.tsx";
import type { Pile } from "./pile-card.tsx";

// A call of unknown outcome on the dashboard's pile, beside the person's
// held actions: a change Grasp sent for them whose answer was lost, so
// nobody can tell whether it took effect (spec 14.3). Only the person it
// acted for sees it, with what was sent, and only they say what became of
// it, each answer asked once more (core's unknown-outcomes.ts). The words
// claim no more than core does: "it happened" sends nothing and undoes
// nothing; "it didn't happen" lets it be sent once more, exactly as
// before, and undoes nothing either. Core reads the person from their
// session and checks the call's permission again before either.

/** What the call does, and where: its tool's title, or its action. */
const useOutcomeName = (outcome: UnknownOutcome): string => {
  const { t } = useLingui();
  const title = outcome.description?.title ?? outcome.key.action;
  const connection = outcome.connectionName ?? outcome.key.connectionId;
  return t`${title} on ${connection}`;
};

/** Where it acted and when it was sent, and what was sent, while kept. */
const OutcomeDetails = ({
  outcome,
  shown,
  unresolvableId,
}: {
  outcome: UnknownOutcome;
  shown: Shown;
  unresolvableId: string;
}) => {
  const { t } = useLingui();
  const { description, resource, input, key } = outcome;
  const connection = outcome.connectionName ?? key.connectionId;
  const tool = key.action;
  const sent = formatDateTime(outcome.sentAt);
  let where = connection;
  if (resource !== null && description !== undefined) {
    where = t`${connection}, ${resource} (${tool})`;
  } else if (resource !== null) {
    where = t`${connection}, ${resource}`;
  } else if (description !== undefined) {
    where = t`${connection} (${tool})`;
  }
  return (
    <div className="flex flex-col gap-2">
      <p>
        <Trans>
          Grasp sent this, but its answer was lost: nobody can tell whether it
          took effect. Check on {connection} before you say.
        </Trans>
      </p>
      <p className="text-muted-foreground">
        <Trans>On {where}</Trans>
      </p>
      <p className="text-muted-foreground">
        <Trans>
          Sent <time dateTime={outcome.sentAt}>{sent}</time>
        </Trans>
      </p>
      {description === undefined || input === null ? null : (
        <Described
          description={description}
          onShowAll={(field) => {
            shown.onShowAll(field);
          }}
        />
      )}
      {input === null ? (
        <p role="note">
          <Trans>
            What was sent is no longer kept: its run&apos;s details were
            removed.
          </Trans>
        </p>
      ) : (
        <>
          {description?.complete === false ? (
            <p role="note">
              <Trans>
                More was sent than is shown above. Read exactly what was sent.
              </Trans>
            </p>
          ) : null}
          <ExactInput
            input={input}
            onOpen={() => {
              shown.onInputOpen();
            }}
            sent
            shown={description?.complete === true}
          />
        </>
      )}
      {outcome.origin === null ? (
        <p className="text-muted-foreground" id={unresolvableId}>
          <Trans>
            Grasp doesn&apos;t know where this came from, so it can&apos;t be
            resolved here.
          </Trans>
        </p>
      ) : null}
      {shown.unseen ? (
        <p className="text-muted-foreground" id={shown.unseenId}>
          <Trans>
            Part of what was sent is cut short above. Show it all, or exactly
            what was sent, before you say it didn&apos;t happen.
          </Trans>
        </p>
      ) : null}
    </div>
  );
};

/**
 * A call of unknown outcome: "It happened" or "It didn't happen", each
 * asked once more. Saying it didn't happen lets it go out again, so, as
 * approving a held change, it waits while part of what was sent is cut
 * short and unseen.
 */
export const OutcomeCard = ({
  outcome,
  pile,
}: {
  outcome: UnknownOutcome;
  pile: Pile;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const shown = useShown(outcome);
  const unresolvableId = useId();
  const who = useOutcomeName(outcome);
  const connection = outcome.connectionName ?? outcome.key.connectionId;
  const unresolvable = outcome.origin === null;
  // The line that says why "It didn't happen" waits, if it does.
  let whyNot: string | undefined;
  if (unresolvable) {
    whyNot = unresolvableId;
  } else if (shown.unseen) {
    whyNot = shown.unseenId;
  }
  const resolve = async (
    choice: ResolutionChoice,
    said: string
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.unknownOutcomes.resolve(
            outcome.key,
            choice,
            outcome.claim
          );
          pile.answered(said);
        },
        async () => {
          // `sync` waits for the read, so the buttons stay off until the card goes.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <PileCard
      busy={busy}
      details={
        <OutcomeDetails
          outcome={outcome}
          shown={shown}
          unresolvableId={unresolvableId}
        />
      }
      failure={failure}
      name={t`Did this happen? ${who}`}
      no={{
        label: t`It didn't happen`,
        name: t`It didn't happen: ${who}`,
        does: t`It can be sent once more, exactly as before. Nothing is undone.`,
        disabled: unresolvable || shown.unseen,
        describedBy: whyNot,
        confirm: {
          title: t`Say it didn't happen?`,
          description: t`Grasp lets it be sent once more, exactly as before, and a run waiting on it sends it again now. Nothing is undone: if it did take effect on ${connection}, it takes effect twice.`,
        },
        onPress: async () => {
          await resolve("not_happened", t`Said it didn't happen: ${who}.`);
        },
      }}
      pile={pile}
      yes={{
        label: t`It happened`,
        name: t`It happened: ${who}`,
        does: t`Grasp never sends it again. Nothing is changed or undone on ${connection}.`,
        // Not held back until everything sent was seen, as "It didn't
        // happen" is: saying it happened sends nothing.
        disabled: unresolvable,
        describedBy: unresolvable ? unresolvableId : undefined,
        confirm: {
          title: t`Say it happened?`,
          description: t`Grasp records your word that it took effect and never sends it again; a run waiting on it goes on without the answer that was lost. Nothing is changed or undone on ${connection}.`,
          variant: "default",
        },
        onPress: async () => {
          await resolve("happened", t`Said it happened: ${who}.`);
        },
      }}
    />
  );
};
