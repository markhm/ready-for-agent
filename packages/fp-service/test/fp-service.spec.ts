import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Result } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FpRequestError } from "../src/lib/errors.js"
import type { FpServiceShape } from "../src/lib/fp-service.js"
import { makeFpService } from "../src/lib/fp-service-live.js"
import { fpMilestoneMarker } from "../src/lib/types.js"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

/**
 * A fake `fp` executable in a temporary directory, the fake-CLI pattern the
 * Agent Backend suites use. It serves canned JSON per command from a
 * fixtures directory, records every invocation, and fails the way fp 0.25.0
 * fails when a marker file exists.
 */

const ISSUE_ID = (seed: string): string => seed.repeat(32).slice(0, 32)
const ROOT_A = ISSUE_ID("a")
const CHILD_B = ISSUE_ID("b")
const CHILD_C = ISSUE_ID("c")
const DONE_D = ISSUE_ID("d")
const ROOT_E = ISSUE_ID("e")
const CHILD_F = ISSUE_ID("f")
const SELECTED_G = ISSUE_ID("g")

type Fixture = {
  readonly id: string
  readonly shortId: string
  readonly title: string
  readonly status: string
  readonly parent: string | null
  readonly dependencies: readonly string[]
  readonly labels: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly author?: string | null
}

const fixture = (
  id: string,
  overrides: Partial<Fixture> & Pick<Fixture, "title" | "status">,
): Fixture => ({
  id,
  shortId: id.slice(0, 8),
  parent: null,
  dependencies: [],
  labels: [],
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-21T10:00:00.000Z",
  author: "operator@example.com",
  ...overrides,
})

const displayIdOf = (id: string): string => `FP-${id.slice(0, 8)}`

const PROJECT: readonly Fixture[] = [
  fixture(ROOT_A, {
    title: "Root A",
    status: "todo",
    labels: ["ready-for-agent", "epic"],
  }),
  fixture(CHILD_B, {
    title: "Child B",
    status: "todo",
    parent: ROOT_A,
    dependencies: [CHILD_C],
    labels: ["ready-for-agent"],
    createdAt: "2026-09-20T11:00:00.000Z",
  }),
  fixture(CHILD_C, {
    title: "Child C",
    status: "todo",
    parent: ROOT_A,
    createdAt: "2026-09-20T12:00:00.000Z",
  }),
  fixture(DONE_D, {
    title: "Done D",
    status: "done",
    labels: ["ready-for-agent"],
  }),
  fixture(ROOT_E, {
    title: "Root E",
    status: "todo",
    labels: ["ready-for-agent"],
    createdAt: "2026-09-20T10:30:00.000Z",
  }),
  fixture(CHILD_F, { title: "Child F", status: "todo", parent: ROOT_E }),
  fixture(SELECTED_G, {
    title: "Selected G",
    status: "selected",
    labels: ["ready-for-agent"],
    author: null,
    createdAt: "2026-09-20T10:45:00.000Z",
  }),
]

let directory = ""
let fixturesDirectory = ""
let commandPath = ""
let logPath = ""
let project = { projectDirectory: "" }

const writeProject = async (issues: readonly Fixture[]) => {
  await rm(fixturesDirectory, { recursive: true, force: true })
  await Bun.write(join(fixturesDirectory, ".keep"), "")
  const list = {
    issues: issues.map((issue) => ({
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      description: `Body of ${issue.title}`,
      status: issue.status,
      priority: "medium",
      parent: issue.parent,
      dependencies: issue.dependencies,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    })),
  }
  await writeFile(join(fixturesDirectory, "list.json"), JSON.stringify(list))
  for (const issue of issues) {
    const show = {
      id: issue.id,
      displayId: displayIdOf(issue.id),
      title: issue.title,
      description: `Body of ${issue.title}`,
      status: issue.status,
      priority: "medium",
      parent: issue.parent,
      dependencies: issue.dependencies,
      revisions: [],
      author: issue.author,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      properties: { labels: issue.labels },
      comments: [],
    }
    const json = JSON.stringify(show)
    // fp accepts the native id and the display id alike.
    await writeFile(join(fixturesDirectory, `show-${issue.id}.json`), json)
    await writeFile(
      join(fixturesDirectory, `show-${displayIdOf(issue.id)}.json`),
      json,
    )
  }
}

const marker = (name: string) => writeFile(join(fixturesDirectory, name), "")

/**
 * The fake's writes: JSON editing the shell script delegates to Bun. Status
 * writes rewrite both `show-*.json` copies; comments live in
 * `comments-<nativeId>.json`, newest first as `fp comment list` prints them.
 * A body file's content is stored trimmed, as fp 0.25.0 does.
 */
