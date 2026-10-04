import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Layer, Semaphore, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FpRequestError } from "./errors.js"
import {
  FP_NUMBER_PROPERTY,
  type FpComment,
  type FpListIssue,
  type FpShowIssue,
  classifyFpFailure,
  fpIssueLabels,
  fpIssueNumber,
  parseFpAuthStatus,
  parseFpCommentList,
  parseFpIssueList,
  parseFpIssueShow,
  parseFpProjectList,
  parseFpProjectRemote,
  parseFpRegisteredProperties,
  parseFpRegisteredStatuses,
  parseFpVersion,
} from "./fp-cli-output.js"
import { FpService, type FpServiceShape } from "./fp-service.js"
import {
  FP_CLI_COMMAND,
  FP_READY_LABEL,
  type FpIssue,
  type FpIssueParent,
  type FpIssueReference,
  type FpIssueSnapshot,
  type FpProjectOptions,
  fpIssueState,
  fpIssueUrl,
} from "./types.js"

export const FP_CLI_TIMEOUT = Duration.seconds(60)
/** Grace after SIGTERM before a timed-out fp is killed outright. */
export const FP_FORCE_KILL_AFTER = Duration.seconds(5)
/** `fp issue show` is one process per Issue; eight at once keeps a poll short. */
export const FP_SHOW_CONCURRENCY = 8

export interface MakeFpServiceOptions {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  /** Executable name or path; defaults to `fp` on the PATH. */
  readonly command?: string
  readonly timeout?: Duration.Duration
}

interface FpCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Cached `show` output, valid while the Issue's list `updatedAt` is unchanged. */
interface ShowCacheEntry {
  readonly updatedAt: string
  readonly issue: FpShowIssue
}

const requestError = (
  message: string,
  extra?: Partial<FpCliResult> & { readonly kind?: FpRequestError["kind"] },
  cause?: unknown,
): FpRequestError =>
  new FpRequestError({
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(extra?.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
    ...(extra?.stderr === undefined || extra.stderr === ""
      ? {}
      : { stderr: extra.stderr }),
    ...(extra?.kind === undefined ? {} : { kind: extra.kind }),
  })

const combinedOutput = (result: FpCliResult): string =>
  `${result.stdout}\n${result.stderr}`

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * A missing executable or working directory: Effect's spawner reports it as
 * `NotFound`, Node's underlying error as `ENOENT`.
 */
const isMissingPath = (cause: unknown): boolean =>
  /ENOENT|NotFound/.test(causeMessage(cause))

const directoryExists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => access(path)).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  )

/**
 * A comment body goes to fp through a file: the positional message parses a
 * leading `-` as a flag, and `--file -` does not read stdin (0.25.0). The
 * file is private to the operator and removed once fp has read it.
 */
const withBodyFile = <A, E>(
  body: string,
  use: (path: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | FpRequestError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const directory = await mkdtemp(join(tmpdir(), "fp-comment-"))
        const path = join(directory, "body.md")
        await writeFile(path, body, { mode: 0o600 })
        return { directory, path }
      },
      catch: (cause) =>
        requestError(
          "Could not write the fp comment body to a temporary file.",
          { kind: "unknown" },
          cause,
        ),
    }),
    (file) => use(file.path),
    (file) =>
      Effect.tryPromise(() =>
        rm(file.directory, { recursive: true, force: true }),
      ).pipe(Effect.ignore),
  )

/**
 * fp stores comment content trimmed at both ends (0.25.0: `content.trim()`
 * on add and update), inner whitespace kept; compare what fp would store.
 */
const storedContent = (text: string): string => text.trim()

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The comment that carries `marker` as a line of its own. A comment that
 * merely quotes the marker (`> ready-for-agent:...`) is someone else's and
 * is never the target. `fp comment list` prints newest first; when more
 * than one comment carries the marker, the oldest is the one the harness
 * wrote first and the one it keeps updating.
 */
const findMarked = (
  comments: readonly FpComment[],
  marker: string,
): FpComment | null => {
  // `\r` is a line terminator for `$` under the m flag, so CRLF bodies match.
  const ownLine = new RegExp(`^${escapeRegExp(marker)}$`, "m")
  return (
    [...comments].reverse().find((comment) => ownLine.test(comment.content)) ??
    null
  )
}

