import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import {
  type FpProjectDetailsView,
  type FpProjectsView,
  RepositorySettingsFpSection,
  effectiveFpStatus,
  fpProjectDetailsViewFromQuery,
  fpProjectsViewFromQuery,
} from "../src/repository-settings-fp.js"
import { describe, expect, test } from "bun:test"

const loaded: FpProjectsView = {
  kind: "loaded",
  projects: [
    { name: "widgets", path: "/work/widgets", orphaned: false },
    { name: "gone", path: "/work/gone", orphaned: true },
  ],
}

const ready: FpProjectDetailsView = {
  kind: "ready",
  version: "0.25.0",
  workspaceSlug: "mhm",
  statuses: ["todo", "in-progress", "review", "done"],
}

const render = (
  props: Partial<Parameters<typeof RepositorySettingsFpSection>[0]> = {},
) =>
  renderToStaticMarkup(
    <RepositorySettingsFpSection
      projects={loaded}
      projectDirectory="/work/widgets"
      onProjectDirectoryChange={() => {}}
      details={ready}
      inProgressStatus="in-progress"
      doneStatus="done"
      onInProgressStatusChange={() => {}}
      onDoneStatusChange={() => {}}
      {...props}
    />,
  )

describe("Repository settings fp section", () => {
  test("offers the registered projects, the folder, readiness and the project's statuses, with no credential prompt", () => {
    const html = render()
    expect(html).toContain("fp project")
    expect(html).toContain(
      '<option value="/work/widgets" selected="">widgets</option>',
    )
    expect(html).toContain(
      '<option value="/work/gone" disabled="">gone (folder missing)</option>',
    )
    expect(html).toContain("/work/widgets</span>")
    expect(html).toContain("Ready · fp 0.25.0 · synced to mhm")
    for (const status of ["todo", "in-progress", "review", "done"]) {
      expect(html.split(`<option value="${status}"`).length - 1).toBe(2)
    }
    expect(html).toContain('<option value="in-progress" selected="">')
    expect(html).toContain('<option value="done" selected="">')
    expect(html).toContain("fp needs no credential")
    expect(html).toContain("ready-for-agent label")
    expect(html).not.toContain("API key")
    // Only the orphaned project is disabled: every select is usable.
    expect(html.match(/disabled=""/g)?.length).toBe(1)
  })

  test("says when the project is not synced to a workspace", () => {
    expect(render({ details: { ...ready, workspaceSlug: null } })).toContain(
      "Ready · fp 0.25.0 · not synced",
    )
  })

  test("waits for the project list before a project can be picked", () => {
    const html = render({
      projects: { kind: "pending" },
      projectDirectory: "",
      details: { kind: "none" },
    })
    expect(html).toContain("Loading fp projects…")
    expect(html).toMatch(
      /<select[^>]*disabled=""[^>]*><option value="" selected="">Loading fp projects…/,
    )
    expect(html).not.toContain("Ready ·")
  })

  test("raises an alarm when fp projects cannot be listed", () => {
    const html = render({
      projects: { kind: "unavailable", message: "fp is not on the PATH" },
    })
    expect(html).toContain(
      "fp projects could not be listed: fp is not on the PATH",
    )
  })

  test("blocks status choice while the project is not ready", () => {
    const html = render({
      details: { kind: "not_ready", message: "Project is not registered" },
    })
    expect(html).toContain("Not ready: Project is not registered")
    expect(html.match(/<select[^>]*disabled=""/g)?.length).toBe(2)
  })

  test("keeps a saved project that fp no longer lists, so it is not silently replaced", () => {
    const html = render({
      projectDirectory: "/work/moved",
      details: { kind: "pending" },
    })
    expect(html).toContain(
      '<option value="/work/moved" selected="">/work/moved</option>',
    )
    expect(html).toContain("Checking the fp project…")
  })
})

