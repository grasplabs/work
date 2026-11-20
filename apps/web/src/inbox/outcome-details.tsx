import type { UnknownOutcome } from "@grasp-os/shared/connect";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Described, ExactInput } from "../chat/held-writes.tsx";
import type { Shown } from "../chat/held-writes.tsx";
import { formatDateTime } from "../format.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A call of unknown outcome, as the Inbox shows it: a change Grasp sent
// for the person whose answer was lost, so nobody can tell whether it took
// effect (spec 14.3). Only the person it acted for sees it, with what was
// sent; the Inbox's item says what became of it (item-detail.tsx).

const styles = stylex.create({
  details: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
});

/**
 * Whether core can't check the call's permission, so can't resolve it:
 * where it came from isn't known, or an App's call names no version
 * (`resolutionCapability` in core refuses both).
 */
export const isUnresolvable = ({ key, origin }: UnknownOutcome): boolean =>
  origin === null || (key.subject.type === "app" && origin.appVersion === null);

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
    <div {...stylex.props(styles.details)}>
      <Text size="sm">
        <Trans>
          Grasp sent this, but its answer was lost: nobody can tell whether it
          took effect. Check on {connection} before you say.
        </Trans>
      </Text>
      <Text size="sm" tone="muted">
        <Trans>On {where}</Trans>
      </Text>
      <Text size="sm" tone="muted">
        <Trans>
          Sent <time dateTime={outcome.sentAt}>{sent}</time>
        </Trans>
      </Text>
      {description === undefined || input === null ? null : (
        <Described
          description={description}
          onShowAll={(field) => {
            shown.onShowAll(field);
          }}
        />
      )}
      {input === null ? (
        <div id={removedId} role="note">
          <Text size="sm">
            <Trans>What was sent is no longer kept.</Trans>
          </Text>
        </div>
      ) : (
        <>
          {description?.complete === false ? (
            <div role="note">
              <Text size="sm">
                <Trans>
                  More was sent than is shown above. Read exactly what was sent.
                </Trans>
              </Text>
            </div>
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
        <Text id={unresolvableId} size="sm" tone="muted">
          <Trans>
            Grasp doesn&apos;t know where this came from, so it can&apos;t be
            resolved here.
          </Trans>
        </Text>
      ) : null}
      {shown.unseen ? (
        <Text id={shown.unseenId} size="sm" tone="muted">
          <Trans>
            Part of what was sent is cut short above. Show it all, or exactly
            what was sent, before you say it didn&apos;t happen.
          </Trans>
        </Text>
      ) : null}
    </div>
  );
};
