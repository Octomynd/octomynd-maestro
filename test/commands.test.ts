import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { detectGitDefaultBranch, hasAnyCommit } from "../src/git.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { ApplicationCommandError } from "../src/commands/errors.js";
import { FeatureGitHubGateway, FeaturePullRequestState } from "../src/features/github.js";

const { bootstrapOptionsSpy } = vi.hoisted(() => ({ bootstrapOptionsSpy: vi.fn() }));
const { gitPushCalls } = vi.hoisted(() => ({ gitPushCalls: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[], options?: object) => {
      if (command === "git" && args[0] === "push") {
        gitPushCalls.push([...args]);
      }
      return actual.spawnSync(command, args, options);
    }
  };
});
vi.mock("../src/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...actual,
    bootstrapEmptyRepository: (...args: Parameters<typeof actual.bootstrapEmptyRepository>) => {
      bootstrapOptionsSpy(args[2]);
      return actual.bootstrapEmptyRepository(...args);
    }
  };
});

function spawnGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let tempDir: string;
let projectDir: string;
let database: MaestroDatabase;
let commands: ApplicationCommands;
let featureGithub: FakeFeatureGitHubGateway;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-commands-"));
  projectDir = path.join(tempDir, "boo-project");
  fs.mkdirSync(projectDir);
  runGit(["init", "-b", "master"], projectDir);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Boo test\n");
  runGit(["add", "README.md"], projectDir);
  runGit(["-c", "user.name=Maestro Test", "-c", "user.email=maestro@test.local", "commit", "-m", "Initial"], projectDir);

  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: projectDir, defaultBranch: "master" });
  featureGithub = new FakeFeatureGitHubGateway();
  commands = new ApplicationCommands(database, featureGithub);
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("ApplicationCommands.createTask", () => {
  it("persists the task with the origin channel as source, regardless of caller", () => {
    const dashboardTask = commands.createTask({ channel: "dashboard" }, { text: "criada pelo dashboard", projectKey: "boo" });
    expect(dashboardTask.source).toBe("dashboard");

    const telegramTask = commands.createTask(
      { channel: "telegram", userId: "42", username: "operador" },
      { text: "criada pelo telegram", projectKey: "boo" }
    );
    expect(telegramTask.source).toBe("telegram");
  });

  it("accepts the internal Maestro origin used by backlog automation", () => {
    const task = commands.createTask(
      { channel: "maestro" },
      { text: "internal backlog task", projectKey: "boo" }
    );

    expect(task.source).toBe("maestro");
    expect(database.getLastEvent()?.source).toBe("maestro");
  });

  it("records an audit event carrying the origin metadata", () => {
    commands.createTask({ channel: "telegram", userId: "42", username: "operador" }, { text: "com auditoria", projectKey: "boo" });

    const event = database.getLastEvent();
    expect(event?.type).toBe("task.created");
    expect(event?.source).toBe("telegram");
    expect(event?.userId).toBe("42");
    expect(event?.username).toBe("operador");
  });

  it("records autonomous workspace approval only when explicitly requested", () => {
    const approvedTask = commands.createTask(
      { channel: "dashboard", userId: "42" },
      { text: "Install Python tooling in this task", projectKey: "boo", workspaceWriteApproved: true }
    );
    const approval = database.listEventsForTask(approvedTask.id).find((event) => event.type === "task.workspace_access_approved");
    expect(approval).toMatchObject({
      source: "dashboard",
      userId: "42",
      taskId: approvedTask.id,
      metadata: { scope: "task_worktree", approval: "autonomous_workspace_execution" }
    });

    const unapprovedTask = commands.createTask(
      { channel: "dashboard" },
      { text: "Review task without elevated approval", projectKey: "boo" }
    );
    expect(database.listEventsForTask(unapprovedTask.id).some((event) => event.type === "task.workspace_access_approved")).toBe(false);
  });

  it("records scoped autonomous workspace approval for an approved follow-up task", () => {
    const parent = commands.createTask({ channel: "dashboard" }, { text: "parent task", projectKey: "boo" });
    const followUp = commands.createFollowUpTask(
      { channel: "telegram", userId: "42" },
      { parentTaskId: parent.id, text: "install test dependencies", workspaceWriteApproved: true }
    );

    expect(database.listEventsForTask(followUp.id).find((event) => event.type === "task.workspace_access_approved"))
      .toMatchObject({ taskId: followUp.id, metadata: { scope: "task_worktree", approval: "autonomous_workspace_execution" } });
  });

  it("throws a typed validation error for blank text", () => {
    expect(() => commands.createTask({ channel: "dashboard" }, { text: "   ", projectKey: "boo" })).toThrowError(
      ApplicationCommandError
    );
    try {
      commands.createTask({ channel: "dashboard" }, { text: "", projectKey: "boo" });
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("validation");
    }
  });

  it("throws a typed not_found error for an unknown project", () => {
    expect.assertions(2);
    try {
      commands.createTask({ channel: "dashboard" }, { text: "task orfa", projectKey: "does-not-exist" });
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("not_found");
    }
  });
});

