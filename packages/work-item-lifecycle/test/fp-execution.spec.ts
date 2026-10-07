import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AGENT_BACKEND_IDS } from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  FpRequestError,
  type FpServiceTestFixture,
  fpMilestoneMarker,
} from "@ready-for-agent/fp-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  FP_MERGE_COMPLETION_SUMMARY,
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  closeIssue,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubFpServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const FP_NATIVE_ID = "miygcidmabcdefghijklmnopqrstuvwx"
const FP_URL = `fp://issue?workspace=mhm&project=proj&id=${FP_NATIVE_ID}`
const FP_REFERENCE = `Why\n\nfp: MC-miygcidm\n${FP_URL}`

// Every step succeeds, through a harness merge.
const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-fp",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_test"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () => Effect.succeed({ _tag: "clean" as const }),
  commit: () =>
    Effect.succeed({
      _tag: "committed" as const,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: FP_REFERENCE,
    }),
  createPr: () =>
    Effect.succeed({
      pullRequestNumber: 101,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: FP_REFERENCE,
    }),
  watchPrStatusChecks: () =>
    Effect.succeed({
      _tag: "succeeded",
      createdAt: new Date(0),
      headSha: "head",
      headPushedAt: new Date(0),
      isDraft: false,
    }),
  resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
  investigatePrStatusChecks: () =>
    Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
  markPrReadyForReview: () => Effect.succeed({ completion: "native" as const }),
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

// Every step succeeds up to Review, which asks for a human.
const stepsToNeedsHuman: LifecycleStepsShape = {
  ...successfulSteps,
  review: () =>
    Effect.succeed({
      _tag: "needs_human" as const,
      reason: "High-severity findings remain.",
    }),
}

const fpLifecycleLayer = (
  fp: FpServiceTestFixture,
  steps: LifecycleStepsShape = stepsToNeedsHuman,
) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(stubLinearServiceLayer()),
    Layer.provideMerge(stubFpServiceLayer(fp)),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

/**
 * A Repository on fp with one stored fp Issue. fp is not selectable through
 * Repository settings until fp tracker 5, so it is set directly.
 */
const seedFpRepository = Effect.gen(function* () {
  const db = yield* DbService
  const sql = yield* SqlClient.SqlClient
  const repo = yield* db.addRepository({
    forge: "github",
    forgeHost: "github.com",
    projectPath: "acme/widgets",
    localPath: "/repos/acme/widgets-fp.git",
    isBare: true,
  })
  yield* db.updateRepositorySettings({
    repositoryId: repo.id,
    paused: true,
    defaultModel: null,
    defaultThinkingLevel: null,
    reviewModel: null,
    reviewThinkingLevel: null,
    mergePolicy: "off",
    includeAllIssueAuthors: false,
    waitForReadyForReviewChecks: false,
  })
  yield* sql.unsafe(
    `UPDATE repository
     SET issue_tracker = 'fp',
         fp_project_directory = '/work/mc-platform',
         fp_in_progress_status = 'in-progress',
         fp_done_status = 'shipped'
     WHERE id = ?`,
    [repo.id],
  )
  yield* db.updateConfig({
    selectedAgentBackend: AGENT_BACKEND_IDS.opencode,
    defaultModel: "opencode/deepseek-v4-flash-free",
    defaultThinkingLevel: null,
    reviewModel: null,
    reviewThinkingLevel: null,
    maxConcurrentAgentTurns: 2,
    maxConcurrentWorkItems: 5,
  })
  yield* db.storeIssue({
    repositoryId: repo.id,
    issueNumber: 7,
    issueTracker: "fp",
    nativeId: FP_NATIVE_ID,
    displayId: "MC-miygcidm",
    title: "Needs a reviewer",
    body: "body",
    url: FP_URL,
    state: "OPEN",
    githubCreatedAt: new Date(),
    issueAuthor: null,
    parent: null,
    parentPosition: null,
    hasChildren: false,
    blockedBy: [],
  })
  return repo
})

