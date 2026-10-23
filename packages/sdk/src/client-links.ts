import { clientError, GraspError, readRejection } from "./client-error.ts";
import type { LinksReference } from "./references.ts";
import { isPlainObject } from "./value-descriptor.ts";

// The session client's links (spec 10.7.7, 32.3): `client.links.open`,
// which asks the trusted host to open a URL through a links resource the
// App declared, over the transport the platform gives the client
// (`LinkTransport`). The host decides whether the URL may open, asks the
// person when they didn't just click in the frame, and opens it in a
// context of its own, with no opener and no referrer: the frame gets no
// handle on it, no response and no network access, only whether the host
// accepted. Failure modes, and how each is closed:
//
// - A screen names a resource its App didn't declare, or a URL outside
//   it: the reference is read as data here and the URL sent as given;
//   core decides from the App's sealed release (the reference grants
//   nothing), and the refusal comes back with its code.
// - A screen passes off a page load as the host's word, or the reverse:
//   the promise settles when the host accepted (or refused) the open,
//   never when or whether the page loads.
// - A screen opens anything else through it: it takes a links reference
//   and a URL only; no target, features, opener or navigation of the
//   shell's.

/**
 * What the client needs of the platform to open links: the page, through
 * the frame's link port (link-port.ts), or a host's own. It rejects with a
 * coded refusal (`{ code, message }`); one without a code is a lost answer.
 */
export interface LinkTransport {
  /** Asks the host to open `url` through `resource`; resolves once it did. */
  open: (resource: string, url: string) => Promise<void>;
}

/** What `client.links.open` takes besides the resource: the URL alone. */
export interface OpenLinkOptions {
  readonly url: string;
}

const aliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** `value` read as a generated links reference: its alias, or refused. */
const linksAliasOf = (value: unknown): string => {
  if (
    !isPlainObject(value) ||
    value.kind !== "links" ||
    typeof value.alias !== "string" ||
    !aliasPattern.test(value.alias)
  ) {
    throw clientError("contract.invalid_request");
  }
  return value.alias;
};

/** `options` read as an open's: an object holding a URL string and no more. */
const urlOf = (options: unknown): string => {
  if (
    !isPlainObject(options) ||
    typeof options.url !== "string" ||
    Object.keys(options).some((key) => key !== "url")
  ) {
    throw clientError("contract.invalid_args");
  }
  return options.url;
};

/** A transport's rejection as a structured error. */
const linkFailure = (error: unknown): GraspError => {
  if (error instanceof GraspError) {
    return error;
  }
  const settled = readRejection(error);
  return settled.kind === "failed"
    ? settled.error
    : clientError("operation.unreachable");
};

/** `client.links` (spec 10.7.7): opening a links resource's URLs. */
export class ClientLinks {
  readonly #transport: LinkTransport | undefined;

  constructor(transport: LinkTransport | undefined) {
    this.#transport = transport;
  }

  /**
   * Asks the host to open `url` through `resource`. Resolves once the host
   * accepted the open, not once the page loads; rejects with the host's
   * refusal (`link.not_allowed`, `link.declined`, ...).
   */
  async open(
    resource: LinksReference,
    options: OpenLinkOptions
  ): Promise<void> {
    const alias = linksAliasOf(resource);
    const url = urlOf(options);
    if (this.#transport === undefined) {
      throw clientError("link.unavailable");
    }
    try {
      await this.#transport.open(alias, url);
    } catch (error) {
      throw linkFailure(error);
    }
  }
}
