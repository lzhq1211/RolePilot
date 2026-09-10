import { randomUUID } from "node:crypto";
import { parseResumeContentV3, RESUME_PROFILE_FIELDS, type ResumeContentV3 } from "web-contracts/resume-document";

type Node = Record<string, any>;
export type ResumeTarget = { nodeId: string } | { profileField: string } | null;
export type ReviewBinding = {
  documentId: string; candidateVersion: number; evidenceVersion: number; reviewArtifactPath: string;
  issueTargets: Array<{ issueRef: string; issueKey: string; target: ResumeTarget }>;
};

export function indexResumeNodes(document: ResumeContentV3) {
  const nodes = new Map<string, { node: Node; parent: Node; collection: string }>();
  const visit = (parent: Node, collection: string) => {
    for (const node of parent[collection] ?? []) {
      if (!node || typeof node.id !== "string") throw new TypeError("Content node requires an ID.");
      if (nodes.has(node.id)) throw new TypeError(`Duplicate node ID: ${node.id}`);
      nodes.set(node.id, { node, parent, collection });
      for (const child of ["entries", "blocks", "bullets", "items"]) if (node[child]) visit(node, child);
    }
  };
  visit(document, "sections");
  return nodes;
}

export function applySourceCorrections(document: ResumeContentV3,
  corrections: Array<{ target: string; field: string; value: string }>) {
  const corrected = structuredClone(document);
  const nodes = indexResumeNodes(corrected);
  for (const correction of corrections) {
    const target = correction.target === "profile" ? corrected.profile : nodes.get(correction.target)?.node;
    if (!target || ["id", "type", "documentId", "schemaVersion"].includes(correction.field)
      || typeof Reflect.get(target, correction.field) !== "string") throw new TypeError("Correction must address source content, not structure.");
    Reflect.set(target, correction.field, correction.value);
  }
  return parseResumeContentV3(corrected);
}

export function materializeInitialCandidate(value: unknown, source: ResumeContentV3, documentId: string) {
  const content = parseResumeContentV3(value);
  if (content.documentId !== documentId) throw new TypeError("Writer changed the assigned documentId.");
  const sourceIds = indexResumeNodes(source);
  for (const { node } of indexResumeNodes(content).values()) {
    const sourceNode = sourceIds.get(node.id)?.node;
    if (!sourceNode) node.id = randomUUID();
    else if (node.type !== sourceNode.type || ("name" in node) !== ("name" in sourceNode)) {
      throw new TypeError("A source ID cannot be reassigned to another node kind.");
    }
  }
  return parseResumeContentV3(content);
}

function object(value: unknown): Node {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object.");
  return value as Node;
}

