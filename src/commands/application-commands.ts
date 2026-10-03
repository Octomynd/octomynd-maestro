import fs from "node:fs";
import path from "node:path";
import {
  FeaturePlanIntegrationDetails,
  FeaturePlanDetails,
  FeaturePlanWriteResult,
  FeatureRecord,
  ImprovementProposalRecord,
  ImprovementStatus,
  MaestroDatabase,
  ProjectRecord,
  SkillEvaluationRecord,
  SkillProposalRecord,
  SkillProposalStatus,
  SkillVersionRecord,
  SkillCuratorCandidateRecord,
  SkillCuratorCandidateStatus,
  TaskRecord,
  TaskLogs
} from "../db.js";
import { FeatureGitHubGateway, GhFeatureGateway } from "../features/github.js";
import { FeatureIntegrationBuilder, WorkPullRequestGateway } from "../features/integration.js";
import {
  bootstrapEmptyRepository,
  cloneGitRepository,
  createGitWorktree,
  createWorktreePlan,
  detectGitDefaultBranch,
  ensureGitRemoteOrigin,
  hasAnyCommit,
  validateGitProject
} from "../git.js";
import { redactSensitiveText, sanitizePublicMetadata, truncateForDisplay } from "../security/redaction.js";
import { ApplicationCommandError, conflictError, notFoundError, validationError } from "./errors.js";
import { CommandOrigin } from "./types.js";
import type { WorkGraphDetails } from "../work-graphs/types.js";
import type { FeatureTaskContractInput } from "../features/task-graph.js";
import { prepareFeatureTaskBaseline } from "../features/task-baseline.js";
import { deriveTaskIntake } from "../tasks/intake.js";
import {
  revalidateQueuedFeaturePlans,
  revalidateQueuedFeaturePlansWithAudit
} from "../features/task-scheduler.js";
import { SkillLifecycleService, suggestSkillProposalQualifiedName, type SkillLifecycleRuntime } from "../skills/lifecycle.js";
import type { SkillCuratorReport } from "../skills/curator.js";
import type { FeatureCoordinator, ManualReviewResult, ManualReviewStatusResult } from "../features/coordinator.js";
import { ProjectRepositoryService, RepositorySyncError } from "../projects/repository-service.js";
import {
  classifyWorkIntake,
  computeWorkIntakeId,
  explainWorkIntakeDecision,
  WorkIntakeClassification,
  WorkIntakeCoordinationSignal,
  WorkIntakeCostEstimate,
  WorkIntakeDecision,
  WorkIntakeInput
} from "../intake/index.js";

export type RegisterProjectInput = {
  key: string;
  path?: string;
  remoteUrl?: string;
  name?: string;
  defaultBranch?: string;
  description?: string;
  mode?: "github" | "localremote" | "local";
};

export type RegisterProjectOutcome = {
  project: ProjectRecord;
  warnings: string[];
};

export type CreateTaskInput = {
  text: string;
  projectKey?: string | null;
  title?: string | null;
  specification?: string | null;
  workspaceWriteApproved?: boolean;
};

export type CreateFollowUpTaskInput = {
  parentTaskId: number;
  text: string;
  workspaceWriteApproved?: boolean;
};

export type WorkIntakeCommandInput = {
  projectKey?: string | null;
  objective: string;
  acceptanceCriteria?: string[];
  coordination?: Partial<WorkIntakeCoordinationSignal>;
  costEstimate?: Partial<WorkIntakeCostEstimate>;
  explicitOverride?: WorkIntakeClassification | null;
  intakeId?: string;
  workspaceWriteApproved?: boolean;
};

export type WorkIntakeCommandResult = {
  status: "created" | "already_created" | "needs_clarification";
  createdType: "task" | "feature_plan" | "none";
  task?: TaskRecord;
  featurePlan?: FeaturePlanDetails;
  writeResult?: FeaturePlanWriteResult;
  decision: WorkIntakeDecision;
  explanation: string;
};

export type CreateFeaturePlanInput = {
  projectKey: string;
  objective: string;
  acceptanceCriteria: string[];
  taskIds?: number[];
  taskContracts?: FeatureTaskContractInput[];
  priority?: number;
  dependsOnFeaturePlanIds?: number[];
  featureIssueNumber?: number | null;
  taskIssueNumbers?: Record<number, number>;
  idempotencyKey?: string | null;
  workIntakeId?: string | null;
  workIntakeDecisionId?: string | null;
  classification?: string | null;
  reasonCode?: string | null;
};

export type ReplanFeaturePlanInput = {
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  taskContracts?: FeatureTaskContractInput[];
  idempotencyKey?: string | null;
};

export type PrepareTaskOutcome = {
  task: TaskRecord;
  branchName: string;
  worktreePath: string;
};

export type ImprovementDecisionOutcome = {
  improvement: ImprovementProposalRecord;
  task: TaskRecord | null;
  featurePlan: FeaturePlanDetails | null;
};

export type WorkGraphRuntimeCommands = {
  cancel(origin: CommandOrigin, workGraphId: number, reason?: string | null): Promise<WorkGraphDetails>;
};

