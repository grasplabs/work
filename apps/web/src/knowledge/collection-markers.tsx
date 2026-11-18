import { readOnlySources } from "@grasp-os/shared/knowledge";
import type { Collection, CollectionAccess } from "@grasp-os/shared/knowledge";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Badge } from "../grasp/badge/index.ts";
import {
  Company,
  Icon,
  Key,
  Person,
  ReadOnly,
  People,
  ShieldAlert,
} from "../grasp/icons/index.ts";
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
  sensitive: { display: "inline-flex", color: grasp.attention },
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

/**
 * A collection's marks at the end of its row in the navigation: sensitive,
 * and read-only (the struck pencil: may read, not change), each an icon
 * named for a screen reader.
 */
export const CollectionMarks = ({ collection }: { collection: Collection }) => {
  const { t } = useLingui();
  if (!collection.sensitive && !isReadOnly(collection)) {
    return null;
  }
  return (
    <>
      {collection.sensitive ? (
        <span {...stylex.props(styles.sensitive)}>
          <Icon icon={ShieldAlert} label={t`Sensitive`} />
        </span>
      ) : null}
      {isReadOnly(collection) ? (
        <Icon icon={ReadOnly} label={t`Read-only`} />
      ) : null}
    </>
  );
};

const accessIcons: Readonly<Record<CollectionAccess, IconData>> = {
  everyone: Company,
  teams: People,
  me: Person,
  admins: Key,
};

/** A collection's icon in the navigation, by who may read it. */
export const collectionIconOf = (
  collection: Pick<Collection, "access">
): IconData => accessIcons[collection.access];
