import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

export interface DevelopmentProcess {
  command?: string
  args: string[]
  environment: Record<string, string>
  name: string
}

export interface DevelopmentProcessPlan {
  processes: DevelopmentProcess[]
}

/** 以进程组方式并行启动开发进程；任一退出或收到 SIGINT/SIGTERM 时停止全部。 */
export async function runDevelopmentProcesses(plan: DevelopmentProcessPlan): Promise<number> {
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const useProcessGroups = process.platform !== 'win32'
  const running: Array<{ child: ChildProcess, name: string }> = plan.processes.map(configuration => ({
    child: spawn(configuration.command ?? packageManager, configuration.args, {
      cwd: repositoryRoot,
      detached: useProcessGroups,
      env: { ...process.env, ...configuration.environment },
      stdio: 'inherit',
    }),
    name: configuration.name,
  }))

  return await new Promise((resolveExitCode) => {
    let closed = 0
    let exitCode = 0
    let stopping = false

    const stop = (signal: NodeJS.Signals, code: number): void => {
      if (stopping) return
      stopping = true
      exitCode = code
      for (const { child } of running) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        if (!useProcessGroups || child.pid === undefined) {
          child.kill(signal)
          continue
        }
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }

    process.once('SIGINT', () => stop('SIGINT', 0))
    process.once('SIGTERM', () => stop('SIGTERM', 0))

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
        if (closed === running.length) resolveExitCode(exitCode)
      })
    }
  })
}