const MUTATE_SCRIPT = `
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const [op, fixtures, target, value] = process.argv.slice(2)
const showFile = (id) => join(fixtures, \`show-\${id}.json\`)
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))
const body = (file) => readFileSync(file, "utf8").trim()
const commentsFile = (issueId) => join(fixtures, \`comments-\${issueId}.json\`)
const comments = (issueId) =>
  existsSync(commentsFile(issueId)) ? readJson(commentsFile(issueId)) : { comments: [] }
if (op === "status") {
  const show = readJson(showFile(target))
  show.status = value
  show.updatedAt = new Date().toISOString()
  const json = JSON.stringify(show)
  writeFileSync(showFile(show.id), json)
  writeFileSync(showFile(show.displayId), json)
} else if (op === "list") {
  process.stdout.write(JSON.stringify(comments(readJson(showFile(target)).id)))
} else if (op === "add") {
  const show = readJson(showFile(target))
  const list = comments(show.id)
  list.comments.unshift({
    id: \`comment-\${list.comments.length + 1}\`,
    issueId: show.id,
    author: "operator@example.com",
    content: body(value),
    createdAt: new Date().toISOString(),
  })
  writeFileSync(commentsFile(show.id), JSON.stringify(list))
} else if (op === "update") {
  for (const name of readdirSync(fixtures).filter((n) => n.startsWith("comments-"))) {
    const list = readJson(join(fixtures, name))
    const comment = list.comments.find((c) => c.id === target)
    if (comment !== undefined) {
      comment.content = body(value)
      writeFileSync(join(fixtures, name), JSON.stringify(list))
      process.exit(0)
    }
  }
  process.exit(3)
}
`

const fakeFpScript = (
  fixtures: string,
  log: string,
  bun: string,
  mutate: string,
): string => `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
notfound() { printf '%s\\n' "Issue $1 not found" "  Suggestion: Run 'fp issue list' to see available issues"; exit 1; }
if [ "$1" = "issue" ] && [ "$2" = "update" ]; then
  if [ -f "${fixtures}/invalid-status" ]; then
    printf '%s\\n' "Invalid status: Status \\"$5\\" is not in the registered options." "  Suggestion: Use one of: todo, in-progress, done"
    exit 1
  fi
  [ -f "${fixtures}/show-$3.json" ] || notfound "$3"
  if [ ! -f "${fixtures}/silent" ]; then "${bun}" "${mutate}" status "${fixtures}" "$3" "$5" || exit 1; fi
  printf '%s\\n' "" "✓ Updated $3:" "  - status: todo → $5" ""
  exit 0
fi
if [ "$1" = "comment" ]; then
  if [ "$2" = "list" ]; then
    [ -f "${fixtures}/show-$3.json" ] || notfound "$3"
    "${bun}" "${mutate}" list "${fixtures}" "$3"; exit $?
  fi
  if [ "$2" = "add" ]; then
    [ -f "${fixtures}/show-$3.json" ] || notfound "$3"
    if [ ! -f "${fixtures}/silent" ]; then "${bun}" "${mutate}" add "${fixtures}" "$3" "$5" || exit 1; fi
    printf '%s\\n' "" "Added comment to $3" ""
    exit 0
  fi
  if [ "$2" = "update" ]; then
    if [ -f "${fixtures}/stale-comment" ]; then printf '%s\\n' "Comment $3 not found" "  Suggestion: Run 'fp comment list <issue-id>' to see available comments"; exit 1; fi
    if [ ! -f "${fixtures}/silent" ]; then
      "${bun}" "${mutate}" update "${fixtures}" "$3" "$5"
      if [ $? -eq 3 ]; then printf '%s\\n' "Comment $3 not found" "  Suggestion: Run 'fp comment list <issue-id>' to see available comments"; exit 1; fi
    fi
    printf '%s\\n' "" "Updated comment $3" ""
    exit 0
  fi
fi
if [ -f "${fixtures}/hang" ]; then sleep 30; exit 0; fi
if [ -f "${fixtures}/crash" ]; then kill -9 $$; fi
if [ "$1" = "--version" ]; then echo "0.25.0 (d818046)"; exit 0; fi
if [ "$1" = "auth" ]; then
  printf '%s\\n' "✓ Token valid" "" "  Source: /home/op/.fiberplane/credentials.toml" "  Token: abc..." "" "  Name: Operator" "  Email: operator@example.com" ""
  exit 0
fi
if [ "$1" = "project" ] && [ "$2" = "remote" ]; then
  if [ -f "${fixtures}/remote-broken" ]; then
    printf '%s\\n' "Failed to read .fp/remote.toml: invalid TOML" >&2
    exit 1
  fi
  if [ -f "${fixtures}/unlinked" ]; then
    printf '%s\\n' "Project not linked to remote" "  Suggestion: No local project is registered here and no remote identity was found." >&2
    exit 1
  fi
  printf '%s\\n' '{"projectId":"proj-test","workspaceSlug":"ws-test","serverUrl":"https://app.fp.dev","linkedAt":"2026-09-21T06:17:07.152Z","lastSyncedAt":"2026-09-22T11:12:06.121Z"}'
  exit 0
fi
if [ -f "${fixtures}/unregistered" ]; then
  printf '%s\\n' ".fp directory not found" "  Suggestion: Run 'fp init' to initialize a project" >&2
  exit 1
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  if [ -f "${fixtures}/hang-list" ]; then sleep 30; exit 0; fi
  if [ -f "${fixtures}/list-broken" ]; then printf '%s\\n' "database is locked" >&2; exit 1; fi
  cat "${fixtures}/list.json"; exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "show" ]; then
  if [ -f "${fixtures}/malformed" ]; then echo "{not json"; exit 0; fi
  f="${fixtures}/show-$3.json"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  printf '%s\\n' "Issue $3 not found" "  Suggestion: Run 'fp issue list' to see available issues" >&2
  exit 1
fi
echo "Unknown arguments: $*" >&2
exit 1
`

