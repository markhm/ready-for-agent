import { Schema } from "effect"
import type { FpFailureKind } from "./errors.js"

/**
 * Pure parsers for fp CLI output, kept separate from process spawning so
 * they can be pinned against captured transcripts. Shapes observed on fp
 * 0.25.0; unknown keys are ignored, so additive CLI changes do not break them.
 */

const IsoDate = Schema.String

const FpPropertiesSchema = Schema.NullOr(
  Schema.Struct({
    labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    "rfa-number": Schema.optional(Schema.NullOr(Schema.String)),
  }),
)

const FpListIssueSchema = Schema.Struct({
  id: Schema.String,
  shortId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  priority: Schema.optional(Schema.NullOr(Schema.String)),
  parent: Schema.optional(Schema.NullOr(Schema.String)),
  dependencies: Schema.optional(Schema.Array(Schema.String)),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  // Absent on fp builds before a381766, which list no properties at all.
  properties: Schema.optional(FpPropertiesSchema),
})

/** `fp issue list --format json` wraps the array: `{ "issues": [...] }`. */
const FpListSchema = Schema.Struct({
  issues: Schema.Array(FpListIssueSchema),
})

const FpShowIssueSchema = Schema.Struct({
  id: Schema.String,
  displayId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  parent: Schema.optional(Schema.NullOr(Schema.String)),
  dependencies: Schema.optional(Schema.Array(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  properties: Schema.optional(FpPropertiesSchema),
})

const FpCommentSchema = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  author: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(IsoDate),
})

/** `fp comment list <id> --format json`: `{ "comments": [...] }`, newest first. */
const FpCommentListSchema = Schema.Struct({
  comments: Schema.Array(FpCommentSchema),
})

export type FpListIssue = typeof FpListIssueSchema.Type
export type FpShowIssue = typeof FpShowIssueSchema.Type
export type FpComment = typeof FpCommentSchema.Type

const decodeJson = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  text: string,
): S["Type"] => Schema.decodeUnknownSync(schema)(JSON.parse(text))

export const parseFpIssueList = (stdout: string): readonly FpListIssue[] =>
  decodeJson(FpListSchema, stdout).issues

export const parseFpIssueShow = (stdout: string): FpShowIssue =>
  decodeJson(FpShowIssueSchema, stdout)

export const parseFpCommentList = (stdout: string): readonly FpComment[] =>
  decodeJson(FpCommentListSchema, stdout).comments

/** Labels live in the `labels` property; absent or null means none. */
export const fpIssueLabels = (
  issue: FpShowIssue | FpListIssue,
): readonly string[] => issue.properties?.labels ?? []

/** The fp property holding the harness-allocated number (ADR 0074). */
export const FP_NUMBER_PROPERTY = "rfa-number"

/**
 * The Issue's `rfa-number`: none when absent or empty (fp clears a property
 * by writing it empty), a number when it is a positive integer, and invalid
 * otherwise, so a value the harness did not write is never overwritten.
 */
export const fpIssueNumber = (
  issue: FpShowIssue | FpListIssue,
):
  | { readonly kind: "none" }
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "invalid"; readonly raw: string } => {
  const raw = issue.properties?.[FP_NUMBER_PROPERTY]
  if (raw === undefined || raw === null || raw === "") {
    return { kind: "none" }
  }
  const number = Number(raw)
  return /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(number)
    ? { kind: "number", number }
    : { kind: "invalid", raw }
}

const EMAIL_LINE = /^\s*Email:\s*(\S+)\s*$/m
const NAME_LINE = /^\s*Name:\s*(.+?)\s*$/m

/**
 * `fp auth status` has no JSON mode. It prints `Name:` and `Email:` lines
 * after a `Token valid` check; the email is the fp author identity.
 */
export const parseFpAuthStatus = (
  combinedOutput: string,
): { readonly name: string | null; readonly email: string } | null => {
  const email = EMAIL_LINE.exec(combinedOutput)?.[1]
  if (email === undefined || email === "") {
    return null
  }
  const name = NAME_LINE.exec(combinedOutput)?.[1] ?? null
  return { name, email }
}

