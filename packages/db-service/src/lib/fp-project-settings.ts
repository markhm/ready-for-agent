import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { InvalidRepositorySettingsError } from "./errors.js"

/** The fp settings a Repository settings write would store. */
export interface FpProjectSettingsInput {
  readonly repositoryId: string
  readonly fpProjectDirectory: string | null
  readonly fpInProgressStatus: string | null
  readonly fpDoneStatus: string | null
}

/**
 * Storage validation for a Repository whose Issue Tracker maps an fp
 * project: the project and both statuses are required, and one fp project
 * maps to one Repository. Values arrive trimmed, with empty as null.
 */
export const checkFpProjectSettings = <E>(
  sql: SqlClient.SqlClient,
  input: FpProjectSettingsInput,
  toDatabaseError: (error: SqlError) => E,
) =>
  Effect.gen(function* () {
    if (input.fpProjectDirectory === null) {
      return yield* new InvalidRepositorySettingsError({
        field: "fpProjectDirectory",
        message: "Select the fp project mapped to this Repository",
      })
    }
    if (input.fpInProgressStatus === null || input.fpDoneStatus === null) {
      return yield* new InvalidRepositorySettingsError({
        field: "fpWorkflowStatuses",
        message: "Choose In Progress and Done statuses for the fp project",
      })
    }
    const mappedFpRows = (yield* sql
      .unsafe(
        `SELECT id FROM repository
         WHERE fp_project_directory = ?
           AND id <> ?
         LIMIT 1`,
        [input.fpProjectDirectory, input.repositoryId],
      )
      .pipe(Effect.mapError(toDatabaseError))) as readonly {
      readonly id: string
    }[]
    if (mappedFpRows.length > 0) {
      return yield* new InvalidRepositorySettingsError({
        field: "fpProjectDirectory",
        message: "That fp project is already mapped to another Repository",
      })
    }
  })
