import rfaNumber from "../extension/rfa-number/index.js"
import { describe, expect, test } from "bun:test"

type Registration = {
  readonly key: string
  readonly options: {
    readonly label?: string
    readonly display: unknown
    readonly schema?: unknown
  }
}

const register = async (): Promise<Registration> => {
  const registrations: Registration[] = []
  await rfaNumber({
    issues: {
      registerProperty: async (key, options) => {
        registrations.push({ key, options })
      },
    },
    ui: { properties: { text: () => ({ type: "text" }) } },
  })
  expect(registrations).toHaveLength(1)
  return registrations[0] as Registration
}

const validate = async (value: unknown) => {
  const { options } = await register()
  const schema = options.schema as {
    readonly "~standard": { validate: (value: unknown) => unknown }
  }
  return schema["~standard"].validate(value)
}

// The extension is copied verbatim into ~/.fiberplane/extensions; fp loads
// it outside this repository (ADR 0074).
describe("rfa-number fp extension", () => {
  test("registers rfa-number as a text property", async () => {
    const { key, options } = await register()
    expect(key).toBe("rfa-number")
    expect(options.display).toEqual({ type: "text" })
  })

  test("accepts a positive integer, and empty so a number can be cleared", async () => {
    for (const value of ["1", "42", "1500", "", null, undefined]) {
      expect(await validate(value)).toEqual({ value })
    }
  })

  test("refuses anything else", async () => {
    for (const value of ["0", "01", "-3", "1.5", "abc", " 4", 4]) {
      expect(await validate(value)).toEqual({
        issues: [
          { message: "rfa-number must be a positive integer, or empty" },
        ],
      })
    }
  })
})
