import { describe, expect, it } from "vitest";
import {
  decodeWorkPacket,
  encodeWorkPacket,
  normalizeWorkPacket,
  WorkPacketCodecError,
  WORK_PACKET_LIMITS,
  WORK_PACKET_VERSION
} from "../src/tasks/work-packet.js";

const provenance: {
  kind: "verified_fact";
  origin: string;
  source: string;
  timestamp: string;
} = {
  kind: "verified_fact",
  origin: "test",
  source: "fixture",
  timestamp: "2026-10-02T10:00:00.000Z"
} as const;

function packet() {
  return {
    version: WORK_PACKET_VERSION,
    objective: { text: "Implement codec", provenance },
    acceptanceCriteria: [{ id: "A1", text: "Round-trip", provenance }],
    projectMap: [{ text: "TypeScript project", path: "package.json", provenance }],
    decisions: [{ text: "Keep arrays ordered", provenance: { ...provenance, kind: "user_decision" } }],
    openQuestions: [{ text: "None", provenance: { ...provenance, kind: "assumption" } }],
    completedWork: [{ text: "Defined schema", provenance }],
    changedFiles: [{ text: "Codec file", path: "src/tasks/work-packet.ts", provenance }],
    validationEvidence: [{ text: "Focused tests", command: "vitest run", result: "passed", provenance }],
    failures: [{ text: "No known failures", provenance }],
    nextAction: { text: "Integrate at checkpoint", provenance: { ...provenance, kind: "unverified_suggestion" } }
  };
}

describe("WorkPacket codec", () => {
  it("normalizes text and produces deterministic canonical JSON", () => {
    const source = packet();
    source.objective.text = "  Implement codec  ";
    const encoded = encodeWorkPacket(source);
    expect(encoded).toBe(encodeWorkPacket(packet()));
    expect(decodeWorkPacket(encoded)).toEqual(normalizeWorkPacket(packet()));
    expect(JSON.parse(encoded).objective.text).toBe("Implement codec");
  });

  it("retains provenance classifications without promoting suggestions", () => {
    const normalized = normalizeWorkPacket(packet());
    expect(normalized.decisions[0].provenance.kind).toBe("user_decision");
    expect(normalized.openQuestions[0].provenance.kind).toBe("assumption");
    expect(normalized.nextAction?.provenance.kind).toBe("unverified_suggestion");
    expect(normalized.objective.provenance.kind).toBe("verified_fact");
  });

  it("rejects unsupported versions and invalid JSON with a clear codec error", () => {
    expect(() => encodeWorkPacket({ ...packet(), version: 2 })).toThrow(WorkPacketCodecError);
    expect(() => decodeWorkPacket("{" )).toThrow("must contain valid JSON");
  });

  it("rejects sparse arrays before encoding invalid null entries", () => {
    const source = packet();
    source.acceptanceCriteria.length = 2;
    expect(() => encodeWorkPacket(source)).toThrow("acceptanceCriteria[1] must not be an empty array slot");
  });

  it("rejects excessive aggregate item counts", () => {
    const source = packet();
    source.failures = Array.from({ length: WORK_PACKET_LIMITS.maxItems }, (_, index) => ({
      text: `Failure ${index}`,
      provenance
    }));
    expect(() => encodeWorkPacket(source)).toThrow(`at most ${WORK_PACKET_LIMITS.maxItems} items`);
  });

  it("rejects oversized text and encoded packets", () => {
    const source = packet();
    source.objective.text = "x".repeat(WORK_PACKET_LIMITS.maxTextLength + 1);
    expect(() => encodeWorkPacket(source)).toThrow(`at most ${WORK_PACKET_LIMITS.maxTextLength} characters`);

    const oversized = JSON.stringify({ padding: "x".repeat(WORK_PACKET_LIMITS.maxEncodedBytes) });
    expect(() => decodeWorkPacket(oversized)).toThrow(`at most ${WORK_PACKET_LIMITS.maxEncodedBytes} bytes`);
  });

  it("rejects non-canonical or invalid provenance timestamps", () => {
    const source = packet();
    source.objective.provenance = { ...provenance, timestamp: "2026-10-02T10:00:00Z" };
    expect(() => encodeWorkPacket(source)).toThrow("must be a canonical UTC ISO timestamp");
  });
});
