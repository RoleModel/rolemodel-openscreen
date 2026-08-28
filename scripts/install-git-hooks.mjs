#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })

// A package install is also used when the toolkit is unpacked outside Git. In
// that case there is nothing to configure and installation must still succeed.
if (git(['rev-parse', '--is-inside-work-tree']).status !== 0 || process.env.CI) process.exit(0)

const existing = git(['config', '--get', 'core.hooksPath']).stdout.trim()
if (existing && existing !== '.githooks') {
  console.warn(`RoleModel Studio left your existing Git hooks path alone (${existing}).`)
  console.warn('To use this repository’s pre-commit gate, run: git config core.hooksPath .githooks')
  process.exit(0)
}

const configured = git(['config', 'core.hooksPath', '.githooks'])
if (configured.status !== 0) {
  console.warn('RoleModel Studio could not configure Git hooks automatically.')
  console.warn('Run: git config core.hooksPath .githooks')
}
