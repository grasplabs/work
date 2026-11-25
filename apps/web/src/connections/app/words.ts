import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

// The words an app's tile, panel, page and connect dialog show or say, in
// the page's language: the product's own parts, so their words come
// straight from Lingui, as #2503's catalogue gave them to its library
// blocks (`frame/part-words.tsx`, `appIntegration` and `connectApp`).

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
  /** An app that works but has an account that needs someone: its tile, its state. */
  needsYou: string;
  /** How many apps need someone, said where the page sums up its apps (`AppsState`). */
  appsNeedYou: (count: number) => string;
  /** How many apps are connected, where none needs anyone (`AppsState`). */
  connectedCount: (count: number) => string;
  account: string;
  connection: string;
  signedInAs: string;
  forWhom: string;
  forYou: string;
  forEveryone: string;
  works: string;
  signedOut: string;
  stopped: string;
  notConnected: string;
  /** Why a member sees no Connect: only an admin may connect the app. */
  adminConnects: string;
  /** What Grasp may do with the app's tools: the page's main card and the panel's section. */
  mayDo: string;
  /** How many tools read and how many change. */
  counts: (reads: number, writes: number) => string;
  /** The bar's key: how many read, how many change. */
  readCount: (count: number) => string;
  changeCount: (count: number) => string;
  allTools: (count: number) => string;
  usedBy: string;
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
  other: string;
  /**
   * A tool group's name in the page's language, by its key (`groupKeyOf`:
   * "excel", "todo", "contacts"). Where it gives undefined, the name is
   * read from the tools' ids.
   */
  toolGroup: (key: string) => string | undefined;
  readsWord: string;
  changesWord: string;
  /** A description cut at its lines: show it whole, then cut it again. */
  showMore: string;
  showLess: string;
  /** Whether the app is offered in the organization: the switch's name, and the one line that says what its state means. */
  offered: string;
  offeredOn: string;
  offeredOff: string;
}

/** The app's parts' words, in the page's language. */
export const useAppIntegrationWords = (): AppIntegrationWords => {
  const { t } = useLingui();
  const toolGroups = new Map([
    ["mail", t({ message: "Mail", context: "a group of an app's tools" })],
    [
      "calendar",
      t({ message: "Calendar", context: "a group of an app's tools" }),
    ],
    ["chats", t({ message: "Chats", context: "a group of an app's tools" })],
    ["files", t({ message: "Files", context: "a group of an app's tools" })],
    [
      "meetings",
      t({ message: "Meetings", context: "a group of an app's tools" }),
    ],
    ["lists", t({ message: "Lists", context: "a group of an app's tools" })],
    [
      "sheets",
      t({
        message: "Sheets",
        context: "Google's spreadsheets, a group of tools",
      }),
    ],
    [
      "contacts",
      t({ message: "Contacts", context: "a group of an app's tools" }),
    ],
    [
      "pull requests",
      t({ message: "Pull requests", context: "a group of an app's tools" }),
    ],
    // Product names, the same in every language.
    ["excel", "Excel"],
    ["word", "Word"],
    ["onenote", "OneNote"],
    ["planner", "Planner"],
    ["todo", "To Do"],
    ["sharepoint", "SharePoint"],
    ["onedrive", "OneDrive"],
  ]);
  return {
    connect: t`Connect`,
    connectAgain: t`Connect again`,
    manage: t`Manage`,
    settings: t`Settings`,
    signInAgain: t`Sign in again`,
    connectAnother: t`Connect another account`,
    disconnect: t`Disconnect`,
    close: t`Close`,
    tools: (toolCount) =>
      t`${plural(toolCount, { one: "# tool", other: "# tools" })}`,
    allowed: (allowed, total) =>
      t`${plural(total, { one: `${allowed} of # tool allowed`, other: `${allowed} of # tools allowed` })}`,
    needsSignIn: t`Sign in again`,
    needsConnect: t`Connect again`,
    needsYou: t({ message: "Needs you", context: "state of one app" }),
    appsNeedYou: (count) =>
      t`${plural(count, { one: "# app needs you", other: "# apps need you" })}`,
    connectedCount: (count) =>
      t`${plural(count, { one: "# connected", other: "# connected" })}`,
    account: t`Account`,
    connection: t`Connection`,
    signedInAs: t`Signed in as`,
    forWhom: t`For`,
    forYou: t`Only you`,
    forEveryone: t`Everyone`,
    works: t({ message: "Connected", context: "state of one app" }),
    signedOut: t({ message: "Signed out", context: "state of one app" }),
    stopped: t({ message: "Stopped working", context: "state of one app" }),
    notConnected: t`Not connected`,
    adminConnects: t`An admin connects this`,
    mayDo: t`What Grasp may do`,
    counts: (reads, writes) =>
      t({
        message: `${reads} read · ${writes} change`,
        comment:
          "How many of an app's tools only read, and how many change something.",
      }),
    readCount: (count) =>
      t({
        message: `${count} read`,
        comment: "How many of an app's tools only read.",
      }),
    changeCount: (count) =>
      t({
        message: `${count} change`,
        comment: "How many of an app's tools change something.",
      }),
    allTools: (count) =>
      t`${plural(count, { one: "The # tool", other: "All # tools" })}`,
    usedBy: t`Used by`,
    workflow: t`Workflow`,
    agent: t`Agent`,
    whoCanUse: t`Who can use it`,
    searchTools: t`Search tools`,
    noMatch: t`No tool matches`,
    never: t({ message: "Never", context: "what a tool may do" }),
    read: t({ message: "Read", context: "what a tool may do" }),
    write: t({ message: "Write", context: "what a tool may do" }),
    mixed: t({ message: "Mixed", context: "what a tool may do" }),
    neverNote: t`Grasp doesn't use these`,
    readNote: t`Reads without asking, changes nothing`,
    writeNote: t`Reads, and asks before each change`,
    mixedNote: t`Set tool by tool`,
    toolReadNote: t`Runs without asking`,
    toolWriteNote: t`Asks before each run`,
    choiceOf: (name) => t`What Grasp may do: ${name}`,
    other: t`Other`,
    toolGroup: (key) => toolGroups.get(key),
    readsWord: t`Reads`,
    changesWord: t`Changes`,
    showMore: t`Show more`,
    showLess: t`Show less`,
    offered: t`Available in your organization`,
    offeredOn: t`Members see it in Connectors.`,
    offeredOff: t`Hidden from members, and no one can connect it.`,
  };
};