const linkFor = (nativeId: string): string =>
  `fp://issue?workspace=ws-test&project=proj-test&id=${nativeId}`

const calls = async (): Promise<readonly string[]> => {
  try {
    const text = await readFile(logPath, "utf8")
    return text.split("\n").filter((line) => line !== "")
  } catch {
    return []
  }
}

const showCalls = async (): Promise<number> =>
  (await calls()).filter((line) => line.startsWith("issue show ")).length

type ServiceOverrides = {
  readonly command?: string
  readonly timeout?: Duration.Duration
}

const makeService = (overrides: ServiceOverrides = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return makeFpService({
      spawner,
      command: overrides.command ?? commandPath,
      ...(overrides.timeout === undefined
        ? {}
        : { timeout: overrides.timeout }),
    })
  }).pipe(Effect.provide(BunServices.layer))

const withService = <A, E>(
  use: (service: FpServiceShape) => Effect.Effect<A, E>,
  overrides: ServiceOverrides = {},
) => Effect.flatMap(makeService(overrides), use)

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const failureOf = async <A>(
  effect: Effect.Effect<A, FpRequestError>,
): Promise<FpRequestError> => {
  const result = await run(effect.pipe(Effect.result))
  if (Result.isSuccess(result)) {
    throw new Error("expected a failure")
  }
  expect(result.failure).toBeInstanceOf(FpRequestError)
  return result.failure
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "fp-service-"))
  fixturesDirectory = join(directory, "fixtures")
  commandPath = join(directory, "fp")
  logPath = join(directory, "calls.log")
  project = { projectDirectory: directory }
  const mutatePath = join(directory, "mutate.ts")
  await writeFile(mutatePath, MUTATE_SCRIPT)
  await writeFile(
    commandPath,
    fakeFpScript(fixturesDirectory, logPath, process.execPath, mutatePath),
  )
  await chmod(commandPath, 0o700)
})

