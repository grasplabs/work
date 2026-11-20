// Add connection's own words, in English. The product gives them in its languages through
// GraspWords (src/words), or one instance gives its own through `words`.
export const addConnectionWords = {
  /** The button that opens the sheet. */
  trigger: "Add a connection",
  /** The sheet's title. */
  title: "Add a connection",
  /** The close button in the sheet's corner. */
  close: "Close",
  /** The search field's name and placeholder. */
  search: "Search providers",
  /** The search field's clear button. */
  clearSearch: "Clear search",
  /** Said when no provider matches the search. */
  noResults: (query: string) => `Nothing matches “${query}”.`,
  /** The quiet words at the end of a tile already connected. */
  addAnother: "Add another",
  /** Said after a connected tile's host, for a screen reader. */
  connected: "Connected",
  /** The key step's back control. */
  back: "All providers",
  /** The key step's form, named by the provider. */
  stepName: (name: string) => `Connect ${name}`,
  key: "Key",
  keyMissing: "Paste the key.",
  showKey: "Show key",
  hideKey: "Hide key",
  paste: "Paste",
  name: "Name",
  /** After the name's label: it may be left empty. */
  nameOptional: "Optional",
  nameNote: "To tell this key from others.",
  address: "Address",
  addressPlaceholder: "https://models.example.com/v1",
  addressMissing: "Enter your endpoint's address.",
  addressWrong: "Enter an address that starts with https://.",
  /** The link out to where the provider gives keys. */
  getKey: (name: string) => `Get a key from ${name}`,
  cancel: "Cancel",
  connect: "Connect",
  connecting: "Connecting",
  /** Under the key when the host refused it with no reason of its own. */
  refused: "That key didn't work.",
  /** The success state's title, its line and its one action. */
  connectedTitle: (name: string) => `${name} is connected`,
  connectedDetail: "Its models are ready to use.",
  done: "Done",
};

export type AddConnectionWords = typeof addConnectionWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    addConnection: AddConnectionWords;
  }
}
