import { z } from "zod";

import type { ToolErrorCode } from "./server.ts";

// A connector's recorded vendor answers (its fixtures): what its tools sent
// and what the vendor answered, recorded on a real connection through
// connect's egress, and replayed with the vendor faked. They live beside
// the connector's entry as `fixtures.json`; connect's build replays each
// case in workerd and refuses the connector if one fails, and tests use
// them as the vendor (`fixtureVendor`) instead of a fake of their own.
//
// Nothing secret or personal is kept, by rule rather than by hand
// (`recordedFixtures`): requests keep no headers, answers only the headers
// a connector reads to page and to wait, a declared secret is replaced in
// every form it shows in, and every string under a field the fixtures name
// as personal, and every email address, is replaced by a stand-in, the
// same one wherever it shows, so a recording still links what the vendor
// linked. The connection's own credential, anywhere in any form, refuses
// the recording, as does what the rule can't replace (a personal value
// inside something encoded).
//
// This is the second guard, and a denylist: it finds only the encodings
// it knows. The first is that only tools that read are recorded, from an
// account Grasp owns filled with made-up data, and a person reads the
// plain-text recording in review.

/** A request a tool sent, as recorded: never its headers. */
const recordedRequestSchema = z.strictObject({
  method: z.string().min(1),
  url: z.url(),
  /** A JSON body. */
  body: z.json().optional(),
  /** A body that isn't JSON. */
  text: z.string().optional(),
});

/** The vendor's answer, as recorded. */
const recordedAnswerSchema = z.strictObject({
  status: z.int().min(100).max(599),
  /** Only those of `keptHeaders`. */
  headers: z.record(z.string(), z.string()),
  body: z.json().optional(),
  text: z.string().optional(),
});

/** One request and its answer. */
const exchangeSchema = z.strictObject({
  request: recordedRequestSchema,
  answer: recordedAnswerSchema,
});

export type Exchange = z.infer<typeof exchangeSchema>;

/** A JSON value, as fixtures hold them. */
type Json = z.infer<ReturnType<typeof z.json>>;

/** The kinds a vendor's answer can make a call fail with, in a replay. */
const vendorErrorKinds = [
  "invalid",
  "access_denied",
  "not_found",
  "conflict",
  "throttled",
  "unavailable",
  "failed",
] as const satisfies readonly ToolErrorCode[];

/** One call of a tool: every request it sent, and what it answered. */
const fixtureCallSchema = z.strictObject({
  exchanges: z.array(exchangeSchema),
  /** The tool's output, unless the call failed. */
  output: z.json().optional(),
});

export type FixtureCall = z.infer<typeof fixtureCallSchema>;

/**
 * One case: a tool called with `args`, and each call of it. A paged case
 * (`cursor`) gives each call after the first the `next` the one before
 * answered, in the argument `cursor` names, up to the vendor's last
 * page. An error case (`error`) ends with a call that fails with that
 * kind.
 */
const fixtureCaseSchema = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.json()),
  cursor: z.string().min(1).optional(),
  error: z.enum(vendorErrorKinds).optional(),
  calls: z.array(fixtureCallSchema).default([]),
});

export type FixtureCase = z.infer<typeof fixtureCaseSchema>;

/** A connector's `fixtures.json`. */
export const fixturesSchema = z.strictObject({
  /** The fields whose values are personal data, wherever they are. */
  personal: z.array(z.string().min(1)),
  /**
   * The fields whose values are secrets other than the connection's own,
   * such as a webhook's signing secret or a signed download URL.
   */
  secret: z.array(z.string().min(1)).optional(),
  /** Connect's lookup of whose account a key is, when one was recorded. */
  account: exchangeSchema.optional(),
  cases: z.array(fixtureCaseSchema),
});

export type Fixtures = z.infer<typeof fixturesSchema>;

/**
 * The headers of an answer a recording keeps: how to read it, page and
 * wait. Not `location`: connect's egress doesn't follow a redirect, and a
 * redirect's URL can carry a signature of its own.
 */
const keptHeaders = new Set(["content-type", "link", "retry-after"]);

/** What a recording run saw of one request, before anything is removed. */
export interface Captured {
  method: string;
  url: string;
  body: string;
  status: number;
  /** The answer's headers. */
  headers: Readonly<Record<string, string>>;
  answer: string;
}

