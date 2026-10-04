import { Effect, Layer } from "effect"
import type { FpRequestError } from "./errors.js"
import type { FpRegisteredProject } from "./fp-cli-output.js"
import { FpService } from "./fp-service.js"
import type {
  FpIssue,
  FpIssueSnapshot,
  FpProjectOptions,
  FpReadiness,
} from "./types.js"

export const defaultFpIssueSnapshot: FpIssueSnapshot = {
  nativeId: "abcdefghijklmnopqrstuvwxyzabcdef",
  displayId: "FP-abcdefgh",
  url: "fp://issue?workspace=ws-test&project=proj-test&id=abcdefghijklmnopqrstuvwxyzabcdef",
  status: "todo",
  state: "OPEN",
  labels: ["ready-for-agent"],
}

export interface FpServiceTestFixture {
  readonly operatorLogin?: string
  readonly issues?: readonly FpIssue[]
  readonly numberReadyIssues?: (
    options: FpProjectOptions,
    issues: readonly FpIssue[],
    floor?: number,
  ) => Effect.Effect<readonly FpIssue[], FpRequestError>
  readonly issue?: FpIssueSnapshot
  readonly getIssue?: (
    options: FpProjectOptions,
    issueId: string,
  ) => Effect.Effect<FpIssueSnapshot, FpRequestError>
  readonly readiness?: FpReadiness
  readonly registeredProjects?: readonly FpRegisteredProject[]
  readonly projectStatuses?: readonly string[]
  readonly updateIssueStatus?: (
    options: FpProjectOptions,
    issueId: string,
    status: string,
  ) => Effect.Effect<void, FpRequestError>
  readonly ensureMilestoneComment?: (
    options: FpProjectOptions,
    issueId: string,
    marker: string,
    body: string,
  ) => Effect.Effect<void, FpRequestError>
  readonly error?: FpRequestError
}

/**
 * The default numbering: Issues without a number get the next ones after
 * the highest in the batch or the floor, in order, and references follow.
 */
const numberInMemory = (
  issues: readonly FpIssue[],
  floor: number,
): readonly FpIssue[] => {
  const numbers = new Map<string, number>()
  let highest = floor
  for (const issue of issues) {
    if (issue.number !== null) {
      numbers.set(issue.nativeId, issue.number)
      highest = Math.max(highest, issue.number)
    }
  }
  for (const issue of issues) {
    if (issue.number === null) {
      highest += 1
      numbers.set(issue.nativeId, highest)
    }
  }
  const numberOf = (nativeId: string, fallback: number | null) =>
    numbers.get(nativeId) ?? fallback
  return issues.map((issue) => ({
    ...issue,
    number: numberOf(issue.nativeId, issue.number),
    parent:
      issue.parent === null
        ? null
        : {
            ...issue.parent,
            number: numberOf(issue.parent.nativeId, issue.parent.number),
          },
    blockedBy: issue.blockedBy.map((blocker) => ({
      ...blocker,
      number: numberOf(blocker.nativeId, blocker.number),
    })),
  }))
}

/** In-memory stand-in for lifecycle and reconciler tests. */
export const makeFpServiceTest = (
  fixture: FpServiceTestFixture = {},
): Layer.Layer<FpService> => {
  const failOr = <A>(succeed: () => Effect.Effect<A, never>) => {
    if (fixture.error !== undefined) {
      return Effect.fail(fixture.error)
    }
    return succeed()
  }
  return Layer.succeed(FpService, {
    getAuthenticatedUserLogin: () =>
      failOr(() =>
        Effect.succeed(fixture.operatorLogin ?? "fp-user@example.com"),
      ),
    listReadyIssues: () =>
      failOr(() => Effect.succeed([...(fixture.issues ?? [])])),
    numberReadyIssues: (options, issues, floor) =>
      fixture.numberReadyIssues !== undefined
        ? fixture.numberReadyIssues(options, issues, floor)
        : failOr(() => Effect.succeed(numberInMemory(issues, floor ?? 0))),
    getIssue: (options, issueId) =>
      fixture.getIssue !== undefined
        ? fixture.getIssue(options, issueId)
        : failOr(() => Effect.succeed(fixture.issue ?? defaultFpIssueSnapshot)),
    listRegisteredProjects: () =>
      failOr(() => Effect.succeed([...(fixture.registeredProjects ?? [])])),
    listProjectStatuses: () =>
      failOr(() =>
        Effect.succeed([
          ...(fixture.projectStatuses ?? ["todo", "in-progress", "done"]),
        ]),
      ),
    checkReadiness: () =>
      Effect.succeed(
        fixture.readiness ?? {
          _tag: "ready",
          version: "0.25.0",
          remote: { workspaceSlug: "ws-test", projectId: "proj-test" },
        },
      ),
    updateIssueStatus: (options, issueId, status) =>
      fixture.updateIssueStatus !== undefined
        ? fixture.updateIssueStatus(options, issueId, status)
        : failOr(() => Effect.void),
    ensureMilestoneComment: (options, issueId, marker, body) =>
      fixture.ensureMilestoneComment !== undefined
        ? fixture.ensureMilestoneComment(options, issueId, marker, body)
        : failOr(() => Effect.void),
  })
}
