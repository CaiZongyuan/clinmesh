#!/usr/bin/env node

import { runCli } from './cli.ts'
import { createRuntimeDependencies } from './runtime.ts'

const exitCode = await runCli(process.argv.slice(2), {
  stderr: process.stderr,
  stdout: process.stdout,
}, createRuntimeDependencies())
process.exitCode = exitCode