beforeEach(async () => {
  await rm(logPath, { force: true })
  await writeProject(PROJECT)
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("FpService.listReadyIssues", () => {
  test("returns open Ready-labeled Issues in creation order with hierarchy and blocker facts", async () => {
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues.map((issue) => issue.title)).toEqual([
      "Root A",
      "Root E",
      "Selected G",
      "Child B",
    ])

    const rootA = issues[0]
    expect(rootA?.nativeId).toBe(ROOT_A)
    expect(rootA?.displayId).toBe(displayIdOf(ROOT_A))
    expect(rootA?.url).toBe(linkFor(ROOT_A))
    expect(rootA?.state).toBe("OPEN")
    expect(rootA?.parent).toBeNull()
    expect(rootA?.parentPosition).toBeNull()
    expect(rootA?.hasChildren).toBe(true)
    expect(rootA?.hierarchySupported).toBe(true)
    expect(rootA?.author).toBe("operator@example.com")
    expect(rootA?.body).toBe("Body of Root A")
    expect(rootA?.labels).toEqual(["ready-for-agent", "epic"])

    const childB = issues[3]
    expect(childB?.parent).toEqual({
      nativeId: ROOT_A,
      displayId: displayIdOf(ROOT_A),
      url: linkFor(ROOT_A),
      state: "OPEN",
      isReadyLabeled: true,
    })
    // B was created before C among A's children.
    expect(childB?.parentPosition).toBe(1)
    expect(childB?.hasChildren).toBe(false)
    expect(childB?.blockedBy).toEqual([
      {
        nativeId: CHILD_C,
        displayId: displayIdOf(CHILD_C),
        url: linkFor(CHILD_C),
      },
    ])

    // E has a child (unlabeled F), so it is a parent, not a leaf.
    expect(issues[1]?.hasChildren).toBe(true)
    // G has no author in fp.
    expect(issues[2]?.author).toBeNull()
    expect(issues[2]?.status).toBe("selected")
  })

  test("a closed Issue is never a candidate, even when labeled", async () => {
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues.some((issue) => issue.nativeId === DONE_D)).toBe(false)
    const shown = await calls()
    expect(shown.some((line) => line.includes(DONE_D))).toBe(false)
  })

  test("closedStatuses is the project's own closed set", async () => {
    const issues = await run(
      withService((service) =>
        service.listReadyIssues({
          ...project,
          closedStatuses: ["done", "selected"],
        }),
      ),
    )
    expect(issues.map((issue) => issue.title)).toEqual([
      "Root A",
      "Root E",
      "Child B",
    ])
  })

  test("inspects only open Issues, and only once per poll", async () => {
    await run(withService((service) => service.listReadyIssues(project)))
    // Six open Issues (A, B, C, E, F, G); their parents are candidates too,
    // so no extra show is needed for them.
    expect(await showCalls()).toBe(6)
  })

  test("a Ready child of a closed parent reports the parent closed, at the cost of one extra show", async () => {
    const CHILD_H = ISSUE_ID("h")
    await writeProject([
      ...PROJECT,
      fixture(CHILD_H, {
        title: "Child H",
        status: "todo",
        parent: DONE_D,
        labels: ["ready-for-agent"],
      }),
    ])
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    const childH = issues.find((issue) => issue.title === "Child H")
    expect(childH?.parent).toEqual({
      nativeId: DONE_D,
      displayId: displayIdOf(DONE_D),
      url: linkFor(DONE_D),
      state: "CLOSED",
      isReadyLabeled: true,
    })
    expect(childH?.parentPosition).toBe(1)
    // Seven open candidates plus the closed parent D.
    expect(await showCalls()).toBe(8)
  })

  test("candidateStatuses narrows the inspection to those statuses", async () => {
    const issues = await run(
      withService((service) =>
        service.listReadyIssues({
          ...project,
          candidateStatuses: ["selected"],
        }),
      ),
    )
    expect(issues.map((issue) => issue.title)).toEqual(["Selected G"])
    expect(await showCalls()).toBe(1)
  })

  test("re-reads only Issues whose updatedAt moved since the last poll", async () => {
    const service = await run(makeService())
    const first = await run(service.listReadyIssues(project))
    expect(first).toHaveLength(4)
    expect(await showCalls()).toBe(6)

    await rm(logPath, { force: true })
    const second = await run(service.listReadyIssues(project))
    expect(second).toEqual(first)
    expect(await showCalls()).toBe(0)

    // A label edit moves updatedAt on fp 0.25.0 (as do parent, dependency
    // and comment edits; measured 2026-09-22); only that Issue is re-read.
    await rm(logPath, { force: true })
    await writeProject(
      PROJECT.map((issue) =>
        issue.id === ROOT_E
          ? { ...issue, labels: [], updatedAt: "2026-09-22T09:00:00.000Z" }
          : issue,
      ),
    )
    const third = await run(service.listReadyIssues(project))
    expect(third.map((issue) => issue.title)).toEqual([
      "Root A",
      "Selected G",
      "Child B",
    ])
    expect(await showCalls()).toBe(1)
  })

  test("re-reads the remote identity every poll, so unlinking takes effect without a restart", async () => {
    const service = await run(makeService())
    const before = await run(service.listReadyIssues(project))
    expect(before[0]?.url).toBe(linkFor(ROOT_A))
    await marker("unlinked")
    const after = await run(service.listReadyIssues(project))
    expect(after[0]?.url).toBe(`fp://issue?id=${ROOT_A}`)
    const remoteCalls = (await calls()).filter((line) =>
      line.startsWith("project remote"),
    )
    expect(remoteCalls).toHaveLength(2)
  })

  test("links by id only when the project is not linked to a remote", async () => {
    await marker("unlinked")
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues[0]?.url).toBe(`fp://issue?id=${ROOT_A}`)
    expect(issues[3]?.parent?.url).toBe(`fp://issue?id=${ROOT_A}`)
  })

  test("linking the project after the harness started takes effect on the next poll", async () => {
    await marker("unlinked")
    const service = await run(makeService())
    const before = await run(service.listReadyIssues(project))
    expect(before[0]?.url).toBe(`fp://issue?id=${ROOT_A}`)
    await rm(join(fixturesDirectory, "unlinked"))
    const after = await run(service.listReadyIssues(project))
    expect(after[0]?.url).toBe(linkFor(ROOT_A))
  })

  test("a failing remote lookup is an error, not an unlinked project", async () => {
    await marker("remote-broken")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(failure.message).toContain("remote identity")
    expect(failure.stderr).toContain("invalid TOML")
  })

  test("parent and blockers come from this poll's list, not from the cached show", async () => {
    const service = await run(makeService())
    await run(service.listReadyIssues(project))
    // The operator adds a dependency C -> B and reparents G under E; fp
    // moves updatedAt for both, but even a list that did not would carry
    // the new facts, and the poll must use them.
    const list = JSON.parse(
      await readFile(join(fixturesDirectory, "list.json"), "utf8"),
    ) as {
      issues: { id: string; parent: string | null; dependencies: string[] }[]
    }
    for (const issue of list.issues) {
      if (issue.id === ROOT_A) {
        issue.dependencies = [ROOT_E]
      }
      if (issue.id === SELECTED_G) {
        issue.parent = ROOT_E
      }
    }
    await writeFile(join(fixturesDirectory, "list.json"), JSON.stringify(list))
    await rm(logPath, { force: true })
    const issues = await run(service.listReadyIssues(project))
    expect(await showCalls()).toBe(0)
    const rootA = issues.find((issue) => issue.nativeId === ROOT_A)
    expect(rootA?.blockedBy.map((blocker) => blocker.nativeId)).toEqual([
      ROOT_E,
    ])
    const selectedG = issues.find((issue) => issue.nativeId === SELECTED_G)
    expect(selectedG?.parent?.nativeId).toBe(ROOT_E)
  })

  test("a blocker that was never shown gets its display id from the project prefix", async () => {
    await writeProject([
      fixture(ISSUE_ID("h"), {
        title: "Blocked H",
        status: "todo",
        labels: ["ready-for-agent"],
        dependencies: [DONE_D],
      }),
      fixture(DONE_D, { title: "Done D", status: "done" }),
    ])
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues).toHaveLength(1)
    // D is closed, so it was never inspected; its display id is inferred.
    expect(await showCalls()).toBe(1)
    expect(issues[0]?.blockedBy).toEqual([
      {
        nativeId: DONE_D,
        displayId: displayIdOf(DONE_D),
        url: linkFor(DONE_D),
      },
    ])
  })

  test("forgets the cached show of an Issue that left the project", async () => {
    const service = await run(makeService())
    await run(service.listReadyIssues(project))
    await writeProject(PROJECT.filter((issue) => issue.id !== ROOT_E))
    await run(service.listReadyIssues(project))
    // E returns with the same updatedAt: without eviction it would be served
    // from the cache; with it, E is shown again.
    await writeProject(PROJECT)
    await rm(logPath, { force: true })
    await run(service.listReadyIssues(project))
    expect(await showCalls()).toBe(1)
  })

  test("an Issue that vanishes between list and show is dropped, not fatal", async () => {
    await rm(join(fixturesDirectory, `show-${ROOT_E}.json`))
    await rm(join(fixturesDirectory, `show-${displayIdOf(ROOT_E)}.json`))
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues.map((issue) => issue.title)).toEqual([
      "Root A",
      "Selected G",
      "Child B",
    ])
  })

  test("a child whose parent is missing from the project is reported under a closed, unready parent", async () => {
    await writeProject([
      ...PROJECT,
      fixture(ISSUE_ID("h"), {
        title: "Orphan H",
        status: "todo",
        parent: ISSUE_ID("z"),
        labels: ["ready-for-agent"],
      }),
    ])
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    const orphan = issues.find((issue) => issue.title === "Orphan H")
    expect(orphan?.parent).toEqual({
      nativeId: ISSUE_ID("z"),
      displayId: ISSUE_ID("z"),
      url: linkFor(ISSUE_ID("z")),
      state: "CLOSED",
      isReadyLabeled: false,
    })
    expect(orphan?.parentPosition).toBeNull()
  })

  test("fails with a clear message when the directory is not an fp project", async () => {
    await marker("unregistered")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(failure.message).toContain("not a registered fp project")
    expect(failure.exitCode).toBe(1)
    expect(failure.kind).toBe("project_not_registered")
  })

  test("fails with a clear message when the fp CLI is absent", async () => {
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project), {
        command: join(directory, "no-such-fp"),
      }),
    )
    expect(failure.message).toContain("the fp CLI is not on the PATH")
    expect(failure.kind).toBe("spawn_failed")
  })

  test("fails with a clear message when fp does not finish in time", async () => {
    await marker("hang")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project), {
        timeout: Duration.millis(300),
      }),
    )
    expect(failure.message).toContain("did not finish within 300 ms")
    expect(failure.kind).toBe("timeout")
  })

  test("fails with a clear message when fp dies by signal", async () => {
    await marker("crash")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(failure.message).not.toContain("not on the PATH")
    expect(failure.message).toContain("failed before exiting")
  })

  test("fails with a clear message when fp prints unreadable JSON", async () => {
    await marker("malformed")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(failure.message).toContain(
      "Could not read fp output while reading fp issue",
    )
    expect(failure.kind).toBe("unreadable_output")
  })
})

