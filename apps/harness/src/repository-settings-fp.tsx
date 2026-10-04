import { Banner } from "./banner.js"
import { cx, ui } from "./ui.js"

export const FP_DEFAULT_IN_PROGRESS_STATUS = "in-progress"
export const FP_DEFAULT_DONE_STATUS = "done"

export type FpProjectChoice = {
  readonly name: string
  readonly path: string
  readonly orphaned: boolean
}

export type FpProjectsView =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "loaded"; readonly projects: readonly FpProjectChoice[] }

export type FpProjectDetailsView =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "not_ready"; readonly message: string }
  | {
      readonly kind: "ready"
      readonly version: string | null
      readonly workspaceSlug: string | null
      readonly statuses: readonly string[]
    }

const FP_REQUEST_FAILED = "fp request failed"

export const fpProjectsViewFromQuery = (input: {
  readonly pending: boolean
  readonly data:
    | {
        readonly available: boolean
        readonly message?: string | null
        readonly projects: readonly FpProjectChoice[]
      }
    | undefined
  readonly error: Error | null
}): FpProjectsView => {
  if (input.pending) {
    return { kind: "pending" }
  }
  if (input.data === undefined || !input.data.available) {
    return {
      kind: "unavailable",
      message: input.data?.message ?? input.error?.message ?? FP_REQUEST_FAILED,
    }
  }
  return { kind: "loaded", projects: input.data.projects }
}

export const fpProjectDetailsViewFromQuery = (input: {
  readonly projectDirectory: string
  readonly pending: boolean
  readonly data:
    | {
        readonly ready: boolean
        readonly message?: string | null
        readonly version?: string | null
        readonly workspaceSlug?: string | null
        readonly statuses: readonly string[]
      }
    | undefined
  readonly error: Error | null
}): FpProjectDetailsView => {
  if (input.projectDirectory === "") {
    return { kind: "none" }
  }
  if (input.pending) {
    return { kind: "pending" }
  }
  if (input.data === undefined || !input.data.ready) {
    return {
      kind: "not_ready",
      message: input.data?.message ?? input.error?.message ?? FP_REQUEST_FAILED,
    }
  }
  return {
    kind: "ready",
    version: input.data.version ?? null,
    workspaceSlug: input.data.workspaceSlug ?? null,
    statuses: input.data.statuses,
  }
}

/**
 * The status the settings show and save: the chosen one while the project
 * still registers it, else the fp default when the project registers that,
 * else none, so a stale or foreign status is never saved silently.
 */
export const effectiveFpStatus = (
  details: FpProjectDetailsView,
  chosen: string,
  preferred: string,
): string => {
  if (details.kind !== "ready") {
    return chosen
  }
  if (details.statuses.includes(chosen)) {
    return chosen
  }
  return details.statuses.includes(preferred) ? preferred : ""
}

const readinessLabel = (details: FpProjectDetailsView): string | null => {
  switch (details.kind) {
    case "none":
      return null
    case "pending":
      return "Checking the fp project…"
    case "not_ready":
      return `Not ready: ${details.message}`
    case "ready": {
      const version =
        details.version === null ? "Ready" : `Ready · fp ${details.version}`
      return details.workspaceSlug === null
        ? `${version} · not synced`
        : `${version} · synced to ${details.workspaceSlug}`
    }
    default: {
      const _exhaustive: never = details
      return _exhaustive
    }
  }
}

export type RepositorySettingsFpSectionProps = {
  readonly projects: FpProjectsView
  readonly projectDirectory: string
  readonly onProjectDirectoryChange: (directory: string) => void
  readonly details: FpProjectDetailsView
  readonly inProgressStatus: string
  readonly doneStatus: string
  readonly onInProgressStatusChange: (status: string) => void
  readonly onDoneStatusChange: (status: string) => void
}

/** fp settings inside the Issue Tracker section: no credential, one project. */
export function RepositorySettingsFpSection({
  projects,
  projectDirectory,
  onProjectDirectoryChange,
  details,
  inProgressStatus,
  doneStatus,
  onInProgressStatusChange,
  onDoneStatusChange,
}: RepositorySettingsFpSectionProps) {
  const choices = projects.kind === "loaded" ? projects.projects : []
  const savedIsListed = choices.some(({ path }) => path === projectDirectory)
  const statuses = details.kind === "ready" ? details.statuses : []
  const readiness = readinessLabel(details)
  const statusSelect = (
    label: string,
    value: string,
    onChange: (status: string) => void,
  ) => (
    <label className={ui.dialogField}>
      {label}
      <select
        className={ui.dialogInput}
        value={value}
        disabled={details.kind !== "ready"}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select a status</option>
        {statuses.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <>
      {projects.kind === "unavailable" && (
        <Banner className={ui.bannerCompact} tone="alarm" tag="Attention">
          fp projects could not be listed: {projects.message}
        </Banner>
      )}
      <label className={ui.dialogField}>
        fp project
        <select
          className={ui.dialogInput}
          value={projectDirectory}
          disabled={projects.kind !== "loaded"}
          onChange={(event) => onProjectDirectoryChange(event.target.value)}
        >
          <option value="">
            {projects.kind === "pending"
              ? "Loading fp projects…"
              : "Select a project"}
          </option>
          {choices.map((project) => (
            <option
              key={project.path}
              value={project.path}
              disabled={project.orphaned}
            >
              {project.orphaned
                ? `${project.name} (folder missing)`
                : project.name}
            </option>
          ))}
          {projectDirectory !== "" && !savedIsListed && (
            <option value={projectDirectory}>{projectDirectory}</option>
          )}
        </select>
        {projectDirectory !== "" && (
          <span className={cx(ui.dialogFieldHint, ui.dialogInputMono)}>
            {projectDirectory}
          </span>
        )}
        {readiness !== null && (
          <span className={ui.dialogFieldHint}>{readiness}</span>
        )}
      </label>
      {statusSelect("In Progress", inProgressStatus, onInProgressStatusChange)}
      {statusSelect("Done", doneStatus, onDoneStatusChange)}
      <span className={ui.dialogFieldHint}>
        fp needs no credential: the harness uses the fp CLI on this machine.
        Open Issues still need the ready-for-agent label.
      </span>
    </>
  )
}
