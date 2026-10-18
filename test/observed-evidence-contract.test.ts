import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject, type ProjectObservedEvidence } from "../src/projects/discovery.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("observed project evidence contract", () => {
  it("keeps backend/package.json observed without inferring a role from the directory name", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-observed-contract-"));
    const manifestPath = path.join(tempRoot, "backend", "package.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, "{}\n", "utf8");

    const evidence: ProjectObservedEvidence | undefined = discoverProject(tempRoot).evidence
      .find((item) => item.sourcePath === "backend/package.json");

    expect(evidence).toEqual({
      sourcePath: "backend/package.json",
      category: "manifest",
      ecosystem: "node",
      confidence: "observed"
    });
    expect(Object.keys(evidence ?? {}).sort()).toEqual([
      "category",
      "confidence",
      "ecosystem",
      "sourcePath"
    ]);
    expect(evidence).not.toHaveProperty("role");
    expect(evidence).not.toHaveProperty("inferredRole");
  });
});
