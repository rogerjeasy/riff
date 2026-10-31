import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { Codex, type ModelReasoningEffort, type ThreadEvent } from '@openai/codex-sdk';
import {
  COMPILE_OUTPUT_JSON_SCHEMA,
  type CompilerTransport,
  type CompilerUsage,
} from '@riff/compiler';

export interface CodexTransportOptions {
  model: string | null;
  reasoningEffort: ModelReasoningEffort;
  /** Source of the operator's Codex login; only auth.json is copied into the run. */
  codexHome?: string;
}

/**
 * Runtime compiler transport backed by the Codex SDK. Each compile gets:
 * - a fresh temp working directory holding exactly the files the compiler may see,
 * - a fresh temp CODEX_HOME holding only the login (no user config, AGENTS.md,
 *   plugins or MCP servers are inherited),
 * - a read-only sandbox, no command network access, no web search, no approvals,
 * - a minimal environment (no application secrets or Twitch credentials).
 * Both directories are deleted when the session closes.
 */
export function createCodexTransport(options: CodexTransportOptions): CompilerTransport {
  const sourceHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return {
    kind: 'codex',
    model: options.model,
    async open(_request, files) {
      const root = await mkdtemp(join(tmpdir(), 'riff-compile-'));
      const workspace = join(root, 'workspace');
      const home = join(root, 'codex-home');
      await mkdir(workspace, { recursive: true });
      await mkdir(home, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(files)) {
        const target = normalize(join(workspace, name));
        if (!target.startsWith(workspace + sep))
          throw new Error('Refusing a path outside the workspace');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { mode: 0o444 });
      }
      const auth = join(sourceHome, 'auth.json');
      if (existsSync(auth)) {
        await copyFile(auth, join(home, 'auth.json'));
        await chmod(join(home, 'auth.json'), 0o600);
      }
      const env: Record<string, string> = {
        CODEX_HOME: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      };
      for (const key of ['HOME', 'LANG', 'TMPDIR', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const) {
        const value = process.env[key];
        if (value) env[key] = value;
      }
      // Ask for concise reasoning summaries so the console can show honest live progress.
      const codex = new Codex({ env, config: { model_reasoning_summary: 'concise' } });
      const thread = codex.startThread({
        workingDirectory: workspace,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        modelReasoningEffort: options.reasoningEffort,
        ...(options.model ? { model: options.model } : {}),
      });
      return {
        get threadId() {
          return thread.id;
        },
        async turn(prompt, { signal, onProgress }) {
          const { events } = await thread.runStreamed(prompt, {
            outputSchema: COMPILE_OUTPUT_JSON_SCHEMA,
            signal,
          });
          let final = '';
          let usage: CompilerUsage | null = null;
          const seen = new Set<string>();
          for await (const event of events as AsyncGenerator<ThreadEvent>) {
            if (event.type === 'turn.started') {
              onProgress({
                kind: 'status',
                text: 'Codex is designing the handler, permission manifest and tests…',
              });
            } else if (event.type === 'item.started' && event.item.type === 'agent_message') {
              onProgress({ kind: 'status', text: 'Codex is writing the structured candidate…' });
            } else if (event.type === 'item.completed' || event.type === 'item.updated') {
              const item = event.item;
              const key = `${item.id}:${event.type}`;
              if (item.type === 'reasoning' && item.text.trim() && !seen.has(key)) {
                seen.add(key);
                onProgress({
                  kind: 'thinking',
                  text: item.text.replace(/\*\*/g, '').trim().slice(0, 400),
                });
              } else if (item.type === 'command_execution' && event.type === 'item.completed') {
                onProgress({ kind: 'command', text: item.command.slice(0, 200) });
              } else if (item.type === 'agent_message' && event.type === 'item.completed') {
                final = item.text;
              } else if (item.type === 'error') {
                onProgress({ kind: 'status', text: item.message.slice(0, 200) });
              }
            } else if (event.type === 'turn.completed') {
              usage = {
                inputTokens: event.usage.input_tokens,
                cachedInputTokens: event.usage.cached_input_tokens,
                outputTokens: event.usage.output_tokens,
              };
            } else if (event.type === 'turn.failed') {
              throw new Error(event.error.message);
            } else if (event.type === 'error') {
              throw new Error(event.message);
            } else if (event.type === 'thread.started') {
              onProgress({ kind: 'status', text: 'Codex thread started.' });
            }
          }
          if (!final) throw new Error('Codex returned no structured response');
          return { output: JSON.parse(final) as unknown, usage };
        },
        async close() {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}
