/**
 * What Grasp's Attio holds on one company: its record, the people on its
 * team and its deals, read from Attio's REST API (`https://api.attio.com/v2`)
 * with a read-only API key (`ATTIO_READ_KEY`, Secrets Store).
 *
 * Threat model: the key is the console's alone. It is read from Secrets
 * Store on the server, sent only to Attio's API as its bearer token, and
 * never logged, kept in D1 or sent to the browser. It should be made with
 * read scopes only, so Attio itself refuses a write; the console only ever
 * sends a GET anyway, to the paths below and nowhere else. What Attio
 * answers is untrusted: it is checked against what the console reads of
 * it, and a record other than the one asked for is refused, so one company
 * is never shown another's people or deals.
 *
 * Attio's standard objects and attributes, by their slugs:
 * - companies: `name`, `domains`, `categories`, `employee_range`, with
 *   `team` (its people) and `associated_deals` (its deals);
 * - people: `name`, `email_addresses`, `job_title`;
 * - deals: `name`, `stage`, `value`, `owner` (a workspace member).
 * A workspace that renamed or removed one simply shows it as not known.
 */
import { z } from "zod";

import { eachLimited } from "../live-reads.ts";

/** Attio's API, which only ever gets this key. */
export const attioApi = "https://api.attio.com/v2";

/** How many of a company's people and deals are read: enough for a page, never a whole CRM. */
export const attioLimits = { people: 25, deals: 10 } as const;

/** How many requests to Attio are under way at once, for one company. */
const concurrency = 4;

/**
 * Why Attio wasn't read, as a code: what is logged and shown, never an
 * answer's body.
 * - `refused`: Attio turned the key away (401, 403);
 * - `not_found`: Attio has no such company;
 * - `invalid_answer`: the answer isn't what Attio's records look like;
 * - `timeout`: no answer within the deadline;
 * - `no_answer`: the request failed otherwise, a rate limit too.
 */
export type AttioReadError =
  | "refused"
  | "not_found"
  | "invalid_answer"
  | "timeout"
  | "no_answer";

/** A record's id, as Attio gives it with the object's and workspace's. */
const recordIdSchema = z.object({ record_id: z.string() });

/**
 * One attribute's values: what Attio sends for a slug, active values only.
 * A value the console can't read is dropped rather than failing the record.
 */
const values = <T extends z.ZodType>(value: T) =>
  z
    .array(z.unknown())
    .optional()
    .transform((all) =>
      (all ?? []).flatMap((each) => {
        const read = value.safeParse(each);
        return read.success ? [read.data] : [];
      })
    );

const text = values(z.object({ value: z.string() }));
const option = values(z.object({ option: z.object({ title: z.string() }) }));
const reference = values(
  z.object({ target_object: z.string(), target_record_id: z.string() })
);

/** A record as Attio answers one: `{ data: { id, web_url, values } }`. */
const recordSchema = <T extends z.ZodRawShape>(shape: T) =>
  z.object({
    data: z.object({
      id: recordIdSchema,
      web_url: z.string().optional(),
      values: z.object(shape),
    }),
  });

const companySchema = recordSchema({
  name: text,
  domains: values(z.object({ domain: z.string() })),
  categories: option,
  employee_range: option,
  team: reference,
  associated_deals: reference,
});

const personSchema = recordSchema({
  name: values(
    z.object({
      full_name: z.string().nullish(),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
    })
  ),
  email_addresses: values(z.object({ email_address: z.string() })),
  job_title: text,
});

const dealSchema = recordSchema({
  name: text,
  stage: values(z.object({ status: z.object({ title: z.string() }) })),
  value: values(
    z.object({
      currency_value: z.number(),
      currency_code: z.string().nullish(),
    })
  ),
  owner: values(
    z.object({
      referenced_actor_type: z.string(),
      referenced_actor_id: z.string().nullable(),
    })
  ),
});

const membersSchema = z.object({
  data: z.array(
    z.object({
      id: z.object({ workspace_member_id: z.string() }),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
    })
  ),
});

/** A company as the console reads it from Attio. */
export interface AttioCompany {
  recordId: string;
  name: string | null;
  domains: string[];
  categories: string[];
  employeeRange: string | null;
  /** The company in Attio's own app, when Attio gave its address. */
  url: string | null;
}

/** One of its people. */
export interface AttioPerson {
  recordId: string;
  name: string;
  /** Their job: "COO"; empty when Attio has none. */
  title: string;
  /** Their first email address; empty when Attio has none. */
  email: string;
}

/** One of its deals. */
export interface AttioDeal {
  recordId: string;
  name: string;
  /** The stage's title in Attio's pipeline: "Won 🎉". */
  stage: string | null;
  value: { amount: number; currency: string | null } | null;
  /** Who at Grasp owns it, by name; null when nobody does or the name isn't readable. */
  owner: string | null;
}

/** Everything read of one company. */
export interface AttioRecords {
  company: AttioCompany;
  people: AttioPerson[];
  deals: AttioDeal[];
}

/** What reading one company takes. */
export interface AttioRead {
  key: string;
  /** The company record's id, as it was linked. */
  recordId: string;
  signal: AbortSignal;
}

/** Why a read stopped, carried up to the one place that answers it. */
class AttioError extends Error {
  readonly code: AttioReadError;

  constructor(code: AttioReadError) {
    super(code);
    this.name = "AttioError";
    this.code = code;
  }
}

