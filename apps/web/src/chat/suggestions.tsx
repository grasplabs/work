import { Suggestion, Suggestions } from "@grasp-os/ui/components/suggestions";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

// Under the box on an empty chat, a few questions to start from
// (grasplabs/prototype `components/chat/suggestions.tsx`): what people
// start with most, each asked with one click. Quiet rows of text rather
// than bordered chips, so the box stays what the page is about.

const suggestions: readonly MessageDescriptor[] = [
  msg`Where does the most time still go?`,
  msg`What waits on me today?`,
  msg`Draw how supplier invoices are handled`,
  msg`Which AI tools do people use?`,
];

/** The starting questions; `onPick` asks the one picked, as it reads here. */
export const StartingQuestions = ({
  disabled = false,
  onPick,
}: {
  disabled?: boolean;
  onPick: (question: string) => void;
}) => {
  const { t, i18n } = useLingui();
  return (
    <Suggestions aria-label={t`Questions to start with`}>
      {suggestions.map((suggestion) => {
        const question = i18n._(suggestion);
        return (
          <Suggestion
            disabled={disabled}
            key={suggestion.id}
            onClick={() => {
              onPick(question);
            }}
          >
            {question}
          </Suggestion>
        );
      })}
    </Suggestions>
  );
};
