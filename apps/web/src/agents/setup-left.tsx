import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatList } from "../format.ts";
import { setupParts, tabOfPart } from "./finish-setup.ts";
import type { SetupOutcome, SetupPart } from "./finish-setup.ts";
import type { AgentTab } from "./tabs.tsx";

// What a new agent's setup couldn't save once it was made, on its page
// (finish-setup.ts): in plain words which parts were saved and which
// weren't, each with why and the tab where it is set, and Try again for
// what is left. Instructions that weren't saved wait as the Instructions
// editor's draft and are saved there; once they are, they count as saved.

const styles = stylex.create({
  parts: {
    display: "grid",
    gap: space["2"],
    margin: 0,
    paddingInlineStart: space["4"],
  },
  part: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space["2"],
  },
});

/** The setup's outcome on the agent's page: see the file's head. */
export const SetupLeft = ({
  name,
  outcome,
  instructionsSaved,
  retry,
  onTab,
  onClose,
}: {
  name: string;
  outcome: SetupOutcome;
  /** Whether its instructions are saved now, from their tab. */
  instructionsSaved: boolean;
  /** Sets what is left again; resolves once done, rejects where it couldn't run. */
  retry: () => Promise<void>;
  /** Opens the tab where a part is set. */
  onTab: (tab: AgentTab) => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const partNames: Record<SetupPart, string> = {
    instructions: t`its instructions`,
    apps: t`its apps`,
    abilities: t`what it may do`,
    reach: t`who can use it`,
    schedule: t`its schedule`,
  };
  const tabNames: Record<AgentTab, string> = {
    overview: t`Overview`,
    instructions: t`Instructions`,
    access: t`Access`,
    schedule: t`Schedule`,
  };
  const unsaved = outcome.unsaved.filter(
    ({ part }) => !(part === "instructions" && instructionsSaved)
  );
  const saved = setupParts.filter(
    (part) =>
      outcome.saved.includes(part) ||
      (part === "instructions" &&
        instructionsSaved &&
        outcome.unsaved.some((each) => each.part === part))
  );
  // Only what the setup can set again: unsaved instructions are saved
  // from their editor, with what was typed.
  const retryable = unsaved.some(({ part }) => part !== "instructions");
  if (unsaved.length === 0) {
    return null;
  }
  const savedList = formatList(saved.map((part) => partNames[part]));
  return (
    <Alert onClose={onClose} variant="warning">
      <AlertTitle>{t`${name} was made, but not all of it was saved`}</AlertTitle>
      <AlertDescription>
        {saved.length === 0 ? null : <p>{t`Saved: ${savedList}.`}</p>}
        <ul {...stylex.props(styles.parts)}>
          {setupParts.flatMap((part) => {
            const found = unsaved.find((each) => each.part === part);
            if (found === undefined) {
              return [];
            }
            const what = partNames[part];
            const { failure } = found;
            const tab = tabNames[tabOfPart[part]];
            return [
              <li key={part} {...stylex.props(styles.part)}>
                <span>
                  {part === "instructions"
                    ? t`Not saved: ${what}. ${failure} What you typed waits on Instructions, to save there.`
                    : t`Not saved: ${what}. ${failure}`}
                </span>
                <Button
                  onClick={() => {
                    onTab(tabOfPart[part]);
                  }}
                  size="sm"
                  variant="link"
                >
                  {t`Open ${tab}`}
                </Button>
              </li>,
            ];
          })}
        </ul>
      </AlertDescription>
      {retryable ? (
        <AlertAction>
          <Button
            errorLabel={t`Not saved`}
            loadingLabel={t`Saving…`}
            onClick={retry}
            size="sm"
            successLabel={t`Saved`}
            variant="outline"
          >
            {t`Try again`}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
};
