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

// What the chat's answers drew on, on Damsko's Sources: the connections
// core says the chat read from, as a pile that opens into their list,
// each opening on the integrations page; whether the chat's agent was
// restricted beside it. Only what core reports: the page never guesses a
// source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
}

/** The pile's marks: a few, as Sources reads well. */
const pileMarks = 3;

const styles = stylex.create({
  // What the chat read, under its last answer, before the box.
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
              // since): said as it is, and nothing to open.
              return name === undefined ? (
                <Source access="locked" key={id} origin={t`Unknown`} title={id}>
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