function fields(value: Node, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unsupported operation field: ${key}`);
}

/** Inserted nodes use proposal-local IDs, mapped once; existing IDs cannot be reassigned. */
export function applyResumeOperations(document: ResumeContentV3, value: unknown) {
  const proposal = object(value);
  fields(proposal, ["documentId", "operations"]);
  if (proposal.documentId !== document.documentId) throw new TypeError("Operation documentId does not match the current document.");
  if (!Array.isArray(proposal.operations)) throw new TypeError("operations must be an array.");
  const candidate = parseResumeContentV3(document);
  const originalIds = indexResumeNodes(candidate);
  const localIds = new Map<string, string>();
  const inserted = (value: unknown): Node => {
    const node = object(value);
    if ("id" in node || typeof node.localId !== "string" || !node.localId.trim()
      || originalIds.has(node.localId) || localIds.has(node.localId) || node.localId === document.documentId) {
      throw new TypeError("New nodes require unique localId and must not assign an existing identity.");
    }
    const id = randomUUID();
    localIds.set(node.localId, id);
    const { localId: _local, ...rest } = node;
    const result: Node = { ...rest, id };
    for (const key of ["entries", "blocks", "bullets", "items"]) if (key in result) {
      if (!Array.isArray(result[key])) throw new TypeError(`${key} must be an array.`);
      result[key] = result[key].map(inserted);
    }
    return result;
  };
  const resolve = (id: unknown): string => {
    if (typeof id !== "string") throw new TypeError("Node reference must be a string.");
    return localIds.get(id) ?? id;
  };
  for (const raw of proposal.operations) {
    const op = object(raw);
    const nodes = indexResumeNodes(candidate);
    if (op.op === "updateProfile") {
      fields(op, ["op", "fields"]);
      const update = object(op.fields);
      fields(update, [...RESUME_PROFILE_FIELDS, "extraContacts"]);
      Object.assign(candidate.profile, update);
    } else if (op.op === "update") {
      fields(op, ["op", "nodeId", "fields"]);
      const ref = nodes.get(resolve(op.nodeId));
      if (!ref) throw new TypeError(`Unknown node: ${op.nodeId}`);
      const update = object(op.fields);
      const allowed = Object.keys(ref.node).filter((key) => !["id", "type", "entries", "blocks", "bullets", "items"].includes(key));
      fields(update, allowed);
      Object.assign(ref.node, update);
    } else if (op.op === "delete") {
      fields(op, ["op", "nodeId"]);
      const ref = nodes.get(resolve(op.nodeId));
      if (!ref) throw new TypeError(`Unknown deletion target: ${op.nodeId}`);
      ref.parent[ref.collection].splice(ref.parent[ref.collection].indexOf(ref.node), 1);
    } else if (op.op === "insert") {
      fields(op, ["op", "parentId", "collection", "beforeId", "node"]);
      const parent = op.parentId === document.documentId ? candidate : nodes.get(resolve(op.parentId))?.node;
      if (!parent || !["sections", "entries", "blocks", "bullets", "items"].includes(op.collection)
        || !Array.isArray((parent as Node)[op.collection])) throw new TypeError("Invalid insertion parent/collection.");
      const list = (parent as Node)[op.collection] as Node[];
      const before = op.beforeId == null ? list.length : list.findIndex((n) => n.id === resolve(op.beforeId));
      if (before < 0) throw new TypeError("beforeId must belong to the insertion collection.");
      list.splice(before, 0, inserted(op.node));
    } else if (op.op === "reorder") {
      fields(op, ["op", "parentId", "collection", "nodeIds"]);
      const parent = op.parentId === document.documentId ? candidate : nodes.get(resolve(op.parentId))?.node;
      const list = parent && (parent as Node)[op.collection];
      if (!["sections", "entries", "blocks", "bullets", "items"].includes(op.collection) || !Array.isArray(list) || !Array.isArray(op.nodeIds)) throw new TypeError("Invalid reorder collection.");
      const ids = op.nodeIds.map(resolve);
      if (ids.length !== list.length || new Set(ids).size !== ids.length || ids.some((id: string) => !list.some((n: Node) => n.id === id))) throw new TypeError("Reorder must name every current child exactly once.");
      (parent as Node)[op.collection] = ids.map((id: string) => list.find((n: Node) => n.id === id));
    } else if (op.op === "move") {
      fields(op, ["op", "nodeId", "parentId", "collection", "beforeId"]);
      const ref = nodes.get(resolve(op.nodeId));
      const parent = nodes.get(resolve(op.parentId))?.node;
      if (!ref || !parent || !["entries", "blocks", "bullets", "items"].includes(op.collection) || !Array.isArray(parent[op.collection])) throw new TypeError("Invalid move target.");
      // Cycles and incompatible structural moves are rejected by the final content validation.
      let ancestor: Node | undefined = parent;
      while (ancestor && ancestor !== candidate) {
        if (ancestor === ref.node) throw new TypeError("Cannot move a node into itself or its descendants.");
        ancestor = nodes.get(ancestor.id)?.parent;
      }
      ref.parent[ref.collection].splice(ref.parent[ref.collection].indexOf(ref.node), 1);
      const list = parent[op.collection] as Node[];
      const before = op.beforeId == null ? list.length : list.findIndex((n) => n.id === resolve(op.beforeId));
      if (before < 0) throw new TypeError("Invalid move beforeId.");
      list.splice(before, 0, ref.node);
    } else throw new TypeError(`Unknown operation: ${op.op}`);
  }
  const content = parseResumeContentV3(candidate);
  return { content, changed: JSON.stringify(content) !== JSON.stringify(parseResumeContentV3(document)), localIds: Object.fromEntries(localIds) };
}

/** Personal details remain deterministic; experience facts are assessed by Review. */
export function assertSourceBackedIdentity(candidate: ResumeContentV3, original: ResumeContentV3, previous: ResumeContentV3 | null, _sourceText: string, userAnswers: string,
  corrections: Array<{ target: string; field: string; previousValue: string; value: string }> = []) {
  const supported = (value: string, source: unknown, old: unknown) => value === "" || value === old || value === source || userAnswers.includes(value);
  for (const key of ["name", "phone", "email", "location", "website", "portfolio", "github"] as const) {
    const correction = corrections.filter((item) => item.target === "profile" && item.field === key).at(-1);
    if (correction) {
      if (candidate.profile[key] !== "" && candidate.profile[key] !== correction.value) throw new TypeError(`Profile conflicts with explicit correction: ${key}`);
      continue;
    }
    if (!supported(candidate.profile[key], original.profile[key], previous?.profile[key])) throw new TypeError(`Unsupported identity change: profile.${key}`);
  }
}

function protectedContentTokens(value: string): string[] {
  return [...value.matchAll(/(?:\d+(?:[.,]\d+)*%?|[A-Za-z][A-Za-z0-9+#./-]{1,})/g)]
    .map((match) => match[0].toLocaleLowerCase())
    .filter((token) => token.length > 1);
}

/**
 * Numeric and technical tokens are the parts of a rewritten bullet most likely
 * to smuggle in an unsupported claim. Natural-language paraphrase remains the
 * reviewer's job, but these high-signal tokens must exist in the source ledger.
 */
export function assertSourceBackedBulletContent(
  candidate: ResumeContentV3,
  sourceText: string,
) {
  const sourceTokens = new Set(protectedContentTokens(sourceText));
  const violations: Array<{ nodeId: string; token: string; content: string }> = [];
  for (const { node } of indexResumeNodes(candidate).values()) {
    if (!Array.isArray(node.bullets)) continue;
    for (const bullet of node.bullets) {
      if (!bullet || typeof bullet.content !== "string") continue;
      for (const token of protectedContentTokens(bullet.content)) {
        if (!sourceTokens.has(token)) violations.push({ nodeId: bullet.id, token, content: bullet.content });
      }
    }
  }
  if (violations.length) {
    const preview = violations.slice(0, 5).map((item) => `${item.nodeId}:${item.token}`).join(", ");
    throw new TypeError(`Unsupported bullet evidence token(s): ${preview}`);
  }
  return { checked: [...indexResumeNodes(candidate).values()].reduce((count, { node }) => count + (Array.isArray(node.bullets) ? node.bullets.length : 0), 0), violations };
}

export function parseReviewBinding(value: unknown, document: ResumeContentV3, report: Record<string, unknown>, metadata: Omit<ReviewBinding, "issueTargets">): ReviewBinding {
  if (!Array.isArray(value)) throw new TypeError("issueTargets must be an array.");
  const nodes = indexResumeNodes(document);
  const issues = Array.isArray(report.topIssues) ? report.topIssues.map((v) => object(v).issueRef) : [];
  const seen = new Set<string>();
  const keys = new Set<string>();
  const issueTargets = value.map((raw) => {
    const item = object(raw);
    fields(item, ["issueRef", "issueKey", "target"]);
    if (!issues.includes(item.issueRef) || seen.has(item.issueRef) || typeof item.issueKey !== "string" || !item.issueKey.trim()) throw new TypeError("Invalid or duplicate issueRef/issueKey.");
    seen.add(item.issueRef);
    let target: ResumeTarget = null;
    if (item.target !== null) {
      const t = object(item.target);
      if (Object.keys(t).length !== 1) throw new TypeError("Issue target must identify one node or profile field.");
      if (typeof t.nodeId === "string" && nodes.has(t.nodeId)) target = { nodeId: t.nodeId };
      else if (typeof t.profileField === "string" && [...RESUME_PROFILE_FIELDS, "extraContacts"].includes(t.profileField as any)) target = { profileField: t.profileField };
      else throw new TypeError("Issue target does not exist in this candidate.");
    }
    const key = JSON.stringify([item.issueKey, target]);
    if (keys.has(key)) throw new TypeError("Duplicate issueKey and target.");
    keys.add(key);
    return { issueRef: item.issueRef as string, issueKey: item.issueKey as string, target };
  });
  if (seen.size !== issues.length) throw new TypeError("Every topIssue must have a binding; global issues use target null.");
  return { ...metadata, issueTargets };
}

/**
 * Deterministic correction for one known binding error: the model rebuilds a
 * node ID from the candidate documentId prefix (…:generated:…) while the
 * candidate still carries the source-preserved ID (…:original:…). Only a full
 * suffix match under the known source prefix is corrected; unknown IDs, UUID
 * nodes, and fuzzy matches stay untouched so the strict binding validation
 * keeps rejecting them. Mutates the supplied target objects in place.
 */
export function normalizeIssueTargetNodeIds(
  issueTargets: Array<Record<string, unknown>>,
  document: ResumeContentV3,
): Array<{ issueRef: unknown; from: string; to: string }> {
  if (!document.documentId.endsWith(":generated")) return [];
  const index = indexResumeNodes(document);
  const documentPrefix = `${document.documentId}:`;
  const sourcePrefix = `${document.documentId.slice(0, -":generated".length)}:original:`;
  const changes: Array<{ issueRef: unknown; from: string; to: string }> = [];
  for (const raw of issueTargets) {
    const target = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).target : null;
    if (!target || typeof target !== "object" || Array.isArray(target)) continue;
    const nodeId = (target as Record<string, unknown>).nodeId;
    if (typeof nodeId !== "string" || index.has(nodeId)) continue;
    if (!nodeId.startsWith(documentPrefix)) continue;
    const suffix = nodeId.slice(documentPrefix.length);
    const corrected = `${sourcePrefix}${suffix}`;
    if (!index.has(corrected)) continue;
    (target as Record<string, unknown>).nodeId = corrected;
    changes.push({ issueRef: raw.issueRef, from: nodeId, to: corrected });
  }
  return changes;
}
