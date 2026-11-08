import type { GraspClient } from "../client-core.ts";
import { peopleDirectory, peopleReferences } from "../people.ts";
import type { PeopleDirectory, User } from "../people.ts";
import { useClient } from "./provider.ts";
import { useQuery } from "./queries.ts";

/**
 * Who is using the page (`User`): their ID, name, address and roles in
 * the App (`builder`, `user`; none for a visitor the App was shared with,
 * whose `id` is their session's: key a visitor by `email`); `undefined`
 * while it loads. Core answers it from who is signed in, never from the
 * page: show it, but decide what someone may do in the App's server
 * functions, with `ctx.auth.getUser()`, which no page can change.
 */
export const useUser = (): User | undefined =>
  useQuery(peopleReferences.user, {});

/** Each client's directory (`usePeople`). */
const directories = new WeakMap<GraspClient, PeopleDirectory>();

/**
 * The organization's people, read-only, for a member, in an App that
 * declares it (`app({ permissions: { people: true } })`): `find` by ID, `search` by name or
 * email, and `team` for a team's members, at most 100 a read, each person
 * with only their name, email and teams. A visitor is refused every read
 * (`visitor.not_granted`). Call it from an event handler or an effect.
 */
export const usePeople = (): PeopleDirectory => {
  const client = useClient();
  // One directory a client, the same on every render: an effect that
  // depends on it runs again only when the client changes.
  let directory = directories.get(client);
  if (directory === undefined) {
    directory = peopleDirectory(
      async (name, args) =>
        // The reads' own references: core answers them for this App.
        await client.query(peopleReferences[name], args)
    );
    directories.set(client, directory);
  }
  return directory;
};