/** A GET to Attio's API at `path`, its JSON answer, or null for a 404. */
const get = async (
  { key, signal }: Pick<AttioRead, "key" | "signal">,
  path: string
): Promise<unknown> => {
  const response = await fetch(`${attioApi}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    // A redirect isn't followed (Workers has no "error"): it isn't ok, so no answer.
    redirect: "manual",
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new AttioError("refused");
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AttioError("no_answer");
  }
  return await response.json().catch(() => {
    throw new AttioError("invalid_answer");
  });
};

/** One record of `object`, parsed with `schema`; null when Attio has none. */
const record = async <
  T extends z.ZodType<{ data: { id: { record_id: string } } }>,
>(
  read: Pick<AttioRead, "key" | "signal">,
  object: "companies" | "people" | "deals",
  recordId: string,
  schema: T
): Promise<z.output<T> | null> => {
  const answer = await get(
    read,
    `/objects/${object}/records/${encodeURIComponent(recordId)}`
  );
  if (answer === null) {
    return null;
  }
  const parsed = schema.safeParse(answer);
  if (!parsed.success || parsed.data.data.id.record_id !== recordId) {
    throw new AttioError("invalid_answer");
  }
  return parsed.data;
};

/** The distinct ids a reference attribute points at in `object`, at most `limit`. */
const targets = (
  references: readonly { target_object: string; target_record_id: string }[],
  object: string,
  limit: number
): string[] =>
  [
    ...new Set(
      references
        .filter((each) => each.target_object === object)
        .map((each) => each.target_record_id)
    ),
  ].slice(0, limit);

/** A name from its parts, as Attio's personal-name value has them. */
const nameOf = (
  name:
    | {
        full_name?: string | null;
        first_name?: string | null;
        last_name?: string | null;
      }
    | undefined
): string => {
  const full = name?.full_name?.trim() ?? "";
  if (full !== "") {
    return full;
  }
  return [name?.first_name, name?.last_name]
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" ")
    .trim();
};

/** A workspace member's name, or null when Attio has none for them. */
const ownerOf = (
  members: ReadonlyMap<string, string>,
  ownerId: string | null | undefined
): string | null => {
  const name =
    ownerId === null || ownerId === undefined
      ? ""
      : (members.get(ownerId) ?? "");
  return name === "" ? null : name;
};

/**
 * Who each workspace member is, by id. Only what names a deal's owner, so
 * a key without user-management access still reads the rest: then owners
 * aren't named. The read stopping still stops it.
 */
const membersOf = async (
  read: Pick<AttioRead, "key" | "signal">
): Promise<Map<string, string>> => {
  try {
    const parsed = membersSchema.safeParse(
      await get(read, "/workspace_members")
    );
    return new Map(
      parsed.success
        ? parsed.data.data.map((member) => [
            member.id.workspace_member_id,
            nameOf(member),
          ])
        : []
    );
  } catch (error) {
    if (read.signal.aborted) {
      throw error;
    }
    return new Map();
  }
};

/** Attio's address for a record, only when it is Attio's own app. */
const attioUrl = (url: string | undefined): string | null =>
  url !== undefined && url.startsWith("https://app.attio.com/") ? url : null;

/**
 * Company `recordId` in Attio, its people and its deals, or why they
 * weren't read. Throws only when a request itself fails or is stopped.
 */
export const readAttioCompany = async (
  read: AttioRead
): Promise<{ records: AttioRecords } | { error: AttioReadError }> => {
  try {
    const company = await record(
      read,
      "companies",
      read.recordId,
      companySchema
    );
    if (company === null) {
      return { error: "not_found" };
    }
    const { values: about } = company.data;
    const personIds = targets(about.team, "people", attioLimits.people);
    const dealIds = targets(about.associated_deals, "deals", attioLimits.deals);
    const [people, deals, members] = await Promise.all([
      eachLimited(
        personIds,
        concurrency,
        async (id) => await record(read, "people", id, personSchema)
      ),
      eachLimited(
        dealIds,
        concurrency,
        async (id) => await record(read, "deals", id, dealSchema)
      ),
      dealIds.length === 0 ? new Map<string, string>() : membersOf(read),
    ]);
    return {
      records: {
        company: {
          recordId: company.data.id.record_id,
          name: about.name[0]?.value ?? null,
          domains: about.domains.map((each) => each.domain),
          categories: about.categories.map((each) => each.option.title),
          employeeRange: about.employee_range[0]?.option.title ?? null,
          url: attioUrl(company.data.web_url),
        },
        // A person or deal deleted since it was referenced is left out.
        people: people.flatMap((person) =>
          person === null
            ? []
            : [
                {
                  recordId: person.data.id.record_id,
                  name: nameOf(person.data.values.name[0]),
                  title: person.data.values.job_title[0]?.value ?? "",
                  email:
                    person.data.values.email_addresses[0]?.email_address ?? "",
                },
              ]
        ),
        deals: deals.flatMap((deal) => {
          if (deal === null) {
            return [];
          }
          const { values: on } = deal.data;
          const [value] = on.value;
          const ownerId = on.owner.find(
            (each) => each.referenced_actor_type === "workspace-member"
          )?.referenced_actor_id;
          return [
            {
              recordId: deal.data.id.record_id,
              name: on.name[0]?.value ?? "",
              stage: on.stage[0]?.status.title ?? null,
              value:
                value === undefined
                  ? null
                  : {
                      amount: value.currency_value,
                      currency: value.currency_code ?? null,
                    },
              owner: ownerOf(members, ownerId),
            },
          ];
        }),
      },
    };
  } catch (error) {
    if (error instanceof AttioError) {
      return { error: error.code };
    }
    throw error;
  }
};