describe("ApplicationCommands.prepareTask", () => {
  it("prepares a worktree and records an audit event with the origin channel", () => {
    const task = commands.createTask({ channel: "dashboard" }, { text: "preparar worktree", projectKey: "boo" });

    const result = commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    expect(result.task.status).toBe("planning");
    expect(fs.existsSync(result.worktreePath)).toBe(true);
    const event = database.getLastEvent();
    expect(event?.type).toBe("task.prepared");
    expect(event?.source).toBe("dashboard");
  });

  it("throws a typed not_found error and records no event for an unknown task", () => {
    expect.assertions(3);
    const eventsBefore = database.listEvents().length;
    try {
      commands.prepareTask({ channel: "telegram" }, 999, path.join(tempDir, "worktrees"));
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("not_found");
    }
    expect(database.listEvents().length).toBe(eventsBefore);
  });

  it("re-prepares idempotently when the worktree already exists on disk (retry loop fix)", () => {
    const task = commands.createTask({ channel: "dashboard" }, { text: "preparar duas vezes", projectKey: "boo" });
    const first = commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    // Second prepare must REUSE the worktree instead of throwing — the chat
    // retry flow flips blocked tasks back and the autopilot re-prepares.
    const second = commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    expect(second.branchName).toBe(first.branchName);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.task.status).toBe("planning");
  });

  it("throws a typed conflict error when the recorded worktree no longer exists on disk", () => {
    expect.assertions(3);
    const task = commands.createTask({ channel: "dashboard" }, { text: "worktree sumiu", projectKey: "boo" });
    commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    // Simulate the user deleting the worktree directory outside Maestro.
    const stored = commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));
    fs.rmSync(stored.worktreePath, { recursive: true, force: true });
    // Reset the DB status so the next prepare is attempted.
    database.updateTaskStatus(task.id, "queued");

    try {
      commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("conflict");
    }

    const event = database.getLastEvent();
    expect(event?.type).toBe("task.prepare_failed");
  });
});