export type WorkGraphAttemptView = {
  attemptNumber: number;
  provider: string;
  status: string;
  durationMs: number | null;
  summary: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type WorkGraphNodeView = WorkGraphDetails["nodes"][number] & {
  objective: string;
  writeScope: string[];
  lastError: string | null;
  attempts: WorkGraphAttemptView[];
  fallbackCount: number;
};

export type WorkGraphAdoptionView = {
  mode: string;
  decision: string;
  reason: string;
  executionMode: string;
  automaticFanOut: boolean;
  telemetry: unknown;
};

export type WorkGraphArtifactView = {
  nodeId: number;
  key: string;
  kind: string;
  summary: string;
  contentHash: string | null;
  bytes: number;
};

export type WorkGraphCanaryEvidence = {
  durationMs: number;
  estimatedTokens: number;
  attempts: number;
  fallbacks: number;
  conflicts: number;
  quality: "passed" | "degraded" | "blocked" | "cancelled" | "pending";
};

export type WorkGraphView = Omit<WorkGraphDetails, "nodes" | "objective"> & {
  taskId: number;
  projectKey: string | null;
  objective: string;
  adoption: WorkGraphAdoptionView | null;
  nodes: WorkGraphNodeView[];
  artifacts: WorkGraphArtifactView[];
  artifactCount: number;
  artifactBytes: number;
  canary: WorkGraphCanaryEvidence;
  cancellable: boolean;
};

const WORK_GRAPH_DISPLAY_LIMIT = 500;

function publicText(value: string): string {
  const redacted = redactSensitiveText(value)
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[REDACTED_LOCAL_PATH]")
    .replace(
      /(^|[\s"'(])\/(?:tmp|var|opt|srv|mnt|home|Users)\/[^\s"',)]+/g,
      "$1[REDACTED_LOCAL_PATH]"
    );
  return truncateForDisplay(redacted, WORK_GRAPH_DISPLAY_LIMIT);
}

function publicScope(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return path.isAbsolute(value) || normalized.split("/").includes("..")
    ? "[REDACTED_LOCAL_PATH]"
    : publicText(normalized);
}

function publicArtifactKey(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return path.isAbsolute(value) || normalized.split("/").includes("..")
    ? "[REDACTED_ARTIFACT_KEY]"
    : publicText(normalized);
}

/**
 * Normalize a remote git URL for comparison (strip trailing slash, scheme case,
 * and any `git@`/`ssh://` prefix differences) so two strings that denote the
 * same repository compare equal.
 */
function normalizeRemoteUrl(value: string): string {
  return (value || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase()
    .replace(/^ssh:\/\//, "")
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "");
}

function adoptionView(metadata: Record<string, unknown>): WorkGraphAdoptionView {
  return {
    mode: String(metadata.mode ?? "unknown"),
    decision: String(metadata.decision ?? "unknown"),
    reason: publicText(String(metadata.reason ?? "unknown")),
    executionMode: String(metadata.executionMode ?? "unknown"),
    automaticFanOut: metadata.automaticFanOut === true,
    telemetry: sanitizePublicMetadata(metadata.telemetry ?? {})
  };
}

export class ApplicationCommands {
  private readonly skillLifecycleService?: SkillLifecycleService;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly featureGithub: FeatureGitHubGateway = new GhFeatureGateway(),
    private readonly workGraphRuntime?: WorkGraphRuntimeCommands,
    skillLifecycle?: SkillLifecycleRuntime,
    private readonly featureCoordinator?: FeatureCoordinator,
    private readonly projectsRoot?: string,
    private readonly repositoryService: ProjectRepositoryService = new ProjectRepositoryService(database)
  ) {
    this.skillLifecycleService = skillLifecycle
      ? new SkillLifecycleService(database, skillLifecycle)
      : undefined;
  }

  async triggerFeatureReview(
    origin: CommandOrigin,
    targetInput: string,
    isRetry = false
  ): Promise<ManualReviewResult> {
    const feature = this.database.findFeatureByTarget(targetInput);
    if (!feature) {
      throw notFoundError("Feature PR not found for the specified target.");
    }
    if (!this.featureCoordinator) {
      throw validationError("Feature Coordinator unavailable.");
    }
    return this.featureCoordinator.triggerManualReview(feature.id, isRetry);
  }

  async getFeatureReviewStatus(
    origin: CommandOrigin,
    targetInput: string
  ): Promise<ManualReviewStatusResult> {
    const feature = this.database.findFeatureByTarget(targetInput);
    if (!feature) {
      throw notFoundError("Feature PR not found for the specified target.");
    }
    if (!this.featureCoordinator) {
      throw validationError("Feature Coordinator unavailable.");
    }
    return this.featureCoordinator.getReviewStatus(feature.id);
  }

  registerProject(
    origin: CommandOrigin,
    input: RegisterProjectInput,
    overrideProjectsRoot?: string
  ): RegisterProjectOutcome {
    const warnings: string[] = [];

    if (!input.key || typeof input.key !== "string") {
      throw validationError("Project key is required.");
    }

    const rawKey = input.key.trim().replace(/^@+/, "");
    const key = rawKey.toLowerCase();

    if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(key)) {
      throw validationError("Project key must use 2-49 chars: lowercase letters, numbers, underscore or dash.");
    }

    const remoteUrl = input.remoteUrl?.trim() || undefined;
    const isRemoteClone = Boolean(remoteUrl && !input.path) || input.mode === "github";
    let projectPath: string;

    if (isRemoteClone) {
      if (!remoteUrl) {
        throw validationError("Remote repository URL is required for remote cloning.");
      }
      const root = overrideProjectsRoot ?? this.projectsRoot ?? path.resolve(process.cwd(), "worktrees", "projects");
      projectPath = path.resolve(path.join(root, key));

      if (!fs.existsSync(projectPath)) {
        const cloneResult = cloneGitRepository(remoteUrl, projectPath, input.defaultBranch?.trim());
        if (!cloneResult.ok) {
          throw validationError(
            `Failed to clone remote repository: ${cloneResult.stderr || cloneResult.stdout || "Unknown error"}`
          );
        }
        const bootstrap = bootstrapEmptyRepository(projectPath, key, { push: false });
        if (bootstrap.bootstrapped) {
          warnings.push("Empty repository: Maestro created the initial commit (README + .gitignore) locally; no branch was published.");
          this.database.addEvent({
            source: origin.channel,
            type: "project.bootstrapped",
            text: `Initial commit created by Maestro for @${key} (empty remote repository).`,
            userId: origin.userId ?? null,
            username: origin.username ?? null
          });
        } else if (!bootstrap.ok) {
          warnings.push(`Repository needs attention before Maestro tasks can run: ${bootstrap.error}`);
        }
      } else if (!fs.existsSync(path.join(projectPath, ".git"))) {
        throw validationError(`Path already exists and is not a Git repository: ${projectPath}`);
      } else {
        // The clone already exists; verify its origin matches the requested URL so
        // re-registration does not silently point at a different repository.
        const existing = ensureGitRemoteOrigin(projectPath, remoteUrl);
        if (existing.error) {
          throw validationError(`Could not confirm remote origin: ${existing.error}`);
        }
        if (existing.existingUrl && normalizeRemoteUrl(existing.existingUrl) !== normalizeRemoteUrl(remoteUrl)) {
          warnings.push(
            `Existing clone at ${projectPath} uses origin ${existing.existingUrl}, which differs from requested ${remoteUrl}; reusing the existing clone.`
          );
        }
      }
    } else {
      if (!input.path || !input.path.trim()) {
        throw validationError("Path is required when not cloning from a remote repository.");
      }
      projectPath = path.resolve(input.path.trim());

      if (!fs.existsSync(projectPath)) {
        throw validationError(`Path does not exist: ${projectPath}`);
      }
      if (!fs.statSync(projectPath).isDirectory()) {
        throw validationError(`Path is not a directory: ${projectPath}`);
      }
      if (!fs.existsSync(path.join(projectPath, ".git"))) {
        warnings.push("Path exists, but .git was not found. Future Git automation will be blocked.");
      } else {
        const bootstrap = bootstrapEmptyRepository(projectPath, key, { push: false });
        if (bootstrap.bootstrapped) {
          warnings.push("Empty repository: Maestro created the initial commit (README + .gitignore) locally; no branch was published.");
          this.database.addEvent({
            source: origin.channel,
            type: "project.bootstrapped",
            text: `Initial commit created by Maestro for @${key} (empty local repository).`,
            userId: origin.userId ?? null,
            username: origin.username ?? null
          });
        } else if (!bootstrap.ok) {
          warnings.push(`Repository needs attention before Maestro tasks can run: ${bootstrap.error}`);
        }
        if (remoteUrl) {
          const remoteResult = ensureGitRemoteOrigin(projectPath, remoteUrl);
          if (remoteResult.error) {
            warnings.push(`Could not configure remote origin: ${remoteResult.error}`);
          } else if (remoteResult.added) {
            warnings.push(`Configured remote origin pointing to ${remoteUrl}.`);
          } else if (remoteResult.existingUrl && normalizeRemoteUrl(remoteResult.existingUrl) !== normalizeRemoteUrl(remoteUrl)) {
            warnings.push(
              `Local repo at ${projectPath} already has origin ${remoteResult.existingUrl}, which differs from requested ${remoteUrl}; keeping the existing origin.`
            );
          }
        }
      }
    }

    let defaultBranch = input.defaultBranch?.trim();
    if (!defaultBranch) {
      if (fs.existsSync(path.join(projectPath, ".git"))) {
        defaultBranch = detectGitDefaultBranch(projectPath) ?? "main";
      } else {
        defaultBranch = "main";
      }
    }

    const name = input.name?.trim() || key;

    let project: ProjectRecord;
    try {
      project = this.database.registerProject({
        key,
        name,
        path: projectPath,
        defaultBranch
      });
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "Unknown project error.");
    }

    try {
      // Registration must remain responsive even when a local repository's
      // remote is offline. The authoritative fetch happens before task
      // preparation (and in project-scoped Chat); here we record the local
      // checkout and any cached remote-tracking state without network I/O.
      const sync = this.repositoryService.inspect(project, false);
      project = this.database.getProjectByKey(project.key);
      if (sync.syncState !== "current" && sync.syncState !== "local_only" && sync.syncState !== "local_ahead") {
        warnings.push(sync.detail ?? `Repository synchronization state: ${sync.syncState}.`);
      }
    } catch (error) {
      const message = error instanceof RepositorySyncError
        ? error.message
        : error instanceof Error ? error.message : "Repository synchronization failed.";
      warnings.push(`Repository needs attention before Maestro tasks can run: ${message}`);
      project = this.database.getProjectByKey(project.key);
    }

    this.database.addEvent({
      source: origin.channel,
      type: "project.registered",
      text: project.key,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      metadata: {
        projectKey: project.key,
        defaultBranch: project.defaultBranch,
        warnings,
        remoteUrl: remoteUrl ?? null,
        mode: input.mode ?? (isRemoteClone ? "github" : remoteUrl ? "localremote" : "local")
      }
    });

    return { project, warnings };
  }

  createTask(origin: CommandOrigin, input: CreateTaskInput): TaskRecord {
    const text = input.text.trim();
    if (!text) {
      throw validationError("Task text is required.");
    }

    const projectKey = input.projectKey?.trim().toLowerCase() || null;
    const project = projectKey ? this.database.findProjectByKey(projectKey) : this.database.getDefaultProject();

    if (projectKey && !project) {
      throw notFoundError(`Project not found: ${projectKey}`);
    }
    if (!project) {
      throw notFoundError("No project registered.");
    }

    const intake = deriveTaskIntake(text, {
      title: input.title ?? undefined,
      specification: input.specification ?? undefined
    });
    const task = this.database.createTask(text, origin.channel, project.key, null, intake.title, intake.specification);
    this.recordWorkspaceWriteApproval(origin, task.id, input.workspaceWriteApproved);

    this.database.addEvent({
      source: origin.channel,
      type: "task.created",
      text,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: task.id,
      metadata: { projectKey: project.key }
    });

    return task;
  }

  createFollowUpTask(origin: CommandOrigin, input: CreateFollowUpTaskInput): TaskRecord {
    const text = input.text.trim();
    if (!text) {
      throw validationError("Follow-up task text is required.");
    }

    let parent: TaskRecord;
    try {
      parent = this.database.getTask(input.parentTaskId);
    } catch {
      throw notFoundError(`Task not found: ${input.parentTaskId}`);
    }
    if (!parent.projectKey) {
      throw conflictError(`Task #${parent.id} is not attached to a project.`);
    }

    const intake = deriveTaskIntake(text);
    const task = this.database.createTask(text, origin.channel, parent.projectKey, parent.id, intake.title, intake.specification);
    this.recordWorkspaceWriteApproval(origin, task.id, input.workspaceWriteApproved);
    this.database.addEvent({
      source: origin.channel,
      type: "task.follow_up_created",
      text,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: task.id,
      metadata: {
        projectKey: parent.projectKey,
        parentTaskId: parent.id,
        sourceTaskId: parent.id
      }
    });
    return task;
  }

  getTaskLogs(origin: CommandOrigin, taskId: number): TaskLogs {
    try {
      this.database.getTask(taskId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Task not found: ${taskId}`);
    }
    return this.database.getTaskLogs(taskId);
  }

  previewWorkIntake(
    origin: CommandOrigin,
    input: WorkIntakeCommandInput
  ): { decision: WorkIntakeDecision; explanation: string } {
    const text = input.objective.trim();
    if (!text) {
      throw validationError("Objective is required.");
    }

    const projectKey = input.projectKey?.trim().toLowerCase() || null;
    const project = projectKey ? this.database.findProjectByKey(projectKey) : this.database.getDefaultProject();
    if (projectKey && !project) {
      throw notFoundError(`Project not found: ${projectKey}`);
    }

    const intakeId = computeWorkIntakeId({
      ...input,
      channel: origin.channel,
      userId: origin.userId ?? undefined,
      projectKey: project?.key
    });

    const decision = classifyWorkIntake({
      ...input,
      id: intakeId,
      projectKey: project?.key
    });

    this.database.saveWorkIntakeDecision(decision);
    const explanation = explainWorkIntakeDecision(decision);

    return { decision, explanation };
  }

  submitWorkIntake(
    origin: CommandOrigin,
    input: WorkIntakeCommandInput
  ): WorkIntakeCommandResult {
    const text = input.objective.trim();
    if (!text) {
      throw validationError("Objective is required.");
    }

    const projectKey = input.projectKey?.trim().toLowerCase() || null;
    const project = projectKey ? this.database.findProjectByKey(projectKey) : this.database.getDefaultProject();

    if (projectKey && !project) {
      throw notFoundError(`Project not found: ${projectKey}`);
    }
    if (!project) {
      throw notFoundError("No project registered.");
    }

    const intakeId = input.intakeId?.trim() || computeWorkIntakeId({
      ...input,
      channel: origin.channel,
      userId: origin.userId ?? undefined,
      projectKey: project.key
    });

    // F3: durable idempotency via the work_intake_submissions table. The old
    // scheme scanned listEvents(200) and silently duplicated once the window
    // rolled over.
    const existingSubmission = this.database.findWorkIntakeSubmission(intakeId);
    if (existingSubmission) {
      const task = existingSubmission.taskId ? this.database.getTask(existingSubmission.taskId) : undefined;
      const featurePlan = existingSubmission.featurePlanId
        ? this.database.getFeaturePlanDetails(existingSubmission.featurePlanId)
        : undefined;
      if (task || featurePlan) {
        if (task) this.recordWorkspaceWriteApproval(origin, task.id, input.workspaceWriteApproved);
        const decision = classifyWorkIntake({ ...input, id: intakeId, projectKey: project.key });
        return {
          status: "already_created",
          createdType: featurePlan ? "feature_plan" : "task",
          ...(featurePlan ? { featurePlan } : {}),
          task: featurePlan ? task : (task as TaskRecord | undefined),
          decision,
          explanation: explainWorkIntakeDecision(decision)
        };
      }
    }

    const decision = classifyWorkIntake({
      ...input,
      id: intakeId,
      projectKey: project.key
    });

    this.database.saveWorkIntakeDecision(decision);
    const explanation = explainWorkIntakeDecision(decision);

    if (decision.classification === "needs_clarification") {
      return {
        status: "needs_clarification",
        createdType: "none",
        decision,
        explanation
      };
    }

    if (decision.classification === "direct_task") {
      const task = this.database.createTask(input.objective, origin.channel, project.key);
      this.recordWorkspaceWriteApproval(origin, task.id, input.workspaceWriteApproved);
      this.database.recordWorkIntakeSubmission(intakeId, { taskId: task.id });
      this.database.addEvent({
        source: origin.channel,
        type: "task.created",
        text: input.objective,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        taskId: task.id,
        metadata: {
          projectKey: project.key,
          workIntakeId: intakeId,
          workIntakeDecisionId: decision.id,
          classification: decision.classification,
          reasonCode: decision.reasonCode
        }
      });
      return {
        status: "created",
        createdType: "task",
        task,
        decision,
        explanation
      };
    }

    const task = this.database.createTask(input.objective, origin.channel, project.key);
    this.recordWorkspaceWriteApproval(origin, task.id, input.workspaceWriteApproved);
    this.database.addEvent({
      source: origin.channel,
      type: "task.created",
      text: input.objective,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: task.id,
      metadata: {
        projectKey: project.key,
        workIntakeId: intakeId,
        workIntakeDecisionId: decision.id,
        classification: decision.classification,
        reasonCode: decision.reasonCode
      }
    });

    const writeResult = this.createFeaturePlan(origin, {
      projectKey: project.key,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria && input.acceptanceCriteria.length > 0
        ? input.acceptanceCriteria
        : [input.objective],
      taskIds: [task.id],
      idempotencyKey: intakeId,
      workIntakeId: intakeId,
      workIntakeDecisionId: decision.id,
      classification: decision.classification,
      reasonCode: decision.reasonCode
    });

    this.database.recordWorkIntakeSubmission(intakeId, {
      taskId: task.id,
      featurePlanId: writeResult.plan.id
    });

    return {
      status: "created",
      createdType: "feature_plan",
      task,
      featurePlan: this.database.getFeaturePlanDetails(writeResult.plan.id),
      writeResult,
      decision,
      explanation
    };
  }

  private recordWorkspaceWriteApproval(origin: CommandOrigin, taskId: number, approved?: boolean): void {
    if (!approved) return;
    if (this.database.hasEventForTask(taskId, "task.workspace_access_approved")) return;
    this.database.addEvent({
      source: origin.channel,
      type: "task.workspace_access_approved",
      text: "User approved autonomous commands and project-local dependency changes inside this task's isolated worktree.",
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId,
      metadata: { scope: "task_worktree", approval: "autonomous_workspace_execution" }
    });
  }

  listWorkGraphs(limit = 30): WorkGraphView[] {
    const events = this.database.listEvents(200);
    return this.database.listWorkGraphs(limit).map((graph) => this.toWorkGraphView(graph, events));
  }

  getWorkGraph(workGraphId: number): WorkGraphView {
    try {
      return this.toWorkGraphView(this.database.getWorkGraphDetails(workGraphId));
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Work Graph #${workGraphId} not found.`);
    }
  }

  async cancelWorkGraph(origin: CommandOrigin, workGraphId: number, reason?: string | null): Promise<WorkGraphView> {
    const graph = this.getRawWorkGraph(workGraphId);
    if (["completed", "blocked", "cancelled"].includes(graph.status)) {
      throw conflictError(`Work Graph #${workGraphId} is already ${graph.status}.`);
    }
    if (this.workGraphRuntime) {
      try {
        return this.toWorkGraphView(await this.workGraphRuntime.cancel(origin, workGraphId, reason));
      } catch (error) {
        throw conflictError(error instanceof Error ? error.message : "Work Graph cancellation failed.");
      }
    }
    if (graph.status === "running") {
      throw conflictError(
        `Work Graph #${workGraphId} is running and requires its runtime coordinator to abort safely.`
      );
    }
    const cancellationReason = reason?.trim() || "Cancelled by operator.";
    for (const node of graph.nodes) {
      if (!["completed", "blocked", "cancelled"].includes(node.status)) {
        this.database.updateWorkerNodeStatus(node.id, "cancelled", cancellationReason);
      }
    }
    this.database.updateWorkGraphStatus(graph.id, "cancelled");
    this.database.addEvent({
      source: origin.channel,
      type: "work_graph.cancelled",
      text: graph.objective,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      metadata: { graphId: graph.id, runId: graph.runId, reason: redactSensitiveText(cancellationReason) }
    });
    return this.toWorkGraphView(this.database.getWorkGraphDetails(graph.id));
  }

  private getRawWorkGraph(workGraphId: number): WorkGraphDetails {
    try {
      return this.database.getWorkGraphDetails(workGraphId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Work Graph #${workGraphId} not found.`);
    }
  }

  private toWorkGraphView(
    graph: WorkGraphDetails,
    events = this.database.listEvents(200)
  ): WorkGraphView {
    const run = this.database.getGoalRun(graph.runId);
    const task = this.database.getTask(run.taskId);
    const artifacts = this.database.listWorkerArtifacts(graph.id).map((artifact): WorkGraphArtifactView => ({
      nodeId: artifact.nodeId,
      key: publicArtifactKey(artifact.key),
      kind: artifact.kind,
      summary: publicText(artifact.summary),
      contentHash: artifact.contentHash,
      bytes: artifact.bytes
    }));
    let fallbackCount = 0;
    let conflictCount = 0;
    let attemptCount = 0;
    let durationMs = 0;
    let degraded = false;
    const nodes = graph.nodes.map((node): WorkGraphNodeView => {
      const attempts = this.database.listWorkerAttempts(node.id).map((attempt): WorkGraphAttemptView => {
        attemptCount += 1;
        durationMs += attempt.durationMs ?? 0;
        if (!["completed", "running"].includes(attempt.status)) degraded = true;
        if (attempt.error && /(?:outside|beyond).*scope|scope violation|write conflict|mutation scope/i.test(attempt.error)) {
          conflictCount += 1;
        }
        return {
          attemptNumber: attempt.attemptNumber,
          provider: attempt.provider,
          status: attempt.status,
          durationMs: attempt.durationMs,
          summary: publicText(attempt.summary),
          error: attempt.error ? publicText(attempt.error) : null,
          createdAt: attempt.createdAt,
          finishedAt: attempt.finishedAt
        };
      });
      const nodeFallbacks = attempts.reduce((count, attempt, index) => (
        index > 0 && attempt.provider !== attempts[index - 1]!.provider ? count + 1 : count
      ), 0);
      fallbackCount += nodeFallbacks;
      return {
        ...node,
        key: publicText(node.key),
        objective: publicText(node.objective),
        dependsOn: node.dependsOn.map(publicText),
        inputArtifacts: node.inputArtifacts.map(publicArtifactKey),
        outputContract: publicText(node.outputContract),
        skillVersions: node.skillVersions.map(publicText),
        writeScope: node.writeScope.map(publicScope),
        lastError: node.lastError ? publicText(node.lastError) : null,
        attempts,
        fallbackCount: nodeFallbacks
      };
    });
    const adoptionEvent = events.find((event) => (
      event.type === "goal.work_graph_adoption_decision" && Number(event.metadata.runId) === graph.runId
    ));
    const adoption = adoptionEvent ? adoptionView(adoptionEvent.metadata) : null;
    const artifactBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
    const quality: WorkGraphCanaryEvidence["quality"] = graph.status === "completed"
      ? degraded || fallbackCount > 0 ? "degraded" : "passed"
      : graph.status === "blocked"
        ? "blocked"
        : graph.status === "cancelled"
          ? "cancelled"
          : "pending";
    return {
      ...graph,
      taskId: task.id,
      projectKey: task.projectKey,
      objective: publicText(graph.objective),
      adoption,
      nodes,
      artifacts,
      artifactCount: artifacts.length,
      artifactBytes,
      canary: {
        durationMs,
        estimatedTokens: Math.ceil(artifactBytes / 4),
        attempts: attemptCount,
        fallbacks: fallbackCount,
        conflicts: conflictCount,
        quality
      },
      cancellable: !["completed", "blocked", "cancelled"].includes(graph.status)
    };
  }

  createFeaturePlan(origin: CommandOrigin, input: CreateFeaturePlanInput): FeaturePlanWriteResult {
    try {
      const result = this.database.createFeaturePlan({
        projectKey: input.projectKey,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        taskIds: input.taskIds ?? [],
        taskContracts: input.taskContracts,
        priority: input.priority,
        dependsOnFeaturePlanIds: input.dependsOnFeaturePlanIds,
        featureIssueNumber: input.featureIssueNumber,
        taskIssueNumbers: input.taskIssueNumbers,
        idempotencyKey: input.idempotencyKey,
        source: origin.channel,
        createdByUserId: origin.userId ?? null,
        createdByUsername: origin.username ?? null
      });

      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.created",
          text: result.plan.objective,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            taskIds: result.tasks.map((task) => task.taskId),
            githubIssues: this.database.getFeaturePlanIssueLinks(result.plan.id),
            acceptanceCriteriaCount: result.plan.acceptanceCriteria.length,
            revision: result.plan.revision,
            workIntakeId: input.workIntakeId ?? null,
            workIntakeDecisionId: input.workIntakeDecisionId ?? null,
            classification: input.classification ?? null,
            reasonCode: input.reasonCode ?? null
          }
        });
      }

      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  decideImprovementProposal(
    origin: CommandOrigin,
    improvementId: number,
    status: Exclude<ImprovementStatus, "candidate">,
    decisionNote?: string | null
  ): ImprovementDecisionOutcome {
    try {
      return this.database.withTransaction(() => {
        const before = this.database.getImprovementProposal(improvementId);
        if (before.status !== "candidate") {
          if (before.status === status && (before.taskId || before.featurePlanId)) {
            return {
              improvement: before,
              task: before.taskId ? this.database.getTask(before.taskId) : null,
              featurePlan: before.featurePlanId ? this.database.getFeaturePlanDetails(before.featurePlanId) : null
            };
          }
          throw new Error(`Improvement proposal ${improvementId} is no longer awaiting a decision.`);
        }

        const decided = this.database.decideImprovementProposal(improvementId, status, decisionNote);
        if (status === "rejected") {
          this.recordImprovementDecision(origin, decided);
          return { improvement: decided, task: null, featurePlan: null };
        }

        const project = decided.projectKey
          ? this.database.findProjectByKey(decided.projectKey)
          : this.database.getDefaultProject();
        if (!project) throw new Error(`Project not found for improvement proposal ${improvementId}.`);
        const isSkillProposal = decided.category === "skill";
        const suggestedQualifiedName = suggestSkillProposalQualifiedName(decided.title);

        const intakeResult = this.submitWorkIntake(origin, {
          projectKey: project.key,
          objective: `Implement approved improvement #${decided.id}: ${decided.title}`,
          acceptanceCriteria: [
            decided.proposedChange,
            `Targets: ${decided.targets.length > 0 ? decided.targets.join(", ") : "determine during planning"}`,
            "Preserve the Maestro Constitution, human gates, secret handling, audit trail and rollback boundaries.",
            "Run deterministic typecheck, tests, build and secret scan.",
            "Deliver a Draft Work PR and require Final Review only on the consolidated Feature PR.",
            "Do not mutate protected policy, permission, audit or rollback layers automatically.",
            ...(isSkillProposal ? [
              `Create the Skill as an agent-owned draft under skills/repository/, qualified name ${suggestedQualifiedName}.`,
              "Set maestro.yaml owner: agent and include evals/cases.yaml with trigger, content and script checks.",
              "Do not activate, approve or wire the Skill into any runtime path; governed evaluation and promotion happen separately."
            ] : [])
          ],
          explicitOverride: "feature_plan",
          intakeId: `improvement:${decided.id}:activation`,
          workspaceWriteApproved: true
        });

        const task = intakeResult.task ?? (intakeResult.writeResult?.tasks?.[0] ? this.database.getTask(intakeResult.writeResult.tasks[0].taskId) : null);
        const featurePlan = intakeResult.featurePlan ?? null;

        const improvement = this.database.attachImprovementActivation(
          decided.id,
          task?.id ?? null,
          featurePlan?.plan.id ?? null
        );
        this.recordImprovementDecision(origin, improvement);

        this.database.addEvent({
          source: origin.channel,
          type: intakeResult.createdType === "feature_plan" ? "improvement.activated_as_feature_plan" : "improvement.activated_as_task",
          text: improvement.title,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          taskId: task?.id ?? null,
          metadata: {
            improvementId: improvement.id,
            featurePlanId: featurePlan?.plan.id ?? null,
            projectKey: project.key,
            workIntakeId: intakeResult.decision.id,
            classification: intakeResult.decision.classification
          }
        });

        if (isSkillProposal && task) {
          const skillProposal = this.database.createSkillProposal({
            improvementProposalId: improvement.id,
            suggestedQualifiedName,
            evidence: improvement.evidence,
            provenance: {
              improvementProposalId: improvement.id,
              source: improvement.source,
              fingerprint: improvement.fingerprint,
              taskId: task.id,
              featurePlanId: featurePlan?.plan.id ?? null
            }
          });
          this.database.addEvent({
            source: origin.channel,
            type: "skill.proposal_drafted",
            text: skillProposal.suggestedQualifiedName,
            userId: origin.userId ?? null,
            username: origin.username ?? null,
            taskId: task.id,
            metadata: {
              skillProposalId: skillProposal.id,
              improvementId: improvement.id,
              suggestedQualifiedName: skillProposal.suggestedQualifiedName
            }
          });
        }
        return { improvement, task, featurePlan };
      });
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "Improvement decision failed.");
    }
  }

  listSkillProposals(status?: SkillProposalStatus): SkillProposalRecord[] {
    return this.database.listSkillProposals(status);
  }

  reconcileSkillProposalDrafts(origin: CommandOrigin): SkillProposalRecord[] {
    const linked = this.requireSkillLifecycle().reconcileSkillProposalDrafts();
    for (const proposal of linked) {
      this.database.addEvent({
        source: origin.channel,
        type: "skill.proposal_linked",
        text: proposal.suggestedQualifiedName,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          skillProposalId: proposal.id,
          improvementId: proposal.improvementProposalId,
          qualifiedName: proposal.qualifiedName,
          versionId: proposal.versionId
        }
      });
    }
    return linked;
  }

  evaluateSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillEvaluationRecord {
    try {
      const evaluation = this.requireSkillLifecycle().evaluateVersion(skillVersionRecordId);
      this.database.addEvent({
        source: origin.channel,
        type: "skill.version_evaluated",
        text: evaluation.qualifiedName,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          skillVersionRecordId,
          qualifiedName: evaluation.qualifiedName,
          versionId: evaluation.versionId,
          status: evaluation.status,
          qualityScore: evaluation.qualityScore,
          regressionDetected: evaluation.regressionDetected
        }
      });
      return evaluation;
    } catch (error) {
      throw this.toSkillLifecycleError(error);
    }
  }

  approveSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_approved", skillVersionRecordId, () => (
      this.requireSkillLifecycle().approveVersion(skillVersionRecordId)
    ));
  }

  activateSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_activated", skillVersionRecordId, () => (
      this.requireSkillLifecycle().activateVersion(skillVersionRecordId)
    ));
  }

  rollbackSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_rolled_back", skillVersionRecordId, () => (
      this.requireSkillLifecycle().rollbackVersion(skillVersionRecordId)
    ));
  }

  restoreSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_restored", skillVersionRecordId, () => (
      this.requireSkillLifecycle().restoreVersion(skillVersionRecordId)
    ));
  }

  archiveSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_archived", skillVersionRecordId, () => (
      this.requireSkillLifecycle().archiveVersion(skillVersionRecordId, "human")
    ));
  }

  getSkillCuratorReport(): SkillCuratorReport {
    return this.requireSkillLifecycle().curatorDryRun();
  }

  applySkillCuratorAutomaticArchival(origin: CommandOrigin): { archived: string[]; report: SkillCuratorReport } {
    const result = this.requireSkillLifecycle().curatorApplyAutomaticArchival();
    if (result.archived.length > 0) {
      this.database.addEvent({
        source: origin.channel,
        type: "skill.curator_applied",
        text: `${result.archived.length} Skill(s) archived by Curator.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { archived: result.archived }
      });
    }
    return result;
  }

  listSkillCuratorCandidates(status?: SkillCuratorCandidateStatus): SkillCuratorCandidateRecord[] {
    return this.database.listSkillCuratorCandidates(status);
  }

  processSkillCuratorIncidents(_origin: CommandOrigin): SkillCuratorCandidateRecord[] {
    return this.requireSkillLifecycle().processCuratorIncidents();
  }

  evaluateSkillCuratorCandidate(_origin: CommandOrigin, candidateId: number): SkillCuratorCandidateRecord {
    return this.requireSkillLifecycle().evaluateCuratorCandidate(candidateId);
  }

  private runSkillLifecycleTransition(
    origin: CommandOrigin,
    eventType: string,
    skillVersionRecordId: number,
    transition: () => SkillVersionRecord
  ): SkillVersionRecord {
    try {
      const version = transition();
      this.database.addEvent({
        source: origin.channel,
        type: eventType,
        text: version.qualifiedName,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          skillVersionRecordId: version.id,
          qualifiedName: version.qualifiedName,
          versionId: version.versionId,
          status: version.status
        }
      });
      return version;
    } catch (error) {
      throw this.toSkillLifecycleError(error);
    }
  }

  private requireSkillLifecycle(): SkillLifecycleService {
    if (!this.skillLifecycleService) throw notFoundError("Governed Skill lifecycle is unavailable in this runtime.");
    return this.skillLifecycleService;
  }

  private toSkillLifecycleError(error: unknown): never {
    const message = error instanceof Error ? error.message : "Skill lifecycle operation failed.";
    if (/not found/i.test(message)) throw notFoundError(message);
    throw conflictError(message);
  }

  getFeaturePlan(featurePlanId: number): FeaturePlanDetails {
    try {
      return this.database.getFeaturePlanDetails(featurePlanId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Feature plan not found: ${featurePlanId}`);
    }
  }

  listFeaturePlans(projectKey?: string | null, limit = 30): FeaturePlanDetails[] {
    const plans = projectKey?.trim()
      ? this.database.listFeaturePlansByProject(projectKey.trim().toLowerCase(), limit)
      : this.database.listFeaturePlans(limit);
    return plans.map((plan) => this.database.getFeaturePlanDetails(plan.id));
  }

  async integrateFeaturePlan(
    _origin: CommandOrigin,
    featurePlanId: number,
    worktreesRoot: string,
    github?: WorkPullRequestGateway
  ): Promise<FeaturePlanIntegrationDetails> {
    try {
      return await new FeatureIntegrationBuilder(this.database, worktreesRoot, github).build(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  cancelFeaturePlan(origin: CommandOrigin, featurePlanId: number, reason?: string | null): FeaturePlanWriteResult {
    try {
      const result = this.database.cancelFeaturePlan(featurePlanId, reason);
      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.cancelled",
          text: result.plan.cancelReason || `Feature Plan #${result.plan.id} cancelled.`,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            taskIds: result.tasks.map((task) => task.taskId),
            revision: result.plan.revision
          }
        });
        revalidateQueuedFeaturePlansWithAudit(
          this.database,
          "feature_plan_cancelled",
          result.plan.projectKey
        );
      }
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  async cancelFeature(origin: CommandOrigin, featureId: number, reason?: string | null): Promise<FeatureRecord> {
    try {
      const before = this.database.getFeature(featureId);
      if (before.status === "cancelled") return before;
      if (["completed", "merging"].includes(before.status)) {
        throw new Error(`Feature #${featureId} cannot be cancelled from status ${before.status}.`);
      }
      const pullRequest = await this.featureGithub.inspect(before.pullRequestUrl);
      if (pullRequest.state === "MERGED") {
        throw new Error(`Feature #${featureId} cannot be cancelled because its pull request is already merged.`);
      }
      const feature = this.database.cancelFeature(featureId, reason);
      if (pullRequest.state === "OPEN") {
        try {
          await this.featureGithub.close(
            before.pullRequestUrl,
            `Feature #${featureId} cancelled before merge. History preserved for audit.`
          );
        } catch (error) {
          this.database.addEvent({
            source: origin.channel,
            type: "feature.cancel_close_failed",
            text: redactSensitiveText(
              error instanceof Error ? error.message : "Unknown GitHub close error."
            ),
            userId: origin.userId ?? null,
            username: origin.username ?? null,
            metadata: { featureId: feature.id, pullRequestUrl: feature.pullRequestUrl }
          });
        }
      }
      this.database.addEvent({
        source: origin.channel,
        type: "feature.cancelled",
        text: feature.cancelReason || `Feature #${feature.id} cancelled before merge.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          featureId: feature.id,
          featurePlanId: feature.featurePlanId,
          projectKey: feature.projectKey,
          previousStatus: before.status,
          pullRequestUrl: feature.pullRequestUrl
        }
      });
      revalidateQueuedFeaturePlansWithAudit(
        this.database,
        "feature_cancelled",
        feature.projectKey
      );
      return feature;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown feature cancellation error.";
      if (/not found/i.test(message)) throw notFoundError(message);
      if (/cannot be cancelled|already merged/i.test(message)) throw conflictError(message);
      throw validationError(message);
    }
  }

  replanFeaturePlan(
    origin: CommandOrigin,
    featurePlanId: number,
    input: ReplanFeaturePlanInput
  ): FeaturePlanWriteResult {
    let before: FeaturePlanDetails | null = null;
    try {
      before = this.database.getFeaturePlanDetails(featurePlanId);
      const result = this.database.replanFeaturePlan({
        id: featurePlanId,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        taskIds: input.taskIds,
        taskContracts: input.taskContracts,
        idempotencyKey: input.idempotencyKey
      });
      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.replanned",
          text: result.plan.objective,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            previousRevision: before.plan.revision,
            revision: result.plan.revision,
            previousTaskIds: before.tasks.map((task) => task.taskId),
            taskIds: result.tasks.map((task) => task.taskId),
            acceptanceCriteriaCount: result.plan.acceptanceCriteria.length
          }
        });
      }
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  prepareTask(origin: CommandOrigin, taskId: number, worktreesRoot: string): PrepareTaskOutcome {
    let task: TaskRecord;
    try {
      task = this.database.getTask(taskId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Task not found: ${taskId}`);
    }

    if (!task.projectKey) {
      const failure = validationError(`Task #${task.id} has no project.`);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    // Idempotent prepare (F-hotfix): a task that already has a worktree must
    // NOT fail preparation again. This is the retry loop killer — the chat
    // "Reiniciar" flips a blocked task back to queued, the autopilot calls
    // prepareTask, and the old code threw "already has a worktree", blocking
    // it again forever. If the worktree still exists on disk, reuse it and
    // move on; only a MISSING worktree is an error (user deleted it).
    if (task.branchName || task.worktreePath) {
      const worktreeExists = task.worktreePath
        ? fs.existsSync(task.worktreePath)
        : false;
      if (worktreeExists) {
        if (task.status === "queued") {
          this.database.updateTaskWorktree({
            id: task.id,
            status: "planning",
            branchName: task.branchName!,
            worktreePath: task.worktreePath!,
            baseBranch: task.baseBranch ?? null
          });
        }
        this.database.addEvent({
          source: origin.channel,
          type: "task.prepared",
          text: `Reused existing worktree for task #${task.id} (idempotent re-prepare).`,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          taskId: task.id
        });
        return {
          task: this.database.getTask(task.id),
          branchName: task.branchName!,
          worktreePath: task.worktreePath!
        };
      }
      const failure = conflictError(
        `Task #${task.id} references a worktree that no longer exists on disk (${task.worktreePath}). Cancel the task and create a new one.`
      );
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    let project = this.database.getProjectByKey(task.projectKey);
    // Task worktrees are created from an exact committed HEAD. A dirty
    // canonical checkout is therefore safe to prepare: its uncommitted files
    // stay in the user's checkout and are never copied into the isolated task
    // worktree. Repository synchronization itself remains strict.
    const validationErrors = validateGitProject(project, { allowDirty: true });
    if (validationErrors.length > 0) {
      const failure = validationError(validationErrors.join("\n"), validationErrors);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    // A freshly created repository (zero commits) has an unborn default branch,
    // so the worktree step below would fail with "fatal: invalid reference".
    // Give the project its first commit instead of blocking the task.
    if (!hasAnyCommit(project.path)) {
      // There is no exact commit to base a worktree on yet. Do not silently
      // absorb an uncommitted first-run checkout into Maestro's bootstrap
      // commit; ask the user to decide what belongs in that initial commit.
      const bootstrapValidationErrors = validateGitProject(project);
      if (bootstrapValidationErrors.length > 0) {
        const failure = conflictError(bootstrapValidationErrors.join("\n"));
        this.recordPrepareFailure(origin, task.id, failure.details);
        throw failure;
      }
      const bootstrap = bootstrapEmptyRepository(project.path, project.key, { push: false });
      if (!bootstrap.ok) {
        const failure = conflictError(
          bootstrap.error ?? "Repository has no commits and Maestro could not create the initial one."
        );
        this.recordPrepareFailure(origin, task.id, failure.details);
        throw failure;
      }
      if (bootstrap.bootstrapped) {
        // The real branch name is only known after the first commit; keep the
        // DB in sync so worktrees/baselines never target a stale ref.
        const actualBranch = detectGitDefaultBranch(project.path);
        if (actualBranch && actualBranch !== project.defaultBranch) {
          project = { ...project, defaultBranch: actualBranch };
          this.database.registerProject({
            key: project.key,
            name: project.name,
            path: project.path,
            defaultBranch: actualBranch
          });
        }
        this.database.addEvent({
          source: origin.channel,
          type: "project.bootstrapped",
          text: `Initial commit created by Maestro for @${project.key} before preparing Task #${task.id}.`,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          taskId: task.id
        });
      }
    }

    let repositoryBase;
    try {
      repositoryBase = this.repositoryService.prepareTaskBase(project, { allowDirty: true });
      project = this.database.getProjectByKey(project.key);
    } catch (error) {
      const failure = conflictError(
        error instanceof RepositorySyncError
          ? error.message
          : error instanceof Error ? error.message : "Repository synchronization failed before task preparation."
      );
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    let baseline;
    try {
      baseline = prepareFeatureTaskBaseline(this.database, task, project, worktreesRoot, {
        baseRef: repositoryBase.baseRef,
        baseBranch: repositoryBase.baseBranch
      });
    } catch (error) {
      const failure = conflictError(
        error instanceof Error ? error.message : "Feature Task baseline preparation failed."
      );
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }
    const plan = createWorktreePlan(project, task, worktreesRoot, baseline);
    const result = createGitWorktree(project, plan);
    if (!result.ok) {
      const failure = conflictError(result.stderr || result.stdout || "git worktree failed.");
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    const updatedTask = this.database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      baseBranch: plan.baseBranch ?? project.defaultBranch,
      baseCommitSha: repositoryBase.baseCommitSha
    });

    this.database.addEvent({
      source: origin.channel,
      type: "task.prepared",
      text: plan.branchName,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: updatedTask.id,
      metadata: {
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
        baseBranch: plan.baseBranch ?? project.defaultBranch,
        baseCommitSha: repositoryBase.baseCommitSha,
        canonicalHeadSha: repositoryBase.state.canonicalHeadSha,
        remoteHeadSha: repositoryBase.state.remoteHeadSha,
        syncState: repositoryBase.state.syncState,
        workingTreePreserved: repositoryBase.state.syncState === "dirty",
        dependencyTaskIds: baseline.dependencyTaskIds
      }
    });

    return { task: updatedTask, branchName: plan.branchName, worktreePath: plan.worktreePath };
  }

  private recordPrepareFailure(origin: CommandOrigin, taskId: number, errors: string[]) {
    this.database.addEvent({
      source: origin.channel,
      type: "task.prepare_failed",
      text: errors.join("\n"),
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId
    });
  }

  pauseFeaturePlan(origin: CommandOrigin, featurePlanId: number, reason?: string | null): FeaturePlanDetails {
    try {
      const result = this.database.pauseFeaturePlan(featurePlanId, reason, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.paused",
        text: result.plan.pauseReason || `Feature Plan #${result.plan.id} paused.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId: result.plan.id, projectKey: result.plan.projectKey }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  resumeFeaturePlan(origin: CommandOrigin, featurePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.resumeFeaturePlan(featurePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.resumed",
        text: `Feature Plan #${result.plan.id} resumed.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId: result.plan.id, projectKey: result.plan.projectKey }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  updateFeaturePlanPriority(origin: CommandOrigin, featurePlanId: number, priority: number): FeaturePlanDetails {
    try {
      const result = this.database.updateFeaturePlanPriority(featurePlanId, priority, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.priority_updated",
        text: `Feature Plan #${result.plan.id} priority updated to ${priority}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId: result.plan.id, priority }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  addFeaturePlanDependency(origin: CommandOrigin, featurePlanId: number, dependsOnFeaturePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.addFeaturePlanDependency(featurePlanId, dependsOnFeaturePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.dependency_added",
        text: `Feature Plan #${featurePlanId} depends on #${dependsOnFeaturePlanId}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId, dependsOnFeaturePlanId }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  removeFeaturePlanDependency(origin: CommandOrigin, featurePlanId: number, dependsOnFeaturePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.removeFeaturePlanDependency(featurePlanId, dependsOnFeaturePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.dependency_removed",
        text: `Dependency on #${dependsOnFeaturePlanId} removed from Feature Plan #${featurePlanId}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId, dependsOnFeaturePlanId }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  updateFeaturePlanQueueStatus(
    origin: CommandOrigin,
    featurePlanId: number,
    toStatus: import("../db.js").FeaturePlanQueueStatus,
    reason?: string | null
  ): FeaturePlanDetails {
    try {
      const result = this.database.updateFeaturePlanQueueStatus(featurePlanId, toStatus, reason, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.status_changed",
        text: `Feature Plan #${featurePlanId} status changed to ${toStatus}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId, status: toStatus, reason: reason || null }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  getFeaturePlanEligibility(featurePlanId: number): import("../db.js").FeaturePlanEligibilityResult {
    try {
      return this.database.evaluateFeaturePlanEligibility(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  getFeaturePlanHistory(featurePlanId: number): import("../db.js").FeaturePlanHistoryRecord[] {
    try {
      return this.database.getFeaturePlanHistory(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  admitFeaturePlan(origin: CommandOrigin, featurePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.admitFeaturePlan(featurePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.admitted",
        text: `Feature Plan #${featurePlanId} admitted to project writer lease.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  revalidateFeaturePlanQueue(projectKey?: string | null): FeaturePlanDetails[] {
    try {
      return revalidateQueuedFeaturePlans(this.database, projectKey || undefined);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  listFeaturePlanQueue(projectKey?: string | null): FeaturePlanDetails[] {
    try {
      return this.database.listFeaturePlanQueue(projectKey || undefined);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  retryFeaturePlan(
    origin: CommandOrigin,
    featurePlanId: number,
    reason?: string | null
  ): FeaturePlanDetails {
    try {
      const current = this.database.getFeaturePlanDetails(featurePlanId);
      if (current.plan.status !== "blocked") {
        throw conflictError(`Feature Plan #${featurePlanId} is not blocked.`);
      }
      const result = this.database.updateFeaturePlanQueueStatus(
        featurePlanId,
        "queued",
        reason,
        origin.userId ?? null,
        origin.username ?? null
      );
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.retried",
        text: `Feature Plan #${featurePlanId} retried.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId, reason: reason || null }
      });
      revalidateQueuedFeaturePlans(this.database, result.plan.projectKey);
      return this.database.getFeaturePlanDetails(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  private toFeaturePlanCommandError(error: unknown): never {
    if (error instanceof ApplicationCommandError) throw error;
    const message = error instanceof Error ? error.message : "Unknown feature plan error.";
    if (/not found/i.test(message)) throw notFoundError(message);
    if (/already associated|already used|cannot be|cancelled|conflict|dirty|cherry-pick|secret guard|diff whitespace|checkpoint|changed after|Invalid Feature Plan status transition|is not blocked/i.test(message)) {
      throw conflictError(message);
    }
    if (/Cyclic dependency|Self-dependencies|Cross-project|must be|positive integer|required|at least/i.test(message)) {
      throw validationError(message);
    }
    throw validationError(message);
  }

  private recordImprovementDecision(origin: CommandOrigin, improvement: ImprovementProposalRecord): void {
    this.database.addEvent({
      source: origin.channel,
      type: `improvement.${improvement.status}`,
      text: improvement.title,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      metadata: {
        improvementId: improvement.id,
        decisionNote: improvement.decisionNote,
        taskId: improvement.taskId,
        featurePlanId: improvement.featurePlanId
      }
    });
  }
}
