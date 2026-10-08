import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type ProjectEcosystem =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "dotnet"
  | "ruby"
  | "php"
  | "elixir"
  | "dart"
  | "swift"
  | "container";

export type ProjectManifestEvidence = {
  path: string;
  directory: string;
  name: string;
  ecosystem: ProjectEcosystem;
};

export type ProjectObservedEvidence = {
  sourcePath: string;
  category: "file" | "manifest" | (string & {});
  ecosystem: ProjectEcosystem | "unknown";
  confidence: "observed";
};

export type ProjectDiscovery = {
  root: string;
  /** Existing project files visible to Git (or all files for a non-Git folder). */
  files: string[];
  manifests: ProjectManifestEvidence[];
  /** Directly observed inventory entries; this does not assign project roles. */
  evidence: ProjectObservedEvidence[];
  ecosystems: ProjectEcosystem[];
  scannedDirectories: number;
  truncated: boolean;
  warnings: string[];
};

export type ProjectDiscoveryOptions = {
  maxDepth?: number;
  maxDirectories?: number;
  /** Maximum files returned; defaults to 50,000. */
  maxFiles?: number;
  /** Maximum filesystem entries inspected; Git inventories count visible file entries. Defaults to 100,000. */
  maxEntries?: number;
};

const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_MAX_DIRECTORIES = 20_000;
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_ENTRIES = 100_000;
const IGNORED_DIRECTORIES = new Set([
  ".git", ".maestro", ".next", ".nuxt", ".pytest_cache", ".venv", ".vite",
  ".yarn", "__pycache__", "bin", "build", "coverage", "dist", "node_modules",
  "obj", "out", "target", "tmp", "temp", "venv", "vendor"
]);
const MAX_GIT_FILE_LIST_BYTES = 64 * 1024 * 1024;

/**
 * Inventories project manifests without inferring meaning from directory names.
 * Traversal is deterministic, bounded, and never follows symbolic links.
 */
export function discoverProject(rootPath: string, options: ProjectDiscoveryOptions = {}): ProjectDiscovery {
  const root = path.resolve(rootPath);
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxDirectories = positiveInteger(options.maxDirectories, DEFAULT_MAX_DIRECTORIES);
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const manifests: ProjectManifestEvidence[] = [];
  const warnings: string[] = [];
  const gitFiles = listGitVisibleFiles(root, maxDepth, maxDirectories, maxFiles, maxEntries);
  const inventory = gitFiles
    ? { files: gitFiles.files, scannedDirectories: gitFiles.scannedDirectories, truncated: gitFiles.truncated }
    : walkProjectFiles(root, maxDepth, maxDirectories, maxFiles, maxEntries, warnings);
  if (gitFiles) warnings.push(...gitFiles.warnings);
  const { files, scannedDirectories, truncated } = inventory;
  const evidence: ProjectObservedEvidence[] = [];
  for (const relative of files) {
    const ecosystem = ecosystemForManifest(path.posix.basename(relative));
    evidence.push({ sourcePath: relative, category: ecosystem ? "manifest" : "file", ecosystem: ecosystem ?? "unknown", confidence: "observed" });
    if (!ecosystem) continue;
    manifests.push({
      path: relative,
      directory: path.posix.dirname(relative) === "." ? "." : path.posix.dirname(relative),
      name: path.posix.basename(relative),
      ecosystem
    });
  }
  if (truncated && !warnings.some((warning) => warning.includes("safety limit"))) {
    warnings.push(`Project discovery reached its maximum depth of ${maxDepth}, directory limit of ${maxDirectories}, file limit of ${maxFiles}, or entry limit of ${maxEntries}; some paths were not inspected.`);
  }
  manifests.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    files,
    manifests,
    evidence,
    ecosystems: [...new Set(manifests.map((manifest) => manifest.ecosystem))].sort(),
    scannedDirectories,
    truncated,
    warnings
  };
}

/**
 * In Git worktrees, use the repository's own index/ignore rules as the file
 * boundary. This prevents ignored build output, fixtures and generated apps
 * from being treated as projects to provision. Non-Git folders remain usable.
 */
