#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=')
  return [key, value.join('=')]
}))
const root = resolve(args.root || process.cwd())
const tag = args.tag || process.env.GITHUB_REF_NAME || ''
const repository = args.repository || process.env.GITHUB_REPOSITORY || 'tilianb/hidemyemail'
const notesOutput = args['notes-output']
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function fail(message) {
  console.error(`Release validation failed: ${message}`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

function match(path, pattern, label) {
  const value = readFileSync(resolve(root, path), 'utf8').match(pattern)?.[1]
  if (!value) fail(`could not read ${label} from ${path}`)
  return value
}

const version = tag.match(stableTagPattern)?.[0]?.slice(1)
if (!version) fail(`tag ${JSON.stringify(tag)} is not stable SemVer vX.Y.Z`)
const currentParts = version.split('.').map(BigInt)

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

const versions = {
  'worker/package.json': readJson('worker/package.json').version,
  'worker/package-lock.json': readJson('worker/package-lock.json').version,
  'dashboard/package.json': readJson('dashboard/package.json').version,
  'dashboard/package-lock.json': readJson('dashboard/package-lock.json').version,
  'Android versionName': match('android/app/build.gradle.kts', /versionName\s*=\s*"([^"]+)"/, 'versionName'),
  'iOS MARKETING_VERSION': match('ios/project.yml', /^\s*MARKETING_VERSION:\s*"([^"]+)"/m, 'MARKETING_VERSION'),
}
for (const [source, actual] of Object.entries(versions)) {
  if (actual !== version) fail(`${source} is ${actual}; expected ${version} from ${tag}`)
}

const versionCode = Number(match('android/app/build.gradle.kts', /versionCode\s*=\s*(\d+)/, 'versionCode'))
let previousTag = args['previous-tag']
if (previousTag === undefined) {
  const tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n')
    .map((candidate) => ({ candidate, match: candidate.match(stableTagPattern) }))
    .filter(({ candidate, match }) => candidate !== tag && match)
    .map(({ candidate, match }) => ({ candidate, parts: match.slice(1).map(BigInt) }))
    .filter(({ parts }) => compareVersions(parts, currentParts) < 0)
    .sort((left, right) => compareVersions(right.parts, left.parts))
  previousTag = tags[0]?.candidate || ''
}
if (previousTag) {
  let previousGradle
  try {
    previousGradle = execFileSync('git', ['show', `${previousTag}:android/app/build.gradle.kts`], { cwd: root, encoding: 'utf8' })
  } catch {
    fail(`could not read Android versionCode from previous stable tag ${previousTag}`)
  }
  const previousCode = Number(previousGradle.match(/versionCode\s*=\s*(\d+)/)?.[1])
  if (!Number.isInteger(previousCode)) fail(`could not read Android versionCode from previous stable tag ${previousTag}`)
  if (versionCode <= previousCode) fail(`Android versionCode ${versionCode} must exceed ${previousCode} from ${previousTag}`)
} else {
  console.log('No previous stable tag found; skipping Android versionCode comparison for first release.')
}

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
const escapedVersion = version.replaceAll('.', '\\.')
const section = changelog.match(new RegExp(`^## \\[${escapedVersion}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm'))?.[1]?.trim()
if (!section) fail(`CHANGELOG.md has no non-empty section for ${version}`)
if (!/^### Upgrade Notes\s*$/m.test(section)) fail(`CHANGELOG.md ${version} section lacks "### Upgrade Notes"`)
if (!notesOutput) fail('--notes-output is required')

const comparison = previousTag
  ? `https://github.com/${repository}/compare/${previousTag}...${tag}`
  : `https://github.com/${repository}/releases/tag/${tag}`
writeFileSync(resolve(root, notesOutput), `${section}\n\n[Full comparison](${comparison})\n`)
console.log(`Validated ${tag}; release notes written to ${notesOutput}.`)
