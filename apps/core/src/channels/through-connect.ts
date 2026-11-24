import type { InternalAxiosRequestConfig } from "axios";

/**
 * One request of an adapter whose platform SDK sends through axios (Slack's
 * Web API client, Microsoft's Teams SDK), set to go out through connect:
 * by axios' fetch adapter, with `send`, which hands it to connect to send
 * as the client's own bot.
 *
 * Each is a call to the platform's API that no cache may answer, so it says
 * `no-store` itself. Left unset, axios' fetch adapter fills in the
 * browser's `cache: "default"` (from 1.20.0), which workerd refuses as it
 * builds the request ("Unsupported cache mode"); a mode the request sets is
 * never replaced.
 */
export const throughConnect = (
  config: InternalAxiosRequestConfig,
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): InternalAxiosRequestConfig => {
  config.adapter = "fetch";
  config.env = { ...config.env, fetch: send };
  config.fetchOptions = { ...config.fetchOptions, cache: "no-store" };
  return config;
};
