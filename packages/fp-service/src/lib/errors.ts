import { Schema } from "effect"

/**
 * Why an fp CLI invocation failed, when known. `issue_not_found` lets
 * discovery drop one vanished Issue instead of failing the poll;
 * `invalid_status` and `comment_not_found` come from writes;
 * `write_not_applied` is a write fp reported as done that the read-back
 * did not find; `outdated_cli` is an fp build whose output lacks what the
 * harness needs. `property_not_registered` is a write of the `rfa-number`
 * property in a project without its extension; `invalid_issue_number` and
 * `duplicate_issue_number` stop numbering a project whose numbers the
 * harness cannot trust (ADR 0074).
 */
export const FpFailureKind = Schema.Literals([
  "project_not_registered",
  "issue_not_found",
  "comment_not_found",
  "invalid_status",
  "write_not_applied",
  "timeout",
  "spawn_failed",
  "unreadable_output",
  "outdated_cli",
  "property_not_registered",
  "invalid_issue_number",
  "duplicate_issue_number",
  "unknown",
])
export type FpFailureKind = typeof FpFailureKind.Type

/** An fp CLI invocation failed, timed out, or returned output we cannot read. */
export class FpRequestError extends Schema.TaggedErrorClass<FpRequestError>()(
  "FpRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Finite),
    stderr: Schema.optional(Schema.String),
    kind: Schema.optional(FpFailureKind),
  },
) {}

/** For the execution half: a Repository selects fp without a usable project. */
export class FpNotConfiguredError extends Schema.TaggedErrorClass<FpNotConfiguredError>()(
  "FpNotConfiguredError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}
