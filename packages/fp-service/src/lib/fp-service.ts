import { Context, type Effect } from "effect"
import type { FpRequestError } from "./errors.js"
import type {
  FpIssue,
  FpIssueSnapshot,
  FpProjectOptions,
  FpReadiness,
} from "./types.js"

export type FpServiceError = FpRequestError

/**
 * fp (Fiberplane's local-first tracker) as an Issue Tracker. Every operation
 * runs the fp CLI with the project directory as working directory: the CLI
 * is fp's supported local interface (its REST mode is for sandboxes and CI
 * against a linked project, not a documented API), and the harness holds no
 * credential of its own; the operator's fp login on the machine is the
 * identity.
 */
export interface FpServiceShape {
  /**
   * The operator's fp identity: the authenticated account's email, which is
   * also what fp records as an Issue's author.
   */
  readonly getAuthenticatedUserLogin: (
    projectDirectory: string,
  ) => Effect.Effect<string, FpServiceError>
  /**
   * Open Ready-labeled Issues of one fp project with parent, children,
   * and dependency facts. fp's list output carries no labels, so each
   * candidate is inspected with `fp issue show`; results are cached by
   * `updatedAt` between calls so a poll re-reads only what changed.
   */
  readonly listReadyIssues: (
    options: FpProjectOptions,
  ) => Effect.Effect<readonly FpIssue[], FpServiceError>
  /**
   * Live status and labels of one Issue, by Issue Native Identity or Issue
   * Display Identifier (fp accepts both). Uses the project's closed statuses.
   */
  readonly getIssue: (
    options: FpProjectOptions,
    issueId: string,
  ) => Effect.Effect<FpIssueSnapshot, FpServiceError>
  /** The CLI is on the path and the directory resolves to an fp project. */
  readonly checkReadiness: (
    projectDirectory: string,
  ) => Effect.Effect<FpReadiness>
  /**
   * Move one Issue to a registered status. An Issue already in that status,
   * or already closed by the project's closed statuses, is accepted without
   * a write. The write is verified by reading the Issue back, because fp
   * reports success on some writes it did not perform.
   */
  readonly updateIssueStatus: (
    options: FpProjectOptions,
    issueId: string,
    status: string,
  ) => Effect.Effect<void, FpServiceError>
  /**
   * Ensure one comment carrying `marker` exists on the Issue with exactly
   * `body`: created when absent, updated when its content differs, left
   * alone when identical, so retries never duplicate it. Verified by
   * reading the comments back.
   */
  readonly ensureMilestoneComment: (
    options: FpProjectOptions,
    issueId: string,
    marker: string,
    body: string,
  ) => Effect.Effect<void, FpServiceError>
}

export class FpService extends Context.Service<FpService, FpServiceShape>()(
  "@ready-for-agent/fp-service/FpService",
) {}
