import { z } from "zod";

import { postToProvider, providerJson, requestBudget } from "./event-kinds.ts";
import type { ProviderAccess } from "./event-kinds.ts";

// HiBob's People API, as the HR platform's connection reads it (hr.ts):
// one search of everyone, with only the fields a roster needs. HiBob signs
// in a service user, which the company's admin makes in Bob and gives
// read access to people's basic and work details; its ID and token are the
// connection's key, `<id>:<token>`, sent as HTTP Basic auth, and only to
// HiBob's API host. HiBob has no way to say what a service user may read,
// so nothing is asked of it past the search, and only the fields below
// are asked for: whatever else the service user may read is never sent.

const hibobHost = "api.hibob.com";
const searchUrl = `https://${hibobHost}/v1/people/search`;

const hibob = postToProvider({ name: "HiBob", hosts: [hibobHost] });

/**
 * What a read asks for: each person's ID, name and email address, and
 * their department, job and who they report to.
 */
const peopleFields = [
  "root.id",
  "root.displayName",
  "root.email",
  "work.department",
  "work.title",
  "work.reportsTo",
] as const;

/** The key as HiBob's API takes it: Basic auth of `<id>:<token>`. */
export const hibobCredential = (key: string) => ({
  header: "authorization",
  value: `Basic ${btoa(key)}`,
});

const searchSchema = z.object({ employees: z.array(z.unknown()) });

const personSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  displayName: z.string().nullish(),
  email: z.string().nullish(),
  work: z
    .object({
      department: z.string().nullish(),
      title: z.string().nullish(),
      reportsTo: z
        .object({
          id: z.union([z.string(), z.number()]).transform(String).nullish(),
          email: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** Someone in HiBob, as its search answers them, before they are kept. */
export interface HibobPerson {
  id: string;
  name: string;
  email: string;
  department: string;
  title: string;
  /** Who they report to, by HiBob ID; empty for nobody. */
  manager: string;
}

/** Searches everyone HiBob's service user sees, asking for `fields`. */
const search = async (
  access: ProviderAccess,
  fields: readonly string[]
): Promise<unknown[]> => {
  const { text } = await hibob(
    access,
    searchUrl,
    JSON.stringify({ fields, showInactive: false }),
    "application/json"
  );
  return searchSchema.parse(providerJson("HiBob", text)).employees;
};

/**
 * Everyone in HiBob, as the search answers them: a person that doesn't
 * parse is left out rather than failing the rest.
 */
export const hibobPeople = async (
  access: ProviderAccess
): Promise<{ people: HibobPerson[]; read: number }> => {
  const employees = await search(access, peopleFields);
  const people = employees.flatMap((employee) => {
    const parsed = personSchema.safeParse(employee);
    if (!parsed.success) {
      return [];
    }
    const { id, displayName, email, work } = parsed.data;
    return [
      {
        id,
        name: displayName ?? "",
        email: email ?? "",
        department: work?.department ?? "",
        title: work?.title ?? "",
        manager: work?.reportsTo?.id ?? "",
      },
    ];
  });
  return { people, read: employees.length };
};

/**
 * The service user `key` signs in, if HiBob takes it: its ID, once a
 * search of only everyone's IDs goes through. Null when HiBob refuses it,
 * or the key isn't `<id>:<token>`.
 */
export const hibobAccount = async (
  key: string
): Promise<{ id: string; name: string; email: null } | null> => {
  const [id = "", ...token] = key.split(":");
  if (id === "" || token.join(":") === "") {
    return null;
  }
  try {
    await search(
      { credential: hibobCredential(key), budget: requestBudget(1) },
      ["root.id"]
    );
  } catch {
    return null;
  }
  return { id, name: id, email: null };
};
