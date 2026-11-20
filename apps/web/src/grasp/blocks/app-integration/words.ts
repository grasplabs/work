// The words an app's tile, panel, page and connect dialog show or say, in English. The product gives
// them in its languages through GraspWords (src/words).
/* oxlint-disable typescript/no-deprecated -- canDo keeps its English beside mayDo until the product stops passing it. */

/** Every word the app's parts show or say. */
export interface AppIntegrationWords {
  connect: string;
  connectAgain: string;
  manage: string;
  /** The panel's way to the app's own page. */
  settings: string;
  signInAgain: string;
  connectAnother: string;
  disconnect: string;
  close: string;
  /** A tile's fact for an app that is not connected: how many tools it has. */
  tools: (count: number) => string;
  /** A tile's fact for a connected app: how many of its tools Grasp may use. */
  allowed: (allowed: number, of: number) => string;
  /** Asks for attention on a tile. */
  needsSignIn: string;
  needsConnect: string;
  account: string;
  connection: string;
  signedInAs: string;
  forWhom: string;
  forYou: string;
  forEveryone: string;
  connectedBy: string;
  status: string;
  works: string;
  signedOut: string;
  stopped: string;
  notConnected: string;
  /** Why a member sees no Connect: only an admin may connect the app. */
  adminConnects: string;
  /** @deprecated The panel says `mayDo` too, as the page does. */
  canDo: string;
  /** What Grasp may do with the app's tools: the page's main card and the panel's section. */
  mayDo: string;
  /** How many tools read and how many change. */
  counts: (reads: number, writes: number) => string;
  /** The bar's key: how many read, how many change. */
  readCount: (count: number) => string;
  changeCount: (count: number) => string;
  /** The two-tone bar's name: how many read against how many change. */
  balance: (reads: number, writes: number) => string;
  allTools: (count: number) => string;
  usedBy: string;
  notUsed: string;
  workflow: string;
  agent: string;
  whoCanUse: string;
  searchTools: string;
  noMatch: string;
  never: string;
  read: string;
  write: string;
  mixed: string;
  /** What each means, in the control's list, for a group of tools. */
  neverNote: string;
  readNote: string;
  writeNote: string;
  mixedNote: string;
  /** What each means for one tool. */
  toolReadNote: string;
  toolWriteNote: string;
  /** A group's or a tool's control, named. */
  choiceOf: (name: string) => string;
  /** A group's disclosure of its tools. */
  showTools: (group: string, count: number) => string;
  other: string;
  readsWord: string;
  changesWord: string;
  /** A description cut at its lines: show it whole, then cut it again. */
  showMore: string;
  showLess: string;
  /** Whether people in the organization may connect the app: the row's name, and its line on and off. */
  offered: string;
  offeredOn: string;
  offeredOff: string;
}

export const appIntegrationWords: AppIntegrationWords = {
  connect: "Connect",
  connectAgain: "Connect again",
  manage: "Manage",
  settings: "Settings",
  signInAgain: "Sign in again",
  connectAnother: "Connect another account",
  disconnect: "Disconnect",
  close: "Close",
  tools: (count) => (count === 1 ? "1 tool" : `${count} tools`),
  allowed: (allowed, of) => `${allowed} of ${of} tools allowed`,
  needsSignIn: "Sign in again",
  needsConnect: "Connect again",
  account: "Account",
  connection: "Connection",
  signedInAs: "Signed in as",
  forWhom: "For",
  forYou: "Only you",
  forEveryone: "Everyone",
  connectedBy: "Connected by",
  status: "Status",
  works: "Connected",
  signedOut: "Signed out",
  stopped: "Stopped working",
  notConnected: "Not connected",
  adminConnects: "An admin connects this",
  canDo: "What Grasp can do",
  mayDo: "What Grasp may do",
  counts: (reads, writes) => `${reads} read · ${writes} change`,
  readCount: (count) => `${count} read`,
  changeCount: (count) => `${count} change`,
  balance: (reads, writes) => `${reads} tools read, ${writes} change`,
  allTools: (count) => `All ${count} tools`,
  usedBy: "Used by",
  notUsed: "Not used yet",
  workflow: "Workflow",
  agent: "Agent",
  whoCanUse: "Who can use it",
  searchTools: "Search tools",
  noMatch: "No tool matches",
  never: "Never",
  read: "Read",
  write: "Write",
  mixed: "Mixed",
  neverNote: "Grasp doesn't use these",
  readNote: "Reads without asking, changes nothing",
  writeNote: "Reads, and asks before each change",
  mixedNote: "Set tool by tool",
  toolReadNote: "Runs without asking",
  toolWriteNote: "Asks before each run",
  choiceOf: (name) => `What Grasp may do: ${name}`,
  showTools: (group, count) => `Show the ${count} ${group} tools`,
  other: "Other",
  readsWord: "Reads",
  changesWord: "Changes",
  showMore: "Show more",
  showLess: "Show less",
  offered: "Available in your organization",
  offeredOn: "Anyone here can connect it.",
  offeredOff: "No one can connect it. Connections already made keep working.",
};

declare module "../../words/words" {
  interface GraspWordsCatalog {
    appIntegration: AppIntegrationWords;
  }
}
