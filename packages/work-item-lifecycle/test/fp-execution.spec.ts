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
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
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

// Every step succeeds up to Review, which asks for a human.
const stepsToNeedsHuman: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-fp",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_test"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () =>
    Effect.succeed({
      _tag: "needs_human" as const,
      reason: "High-severity findings remain.",
    }),
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
  watchPrStatusChecks: () => Effect.die("checks must not run"),
  resolvePrMergeConflict: () => Effect.die("conflicts must not run"),
  investigatePrStatusChecks: () => Effect.die("investigation must not run"),
  markPrReadyForReview: () => Effect.die("mark ready must not run"),
  decidePrMerge: () => Effect.die("decide merge must not run"),
  mergePr: () => Effect.die("merge must not run"),
  closeIssue: () => Effect.die("close-out must not run"),
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const fpLifecycleLayer = (fp: FpServiceTestFixture) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(stubLinearServiceLayer()),
    Layer.provideMerge(stubFpServiceLayer(fp)),
    Layer.provideMerge(
      Layer.succeed(LifecycleSteps, LifecycleSteps.of(stepsToNeedsHuman)),
    ),
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
  yield* sql.unsafe(
    `UPDATE repository
     SET paused = 1,
         issue_tracker = 'fp',
         fp_project_directory = '/work/mc-platform',
         fp_in_progress_status = 'in-progress',
         fp_done_status = 'done'
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
})
