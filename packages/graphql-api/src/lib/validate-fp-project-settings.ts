import { Effect } from "effect"
import { InvalidRepositorySettingsError } from "@ready-for-agent/db-service"
import { FpService } from "@ready-for-agent/fp-service"
import {
  type IssueTracker,
  describeIssueTracker,
} from "@ready-for-agent/lifecycle-model"

/** The fp settings a Repository settings write would leave in place. */
export interface NextFpProjectSettings {
  readonly issueTracker: IssueTracker
  readonly fpProjectDirectory: string | null
  readonly fpInProgressStatus: string | null
  readonly fpDoneStatus: string | null
}

const trimmedOrNull = (value: string | null): string | null =>
  value === null || value.trim() === "" ? null : value.trim()

/**
 * Server-side check of the fp project mapping against the fp CLI, so a
 * direct GraphQL request cannot store a folder that is not a registered fp
 * project, or a status that project does not register, which would only
 * fail later at discovery or at the first status write.
 *
 * Missing values are left to the storage validation, which owns the
 * required-field messages; this check only judges values that are present.
 */
export const validateFpProjectSettings = (next: NextFpProjectSettings) =>
  Effect.gen(function* () {
    if (
      describeIssueTracker(next.issueTracker).settings.kind !== "fp_project"
    ) {
      return
    }
    const directory = trimmedOrNull(next.fpProjectDirectory)
    if (directory === null) {
      return
    }
    const fp = yield* FpService
    const projects = yield* fp.listRegisteredProjects().pipe(
      Effect.mapError(
        (error) =>
          new InvalidRepositorySettingsError({
            field: "fpProjectDirectory",
            message: `Could not list the registered fp projects: ${error.message}`,
          }),
      ),
    )
    const project = projects.find(({ path }) => path === directory)
    if (project === undefined) {
      return yield* new InvalidRepositorySettingsError({
        field: "fpProjectDirectory",
        message: "That folder is not a registered fp project",
      })
    }
    if (project.orphaned) {
      return yield* new InvalidRepositorySettingsError({
        field: "fpProjectDirectory",
        message: "That fp project's folder no longer exists",
      })
    }
    const submitted = [
      trimmedOrNull(next.fpInProgressStatus),
      trimmedOrNull(next.fpDoneStatus),
    ].filter((status): status is string => status !== null)
    if (submitted.length === 0) {
      return
    }
    const statuses = yield* fp.listProjectStatuses(directory).pipe(
      Effect.mapError(
        (error) =>
          new InvalidRepositorySettingsError({
            field: "fpWorkflowStatuses",
            message: `Could not read the fp project's statuses: ${error.message}`,
          }),
      ),
    )
    const unknown = submitted.find((status) => !statuses.includes(status))
    if (unknown !== undefined) {
      return yield* new InvalidRepositorySettingsError({
        field: "fpWorkflowStatuses",
        message: `${unknown} is not a status of that fp project`,
      })
    }
  })
