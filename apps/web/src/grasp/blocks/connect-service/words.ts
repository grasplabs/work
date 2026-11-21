// Connect service's words, in English, on their own: the product's words
// (frame/part-words.tsx) come with the app, the block itself doesn't.

/** Every word the block shows or says. */
export interface ConnectServiceWords {
  change: string;
  key: string;
  keyNote: string;
  keyMissing: string;
  address: string;
  addressPlaceholder: string;
  addressMissing: string;
  addressWrong: string;
  connect: string;
  connecting: string;
  connected: string;
  notConnected: string;
  replaceKey: string;
  disconnect: string;
  /** The question before disconnecting: "Disconnect Anthropic?". */
  disconnectTitle: (name: string) => string;
  /** What is lost. */
  disconnectDetail: string;
  /** The safe answer. */
  keep: string;
  /** Said while it disconnects, and when it could not. */
  disconnecting: string;
  notDisconnected: string;
  /** The connected row's line: "Key …9c1e · European Union". */
  keyLine: (last: string, region: string | undefined) => string;
  /** The form's name: "Connect Anthropic". */
  connectName: (name: string) => string;
}

export const connectServiceWords: ConnectServiceWords = {
  change: "Change",
  key: "Key",
  keyNote: "Only its last four characters are shown again.",
  keyMissing: "Paste the key.",
  address: "Address",
  addressPlaceholder: "https://models.example.com/v1",
  addressMissing: "Enter your endpoint's address.",
  addressWrong: "Enter an address that starts with https://.",
  connect: "Connect",
  connecting: "Connecting",
  connected: "Connected",
  notConnected: "Not connected",
  replaceKey: "Replace key",
  disconnect: "Disconnect",
  disconnectTitle: (name) => `Disconnect ${name}?`,
  disconnectDetail:
    "Grasp's chat, agents and workflows stop using it, and its key is removed. Connecting again takes a new key.",
  keep: "Keep it",
  disconnecting: "Disconnecting",
  notDisconnected: "Could not disconnect",
  keyLine: (last, region) =>
    region === undefined ? `Key …${last}` : `Key …${last} · ${region}`,
  connectName: (name) => `Connect ${name}`,
};

declare module "../../words/words" {
  interface GraspWordsCatalog {
    connectService: ConnectServiceWords;
  }
}
