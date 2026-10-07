import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { InvalidRepositorySettingsError } from "./errors.js"

/** The fp settings a Repository settings write would store. */
export interface FpProjectSettingsInput {
  readonly repositoryId: string
  /** The fp project the Repository maps now, before this write. */
  readonly currentFpProjectDirectory: string | null
  readonly fpProjectDirectory: string | null
  readonly fpInProgressStatus: string | null
  readonly fpDoneStatus: string | null
}

/**
 * Storage validation for a Repository whose Issue Tracker maps an fp
 * project: the project and both statuses are required, one fp project maps
 * to one Repository, and the project cannot change while the Repository
 * has unfinished fp Work Items: an fp Issue id only resolves in its own
 * project, and those Work Items would write to the new one. Values arrive
 * trimmed, with empty as null.
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
    if (
      input.fpProjectDirectory !== input.currentFpProjectDirectory &&
      (yield* hasUnfinishedFpWorkItems(
        sql,
        input.repositoryId,
        toDatabaseError,
      ))
    ) {
      return yield* new InvalidRepositorySettingsError({
        field: "fpProjectDirectory",
        message:
          "Finish or abandon this Repository's unfinished fp Work Items before mapping another fp project",
      })
    }
  })

/**
 * Whether the Repository has an fp Work Item that can still write to fp:
 * not Complete, not Abandoned, and not Failed unless the failure is the
 * retryable one (the ontology's Unfinished Work Item; the code matches
 * RETRYABLE_FAILED_WORK_ITEM_CODE in work-item-lifecycle). The harness
 * does not record a Work Item's fp project, so while one exists the
 * Repository keeps its fp project: neither another project nor leaving fp.
 */
export const hasUnfinishedFpWorkItems = <E>(
  sql: SqlClient.SqlClient,
  repositoryId: string,
  toDatabaseError: (error: SqlError) => E,
) =>
  Effect.gen(function* () {
    const rows = (yield* sql
      .unsafe(
        `SELECT id FROM work_item
         WHERE repository_id = ?
           AND issue_tracker = 'fp'
           AND (
             state NOT IN ('complete', 'failed', 'abandoned')
             OR (state = 'failed' AND failure_code = 'pr_status_checks_unresolved')
           )
         LIMIT 1`,
        [repositoryId],
      )
      .pipe(Effect.mapError(toDatabaseError))) as readonly {
      readonly id: string
    }[]
    return rows.length > 0
  })
