/**
 * ready-for-agent's fp extension: registers the `rfa-number` property, where
 * the harness keeps the number it allocates to each fp Issue it works
 * (ADR 0074). Copied verbatim into `~/.fiberplane/extensions/rfa-number/` on
 * the machine that runs the harness; see README.md next to this file.
 *
 * Self-contained on purpose: fp loads it on its own, outside this repository,
 * so it imports nothing and types only what it uses.
 */

type StandardResult =
  | { readonly value: unknown }
  | { readonly issues: readonly { readonly message: string }[] }

interface FpExtensionContext {
  readonly issues: {
    registerProperty(
      key: string,
      options: {
        readonly label?: string
        readonly icon?: string
        readonly display: unknown
        readonly schema?: unknown
      },
    ): Promise<void>
  }
  readonly ui: { readonly properties: { text(): unknown } }
}

// A positive integer, or empty: fp clears a property by writing it empty.
const positiveIntegerOrEmpty = {
  "~standard": {
    version: 1,
    vendor: "ready-for-agent",
    validate: (value: unknown): StandardResult =>
      value === undefined ||
      value === null ||
      value === "" ||
      (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
        ? { value }
        : {
            issues: [
              { message: "rfa-number must be a positive integer, or empty" },
            ],
          },
  },
}

export default async function rfaNumber(fp: FpExtensionContext) {
  await fp.issues.registerProperty("rfa-number", {
    label: "RFA number",
    icon: "hash",
    display: fp.ui.properties.text(),
    schema: positiveIntegerOrEmpty,
  })
}