/** What a recording run saw, case by case. */
export interface Seen {
  account?: Captured;
  cases: readonly (Omit<FixtureCase, "calls"> & {
    calls: readonly { exchanges: readonly Captured[] }[];
  })[];
}

/** What a secret is replaced with. */
export const credentialStandIn = "[credential]";

const emailLike = /^[^\s@]+@[^\s@]+$/u;
/** An email address within any text. */
//
// By RFC 5322's grammar (its `atext`, the dot-atom) with RFC 6531's
// Unicode letters, less `/ = ? & #`: those also delimit a URL, and an
// address within one is found as the URL's own part.
const emailsIn =
  /[\p{L}\p{N}!$%'*+^_`{|}~.-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])/giu;
/** Text that may be base64 or base64url of something. */
const base64Like = /[\w+/-]{8,}/gu;
const regExpSyntax = /[.*+?^${}()|[\]\\/]/gu;
/**
 * The shortest personal value replaced within text (a URL, a header, a
 * longer string), and looked for within what decodes: a shorter one is
 * replaced only where a whole JSON value is it, as it turns up within
 * other text by chance.
 */
const minWithinText = 4;
/**
 * The shortest secret replaced within text: a shorter one is more likely a
 * placeholder (`hidden`, `none`) than a secret, and is replaced only where
 * a whole JSON value is it.
 */
const minSecretWithinText = 8;

const jsonOf = (text: string): { body: Json } | undefined => {
  try {
    return { body: z.json().parse(JSON.parse(text)) };
  } catch {
    return undefined;
  }
};

/** A body as recorded: none, JSON, or text. */
const bodyOf = (text: string): { body?: Json; text?: string } =>
  text === "" ? {} : (jsonOf(text) ?? { text });

const percentDecoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** `text` as a form's value (`+` for a space). */
const formEncoded = (text: string): string =>
  new URLSearchParams({ text }).toString().slice("text=".length);

const base64Of = (text: string): string =>
  btoa(
    Array.from(new TextEncoder().encode(text), (byte) =>
      String.fromCodePoint(byte)
    ).join("")
  );

/**
 * What `token` decodes to as base64 or base64url, from each of the four
 * places a value within it can start, invalid bytes and all.
 */
const decodingsOf = (token: string): string[] => {
  const standard = token.replaceAll("-", "+").replaceAll("_", "/");
  return [0, 1, 2, 3].flatMap((start) => {
    const from = standard.slice(start);
    // A tail of 2 or 3 characters is whole once padded; one of 1 never is.
    const tail = from.length % 4;
    const whole =
      tail === 1 ? from.slice(0, -1) : from + "=".repeat((4 - tail) % 4);
    try {
      return [
        new TextDecoder().decode(
          Uint8Array.from(atob(whole), (char) => char.codePointAt(0) ?? 0)
        ),
      ];
    } catch {
      return [];
    }
  });
};

/**
 * The forms `value` shows in where nothing decodes it: as is, escaped in
 * JSON, in base64 and base64url, and each of those percent- and
 * form-encoded.
 */
const formsOf = (value: string): string[] => {
  const base64 = base64Of(value).replace(/=+$/u, "");
  return [
    ...new Set(
      [
        value,
        JSON.stringify(value).slice(1, -1),
        base64,
        base64.replaceAll("+", "-").replaceAll("/", "_"),
      ].flatMap((form) => [form, encodeURIComponent(form), formEncoded(form)])
    ),
  ];
};

/** `value` with each of its strings `replace`d; its objects' keys stay. */
const mapJson = (value: Json, replace: (text: string) => string): Json => {
  if (typeof value === "string") {
    return replace(value);
  }
  if (Array.isArray(value)) {
    return value.map((each) => mapJson(each, replace));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, mapJson(each, replace)])
    );
  }
  return value;
};

/** Every string in `value`, its objects' keys too. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, each]) => [
      key,
      ...stringsIn(each),
    ]);
  }
  return [];
};

/** `text`, a request's URL once its secrets are replaced, if it still is one. */
const urlOf = (text: string): string => {
  if (!URL.canParse(text)) {
    throw new Error(
      "A request's URL is a secret, such as a signed download URL: a tool that sends one isn't recorded"
    );
  }
  return text;
};

