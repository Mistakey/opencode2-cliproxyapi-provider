/**
 * The persisted Fast preference.
 *
 * Fast is a durable, provider-scoped preference, not a model capability: the
 * directory decides which models may receive the priority parameter, and the
 * preference decides whether they do. It is stored through OpenCode's own
 * storage, so it survives a location or service restart.
 */

/** The slice of OpenCode's storage the Fast preference uses. */
export interface PreferenceStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: boolean): Promise<void>
}

/** Durable key for one provider's preference; storage is already location-scoped. */
export function fastStorageKey(providerID: string): string {
  return `cliproxyapi.fast.${providerID}`
}

/** A stored value is a boolean, or an object with an `enabled` flag. Anything else is off. */
export function parseFastPreference(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const enabled = (value as Record<string, unknown>).enabled
    if (typeof enabled === "boolean") return enabled
  }
  return false
}

/** Read the preference; an unreadable store leaves Fast off rather than blocking setup. */
export async function readFastPreference(storage: PreferenceStorage, key: string): Promise<boolean> {
  try {
    return parseFastPreference(await storage.get(key))
  } catch {
    return false
  }
}

export async function writeFastPreference(
  storage: PreferenceStorage,
  key: string,
  enabled: boolean,
): Promise<void> {
  await storage.set(key, enabled)
}