/** Run queued steps until the Work Item parks or a step fails. */
const runUntilParkedOrFailed = (repositoryId: string) =>
  Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const created = yield* lifecycle.implementNow(repositoryId, FP_NATIVE_ID)
    let current = created
    let failure: unknown
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (current.state === "needs_human") {
        break
      }
      const queued = current.stepRuns.find((run) => run.status === "queued")
      if (queued === undefined) {
        break
      }
      const step = yield* lifecycle.runStep(queued.id).pipe(Effect.result)
      if (step._tag === "Failure") {
        failure = step.failure
        break
      }
      current = yield* lifecycle.getWorkItem(created.id)
    }
    const settled = yield* lifecycle.getWorkItem(created.id)
    return { workItemId: created.id, state: settled.state, failure }
  })

/** Run queued steps until none is left, or the Work Item reaches `stopAt`. */
const runQueuedSteps = (workItemId: string, stopAt?: string) =>
  Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    let current = yield* lifecycle.getWorkItem(workItemId)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (stopAt !== undefined && current.state === stopAt) {
        return current
      }
      const queued = current.stepRuns.find((run) => run.status === "queued")
      if (queued === undefined) {
        return current
      }
      yield* lifecycle.runStep(queued.id)
      current = yield* lifecycle.getWorkItem(workItemId)
    }
    return current
  })

/** Records fp writes in order, as `<kind> <id> <marker or status>`. */
const recordingFp = (writes: string[]): FpServiceTestFixture => ({
  updateIssueStatus: (_options, id, status) =>
    Effect.sync(() => {
      writes.push(`status ${id} ${status}`)
    }),
  ensureMilestoneComment: (_options, id, marker) =>
    Effect.sync(() => {
      writes.push(`comment ${id} ${marker}`)
    }),
})