/** Every string under a field `names` holds, in `value`, into `found`. */
const valuesUnder = (
  value: unknown,
  names: ReadonlySet<string>,
  found: string[],
  under = false
): void => {
  if (typeof value === "string") {
    if (under) {
      found.push(value);
    }
    // JSON within a string, such as a filter in a query, is looked into too.
    const nested = jsonOf(value)?.body;
    if (typeof nested === "object" && nested !== null) {
      valuesUnder(nested, names, found, under);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const each of value) {
      valuesUnder(each, names, found, under);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, each] of Object.entries(value)) {
      valuesUnder(each, names, found, under || names.has(key));
    }
  }
};

/** Every email address in `value`'s strings, decoded, and its keys. */
const emailsOf = (value: unknown): string[] =>
  stringsIn(value).flatMap((text) =>
    Array.from(percentDecoded(text).matchAll(emailsIn), ([address]) => address)
  );

/**
 * A query's or a form's fields, each its own object, so a field that
 * repeats keeps every value.
 */
const fieldsOf = (params: URLSearchParams): Record<string, string>[] =>
  [...params].map(([name, value]) => ({ [name]: value }));

/**
 * What a vendor sent and answered in `exchange`, where personal or
 * secret values are looked for: never the fixture's own structure, so a
 * field named `body` or `url` is only ever the vendor's.
 */
const vendorDataOf = (exchange: Exchange): unknown[] => [
  fieldsOf(new URL(exchange.request.url).searchParams),
  fieldsOf(new URLSearchParams(exchange.request.text)),
  new URL(exchange.request.url).pathname.split("/").map(percentDecoded),
  exchange.request.body ?? exchange.request.text,
  Object.values(exchange.answer.headers),
  exchange.answer.body ?? exchange.answer.text,
];

/**
 * The fixtures a recording run makes of what it `seen`, with nothing
 * secret or personal kept, by `rule`: no request headers, only
 * `keptHeaders` of an answer, every value under a field `secret` names
 * replaced in every form it shows in, and every personal value (a string under a
 * field `personal` names, in a body, an answer or a query, and
 * any email address) replaced by a stand-in (`person-1`, or
 * `person-1@example.com` for an address), the same wherever that value
 * shows: as a whole JSON value, and within any text, a URL's or a
 * header's too, as a word, when it is at least `minWithinText` long.
 *
 * Refused, rather than kept, when a case's arguments hold a personal
 * value (they're written by hand and sent as written, so call by an id),
 * or when what is kept carries the connection's `credential` in any form
 * at all (a vendor that echoes it is recorded from no case), or a secret
 * or personal value within base64 or percent-encoding. It records no output: the recorder
 * gets each call's by calling the tool again with what is kept as its
 * vendor, so an output holds only stand-ins, whatever the tool makes of
 * them, and refuses those outputs by `refuseKnownIn` as well, for a tool
 * that decodes what the check doesn't (an HTML entity, a mail header).
 */