describe("ApplicationCommands.registerProject", () => {
  it("registers a project and records an audit event", () => {
    const otherProjectDir = path.join(tempDir, "other-project");
    fs.mkdirSync(otherProjectDir);
    runGit(["init", "-b", "main"], otherProjectDir);

    const result = commands.registerProject(
      { channel: "telegram", userId: "42", username: "operador" },
      { key: "other", path: otherProjectDir }
    );

    expect(result.project.key).toBe("other");
    const event = database.getLastEvent();
    expect(event?.type).toBe("project.registered");
    expect(event?.source).toBe("telegram");
  });

  it("registers a project by cloning from a remote repository into managed projects root", () => {
    const upstreamDir = path.join(tempDir, "upstream-repo");
    fs.mkdirSync(upstreamDir);
    runGit(["init", "-b", "main"], upstreamDir);
    fs.writeFileSync(path.join(upstreamDir, "index.js"), "console.log('upstream');\n");
    runGit(["add", "index.js"], upstreamDir);
    runGit(["-c", "user.name=Maestro Test", "-c", "user.email=maestro@test.local", "commit", "-m", "init upstream"], upstreamDir);

    const projectsRoot = path.join(tempDir, "managed-projects");
    const result = commands.registerProject(
      { channel: "dashboard" },
      {
        key: "@cloned-app",
        remoteUrl: "file://" + upstreamDir.replace(/\\/g, "/"),
        mode: "github"
      },
      projectsRoot
    );

    expect(result.project.key).toBe("cloned-app");
    expect(result.project.path).toBe(path.join(projectsRoot, "cloned-app"));
    expect(fs.existsSync(path.join(projectsRoot, "cloned-app", "index.js"))).toBe(true);
    expect(result.project.defaultBranch).toBe("main");
  });

  it("links a local repository to a remote origin if origin is missing", () => {
    const localDir = path.join(tempDir, "local-to-link");
    fs.mkdirSync(localDir);
    runGit(["init", "-b", "main"], localDir);

    const result = commands.registerProject(
      { channel: "dashboard" },
      {
        key: "linked-app",
        path: localDir,
        remoteUrl: "https://github.com/octomynd/linked-app.git",
        mode: "localremote"
      }
    );

    expect(result.project.key).toBe("linked-app");
    expect(result.warnings.some((w) => w.includes("Configured remote origin"))).toBe(true);
  });

  it("throws a typed validation error for a missing path", () => {
    expect.assertions(2);
    try {
      commands.registerProject({ channel: "dashboard" }, { key: "missing", path: path.join(tempDir, "nope") });
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("validation");
    }
  });

  it("throws a typed validation error for an invalid project key", () => {
    expect.assertions(2);
    try {
      commands.registerProject({ channel: "dashboard" }, { key: "X", path: projectDir });
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("validation");
    }
  });
});

describe("ApplicationCommands.cancelFeature", () => {
  it("closes the consolidated PR and preserves an audited cancelled record", async () => {
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature cancelavel",
      objective: "Cancelar antes do merge.",
      branchName: "maestro/feature-cancelavel",
      worktreePath: path.join(tempDir, "feature-cancelavel"),
      pullRequestUrl: featureGithub.state.url
    });

    const cancelled = await commands.cancelFeature(
      { channel: "telegram", userId: "42", username: "operador" },
      feature.id,
      "Prioridade mudou."
    );

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("Prioridade mudou.");
    expect(featureGithub.closed).toEqual([featureGithub.state.url]);
    expect(database.getLastEvent()).toMatchObject({
      source: "telegram",
      type: "feature.cancelled",
      userId: "42"
    });
  });

  it("fails closed when GitHub reports that the Feature PR was already merged", async () => {
    featureGithub.state = { ...featureGithub.state, state: "MERGED", isDraft: false };
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature mergeada",
      objective: "Nao pode cancelar depois do merge.",
      branchName: "maestro/feature-merged",
      worktreePath: path.join(tempDir, "feature-merged"),
      pullRequestUrl: featureGithub.state.url
    });

    await expect(commands.cancelFeature({ channel: "dashboard" }, feature.id)).rejects.toMatchObject({
      code: "conflict"
    });
    expect(database.getFeature(feature.id).status).toBe("draft");
    expect(featureGithub.closed).toHaveLength(0);
  });

  it("keeps the Feature cancelled when closing GitHub fails and audits the cleanup blocker", async () => {
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature com falha de fechamento",
      objective: "Cancelar localmente mesmo se GitHub estiver indisponivel.",
      branchName: "maestro/feature-close-failure",
      worktreePath: path.join(tempDir, "feature-close-failure"),
      pullRequestUrl: featureGithub.state.url
    });
    featureGithub.closeError = new Error(`Falha em C:\\Users\\private com sk-proj-${"x".repeat(48)}`);

    const cancelled = await commands.cancelFeature({ channel: "dashboard" }, feature.id, "Cancelamento seguro.");

    expect(cancelled.status).toBe("cancelled");
    const closeFailure = database.listEvents(10).find((event) => event.type === "feature.cancel_close_failed");
    expect(closeFailure).toBeDefined();
    expect(closeFailure?.text).not.toContain("C:\\Users\\private");
    expect(closeFailure?.text).not.toContain(`sk-proj-${"x".repeat(48)}`);
  });
});

