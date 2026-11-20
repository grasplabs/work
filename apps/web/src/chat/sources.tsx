import type { ChatProvenance } from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";

import { Badge } from "../grasp/badge/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { SourceList, Sources } from "../grasp/sources/index.ts";
import type { Source, SourcesLabels } from "../grasp/sources/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// What the chat's answers may hold, on Grasp UI's parts: the connections
// core says the chat read from, as the library's SourceList, each opening
// on its integration's page. Only what core reports: the page never
// guesses a source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
  /** A connection's integration, as the address names it (`native:microsoft`); none for an HTTP connection. */
  integration?: string;
  /** A connection's app, whose mark it wears. */
  brand?: Brand;
}

const styles = stylex.create({
  // What the chat read, under its last answer, before the box.
  sources: {
    display: "grid",
    gap: grasp.space2,
  },
  // The badge at its own width, over the list's full one.
  restricted: { justifySelf: "start" },
});

/**
 * What the chat's answers drew on, as core says: whether the chat's agent
 * was restricted, and the connections it read, as the library's pile of
 * sources, opened into its list.
 */
export const ChatSources = ({
  provenance,
  names,
  sourcesShown = true,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
  /** Whether the sources show: not where something nearer says it, or wants the eye. */
  sourcesShown?: boolean;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { restricted } = provenance;
  const read = (sourcesShown ? provenance.sources : []).map((id) => ({
    id,
    name: names.get(id),
  }));
  if (read.length === 0 && !restricted) {
    return null;
  }
  const items = read.map(({ id, name }): Source => {
    // One Grasp can't name (its list was refused, or it is gone since):
    // said as it is, and nothing to open.
    if (name === undefined) {
      return {
        kind: "record",
        title: id,
        origin: t`Unknown`,
        access: "locked",
      };
    }
    return {
      kind: "record",
      title: name.name,
      origin: t`Connection`,
      ...(name.brand === undefined ? {} : { brand: name.brand }),
    };
  });
  // What the chat reads are connections, not single records: the pile
  // says so.
  const labels: Partial<SourcesLabels> = {
    kind: (_kind, count) =>
      t`${plural(count, { one: "# connection", other: "# connections" })}`,
  };
  return (
    <div {...stylex.props(styles.sources)}>
      {restricted ? (
        <Badge layout={styles.restricted} tone="attention">
          {t`Restricted`}
        </Badge>
      ) : null}
      {items.length === 0 ? null : (
        <Sources
          items={items}
          labels={labels}
          onOpen={(_source, index) => {
            const source = read[index];
            if (source?.name === undefined) {
              return;
            }
            if (source.name.integration === undefined) {
              void navigate({ to: "/integrations", search: {} });
            } else {
              void navigate({
                to: "/integrations/$integration",
                params: { integration: source.name.integration },
                search: {},
              });
            }
          }}
        >
          <SourceList />
        </Sources>
      )}
    </div>
  );
};
