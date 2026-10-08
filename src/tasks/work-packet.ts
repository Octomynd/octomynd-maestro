export const WORK_PACKET_VERSION = 1 as const;

export const WORK_PACKET_LIMITS = {
  maxEncodedBytes: 64 * 1024,
  maxItems: 256,
  maxTextLength: 4096
} as const;

export type WorkPacketProvenanceKind =
  | "verified_fact"
  | "user_decision"
  | "assumption"
  | "unverified_suggestion";

export type WorkPacketProvenance = {
  kind: WorkPacketProvenanceKind;
  origin: string;
  source: string;
  timestamp: string;
};

export type WorkPacketEntry = {
  text: string;
  provenance: WorkPacketProvenance;
};

export type WorkPacketEvidence = WorkPacketEntry & {
  path?: string;
};

export type WorkPacketAcceptanceCriterion = WorkPacketEntry & {
  id: string;
};

export type WorkPacketValidation = WorkPacketEntry & {
  command: string;
  result: string;
};

export type WorkPacket = {
  version: typeof WORK_PACKET_VERSION;
  objective: WorkPacketEntry;
  acceptanceCriteria: WorkPacketAcceptanceCriterion[];
  projectMap: WorkPacketEvidence[];
  decisions: WorkPacketEntry[];
  openQuestions: WorkPacketEntry[];
  completedWork: WorkPacketEntry[];
  changedFiles: WorkPacketEvidence[];
  validationEvidence: WorkPacketValidation[];
  failures: WorkPacketEntry[];
  nextAction: WorkPacketEntry | null;
};

export class WorkPacketCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkPacketCodecError";
  }
}

const provenanceKinds = new Set<WorkPacketProvenanceKind>([
  "verified_fact",
  "user_decision",
  "assumption",
  "unverified_suggestion"
]);

function fail(path: string, message: string): never {
  throw new WorkPacketCodecError(`${path} ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path, "must be a string");
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) return fail(path, "must not be empty");
  if (normalized.length > WORK_PACKET_LIMITS.maxTextLength) {
    return fail(path, `must be at most ${WORK_PACKET_LIMITS.maxTextLength} characters`);
  }
  return normalized;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function timestamp(value: unknown, path: string): string {
  const normalized = text(value, path);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    return fail(path, "must be a canonical UTC ISO timestamp");
  }
  return normalized;
}

function provenance(value: unknown, path: string): WorkPacketProvenance {
  const input = object(value, path);
  if (typeof input.kind !== "string" || !provenanceKinds.has(input.kind as WorkPacketProvenanceKind)) {
    return fail(`${path}.kind`, "is not a supported provenance classification");
  }
  return {
    kind: input.kind as WorkPacketProvenanceKind,
    origin: text(input.origin, `${path}.origin`),
    source: text(input.source, `${path}.source`),
    timestamp: timestamp(input.timestamp, `${path}.timestamp`)
  };
}

function entry(value: unknown, path: string): WorkPacketEntry {
  const input = object(value, path);
  return {
    text: text(input.text, `${path}.text`),
    provenance: provenance(input.provenance, `${path}.provenance`)
  };
}

function evidence(value: unknown, path: string): WorkPacketEvidence {
  const input = object(value, path);
  const base = entry(input, path);
  const sourcePath = optionalText(input.path, `${path}.path`);
  return sourcePath === undefined ? base : { ...base, path: sourcePath };
}

function list<T>(value: unknown, path: string, parse: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return fail(`${path}[${index}]`, "must not be an empty array slot");
    }
    result.push(parse(value[index], `${path}[${index}]`));
  }
  return result;
}

function parseWorkPacket(value: unknown): WorkPacket {
  const input = object(value, "workPacket");
  if (input.version !== WORK_PACKET_VERSION) {
    return fail("workPacket.version", `must equal supported version ${WORK_PACKET_VERSION}`);
  }
  const acceptanceCriteria = list(input.acceptanceCriteria, "acceptanceCriteria", (item, path) => {
    const raw = object(item, path);
    return { ...entry(raw, path), id: text(raw.id, `${path}.id`) };
  });
  const projectMap = list(input.projectMap, "projectMap", evidence);
  const decisions = list(input.decisions, "decisions", entry);
  const openQuestions = list(input.openQuestions, "openQuestions", entry);
  const completedWork = list(input.completedWork, "completedWork", entry);
  const changedFiles = list(input.changedFiles, "changedFiles", evidence);
  const validationEvidence = list(input.validationEvidence, "validationEvidence", (item, path) => {
    const raw = object(item, path);
    return {
      ...entry(raw, path),
      command: text(raw.command, `${path}.command`),
      result: text(raw.result, `${path}.result`)
    };
  });
  const failures = list(input.failures, "failures", entry);
  const nextAction = input.nextAction === null ? null : entry(input.nextAction, "nextAction");
  const totalItems = acceptanceCriteria.length + projectMap.length + decisions.length + openQuestions.length
    + completedWork.length + changedFiles.length + validationEvidence.length + failures.length
    + (nextAction === null ? 0 : 1);
  if (totalItems > WORK_PACKET_LIMITS.maxItems) {
    return fail("workPacket", `must contain at most ${WORK_PACKET_LIMITS.maxItems} items`);
  }
  return {
    version: WORK_PACKET_VERSION,
    objective: entry(input.objective, "objective"),
    acceptanceCriteria,
    projectMap,
    decisions,
    openQuestions,
    completedWork,
    changedFiles,
    validationEvidence,
    failures,
    nextAction
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
  }
  return value;
}

export function normalizeWorkPacket(value: unknown): WorkPacket {
  return parseWorkPacket(value);
}

export function encodeWorkPacket(value: unknown): string {
  const packet = normalizeWorkPacket(value);
  const encoded = JSON.stringify(sortKeys(packet));
  if (Buffer.byteLength(encoded, "utf8") > WORK_PACKET_LIMITS.maxEncodedBytes) {
    return fail("workPacket", `must encode to at most ${WORK_PACKET_LIMITS.maxEncodedBytes} bytes`);
  }
  return encoded;
}

export function decodeWorkPacket(encoded: string): WorkPacket {
  if (typeof encoded !== "string") return fail("encodedWorkPacket", "must be a string");
  if (Buffer.byteLength(encoded, "utf8") > WORK_PACKET_LIMITS.maxEncodedBytes) {
    return fail("encodedWorkPacket", `must be at most ${WORK_PACKET_LIMITS.maxEncodedBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    return fail("encodedWorkPacket", "must contain valid JSON");
  }
  return normalizeWorkPacket(parsed);
}
