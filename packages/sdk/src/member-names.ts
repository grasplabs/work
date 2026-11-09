// How a declared name becomes a member of a client (`ctx.connections.<alias>`
// and `ctx.grasp.<namespace>`), at run time and in types alike.
//
// An action name a declaration may list (permission-checks.ts) is a
// letter, then letters, digits, `_` or `-`. All of it is an identifier
// except `-`, so the mapping only touches that. The name is split on `-`,
// the first part is kept, and each later part starts with a capital:
// `send-mail` is `sendMail`, `get-v2` is `getV2`, and a trailing or doubled
// `-` adds nothing. Every other name, such as a Composio tool
// (`GMAIL_SEND_EMAIL`), stays exactly as declared. A declaration that
// lists two names with the same member (`send-mail` and `sendMail`) is
// refused (`permission.connection`). The member only finds the call:
// what reaches the host is always the declared name.

/** The member of declared name `Name`: its `-` parts joined in camel case. */
export type MemberName<Name extends string> =
  Name extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<MemberName<Tail>>}`
    : Name;

/** The member of declared name `name`, as `MemberName` types it. */
export const memberName = (name: string): string => {
  const [head = "", ...tail] = name.split("-");
  return (
    head +
    tail.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")
  );
};

/**
 * A client of `entries`, by member: frozen, and with no prototype, so a
 * name nobody declared, `constructor` and `toString` included, is
 * undefined rather than something inherited.
 */
export const membersOf = <Member>(
  entries: Iterable<readonly [string, Member]>
): Readonly<Record<string, Member>> => {
  const members: Record<string, Member> = Object.fromEntries(entries);
  Object.setPrototypeOf(members, null);
  return Object.freeze(members);
};
