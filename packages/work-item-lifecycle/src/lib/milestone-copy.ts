/**
 * Milestone comment prose shared by the tracker-only Issue Trackers. Each
 * comment ends with the tracker's marker on a line of its own, which is how
 * a retry finds and updates the comment instead of adding another.
 */
const commentBody = (prose: readonly string[], marker: string): string =>
  `${prose.filter((line) => line.length > 0).join("\n")}\n\n${marker}`

export const workStartedComment = (workItemId: string, marker: string) =>
  commentBody(
    [
      "Ready for Agent started implementation for this Issue.",
      `Work Item ${workItemId}.`,
    ],
    marker,
  )

export const pullRequestComment = (pullRequestUrl: string, marker: string) =>
  commentBody(
    [
      "Ready for Agent opened a GitHub pull request for this Issue:",
      pullRequestUrl,
    ],
    marker,
  )

export const humanAttentionComment = (reason: string, marker: string) =>
  commentBody(
    [
      "Ready for Agent needs human attention:",
      reason.trim() === ""
        ? "A human decision is required to continue."
        : reason.trim(),
    ],
    marker,
  )

export const completionComment = (summary: string, marker: string) =>
  commentBody([summary.trim()], marker)
