import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";

import { ErrorText } from "../error-text.tsx";
import { PersonPicker } from "../people/person-picker.tsx";

/** Someone who may answer for an App, as the picker lists them. */
interface Answerer {
  id: string;
  name: string;
}

/**
 * An App's owner, and the picker to name another: from those core says may
 * answer for it (`apps.answerers`). While that list couldn't be read
 * (`answerers` null), the picker is shown but not to be changed, and says
 * so with a way to read it again: never an empty list mistaken for nobody
 * else.
 */
export const AppOwner = ({
  owner,
  answerers,
  disabled,
  onPick,
  onRetry,
}: {
  /** Who answers for it now. */
  owner: Answerer;
  /** Who else may, or null while the list couldn't be read. */
  answerers: readonly Answerer[] | null;
  disabled: boolean;
  onPick: (id: string) => void;
  onRetry: () => void;
}) => {
  const { t } = useLingui();
  // Whoever answers now stays on the list.
  const people =
    answerers === null
      ? [owner]
      : [
          ...new Map(
            [...answerers, owner].map((each) => [each.id, each] as const)
          ).values(),
        ];
  return (
    <div className="flex flex-col gap-2">
      <div className="-ml-2.5">
        <PersonPicker
          align="start"
          disabled={disabled || answerers === null}
          onPick={(picked) => {
            onPick(picked.id);
          }}
          owner={owner.name}
          ownerId={owner.id}
          people={people}
        />
      </div>
      {answerers === null ? (
        <div className="flex items-center gap-2">
          <ErrorText>{t`Couldn't load who may answer for it.`}</ErrorText>
          <Button onClick={onRetry} size="sm" variant="outline">
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
};