describe("FpService.getIssue", () => {
  test("returns the live snapshot by native id", async () => {
    const snapshot = await run(
      withService((service) => service.getIssue(project, DONE_D)),
    )
    expect(snapshot).toEqual({
      nativeId: DONE_D,
      displayId: displayIdOf(DONE_D),
      url: linkFor(DONE_D),
      status: "done",
      state: "CLOSED",
      labels: ["ready-for-agent"],
    })
  })

  test("returns the live snapshot by display id", async () => {
    const snapshot = await run(
      withService((service) => service.getIssue(project, displayIdOf(ROOT_A))),
    )
    expect(snapshot.nativeId).toBe(ROOT_A)
    expect(snapshot.state).toBe("OPEN")
  })

  test("uses the project's closed statuses", async () => {
    const snapshot = await run(
      withService((service) =>
        service.getIssue(
          { ...project, closedStatuses: ["selected"] },
          SELECTED_G,
        ),
      ),
    )
    expect(snapshot.state).toBe("CLOSED")
  })

  test("fails for an unknown Issue", async () => {
    const failure = await failureOf(
      withService((service) => service.getIssue(project, "FP-nope")),
    )
    expect(failure.message).toContain("the Issue does not exist")
    expect(failure.kind).toBe("issue_not_found")
    // fp prints its diagnostics on stderr; the error carries them.
    expect(failure.stderr).toContain("Issue FP-nope not found")
  })
})

