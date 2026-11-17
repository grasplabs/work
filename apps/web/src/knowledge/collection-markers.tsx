import { readOnlySources } from "@grasp-os/shared/knowledge";
import type { Collection, CollectionAccess } from "@grasp-os/shared/knowledge";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Badge } from "../grasp/badge/index.ts";
import { Company, Key, Lock, People } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

/** Who may read a collection, in words. */
const accessLabels: Readonly<Record<CollectionAccess, MessageDescriptor>> = {
  everyone: msg`Everyone`,
  teams: msg`Teams`,
  me: msg`Only the owner`,
  admins: msg`Admins`,
};

/** Whether nobody may change `collection` here: Grasp or an App writes it. */
const isReadOnly = ({ source }: Collection): boolean =>
  readOnlySources.has(source);

const styles = stylex.create({
  markers: { display: "flex", flexWrap: "wrap", gap: grasp.space1 },
});

/** Who may read a collection, and whether it is sensitive or read-only. */
export const CollectionMarkers = ({
  collection,
}: {
  collection: Collection;
}) => (
  <span {...stylex.props(styles.markers)}>
    <Badge>{i18n._(accessLabels[collection.access])}</Badge>
    {collection.sensitive ? (
      <Badge tone="attention">
        <Trans>Sensitive</Trans>
      </Badge>
    ) : null}
    {isReadOnly(collection) ? (
      <Badge>
        <Trans>Read-only</Trans>
      </Badge>
    ) : null}
  </span>
);

const accessIcons: Readonly<Record<CollectionAccess, IconData>> = {
  everyone: Company,
  teams: People,
  me: Lock,
  admins: Key,
};

/** A collection's icon in the navigation, by who may read it. */
export const collectionIconOf = (
  collection: Pick<Collection, "access">
): IconData => accessIcons[collection.access];
