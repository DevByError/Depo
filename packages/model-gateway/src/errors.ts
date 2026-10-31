export type GatewayErrorKind =
  | "unreachable"
  | "timeout"
  | "cancelled"
  | "http"
  | "invalid_output"
  | "not_supported";

/** Typed error with a message written for the user (shown in the activity feed). */
export class ModelGatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export function providerLabel(kind: string): string {
  return kind === "ollama" ? "Ollama" : kind === "lmstudio" ? "LM Studio" : "llama.cpp server";
}