/**
 * `fp project remote --format json` of a linked project: `projectId`,
 * `workspaceSlug`, `serverUrl` and timestamps. An unlinked project prints
 * `Project not linked to remote` and exits 1 instead; that is decided on
 * the exit code, not here.
 */
const FpProjectRemoteSchema = Schema.Struct({
  projectId: Schema.String,
  workspaceSlug: Schema.String,
})

export const parseFpProjectRemote = (
  stdout: string,
): { readonly workspaceSlug: string; readonly projectId: string } => {
  const remote = decodeJson(FpProjectRemoteSchema, stdout)
  return { workspaceSlug: remote.workspaceSlug, projectId: remote.projectId }
}

/** One fp project registered on this machine. */
export interface FpRegisteredProject {
  readonly name: string
  readonly path: string
  /** fp marks a project whose folder no longer exists as orphaned. */
  readonly orphaned: boolean
}

const PROJECT_NAME_LINE = /^ {2}(\S.*?)( \(orphaned\))?\s*$/
const PROJECT_PATH_LINE = /^ {4}Path:\s+(.+?)\s*$/

/**
 * `fp project list` has no JSON mode (0.25.0). After a `Registered
 * projects:` header, each project is a block: the name indented two spaces
 * (with ` (orphaned)` when its folder is gone), then `Path:` and `Storage:`
 * indented four. Output without the header is not a project list.
 */
export const parseFpProjectList = (
  stdout: string,
): readonly FpRegisteredProject[] => {
  const lines = stdout.split(/\r?\n/)
  const header = lines.findIndex(
    (line) => line.trim() === "Registered projects:",
  )
  if (header === -1) {
    throw new Error("fp project list output has no Registered projects header")
  }
  const projects: FpRegisteredProject[] = []
  let current: { name: string; orphaned: boolean } | null = null
  for (const line of lines.slice(header + 1)) {
    const path = PROJECT_PATH_LINE.exec(line)
    if (path !== null) {
      if (current !== null) {
        projects.push({ ...current, path: path[1] ?? "" })
        current = null
      }
      continue
    }
    const name = PROJECT_NAME_LINE.exec(line)
    if (name !== null) {
      current = { name: name[1] ?? "", orphaned: name[2] !== undefined }
    }
  }
  return projects
}

const REGISTERED_STATUSES_LINE =
  /^\s*-\s*Registered statuses \(in order\):\s*(.+?)\s*$/m

/**
 * `fp guide` is the only place fp 0.25.0 lists a project's registered
 * statuses: `- Registered statuses (in order): todo, in-progress, done`
 * under `## Project context`. Outside a project it says `Not in an fp
 * project` instead, with exit code 0; that is null here.
 */
export const parseFpRegisteredStatuses = (
  stdout: string,
): readonly string[] | null => {
  const match = REGISTERED_STATUSES_LINE.exec(stdout)
  if (match === null) {
    if (/Not in an fp project/i.test(stdout)) {
      return null
    }
    throw new Error("fp guide output lists no registered statuses")
  }
  return (match[1] ?? "")
    .split(",")
    .map((status) => status.trim())
    .filter((status) => status !== "")
}

/** `fp --version` prints `0.25.0 (d818046)`. */
export const parseFpVersion = (stdout: string): string | null => {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout)
  return match?.[1] ?? null
}

/**
 * fp reports failures as prose on stdout or stderr with exit code 1. These
 * are the messages observed on 0.25.0; anything else is `unknown`.
 * `invalid_status` and `comment_not_found` are only reachable from writes.
 */
export const classifyFpFailure = (
  combinedOutput: string,
): Extract<
  FpFailureKind,
  | "project_not_registered"
  | "issue_not_found"
  | "comment_not_found"
  | "invalid_status"
  | "unknown"
> => {
  if (
    /\.fp directory not found/i.test(combinedOutput) ||
    /not registered with fp/i.test(combinedOutput)
  ) {
    return "project_not_registered"
  }
  if (/^Issue \S+ not found/im.test(combinedOutput)) {
    return "issue_not_found"
  }
  if (/^Comment \S+ not found/im.test(combinedOutput)) {
    return "comment_not_found"
  }
  if (/Invalid status/i.test(combinedOutput)) {
    return "invalid_status"
  }
  return "unknown"
}