describe("FpService.getAuthenticatedUserLogin", () => {
  test("returns the fp account email as the operator identity", async () => {
    const login = await run(
      withService((service) => service.getAuthenticatedUserLogin(directory)),
    )
    expect(login).toBe("operator@example.com")
  })
})

describe("FpService.checkReadiness", () => {
  test("is ready when the CLI runs and the project resolves", async () => {
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness).toEqual({
      _tag: "ready",
      version: "0.25.0",
      remote: { workspaceSlug: "ws-test", projectId: "proj-test" },
    })
  })

  test("is ready without a remote for a local-only project, so callers can warn that links will not open", async () => {
    await marker("unlinked")
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness).toEqual({
      _tag: "ready",
      version: "0.25.0",
      remote: null,
    })
  })

  test("reports a missing CLI", async () => {
    const readiness = await run(
      withService((service) => service.checkReadiness(directory), {
        command: join(directory, "no-such-fp"),
      }),
    )
    expect(readiness._tag).toBe("cli_missing")
  })

  test("reports a directory that does not exist, without blaming the CLI", async () => {
    const readiness = await run(
      withService((service) =>
        service.checkReadiness(join(directory, "no-such-dir")),
      ),
    )
    expect(readiness._tag).toBe("project_not_registered")
    if (readiness._tag === "project_not_registered") {
      expect(readiness.message).toContain("does not exist")
    }
  })

  test("reports an unregistered project directory", async () => {
    await marker("unregistered")
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness._tag).toBe("project_not_registered")
  })

  test("reports an fp that hangs as a CLI error, not as an unregistered project", async () => {
    await marker("hang-list")
    const readiness = await run(
      withService((service) => service.checkReadiness(directory), {
        timeout: Duration.millis(300),
      }),
    )
    expect(readiness._tag).toBe("cli_error")
    if (readiness._tag === "cli_error") {
      expect(readiness.message).toContain("did not finish")
    }
  })

  test("reports an fp that fails for another reason as a CLI error with its message", async () => {
    await marker("list-broken")
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness).toEqual({
      _tag: "cli_error",
      message: expect.stringContaining("database is locked"),
    })
  })

  test("reports a broken remote lookup as a CLI error, not as an unlinked project", async () => {
    await marker("remote-broken")
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness._tag).toBe("cli_error")
  })
})

/** Every status write and every comment command, reads included. */
const trackedCalls = async (): Promise<readonly string[]> =>
  (await calls()).filter(
    (line) => line.startsWith("issue update ") || line.startsWith("comment "),
  )

