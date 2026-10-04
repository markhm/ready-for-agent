import {
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
} from "../src/lib/fp-cli-output.js"
import { describe, expect, test } from "bun:test"

// Transcripts captured from fp 0.25.0 (d818046) on 2026-09-22.

const LIST_OUTPUT = JSON.stringify({
  issues: [
    {
      id: "sxflialvmviogismmsczmwrvnsdbpnrb",
      shortId: "sxflialv",
      title: "fp tracker 4: execution",
      description: "Plan section 4, item 4.",
      status: "todo",
      priority: "high",
      parent: "qnijsazsvqabyjjrappukabhccvtodey",
      dependencies: [
        "peomwupiocfoiirgpjolwhfohsczfsde",
        "xfuurawudexxmdrstcwirfnxyohgyzsz",
      ],
      createdAt: "2026-09-20T16:11:26.316Z",
      updatedAt: "2026-09-22T05:55:48.990Z",
    },
    {
      id: "qnijsazsvqabyjjrappukabhccvtodey",
      shortId: "qnijsazs",
      title: "Epic",
      description: "",
      status: "todo",
      priority: "high",
      parent: null,
      dependencies: [],
      createdAt: "2026-09-08T07:07:50.896Z",
      updatedAt: "2026-09-22T07:00:00.000Z",
    },
  ],
})

// fp 0.25.0 (a381766), captured 2026-10-04 from scratch projects with the
// rfa-number extension: the first two from one project, the third (an Issue
// with no properties set) from an earlier probe the same day.
const LIST_OUTPUT_WITH_PROPERTIES = `{
  "issues": [
    {
      "id": "mvgclaogbqkdygwpfzcqtwxxaxitmcve",
      "shortId": "mvgclaog",
      "title": "A",
      "description": "",
      "status": "todo",
      "priority": null,
      "parent": null,
      "dependencies": [],
      "createdAt": "2026-10-04T18:47:55.827Z",
      "updatedAt": "2026-10-04T18:47:58.087Z",
      "properties": {
        "labels": [
          "ready-for-agent"
        ],
        "rfa-number": "3"
      }
    },
    {
      "id": "ikuqlrgaavpgqwjrwmulpbukipykahhw",
      "shortId": "ikuqlrga",
      "title": "B",
      "description": "",
      "status": "todo",
      "priority": null,
      "parent": null,
      "dependencies": [],
      "createdAt": "2026-10-04T18:47:56.113Z",
      "updatedAt": "2026-10-04T18:47:57.275Z",
      "properties": {
        "rfa-number": "2",
        "labels": [
          "ready-for-agent"
        ]
      }
    },
    {
      "id": "obwfqqhubdrcymnultskhqgxlmzxgupr",
      "shortId": "obwfqqhu",
      "title": "C",
      "description": "",
      "status": "todo",
      "priority": null,
      "parent": null,
      "dependencies": [],
      "createdAt": "2026-10-04T16:09:54.586Z",
      "updatedAt": "2026-10-04T16:09:54.586Z",
      "properties": {}
    }
  ]
}`

const SHOW_OUTPUT = JSON.stringify({
  id: "sxflialvmviogismmsczmwrvnsdbpnrb",
  displayId: "RFA-sxflialv",
  title: "fp tracker 4: execution",
  description: "Plan section 4, item 4.",
  status: "todo",
  priority: "high",
  parent: "qnijsazsvqabyjjrappukabhccvtodey",
  dependencies: [
    "peomwupiocfoiirgpjolwhfohsczfsde",
    "xfuurawudexxmdrstcwirfnxyohgyzsz",
  ],
  revisions: [],
  author: "github@hissinkmuller.nl",
  createdAt: "2026-09-20T16:11:26.316Z",
  updatedAt: "2026-09-22T05:55:48.990Z",
  properties: { labels: ["fp-tracker"] },
  comments: [
    {
      id: "c1",
      author: "a",
      content: "x",
      createdAt: "2026-09-22T00:00:00.000Z",
    },
  ],
})

const AUTH_STATUS_OUTPUT = `✓ Token valid

  Source: /Users/mark/.fiberplane/credentials.toml
  Token: YMQvNYBH...

  Name: Mark HM
  Email: github@hissinkmuller.nl

`

