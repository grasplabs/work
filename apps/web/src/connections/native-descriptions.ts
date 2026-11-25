import type { OAuthProvider } from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What Grasp's own connectors are for, in the web's words: connect sends
// no description for them, so each reads in the person's language. Keyed
// by the connector's id, as the catalog names it. A Composio toolkit's
// description is its provider's, and stays as connect sends it.

/** A native connector's description: shown in the page's language, matched in English too. */
interface NativeDescription {
  words: MessageDescriptor;
  /**
   * The same sentence in English, which matching reads in every language:
   * people often write an agent's job in English whatever their page's
   * language. Written out because a production build keeps only a
   * message's id.
   */
  english: string;
}

/** What each of Grasp's own connectors is for, by its id. */
const nativeDescriptions: Readonly<Partial<Record<string, NativeDescription>>> =
  {
    microsoft: {
      words: msg`Outlook mail and calendars, and files in OneDrive and SharePoint.`,
      english:
        "Outlook mail and calendars, and files in OneDrive and SharePoint.",
    },
    google: {
      words: msg`Gmail, Google Calendar, and files in Google Drive.`,
      english: "Gmail, Google Calendar, and files in Google Drive.",
    },
  } satisfies Record<OAuthProvider, NativeDescription>;

/** A catalog entry, as far as what it is for goes. */
interface Described {
  source: string;
  id: string;
  description: string | null;
}

/** The web's description of a native entry, if it has one. */
const nativeOf = ({ source, id }: Described): NativeDescription | undefined =>
  source === "native" && Object.hasOwn(nativeDescriptions, id)
    ? nativeDescriptions[id]
    : undefined;

/**
 * What a catalog entry is for, in a sentence: a native one's in the web's
 * words, any other's as the catalog sends it. Read when rendering, so it
 * follows the page's language.
 */
export const descriptionOf = (entry: Described): string | null => {
  const native = nativeOf(entry);
  return native === undefined ? entry.description : i18n._(native.words);
};

/**
 * What a catalog entry is for, as text that typed words are matched
 * against: {@link descriptionOf}, and a native one's English as well.
 */
export const matchedDescriptionOf = (entry: Described): string => {
  const native = nativeOf(entry);
  return native === undefined
    ? (entry.description ?? "")
    : `${i18n._(native.words)} ${native.english}`;
};