export const recordedFixtures = (
  seen: Seen,
  rule: {
    credential: string;
    personal: readonly string[];
    secret: readonly string[];
  }
): { fixtures: Fixtures; refuseKnownIn: (value: unknown) => void } => {
  // Each text and what it decodes to, for what may not be kept.
  // JSON within a string is read as JSON too, so a value its own escaping
  // hides (`\u00e9`, `\/`) is still seen.
  const decodedIn = (value: unknown): string[] =>
    stringsIn(value).flatMap((text) => {
      const decoded = percentDecoded(text.replaceAll("+", " "));
      const nested = jsonOf(text)?.body;
      return [
        ...[text, percentDecoded(text), decoded].flatMap((each) => [
          each,
          ...Array.from(each.matchAll(base64Like), ([token]) =>
            decodingsOf(token)
          ).flat(),
        ]),
        ...(typeof nested === "object" && nested !== null
          ? decodedIn(nested)
          : []),
      ];
    });
  const sources = [
    ...(seen.account === undefined
      ? []
      : [{ where: "The account lookup", exchanges: [seen.account] }]),
    ...seen.cases.map(({ calls }, index) => ({
      where: `Case ${index + 1}`,
      exchanges: calls.flatMap(({ exchanges }) => exchanges),
    })),
  ];
  // The connection's own credential, in any form, in what would be kept
  // refuses the recording: it is never replaced, not even within a secret.
  const credentialForms = formsOf(rule.credential);
  const carriesCredential = (each: Captured): boolean =>
    decodedIn([
      each.url,
      each.body,
      each.answer,
      ...Object.entries(each.headers).flatMap(([name, value]) =>
        keptHeaders.has(name.toLowerCase()) ? [value] : []
      ),
    ]).some((text) => credentialForms.some((form) => text.includes(form)));
  const echoing = sources.find(({ exchanges }) =>
    exchanges.some(carriesCredential)
  );
  if (echoing !== undefined) {
    throw new Error(
      `${echoing.where} carries the connection's credential, which a recording never keeps: record only from a vendor and tools whose answers don't echo it`
    );
  }
  const everyCaptured = sources.flatMap(({ exchanges }) => exchanges);
  // The secrets: every value under a field `rule.secret` names, each
  // replaced in every form it shows in.
  const secrets: string[] = [];
  valuesUnder(
    everyCaptured.flatMap((each) => [
      bodyOf(each.body).body,
      bodyOf(each.answer).body,
      fieldsOf(new URL(each.url).searchParams),
      fieldsOf(new URLSearchParams(each.body)),
    ]),
    new Set(rule.secret),
    secrets
  );
  // An empty one is no secret.
  const given = secrets.filter((value) => value !== "");
  // One long enough is replaced within any text; a shorter one only where
  // a whole JSON value is it, as it turns up within other text by chance.
  const isLong = (value: string): boolean =>
    value.length >= minSecretWithinText;
  const longSecrets = [...new Set(given.filter(isLong))].toSorted(
    (a, b) => b.length - a.length
  );
  const shortSecrets = new Set(given.filter((value) => !isLong(value)));
  const secretForms = longSecrets.flatMap(formsOf);
  const secretFree = (text: string): string => {
    let replaced = text;
    for (const form of secretForms) {
      replaced = replaced.replaceAll(form, credentialStandIn);
    }
    return replaced;
  };
  const secretValueFree = (text: string): string =>
    shortSecrets.has(text) ? credentialStandIn : secretFree(text);
  const recordedBody = (text: string): { body?: Json; text?: string } => {
    // JSON is replaced string by string, so its syntax is never touched.
    const recorded = bodyOf(text);
    return recorded.body === undefined
      ? bodyOf(secretFree(text))
      : { body: mapJson(recorded.body, secretValueFree) };
  };
  const personal = new Set(rule.personal);
  const exchangesOf = (call: readonly Captured[]): Exchange[] =>
    call.map((each) => ({
      request: {
        method: each.method,
        url: urlOf(secretFree(each.url)),
        ...recordedBody(each.body),
      },
      answer: {
        status: each.status,
        headers: Object.fromEntries(
          Object.entries(each.headers).flatMap(([name, value]) =>
            keptHeaders.has(name.toLowerCase())
              ? [[name.toLowerCase(), secretFree(value)]]
              : []
          )
        ),
        ...recordedBody(each.answer),
      },
    }));
  const [account] =
    seen.account === undefined ? [] : exchangesOf([seen.account]);
  const cases = seen.cases.map(({ calls, ...rest }) => ({
    ...rest,
    calls: calls.map(({ exchanges }) => ({
      exchanges: exchangesOf(exchanges),
    })),
  }));

  // Personal values, in the order they first show, each with its stand-in.
  const vendorData = [
    ...(account === undefined ? [] : vendorDataOf(account)),
    ...cases.flatMap(({ args, calls }) => [
      args,
      ...calls.flatMap(({ exchanges }) => exchanges.flatMap(vendorDataOf)),
    ]),
  ];
  const found: string[] = [];
  for (const each of vendorData) {
    valuesUnder(each, personal, found);
    found.push(...emailsOf(each));
  }
  const standIns = new Map<string, string>();
  for (const value of found) {
    if (value !== "" && !standIns.has(value)) {
      const number = standIns.size + 1;
      standIns.set(
        value,
        emailLike.test(value)
          ? `person-${number}@example.com`
          : `person-${number}`
      );
    }
  }
  // Each value long enough to look for within text, as is and
  // percent-encoded, replaced in one pass, longest first, so neither a
  // value inside a longer one nor a stand-in already written is broken up.
  const withinText = new Map(
    [...standIns]
      .filter(([value]) => value.length >= minWithinText)
      .flatMap(([value, stand]) => [
        [value, stand],
        [encodeURIComponent(value), encodeURIComponent(stand)],
        [formEncoded(value), formEncoded(stand)],
      ])
  );
  const alternatives = [...withinText.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map((value) => value.replaceAll(regExpSyntax, "\\$&"));
  const asWord =
    alternatives.length === 0
      ? undefined
      : new RegExp(`(?<!\\p{L})(?:${alternatives.join("|")})(?!\\p{L})`, "gu");
  const inText = (text: string): string =>
    asWord === undefined
      ? text
      : text.replaceAll(asWord, (value) => withinText.get(value) ?? value);
  // A JSON value that is a personal value whole is replaced at any length.
  const inValue = (text: string): string => standIns.get(text) ?? inText(text);
  // Only a part that holds a personal value is written again, so the rest
  // of the URL stays exactly as the connector sent it.
  const inUrl = (text: string): string => {
    const url = new URL(text);
    url.pathname = url.pathname
      .split("/")
      .map((part) => {
        const decoded = percentDecoded(part);
        const replaced = inText(decoded);
        return replaced === decoded ? part : encodeURIComponent(replaced);
      })
      .join("/");
    const query = [...url.searchParams];
    const replaced = query.map(([name, value]) => [
      inText(name),
      inValue(value),
    ]);
    if (JSON.stringify(replaced) !== JSON.stringify(query)) {
      url.search = new URLSearchParams(replaced).toString();
    }
    return url.href;
  };
  const inBody = <Part extends { body?: Json; text?: string }>(
    part: Part
  ): Part => ({
    ...part,
    ...(part.body === undefined ? {} : { body: mapJson(part.body, inValue) }),
    ...(part.text === undefined ? {} : { text: inText(part.text) }),
  });
  const inExchange = (exchange: Exchange): Exchange => ({
    request: inBody({ ...exchange.request, url: inUrl(exchange.request.url) }),
    answer: inBody({
      ...exchange.answer,
      headers: Object.fromEntries(
        Object.entries(exchange.answer.headers).map(([name, value]) => [
          name,
          inText(value),
        ])
      ),
    }),
  });
  const fixtures = fixturesSchema.parse({
    personal: [...rule.personal],
    ...(rule.secret.length === 0 ? {} : { secret: [...rule.secret] }),
    ...(account === undefined ? {} : { account: inExchange(account) }),
    cases: cases.map(({ calls, ...rest }) => ({
      ...rest,
      calls: calls.map(({ exchanges: sent }) => ({
        exchanges: sent.map(inExchange),
      })),
    })),
  });

  for (const [index, { args }] of fixtures.cases.entries()) {
    if (JSON.stringify(mapJson(args, inValue)) !== JSON.stringify(args)) {
      throw new Error(
        `Case ${index + 1}'s arguments hold personal data, which a recording doesn't keep: call it with an id instead`
      );
    }
  }
  // What is kept, and what it decodes to: none of it may carry the
  // credential or a personal value.
  const kept = decodedIn(fixtures);
  // Personal values are looked for in what the vendor sent and answered
  // only, so a host or the file's own keys never count as one.
  const keptVendorData = decodedIn([
    ...(fixtures.account === undefined ? [] : vendorDataOf(fixtures.account)),
    ...fixtures.cases.flatMap(({ args, calls }) => [
      args,
      ...calls.flatMap(({ exchanges }) => exchanges.flatMap(vendorDataOf)),
    ]),
  ]);
  const keptSecretForms = [
    ...new Set([...longSecrets, rule.credential].flatMap(formsOf)),
  ];
  const refuseSecretsIn = (texts: readonly string[]): void => {
    if (
      texts.some((text) => keptSecretForms.some((form) => text.includes(form)))
    ) {
      throw new Error(
        "The recording still carries the credential or a secret, encoded: it isn't kept"
      );
    }
  };
  refuseSecretsIn(kept);
  // Without the stand-ins, so a value such as `example` doesn't find them,
  // and in any case, so a value a tool changed the case of is found.
  const standing = [...standIns.values()].toSorted(
    (a, b) => b.length - a.length
  );
  const withoutStandIns = (text: string): string => {
    let left = text;
    for (const stand of standing) {
      left = left.replaceAll(stand, "");
    }
    return left;
  };
  if (
    keptVendorData.some((text) =>
      [...withoutStandIns(text).matchAll(emailsIn)].some(
        ([address]) => !address.endsWith("@example.com")
      )
    )
  ) {
    throw new Error(
      "The recording carries an email address no rule could replace: it isn't kept"
    );
  }
  const refusePersonalIn = (texts: readonly string[]): void => {
    if (
      asWord !== undefined &&
      texts.some((text) =>
        new RegExp(alternatives.join("|"), "iu").test(withoutStandIns(text))
      )
    ) {
      throw new Error(
        "The recording carries personal data where it can't be replaced, such as within base64 in a cursor: it isn't kept. Record it with arguments whose answers don't"
      );
    }
  };
  refusePersonalIn(keptVendorData);
  return {
    fixtures,
    // A tool may build an address of its own, so only the secrets and the
    // personal values found are looked for in what it makes of them.
    refuseKnownIn: (value) => {
      const decoded = decodedIn(value);
      refuseSecretsIn(decoded);
      refusePersonalIn(decoded);
    },
  };
};

/**
 * The vendor, as recorded `exchanges` make it: it answers a request that
 * matches a recorded one (the same method, URL with its query in any
 * order, and body, compared as JSON where it is JSON) with that one's
 * answer, preferring one it hasn't given yet. A request it has given
 * every match of already gets the last of them again, and is kept in
 * `repeated`. A request to a host it has no recording of isn't its:
 * `answer` gives undefined and keeps nothing. One to its hosts is kept in
 * `received`, with its headers, for tests to read what was sent, and
 * gives undefined if it matches no recording.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const fixtureVendor = (exchanges: readonly Exchange[]) => {
  const given = new Set<number>();
  const received: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }[] = [];
  const repeated: string[] = [];
  const origins = new Set(
    exchanges.map(({ request }) => new URL(request.url).origin)
  );
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, each: unknown) =>
      typeof each === "object" && each !== null && !Array.isArray(each)
        ? Object.fromEntries(
            Object.entries(each).toSorted(([a], [b]) => (a < b ? -1 : 1))
          )
        : each
    );
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const pathOf = (url: URL): string =>
    url.origin +
    url.pathname
      .split("/")
      .map((part) => {
        try {
          return encodeURIComponent(decodeURIComponent(part));
        } catch {
          return part;
        }
      })
      .join("/");
  // Pairs, never joined: a decoded `=` would make two queries one.
  const queryOf = (url: URL): string =>
    canonical(
      [...url.searchParams]
        .map(([name, value]) => JSON.stringify([name, value]))
        .toSorted((a, b) => (a < b ? -1 : 1))
    );
  const sameBody = (exchange: Exchange, text: string): boolean => {
    if (exchange.request.body === undefined) {
      return text === (exchange.request.text ?? "");
    }
    try {
      return canonical(JSON.parse(text)) === canonical(exchange.request.body);
    } catch {
      return false;
    }
  };
  return {
    received,
    repeated,
    /** The recorded requests it hasn't answered. */
    unsent: (): string[] =>
      exchanges.flatMap(({ request }, index) =>
        given.has(index) ? [] : [`${request.method} ${request.url}`]
      ),
    answer: async (request: Request): Promise<Response | undefined> => {
      const url = new URL(request.url);
      if (!origins.has(url.origin)) {
        return undefined;
      }
      const text = await request.clone().text();
      received.push({
        method: request.method,
        url: url.href,
        headers: Object.fromEntries(request.headers),
      });
      const matching = exchanges.flatMap((exchange, index) => {
        const recorded = new URL(exchange.request.url);
        return exchange.request.method === request.method &&
          pathOf(recorded) === pathOf(url) &&
          queryOf(recorded) === queryOf(url) &&
          sameBody(exchange, text)
          ? [index]
          : [];
      });
      const fresh = matching.find((each) => !given.has(each));
      const index = fresh ?? matching.at(-1);
      const exchange = index === undefined ? undefined : exchanges[index];
      if (index === undefined || exchange === undefined) {
        return undefined;
      }
      if (fresh === undefined) {
        repeated.push(`${request.method} ${url.href}`);
      }
      given.add(index);
      const { status, headers, body, text: answered } = exchange.answer;
      const json = body === undefined ? null : JSON.stringify(body);
      return new Response(
        status === 204 || status === 304 ? null : (answered ?? json),
        { status, headers }
      );
    },
  };
};
