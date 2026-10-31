import type { CompileRequest } from './contract.js';

export interface CompilerUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
/** Human-readable progress streamed while the model works. Never contains secrets. */
export interface CompilerProgress {
  kind: 'thinking' | 'command' | 'message' | 'status';
  text: string;
}
export interface CompilerTurn {
  /** Parsed JSON from the structured final response. */
  output: unknown;
  usage: CompilerUsage | null;
}
export interface CompilerSession {
  readonly threadId: string | null;
  turn(
    prompt: string,
    options: { signal: AbortSignal; onProgress: (progress: CompilerProgress) => void },
  ): Promise<CompilerTurn>;
  close(): Promise<void>;
}
/**
 * The model transport. The server owns the networked implementation (Codex SDK) and
 * injects it; this package never talks to the network.
 */
export interface CompilerTransport {
  readonly kind: 'codex' | 'offline';
  readonly model: string | null;
  open(request: CompileRequest, files: Record<string, string>): Promise<CompilerSession>;
}