describe("FpService.updateIssueStatus", () => {
  test("moves an open Issue to the target status and reads the result back", async () => {
    await run(
      withService((service) =>
        service.updateIssueStatus(project, CHILD_B, "in-progress"),
      ),
    )
    const after = await run(
      withService((service) => service.getIssue(project, CHILD_B)),
    )
    expect(after.status).toBe("in-progress")
    expect(await trackedCalls()).toEqual([
      `issue update ${CHILD_B} --status in-progress`,
    ])
  })

  test("accepts an Issue already in the target status without writing", async () => {
    await run(
      withService((service) =>
        service.updateIssueStatus(project, SELECTED_G, "selected"),
      ),
    )
    expect(await trackedCalls()).toEqual([])
  })

  test("accepts a closed Issue without reopening or re-transitioning it", async () => {
    await run(
      withService((service) =>
        service.updateIssueStatus(project, DONE_D, "in-progress"),
      ),
    )
    expect(await trackedCalls()).toEqual([])
    const after = await run(
      withService((service) => service.getIssue(project, DONE_D)),
    )
    expect(after.status).toBe("done")
  })

  test("uses the project's own closed statuses to decide what is closed", async () => {
    await run(
      withService((service) =>
        service.updateIssueStatus(
          { ...project, closedStatuses: ["done", "selected"] },
          SELECTED_G,
          "in-progress",
        ),
      ),
    )
    expect(await trackedCalls()).toEqual([])
  })

  test("reports a status the project does not register as invalid_status", async () => {
    await marker("invalid-status")
    const error = await failureOf(
      withService((service) =>
        service.updateIssueStatus(project, CHILD_B, "shipping"),
      ),
    )
    expect(error.kind).toBe("invalid_status")
    expect(error.message).toContain("not registered")
  })

  test("reports an Issue that does not exist as issue_not_found", async () => {
    const error = await failureOf(
      withService((service) =>
        service.updateIssueStatus(project, "nope", "in-progress"),
      ),
    )
    expect(error.kind).toBe("issue_not_found")
    expect(await trackedCalls()).toEqual([])
  })

  test("fails as write_not_applied when fp reports success but the status did not move", async () => {
    await marker("silent")
    const error = await failureOf(
      withService((service) =>
        service.updateIssueStatus(project, CHILD_B, "in-progress"),
      ),
    )
    expect(error.kind).toBe("write_not_applied")
    expect(error.message).toContain("reads back as todo")
  })
})

const MARKER = fpMilestoneMarker("work-started", "wi-123")
const BODY = `- Work started by ready-for-agent on Child B.\nSecond line with \`code\`.\n\n${MARKER}\n`

/** Put a comment on the fake's store directly, as a person or another tool would. */
const addForeignComment = async (issueId: string, content: string) => {
  const file = join(fixturesDirectory, `comments-${issueId}.json`)
  const stored = JSON.parse(await readFile(file, "utf8")) as {
    comments: { id: string; content: string }[]
  }
  stored.comments.unshift({ id: `foreign-${stored.comments.length}`, content })
  await writeFile(file, JSON.stringify(stored))
}

const storedComments = async (issueId: string) =>
  (
    JSON.parse(
      await readFile(
        join(fixturesDirectory, `comments-${issueId}.json`),
        "utf8",
      ),
    ) as { comments: { id: string; content: string }[] }
  ).comments

/** Ensure the standard marked comment, then return what the fake stored. */
const markedComments = async (issueId: string) => {
  await run(
    withService((service) =>
      service.ensureMilestoneComment(project, issueId, MARKER, BODY),
    ),
  )
  const stored = JSON.parse(
    await readFile(join(fixturesDirectory, `comments-${issueId}.json`), "utf8"),
  ) as { comments: { id: string; content: string }[] }
  return stored.comments
}

