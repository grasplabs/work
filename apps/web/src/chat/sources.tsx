import type { ChatProvenance } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Plural, Trans } from "@lingui/react/macro";
import { BookOpenIcon, CableIcon, ChevronDownIcon } from "lucide-react";

// What the chat's answers may hold, in the prototype's sources look
// (grasplabs/prototype `components/ai-elements/sources.tsx`): the
// sources core says the chat read from, each by its name where the page
// knows it (a connection), else by its ID. Only what core reports: the
// page never guesses a source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
}

export const ChatSources = ({
  provenance,
  names,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
}) => {
  const { sources, restricted } = provenance;
  const count = sources.length;
  if (count === 0 && !restricted) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-start gap-2 text-xs">
      {restricted ? (
        <Badge variant="attention">
          <Trans>Restricted</Trans>
        </Badge>
      ) : null}
      {count === 0 ? null : (
        <details className="group text-primary">
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <BookOpenIcon aria-hidden="true" className="size-3.5" />
            <span className="font-medium">
              <Plural
                one="Answers draw on # source"
                other="Answers draw on # sources"
                value={count}
              />
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 transition-transform group-open:rotate-180"
            />
          </summary>

          <ul className="mt-3 flex w-fit flex-col gap-2">
            {sources.map((id) => {
              const name = names.get(id)?.name ?? id;
              return (
                <li key={id}>
                  <span className="flex items-center gap-2 font-medium">
                    <CableIcon aria-hidden="true" className="size-4" />
                    {name}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
};
