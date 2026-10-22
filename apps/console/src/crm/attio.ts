/**
 * What Grasp's Attio holds on one company: its record, the people on its
 * team, its deals and the calls with it; and the deals Grasp won, to start
 * a new organization from. Read from Attio's REST API
 * (`https://api.attio.com/v2`) with one read-only API key
 * (`ATTIO_READ_KEY`, Secrets Store), as Stripe is read with one restricted
 * key: not through Attio's MCP server, whose OAuth grant would be a
 * person's and need renewing.
 *
 * Threat model: the key is the console's alone. It is read from Secrets
 * Store on the server, sent only to Attio's API as its bearer token, and
 * never logged, kept in D1 or sent to the browser. It should be made with
 * read scopes only, so Attio itself refuses a write. The console sends
 * only GETs, and one POST that reads: Attio lists records only through
 * `POST /objects/{object}/records/query`, and the console calls it for
 * deals alone (`dealsQueryPath`), with a body that sets only a limit.
 * What Attio answers is untrusted: it is checked against what
 * the console reads of it, and a record other than the one asked for is
 * refused, as is a meeting or note on another company, so one company is
 * never shown another's people, deals or calls.
 *
 * Attio's standard objects and attributes, by their slugs:
 * - companies: `name`, `domains`, `categories`, `employee_range`, with
 *   `team` (its people) and `associated_deals` (its deals);
 * - people: `name`, `email_addresses`, `job_title`;
 * - deals: `name`, `stage`, `value`, `owner` (a workspace member) and
 *   `associated_company`.
 * The calls are the company's meetings (`GET /meetings`, linked to the
 * company), as Attio has them from calendars and call recordings; a
 * workspace without them has its notes on the company read instead
 * (`GET /notes`). A workspace that renamed or removed an attribute simply
 * shows it as not known.
 */
import { z } from "zod";

import { eachLimited } from "../live-reads.ts";

/** Attio's API, which only ever gets this key. */
export const attioApi = "https://api.attio.com/v2";

/**
 * How many of a company's people, deals and calls are read, and how many
 * of the workspace's deals are looked through for won ones: enough for a
 * page, never a whole CRM.
 */
export const attioLimits = {
  people: 25,
  deals: 10,
  calls: 20,
  scanned: 500,
  won: 20,
} as const;

/** The one listing the console reads: the workspace's deals. */
export const dealsQueryPath = "/objects/deals/records/query";

/**
 * Where a deal stands, as the prototype's CRM has it (grasplabs/prototype
 * `lib/admin-sources.ts`, `SourceRecords.crm.stage`): a lead, a proposal
 * out, or won. Attio's pipeline stages are each workspace's own titles, so
 * they are read by their words; a stage that says none of these (a lost
 * deal, or one named otherwise) has no kind, only its title.
 */
export type DealStageKind = "lead" | "proposal" | "won";

const wonStage = /\bwon\b|closed[ -]won/iu;
const lostStage = /\blost\b|closed[ -]lost|\bdead\b/iu;
const proposalStage =
  /proposal|negotiat|in progress|contract|offer|quote|pricing/iu;
const leadStage = /\blead\b|prospect|qualif|discover|\bnew\b|intro/iu;

/** What an Attio stage's title says it is, or null when it says none. */
export const stageKind = (title: string): DealStageKind | null => {
  if (lostStage.test(title)) {
    return null;
  }
  if (wonStage.test(title)) {
    return "won";
  }
  if (proposalStage.test(title)) {
    return "proposal";
  }
  return leadStage.test(title) ? "lead" : null;
};

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
  stage: values(
    z.object({
      status: z.object({ title: z.string() }),
      /** When the deal came to this stage. */
      active_from: z.string().nullish(),
    })
  ),
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
  associated_company: reference,
});

/** A list as Attio answers one: `{ data: [...] }`, each item read on its own. */
const listOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: values(item) });

const meetingsSchema = listOf(
  z.object({
    title: z.string().nullish(),
    start: z
      .object({ datetime: z.string().nullish(), date: z.string().nullish() })
      .nullish(),
    participants: values(z.object({ email_address: z.string() })),
    linked_records: values(
      z.object({ object_slug: z.string().nullish(), record_id: z.string() })
    ),
  })
);

const notesSchema = listOf(
  z.object({
    title: z.string().nullish(),
    created_at: z.string(),
    parent_object: z.string(),
    parent_record_id: z.string(),
  })
);

const dealsSchema = listOf(dealSchema.shape.data);

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

/** A deal's stage: its title in Attio's pipeline ("Won 🎉"), and what that says it is. */
export interface AttioStage {
  title: string;
  kind: DealStageKind | null;
}