describe("fp issue list parsing", () => {
  test("reads the wrapped issues array with parent and dependencies", () => {
    const issues = parseFpIssueList(LIST_OUTPUT)
    expect(issues.map((issue) => issue.shortId)).toEqual([
      "sxflialv",
      "qnijsazs",
    ])
    expect(issues[0]?.parent).toBe("qnijsazsvqabyjjrappukabhccvtodey")
    expect(issues[0]?.dependencies).toHaveLength(2)
    expect(issues[1]?.parent).toBeNull()
  })

  test("list output of builds before a381766 carries no properties", () => {
    const issues = parseFpIssueList(LIST_OUTPUT)
    expect(issues[0]?.properties).toBeUndefined()
  })

  test("reads labels and the rfa-number from list properties (build a381766)", () => {
    const issues = parseFpIssueList(LIST_OUTPUT_WITH_PROPERTIES)
    expect(issues.map(fpIssueLabels)).toEqual([
      ["ready-for-agent"],
      ["ready-for-agent"],
      [],
    ])
    expect(issues.map(fpIssueNumber)).toEqual([
      { kind: "number", number: 3 },
      { kind: "number", number: 2 },
      { kind: "none" },
    ])
  })

  test("rejects output that is not the list shape", () => {
    expect(() => parseFpIssueList("[]")).toThrow()
    expect(() => parseFpIssueList("not json")).toThrow()
  })
})

describe("fp rfa-number property", () => {
  const withNumber = (raw: string | null | undefined) =>
    parseFpIssueList(
      JSON.stringify({
        issues: [
          {
            id: "a".repeat(32),
            shortId: "aaaaaaaa",
            title: "A",
            status: "todo",
            createdAt: "2026-10-04T18:47:55.827Z",
            updatedAt: "2026-10-04T18:47:58.087Z",
            properties: raw === undefined ? {} : { "rfa-number": raw },
          },
        ],
      }),
    )[0] as Parameters<typeof fpIssueNumber>[0]

  test("absent, null and empty are no number", () => {
    for (const raw of [undefined, null, ""]) {
      expect(fpIssueNumber(withNumber(raw))).toEqual({ kind: "none" })
    }
  })

  test("a positive integer is the number", () => {
    expect(fpIssueNumber(withNumber("1"))).toEqual({
      kind: "number",
      number: 1,
    })
    expect(fpIssueNumber(withNumber("1500"))).toEqual({
      kind: "number",
      number: 1500,
    })
  })

  test("anything else is invalid, not none, so it is never overwritten", () => {
    for (const raw of [
      "0",
      "-3",
      "07",
      "1.5",
      "12a",
      " 4",
      "99999999999999999999",
    ]) {
      expect(fpIssueNumber(withNumber(raw))).toEqual({ kind: "invalid", raw })
    }
  })
})

describe("fp issue show parsing", () => {
  test("reads display id, author and labels", () => {
    const issue = parseFpIssueShow(SHOW_OUTPUT)
    expect(issue.displayId).toBe("RFA-sxflialv")
    expect(issue.author).toBe("github@hissinkmuller.nl")
    expect(fpIssueLabels(issue)).toEqual(["fp-tracker"])
  })

  test("treats absent or null labels as none", () => {
    const withoutProperties = parseFpIssueShow(
      JSON.stringify({
        id: "a".repeat(32),
        displayId: "RFA-aaaaaaaa",
        title: "t",
        status: "todo",
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      }),
    )
    expect(fpIssueLabels(withoutProperties)).toEqual([])
    const nullLabels = parseFpIssueShow(
      JSON.stringify({
        id: "a".repeat(32),
        displayId: "RFA-aaaaaaaa",
        title: "t",
        status: "todo",
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
        properties: { labels: null },
      }),
    )
    expect(fpIssueLabels(nullLabels)).toEqual([])
  })
})

describe("fp auth status parsing", () => {
  test("extracts the operator email and name", () => {
    expect(parseFpAuthStatus(AUTH_STATUS_OUTPUT)).toEqual({
      name: "Mark HM",
      email: "github@hissinkmuller.nl",
    })
  })

  test("returns null without an Email line", () => {
    expect(parseFpAuthStatus("Not logged in\n")).toBeNull()
  })
})