describe("ApplicationCommands.triggerFeatureReview", () => {
  it("resolves target by PR URL or numeric ID and delegates to FeatureCoordinator", async () => {
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature para revisao manual",
      objective: "Validar comando /review",
      branchName: "maestro/feature-review-cmd",
      worktreePath: path.join(tempDir, "feature-review-cmd"),
      pullRequestUrl: "https://github.com/example/boo/pull/7"
    });

    const fakeCoordinator = {
      triggerManualReview: async (featureId: number, isRetry = false) => ({
        success: true,
        feature,
        status: "completed" as const,
        providerId: "codex" as const,
        summary: "Aprovado via comando manual.",
        message: "Revisao final aprovada e Feature PR mesclado com sucesso!"
      }),
      getReviewStatus: async (featureId: number) => ({
        feature,
        prState: featureGithub.state,
        isReady: true,
        notReadyReason: null,
        isReviewActive: false
      })
    } as any;

    const cmds = new ApplicationCommands(database, featureGithub, undefined, undefined, fakeCoordinator);

    // 1. Resolve by numeric Feature ID
    const resId = await cmds.triggerFeatureReview({ channel: "telegram" }, String(feature.id));
    expect(resId.success).toBe(true);
    expect(resId.summary).toBe("Aprovado via comando manual.");

    // 2. Resolve by PR URL
    const statusRes = await cmds.getFeatureReviewStatus({ channel: "telegram" }, feature.pullRequestUrl);
    expect(statusRes.isReady).toBe(true);
    expect(statusRes.feature.id).toBe(feature.id);

    // 3. Throw notFoundError for unknown target
    await expect(cmds.triggerFeatureReview({ channel: "telegram" }, "999")).rejects.toMatchObject({
      code: "not_found"
    });
  });
});

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git test setup failed");
  }
}

class FakeFeatureGitHubGateway implements FeatureGitHubGateway {
  state: FeaturePullRequestState = {
    number: 7,
    title: "Feature cancelavel",
    url: "https://github.com/example/boo/pull/7",
    state: "OPEN",
    isDraft: true,
    mergeable: "MERGEABLE",
    headRefName: "maestro/feature-cancelavel",
    headRepositoryOwner: "example",
    headRepositoryName: "boo",
    baseRefName: "master",
    headSha: "a".repeat(40),
    checks: []
  };
  readonly closed: string[] = [];
  closeError: Error | null = null;

