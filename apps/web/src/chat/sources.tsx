import type { ChatProvenance } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Source,
  SourceIcon,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@grasp-os/ui/components/sources";
import { Icon, LinkIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";

// What the chat's answers drew on, on Damsko's Sources, under the last
// answer's words (thread.tsx): the connections core says the chat read
// from, each by the name the Connectors page gives it, as a pile that
// opens into their list, each opening on the Connectors page; whether the
// chat's agent was restricted beside it. Only what core reports: the page
// never guesses a source, and never shows one's ID.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
}

/** The pile's marks: a few, as Sources reads well. */
const pileMarks = 3;

const styles = stylex.create({
  // The Restricted badge beside the pile.
  sources: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
});

export const ChatSources = ({
  provenance,
  names,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { sources, restricted } = provenance;
  if (sources.length === 0 && !restricted) {
    return null;
  }
  return (
    <div {...stylex.props(styles.sources)}>
      {restricted ? <Badge variant="warning">{t`Restricted`}</Badge> : null}
      {sources.length === 0 ? null : (
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
      )}
    </div>
  );
};
