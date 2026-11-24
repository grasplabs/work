// The Never class, as connect holds it (GRA-717): what Grasp never does,
// whatever a company turns on or an admin allows, for native and Composio
// tools alike. Deleting, permissions and sharing, forwarding and mail
// rules, settings, and payments. A Composio tool is known only by its
// name, which Composio and the admin give, and a review's class can be
// wrong, so the rule reads the name itself: any of its words that is one
// of these refuses it. It errs towards refusing: a read named for one of
// them (`LIST_MAIL_RULES`) is refused too, and that costs less than a
// change let through.
//
// The ways it can fail, which the tests start from: an admin allows such
// a tool by name and it runs; a name in another case or joined another
// way (`deleteMessage`, `DELETE_MESSAGE`, `mail.delete`) slips past; a
// word inside another (`SHAREPOINT`) refuses a tool that is fine.

/** Words that make a tool's name one Grasp never runs. */
const neverWords: ReadonlySet<string> = new Set([
  // Deleting
  "delete",
  "deletes",
  "remove",
  "removes",
  "trash",
  "purge",
  "destroy",
  "erase",
  "wipe",
  // Permissions and sharing
  "permission",
  "permissions",
  "share",
  "unshare",
  "acl",
  "grant",
  "revoke",
  // Forwarding and mail rules
  "forward",
  "forwarding",
  "redirect",
  "rule",
  "rules",
  "filter",
  "filters",
  "autoreply",
  // Settings
  "setting",
  "settings",
  "preferences",
  "config",
  // Payments
  "pay",
  "payment",
  "payments",
  "payout",
  "payouts",
  "refund",
  "refunds",
  "charge",
  "charges",
  "transfer",
  "transfers",
]);

/** A name's words: split at anything not a letter or digit, and camelCase. */
const wordsOf = (name: string): string[] =>
  name
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");

/** Whether the tool `name` is one Grasp never runs. */
export const isNeverTool = (name: string): boolean =>
  wordsOf(name).some((word) => neverWords.has(word));
