/**
 * CPA address normalization.
 *
 * A CPA address may point at a reverse-proxied deployment, so the subpath is
 * part of the connection and must survive normalization. The Responses runtime
 * appends `/responses` to `baseURL`, and the enhanced directory lives next to it
 * at `/models`.
 */

import { CLIENT_VERSION } from "./host"

export const DEFAULT_BASE_URL = "http://127.0.0.1:8317"

export class AddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AddressError"
  }
}

export interface CpaEndpoints {
  /** Address handed to the Responses runtime; `/responses` is appended to it. */
  readonly baseURL: string
  /** Enhanced directory URL including the `client_version` query. */
  readonly modelsURL: string
  /** Scheme and authority of the address. */
  readonly origin: string
  /** Subpath in front of `/v1`, without a trailing slash; empty at the origin root. */
  readonly rootPath: string
}

export function resolveEndpoints(input: string): CpaEndpoints {
  const raw = (input ?? "").trim()
  if (!raw) throw new AddressError("CPA address is empty")

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new AddressError(`CPA address is not a valid URL: ${raw}`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AddressError(`CPA address must use http or https: ${raw}`)
  }
  if (url.username || url.password) {
    throw new AddressError("CPA address must not embed credentials; configure the API key separately")
  }

  let path = url.pathname.replace(/\/+$/, "")
  if (path === "/v1") path = ""
  else if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length)
  const rootPath = path.replace(/\/+$/, "")

  const baseURL = `${url.origin}${rootPath}/v1`
  return {
    baseURL,
    modelsURL: `${baseURL}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`,
    origin: url.origin,
    rootPath,
  }
}