describe("fp Issue execution", () => {
  it("posts an fp human-attention comment when an fp Work Item needs human", async () => {
    const comments: Array<{
      project: string
      id: string
      marker: string
      body: string
    }> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* seedFpRepository
        return yield* runUntilParkedOrFailed(repo.id)
      }).pipe(
        Effect.provide(
          fpLifecycleLayer({
            ensureMilestoneComment: (options, id, marker, body) =>
              Effect.sync(() => {
                comments.push({
                  project: options.projectDirectory,
                  id,
                  marker,
                  body,
                })
              }),
          }),
        ),
      ),
    )
    expect(result.state).toBe("needs_human")
    expect(comments).toEqual([
      {
        project: "/work/mc-platform",
        id: FP_NATIVE_ID,
        marker: fpMilestoneMarker("human-attention", result.workItemId),
        body: `Ready for Agent needs human attention:\nHigh-severity findings remain.\n\n${fpMilestoneMarker("human-attention", result.workItemId)}`,
      },
    ])
  })

  it("fails fp attention as an fp error without parking Needs Human", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* seedFpRepository
        return yield* runUntilParkedOrFailed(repo.id)
      }).pipe(
        Effect.provide(
          fpLifecycleLayer({
            ensureMilestoneComment: () =>
              Effect.fail(
                new FpRequestError({
                  message: "fp could not add the comment",
                  kind: "unknown",
                }),
              ),
          }),
        ),
      ),
    )
    expect(result.state).not.toBe("needs_human")
    expect(result.failure).toBeInstanceOf(FpRequestError)
    expect(String(result.failure)).not.toContain(
      "Unexpected transaction failure",
    )
  })

  it("completes an fp No-Change Outcome through Close Issue without a GitHub PR", async () => {
    const summary = "The answer is already in fp; no repository changes."
    const writes: string[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedFpRepository
        const created = yield* lifecycle.implementNow(repo.id, FP_NATIVE_ID)
        return { created, finished: yield* runQueuedSteps(created.id) }
      }).pipe(
        Effect.provide(
          fpLifecycleLayer(recordingFp(writes), {
            ...successfulSteps,
            assessChanges: () =>
              Effect.succeed({
                _tag: "no_changes",
                completionSummary: summary,
              }),
            createPr: () => Effect.die("create PR must not run"),
            mergePr: () => Effect.die("merge must not run"),
          }),
        ),
      ),
    )
    expect(result.finished.state).toBe("complete")
    expect(result.finished.completionSummary).toBe(summary)
    expect(result.finished.pullRequestNumber).toBeNull()
    // Implement is stubbed, so only close-out writes to fp: the summary
    // first, then the Repository's Done status.
    expect(writes).toEqual([
      `comment ${FP_NATIVE_ID} ${fpMilestoneMarker("completion", result.created.id)}`,
      `status ${FP_NATIVE_ID} shipped`,
    ])
  })

  it("completes fp after a harness-performed GitHub merge", async () => {
    const writes: string[] = []
    let mergeCalls = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedFpRepository
        const created = yield* lifecycle.implementNow(repo.id, FP_NATIVE_ID)
        return { created, finished: yield* runQueuedSteps(created.id) }
      }).pipe(
        Effect.provide(
          fpLifecycleLayer(recordingFp(writes), {
            ...successfulSteps,
            mergePr: () => {
              mergeCalls += 1
              return Effect.succeed({ _tag: "merged" as const })
            },
          }),
        ),
      ),
    )
    expect(result.finished.state).toBe("complete")
    expect(mergeCalls).toBe(1)
    expect(result.finished.completionSummary).toBe(FP_MERGE_COMPLETION_SUMMARY)
    expect(writes).toEqual([
      `comment ${FP_NATIVE_ID} ${fpMilestoneMarker("completion", result.created.id)}`,
      `status ${FP_NATIVE_ID} shipped`,
    ])
  })

  it("completes fp after an observed human-performed GitHub merge", async () => {
    const writes: string[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedFpRepository
        const created = yield* lifecycle.implementNow(repo.id, FP_NATIVE_ID)
        const parked = yield* runQueuedSteps(created.id, "needs_human")
        expect(parked.state).toBe("needs_human")
        const resumed = yield* lifecycle.continueAfterHumanPrOutcome(
          created.id,
          "merged",
        )
        expect(resumed.state).toBe("close_issue")
        return { created, finished: yield* runQueuedSteps(created.id) }
      }).pipe(
        Effect.provide(
          fpLifecycleLayer(recordingFp(writes), {
            ...successfulSteps,
            decidePrMerge: () =>
              Effect.succeed({
                _tag: "needs_human" as const,
                reason: "Repository merge policy requires a human merge",
              }),
            mergePr: () => Effect.die("merge must not run after a human merge"),
          }),
        ),
      ),
    )
    expect(result.finished.state).toBe("complete")
    const completion = fpMilestoneMarker("completion", result.created.id)
    expect(writes.filter((write) => write.includes("completion"))).toEqual([
      `comment ${FP_NATIVE_ID} ${completion}`,
    ])
    expect(writes.at(-1)).toBe(`status ${FP_NATIVE_ID} shipped`)
  })

  it("retries only fp close-out after a confirmed merge when fp fails", async () => {
    const writes: string[] = []
    let mergeCalls = 0
    let closeAttempts = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedFpRepository
        const created = yield* lifecycle.implementNow(repo.id, FP_NATIVE_ID)
        const afterFailure = yield* runQueuedSteps(created.id)
        // The delivery stands: merged, close-out pending, not complete.
        expect(afterFailure.state).toBe("close_issue")
        expect(
          afterFailure.stepRuns.some(
            (run) => run.step === "close_issue" && run.status === "failed",
          ),
        ).toBe(true)
        expect(writes).toEqual([])
        const retried = yield* lifecycle.retry(created.id)
        return { created, finished: yield* runQueuedSteps(retried.id) }
      }).pipe(
        Effect.provide(
          fpLifecycleLayer(recordingFp(writes), {
            ...successfulSteps,
            mergePr: () => {
              mergeCalls += 1
              return Effect.succeed({ _tag: "merged" as const })
            },
            closeIssue: (context) => {
              closeAttempts += 1
              return closeAttempts === 1
                ? Effect.fail(
                    new FpRequestError({
                      message: "fp could not add the comment",
                      kind: "unknown",
                    }),
                  )
                : closeIssue(context)
            },
          }),
        ),
      ),
    )
    expect(result.finished.state).toBe("complete")
    expect(mergeCalls).toBe(1)
    expect(closeAttempts).toBe(2)
    expect(writes).toEqual([
      `comment ${FP_NATIVE_ID} ${fpMilestoneMarker("completion", result.created.id)}`,
      `status ${FP_NATIVE_ID} shipped`,
    ])
    expect(
      result.finished.stepRuns.filter((run) => run.step === "merge_pr"),
    ).toHaveLength(1)
  })
})
