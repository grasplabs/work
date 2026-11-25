import { useLingui } from "@lingui/react/macro";

// What the Add a provider sheet says, in the page's language. The old
// library took these as its `addConnection` words; here they come from
// Lingui, and the sheet's host may give its own over them.

/** The sheet's words, translated. */
export const useAddConnectionWords = () => {
  const { t } = useLingui();
  return {
    /** The button that opens the sheet. */
    trigger: t`Add a connection`,
    /** The sheet's title. */
    title: t`Add a connection`,
    /** The search field's name and placeholder. */
    search: t`Search providers`,
    /** The search field's clear button. */
    clearSearch: t`Clear search`,
    /** Said when no provider matches the search. */
    noResults: (query: string) => t`Nothing matches “${query}”.`,
    /** The quiet words at the end of a tile already connected. */
    addAnother: t`Add another`,
    /** Said after a connected tile's host, for a screen reader. */
    connected: t`Connected`,
    /** The key step's back control. */
    back: t`All providers`,
    /** The key step's form, named by the provider. */
    stepName: (name: string) => t`Connect ${name}`,
    key: t`Key`,
    keyMissing: t`Paste the key.`,
    showKey: t`Show key`,
    hideKey: t`Hide key`,
    paste: t`Paste`,
    name: t`Name`,
    /** After the name's label: it may be left empty. */
    nameOptional: t`Optional`,
    nameNote: t`To tell this key from others.`,
    address: t`Address`,
    addressPlaceholder: "https://models.example.com/v1",
    addressMissing: t`Enter your endpoint's address.`,
    addressWrong: t`Enter an address that starts with https://.`,
    /** The link out to where the provider gives keys. */
    getKey: (name: string) => t`Get a key from ${name}`,
    cancel: t`Cancel`,
    connect: t`Connect`,
    connecting: t`Connecting`,
    /** Under the key when the host refused it with no reason of its own. */
    refused: t`That key didn't work.`,
    /** The success state's title, its line and its one action. */
    connectedTitle: (name: string) => t`${name} is connected`,
    connectedDetail: t`Its models are ready to use.`,
    done: t`Done`,
  };
};

export type AddConnectionWords = ReturnType<typeof useAddConnectionWords>;
