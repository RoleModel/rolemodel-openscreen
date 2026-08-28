#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/*
 * These are the outputs `pnpm run build` owns. Stage only this closed list so a
 * commit never silently picks up unrelated working files, while the generated
 * token, Figma, icon, imagery, and wallpaper files that CI checks travel with
 * their source change.
 */
const GENERATED = [
  'brand/tokens.json',
  'brand/optics',
  'brand/figma/light.tokens.json',
  'brand/figma/dark.tokens.json',
  'brand/figma/Color Styles.Light.tokens.json',
  'brand/figma/Color Styles.Dark.tokens.json',
  'brand/icons',
  'brand/imagery/index.json',
  'brand/wallpapers',
  'brand/wallpapers.json',
]

console.log('\nPre-commit: regenerating brand artifacts…')
run('pnpm', ['run', 'build'])

console.log('\nPre-commit: staging regenerated artifacts…')
run('git', ['add', '--all', '--', ...GENERATED])

console.log('\nPre-commit: running the CI gate…')
run('pnpm', ['run', 'check:ci'])
