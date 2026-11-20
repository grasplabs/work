import type { Identity } from "@grasp-os/shared/rpc";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatList } from "../format.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import { Doc, Icon, People } from "../grasp/icons/index.ts";
import { ItemGrid } from "../grasp/item/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { IntegrationTile } from "./integration-tile.tsx";
import type { OpenApp } from "./integration-tile.tsx";
import type { Reason, Recommendation } from "./recommended.ts";

// Recommended, the overview's first run of tiles (Ruben's direction B,
// RUB-68): each app with the one reason it is there in place of its tool
// count, a mark before it (the suite's own, a document, people), and one
// line under the heading saying where the reasons come from.

const styles = stylex.create({
  run: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  why: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
  },
  icon: { display: "inline-flex", flexShrink: 0 },
  words: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
});

/** A reason, as the tile says it; `name`, the app's, names the suite. */
const Why = ({ reason, name }: { reason: Reason; name: string }) => {
  const { t } = useLingui();
  let mark = <Icon icon={Doc} />;
  let words: string;
  if (reason.kind === "suite") {
    mark = <BrandIcon brand={reason.suite} decorative size="xs" tile={false} />;
    words = t`You work in ${name}`;
  } else if (reason.kind === "documents") {
    const teams = formatList(reason.teams);
    words =
      reason.teams.length === 0
        ? t`In the company's documents`
        : t`In ${teams} documents`;
  } else {
    mark = <Icon icon={People} />;
    const { people } = reason;
    words = t`${plural(people, { one: "Asked for by # person", other: "Asked for by # people" })}`;
  }
  return (
    <span {...stylex.props(styles.why)}>
      <span aria-hidden="true" {...stylex.props(styles.icon)}>
        {mark}
      </span>
      <span {...stylex.props(styles.words)}>{words}</span>
    </span>
  );
};

/**
 * Where Grasp looks for its reasons, as one sentence: the suite the
 * kickoff names, when it names one Grasp recommends, then the documents
 * and the requests.
 */
const useSources = (recommended: readonly Recommendation[]): string => {
  const { t } = useLingui();
  const suite = recommended.find(({ reason }) => reason.kind === "suite")
    ?.integration.name;
  return suite === undefined
    ? t`From your documents and what people asked for.`
    : t`From your ${suite}, your documents and what people asked for.`;
};

/** The apps to connect first, each saying why; nothing when there are none. */
export const RecommendedApps = ({
  recommended,
  identity,
  open,
  onOpen,
}: {
  recommended: readonly Recommendation[];
  identity: Pick<Identity, "role" | "staff" | "userId">;
  open: string | undefined;
  onOpen: OpenApp;
}) => {
  const { t } = useLingui();
  const sources = useSources(recommended);
  if (recommended.length === 0) {
    return null;
  }
  const title = t({ message: "Recommended", context: "apps to connect first" });
  return (
    <section {...stylex.props(styles.run)}>
      <SectionHeader
        description={sources}
        headingLevel={2}
        size="sm"
        title={title}
      />
      <ItemGrid aria-label={title}>
        {recommended.map(({ integration, reason }) => (
          <IntegrationTile
            fact={<Why name={integration.name} reason={reason} />}
            identity={identity}
            integration={integration}
            key={integration.key}
            onOpen={onOpen}
            open={integration.key === open}
          />
        ))}
      </ItemGrid>
    </section>
  );
};
