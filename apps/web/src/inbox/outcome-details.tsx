import type { UnknownOutcome } from "@grasp-os/shared/connect";
import { Trans, useLingui } from "@lingui/react/macro";

import { Described, ExactInput } from "../chat/held-writes.tsx";
import type { Shown } from "../chat/held-writes.tsx";
import { formatDateTime } from "../format.ts";

// A call of unknown outcome in the inbox (item-detail.tsx), beside the
// person's held actions: a change Grasp sent for them whose answer was lost, so
// nobody can tell whether it took effect (spec 14.3). Only the person it
// acted for sees it, with what was sent, and only they say what became of
// it, each answer asked once more (core's unknown-outcomes.ts). The words
// claim no more than core does: "it happened" sends nothing and undoes
// nothing; "it didn't happen" lets it be sent once more, exactly as
// before, and undoes nothing either. Core reads the person from their
// session and checks the call's permission again before either.

/**
 * Whether core can't check the call's permission, so can't resolve it:
 * where it came from isn't known, or an App's call names no version
 * (`resolutionCapability` in core refuses both).
 */
export const isUnresolvable = ({ key, origin }: UnknownOutcome): boolean =>
  origin === null || (key.subject.type === "app" && origin.appVersion === null);

/**
 * Why what was sent isn't shown: no longer kept, or withheld by core
 * (`withheld`), its run no longer allowed to read what it read, or that
 * not checked now.
 */
const RemovedInput = ({
  withheld,
}: {
  withheld: UnknownOutcome["withheld"];
}) => {
  if (withheld === "revoked") {
    return (
      <Trans>
        What was sent is withheld: the run that sent it may no longer read what
        it read.
      </Trans>
    );
  }
  if (withheld === "unchecked") {
    return (
      <Trans>
        What was sent can&apos;t be shown right now. Try again in a moment.
      </Trans>
    );
  }
  return <Trans>What was sent is no longer kept.</Trans>;
};

/**
 * Where it acted and when it was sent, and what was sent, while kept.
 */
export const OutcomeDetails = ({
  outcome,
  shown,
  unresolvableId,
  removedId,
}: {
  outcome: UnknownOutcome;
  shown: Shown;
  unresolvableId: string;
  removedId: string;
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
        <p id={removedId} role="note">
          <RemovedInput withheld={outcome.withheld} />
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
      {isUnresolvable(outcome) ? (
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
