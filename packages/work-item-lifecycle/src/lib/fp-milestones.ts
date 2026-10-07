import { Effect } from "effect"
import type { RepositoryRecord } from "@ready-for-agent/db-service"
import {
  FpNotConfiguredError,
  type FpProjectOptions,
  type FpRequestError,
  FpService,
  fpMilestoneMarker,
  fpProjectOptionsFromSettings,
} from "@ready-for-agent/fp-service"
import {
  ISSUE_TRACKER_DESCRIPTIONS,
  type IssueSource,
  describeIssueTracker,
} from "@ready-for-agent/lifecycle-model"
import {
  completionComment,
  humanAttentionComment,
  pullRequestComment,
  workStartedComment,
} from "./milestone-copy.js"

export const FP_MERGE_COMPLETION_SUMMARY =
  ISSUE_TRACKER_DESCRIPTIONS.fp.afterConfirmedMerge.completionSummary

/** An Original Issue Source already dispatched to fp. */
export type FpIssueSource = IssueSource & { readonly tracker: "fp" }

type FpProject =
  | { readonly _tag: "project"; readonly options: FpProjectOptions }
  | { readonly _tag: "left"; readonly why: string }

/**
 * The fp project a Work Item's tracker writes go to. A Repository still on
 * fp must name its project; one that has left fp (or was removed) no longer
 * has it, since switching trackers clears the fp settings, so the writes
 * for its Work Items are skipped, as Linear skips its status change.
 */
const fpProjectFor = (
  repository: RepositoryRecord | undefined,
): Effect.Effect<FpProject, FpNotConfiguredError> => {
  if (repository === undefined) {
    return Effect.succeed({ _tag: "left", why: "the Repository was removed" })
  }
  if (
    describeIssueTracker(repository.issueTracker).settings.kind !== "fp_project"
  ) {
    return Effect.succeed({
      _tag: "left",
      why: "the Repository no longer uses fp",
    })
  }
  const options = fpProjectOptionsFromSettings(repository)
  if (options === null) {
    return Effect.fail(
      new FpNotConfiguredError({
        repositoryId: repository.id,
        message:
          "No fp project is configured for this Repository. Choose the fp project in Repository settings, then Retry.",
      }),
    )
  }
  return Effect.succeed({ _tag: "project", options })
}

const skipped = (
  milestone: string,
  project: { readonly why: string },
  input: { readonly workItemId: string },
) =>
  Effect.logInfo(`Skipped the fp ${milestone}: ${project.why}`).pipe(
    Effect.annotateLogs({ workItemId: input.workItemId }),
  )

/** In Progress and the work-started milestone when implementation starts. */
export const notifyFpWorkStarted = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: FpIssueSource
  readonly workItemId: string
}): Effect.Effect<void, FpRequestError | FpNotConfiguredError, FpService> =>
  Effect.gen(function* () {
    const project = yield* fpProjectFor(input.repository)
    if (project._tag === "left") {
      return yield* skipped("work-started milestone", project, input)
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
      return yield* skipped("pull request milestone", project, input)
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
      return yield* skipped("human attention milestone", project, input)
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

/**
 * Close Issue for an fp Original Issue Source: publish the completion
 * summary once, then move the Issue to the Repository's Done status. An
 * Issue already finished is accepted without a second transition; the
 * summary comment is updated in place on a retry.
 */
export const completeFpIssue = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: FpIssueSource
  readonly workItemId: string
  readonly summary: string
}): Effect.Effect<void, FpRequestError | FpNotConfiguredError, FpService> =>
  Effect.gen(function* () {
    const project = yield* fpProjectFor(input.repository)
    if (project._tag === "left") {
      return yield* skipped("completion", project, input)
    }
    const done = input.repository.fpDoneStatus?.trim() ?? ""
    if (done === "") {
      return yield* new FpNotConfiguredError({
        repositoryId: input.repository.id,
        message:
          "No Done status is configured for the fp project. Choose Done in Repository settings, then Retry.",
      })
    }
    const fp = yield* FpService
    const marker = fpMilestoneMarker("completion", input.workItemId)
    yield* fp.ensureMilestoneComment(
      project.options,
      input.issueSource.nativeId,
      marker,
      completionComment(input.summary, marker),
    )
    yield* fp.updateIssueStatus(
      project.options,
      input.issueSource.nativeId,
      done,
    )
  })
