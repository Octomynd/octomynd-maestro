import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { OperationalChatService } from "../src/chat/service.js";
import { parseProjectCreationIntent, parseTaskCreationIntent } from "../src/chat/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createTelegramBot } from "../src/telegram/bot.js";
import { MaestroConfig } from "../src/config.js";
import type { AgentCapability, AgentProvider } from "../src/agents/types.js";
import { runGit } from "../src/git.js";
import { ProjectProcessManager } from "../src/chat/project-process.js";
import { planProjectStartCommand } from "../src/chat/project-command.js";
import { compileOperationalChatContext } from "../src/chat/context-compiler.js";
import { isRecoveryRequest } from "../src/chat/recovery.js";

const { bootstrapOptionsSpy } = vi.hoisted(() => ({ bootstrapOptionsSpy: vi.fn() }));
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

describe("Unified Operational Chat (Task #52)", () => {
  let tmpDir: string;
  let dbPath: string;
  let database: MaestroDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-test-"));
    dbPath = path.join(tmpDir, "test-maestro.db");
    database = createDatabase(dbPath);
    database.registerProject({
      key: "maestro",
      name: "Octomynd Maestro Test",
      path: tmpDir,
      defaultBranch: "main"
    });
  });

  afterEach(() => {
    try {
      database.close();
    } catch (_) {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists compact project-scoped conversation context across surfaces", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });

    const dashResp = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que as tarefas estao paradas?"
    });

    expect(dashResp.projectKey).toBe("maestro");
    expect(dashResp.surface).toBe("dashboard");
    // Short natural reply: both branches (stuck or not) mention stalled work.
    expect(dashResp.explanation.toLowerCase()).toContain("stalled");

    const tgResp = await chatService.ask({
      projectKey: "maestro",
      surface: "telegram",
      message: "Qual o estado dos provedores?"
    });

    expect(tgResp.surface).toBe("telegram");

    const history = await chatService.getHistory("maestro", 50);
    expect(history.length).toBe(4); // 2 user messages + 2 orchestrator responses
    expect(history[0].surface).toBe("dashboard");
    expect(history[0].senderRole).toBe("user");
    expect(history[1].senderRole).toBe("orchestrator");
    expect(history[2].surface).toBe("telegram");
    expect(history[2].senderRole).toBe("user");
  });

  it("uses persisted conversation history when the deterministic fallback is active", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Estamos revisando o projeto RepuFin e mantendo a lista de compras.",
      uiLocale: "pt-BR"
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Você consegue resgatar o contexto do que foi falado no chat?",
      uiLocale: "pt-BR"
    });

    expect(response.explanation).toContain("Sim, consigo recuperar o histórico");
    expect(response.explanation).toContain("RepuFin");
  });

  it("persists Full Access on the selected conversation", () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const thread = chatService.createThread("maestro", "Access test", "standard");

    const updated = chatService.selectThreadAccessMode("maestro", thread.id, "full");

    expect(updated.id).toBe(thread.id);
    expect(updated.accessMode).toBe("full");
    expect(chatService.listThreads("maestro").find((item) => item.id === thread.id)?.accessMode).toBe("full");
  });

  it("injects the selected conversation Skill into the provider prompt", async () => {
    let seen: Parameters<AgentProvider["execute"]>[0] | undefined;
    const provider = chatProvider("codex", {
      outcome: "completed",
      summary: "answered",
      output: "Oi! Como posso ajudar?",
      error: null,
      retryable: false
    }, { onExecute: (request) => { seen = request; } });
    const skillContext = {
      available: [],
      loaded: [{
        qualifiedName: "repository:conversation",
        versionId: "sha256:conversation",
        triggerReason: "Implicit metadata match for conversation.",
        instructions: "CONVERSATION SKILL INSTRUCTIONS"
      }],
      selectionMode: "deterministic_metadata" as const,
      selectionNote: "Selected by conversation capability."
    };
    const chatService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: tmpDir,
      skillRuntime: {
        prepareContext: (request) => {
          expect(request).toMatchObject({
            runId: null,
            phase: "conversation",
            capability: "conversation",
            projectKey: "maestro"
          });
          return skillContext;
        }
      },
      skillProjectKey: "maestro"
    });

    await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Oi"
    });

    expect(seen?.skillContext).toEqual(skillContext);
    expect(seen?.humanFeedback).toContain("CONVERSATION SKILL INSTRUCTIONS");
  });

  it("exposes conversation activity while a provider is still responding", async () => {
    let markStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const provider = chatProvider("codex", {
      outcome: "completed",
      summary: "answered",
      output: "Resposta concluída.",
      error: null,
      retryable: false
    }, {
      execute: async () => {
        markStarted();
        await providerRelease;
        return {
          outcome: "completed",
          summary: "answered",
          output: "Resposta concluída.",
          error: null,
          retryable: false,
          durationMs: 1
        };
      }
    });
    const chatService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: tmpDir
    });
    const thread = chatService.createThread("maestro", "Em andamento");
    const pending = chatService.ask({ projectKey: "maestro", threadId: thread.id, surface: "dashboard", message: "Olá" });

    await started;
    expect(chatService.getActivity("maestro", thread.id)).toMatchObject({ active: true });
    releaseProvider();
    await pending;
    expect(chatService.getActivity("maestro", thread.id)).toMatchObject({ active: false, startedAt: null, phase: "idle" });
    expect(chatService.getActivityEvents("maestro", thread.id).map((event) => event.phase)).toEqual(
      expect.arrayContaining(["thinking", "finished"])
    );
    expect(chatService.getActivityEvents("maestro", thread.id).at(-1)).toMatchObject({ active: false, phase: "finished" });
  });

  it("keeps chat history isolated per conversation and supports deletion", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const first = chatService.createThread("maestro", "Primeira conversa");
    const second = chatService.createThread("maestro", "Segunda conversa");

    await chatService.ask({
      projectKey: "maestro",
      threadId: first.id,
      surface: "dashboard",
      message: "Oi na primeira conversa"
    });
    await chatService.ask({
      projectKey: "maestro",
      threadId: second.id,
      surface: "dashboard",
      message: "Oi na segunda conversa"
    });

    expect(chatService.listThreads("maestro")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, title: "Primeira conversa", messageCount: 2 }),
        expect.objectContaining({ id: second.id, title: "Segunda conversa", messageCount: 2 })
      ])
    );
    expect((await chatService.getHistory("maestro", 50, first.id)).every((message) => message.threadId === first.id)).toBe(true);
    expect((await chatService.getHistory("maestro", 50, second.id)).every((message) => message.threadId === second.id)).toBe(true);

    expect(chatService.deleteThread("maestro", first.id)).toBe(true);
    expect(chatService.deleteThread("maestro", first.id)).toBe(false);
    expect(chatService.listThreads("maestro").map((thread) => thread.id)).not.toContain(first.id);
  });

  it("gathers empirical evidence and identifies governed next actions without inventing state", async () => {
    const task = database.createTask("Implement safe operational chat", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que a task estah bloqueada?"
    });

    expect(response.explanation).toContain(`#${task.id}`);
    expect(response.explanation).toContain("blocked");

    expect(response.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "retry_task",
          targetId: task.id
        })
      ])
    );
  });

  it("answers a casual greeting naturally without dumping task actions", async () => {
    const task = database.createTask("A blocked task should not hijack a greeting", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Oi"
    });

    expect(response.explanation.toLowerCase()).toMatch(/hi|help/);
    expect(response.explanation).not.toContain("task(s) ativa(s)");
    expect(response.actions).toEqual([]);
  });

  it("supports a standalone Maestro conversation without a project", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "",
      surface: "dashboard",
      message: "Oi, quais providers posso usar?"
    });

    expect(response.projectKey).toBe("__maestro__");
    expect(response.evidence.project.name).toBe("Maestro (general)");
    expect((await chatService.listThreads("")).length).toBe(1);
    expect((await chatService.getHistory("", 20)).length).toBe(2);
  });

  it("enforces chat access modes in the core, not only in the UI", async () => {
    const task = database.createTask("Cancelar uma task de teste", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });

    const standard = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que a task está bloqueada?",
      accessMode: "standard"
    });
    expect(standard.actions.some((action) => action.type === "cancel_task")).toBe(false);

    const full = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que a task está bloqueada?",
      accessMode: "full"
    });
    const cancel = full.actions.find((action) => action.type === "cancel_task");
    expect(cancel).toBeDefined();

    const readOnly = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Quais tasks existem?",
      accessMode: "read_only"
    });
    expect(readOnly.actions).toEqual([]);
    await expect(chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "read_only",
      action: cancel!
    })).rejects.toThrow(/read-only/i);
  });

  it("takes a coded project from install to managed server and browser URL", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "chat-runner-test",
      version: "1.0.0",
      scripts: { dev: "node -e \"console.log('Local: http://127.0.0.1:4555/'); setInterval(() => {}, 1000)\"" }
    }), "utf8");
    const processManager = new ProjectProcessManager();
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir, processManager });

    try {
      const started = await chatService.ask({
        projectKey: "maestro",
        surface: "dashboard",
        message: "start project",
        accessMode: "full"
      });
      expect(started.evidence.commands.map((command) => command.command)).toEqual(expect.arrayContaining(["npm install", "npm run dev"]));
      expect(started.evidence.processes).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "running", pid: expect.any(Number), url: "http://127.0.0.1:4555/" })
      ]));

      const open = await chatService.ask({
        projectKey: "maestro",
        surface: "dashboard",
        message: "open project in browser",
        accessMode: "full"
      });
      const openAction = open.actions.find((action) => action.type === "open_project_browser");
      expect(openAction).toBeDefined();
      expect(await chatService.executeAction({
        projectKey: "maestro",
        surface: "dashboard",
        accessMode: "full",
        action: openAction!
      })).toMatchObject({ success: true });

      const stopRequest = await chatService.ask({
        projectKey: "maestro",
        surface: "dashboard",
        message: "stop server",
        accessMode: "full"
      });
      const stopAction = stopRequest.actions.find((action) => action.type === "stop_project_process");
      expect(stopAction).toBeDefined();
      expect(await chatService.executeAction({
        projectKey: "maestro",
        surface: "dashboard",
        accessMode: "full",
        action: stopAction!
      })).toMatchObject({ success: true });
      expect(processManager.list("maestro")[0]?.status).toBe("stopped");
    } finally {
      chatService.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  it("executes an explicit natural-language dev-server request in Full Access", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "chat-natural-command-test",
      version: "1.0.0",
      scripts: { dev: "node -e \"console.log('Local: http://127.0.0.1:4556/'); setInterval(() => {}, 1000)\"" }
    }), "utf8");
    const processManager = new ProjectProcessManager();
    let providerPrompt = "";
    const provider = chatProvider("claude", {
      outcome: "completed",
      summary: "reported evidence",
      output: "O servidor foi iniciado conforme a evidência.",
      error: null,
      retryable: false
    }, { onExecute: (request) => { providerPrompt = request.humanFeedback ?? ""; } });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([provider]),
      processManager
    });

    try {
      const response = await chatService.ask({
        projectKey: "maestro",
        surface: "dashboard",
        message: "eu quero que você dê npm run dev para mim",
        accessMode: "full"
      });

      expect(response.evidence.commands).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "npm run dev", status: "completed" })
      ]));
      expect(response.evidence.processes).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "running", url: "http://127.0.0.1:4556/" })
      ]));
      expect(providerPrompt).toContain("Full Access rule");
      expect(providerPrompt).not.toContain("wait for the confirmation button");
    } finally {
      chatService.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  it("runs an agent-requested dev server in the background and does not duplicate it", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "chat-agent-server-test",
      version: "1.0.0",
      scripts: { dev: "node -e \"console.log('Local: http://127.0.0.1:4557/'); setInterval(() => {}, 1000)\"" }
    }), "utf8");
    const processManager = new ProjectProcessManager();
    let calls = 0;
    const provider = chatProvider("claude", {
      outcome: "completed",
      summary: "completed",
      output: "",
      error: null,
      retryable: false
    }, {
      execute: async () => {
        calls += 1;
        const turn = calls === 1
          ? { type: "tool_call", name: "run_command", arguments: { command: "npm run dev" } }
          : { type: "final", response: "O servidor está ativo em background." };
        return {
          outcome: "completed",
          summary: "completed",
          output: JSON.stringify(turn),
          structuredPayload: turn,
          error: null,
          retryable: false,
          durationMs: 1
        };
      }
    });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([provider]),
      processManager
    });

    try {
      const response = await chatService.ask({
        projectKey: "maestro",
        surface: "dashboard",
        message: "A task terminou, reinicie o serviço para eu testar.",
        accessMode: "full"
      });

      expect(response.evidence.commands).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "npm run dev", status: "completed" })
      ]));
      expect(response.evidence.processes).toEqual([
        expect.objectContaining({ status: "running", url: "http://127.0.0.1:4557/" })
      ]);
      expect(processManager.list("maestro")).toHaveLength(1);

      const sameProcess = processManager.start("maestro", tmpDir, planProjectStartCommand(tmpDir, "full"));
      expect(sameProcess.id).toBe(processManager.list("maestro")[0]?.id);
      expect(processManager.list("maestro")).toHaveLength(1);
    } finally {
      chatService.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  it("exposes resume from checkpoint for a blocked goal instead of only restarting the task", async () => {
    const task = database.createTask("Continue the financial app implementation", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "implementing",
      stepCount: 6,
      lastError: "provider permission denied"
    });

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Continue a task bloqueada do checkpoint"
    });

    expect(response.evidence.goals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: run.id, taskId: task.id, status: "blocked", phase: "implementing" })
      ])
    );
    expect(response.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "resume_goal", targetId: run.id })
      ])
    );
    expect(response.actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "retry_task", targetId: task.id })
      ])
    );
  });

  it("uses recent user context to interpret an acknowledgement as a recovery command", () => {
    expect(isRecoveryRequest("acho que agora você consegue", ["tente novamente desbloquear essa task"])).toBe(true);
    expect(isRecoveryRequest("acho que agora você consegue", ["qual é o status do projeto?"])).toBe(false);
  });

  it("interprets an explicit unblock request and resumes the only blocked Goal automatically", async () => {
    const task = database.createTask("Continue the financial app implementation", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "implementing",
      stepCount: 6,
      lastError: "provider permission denied",
      failureCategory: "permission_denied"
    });
    const resumed: number[] = [];
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      actionExecutor: {
        resumeGoal: (runId) => resumed.push(runId)
      }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "full",
      message: "Tente novamente desbloquear, fiz uns ajustes no Maestro."
    });

    expect(resumed).toEqual([run.id]);
    expect(response.explanation).toContain(`Goal #${run.id} for Task #${task.id} resumed`);
    expect(response.actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "resume_goal", targetId: run.id })
      ])
    );
  });

  it("carries a prior recovery request into a short follow-up acknowledgement", async () => {
    const task = database.createTask("Continue the financial app implementation", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "implementing",
      stepCount: 6,
      lastError: "provider permission denied",
      failureCategory: "permission_denied"
    });
    const resumed: number[] = [];
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      actionExecutor: {
        resumeGoal: (runId) => resumed.push(runId)
      }
    });

    await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "tente novamente desbloquear essa task"
    });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "full",
      message: "acho que agora você consegue"
    });

    expect(resumed).toEqual([run.id]);
    expect(response.explanation).toContain(`Goal #${run.id} for Task #${task.id} resumed`);
  });

  it("executes safe governed actions directly from chat", async () => {
    const task = database.createTask("Fix broken task", "test", "maestro");
    database.updateTaskStatus(task.id, "failed");

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const initial = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Como resolver a task com falha?"
    });

    const retryAction = initial.actions.find((a) => a.type === "retry_task");
    expect(retryAction).toBeDefined();

    const actionResult = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: retryAction!
    });

    expect(actionResult.success).toBe(true);
    expect(actionResult.resultSummary).toContain(`Task #${task.id} restarted`);

    const updatedTask = database.getTask(task.id);
    expect(updatedTask.status).toBe("queued");

    const history = await chatService.getHistory("maestro", 50);
    const systemMsg = history.find((m) => m.senderRole === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.messageText).toContain("Task #");

    const staleActionResult = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: retryAction!
    });
    expect(staleActionResult.success).toBe(false);
    expect(staleActionResult.resultSummary).toContain("no longer applicable");
  });

  it("offers and executes Start Goal for a queued task through chat", async () => {
    const task = database.createTask("Implement queued change", "test", "maestro");
    const startedTaskIds: number[] = [];
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      actionExecutor: {
        startGoal: (taskId) => { startedTaskIds.push(taskId); }
      }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Inicie o goal da task que está na fila",
      uiLocale: "pt-BR"
    });
    const startAction = response.actions.find((action) => action.type === "start_goal" && action.targetId === task.id);
    expect(startAction).toBeDefined();

    const result = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: startAction!,
      uiLocale: "pt-BR"
    });

    expect(result.success).toBe(true);
    expect(startedTaskIds).toEqual([task.id]);
    expect(result.resultSummary).toContain(`Goal da Task #${task.id} iniciado`);
  });

  it("recognizes the task wording used by users and queues it only after confirmation", async () => {
    const longObjective = "A ideia inicial é fazer um projeto de controle de finanças, organizar gastos do apartamento e acompanhar investimentos.";
    expect(parseTaskCreationIntent(`Crie essa task: ${longObjective}`)?.text).toBe(longObjective);
    expect(parseTaskCreationIntent(`eu quero criar a task, não estou pedindo análise: ${longObjective}`)?.text).toBe(longObjective);
    expect(parseTaskCreationIntent("Quero Criar um projeto de controle de finanças, organizar meu salario e as despesas etc")?.text)
      .toBe("um projeto de controle de finanças, organizar meu salario e as despesas etc");

    const createdTaskIds: number[] = [];
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      actionExecutor: { taskCreated: (taskId) => { createdTaskIds.push(taskId); } }
    });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: `Crie essa task: ${longObjective}`
    });

    const createAction = response.actions.find((action) => action.type === "create_task");
    expect(createAction).toBeDefined();
    expect(createAction?.payload?.title).toBeTruthy();
    expect(String(createAction?.payload?.specification)).toContain("## Acceptance criteria");
    expect(database.listTasks(20)).toHaveLength(0);
    expect(response.explanation).toContain("Create task");

    const actionResult = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: createAction!
    });
    expect(actionResult.success).toBe(true);
    expect(actionResult.resultSummary).toContain("added to the queue");
    expect(createdTaskIds).toHaveLength(1);
    expect(database.getTask(createdTaskIds[0]).text).toBe(longObjective);
    expect(database.listEventsForTask(createdTaskIds[0]).some((event) => (
      event.type === "task.workspace_access_approved"
      && event.metadata?.scope === "task_worktree"
    ))).toBe(true);
    const repeatedActionResult = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: createAction!
    });
    expect(repeatedActionResult.success).toBe(true);
    expect(repeatedActionResult.resultSummary).toContain("already");
    expect(database.listTasks(20)).toHaveLength(1);
    expect(parseTaskCreationIntent("Crie essa task: Task #6 waiting for provider @myfinance")).toBeNull();
    const prior = [
      { senderRole: "user" as const, messageText: "Melhorar a interface do projeto para deixar o fluxo de edição mais simples e previsível para o usuário." },
      { senderRole: "orchestrator" as const, messageText: "A Task #6 foi interrompida e está blocked por permission denied; uma nova task poderá ser criada depois." }
    ];
    expect(parseTaskCreationIntent("Crie a tarefa conforme alinhamos o chat para esse projeto.", prior)?.text)
      .toContain("Melhorar a interface do projeto");

    const formattedIncident = [
      { senderRole: "user" as const, messageText: "Melhorar a interface do projeto para deixar o fluxo de edição mais simples e previsível para o usuário." },
      { senderRole: "orchestrator" as const, messageText: "A **Task #7** foi interrompida e está com status **blocked** por permission denied. ### 3. Como Proceder - Para implementar as melhorias, escolha outro provider." }
    ];
    expect(parseTaskCreationIntent("Crie a tarefa conforme alinhamos o chat para esse projeto.", formattedIncident)?.text)
      .toContain("Melhorar a interface do projeto");
    expect(parseTaskCreationIntent("Crie essa task: A **Task #7** foi interrompida e está com status **blocked** por permission denied. ### 3. Como Proceder - Para implementar as melhorias, escolha outro provider.")).toBeNull();
  });

  it("offers an explicit provider switch for an existing Goal instead of creating another task", async () => {
    const task = database.createTask("Implement the financial app", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "blocked", currentPhase: "implementing", stepCount: 3, lastError: "provider permission denied" });
    const switched: Array<{ runId: number; providerId: string }> = [];
    const codex = chatProvider("codex", {
      outcome: "completed",
      summary: "ready",
      output: "ready",
      error: null,
      retryable: false
    }, { capabilities: ["coding", "conversation"] });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([codex]),
      actionExecutor: {
        switchGoalProvider: (runId, providerId) => switched.push({ runId, providerId })
      }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "Troque o provider desta task para codex e continue do checkpoint."
    });
    const action = response.actions.find((item) => item.type === "switch_goal_provider");
    expect(action).toBeDefined();
    expect(response.actions).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "create_task" })]));

    const result = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "full",
      action: action!
    });
    expect(result.success).toBe(true);
    expect(switched).toEqual([{ runId: run.id, providerId: "codex" }]);
  });

  it("recognizes Gemini and reencaminhamento language when switching a Goal provider", async () => {
    const task = database.createTask("Implement the financial app", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "blocked", currentPhase: "implementing", stepCount: 3, lastError: "provider unavailable" });
    const antigravity = chatProvider("antigravity", {
      outcome: "completed",
      summary: "ready",
      output: "ready",
      error: null,
      retryable: false
    }, { capabilities: ["coding", "conversation"] });
    const switched: Array<{ runId: number; providerId: string }> = [];
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([antigravity]),
      actionExecutor: {
        switchGoalProvider: (runId, providerId) => switched.push({ runId, providerId })
      }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "Reencaminhe a execução desta task para Gemini e continue do checkpoint."
    });
    const action = response.actions.find((item) => item.type === "switch_goal_provider");
    expect(action).toMatchObject({ type: "switch_goal_provider", targetId: run.id });

    const result = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "full",
      action: action!
    });
    expect(result.success).toBe(true);
    expect(switched).toEqual([{ runId: run.id, providerId: "antigravity" }]);
  });

  it("does not offer an explicitly requested provider that is offline", async () => {
    const task = database.createTask("Implement the financial app", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "waiting_provider");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "waiting_provider", currentPhase: "implementing", stepCount: 3 });
    const codex = chatProvider("codex", {
      outcome: "completed", summary: "ready", output: "ready", error: null, retryable: false
    }, { capabilities: ["coding", "conversation"], healthState: "offline" });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([codex]),
      actionExecutor: { switchGoalProvider: () => undefined }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "Troque para codex e continue a task."
    });

    expect(response.actions.some((item) => item.type === "switch_goal_provider" && item.targetId === run.id)).toBe(false);
  });

  it("offers every ready provider for a stopped Goal without the user naming one", async () => {
    const task = database.createTask("Implement the financial app", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "waiting_provider", currentPhase: "implementing", stepCount: 3, lastError: "Codex failed", lastProvider: "codex" });
    const ready = { outcome: "completed" as const, summary: "ready", output: "ready", error: null, retryable: false };
    const codex = chatProvider("codex", ready, { capabilities: ["coding", "conversation"] });
    const antigravity = chatProvider("antigravity", ready, { capabilities: ["coding", "conversation"] });
    const reviewer = chatProvider("claude", ready, { capabilities: ["reviewing", "conversation"] });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([codex, antigravity, reviewer]),
      actionExecutor: { switchGoalProvider: () => undefined }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "A task travou de novo, o que eu faço?"
    });

    const offered = response.actions
      .filter((item) => item.type === "switch_goal_provider" && item.targetId === run.id)
      .map((item) => item.payload?.providerId)
      .sort();
    // Only providers able to implement are offered; the reviewing-only one is not.
    expect(offered).toEqual(["antigravity"]);
  });

  it("does not suggest any provider that already failed in the stopped Goal phase", async () => {
    const task = database.createTask("recover implementation after providers fail", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "waiting_provider", currentPhase: "implementing", stepCount: 4, lastProvider: "antigravity" });
    for (const providerId of ["codex", "antigravity", "claude"]) {
      const step = database.createGoalStep(run.id, "implementing", providerId);
      database.finishGoalStep({
        id: step.id,
        status: "failed",
        summary: `${providerId} failed`,
        output: "",
        error: `${providerId} failed`,
        durationMs: 1
      });
    }
    const ready = { outcome: "completed" as const, summary: "ready", output: "ready", error: null, retryable: false };
    const codex = chatProvider("codex", ready, { capabilities: ["coding", "conversation"] });
    const antigravity = chatProvider("antigravity", ready, { capabilities: ["coding", "conversation"] });
    const claude = chatProvider("claude", ready, { capabilities: ["coding", "conversation"] });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([codex, antigravity, claude]),
      actionExecutor: { switchGoalProvider: () => undefined }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "Como posso recuperar a task?"
    });

    expect(response.actions.some((item) => item.type === "switch_goal_provider" && item.targetId === run.id)).toBe(false);
  });

  it("does not classify a blocked step as a provider failure", async () => {
    const task = database.createTask("recover a blocked implementation", "dashboard", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "blocked", currentPhase: "implementing", stepCount: 2, lastProvider: "antigravity" });
    const blockedStep = database.createGoalStep(run.id, "implementing", "codex");
    database.finishGoalStep({
      id: blockedStep.id,
      status: "blocked",
      summary: "Waiting for environment approval",
      output: "",
      error: "environment approval required",
      durationMs: 1
    });
    const ready = { outcome: "completed" as const, summary: "ready", output: "ready", error: null, retryable: false };
    const codex = chatProvider("codex", ready, { capabilities: ["coding", "conversation"] });
    const antigravity = chatProvider("antigravity", ready, { capabilities: ["coding", "conversation"] });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([codex, antigravity]),
      actionExecutor: { switchGoalProvider: () => undefined }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "Como continuo esse goal bloqueado?"
    });

    const offered = response.actions
      .filter((item) => item.type === "switch_goal_provider" && item.targetId === run.id)
      .map((item) => item.payload?.providerId);
    expect(offered).toContain("codex");
  });

  it("does not offer provider switches for a Goal that is running normally", async () => {
    const task = database.createTask("Implement the financial app", "dashboard", "maestro");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "running", currentPhase: "implementing", stepCount: 1 });
    const codex = chatProvider("codex", { outcome: "completed", summary: "ready", output: "ready", error: null, retryable: false }, { capabilities: ["coding", "conversation"] });
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      agentRegistry: new AgentRegistry([codex]),
      actionExecutor: { switchGoalProvider: () => undefined }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "standard",
      message: "Como está a task?"
    });

    expect(response.actions.some((item) => item.type === "switch_goal_provider")).toBe(false);
  });

  it("parses explicit local and remote project creation without treating task requests as projects", () => {
    expect(parseProjectCreationIntent("Crie um projeto chamado finance em C:\\Users\\evers\\projects\\finance"))
      .toMatchObject({ key: "finance", path: "C:\\Users\\evers\\projects\\finance" });
    expect(parseProjectCreationIntent("Clone https://github.com/example/finance.git como finance branch develop"))
      .toMatchObject({ key: "finance", remoteUrl: "https://github.com/example/finance.git", defaultBranch: "develop" });
    expect(parseProjectCreationIntent("Crie uma task para o projeto finance"))
      .toBeNull();
  });

  it.each(["dashboard", "telegram"] as const)("creates a local bootstrap commit without publishing a chat-created project via %s", async (surface) => {
    const remotePath = path.join(tmpDir, `finance-${surface}.git`);
    const projectPath = path.join(tmpDir, "new-project");
    fs.mkdirSync(projectPath);
    expect(runGit(["init", "--bare", remotePath], tmpDir).ok).toBe(true);
    expect(runGit(["init", "-b", "main"], projectPath).ok).toBe(true);
    expect(runGit(["remote", "add", "origin", remotePath], projectPath).ok).toBe(true);
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    bootstrapOptionsSpy.mockClear();
    const response = await chatService.ask({
      projectKey: "maestro",
      surface,
      accessMode: "standard",
      message: `Crie um projeto chamado finance em ${projectPath}`
    });

    const action = response.actions.find((item) => item.type === "create_project");
    expect(action).toBeDefined();
    const result = await chatService.executeAction({
      projectKey: "maestro",
      surface,
      accessMode: "standard",
      action: action!
    });

    expect(result.success).toBe(true);
    expect(result.resultSummary).toContain("no branch was published");
    expect(database.findProjectByKey("finance")?.path).toBe(projectPath);
    expect(database.listOperationalChatMemories("finance").some((memory) => memory.text.includes("finance"))).toBe(true);
    expect(runGit(["rev-parse", "--verify", "HEAD"], projectPath).ok).toBe(true);
    expect(runGit(["for-each-ref", "--format=%(refname)"], remotePath).stdout.trim()).toBe("");
    expect(bootstrapOptionsSpy).toHaveBeenCalledWith({ push: false });
  });

  it("creates an explicitly requested task directly in Full Access", async () => {
    const request = "A partir disso analise o projeto e crie uma task para o Maestro rodar: simplificar o fluxo de despesas e dividir o saldo entre os moradores.";
    expect(parseTaskCreationIntent(request)?.text).toBe(request);
    expect(parseTaskCreationIntent("não crie uma task agora, apenas explique a ideia")).toBeNull();

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: request,
      accessMode: "full"
    });

    expect(database.listTasks(20)).toHaveLength(1);
    expect(database.getTask(1).specification).toContain("## Validation");
    expect(response.explanation).toMatch(/Task #\d+ (?:created for|criada para) @maestro/);
    expect(response.actions.some((action) => action.type === "create_task")).toBe(false);
  });

  it("uses the previous user context when task creation is requested as a follow-up", async () => {
    const context = "Quero um sistema simples para dividir as contas do apartamento entre os moradores, registrar quem pagou cada despesa e reduzir automaticamente a dívida de quem ainda precisa pagar sua parte.";
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const thread = chatService.createThread("maestro", "Context task");
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "maestro",
      surface: "dashboard",
      senderRole: "user",
      messageText: context
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      threadId: thread.id,
      surface: "dashboard",
      message: "eu estou pedindo para você criar uma task nova, eu te mandei o contexto",
      accessMode: "full"
    });

    const task = database.listTasks(20)[0];
    expect(task?.text).toBe(context);
    expect(task?.specification).toContain("## Objective");
    expect(task?.specification).toContain("## Constraints");
    expect(response.explanation).toMatch(/Task #\d+ (?:created for|criada para)/);
  });

  it("uses the Maestro synthesis when the user says to create a task from that explanation", () => {
    const synthesis = "Olá! Analisei a problemática. O objetivo é simplificar o sistema, implementar a divisão automática das dívidas entre moradores, registrar comprovantes, manter uma lista de compras e organizar avaliações de restaurantes. Esse é o escopo para começar a implementação.";
    const result = parseTaskCreationIntent(
      "sim, a partir disso crie uma task para começar a implementar",
      [
        { senderRole: "user", messageText: "veja a mensagem que usei explicando a problemática" },
        { senderRole: "orchestrator", messageText: synthesis }
      ]
    );
    expect(result?.text).toBe(synthesis);
  });

  it("compiles older turns into working memory while keeping the recent transcript", () => {
    const messages = Array.from({ length: 24 }, (_, index) => ({
      id: index + 1,
      threadId: 1,
      projectKey: "maestro",
      surface: "dashboard" as const,
      senderRole: index % 2 === 0 ? "user" as const : "orchestrator" as const,
      messageText: index === 0
        ? "Quero simplificar o sistema de despesas do apartamento, dividir automaticamente o saldo entre moradores e manter uma lista de compras."
        : `Mensagem de acompanhamento ${index} sobre o projeto e a implementação do fluxo.`,
      evidenceJson: null,
      actionTaken: null,
      providerId: null,
      model: null,
      createdAt: new Date(index * 1000).toISOString()
    }));

    const context = compileOperationalChatContext(messages, [], { recentMessageCount: 8 });
    expect(context.recentMessages).toHaveLength(8);
    expect(context.workingMemory.objective).toContain("simplificar o sistema de despesas");
    expect(context.promptText).toContain("COMPILED WORKING MEMORY");
  });

  it("uses the synthesized brief for an automatic Full Access task", async () => {
    const synthesis = "Olá! Analisei a problemática. O objetivo é simplificar o sistema, implementar a divisão automática das dívidas entre moradores, registrar comprovantes, manter uma lista de compras e organizar avaliações de restaurantes. Esse é o escopo para começar a implementação.";
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const thread = chatService.createThread("maestro", "Synthesized task");
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "maestro",
      surface: "dashboard",
      senderRole: "user",
      messageText: "veja a mensagem que usei explicando a problemática"
    });
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "maestro",
      surface: "dashboard",
      senderRole: "orchestrator",
      messageText: synthesis
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      threadId: thread.id,
      surface: "dashboard",
      message: "sim, a partir disso crie uma task para começar a implementar",
      accessMode: "full"
    });

    expect(database.listTasks(20)[0]?.text).toBe(synthesis);
    expect(response.explanation).toMatch(/Task #\d+ (?:created for|criada para)/);
  });

  it("does not answer a context-to-task interpretation request as a new conversation", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const thread = chatService.createThread("maestro", "Interpret task");
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "maestro",
      surface: "dashboard",
      senderRole: "user",
      messageText: "Quero simplificar o sistema de despesas, dividir automaticamente as dívidas entre moradores e manter uma lista de compras."
    });
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "maestro",
      surface: "dashboard",
      senderRole: "orchestrator",
      messageText: "Entendi o objetivo do projeto: simplificar o sistema de despesas, dividir automaticamente as dívidas entre moradores e manter uma lista de compras para começar a implementação."
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      threadId: thread.id,
      surface: "dashboard",
      uiLocale: "pt-BR",
      message: "veja aí o que estávamos falando para interpretar e ver qual task é para ser criada"
    });

    expect(response.explanation).toContain("interpretar a conversa");
    expect(response.explanation).toContain("simplificar o sistema de despesas");
    expect(response.explanation).not.toContain("Me conte um pouco mais");
  });

  it("falls back to the next conversation provider after a headless provider failure", async () => {
    const antigravity = chatProvider("antigravity", {
      outcome: "failed",
      summary: "permission check failed in headless mode",
      output: "",
      error: "user denied permission",
      retryable: false
    });
    const claude = chatProvider("claude", {
      outcome: "completed",
      summary: "Claude answered",
      output: "Consegui consultar o estado com o Claude.",
      error: null,
      retryable: false
    });
    const registry = new AgentRegistry([antigravity, claude]);
    const chatService = new OperationalChatService({
      database,
      agentRegistry: registry,
      worktreesRoot: tmpDir
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Qual provider está pronto agora?"
    });

    expect(response.providerId).toBe("claude");
    expect(response.explanation).toContain("Claude");
  });

  it("honors paused or disabled providers and excludes Codex when Codex is paused or disabled", async () => {
    const fakeCodex = {
      id: "codex" as const,
      label: "Codex Adapter",
      capabilities: new Set(["conversation" as const]),
      health: async () => ({ state: "ready" as const, detail: "Codex active", checkedAt: new Date().toISOString() }),
      execute: async () => ({
        outcome: "completed" as const,
        summary: "Codex output",
        output: "Codex output",
        error: null,
        durationMs: 10,
        retryable: false
      })
    };
    const registry = new AgentRegistry([fakeCodex], undefined, undefined, database);

    // Pause/Disable Codex in Provider Control Plane
    registry.updateProviderControl({ providerId: "codex", mode: "paused", fallbackEnabled: true });

    const chatService = new OperationalChatService({
      database,
      agentRegistry: registry,
      worktreesRoot: tmpDir
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Status dos provedores?"
    });

    // Provider ID must NOT be codex because codex is paused!
    expect(response.providerId).not.toBe("codex");
    expect(response.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "unblock_provider",
          targetId: "codex"
        })
      ])
    );
  });

  it("reads bounded project files for chat while rejecting secrets and traversal", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "example.ts"), "export const projectAnswer = 'only-inside-project';\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".env"), "API_KEY=should-never-enter-chat\n", "utf8");
    const outsidePath = path.join(path.dirname(tmpDir), "outside-chat-secret.txt");
    fs.writeFileSync(outsidePath, "outside-content-must-not-be-read\n", "utf8");

    try {
      const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
      const evidence = await chatService.gatherEvidenceContext("maestro", "What is in src/example.ts? Also read ../outside-chat-secret.txt");
      const example = evidence.files.find((file) => file.path === "src/example.ts");
      expect(example?.content).toContain("only-inside-project");
      expect(evidence.files.some((file) => file.path === ".env")).toBe(false);
      expect(evidence.files.some((file) => file.content?.includes("outside-content"))).toBe(false);
      expect(evidence.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("unsafe file reference")
      ]));
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("grounds a provider response in code read from the registered project", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "answer.ts"), "export const answerOnlyInCode = 'project-grounded-answer';\n", "utf8");
    let providerPrompt = "";
    const provider = chatProvider("claude", {
      outcome: "completed",
      summary: "answered from project context",
      output: "The answer is in the project file.",
      error: null,
      retryable: false
    }, { onExecute: (request) => { providerPrompt = request.humanFeedback ?? ""; } });
    const chatService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: tmpDir
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "What is the value in src/answer.ts?"
    });

    expect(response.providerId).toBe("claude");
    expect(providerPrompt).toContain("project-grounded-answer");
    expect(providerPrompt).toContain("src/answer.ts");
  });

  it("lets the provider answer in an unlisted user language while keeping UI labels separate", async () => {
    let providerPrompt = "";
    const provider = chatProvider("claude", {
      outcome: "completed",
      summary: "answered in the user's language",
      output: "こんにちは！プロジェクトについてお手伝いします。",
      error: null,
      retryable: false
    }, { onExecute: (request) => { providerPrompt = request.humanFeedback ?? ""; } });
    const chatService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: tmpDir
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      uiLocale: "pt-BR",
      message: "プロジェクトの状態を教えてください。"
    });

    expect(response.explanation).toContain("こんにちは");
    expect(providerPrompt).toContain("Reply in the same language used by the user");
    expect(providerPrompt).not.toContain("natural Brazilian Portuguese");
    expect(providerPrompt).toContain("プロジェクトの状態を教えてください");
  });

  it("keeps governed UI labels in the selected interface language", async () => {
    const task = database.createTask("Uma task bloqueada para testar idioma da interface", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      uiLocale: "pt-BR",
      accessMode: "full",
      message: "Por que a task está bloqueada?"
    });

    expect(response.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "cancel_task", label: `Cancelar task #${task.id}` })
    ]));
  });

  it("persists only explicit project memory across new conversations", async () => {
    const prompts: string[] = [];
    const provider = chatProvider("claude", {
      outcome: "completed",
      summary: "answered with project memory",
      output: "Entendi o contexto salvo do projeto.",
      error: null,
      retryable: false
    }, { onExecute: (request) => { prompts.push(request.humanFeedback ?? ""); } });
    const chatService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: tmpDir
    });

    const firstThread = chatService.createThread("maestro", "Decisões");
    const first = await chatService.ask({
      projectKey: "maestro",
      threadId: firstThread.id,
      surface: "dashboard",
      message: "Decidimos que o padrão do dashboard é inglês."
    });
    expect(first.evidence.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "o padrão do dashboard é inglês", kind: "decision", sourceThreadId: firstThread.id })
    ]));

    const secondThread = chatService.createThread("maestro", "Nova conversa");
    const second = await chatService.ask({
      projectKey: "maestro",
      threadId: secondThread.id,
      surface: "dashboard",
      message: "Qual decisão sobre o idioma do dashboard você lembra?"
    });
    expect(second.evidence.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "o padrão do dashboard é inglês" })
    ]));
    expect(prompts.at(-1)).toContain("o padrão do dashboard é inglês");

    await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "read_only",
      message: "Guarde na memória que a senha é secreta."
    });
    expect(database.listOperationalChatMemories("maestro")).toHaveLength(1);
  });

  it("persists an explicit provider/model selection and never falls back from it", async () => {
    const selectedModels: string[] = [];
    const selectedEfforts: string[] = [];
    const claude = chatProvider("claude", {
      outcome: "completed",
      summary: "Claude answered",
      output: "Resposta do Claude selecionado.",
      error: null,
      retryable: false
    }, { models: ["claude-sonnet-4"], reasoningEfforts: ["low", "high"], onExecute: (request) => {
      selectedModels.push(request.model ?? "");
      selectedEfforts.push(request.effort ?? "");
    } });
    const codex = chatProvider("codex", {
      outcome: "completed",
      summary: "Codex answered",
      output: "Resposta do Codex.",
      error: null,
      retryable: false
    }, { models: ["gpt-5-codex"] });
    const registry = new AgentRegistry([codex, claude]);
    const chatService = new OperationalChatService({ database, agentRegistry: registry, worktreesRoot: tmpDir });
    const thread = chatService.createThread("maestro", "Seleção de provider");

    const response = await chatService.ask({
      projectKey: "maestro",
      threadId: thread.id,
      surface: "dashboard",
      message: "Explique o estado do projeto.",
      providerId: "claude",
      model: "claude-sonnet-4",
      effort: "high"
    });

    expect(response.providerId).toBe("claude");
    expect(response.model).toBe("claude-sonnet-4");
    expect(selectedModels).toEqual(["claude-sonnet-4"]);
    expect(selectedEfforts).toEqual(["high"]);
    expect(database.getOperationalChatThread(thread.id)).toEqual(expect.objectContaining({
      providerId: "claude",
      model: "claude-sonnet-4",
      effort: "high"
    }));
    expect((await chatService.getHistory("maestro", 20, thread.id)).at(-1)).toEqual(expect.objectContaining({
      providerId: "claude",
      model: "claude-sonnet-4"
    }));

    const failing = chatProvider("antigravity", {
      outcome: "failed",
      summary: "permission denied",
      output: "",
      error: "permission denied",
      retryable: false
    }, { models: ["gemini-3.7-flash-high"] });
    const fallback = chatProvider("codex", {
      outcome: "completed",
      summary: "Codex answered",
      output: "Fallback must not be used.",
      error: null,
      retryable: false
    }, { models: ["gpt-5-codex"] });
    const strictService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([failing, fallback]),
      worktreesRoot: tmpDir
    });
    const strictThread = strictService.createThread("maestro", "Sem fallback");
    const strictResponse = await strictService.ask({
      projectKey: "maestro",
      threadId: strictThread.id,
      surface: "dashboard",
      message: "Responda usando exatamente o provider escolhido.",
      providerId: "antigravity",
      model: "gemini-3.7-flash-high"
    });
    expect(strictResponse.providerId).toBe("antigravity");
    expect(strictResponse.explanation).toContain("No fallback was used");
    expect((await strictService.getHistory("maestro", 20, strictThread.id)).at(-1)?.providerId).toBe("antigravity");

    const incompatibleCodex = chatProvider("codex", {
      outcome: "failed",
      summary: "Codex failed",
      output: "",
      error: `2026 ERROR codex_models_manager::cache: failed to load models cache: unknown variant \`max\`, expected one of \`none\`, \`minimal\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`; body: {\"models\":[${"x".repeat(10_000)}]}`,
      retryable: false
    }, { models: ["gpt-5.6-luna"] });
    const conciseFailureService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([incompatibleCodex]),
      worktreesRoot: tmpDir
    });
    const conciseThread = conciseFailureService.createThread("maestro", "Erro de compatibilidade");
    const conciseFailure = await conciseFailureService.ask({
      projectKey: "maestro",
      threadId: conciseThread.id,
      surface: "dashboard",
      message: "Teste o Codex",
      providerId: "codex",
      model: "gpt-5.6-luna",
      uiLocale: "pt-BR"
    });
    expect(conciseFailure.explanation).toContain("atualize o Codex CLI");
    expect(conciseFailure.explanation).not.toContain('"models"');
    expect(conciseFailure.explanation.length).toBeLessThan(500);
  });

  it("offers governed or direct worktree code paths and verifies the direct change", async () => {
    expect(runGit(["init", "-b", "main"], tmpDir).ok).toBe(true);
    fs.writeFileSync(path.join(tmpDir, "README.md"), "chat code change test\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "test-maestro.db*\n.worktrees/\n", "utf8");
    expect(runGit(["add", "README.md", ".gitignore"], tmpDir).ok).toBe(true);
    expect(runGit(["-c", "user.name=Chat Test", "-c", "user.email=chat@test.local", "commit", "-m", "initial"], tmpDir).ok).toBe(true);
    const changedWorktreePaths: string[] = [];
    const provider = chatProvider("claude", {
      outcome: "completed",
      summary: "implemented",
      output: "Implemented in the worktree.",
      error: null,
      retryable: false
    }, {
      capabilities: ["conversation", "coding"],
      onExecute: (request) => {
        if (request.task.worktreePath) {
          fs.writeFileSync(path.join(request.task.worktreePath, "implemented.ts"), "export const implemented = true;\n", "utf8");
          changedWorktreePaths.push(request.task.worktreePath);
        }
      }
    });
    const createdTaskIds: number[] = [];
    const chatService = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: path.join(tmpDir, ".worktrees"),
      actionExecutor: { taskCreated: (taskId) => { createdTaskIds.push(taskId); } }
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Corrija o bug no arquivo src/demo.ts",
      providerId: "claude"
    });
    const worktreeAction = response.actions.find((action) => action.type === "code_change_worktree");
    const taskAction = response.actions.find((action) => action.type === "code_change_task");
    expect(worktreeAction).toBeDefined();
    expect(taskAction).toBeDefined();

    const direct = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: worktreeAction!,
      accessMode: "standard"
    });
    expect(direct.success).toBe(true);
    expect(direct.resultSummary).toContain("worktree");
    expect(changedWorktreePaths).toHaveLength(1);
    expect(fs.existsSync(path.join(changedWorktreePaths[0], "implemented.ts"))).toBe(true);
    expect(database.listTasks(10).some((task) => task.status === "awaiting_human")).toBe(true);

    const governed = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: taskAction!,
      accessMode: "standard"
    });
    expect(governed.success).toBe(true);
    expect(createdTaskIds).toHaveLength(1); // governed task is handed to the queue callback
    expect(database.listTasks(10).some((task) => task.status === "queued")).toBe(true);
  });

  it("serves operational chat endpoints through dashboard server", async () => {
    const mockConfig: MaestroConfig = {
      projectName: "maestro",
      databasePath: dbPath,
      worktreesPath: tmpDir,
      execution: { rootPath: tmpDir, worktreesPath: tmpDir, expectedNodeVersion: "22.12.0", supportedNodeRange: ">=22.12.0 <25" },
      dashboard: { enabled: true, host: "127.0.0.1", port: 0 },
      autopilot: { enabled: false, pollIntervalMs: 5000, maxConcurrentGoals: 1 },
      runtime: { tokenEfficient: true },
      workGraph: { adoptionMode: "off" },
      skills: {
        enabled: true,
        catalogPath: tmpDir,
        versionsPath: tmpDir,
        projectKey: "maestro",
        curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 60000 }
      },
      telegram: { botToken: "mock-token", allowedUserId: "123" }
    };

    const server = createDashboardServer({
      config: mockConfig,
      database
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // 1. Post message to /api/chat/ask
      const askRes = await fetch(`${baseUrl}/api/chat/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "maestro",
          message: "Qual o status do projeto?"
        })
      });

      expect(askRes.status).toBe(200);
      const askData = await askRes.json();
      expect(askData.explanation).toBeDefined();
      expect(askData.projectKey).toBe("maestro");
      expect(askData.threadId).toEqual(expect.any(Number));

      const chatProvidersRes = await fetch(`${baseUrl}/api/chat/providers`);
      expect(chatProvidersRes.status).toBe(200);
      expect((await chatProvidersRes.json()).providers).toEqual([]);

      const globalAskRes = await fetch(`${baseUrl}/api/chat/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Oi, preciso entender o Maestro." })
      });
      expect(globalAskRes.status).toBe(200);
      expect((await globalAskRes.json()).projectKey).toBe("__maestro__");

      // 1b. List and create conversation threads without mixing histories.
      const threadsRes = await fetch(`${baseUrl}/api/chat/threads?projectKey=maestro`);
      expect(threadsRes.status).toBe(200);
      const threadsData = await threadsRes.json();
      expect(threadsData.threads).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: askData.threadId, messageCount: 2 })])
      );

      const newThreadRes = await fetch(`${baseUrl}/api/chat/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "maestro", title: "Conversa isolada" })
      });
      expect(newThreadRes.status).toBe(201);
      const newThreadData = await newThreadRes.json();
      expect(newThreadData.thread.title).toBe("Conversa isolada");

      const deleteThreadRes = await fetch(
        `${baseUrl}/api/chat/threads/${newThreadData.thread.id}?projectKey=maestro`,
        { method: "DELETE" }
      );
      expect(deleteThreadRes.status).toBe(200);
      expect((await deleteThreadRes.json()).deleted).toBe(true);

      // 2. Fetch history from /api/chat/messages
      const getRes = await fetch(`${baseUrl}/api/chat/messages?projectKey=maestro`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.messages.length).toBe(2);

      // 3. Post action to /api/chat/action
      const actRes = await fetch(`${baseUrl}/api/chat/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "maestro",
          action: {
            id: "unblock_provider_claude",
            type: "unblock_provider",
            label: "Habilita Claude",
            description: "Habilita Claude",
            targetId: "claude"
          }
        })
      });

      expect(actRes.status).toBe(200);
      const actData = await actRes.json();
      expect(actData.resultSummary).toBeDefined();
    } finally {
      server.close();
    }
  });

  it("handles Telegram /chat and /chat_action commands", async () => {
    const mockConfig: MaestroConfig = {
      projectName: "maestro",
      databasePath: dbPath,
      worktreesPath: tmpDir,
      execution: { rootPath: tmpDir, worktreesPath: tmpDir, expectedNodeVersion: "22.12.0", supportedNodeRange: ">=22.12.0 <25" },
      dashboard: { enabled: false, host: "127.0.0.1", port: 0 },
      autopilot: { enabled: false, pollIntervalMs: 5000, maxConcurrentGoals: 1 },
      runtime: { tokenEfficient: true },
      workGraph: { adoptionMode: "off" },
      skills: {
        enabled: true,
        catalogPath: tmpDir,
        versionsPath: tmpDir,
        projectKey: "maestro",
        curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 60000 }
      },
      telegram: { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", allowedUserId: "123" }
    };

    const bot = createTelegramBot(mockConfig, database);
    expect(bot).toBeDefined();
  });
});

function chatProvider(id: string, result: {
  outcome: "completed" | "failed";
  summary: string;
  output: string;
  error: string | null;
  retryable: boolean;
}, options: { models?: string[]; reasoningEfforts?: AgentProvider["reasoningEfforts"]; capabilities?: AgentCapability[]; healthState?: "ready" | "offline"; onExecute?: (request: Parameters<AgentProvider["execute"]>[0]) => void; execute?: AgentProvider["execute"] } = {}): AgentProvider {
  return {
    id,
    label: id,
    capabilities: new Set(options.capabilities ?? ["conversation"]),
    health: async () => ({ state: options.healthState ?? "ready", detail: options.healthState ?? "ready", checkedAt: new Date().toISOString() }),
    models: async () => options.models ?? [],
    reasoningEfforts: options.reasoningEfforts,
    execute: async (request) => {
      if (options.execute) return options.execute(request);
      options.onExecute?.(request);
      return {
        ...result,
        durationMs: 1
      };
    }
  };
}
