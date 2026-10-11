/**
 * Masked key entry rules, kept out of the JSX so they can be tested.
 *
 * The dialog never renders the key: it renders `maskedDisplay`, and the only
 * place the real value exists is this accumulator.
 */

export interface KeyStroke {
  readonly name: string
  readonly sequence?: string | undefined
  readonly ctrl?: boolean | undefined
  readonly meta?: boolean | undefined
  readonly option?: boolean | undefined
}

export type MaskedKeyOutcome =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "submit"; readonly value: string }
  | { readonly kind: "cancel" }
  | { readonly kind: "ignore" }

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function applyMaskedKey(value: string, key: KeyStroke): MaskedKeyOutcome {
  if (key.name === "return" || key.name === "enter") return { kind: "submit", value }
  if (key.name === "escape") return { kind: "cancel" }
  if (key.name === "backspace" || key.name === "delete") return { kind: "value", value: value.slice(0, -1) }
  if (key.ctrl || key.meta || key.option) return { kind: "ignore" }
  const sequence = key.sequence
  if (typeof sequence === "string" && sequence.length > 0 && !CONTROL_CHARACTERS.test(sequence)) {
    return { kind: "value", value: value + sequence }
  }
  return { kind: "ignore" }
}

/** Renderable form of the accumulator: a bullet per character, never the value. */
export function maskedDisplay(length: number, empty = "(typing is hidden)"): string {
  return length === 0 ? empty : "\u2022".repeat(length)
}