describe("FpService.ensureMilestoneComment", () => {
  test("creates the comment when no comment carries the marker, through a body file", async () => {
    const comments = await markedComments(CHILD_B)
    expect(comments).toHaveLength(1)
    // fp stores the body trimmed; the dash-led first line survives because
    // the body travelled as a file, not an argument.
    expect(comments[0]?.content).toBe(BODY.trim())
    const writes = await trackedCalls()
    expect(writes).toHaveLength(3)
    expect(writes[0]).toBe(`comment list ${CHILD_B} --format json`)
    expect(writes[1]).toMatch(
      new RegExp(`^comment add ${CHILD_B} --file .*/body\\.md$`),
    )
    expect(writes[2]).toBe(`comment list ${CHILD_B} --format json`)
  })

  test("leaves an identical comment alone, so a retry writes nothing", async () => {
    await markedComments(CHILD_B)
    await rm(logPath, { force: true })
    await run(
      withService((service) =>
        service.ensureMilestoneComment(project, CHILD_B, MARKER, BODY),
      ),
    )
    expect(await trackedCalls()).toEqual([
      `comment list ${CHILD_B} --format json`,
    ])
  })

  test("updates the marked comment in place when its content differs, never adding a second one", async () => {
    await markedComments(CHILD_B)
    // An unrelated newer comment must not be mistaken for the marked one.
    await run(
      withService((service) =>
        service.ensureMilestoneComment(
          project,
          CHILD_B,
          "ready-for-agent:pull-request:wi-123",
          "PR opened.\n\nready-for-agent:pull-request:wi-123",
        ),
      ),
    )
    await rm(logPath, { force: true })
    const revised = `Work resumed.\n\n${MARKER}`
    await run(
      withService((service) =>
        service.ensureMilestoneComment(project, CHILD_B, MARKER, revised),
      ),
    )
    const stored = JSON.parse(
      await readFile(
        join(fixturesDirectory, `comments-${CHILD_B}.json`),
        "utf8",
      ),
    ) as { comments: { id: string; content: string }[] }
    expect(stored.comments).toHaveLength(2)
    expect(
      stored.comments.find((comment) => comment.content.includes(MARKER)),
    ).toMatchObject({ id: "comment-1", content: revised })
    const writes = await trackedCalls()
    expect(writes[1]).toMatch(/^comment update comment-1 --file /)
  })

  test("rejects an empty marker or body before touching fp", async () => {
    const noMarker = await failureOf(
      withService((service) =>
        service.ensureMilestoneComment(project, CHILD_B, " ", BODY),
      ),
    )
    expect(noMarker.message).toContain("was empty")
    const noBody = await failureOf(
      withService((service) =>
        service.ensureMilestoneComment(project, CHILD_B, MARKER, ""),
      ),
    )
    expect(noBody.message).toContain("was empty")
    expect(await trackedCalls()).toEqual([])
  })

  test("reports an Issue that does not exist as issue_not_found", async () => {
    const error = await failureOf(
      withService((service) =>
        service.ensureMilestoneComment(project, "nope", MARKER, BODY),
      ),
    )
    expect(error.kind).toBe("issue_not_found")
  })

  test("fails as write_not_applied when fp reports the comment added but it is not there", async () => {
    await marker("silent")
    const error = await failureOf(
      withService((service) =>
        service.ensureMilestoneComment(project, CHILD_B, MARKER, BODY),
      ),
    )
    expect(error.kind).toBe("write_not_applied")
    expect(error.message).toContain("no comment with its marker")
  })

  test("fails as write_not_applied when fp reports the comment updated but the content did not change", async () => {
    await markedComments(CHILD_B)
    await marker("silent")
    const error = await failureOf(
      withService((service) =>
        service.ensureMilestoneComment(
          project,
          CHILD_B,
          MARKER,
          `Changed.\n\n${MARKER}`,
        ),
      ),
    )
    expect(error.kind).toBe("write_not_applied")
    expect(error.message).toContain("different content")
  })

  test("removes the temporary body file and its directory after fp has read it", async () => {
    await markedComments(CHILD_B)
    const addCall = (await trackedCalls()).find((line) =>
      line.startsWith("comment add "),
    )
    const path = addCall?.split(" --file ")[1]
    expect(path).toBeDefined()
    expect(path).toMatch(/fp-comment-[^/]+\/body\.md$/)
    await expect(readdir(dirname(path as string))).rejects.toThrow()
  })

  test("a body with surrounding whitespace is compared as fp stores it, so a retry writes nothing", async () => {
    const padded = `  ${BODY}  \n`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await run(
        withService((service) =>
          service.ensureMilestoneComment(project, CHILD_B, MARKER, padded),
        ),
      )
    }
    const comments = await storedComments(CHILD_B)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.content).toBe(BODY.trim())
    expect(
      (await trackedCalls()).filter((line) => line.startsWith("comment add ")),
    ).toHaveLength(1)
    expect(
      (await trackedCalls()).some((line) => line.startsWith("comment update ")),
    ).toBe(false)
  })

  test("a comment that only quotes the marker is never the target, even when it is the only one carrying it", async () => {
    await writeFile(
      join(fixturesDirectory, `comments-${CHILD_B}.json`),
      JSON.stringify({ comments: [] }),
    )
    const quoting = `Seen this?\n\n> ${MARKER}\n\nThanks.`
    await addForeignComment(CHILD_B, quoting)
    await run(
      withService((service) =>
        service.ensureMilestoneComment(project, CHILD_B, MARKER, BODY),
      ),
    )
    const comments = await storedComments(CHILD_B)
    expect(comments.map((comment) => comment.content)).toEqual([
      BODY.trim(),
      quoting,
    ])
  })

  test("when two comments carry the marker, the oldest is the one kept up to date", async () => {
    await markedComments(CHILD_B)
    await addForeignComment(
      CHILD_B,
      `Duplicate from an earlier bug.\n\n${MARKER}`,
    )
    const revised = `Work resumed.\n\n${MARKER}`
    await run(
      withService((service) =>
        service.ensureMilestoneComment(project, CHILD_B, MARKER, revised),
      ),
    )
    const comments = await storedComments(CHILD_B)
    expect(
      comments.find((comment) => comment.id === "comment-1")?.content,
    ).toBe(revised)
    expect(
      comments.find((comment) => comment.id === "foreign-1")?.content,
    ).toContain("Duplicate")
  })

  test("reports a marked comment that vanished before the update as comment_not_found", async () => {
    await markedComments(CHILD_B)
    await marker("stale-comment")
    const error = await failureOf(
      withService((service) =>
        service.ensureMilestoneComment(
          project,
          CHILD_B,
          MARKER,
          `Changed.\n\n${MARKER}`,
        ),
      ),
    )
    expect(error.kind).toBe("comment_not_found")
    expect(error.message).toContain("no longer exists")
  })
})

describe("fpMilestoneMarker", () => {
  test("is the Linear form: ready-for-agent:<kind>:<workItemId>", () => {
    expect(fpMilestoneMarker("completion", "wi-01J")).toBe(
      "ready-for-agent:completion:wi-01J",
    )
  })
})
