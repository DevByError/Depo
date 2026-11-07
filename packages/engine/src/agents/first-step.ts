import type { Role } from "@depo/model-gateway";
import type { AgentId, AgentManifest, WorkMode } from "@depo/shared";
import { manifestOf } from "./manifests";
import { templateNodes } from "./team";

/**
 * The model role of a task's first model call, for the warm-up: the coding agent alone, else the
 * Manager planning (reasoning model), or the only agent of a one-step mode.
 */
export function firstStepRole(mode: WorkMode, text: string, manifest?: (id: AgentId) => AgentManifest): Role {
  if (mode === "single") return "coder";
  const nodes = templateNodes(mode, text);
  if (nodes.length > 1) return "reasoning";
  const owner = nodes[0]?.owner;
  return owner ? (manifest?.(owner) ?? manifestOf(owner)).role : "coder";
}