function listGitVisibleFiles(root: string, maxDepth: number, maxDirectories: number, maxFiles: number, maxEntries: number): {
  files: string[];
  scannedDirectories: number;
  truncated: boolean;
  warnings: string[];
} | null {
  const prefixResult = spawnSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000
  });
  if (prefixResult.status !== 0) {
    if (hasGitMetadataAncestor(root)) {
      return { files: [], scannedDirectories: 1, truncated: true, warnings: ["Could not inventory Git-visible project files; automatic project preparation is limited to prevent scanning ignored content."] };
    }
    return null;
  }

  const relativeRoot = String(prefixResult.stdout).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const listed = spawnSync("git", ["-C", root, "ls-files", "--full-name", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer", windowsHide: true, timeout: 15_000, maxBuffer: MAX_GIT_FILE_LIST_BYTES
  });
  if (listed.status !== 0 || listed.error) {
    return { files: [], scannedDirectories: 1, truncated: true, warnings: ["Could not inventory Git-visible project files; automatic project preparation is limited to prevent scanning ignored content."] };
  }

  const prefix = relativeRoot && relativeRoot !== "." ? `${relativeRoot}/` : "";
  const directories = new Set<string>(["."]);
  const files: string[] = [];
  let truncated = false;
  let fileLimitReached = false;
  let entryLimitReached = false;
  let inspectedEntries = 0;
  const listedFiles = Buffer.from(listed.stdout).toString("utf8").split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  for (const item of listedFiles) {
    if (prefix && !item.startsWith(prefix)) continue;
    const relative = prefix ? item.slice(prefix.length) : item;
    if (!relative || relative.split("/").some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()))) continue;
    if (inspectedEntries >= maxEntries) {
      truncated = true;
      entryLimitReached = true;
      break;
    }
    inspectedEntries += 1;
    const parts = relative.split("/");
    const depth = parts.length - 1;
    if (depth > maxDepth) {
      truncated = true;
      continue;
    }
    const absolute = path.join(root, ...parts);
    try {
      if (!fs.lstatSync(absolute).isFile()) continue;
    } catch {
      continue;
    }
    let relativeDirectory = ".";
    for (const part of parts.slice(0, -1)) {
      relativeDirectory = relativeDirectory === "." ? part : `${relativeDirectory}/${part}`;
      directories.add(relativeDirectory);
      if (directories.size >= maxDirectories) {
        truncated = true;
        break;
      }
    }
    if (directories.size >= maxDirectories && truncated) break;
    files.push(relative);
    if (files.length > maxFiles) {
      files.pop();
      truncated = true;
      fileLimitReached = true;
      break;
    }
  }
  const warnings: string[] = [];
  if (fileLimitReached) warnings.push(`Project discovery stopped at its ${maxFiles} file safety limit.`);
  if (entryLimitReached) warnings.push(`Project discovery stopped at its ${maxEntries} Git file-entry safety limit.`);
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    scannedDirectories: directories.size,
    truncated,
    warnings
  };
}

function hasGitMetadataAncestor(root: string): boolean {
  let current = root;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function walkProjectFiles(
  root: string,
  maxDepth: number,
  maxDirectories: number,
  maxFiles: number,
  maxEntries: number,
  warnings: string[]
): { files: string[]; scannedDirectories: number; truncated: boolean } {
  const files: string[] = [];
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: ".", depth: 0 }
  ];
  let scannedDirectories = 0;
  let truncated = false;
  let inspectedEntries = 0;
  while (stack.length > 0) {
    if (scannedDirectories >= maxDirectories) {
      truncated = true;
      warnings.push(`Project discovery stopped at its ${maxDirectories} directory safety limit.`);
      break;
    }
    const current = stack.pop()!;
    scannedDirectories += 1;
    let directory: fs.Dir;
    try {
      directory = fs.opendirSync(current.absolute);
    } catch (error) {
      warnings.push(`Could not inspect ${current.relative}: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    const entries: fs.Dirent[] = [];
    let entryLimitReached = false;
    try {
      while (true) {
        const entry = directory.readSync();
        if (!entry) break;
        if (inspectedEntries >= maxEntries) {
          entryLimitReached = true;
          break;
        }
        inspectedEntries += 1;
        entries.push(entry);
      }
    } catch (error) {
      directory.closeSync();
      warnings.push(`Could not inspect ${current.relative}: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    directory.closeSync();
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (entryLimitReached) {
      truncated = true;
      warnings.push(`Project discovery stopped at its ${maxEntries} directory-entry safety limit; entries follow filesystem enumeration order, with inspected entries processed lexically.`);
    }
    for (const entry of entries) {
      const relative = current.relative === "." ? entry.name : `${current.relative}/${entry.name}`;
      if (entry.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          warnings.push(`Project discovery stopped at its ${maxFiles} file safety limit.`);
          return { files, scannedDirectories, truncated };
        }
        files.push(relative);
        continue;
      }
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (current.depth >= maxDepth) {
        truncated = true;
        continue;
      }
      stack.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
    }
    if (entryLimitReached) break;
  }
  return { files, scannedDirectories, truncated };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function ecosystemForManifest(fileName: string): ProjectEcosystem | null {
  const name = fileName.toLowerCase();
  if (name === "package.json" || name === "pnpm-workspace.yaml" || name === "deno.json" || name === "deno.jsonc") return "node";
  if (name === "pyproject.toml" || name === "pipfile" || name === "setup.py" || name === "setup.cfg"
    || name === "pytest.ini" || name === "tox.ini" || name === "environment.yml"
    || /^requirements(?:[-_.][^/]+)?\.txt$/.test(name)) return "python";
  if (name === "cargo.toml") return "rust";
  if (name === "go.mod") return "go";
  if (["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].includes(name)) return "java";
  if (/\.(?:sln|csproj|fsproj|vbproj)$/.test(name)) return "dotnet";
  if (name === "gemfile") return "ruby";
  if (name === "composer.json") return "php";
  if (name === "mix.exs") return "elixir";
  if (name === "pubspec.yaml") return "dart";
  if (name === "package.swift") return "swift";
  if (name === "dockerfile" || name === "compose.yaml" || name === "compose.yml"
    || name === "docker-compose.yaml" || name === "docker-compose.yml") return "container";
  return null;
}
