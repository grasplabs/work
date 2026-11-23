import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import { Combobox } from "@grasp-os/ui/components/combobox";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { usePeopleApart } from "../people/people-apart.ts";

const styles = stylex.create({
  owner: { display: "flex", flexDirection: "column", gap: space[2] },
  // Why it can't be changed, and the way to read it again, on one line.
  failed: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
  },
});

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
  const apart = usePeopleApart(people);
  return (
    <div {...stylex.props(styles.owner)}>
      <Combobox
        aria-label={t({ message: "Owner", context: "who answers for an app" })}
        disabled={disabled || answerers === null}
        items={people.map((person) => {
          // A namesake is told apart by the end of their ID.
          const detail = apart.hint(person);
          return {
            value: person.id,
            label: person.name,
            media: (
              <Avatar decorative name={person.name} size="xs">
                <AvatarFallback />
              </Avatar>
            ),
            ...(detail === undefined ? {} : { description: detail }),
          };
        })}
        onValueChange={(id) => {
          if (id !== null && id !== owner.id) {
            onPick(id);
          }
        }}
        value={owner.id}
      />
      {answerers === null ? (
        <div {...stylex.props(styles.failed)}>
          <Alert appearance="subtle" variant="destructive">
            <AlertTitle>{t`Couldn't load who may answer for it.`}</AlertTitle>
          </Alert>
          <Button onClick={onRetry} size="sm" variant="secondary">
            {t`Try again`}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
