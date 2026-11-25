import {
  Source,
  SourceIcon,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@grasp-os/ui/components/sources";
import { Icon, LinkIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";

// What the chat's answers drew on, on Damsko's Sources, under the last
// answer's words (thread.tsx): the connections core says the chat read
// from, each by the name the Connectors page gives it, as a pile that
// opens into their list, each opening on the Connectors page. Only what
// core reports: the page never guesses a source, and never shows one's ID.
// The list is the chat's whole provenance, which core keeps for the chat,
// not per answer: the last answer folds it.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
}

/** The pile's marks: a few, as Sources reads well. */
const pileMarks = 3;

export const ChatSources = ({
  sources,
  names,
}: {
  sources: readonly string[];
  names: ReadonlyMap<string, SourceName>;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  if (sources.length === 0) {
    return null;
  }
  return (
    <Sources>
      <SourcesTrigger count={sources.length}>
        {sources.slice(0, pileMarks).map((id) => (
          <SourceIcon key={id}>
            <Icon icon={LinkIcon} />
          </SourceIcon>
        ))}
      </SourcesTrigger>
      <SourcesContent>
        {sources.map((id) => {
          const name = names.get(id)?.name;
          // One Grasp can't name (its list was refused, or it is gone
          // since): said so, never by its ID, and nothing to open.
          return name === undefined ? (
            <Source
              access="locked"
              key={id}
              origin={t`Connection`}
              title={t`Unknown source`}
            >
              <SourceIcon>
                <Icon icon={LinkIcon} />
              </SourceIcon>
            </Source>
          ) : (
            <Source
              key={id}
              onOpen={() => {
                void navigate({ to: "/connectors", search: {} });
              }}
              origin={t`Connection`}
              title={name}
            >
              <SourceIcon>
                <Icon icon={LinkIcon} />
              </SourceIcon>
            </Source>
          );
        })}
      </SourcesContent>
    </Sources>
  );
};
