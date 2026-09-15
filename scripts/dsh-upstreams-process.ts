import { execFile, spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

async function terminateTree(child: ChildProcess) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
    }
    return
  }
  const group = -child.pid
  try { process.kill(group, 'SIGTERM') } catch { return }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try { process.kill(group, 0) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  try { process.kill(group, 'SIGKILL') } catch { /* 进程组已退出。 */ }
}

/** POSIX 命令拥有独立进程组；Windows 取消时通过 taskkill 回收仍由 launcher 拥有的子树。 */
export function startManagedProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
  const child = spawn(command, args, {
    ...options, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let interrupted = false
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= terminateTree(child).finally(() => {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
    })
    return stopping
  }
  const interrupt = () => { interrupted = true; void stop() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  child.once('exit', () => { void stop() })
  child.once('error', () => { void stop() })
  return { child, stop, wasInterrupted: () => interrupted }
}
