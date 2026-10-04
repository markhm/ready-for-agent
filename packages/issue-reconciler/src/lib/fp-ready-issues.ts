import type {
  GitHubIssueReference,
  ReadyLabeledIssue,
} from "@ready-for-agent/forge-contract"
import type { FpIssue, FpIssueReference } from "@ready-for-agent/fp-service"

/**
 * The number stored for a parent or blocker that has no `rfa-number` yet
 * (ADR 0074 numbers only Issues that become Ready). Stored references need a
 * positive number, but nothing resolves them by it: parents are matched by
 * native id, and blockers are only counted, as with Linear's unreadable
 * blockers. A parent that matters, an open Ready-labeled one, is itself in
 * the Ready set and numbered before this mapping runs.
 */
const FP_UNNUMBERED_REFERENCE = 1

const reference = (issue: FpIssueReference): GitHubIssueReference => ({
  number: issue.number ?? FP_UNNUMBERED_REFERENCE,
  url: issue.url,
  nativeId: issue.nativeId,
  displayId: issue.displayId,
})

/**
 * Numbered fp Issues in the reconciler's shape. An Issue still without a
 * number (it left the project between discovery and numbering) is skipped
 * until the next refresh. fp has no pull requests of its own.
 */
export const fpReadyLabeledIssues = (
  issues: readonly FpIssue[],
): readonly ReadyLabeledIssue[] =>
  issues.flatMap((issue): ReadyLabeledIssue[] =>
    issue.number === null
      ? []
      : [
          {
            number: issue.number,
            nativeId: issue.nativeId,
            displayId: issue.displayId,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            createdAt: issue.createdAt,
            state: issue.state,
            author: issue.author,
            parent:
              issue.parent === null
                ? null
                : {
                    ...reference(issue.parent),
                    state: issue.parent.state,
                    isReadyLabeled: issue.parent.isReadyLabeled,
                  },
            parentPosition: issue.parentPosition,
            hasChildren: issue.hasChildren,
            hierarchySupported: issue.hierarchySupported,
            blockedBy: issue.blockedBy.map(reference),
            closingPullRequests: [],
          },
        ],
  )