/** One of its deals. */
export interface AttioDeal {
  recordId: string;
  name: string;
  stage: AttioStage | null;
  value: { amount: number; currency: string | null } | null;
  /** Who at Grasp owns it, by name; null when nobody does or the name isn't readable. */
  owner: string | null;
}

/** A call with the company, as the prototype's CRM has one. */
export interface AttioCall {
  /** The day it was. */
  on: string;
  title: string;
  /** The company's people who were in it, by name, or by email when Attio has no name. */
  with: string[];
}

/**
 * The calls with the company, the newest first, and where they come from:
 * its meetings, or, in a workspace without them, its notes (which say
 * nobody who was in them). Null when neither could be read.
 */
export type AttioCalls = {
  from: "meetings" | "notes";
  calls: AttioCall[];
} | null;

/** Everything read of one company. */
export interface AttioRecords {
  company: AttioCompany;
  people: AttioPerson[];
  deals: AttioDeal[];
  calls: AttioCalls;
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

/**
 * A GET to Attio's API at `path`, or with `query` the deals' one reading
 * POST: its JSON answer, or null for a 404.
 */
const get = async (
  { key, signal }: Pick<AttioRead, "key" | "signal">,
  path: string,
  query?: { limit: number }
): Promise<unknown> => {
  const response = await fetch(`${attioApi}${path}`, {
    ...(query === undefined
      ? { method: "GET" }
      : { method: "POST", body: JSON.stringify(query) }),
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(query === undefined ? {} : { "content-type": "application/json" }),
    },
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

/** The day an ISO time or day falls on, or null when it isn't one. */
const dayOf = (time: string | null | undefined): string | null => {
  const day = time?.slice(0, 10) ?? "";
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : null;
};

/** Reads that only add to a company's page: none of them fails the rest, unless the read was stopped. */
const orNull = async <T>(
  read: Pick<AttioRead, "signal">,
  task: () => Promise<T | null>
): Promise<T | null> => {
  try {
    return await task();
  } catch (error) {
    if (read.signal.aborted) {
      throw error;
    }
    return null;
  }
};

/** The newest calls first, at most a page of them. */
const newestCalls = (calls: AttioCall[]): AttioCall[] =>
  calls
    .toSorted((one, other) => other.on.localeCompare(one.on))
    .slice(0, attioLimits.calls);

/**
 * Company `recordId`'s meetings that have taken place, with who of the
 * company was in them: a participant is the company's when they are one of
 * `people` or their email is at one of its `domains`, so Grasp's own
 * people in the call aren't listed. Null when Attio has no meetings to
 * read (an older workspace, or a key without their scope).
 */
const meetingsOf = async (
  read: AttioRead,
  people: ReadonlyMap<string, string>,
  domains: readonly string[]
): Promise<AttioCall[] | null> => {
  const answer = await get(
    read,
    `/meetings?linked_object=companies&linked_record_id=${encodeURIComponent(read.recordId)}&limit=${attioLimits.calls * 2}`
  );
  const parsed = meetingsSchema.safeParse(answer);
  if (answer === null || !parsed.success) {
    return null;
  }
  const today = new Date().toISOString().slice(0, 10);
  const ours = (email: string): boolean =>
    people.has(email) ||
    domains.some((domain) => email.endsWith(`@${domain.toLowerCase()}`));
  return parsed.data.data.flatMap((meeting) => {
    const on = dayOf(meeting.start?.datetime ?? meeting.start?.date);
    const linked = meeting.linked_records.some(
      (each) => each.record_id === read.recordId
    );
    if (on === null || on > today || !linked) {
      return [];
    }
    const emails = meeting.participants.map((each) =>
      each.email_address.toLowerCase()
    );
    return [
      {
        on,
        title: meeting.title?.trim() ?? "",
        with: [...new Set(emails.filter(ours))].map(
          (email) => people.get(email) ?? email
        ),
      },
    ];
  });
};

/** Company `recordId`'s notes, as calls nobody is named in; null when Attio has none to read. */
const notesOf = async (read: AttioRead): Promise<AttioCall[] | null> => {
  const answer = await get(
    read,
    `/notes?parent_object=companies&parent_record_id=${encodeURIComponent(read.recordId)}&limit=${attioLimits.calls}`
  );
  const parsed = notesSchema.safeParse(answer);
  if (answer === null || !parsed.success) {
    return null;
  }
  return parsed.data.data.flatMap((note) => {
    const on = dayOf(note.created_at);
    return on === null ||
      note.parent_object !== "companies" ||
      note.parent_record_id !== read.recordId
      ? []
      : [{ on, title: note.title?.trim() ?? "", with: [] }];
  });
};

/** The calls with company `recordId`: its meetings, or else its notes. */
const callsOf = async (
  read: AttioRead,
  people: readonly AttioPerson[],
  domains: readonly string[]
): Promise<AttioCalls> => {
  const byEmail = new Map(
    people
      .filter((person) => person.email !== "" && person.name !== "")
      .map((person) => [person.email.toLowerCase(), person.name])
  );
  const meetings = await orNull(
    read,
    async () => await meetingsOf(read, byEmail, domains)
  );
  if (meetings !== null && meetings.length > 0) {
    return { from: "meetings", calls: newestCalls(meetings) };
  }
  const notes = await orNull(read, async () => await notesOf(read));
  if (notes !== null && notes.length > 0) {
    return { from: "notes", calls: newestCalls(notes) };
  }
  return meetings === null && notes === null
    ? null
    : { from: "meetings", calls: [] };
};

/** A deal's stage as the console reads it. */
const stageOf = (
  stage: { status: { title: string } } | undefined
): AttioStage | null =>
  stage === undefined
    ? null
    : { title: stage.status.title, kind: stageKind(stage.status.title) };

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
    const [personRecords, deals, members] = await Promise.all([
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
    // A person or deal deleted since it was referenced is left out.
    const people = personRecords.flatMap((person): AttioPerson[] =>
      person === null
        ? []
        : [
            {
              recordId: person.data.id.record_id,
              name: nameOf(person.data.values.name[0]),
              title: person.data.values.job_title[0]?.value ?? "",
              email: person.data.values.email_addresses[0]?.email_address ?? "",
            },
          ]
    );
    const domains = about.domains.map((each) => each.domain);
    const calls = await callsOf(read, people, domains);
    return {
      records: {
        company: {
          recordId: company.data.id.record_id,
          name: about.name[0]?.value ?? null,
          domains,
          categories: about.categories.map((each) => each.option.title),
          employeeRange: about.employee_range[0]?.option.title ?? null,
          url: attioUrl(company.data.web_url),
        },
        people,
        calls,
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
              stage: stageOf(on.stage[0]),
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

/** A deal Grasp won, with its company: where a new organization can start from. */
export interface WonDeal {
  dealId: string;
  /** The deal, as it is called in Attio. */
  title: string;
  /** Its stage's own title: "Won 🎉". */
  stage: string;
  /** The day it came to that stage, when Attio says. */
  on: string | null;
  companyId: string;
  /** The company's name in Attio. */
  name: string;
  domains: string[];
}

/**
 * The deals Grasp won in Attio, the latest first, each with its company,
 * leaving out companies in `linked` (already a client). At most
 * `attioLimits.won`, from the `attioLimits.scanned` deals looked through.
 * Throws only when a request itself fails or is stopped.
 */
export const readWonDeals = async (
  read: Pick<AttioRead, "key" | "signal">,
  linked: ReadonlySet<string>
): Promise<{ deals: WonDeal[] } | { error: AttioReadError }> => {
  try {
    const parsed = dealsSchema.safeParse(
      await get(read, dealsQueryPath, { limit: attioLimits.scanned })
    );
    if (!parsed.success) {
      return { error: "invalid_answer" };
    }
    const won = parsed.data.data.flatMap((deal) => {
      const [stage] = deal.values.stage;
      const companyId = deal.values.associated_company.find(
        (each) => each.target_object === "companies"
      )?.target_record_id;
      return stage === undefined ||
        stageKind(stage.status.title) !== "won" ||
        companyId === undefined ||
        linked.has(companyId)
        ? []
        : [
            {
              dealId: deal.id.record_id,
              title: deal.values.name[0]?.value ?? "",
              stage: stage.status.title,
              on: dayOf(stage.active_from),
              companyId,
            },
          ];
    });
    const latest = won
      .toSorted((one, other) => (other.on ?? "").localeCompare(one.on ?? ""))
      .slice(0, attioLimits.won);
    const companies = await eachLimited(
      latest,
      concurrency,
      async (deal) =>
        await record(read, "companies", deal.companyId, companySchema)
    );
    return {
      deals: latest.flatMap((deal, index) => {
        const company = companies[index];
        if (company === null || company === undefined) {
          return [];
        }
        const { values: about } = company.data;
        return [
          {
            ...deal,
            name: about.name[0]?.value ?? deal.title,
            domains: about.domains.map((each) => each.domain),
          },
        ];
      }),
    };
  } catch (error) {
    if (error instanceof AttioError) {
      return { error: error.code };
    }
    throw error;
  }
};