/**
 * Every operation spawns the fp CLI with the project directory as working
 * directory. One cache lives as long as the service: `show` output keyed by
 * the list's `updatedAt`, so a poll re-reads only what changed, pruned to
 * the Issues the list still has. The project's remote identity is read on
 * every poll so a link change takes effect without a restart.
 */
export const makeFpService = (
  options: MakeFpServiceOptions,
): FpServiceShape => {
  const command = options.command ?? FP_CLI_COMMAND
  const timeout = options.timeout ?? FP_CLI_TIMEOUT
  const showCache = new Map<string, ShowCacheEntry>()
  // One allocation at a time: refresh can be started by a queued job and by
  // polling, and two allocations reading the same highest number would
  // hand it out twice (ADR 0074's single allocator).
  const numbering = Semaphore.makeUnsafe(1)

  const runFp = Effect.fn("FpService.runFp")(function* (
    cwd: string,
    args: readonly string[],
  ) {
    const process = ChildProcess.make(command, [...args], {
      cwd,
      stdin: "ignore",
      // On timeout the scope's release sends SIGTERM to the process group;
      // an fp that ignores it is killed rather than holding the poll.
      forceKillAfter: FP_FORCE_KILL_AFTER,
    })
    const invocation = `${command} ${args.join(" ")}`
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* options.spawner.spawn(process)
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          ],
          { concurrency: 3 },
        )
        return {
          exitCode: Number(exitCode),
          stdout,
          stderr,
        } satisfies FpCliResult
      }),
    ).pipe(
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          requestError(
            `${invocation} did not finish within ${Duration.toMillis(timeout)} ms in ${cwd}.`,
            { kind: "timeout" },
          ),
        ),
      ),
      Effect.catch((error) => {
        if (error instanceof FpRequestError) {
          return Effect.fail(error)
        }
        // A missing executable and a missing working directory both surface
        // as ENOENT; the readiness check tells them apart, this message
        // names both so the operator is not sent to install fp for a typo
        // in the directory.
        const message = isMissingPath(error)
          ? `Could not run ${invocation}: the fp CLI is not on the PATH, or ${cwd} does not exist.`
          : `${invocation} failed before exiting in ${cwd}: ${causeMessage(error)}`
        return Effect.fail(
          requestError(
            message,
            { kind: isMissingPath(error) ? "spawn_failed" : "unknown" },
            error,
          ),
        )
      }),
    )
  })

  /** Run fp and require exit code 0, or fail with the classified message. */
  const runFpOk = Effect.fn("FpService.runFpOk")(function* (
    cwd: string,
    args: readonly string[],
    describe: string,
  ) {
    const result = yield* runFp(cwd, args)
    if (result.exitCode !== 0) {
      const kind = classifyFpFailure(combinedOutput(result))
      const detail =
        kind === "project_not_registered"
          ? `${cwd} is not a registered fp project`
          : kind === "issue_not_found"
            ? "the Issue does not exist"
            : kind === "comment_not_found"
              ? "the comment no longer exists"
              : kind === "invalid_status"
                ? "the status is not registered in this fp project"
                : kind === "property_not_registered"
                  ? `the fp project does not register the ${FP_NUMBER_PROPERTY} property; install the ready-for-agent rfa-number fp extension`
                  : `fp exited with code ${result.exitCode}`
      return yield* requestError(`Failed ${describe}: ${detail}.`, {
        ...result,
        kind,
      })
    }
    return result
  })

  const parseOrFail = <A>(
    describe: string,
    result: FpCliResult,
    parse: (stdout: string) => A,
  ): Effect.Effect<A, FpRequestError> =>
    Effect.try({
      try: () => parse(result.stdout),
      catch: (cause) =>
        requestError(
          `Could not read fp output while ${describe}.`,
          { ...result, kind: "unreadable_output" },
          cause,
        ),
    })

  /**
   * For commands whose text lands on either stream: fp 0.25.0 prints `fp
   * guide` on stderr (stdout is a blank line) and `fp project list` on both.
   * Parse stdout, and stderr only when stdout does not parse, so output
   * printed twice is not read twice.
   */
  const parseEitherStreamOrFail = <A>(
    describe: string,
    result: FpCliResult,
    parse: (text: string) => A,
  ): Effect.Effect<A, FpRequestError> =>
    Effect.try({
      try: () => {
        try {
          return parse(result.stdout)
        } catch {
          return parse(result.stderr)
        }
      },
      catch: (cause) =>
        requestError(
          `Could not read fp output while ${describe}.`,
          { ...result, kind: "unreadable_output" },
          cause,
        ),
    })

  const listIssues = Effect.fn("FpService.listIssues")(function* (cwd: string) {
    const describe = "listing fp issues"
    const result = yield* runFpOk(
      cwd,
      ["issue", "list", "--format", "json"],
      describe,
    )
    return yield* parseOrFail(describe, result, parseFpIssueList)
  })

  const showIssue = Effect.fn("FpService.showIssue")(function* (
    cwd: string,
    issueId: string,
  ) {
    const describe = `reading fp issue ${issueId}`
    const result = yield* runFpOk(
      cwd,
      ["issue", "show", issueId, "--format", "json"],
      describe,
    )
    return yield* parseOrFail(describe, result, parseFpIssueShow)
  })

  /**
   * The project's remote identity, read on every call: one short process
   * per poll, so linking, unlinking or relinking the project takes effect
   * on the next poll without a restart. An unlinked project (exit 1,
   * "Project not linked to remote") reads as null; any other failure is an
   * error, not "unlinked".
   */
  const projectRemote = Effect.fn("FpService.projectRemote")(function* (
    cwd: string,
  ) {
    const describe = "reading the fp project's remote identity"
    const result = yield* runFp(cwd, ["project", "remote", "--format", "json"])
    if (result.exitCode !== 0) {
      if (/not linked to remote/i.test(combinedOutput(result))) {
        return null
      }
      return yield* requestError(
        `Failed ${describe}: fp exited with code ${result.exitCode}.`,
        { ...result, kind: classifyFpFailure(combinedOutput(result)) },
      )
    }
    return yield* parseOrFail(describe, result, parseFpProjectRemote)
  })

  /**
   * `show`, served from the cache while the list's `updatedAt` matches. fp
   * 0.25.0 moves `updatedAt` on every edit that matters here: a label,
   * parent or dependency change and a comment (measured 2026-09-22), so an
   * unchanged `updatedAt` means unchanged labels. Null when the Issue
   * vanished between list and show; that one Issue is dropped from the poll
   * instead of failing discovery for every other one.
   */
  const showCached = Effect.fn("FpService.showCached")(function* (
    cwd: string,
    listed: FpListIssue,
  ) {
    const cached = showCache.get(listed.id)
    if (cached !== undefined && cached.updatedAt === listed.updatedAt) {
      return cached.issue
    }
    const issue = yield* showIssue(cwd, listed.id).pipe(
      Effect.catch((error) =>
        error.kind === "issue_not_found"
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    )
    if (issue !== null) {
      showCache.set(listed.id, { updatedAt: listed.updatedAt, issue })
    }
    return issue
  })

  const listReadyIssues = Effect.fn("FpService.listReadyIssues")(function* (
    projectOptions: FpProjectOptions,
  ) {
    const cwd = projectOptions.projectDirectory
    const readyLabel = projectOptions.readyLabel ?? FP_READY_LABEL
    const stateOf = (status: string) => fpIssueState(status, projectOptions)
    const remote = yield* projectRemote(cwd)

    // One list call gives status, parent, dependencies, labels, number and
    // updatedAt for every Issue; eligibility, hierarchy and blocker facts
    // come from here, never from extra show calls.
    const all = yield* listIssues(cwd)
    if (all.some((issue) => issue.properties === undefined)) {
      return yield* requestError(
        "This fp build lists Issues without their properties, so labels and numbers cannot be read. Run `fp update`.",
        { kind: "outdated_cli" },
      )
    }
    const byId = new Map(all.map((issue) => [issue.id, issue]))
    const childrenOf = new Map<string, FpListIssue[]>()
    for (const issue of all) {
      if (issue.parent !== null && issue.parent !== undefined) {
        const siblings = childrenOf.get(issue.parent) ?? []
        siblings.push(issue)
        childrenOf.set(issue.parent, siblings)
      }
    }

    const candidateStatuses =
      projectOptions.candidateStatuses === undefined
        ? null
        : new Set(projectOptions.candidateStatuses)
    const candidates = all.filter(
      (issue) =>
        stateOf(issue.status) === "OPEN" &&
        (candidateStatuses === null || candidateStatuses.has(issue.status)) &&
        fpIssueLabels(issue).includes(readyLabel),
    )

    // Only the display id, title, body and author need show, and only for
    // the Ready candidates; cached by updatedAt so an unchanged Issue costs
    // nothing on the next poll. Everything else comes from this poll's list.
    const shown = yield* Effect.forEach(
      candidates,
      (listed) => showCached(cwd, listed),
      { concurrency: FP_SHOW_CONCURRENCY },
    )
    // Issues that left the project take their cached show with them.
    for (const cachedId of [...showCache.keys()]) {
      if (!byId.has(cachedId)) {
        showCache.delete(cachedId)
      }
    }
    const ready = candidates.flatMap((listed, index) => {
      const issue = shown[index]
      return issue !== undefined && issue !== null ? [{ listed, issue }] : []
    })
    const numberOf = (listed: FpListIssue | undefined): number | null => {
      if (listed === undefined) {
        return null
      }
      const number = fpIssueNumber(listed)
      return number.kind === "number" ? number.number : null
    }

    // A reference to an Issue we did not show (a blocker, an absent parent)
    // gets its display id from the cache when we have shown it before, else
    // from the project prefix: the display id is `<prefix>-<shortId>`, and
    // the prefix is what a shown Issue's display id has before its own
    // short id (a prefix may itself contain a dash).
    const prefix = (() => {
      const sample = ready[0]
      if (sample === undefined) {
        return null
      }
      const suffix = `-${sample.listed.shortId}`
      return sample.issue.displayId.endsWith(suffix)
        ? sample.issue.displayId.slice(0, -suffix.length)
        : null
    })()
    const referenceFor = (nativeId: string): FpIssueReference => {
      const cachedDisplayId = showCache.get(nativeId)?.issue.displayId
      const listed = byId.get(nativeId)
      const displayId =
        cachedDisplayId ??
        (listed !== undefined && prefix !== null
          ? `${prefix}-${listed.shortId}`
          : nativeId)
      return {
        nativeId,
        displayId,
        url: fpIssueUrl(remote, nativeId),
        number: numberOf(listed),
      }
    }

    const parentFor = Effect.fn("FpService.parentFor")(function* (
      issue: FpListIssue,
    ) {
      const parentId = issue.parent
      if (parentId === null || parentId === undefined) {
        return { parent: null, parentPosition: null }
      }
      const listedParent = byId.get(parentId)
      // A parent outside this project's list (deleted, foreign) or one that
      // vanished mid-poll counts as closed and not Ready, so the child is
      // not offered.
      const shownParent =
        listedParent === undefined ? null : yield* showCached(cwd, listedParent)
      if (listedParent === undefined || shownParent === null) {
        const parent: FpIssueParent = {
          ...referenceFor(parentId),
          state: "CLOSED",
          isReadyLabeled: false,
        }
        return { parent, parentPosition: null }
      }
      const parent: FpIssueParent = {
        nativeId: parentId,
        displayId: shownParent.displayId,
        url: fpIssueUrl(remote, parentId),
        number: numberOf(listedParent),
        state: stateOf(listedParent.status),
        isReadyLabeled: fpIssueLabels(listedParent).includes(readyLabel),
      }
      const siblings = [...(childrenOf.get(parentId) ?? [])].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      )
      const index = siblings.findIndex((sibling) => sibling.id === issue.id)
      return { parent, parentPosition: index === -1 ? null : index + 1 }
    })

    const issues: FpIssue[] = []
    for (const { listed, issue } of ready) {
      const { parent, parentPosition } = yield* parentFor(listed)
      issues.push({
        nativeId: issue.id,
        number: numberOf(listed),
        displayId: issue.displayId,
        title: issue.title,
        body: issue.description ?? "",
        url: fpIssueUrl(remote, issue.id),
        createdAt: new Date(listed.createdAt),
        updatedAt: new Date(listed.updatedAt),
        status: listed.status,
        state: stateOf(listed.status),
        author: issue.author ?? null,
        labels: fpIssueLabels(listed),
        parent,
        parentPosition,
        hasChildren: (childrenOf.get(issue.id)?.length ?? 0) > 0,
        hierarchySupported: true,
        // A finished blocker no longer blocks, as on the Forges; one missing
        // from the list (deleted, foreign) still does.
        blockedBy: (listed.dependencies ?? [])
          .filter((blockerId) => {
            const blocker = byId.get(blockerId)
            return blocker === undefined || stateOf(blocker.status) === "OPEN"
          })
          .map(referenceFor),
      })
    }
    // fp short ids are random letters, so creation order is the meaningful
    // order; the display id only breaks ties deterministically.
    return issues.sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.displayId.localeCompare(right.displayId),
    )
  })

  const writeIssueNumber = Effect.fn("FpService.writeIssueNumber")(function* (
    cwd: string,
    issueId: string,
    number: number,
  ) {
    const describe = `numbering fp issue ${issueId} as ${number}`
    yield* runFpOk(
      cwd,
      [
        "issue",
        "update",
        issueId,
        "--property",
        `${FP_NUMBER_PROPERTY}=${number}`,
      ],
      describe,
    )
    const after = fpIssueNumber(yield* showIssue(cwd, issueId))
    if (after.kind !== "number" || after.number !== number) {
      return yield* requestError(
        `fp reported ${describe}, but the Issue reads back without that number.`,
        { kind: "write_not_applied" },
      )
    }
  })

  const numberReadyIssues = Effect.fn("FpService.numberReadyIssues")(
    function* (projectOptions: FpProjectOptions, issues: readonly FpIssue[]) {
      const cwd = projectOptions.projectDirectory
      // A fresh list, not the discovery poll's: the numbers in fp are the
      // record, and another write may have landed since.
      const all = yield* listIssues(cwd)
      if (all.some((issue) => issue.properties === undefined)) {
        return yield* requestError(
          "This fp build lists Issues without their properties, so numbers cannot be read. Run `fp update`.",
          { kind: "outdated_cli" },
        )
      }
      const nameOf = (listed: FpListIssue) =>
        issues.find((issue) => issue.nativeId === listed.id)?.displayId ??
        listed.shortId
      const numbers = new Map<string, number>()
      const holders = new Map<number, FpListIssue>()
      for (const listed of all) {
        const value = fpIssueNumber(listed)
        if (value.kind === "invalid") {
          return yield* requestError(
            `fp issue ${nameOf(listed)} has ${FP_NUMBER_PROPERTY} "${value.raw}", which is not a positive integer; correct or clear it in fp.`,
            { kind: "invalid_issue_number" },
          )
        }
        if (value.kind === "number") {
          const holder = holders.get(value.number)
          if (holder !== undefined) {
            return yield* requestError(
              `fp issues ${nameOf(holder)} and ${nameOf(listed)} both have ${FP_NUMBER_PROPERTY} ${value.number}; clear one of them in fp.`,
              { kind: "duplicate_issue_number" },
            )
          }
          holders.set(value.number, listed)
          numbers.set(listed.id, value.number)
        }
      }
      let highest = Math.max(0, ...holders.keys())
      const listedIds = new Set(all.map((listed) => listed.id))
      for (const issue of issues) {
        // An Issue that left the project since discovery is not numbered.
        if (numbers.has(issue.nativeId) || !listedIds.has(issue.nativeId)) {
          continue
        }
        highest += 1
        yield* writeIssueNumber(cwd, issue.nativeId, highest)
        numbers.set(issue.nativeId, highest)
      }
      const numberOf = (nativeId: string) => numbers.get(nativeId) ?? null
      return issues.map(
        (issue): FpIssue => ({
          ...issue,
          number: numberOf(issue.nativeId),
          parent:
            issue.parent === null
              ? null
              : { ...issue.parent, number: numberOf(issue.parent.nativeId) },
          blockedBy: issue.blockedBy.map((blocker) => ({
            ...blocker,
            number: numberOf(blocker.nativeId),
          })),
        }),
      )
    },
    (effect) => numbering.withPermits(1)(effect),
  )

  const getIssue = Effect.fn("FpService.getIssue")(function* (
    projectOptions: FpProjectOptions,
    issueId: string,
  ) {
    const issue = yield* showIssue(projectOptions.projectDirectory, issueId)
    const remote = yield* projectRemote(projectOptions.projectDirectory)
    const snapshot: FpIssueSnapshot = {
      nativeId: issue.id,
      displayId: issue.displayId,
      url: fpIssueUrl(remote, issue.id),
      status: issue.status,
      state: fpIssueState(issue.status, projectOptions),
      labels: fpIssueLabels(issue),
    }
    return snapshot
  })

  const getAuthenticatedUserLogin = Effect.fn(
    "FpService.getAuthenticatedUserLogin",
  )(function* (projectDirectory: string) {
    const result = yield* runFp(projectDirectory, ["auth", "status"])
    const operator = parseFpAuthStatus(combinedOutput(result))
    if (result.exitCode !== 0 || operator === null) {
      return yield* requestError(
        "fp is not authenticated on this machine; run `fp auth login` as the operator.",
        result,
      )
    }
    return operator.email
  })

  /**
   * `fp project list` reads fp's machine-wide registry, so it runs from the
   * operator's home directory rather than from any one project.
   */
  const listRegisteredProjects = Effect.fn("FpService.listRegisteredProjects")(
    function* () {
      const describe = "listing registered fp projects"
      const result = yield* runFpOk(homedir(), ["project", "list"], describe)
      return yield* parseEitherStreamOrFail(
        describe,
        result,
        parseFpProjectList,
      )
    },
  )

  const listProjectStatuses = Effect.fn("FpService.listProjectStatuses")(
    function* (projectDirectory: string) {
      const describe = `reading the registered statuses of ${projectDirectory}`
      const result = yield* runFpOk(projectDirectory, ["guide"], describe)
      const statuses = yield* parseEitherStreamOrFail(
        describe,
        result,
        parseFpRegisteredStatuses,
      )
      if (statuses === null) {
        return yield* requestError(
          `Failed ${describe}: ${projectDirectory} is not a registered fp project.`,
          { ...result, kind: "project_not_registered" },
        )
      }
      return statuses
    },
  )

  const checkReadiness = Effect.fn("FpService.checkReadiness")(function* (
    projectDirectory: string,
  ) {
    if (!(yield* directoryExists(projectDirectory))) {
      return {
        _tag: "project_not_registered" as const,
        message: `${projectDirectory} does not exist.`,
      }
    }
    const version = yield* runFp(projectDirectory, ["--version"]).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? parseFpVersion(result.stdout) : null,
      ),
      Effect.orElseSucceed(() => null),
    )
    if (version === null) {
      return {
        _tag: "cli_missing" as const,
        message: `The fp CLI is not available as \`${command}\`; install it and make sure it is on the PATH.`,
      }
    }
    // The CLI runs, so a probe that hangs, dies or fails for another reason
    // is an fp problem, not an unregistered directory.
    const probe = yield* runFp(projectDirectory, [
      "issue",
      "list",
      "--format",
      "json",
      "--limit",
      "1",
    ]).pipe(
      Effect.map((result) => ({ _tag: "exited" as const, result })),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "failed" as const, error }),
      ),
    )
    if (probe._tag === "failed") {
      return { _tag: "cli_error" as const, message: probe.error.message }
    }
    if (probe.result.exitCode !== 0) {
      if (
        classifyFpFailure(combinedOutput(probe.result)) ===
        "project_not_registered"
      ) {
        return {
          _tag: "project_not_registered" as const,
          message: `${projectDirectory} is not a registered fp project (run \`fp init\` there, or configure the fp project directory).`,
        }
      }
      return {
        _tag: "cli_error" as const,
        message: `fp could not list issues in ${projectDirectory} (exit code ${probe.result.exitCode}): ${combinedOutput(probe.result).trim()}`,
      }
    }
    // Readiness never fails; a remote lookup that errors is reported as such,
    // not as an unlinked project.
    const remote = yield* projectRemote(projectDirectory).pipe(
      Effect.map((value) => ({ _tag: "known" as const, value })),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "failed" as const, message: error.message }),
      ),
    )
    if (remote._tag === "failed") {
      return { _tag: "cli_error" as const, message: remote.message }
    }
    const guide = yield* runFpOk(
      projectDirectory,
      ["guide"],
      "reading the fp project's registered properties",
    ).pipe(
      Effect.map((result) => ({ _tag: "read" as const, result })),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "failed" as const, message: error.message }),
      ),
    )
    if (guide._tag === "failed") {
      return { _tag: "cli_error" as const, message: guide.message }
    }
    // fp prints the guide on stderr.
    if (
      !parseFpRegisteredProperties(combinedOutput(guide.result)).includes(
        FP_NUMBER_PROPERTY,
      )
    ) {
      return {
        _tag: "number_property_missing" as const,
        message: `The fp project does not register the ${FP_NUMBER_PROPERTY} property, where the harness keeps each Issue's number; install the ready-for-agent rfa-number fp extension.`,
      }
    }
    return { _tag: "ready" as const, version, remote: remote.value }
  })

  const updateIssueStatus = Effect.fn("FpService.updateIssueStatus")(function* (
    projectOptions: FpProjectOptions,
    issueId: string,
    status: string,
  ) {
    const cwd = projectOptions.projectDirectory
    const before = yield* showIssue(cwd, issueId)
    if (before.status === status) {
      return
    }
    // A closed Issue stays closed: completion after a manual close, or a
    // rejected Issue, is accepted rather than reopened or re-transitioned.
    if (fpIssueState(before.status, projectOptions) === "CLOSED") {
      return
    }
    const describe = `updating fp issue ${issueId} to status ${status}`
    yield* runFpOk(
      cwd,
      ["issue", "update", issueId, "--status", status],
      describe,
    )
    const after = yield* showIssue(cwd, issueId)
    if (after.status !== status) {
      return yield* requestError(
        `fp reported ${describe}, but the Issue reads back as ${after.status}.`,
        { kind: "write_not_applied" },
      )
    }
  })

  const listComments = Effect.fn("FpService.listComments")(function* (
    cwd: string,
    issueId: string,
  ) {
    const describe = `listing comments of fp issue ${issueId}`
    const result = yield* runFpOk(
      cwd,
      ["comment", "list", issueId, "--format", "json"],
      describe,
    )
    return yield* parseOrFail(describe, result, parseFpCommentList)
  })

  const ensureMilestoneComment = Effect.fn("FpService.ensureMilestoneComment")(
    function* (
      projectOptions: FpProjectOptions,
      issueId: string,
      marker: string,
      body: string,
    ) {
      if (marker.trim() === "" || body.trim() === "") {
        return yield* requestError(
          `fp milestone comment for Issue ${issueId} was empty.`,
        )
      }
      const cwd = projectOptions.projectDirectory
      const wanted = storedContent(body)
      const existing = findMarked(yield* listComments(cwd, issueId), marker)
      if (existing !== null && storedContent(existing.content) === wanted) {
        return
      }
      yield* withBodyFile(body, (path) =>
        existing === null
          ? runFpOk(
              cwd,
              ["comment", "add", issueId, "--file", path],
              `adding a milestone comment to fp issue ${issueId}`,
            )
          : runFpOk(
              cwd,
              ["comment", "update", existing.id, "--file", path],
              `updating milestone comment ${existing.id} on fp issue ${issueId}`,
            ),
      )
      const written = findMarked(yield* listComments(cwd, issueId), marker)
      if (written === null || storedContent(written.content) !== wanted) {
        return yield* requestError(
          `fp reported the milestone comment on Issue ${issueId} as written, but reading back found ${written === null ? "no comment with its marker" : "different content"}.`,
          { kind: "write_not_applied" },
        )
      }
    },
  )

  return {
    getAuthenticatedUserLogin,
    listReadyIssues,
    numberReadyIssues,
    getIssue,
    listRegisteredProjects,
    listProjectStatuses,
    checkReadiness,
    updateIssueStatus,
    ensureMilestoneComment,
  } satisfies FpServiceShape
}

/** Live layer: spawns the `fp` CLI through the platform's process spawner. */
export const FpServiceLive = Layer.effect(
  FpService,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return makeFpService({ spawner })
  }),
)
