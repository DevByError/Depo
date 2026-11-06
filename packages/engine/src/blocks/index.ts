import { AUTH_PY, COMPOSE_PG, LOGIN_REACT, RBAC_PY } from "./other-blocks";
import { AUDIT_TS, AUTH_TS, ENV_TS, PAGINATE_TS, RATE_TS, RBAC_TS } from "./ts-blocks";
import type { Block } from "./types";

export type { Block } from "./types";

export const BLOCKS: Block[] = [
  AUTH_TS,
  RBAC_TS,
  AUDIT_TS,
  RATE_TS,
  ENV_TS,
  PAGINATE_TS,
  AUTH_PY,
  RBAC_PY,
  LOGIN_REACT,
  COMPOSE_PG,
];

export function findBlock(id: string): Block | undefined {
  return BLOCKS.find((b) => b.id === id);
}

export function searchBlocks(q: { stack?: string | undefined; text?: string | undefined }): Block[] {
  const t = q.text?.toLowerCase().trim();
  return BLOCKS.filter(
    (b) =>
      (!q.stack || b.stack === q.stack) &&
      (!t || `${b.id} ${b.name} ${b.description} ${b.tags.join(" ")}`.toLowerCase().includes(t)),
  );
}
