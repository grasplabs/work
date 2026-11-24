import type { OAuthProvider } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

import { readCapped } from "./oauth-client.ts";

// A connected account's addresses besides its sign-in name, two lists,
// which core uses when it decides whether mail is a workflow run's own
// (core's workflows/mail-stamps.ts): those its mailbox receives mail at,
// which count as its own mailbox and as its senders, and those it may
// only send as, which count as its senders only. Read once, as the
// connection is made or made again, with the token just issued, from the
// account's own profile only, so no scope beyond what the connector
// already asks for:
// - Microsoft 365: `/me`'s `mail` and its `smtp:` `proxyAddresses`
//   (`User.Read`), which the tenant's admins set: each is delivered to
//   this mailbox, so each is both;
// - Google Workspace: the account's send-as addresses (`gmail.modify`),
//   only those Google verified, so an owner can't claim an address that
//   isn't theirs by adding it unverified. Senders only: a send-as address
//   may receive in another mailbox (an external one), and a Workspace
//   alias that isn't a send-as address isn't listed at all, so neither
//   says what this mailbox receives. Workspace aliases need the Directory
//   API (GRA-677).
// A lookup that fails is logged and changes nothing: the connection is
// made all the same, a reconnected one keeps the lists it had, and a new
// one has none (null: never read), so mail to an alias is mail like any
// other, as before. Each list is bounded, so no account can bloat every answer that
// carries it.

/** Most addresses kept for one account, in each list. */
export const accountAddressesMax = 50;

/** How long the lookup may take. */
const timeoutMs = 10_000;

const address = z.email().max(256);

const microsoftProfile = z.object({
  mail: z.string().nullish(),
  proxyAddresses: z.array(z.string()).nullish(),
});

const googleSendAs = z.object({
  sendAs: z
    .array(
      z.object({
        sendAsEmail: z.string(),
        isPrimary: z.boolean().nullish(),
        verificationStatus: z.string().nullish(),
      })
    )
    .nullish(),
});

/** `text` as JSON, never quoting it in an error: it holds addresses. */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The provider's answer isn't JSON");
  }
};

/** An account's addresses: those it receives mail at, those it sends as. */
export interface AccountAddresses {
  receives: string[];
  sends: string[];
}

/** Where each provider says an account's addresses, and how to read them. */
const lookups: Readonly<
  Record<
    OAuthProvider,
    { url: string; read: (body: unknown) => AccountAddresses }
  >
> = {
  microsoft: {
    url: "https://graph.microsoft.com/v1.0/me?$select=mail,proxyAddresses",
    read: (body) => {
      const { mail, proxyAddresses } = microsoftProfile.parse(body);
      // `SMTP:` is the primary address, `smtp:` an alias; `SIP:`, `X500:`
      // and the rest aren't addresses mail is delivered to.
      const smtp = (proxyAddresses ?? []).flatMap((entry) =>
        entry.toLowerCase().startsWith("smtp:") ? [entry.slice(5)] : []
      );
      const delivered = [...(typeof mail === "string" ? [mail] : []), ...smtp];
      return { receives: delivered, sends: delivered };
    },
  },
  google: {
    // Only the fields read: a send-as address's signature and SMTP
    // settings could take an answer past its cap.
    url: "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs?fields=sendAs(sendAsEmail,isPrimary,verificationStatus)",
    read: (body) => ({
      receives: [],
      sends: (googleSendAs.parse(body).sendAs ?? []).flatMap(
        ({ sendAsEmail, isPrimary, verificationStatus }) =>
          isPrimary === true || verificationStatus === "accepted"
            ? [sendAsEmail]
            : []
      ),
    }),
  },
};

/** `listed`'s addresses: lower case, each once, at most the most kept. */
const addressesIn = (listed: readonly string[]): string[] => {
  const valid = listed.flatMap((each) => {
    const parsed = address.safeParse(each.trim());
    return parsed.success ? [parsed.data.toLowerCase()] : [];
  });
  return [...new Set(valid)].slice(0, accountAddressesMax);
};

/**
 * The addresses of the account `accessToken` is for, as its provider
 * says: those it receives mail at and those it sends as; undefined when
 * the lookup fails, so a reconnect keeps what was read before and a new
 * connection records that nothing was read.
 */
export const accountAddressesOf = async (
  provider: OAuthProvider,
  accessToken: string
): Promise<AccountAddresses | undefined> => {
  const lookup = lookups[provider];
  try {
    const response = await fetch(lookup.url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      // A redirect would take the token along.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The provider answered ${response.status}`);
    }
    // At most 64 KiB: more refuses the lookup (`readCapped`).
    const text = await readCapped(response);
    const { receives, sends } = lookup.read(jsonOf(text));
    return { receives: addressesIn(receives), sends: addressesIn(sends) };
  } catch (error) {
    log.warn("connection.addresses_unread", {
      provider,
      ...errorFields(error),
    });
    return undefined;
  }
};