// Captured from `fp project remote --format json` on fp 0.25.0, 2026-09-22.
const PROJECT_REMOTE_OUTPUT = JSON.stringify({
  projectId: "maj1jnV31wzqoUjtAXNMd",
  workspaceSlug: "markhm-jcVg",
  serverUrl: "https://app.fp.dev",
  linkedAt: "2026-09-21T06:17:07.152Z",
  lastSyncedAt: "2026-09-22T11:12:06.121Z",
})

describe("fp project remote parsing", () => {
  test("reads the workspace slug and remote project id of a linked project", () => {
    expect(parseFpProjectRemote(PROJECT_REMOTE_OUTPUT)).toEqual({
      workspaceSlug: "markhm-jcVg",
      projectId: "maj1jnV31wzqoUjtAXNMd",
    })
  })

  test("rejects the unlinked project's prose, which fp prints with exit 1", () => {
    expect(() =>
      parseFpProjectRemote(
        "Project not linked to remote\n  Suggestion: No local project is registered here and no remote identity was found.\n",
      ),
    ).toThrow()
  })
})

describe("fp version parsing", () => {
  test("reads the semantic version before the commit hash", () => {
    expect(parseFpVersion("0.25.0 (d818046)\n")).toBe("0.25.0")
    expect(parseFpVersion("garbage")).toBeNull()
  })
})

describe("fp failure classification", () => {
  test("recognises the three messages fp prints on 0.25.0", () => {
    expect(
      classifyFpFailure(
        ".fp directory not found\n  Suggestion: Run 'fp init' to initialize a project\n",
      ),
    ).toBe("project_not_registered")
    expect(
      classifyFpFailure(
        "This path is not registered with fp, but there are issues stored for 1 other location:\n",
      ),
    ).toBe("project_not_registered")
    expect(
      classifyFpFailure(
        "Issue nope not found\n  Suggestion: Run 'fp issue list' to see available issues\n",
      ),
    ).toBe("issue_not_found")
    expect(
      classifyFpFailure(
        'Invalid status: Status "todo,selected" is not in the registered options.\n',
      ),
    ).toBe("invalid_status")
    expect(classifyFpFailure("segfault")).toBe("unknown")
  })

  test("recognises a property the project does not register (captured 2026-10-04, stderr)", () => {
    expect(
      classifyFpFailure(
        "Invalid value for extension property 'rfa-number': Property is not registered\n",
      ),
    ).toBe("property_not_registered")
  })

  test("recognises a comment that no longer exists", () => {
    expect(
      classifyFpFailure(
        "Comment 00000000-0000-0000-0000-000000000000 not found\n  Suggestion: Run 'fp comment list <issue-id>' to see available comments\n",
      ),
    ).toBe("comment_not_found")
  })
})

// Captured from `fp comment list <id> --format json` on fp 0.25.0 (d818046),
// 2026-09-22: newest comment first, wrapped in `{ "comments": [...] }`.
const COMMENT_LIST_OUTPUT = JSON.stringify({
  comments: [
    {
      id: "85d226d1-1b2a-4f90-9e4c-e107cf90532c",
      issueId: "pcunulenyfmmijjvhqpxetdiizkrbpbc",
      author: "github@hissinkmuller.nl",
      content:
        "ready-for-agent:work-started:wi-123\n\n- body starts with a dash\nline two `code`",
      createdAt: "2026-09-22T13:55:13.224Z",
    },
    {
      id: "f3bfd763-9e57-440f-9eed-47d77946bdff",
      issueId: "pcunulenyfmmijjvhqpxetdiizkrbpbc",
      author: "github@hissinkmuller.nl",
      content: "an earlier comment",
      createdAt: "2026-09-22T12:26:42.715Z",
    },
  ],
})

