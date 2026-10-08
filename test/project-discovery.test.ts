import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject } from "../src/projects/discovery.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("discoverProject", () => {
  it("finds mixed project manifests at arbitrary paths without assigning meaning to folder names", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-"));
    const files = [
      "odd/place/service/package.json",
      "odd/place/service/requirements-prod.txt",
      "odd/place/service/mystery.input",
      "mobile/ios/Cargo.toml",
      "tools/worker/go.mod",
      "desktop/native/Octomynd.csproj",
      "odd/place/service/node_modules/ignored/package.json",
      "target/generated/Cargo.toml"
    ];
    for (const file of files) {
      const absolute = path.join(tempDir, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "{}\n", "utf8");
    }

    const discovery = discoverProject(tempDir);

    expect(discovery.manifests.map((manifest) => manifest.path)).toEqual([
      "desktop/native/Octomynd.csproj",
      "mobile/ios/Cargo.toml",
      "odd/place/service/package.json",
      "odd/place/service/requirements-prod.txt",
      "tools/worker/go.mod"
    ]);
    expect(discovery.ecosystems).toEqual(["dotnet", "go", "node", "python", "rust"]);
    expect(discovery.manifests.find((manifest) => manifest.path === "odd/place/service/package.json"))
      .toMatchObject({ directory: "odd/place/service", ecosystem: "node" });
    expect(discovery.evidence.find((item) => item.sourcePath === "odd/place/service/package.json"))
      .toMatchObject({ category: "manifest", ecosystem: "node", confidence: "observed" });
    expect(discovery.evidence.find((item) => item.sourcePath === "odd/place/service/mystery.input"))
      .toMatchObject({ category: "file", ecosystem: "unknown", confidence: "observed" });
    expect(discovery.truncated).toBe(false);
  });

  it("marks the file limit only when an eligible file is omitted", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-file-limit-"));
    fs.writeFileSync(path.join(tempDir, "alpha.bin"), "", "utf8");
    fs.writeFileSync(path.join(tempDir, "beta.bin"), "", "utf8");

    const exact = discoverProject(tempDir, { maxFiles: 2 });
    expect(exact.files).toEqual(["alpha.bin", "beta.bin"]);
    expect(exact.truncated).toBe(false);
    expect(exact.warnings).toEqual([]);

    fs.writeFileSync(path.join(tempDir, "gamma.bin"), "", "utf8");
    const exceeded = discoverProject(tempDir, { maxFiles: 2 });
    expect(exceeded.files).toEqual(["alpha.bin", "beta.bin"]);
    expect(exceeded.truncated).toBe(true);
    expect(exceeded.warnings.join(" ")).toContain("2 file safety limit");
  });

  it("bounds non-Git directory enumeration and reports only an exceeded entry cap", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-entry-limit-"));
    fs.writeFileSync(path.join(tempDir, "alpha.bin"), "", "utf8");
    fs.writeFileSync(path.join(tempDir, "beta.bin"), "", "utf8");

    const exact = discoverProject(tempDir, { maxEntries: 2 });
    expect(exact.truncated).toBe(false);
    expect(exact.files).toHaveLength(2);

    fs.writeFileSync(path.join(tempDir, "gamma.bin"), "", "utf8");
    const exceeded = discoverProject(tempDir, { maxEntries: 2 });
    expect(exceeded.truncated).toBe(true);
    expect(exceeded.files).toHaveLength(2);
    expect(exceeded.files).toEqual([...exceeded.files].sort((left, right) => left.localeCompare(right)));
    expect(exceeded.warnings.join(" ")).toContain("2 directory-entry safety limit");
  });

  it("applies the exact and exceeded file limits to Git-visible inventories", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-git-limit-"));
    const git = (args: string[]) => {
      const result = spawnSync("git", ["-C", tempDir!, ...args], { encoding: "utf8", windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    };
    git(["init", "-b", "main"]);
    for (const name of ["alpha.bin", "beta.bin"]) fs.writeFileSync(path.join(tempDir, name), "", "utf8");
    git(["add", "alpha.bin", "beta.bin"]);

    const exact = discoverProject(tempDir, { maxFiles: 2 });
    expect(exact.files).toEqual(["alpha.bin", "beta.bin"]);
    expect(exact.truncated).toBe(false);

    fs.writeFileSync(path.join(tempDir, "gamma.bin"), "", "utf8");
    const exceeded = discoverProject(tempDir, { maxFiles: 2 });
    expect(exceeded.files).toEqual(["alpha.bin", "beta.bin"]);
    expect(exceeded.truncated).toBe(true);
    expect(exceeded.warnings.join(" ")).toContain("2 file safety limit");
  });

  it("applies the entry limit to Git-visible inventories", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-git-entry-limit-"));
    const git = (args: string[]) => {
      const result = spawnSync("git", ["-C", tempDir!, ...args], { encoding: "utf8", windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    };
    git(["init", "-b", "main"]);
    for (const name of ["alpha.bin", "beta.bin", "gamma.bin"]) fs.writeFileSync(path.join(tempDir, name), "", "utf8");
    git(["add", "alpha.bin", "beta.bin", "gamma.bin"]);

    const exact = discoverProject(tempDir, { maxEntries: 3 });
    expect(exact.files).toEqual(["alpha.bin", "beta.bin", "gamma.bin"]);
    expect(exact.truncated).toBe(false);

    const exceeded = discoverProject(tempDir, { maxEntries: 2 });
    expect(exceeded.files).toEqual(["alpha.bin", "beta.bin"]);
    expect(exceeded.truncated).toBe(true);
    expect(exceeded.warnings.join(" ")).toContain("2 Git file-entry safety limit");
  });

  it("bounds traversal and reports when the project inventory is incomplete", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-"));
    fs.mkdirSync(path.join(tempDir, "level-one", "level-two"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "level-one", "level-two", "go.mod"), "module sample\n", "utf8");

    const discovery = discoverProject(tempDir, { maxDepth: 1 });

    expect(discovery.truncated).toBe(true);
    expect(discovery.warnings.join(" ")).toContain("maximum depth of 1");
    expect(discovery.manifests).toEqual([]);
  });

  it("uses Git's visible-file inventory and excludes ignored builds and fixtures", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-git-"));
    const git = (args: string[]) => {
      const result = spawnSync("git", ["-C", tempDir!, ...args], { encoding: "utf8", windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    };
    git(["init", "-b", "main"]);
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "release/\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "package.json"), "{}\n", "utf8");
    fs.mkdirSync(path.join(tempDir, "examples", "demo"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "examples", "demo", "package.json"), "{}\n", "utf8");
    fs.mkdirSync(path.join(tempDir, "release", "win-unpacked", "resources", "app"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "release", "win-unpacked", "resources", "app", "package.json"), "{}\n", "utf8");
    git(["add", ".gitignore", "package.json", "examples"]);

    const discovery = discoverProject(tempDir);

    expect(discovery.manifests.map((manifest) => manifest.path)).toEqual([
      "examples/demo/package.json",
      "package.json"
    ]);
    expect(discovery.files).not.toContain("release/win-unpacked/resources/app/package.json");
  });

  it("scopes Git inventory to a nested project root", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-nested-git-"));
    const git = (cwd: string, args: string[]) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    };
    git(tempDir, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(tempDir, "package.json"), "{}\n", "utf8");
    const projectRoot = path.join(tempDir, "nested", "service");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "pyproject.toml"), "[project]\nname = 'service'\n", "utf8");
    git(tempDir, ["add", "."]);

    const discovery = discoverProject(projectRoot);

    expect(discovery.manifests.map((manifest) => manifest.path)).toEqual(["pyproject.toml"]);
    expect(discovery.files).not.toContain("package.json");
  });
});
