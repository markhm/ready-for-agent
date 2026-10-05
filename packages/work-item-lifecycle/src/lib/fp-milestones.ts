import { Effect } from "effect"
import type { RepositoryRecord } from "@ready-for-agent/db-service"
import {
  FP_DEFAULT_CLOSED_STATUSES,
  FpNotConfiguredError,
  type FpProjectOptions,
  type FpRequestError,
  FpService,
  fpMilestoneMarker,
} from "@ready-for-agent/fp-service"
import {
  type IssueSource,
  describeIssueTracker,
} from "@ready-for-agent/lifecycle-model"
import {
  humanAttentionComment,
  pullRequestComment,
  workStartedComment,
} from "./milestone-copy.js"

/** An Original Issue Source already dispatched to fp. */
export type FpIssueSource = IssueSource & { readonly tracker: "fp" }

type FpProject =
  | { readonly _tag: "project"; readonly options: FpProjectOptions }
  | { readonly _tag: "left" }

/**
 * The fp project a Work Item's tracker writes go to. A Repository still on
 * fp must name its project; one that has left fp (or was removed) no longer
 * has it, since switching trackers clears the fp settings, so the writes
 * for its Work Items are skipped, as Linear skips its status change.
 */
const fpProjectFor = (
  repository: RepositoryRecord | undefined,
): Effect.Effect<FpProject, FpNotConfiguredError> => {
  if (
    repository === undefined ||
    describeIssueTracker(repository.issueTracker).settings.kind !== "fp_project"
  ) {
    return Effect.succeed({ _tag: "left" })
  }
  const projectDirectory = repository.fpProjectDirectory?.trim() ?? ""
  if (projectDirectory === "") {
    return Effect.fail(
      new FpNotConfiguredError({
        repositoryId: repository.id,
        message:
          "No fp project is configured for this Repository. Choose the fp project in Repository settings, then Retry.",
      }),
    )
  }
  const doneStatus = repository.fpDoneStatus?.trim() ?? ""
  return Effect.succeed({
    _tag: "project",
    options: {
      projectDirectory,
      closedStatuses: [
        ...new Set([
          ...FP_DEFAULT_CLOSED_STATUSES,
          ...(doneStatus === "" ? [] : [doneStatus]),
        ]),
      ],
    },
  })
}

const skipped = (milestone: string, input: { readonly workItemId: string }) =>
  Effect.logInfo(
    `Skipped the fp ${milestone}: the Repository no longer uses fp`,
  ).pipe(Effect.annotateLogs({ workItemId: input.workItemId }))

/** In Progress and the work-started milestone when implementation starts. */
export const notifyFpWorkStarted = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: FpIssueSource
  readonly workItemId: string
}): Effect.Effect<void, FpRequestError | FpNotConfiguredError, FpService> =>
  Effect.gen(function* () {
    const project = yield* fpProjectFor(input.repository)
    if (project._tag === "left") {
      return yield* skipped("work-started milestone", input)
    }
    const inProgress = input.repository.fpInProgressStatus?.trim() ?? ""
    if (inProgress === "") {
      return yield* new FpNotConfiguredError({
        repositoryId: input.repository.id,
        message:
          "No In Progress status is configured for the fp project. Choose In Progress in Repository settings, then Retry.",
      })
    }
    const fp = yield* FpService
    yield* fp.updateIssueStatus(
      project.options,
      input.issueSource.nativeId,
      inProgress,
    )
    const marker = fpMilestoneMarker("work-started", input.workItemId)
    yield* fp.ensureMilestoneComment(
      project.options,
      input.issueSource.nativeId,
      marker,
      workStartedComment(input.workItemId, marker),
    )
  })

/** Pull request milestone after the pull request is opened. */
export const notifyFpPullRequest = (input: {
  readonly repository: RepositoryRecord | undefined
  readonly issueSource: FpIssueSource
  readonly workItemId: string
  readonly pullRequestUrl: string
}): Effect.Effect<void, FpRequestError | FpNotConfiguredError, FpService> =>
  Effect.gen(function* () {
    const project = yield* fpProjectFor(input.repository)
    if (project._tag === "left") {
      return yield* skipped("pull request milestone", input)
    }
    const fp = yield* FpService
    const marker = fpMilestoneMarker("pull-request", input.workItemId)
    yield* fp.ensureMilestoneComment(
      project.options,
      input.issueSource.nativeId,
      marker,
      pullRequestComment(input.pullRequestUrl, marker),
    )
  })

/** Human attention milestone when a Work Item parks for a person. */
export const notifyFpHumanAttention = (input: {
  readonly repository: RepositoryRecord | undefined
  readonly issueSource: FpIssueSource
  readonly workItemId: string
  readonly reason: string
}): Effect.Effect<void, FpRequestError | FpNotConfiguredError, FpService> =>
  Effect.gen(function* () {
    const project = yield* fpProjectFor(input.repository)
    if (project._tag === "left") {
      return yield* skipped("human attention milestone", input)
    }
    const fp = yield* FpService
    const marker = fpMilestoneMarker("human-attention", input.workItemId)
    yield* fp.ensureMilestoneComment(
      project.options,
      input.issueSource.nativeId,
      marker,
      humanAttentionComment(input.reason, marker),
    )
  })