  async inspect(): Promise<FeaturePullRequestState> { return { ...this.state, checks: [...this.state.checks] }; }
  async merge(): Promise<void> {}
  async markDraft(): Promise<void> {}
  async close(url: string): Promise<void> {
    if (this.closeError) throw this.closeError;
    this.closed.push(url);
    this.state = { ...this.state, state: "CLOSED" };
  }
  async closeSuperseded(): Promise<void> {}
  async deleteHeadBranch(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}

describe("ApplicationCommands Work Intake integration", () => {
  it("previews classification and returns the default English explanation", () => {
    const preview = commands.previewWorkIntake(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Criar novo assistente de voz" }
    );
    expect(preview.decision.classification).toBe("direct_task");
    expect(preview.explanation).toContain("Direct Task");
  });

  it("routes bounded maintenance request to exactly one direct task without feature plan", () => {
    const res = commands.submitWorkIntake(
      { channel: "dashboard" },
      {
        projectKey: "boo",
        objective: "Fix typo in README header"
      }
    );

    expect(res.status).toBe("created");
    expect(res.createdType).toBe("task");
    expect(res.task).toBeDefined();
    expect(res.featurePlan).toBeUndefined();
    expect(res.decision.reasonCode).toBe("single_bounded_objective");

    const tasks = database.listTasksByProject("boo");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(res.task!.id);
    expect(database.listFeaturePlansByProject("boo")).toHaveLength(0);
  });

  it("persists explicit work-intake workspace consent for the created task", () => {
    const res = commands.submitWorkIntake(
      { channel: "dashboard", userId: "42" },
      {
        projectKey: "boo",
        objective: "Set up Python tests and repair local test dependencies",
        workspaceWriteApproved: true
      }
    );

    expect(res.task).toBeDefined();
    expect(database.listEventsForTask(res.task!.id)).toContainEqual(expect.objectContaining({
      type: "task.workspace_access_approved",
      source: "dashboard",
      userId: "42",
      metadata: { scope: "task_worktree", approval: "autonomous_workspace_execution" }
    }));

    commands.submitWorkIntake(
      { channel: "dashboard", userId: "42" },
      {
        projectKey: "boo",
        objective: "Set up Python tests and repair local test dependencies",
        workspaceWriteApproved: true
      }
    );
    expect(database.listEventsForTask(res.task!.id).filter((event) => event.type === "task.workspace_access_approved")).toHaveLength(1);
  });

  it("creates a low-confidence direct task for ambiguous requests in automatic mode (F2)", () => {
    const res = commands.submitWorkIntake(
      { channel: "telegram", userId: "100" },
      {
        projectKey: "boo",
        objective: "..."
      }
    );

    // Automatic mode never refuses to create (F2): "..." still becomes a task.
    expect(res.status).toBe("created");
    expect(res.createdType).toBe("task");
    expect(res.decision.classification).toBe("direct_task");
    expect(res.decision.reasonCode).toBe("fallback_low_confidence");

    expect(database.listTasksByProject("boo")).toHaveLength(1);
    expect(database.listFeaturePlansByProject("boo")).toHaveLength(0);
    const persistedDecision = database.getWorkIntakeDecision(res.decision.id);
    expect(persistedDecision?.classification).toBe("direct_task");
  });

  it("still honors an explicit needs_clarification override without creating anything", () => {
    const res = commands.submitWorkIntake(
      { channel: "telegram", userId: "100" },
      {
        projectKey: "boo",
        objective: "alguma coisa um pouco mais longa mas marcada como duvidosa",
        explicitOverride: "needs_clarification"
      }
    );

    expect(res.status).toBe("needs_clarification");
    expect(res.createdType).toBe("none");
    expect(res.task).toBeUndefined();
    expect(res.featurePlan).toBeUndefined();
    expect(res.explanation).toContain("Needs Clarification");

    expect(database.listTasksByProject("boo")).toHaveLength(0);
    expect(database.listFeaturePlansByProject("boo")).toHaveLength(0);
    const persistedDecision = database.getWorkIntakeDecision(res.decision.id);
    expect(persistedDecision?.classification).toBe("needs_clarification");
  });

  it("routes genuinely dependent work to create a feature plan with attached task", () => {
    const res = commands.submitWorkIntake(
      { channel: "dashboard" },
      {
        projectKey: "boo",
        objective: "Implement multi-service auth flow",
        coordination: { dependsOnCount: 1 }
      }
    );

    expect(res.status).toBe("created");
    expect(res.createdType).toBe("feature_plan");
    expect(res.featurePlan).toBeDefined();
    expect(res.task).toBeDefined();
    expect(res.decision.reasonCode).toBe("coordination_required");

    const featurePlans = database.listFeaturePlansByProject("boo");
    expect(featurePlans).toHaveLength(1);
    expect(featurePlans[0].id).toBe(res.featurePlan!.plan.id);

    const tasks = database.listTasksByProject("boo");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(res.task!.id);
  });

  it("submits request idempotently yielding exactly one Task or Feature Plan", () => {
    const res1 = commands.submitWorkIntake(
      { channel: "telegram", userId: "100" },
      {
        projectKey: "boo",
        objective: "Integracao de pagamentos com webhook",
        coordination: { dependsOnCount: 2 }
      }
    );
    expect(res1.status).toBe("created");
    expect(res1.createdType).toBe("feature_plan");
    expect(res1.featurePlan).toBeDefined();

    const res2 = commands.submitWorkIntake(
      { channel: "telegram", userId: "100" },
      {
        projectKey: "boo",
        objective: "Integracao de pagamentos com webhook",
        coordination: { dependsOnCount: 2 },
        intakeId: res1.decision.id
      }
    );
    expect(res2.status).toBe("already_created");
    expect(res2.createdType).toBe("feature_plan");
    expect(res2.featurePlan?.plan.id).toBe(res1.featurePlan?.plan.id);
  });

  it("allows governed explicit override of classification", () => {
    const res = commands.submitWorkIntake(
      { channel: "dashboard" },
      {
        projectKey: "boo",
        objective: "Demanda complexa mas forcada como task",
        coordination: { dependsOnCount: 5, parallelWorkstreamCount: 4 },
        explicitOverride: "direct_task"
      }
    );
    expect(res.status).toBe("created");
    expect(res.createdType).toBe("task");
    expect(res.decision.reasonCode).toBe("explicit_override_direct_task");
    expect(res.explanation).toContain("Explicit user override");
  });
});

describe("ApplicationCommands.prepareTask on an empty repository", () => {
  it("bootstraps the initial commit and prepares the task instead of blocking", () => {
    const emptyDir = path.join(tempDir, "empty-project");
    const bareRemote = path.join(tempDir, "empty-project-origin.git");
    fs.mkdirSync(emptyDir);
    runGit(["init", "-b", "main"], emptyDir);
    runGit(["init", "--bare", bareRemote], tempDir);
    runGit(["remote", "add", "origin", bareRemote], emptyDir);
    database.registerProject({ key: "empty-repo", name: "Empty Repo", path: emptyDir, defaultBranch: "main" });

    const task = commands.createTask({ channel: "dashboard" }, { text: "criar app de financas", projectKey: "empty-repo" });

    bootstrapOptionsSpy.mockClear();
    gitPushCalls.length = 0;
    const result = commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    expect(result.task.worktreePath).toBeTruthy();
    expect(hasAnyCommit(emptyDir)).toBe(true);
    expect(bootstrapOptionsSpy).toHaveBeenCalledWith({ push: false });
    expect(gitPushCalls).toEqual([]);
    expect(spawnGit(["show-ref"], bareRemote).stdout).toBe("");

    const events = database.listEvents(50).filter((event) => event.type === "project.bootstrapped");
    expect(events.length).toBeGreaterThan(0);
  });

  it("records a prepare failure when the repository is dirty on first commit attempt", () => {
    const emptyDir = path.join(tempDir, "dirty-project");
    fs.mkdirSync(emptyDir);
    runGit(["init", "-b", "main"], emptyDir);
    fs.writeFileSync(path.join(emptyDir, "uncommitted.txt"), "dirty\n");
    database.registerProject({ key: "dirty-repo", name: "Dirty Repo", path: emptyDir, defaultBranch: "main" });

    const task = commands.createTask({ channel: "dashboard" }, { text: "tarefa em repo sujo", projectKey: "dirty-repo" });

    expect(() => commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees")))
      .toThrow(/invalid reference|dirty|failed/i);
  });

  it("syncs project.defaultBranch with the actual branch created by the bootstrap", () => {
    // Registered as 'main', but git's init.defaultBranch here is different:
    // the bootstrap must re-detect and persist the real branch name.
    const emptyDir = path.join(tempDir, "renamed-branch-project");
    fs.mkdirSync(emptyDir);
    runGit(["init"], emptyDir); // uses git's configured init.defaultBranch (may not be main)
    database.registerProject({ key: "renamed-repo", name: "Renamed Repo", path: emptyDir, defaultBranch: "main" });

    const task = commands.createTask({ channel: "dashboard" }, { text: "tarefa com branch divergente", projectKey: "renamed-repo" });
    const result = commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    expect(result.task.worktreePath).toBeTruthy();
    const stored = database.getProjectByKey("renamed-repo");
    expect(stored.defaultBranch).toBe(detectGitDefaultBranch(emptyDir));
    // The worktree base ref must match the branch that actually exists.
    const worktreeBranch = spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], result.task.worktreePath!);
    expect(worktreeBranch.stdout.trim()).not.toBe("");
  });
});