describe("fp status defaults", () => {
  test("keeps a chosen status the project registers", () => {
    expect(effectiveFpStatus(ready, "review", "in-progress")).toBe("review")
  })

  test("falls back to the fp default when the choice is empty or no longer registered", () => {
    expect(effectiveFpStatus(ready, "", "in-progress")).toBe("in-progress")
    expect(effectiveFpStatus(ready, "doing", "done")).toBe("done")
  })

  test("chooses nothing when the project registers neither", () => {
    expect(
      effectiveFpStatus({ ...ready, statuses: ["open", "closed"] }, "", "done"),
    ).toBe("")
  })

  test("leaves the choice alone until the project's statuses are known", () => {
    expect(effectiveFpStatus({ kind: "pending" }, "doing", "done")).toBe(
      "doing",
    )
  })
})

describe("fp query views", () => {
  test("project list", () => {
    expect(
      fpProjectsViewFromQuery({ pending: true, data: undefined, error: null }),
    ).toEqual({ kind: "pending" })
    expect(
      fpProjectsViewFromQuery({
        pending: false,
        data: { available: false, message: "no fp", projects: [] },
        error: null,
      }),
    ).toEqual({ kind: "unavailable", message: "no fp" })
    expect(
      fpProjectsViewFromQuery({
        pending: false,
        data: undefined,
        error: new Error("offline"),
      }),
    ).toEqual({ kind: "unavailable", message: "offline" })
    expect(
      fpProjectsViewFromQuery({
        pending: false,
        data: { available: true, message: null, projects: loaded.projects },
        error: null,
      }),
    ).toEqual(loaded)
  })

  test("project details", () => {
    const base = {
      projectDirectory: "/work/widgets",
      pending: false,
      error: null,
    }
    expect(
      fpProjectDetailsViewFromQuery({
        ...base,
        projectDirectory: "",
        pending: true,
        data: undefined,
      }),
    ).toEqual({ kind: "none" })
    expect(
      fpProjectDetailsViewFromQuery({
        ...base,
        pending: true,
        data: undefined,
      }),
    ).toEqual({
      kind: "pending",
    })
    expect(
      fpProjectDetailsViewFromQuery({
        ...base,
        data: { ready: false, message: "not registered", statuses: [] },
      }),
    ).toEqual({ kind: "not_ready", message: "not registered" })
    expect(
      fpProjectDetailsViewFromQuery({
        ...base,
        data: {
          ready: true,
          message: null,
          version: "0.25.0",
          workspaceSlug: "mhm",
          statuses: ready.statuses,
        },
      }),
    ).toEqual(ready)
  })
})

describe("Repository settings dialog wiring for fp", () => {
  const source = readFileSync(
    join(import.meta.dir, "../src/home-page-content.tsx"),
    "utf8",
  )
  const query = readFileSync(
    join(import.meta.dir, "../src/repositories-query.ts"),
    "utf8",
  )

  test("shows the fp section only when the tracker maps an fp project", () => {
    expect(source).toContain("{usesFpProjectMapping(issueTracker) && (")
    expect(source).toContain("<RepositorySettingsFpSection")
  })

  test("saves the fp settings with the shown statuses, and clears them for any other tracker", () => {
    for (const field of [
      'fpProjectDirectory:\n        forge === "github" && usesFpProjectMapping(issueTracker)\n          ? fpProjectDirectory\n          : null,',
      'fpInProgressStatus:\n        forge === "github" && usesFpProjectMapping(issueTracker)\n          ? fpEffectiveInProgressStatus\n          : null,',
      'fpDoneStatus:\n        forge === "github" && usesFpProjectMapping(issueTracker)\n          ? fpEffectiveDoneStatus\n          : null,',
    ]) {
      expect(source).toContain(field)
    }
  })

  test("reads the fp settings back from the Repository and from the save", () => {
    for (const field of [
      "fpProjectDirectory: true",
      "fpInProgressStatus: true",
      "fpDoneStatus: true",
    ]) {
      expect(query).toContain(field)
      expect(source).toContain(field)
    }
  })
})
