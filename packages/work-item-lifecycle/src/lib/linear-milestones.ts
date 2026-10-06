import { Effect } from "effect"
import type { RepositoryRecord } from "@ready-for-agent/db-service"
import {
  ISSUE_TRACKER_DESCRIPTIONS,
  type IssueSource,
  describeIssueTracker,
} from "@ready-for-agent/lifecycle-model"
import {
  LinearNotConfiguredError,
  type LinearRequestError,
  LinearService,
  linearMilestoneMarker,
} from "@ready-for-agent/linear-service"
import {
  completionComment,
  humanAttentionComment,
  pullRequestComment,
  workStartedComment,
} from "./milestone-copy.js"

export const LINEAR_MERGE_COMPLETION_SUMMARY =
  ISSUE_TRACKER_DESCRIPTIONS.linear.afterConfirmedMerge.completionSummary

/** An Original Issue Source already dispatched to Linear. */
export type LinearIssueSource = IssueSource & { readonly tracker: "linear" }

export const linearWorkStartedComment = (workItemId: string): string =>
  workStartedComment(
    workItemId,
    linearMilestoneMarker("work-started", workItemId),
  )

export const linearPullRequestComment = (
  workItemId: string,
  pullRequestUrl: string,
): string =>
  pullRequestComment(
    pullRequestUrl,
    linearMilestoneMarker("pull-request", workItemId),
  )

export const linearHumanAttentionComment = (
  workItemId: string,
  reason: string,
): string =>
  humanAttentionComment(
    reason,
    linearMilestoneMarker("human-attention", workItemId),
  )

export const linearCompletionComment = (
  workItemId: string,
  summary: string,
): string =>
  completionComment(summary, linearMilestoneMarker("completion", workItemId))

export const githubPullRequestUrl = (input: {
  readonly forgeHost: string
  readonly projectPath: string
  readonly pullRequestNumber: number
}): string =>
  `https://${input.forgeHost}/${input.projectPath}/pull/${input.pullRequestNumber}`

/**
 * Whether the Repository still carries Linear workflow statuses. A Work Item
 * whose Repository has since switched trackers skips the status change.
 */
const usesLinearSettings = (repository: RepositoryRecord): boolean =>
  describeIssueTracker(repository.issueTracker).settings.kind ===
  "linear_project_mapping"

export const notifyLinearWorkStarted = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: LinearIssueSource
  readonly workItemId: string
}): Effect.Effect<
  void,
  LinearRequestError | LinearNotConfiguredError,
  LinearService
> =>
  Effect.gen(function* () {
    const linear = yield* LinearService
    const issue = yield* linear.getIssue(input.issueSource.nativeId)
    const team = input.repository.linearWorkflowStatuses.find(
      (status) => status.teamId === issue.teamId,
    )
    if (team === undefined) {
      if (usesLinearSettings(input.repository)) {
        return yield* new LinearNotConfiguredError({
          repositoryId: input.repository.id,
          message: `No In Progress workflow status is configured for Linear team ${issue.teamKey}. Choose In Progress in Repository settings, then Retry.`,
        })
      }
    } else {
      yield* linear.updateIssueState(
        input.issueSource.nativeId,
        team.inProgressStateId,
      )
    }
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("work-started", input.workItemId),
      linearWorkStartedComment(input.workItemId),
    )
  })

export const notifyLinearPullRequest = (input: {
  readonly issueSource: LinearIssueSource
  readonly workItemId: string
  readonly pullRequestUrl: string
}): Effect.Effect<void, LinearRequestError, LinearService> =>
  Effect.gen(function* () {
    const linear = yield* LinearService
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("pull-request", input.workItemId),
      linearPullRequestComment(input.workItemId, input.pullRequestUrl),
    )
  })

export const notifyLinearHumanAttention = (input: {
  readonly issueSource: LinearIssueSource
  readonly workItemId: string
  readonly reason: string
}): Effect.Effect<void, LinearRequestError, LinearService> =>
  Effect.gen(function* () {
    const linear = yield* LinearService
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("human-attention", input.workItemId),
      linearHumanAttentionComment(input.workItemId, input.reason),
    )
  })

/**
 * Close Issue for a Linear Original Issue Source: publish the completion
 * summary once, then move to the configured Done status. Already completed
 * or canceled Issues are accepted without a second transition.
 */
export const completeLinearIssue = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: LinearIssueSource
  readonly workItemId: string
  readonly summary: string
}): Effect.Effect<
  void,
  LinearRequestError | LinearNotConfiguredError,
  LinearService
> =>
  Effect.gen(function* () {
    const linear = yield* LinearService
    const issue = yield* linear.getIssue(input.issueSource.nativeId)
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("completion", input.workItemId),
      linearCompletionComment(input.workItemId, input.summary),
    )
    const team = input.repository.linearWorkflowStatuses.find(
      (status) => status.teamId === issue.teamId,
    )
    if (team === undefined) {
      if (usesLinearSettings(input.repository)) {
        return yield* new LinearNotConfiguredError({
          repositoryId: input.repository.id,
          message: `No Done workflow status is configured for Linear team ${issue.teamKey}. Choose Done in Repository settings, then Retry.`,
        })
      }
      return
    }
    yield* linear.updateIssueState(input.issueSource.nativeId, team.doneStateId)
  })
