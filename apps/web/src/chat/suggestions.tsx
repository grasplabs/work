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
export const Suggestions = ({
  disabled = false,
  onPick,
}: {
  disabled?: boolean;
  onPick: (question: string) => void;
}) => {
  const { t, i18n } = useLingui();
  return (
    <ul aria-label={t`Questions to start with`} className="flex flex-col">
      {suggestions.map((suggestion) => {
        const question = i18n._(suggestion);
        return (
          <li className="flex" key={suggestion.id}>
            <button
              className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 min-w-0 flex-1 truncate rounded-lg px-4.5 py-2 text-left text-sm transition-colors duration-150 outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50"
              disabled={disabled}
              onClick={() => {
                onPick(question);
              }}
              type="button"
            >
              {question}
            </button>
          </li>
        );
      })}
    </ul>
  );
};
