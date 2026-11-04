// SPDX-License-Identifier: AGPL-3.0-only
// Bounded child-process runner for ffmpeg/ffprobe: hard timeout (SIGKILL), capped stderr capture, and
// errors that name the tool and exit status but never the arguments (which contain temp paths).
import { spawn } from 'node:child_process';

export interface ExecOptions {
  timeoutMs: number;
  /** Bytes of stdout to keep (ffprobe JSON); stderr keeps the last 8 KiB for logs. */
  maxStdoutBytes?: number;
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderrTail: string;
}

export class ToolError extends Error {
  constructor(
    public readonly tool: string,
    public readonly kind: 'exit' | 'timeout' | 'spawn' | 'output',
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
  ) {
    super(
      kind === 'timeout'
        ? `${tool} timed out`
        : kind === 'spawn'
          ? `${tool} could not be started`
          : kind === 'output'
            ? `${tool} produced too much output`
            : `${tool} exited with status ${exitCode ?? 'signal'}`,
    );
    this.name = 'ToolError';
  }
}

const STDERR_KEEP = 8 * 1024;

export function execTool(tool: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const maxStdout = opts.maxStdoutBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(tool, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
    } catch {
      reject(new ToolError(tool, 'spawn', null, ''));
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let errTail = '';
    let settled = false;
    let timedOut = false;
    let tooMuch = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > maxStdout) {
        tooMuch = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.on('error', () => finish(() => reject(new ToolError(tool, 'spawn', null, errTail))));
    child.on('close', (code) =>
      finish(() => {
        if (timedOut) reject(new ToolError(tool, 'timeout', code, errTail));
        else if (tooMuch) reject(new ToolError(tool, 'output', code, errTail));
        else if (code !== 0) reject(new ToolError(tool, 'exit', code, errTail));
        else resolve({ stdout: Buffer.concat(out).toString('utf8'), stderrTail: errTail });
      }),
    );
  });
}
