import { deadline } from "@grasp-os/shared/deadline";
/**
 * What Grasp's CRM says of a company, for the admin's Details: its company
 * record in Grasp's Attio, linked by hand (`clients.attioCompanyId`,
 * src/crm/link.ts), with its people and deals, read each time the admin
 * reads its organizations (src/crm/attio.ts). The admin keeps only the
 * link; nothing Attio answers is stored.
 *
 * What reaches the browser is `Crm`: what the page shows, never Attio's
 * records as they came, and never the key.
 */
import { log } from "@grasp-os/shared/log";
import { isNotNull } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { ifStored, storeSecret } from "../deploy/context.ts";
import { readAttioCompany } from "./attio.ts";
import type {
  AttioCalls,
  AttioCompany,
  AttioDeal,
  AttioPerson,
  AttioReadError,
} from "./attio.ts";

/** The company as Attio has it. */
export type CrmCompany = Omit<AttioCompany, "recordId">;
/** One of its people, as the page lists them. */
export type CrmPerson = Omit<AttioPerson, "recordId">;
/** One of its deals, as the page lists them. */
export type CrmDeal = Omit<AttioDeal, "recordId">;

/** What Attio says of the company, worked out for the page. */
export interface CrmRecords {
  company: CrmCompany;
  /** Its people, by name. */
  people: CrmPerson[];
  deals: CrmDeal[];
  /** The calls with it, the newest first, and where they come from; null when Attio has none to read. */
  calls: AttioCalls;
}

/**
 * The company in the CRM, as far as it is read:
 * - `not_connected`: Secrets Store has no key, so Attio isn't read at all;
 *   the record it is linked to, if any, is still said;
 * - `not_linked`: nobody at Grasp linked it to a company in Attio yet;
 * - `unread`: Attio wasn't read now, and why;
 * - `read`: what Attio says.
 */
export type Crm =
  | { state: "not_connected"; recordId: string | null }
  | { state: "not_linked" }
  | { state: "unread"; recordId: string; error: AttioReadError }
  | { state: "read"; recordId: string; records: CrmRecords };

/** The read-only key, or null while Secrets Store doesn't have it. */
export const attioKey = async (env: Env): Promise<string | null> =>
  await ifStored(async () => await storeSecret(env, "ATTIO_READ_KEY"));

/** The Attio company each linked client is linked to, by the client's id. */
export const attioLinks = async (
  db: AdminDatabase
): Promise<Map<string, string>> => {
  const rows = await db
    .select({ id: clients.id, recordId: clients.attioCompanyId })
    .from(clients)
    .where(isNotNull(clients.attioCompanyId));
  return new Map(
    rows.flatMap(({ id, recordId }) =>
      recordId === null ? [] : [[id, recordId] as const]
    )
  );
};

/** What reading one client's company in the CRM takes. */
export interface CrmRead {
  key: string | null;
  recordId: string | null;
  clientId: string;
  timeoutMs: number;
}

const companyOf = ({
  name,
  domains,
  categories,
  employeeRange,
  url,
}: AttioCompany): CrmCompany => ({
  name,
  domains,
  categories,
  employeeRange,
  url,
});

const personOf = ({ name, title, email }: AttioPerson): CrmPerson => ({
  name,
  title,
  email,
});

const dealOf = ({ name, stage, value, owner }: AttioDeal): CrmDeal => ({
  name,
  stage,
  value,
  owner,
});

/**
 * Client `clientId`'s company in the CRM: not read without a key or a
 * linked record, else read from Attio within `timeoutMs`. Never throws.
 */
export const crmOf = async ({
  key,
  recordId,
  clientId,
  timeoutMs,
}: CrmRead): Promise<Crm> => {
  if (key === null) {
    return { state: "not_connected", recordId };
  }
  if (recordId === null) {
    return { state: "not_linked" };
  }
  const limit = deadline(timeoutMs);
  let error: AttioReadError = "no_answer";
  try {
    const read = await readAttioCompany({
      key,
      recordId,
      signal: limit.signal,
    });
    if ("records" in read) {
      const { company, people, deals, calls } = read.records;
      return {
        state: "read",
        recordId,
        records: {
          company: companyOf(company),
          people: people
            .map(personOf)
            .toSorted((one, other) => one.name.localeCompare(other.name)),
          deals: deals.map(dealOf),
          calls,
        },
      };
    }
    ({ error } = read);
  } catch {
    error = limit.stopped() === "timeout" ? "timeout" : "no_answer";
  } finally {
    limit.clear();
  }
  log.warn("admin.crm_unread", { clientId, error });
  return { state: "unread", recordId, error };
};
