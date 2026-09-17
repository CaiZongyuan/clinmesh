import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createDshCommandRunner } from './dev-dsh.ts'

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

it.each(['startup', 'SIGINT', 'SIGTERM', 'failure'] as const)('cleans both process trees on %s, including orphaned descendants', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh process 中文 '))
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const pids: number[] = []
  try {
    const fixture = join(directory, 'child.cjs')
    await writeFile(fixture, `
const { spawn } = require('node:child_process')
const { writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const [directory, role, mode] = process.argv.slice(2)
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' })
writeFileSync(join(directory, role + '.pid'), String(grandchild.pid))
console.log('starting-' + role)
setTimeout(() => console.log('ready-' + role), 200)
if (mode === 'failure' && role === 'first') {
  setInterval(() => { if (existsSync(join(directory, 'second.pid'))) process.exit(7) }, 20)
} else setInterval(() => {}, 1000)
`)
    const harness = join(directory, 'harness.mts')
    const command = process.platform === 'win32' ? join(directory, 'launcher.cmd') : process.execPath
    if (process.platform === 'win32') await writeFile(command, `@echo off\r\n"${process.execPath}" %*\r\n`)
    await writeFile(harness, `
import { runDevelopmentProcesses } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'development-processes.ts')).href)}
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const ready = new Set()
const code = await runDevelopmentProcesses({ processes: ['first', 'second'].map(role => ({
  name: role, command: ${JSON.stringify(command)}, args: [${JSON.stringify(fixture)}, ${JSON.stringify(directory)}, role, ${JSON.stringify(mode)}], environment: {},
  output: { prefix: role, onText(text) {
    if (${JSON.stringify(mode)} === 'startup' && text.includes('starting-')) process.emit('SIGINT')
    if (text.includes('ready-' + role)) ready.add(role)
    if (ready.size === 2 && ['SIGINT', 'SIGTERM'].includes(${JSON.stringify(mode)})) process.emit(${JSON.stringify(mode)})
  } }
})) })
console.log('exit-code=' + code)
const readPid = role => {
  const path = join(${JSON.stringify(directory)}, role + '.pid')
  if (!existsSync(path)) return 0
  return Number(readFileSync(path, 'utf8'))
}
const alive = pid => {
  if (pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
// 刚被杀掉的孤儿进程在内核收尸前仍能被 kill(pid, 0) 探测为存活，轮询等待回收完成后再判定
const deadline = Date.now() + 3000
let survivors = ['first', 'second'].filter(role => alive(readPid(role)))
while (survivors.length > 0 && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
  survivors = ['first', 'second'].filter(role => alive(readPid(role)))
}
console.log('survivors=' + survivors.join(','))
process.exitCode = 0
`)
    const output = await createDshCommandRunner()(process.execPath, ['--import', 'tsx', harness], process.cwd(), undefined, { quiet: true })
    for (const role of ['first', 'second']) {
      const pid = Number(await readFile(join(directory, `${role}.pid`), 'utf8').catch(() => '0'))
      if (pid > 0) pids.push(pid)
    }
    expect(pids.length).toBeGreaterThanOrEqual(mode === 'startup' ? 1 : 2)
    if (mode === 'startup') expect(output).not.toContain('ready-')
    expect(output).toContain(`exit-code=${mode === 'failure' ? 7 : 0}`)
    expect(output).toMatch(/survivors=\r?\n/)
    await expect.poll(() => pids.every(pid => !alive(pid)), { timeout: 3000 }).toBe(true)
    expect(alive(unrelated.pid!)).toBe(true)
  } finally {
    unrelated.kill()
    for (const role of ['first', 'second']) {
      const pid = Number(await readFile(join(directory, `${role}.pid`), 'utf8').catch(() => '0'))
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
