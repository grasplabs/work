import { Item, ItemGroup } from "@grasp-os/ui/components/item";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

// Under the box on an empty chat, a few questions to start from
// (grasplabs/prototype `components/chat/suggestions.tsx`): what people
// start with most, each asked with one click. Quiet rows of text rather
// than bordered chips (the kit's quiet Item, touching as the prototype's
// do), so the box stays what the page is about.

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
    <ItemGroup
      aria-label={t`Questions to start with`}
      render={<ul />}
      spacing="none"
    >
      {suggestions.map((suggestion) => {
        const question = i18n._(suggestion);
        return (
          <li key={suggestion.id}>
            <Item
              onClick={() => {
                onPick(question);
              }}
              render={
                <button
                  aria-label={question}
                  disabled={disabled}
                  type="button"
                />
              }
              size="sm"
              variant="quiet"
            >
              {/* A long one ends in an ellipsis on a phone. */}
              <span className="min-w-0 truncate">{question}</span>
            </Item>
          </li>
        );
      })}
    </ItemGroup>
  );
};
