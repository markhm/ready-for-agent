import { fpProjectOptionsFromSettings } from "../src/lib/types.js"
import { describe, expect, test } from "bun:test"

// Discovery and execution both build their project options here, so they
// agree on which statuses count as finished.
describe("fp project options from Repository settings", () => {
  test("closes fp's done and rejected and the Repository's Done status", () => {
    expect(
      fpProjectOptionsFromSettings({
        fpProjectDirectory: " /work/mc-platform ",
        fpDoneStatus: " shipped ",
      }),
    ).toEqual({
      projectDirectory: "/work/mc-platform",
      closedStatuses: ["done", "rejected", "shipped"],
    })
  })

  test("a Done status that is fp's own adds nothing", () => {
    expect(
      fpProjectOptionsFromSettings({
        fpProjectDirectory: "/work/mc-platform",
        fpDoneStatus: "done",
      })?.closedStatuses,
    ).toEqual(["done", "rejected"])
  })

  test("no Done status leaves fp's own", () => {
    for (const fpDoneStatus of [null, "", "  "]) {
      expect(
        fpProjectOptionsFromSettings({
          fpProjectDirectory: "/work/mc-platform",
          fpDoneStatus,
        })?.closedStatuses,
      ).toEqual(["done", "rejected"])
    }
  })

  test("no project directory is no project", () => {
    for (const fpProjectDirectory of [null, "", "  "]) {
      expect(
        fpProjectOptionsFromSettings({
          fpProjectDirectory,
          fpDoneStatus: "done",
        }),
      ).toBeNull()
    }
  })
})
