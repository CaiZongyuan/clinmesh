import type { ChildProcess } from 'node:child_process'
import spawn from 'cross-spawn'
import { resolve } from 'node:path'

export interface DevelopmentProcessOutput {
  /** 日志行前缀；同时开启 stdout/stderr 管道与 onText 回调。 */
  prefix: string
  /** 收到原始输出文本（含 stdout 与 stderr，不做分行）时调用。 */
  onText?: (text: string) => void
}

export interface DevelopmentProcess {
  command?: string
  args: string[]
  environment: Record<string, string>
  name: string
  output?: DevelopmentProcessOutput
}

export interface DevelopmentProcessPlan {
  processes: DevelopmentProcess[]
}

/** 按行缓冲输出并以 prefix 逐行转发；残留的最后一行由 flush 补发。 */
export function createPrefixedLineWriter(
  prefix: string,
  write: (line: string) => void,
): { write: (text: string) => void, flush: () => void } {
  let buffered = ''
  const emit = (): void => {
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '')
      if (line.length > 0) write(`${prefix} ${line}`)
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
  return {
    write: (text) => {
      buffered += text
      emit()
    },
    flush: () => {
      if (buffered.length > 0) {
        write(`${prefix} ${buffered.replace(/\r$/, '')}`)
        buffered = ''
      }
    },
  }
}

/** POSIX 使用进程组，Windows 使用 Job Object；任一退出或收到终止信号时停止全部子树。 */
export async function runDevelopmentProcesses(plan: DevelopmentProcessPlan): Promise<number> {
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const useProcessGroups = process.platform !== 'win32'
  const running: Array<{ child: ChildProcess, name: string, output?: DevelopmentProcessOutput }> = plan
    .processes.map(configuration => {
      const command = configuration.command ?? packageManager
      const executable = process.platform === 'win32' ? 'powershell.exe' : command
      const args = process.platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
            resolve(import.meta.dirname, 'windows-process-job.ps1'), process.execPath,
            resolve(import.meta.dirname, 'windows-process-bootstrap.mjs'),
            Buffer.from(JSON.stringify({ command, args: configuration.args })).toString('base64')]
        : configuration.args
      return {
        child: spawn(executable, args, {
          cwd: repositoryRoot,
          detached: useProcessGroups,
          windowsHide: true,
          env: { ...process.env, ...configuration.environment },
          stdio: configuration.output === undefined
            ? 'inherit'
            : ['ignore', 'pipe', 'pipe'],
        }),
        name: configuration.name,
        output: configuration.output,
      }
    })

  for (const { child, output } of running) {
    if (output === undefined || child.stdout === null || child.stderr === null) continue
    const stdoutWriter = createPrefixedLineWriter(output.prefix, line => process.stdout.write(`${line}\n`))
    const stderrWriter = createPrefixedLineWriter(output.prefix, line => process.stderr.write(`${line}\n`))
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdoutWriter.write(text)
      output.onText?.(text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderrWriter.write(text)
      output.onText?.(text)
    })
    child.stdout.once('end', () => stdoutWriter.flush())
    child.stderr.once('end', () => stderrWriter.flush())
  }

  return await new Promise((resolveExitCode) => {
    let closed = 0
    let exitCode = 0
    let stopping = false

    const stop = (signal: NodeJS.Signals, code: number): void => {
      if (stopping) return
      stopping = true
      exitCode = code
      for (const { child } of running) {
        if (!useProcessGroups || child.pid === undefined) {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal)
          continue
        }
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }

    const interrupt = () => stop('SIGINT', 0)
    const terminate = () => stop('SIGTERM', 0)
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)

    for (const { child, name } of running) {
      child.once('error', (error) => {
        console.error(`${name} failed to start:`, error)
        stop('SIGTERM', 1)
      })
      child.once('close', (code, signal) => {
        closed += 1
        if (!stopping) {
          if (code !== 0) console.error(`${name} exited with ${code ?? signal ?? 'unknown status'}`)
          stop('SIGTERM', code ?? 1)
        }
        if (closed === running.length) {
          process.removeListener('SIGINT', interrupt)
          process.removeListener('SIGTERM', terminate)
          resolveExitCode(exitCode)
        }
      })
    }
  })
}
