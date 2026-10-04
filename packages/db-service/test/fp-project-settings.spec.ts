import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  InvalidRepositorySettingsError,
} from "../src/index.js"
import { checkFpProjectSettings } from "../src/lib/fp-project-settings.js"
import { describe, expect, it } from "bun:test"

// fp is not selectable yet, so updateRepositorySettings refuses fp before
// reaching this check; it is exercised here directly, against a real
// database, until fp tracker 5 makes it reachable.
describe("fp project settings storage validation", () => {
  const TestLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
  const runTest = <A, E>(
    test: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, TestLayer))

  const repositoryInput = (projectPath: string) => ({
    forge: "github",
    forgeHost: "github.com",
    projectPath,
    localPath: `/repos/${projectPath}.git`,
    isBare: true,
  })

  const check = (input: {
    readonly repositoryId: string
    readonly fpProjectDirectory: string | null
    readonly fpInProgressStatus: string | null
    readonly fpDoneStatus: string | null
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* checkFpProjectSettings(sql, input, (error) => error)
    })

  it("accepts a project with both statuses that no other Repository maps", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const repo = yield* db.addRepository(repositoryInput("acme/widgets"))
        yield* check({
          repositoryId: repo.id,
          fpProjectDirectory: "/work/widgets",
          fpInProgressStatus: "in-progress",
          fpDoneStatus: "done",
        })
      }),
    ))

  it("requires the project, then both statuses", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const repo = yield* db.addRepository(repositoryInput("acme/widgets"))
        const noProject = yield* Effect.flip(
          check({
            repositoryId: repo.id,
            fpProjectDirectory: null,
            fpInProgressStatus: "in-progress",
            fpDoneStatus: "done",
          }),
        )
        expect(noProject).toBeInstanceOf(InvalidRepositorySettingsError)
        expect(noProject).toMatchObject({
          field: "fpProjectDirectory",
          message: "Select the fp project mapped to this Repository",
        })
        for (const statuses of [
          { fpInProgressStatus: null, fpDoneStatus: "done" },
          { fpInProgressStatus: "in-progress", fpDoneStatus: null },
        ]) {
          const missing = yield* Effect.flip(
            check({
              repositoryId: repo.id,
              fpProjectDirectory: "/work/widgets",
              ...statuses,
            }),
          )
          expect(missing).toMatchObject({
            field: "fpWorkflowStatuses",
            message: "Choose In Progress and Done statuses for the fp project",
          })
        }
      }),
    ))

  it("refuses a project another Repository maps, but not the Repository's own mapping", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const widgets = yield* db.addRepository(repositoryInput("acme/widgets"))
        const gadgets = yield* db.addRepository(repositoryInput("acme/gadgets"))
        yield* sql.unsafe(
          `UPDATE repository
           SET issue_tracker = 'fp',
               fp_project_directory = '/work/widgets',
               fp_in_progress_status = 'in-progress',
               fp_done_status = 'done'
           WHERE id = ?`,
          [widgets.id],
        )
        const input = {
          fpProjectDirectory: "/work/widgets",
          fpInProgressStatus: "in-progress",
          fpDoneStatus: "done",
        }

        const taken = yield* Effect.flip(
          check({ repositoryId: gadgets.id, ...input }),
        )
        expect(taken).toMatchObject({
          field: "fpProjectDirectory",
          message: "That fp project is already mapped to another Repository",
        })
        yield* check({ repositoryId: widgets.id, ...input })
      }),
    ))
})