describe("fp comment list parsing", () => {
  test("reads comment ids and content, newest first as fp prints them", () => {
    const comments = parseFpCommentList(COMMENT_LIST_OUTPUT)
    expect(comments.map((comment) => comment.id)).toEqual([
      "85d226d1-1b2a-4f90-9e4c-e107cf90532c",
      "f3bfd763-9e57-440f-9eed-47d77946bdff",
    ])
    expect(comments[0]?.content).toBe(
      "ready-for-agent:work-started:wi-123\n\n- body starts with a dash\nline two `code`",
    )
  })

  test("an Issue without comments parses to an empty list", () => {
    expect(parseFpCommentList('{"comments":[]}')).toEqual([])
  })
})

// Captured from fp 0.25.0 (d818046) on 2026-09-26.
const PROJECT_LIST_OUTPUT = [
  "",
  "Registered projects:",
  "",
  "  maintainability-cloud",
  "    Path:    /Users/op/git/maintainability-cloud",
  "    Storage: /Users/op/.fiberplane/projects/maintainability-cloud-4ab7f7fd/",
  "",
  "  market-analysis (orphaned)",
  "    Path:    /Users/op/git/markhm/market-analysis",
  "    Storage: /Users/op/.fiberplane/projects/market-analysis-52d0d938/",
  "",
  "  ready-for-agent",
  "    Path:    /Users/op/git/berenddeboer/ready-for-agent",
  "    Storage: /Users/op/.fiberplane/projects/ready-for-agent-276de401/",
  "",
].join("\n")

describe("parseFpProjectList", () => {
  test("reads each registered project's name, folder and orphaned mark", () => {
    expect(parseFpProjectList(PROJECT_LIST_OUTPUT)).toEqual([
      {
        name: "maintainability-cloud",
        path: "/Users/op/git/maintainability-cloud",
        orphaned: false,
      },
      {
        name: "market-analysis",
        path: "/Users/op/git/markhm/market-analysis",
        orphaned: true,
      },
      {
        name: "ready-for-agent",
        path: "/Users/op/git/berenddeboer/ready-for-agent",
        orphaned: false,
      },
    ])
  })

  test("an empty registry is an empty list", () => {
    expect(parseFpProjectList("\nRegistered projects:\n\n")).toEqual([])
  })

  test("output without the header is not a project list", () => {
    expect(() => parseFpProjectList("Unknown argument: list\n")).toThrow()
  })
})

// Captured from fp 0.25.0 (d818046) on 2026-09-26, in the MC project and in
// a folder outside any project.
const GUIDE_OUTPUT = [
  "## Project context",
  "- Prefix: MC",
  "- Registered statuses (in order): todo, selected, in-progress, done, deferred, rejected",
  "  - Default for new issues: todo",
  '  - Counts as "current": selected, in-progress, done, deferred  [auto]',
  "- Other registered properties: labels (multiselect), workstation (select)",
  "- Loaded extensions: labels, workflow",
  "",
].join("\n")
const GUIDE_OUTSIDE_PROJECT = [
  "## Project context",
  "- Not in an fp project. Run `fp init` first.",
  "",
].join("\n")

describe("parseFpRegisteredProperties", () => {
  test("reads the property keys without their kinds", () => {
    expect(parseFpRegisteredProperties(GUIDE_OUTPUT)).toEqual([
      "labels",
      "workstation",
    ])
  })

  test("sees rfa-number where its extension is loaded (captured 2026-10-04)", () => {
    expect(
      parseFpRegisteredProperties(
        "- Other registered properties: labels (multiselect), rfa-number (text)\n- Loaded extensions: labels, rfa-number\n",
      ),
    ).toEqual(["labels", "rfa-number"])
  })

  test("a guide without the line registers no properties", () => {
    expect(parseFpRegisteredProperties(GUIDE_OUTSIDE_PROJECT)).toEqual([])
  })
})

describe("parseFpRegisteredStatuses", () => {
  test("reads the registered statuses in fp's order", () => {
    expect(parseFpRegisteredStatuses(GUIDE_OUTPUT)).toEqual([
      "todo",
      "selected",
      "in-progress",
      "done",
      "deferred",
      "rejected",
    ])
  })

  test("outside a project there are no statuses", () => {
    expect(parseFpRegisteredStatuses(GUIDE_OUTSIDE_PROJECT)).toBeNull()
  })

  test("output with neither is unreadable", () => {
    expect(() => parseFpRegisteredStatuses("## Something else\n")).toThrow()
  })
})
