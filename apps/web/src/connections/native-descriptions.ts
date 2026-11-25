import type { CatalogEntry, OAuthProvider } from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What Grasp's own connectors are for, in the web's words: connect sends
// no description for them, so each reads in the person's language. Keyed
// by the connector's id, as the catalog names it. A Composio toolkit's
// description is its provider's, and stays as connect sends it.

/** What each of Grasp's own connectors is for, by its id. */
const nativeDescriptions: Readonly<Partial<Record<string, MessageDescriptor>>> =
  {
    microsoft: msg`Outlook mail and calendars, and files in OneDrive and SharePoint.`,
    google: msg`Gmail, Google Calendar, and files in Google Drive.`,
  } satisfies Record<OAuthProvider, MessageDescriptor>;

/**
 * What a catalog entry is for, in a sentence: a native one's in the web's
 * words, any other's as the catalog sends it. Read when rendering.
 */
export const descriptionOf = ({
  source,
  id,
  description,
}: Pick<CatalogEntry, "source" | "id" | "description">): string | null => {
  const words =
    source === "native" && Object.hasOwn(nativeDescriptions, id)
      ? nativeDescriptions[id]
      : undefined;
  return words === undefined ? description : i18n._(words);
};
