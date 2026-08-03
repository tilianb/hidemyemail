import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const validator = resolve(import.meta.dirname, '../scripts/validate-release.mjs')
const releaseWorkflow = resolve(import.meta.dirname, '../../.github/workflows/release.yml')
const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(version = '2.0.0', changelog = `## [2.0.0] - 2026-07-26\n\nThis release improves security and reliability for every deployment.\n\n### Added\n\nCurrent notes.\n\n### Upgrade Notes\n\nNone.\n`, withGit = false) {
  const root = mkdtempSync(join(tmpdir(), 'release-validator-'))
  roots.push(root)
  for (const path of ['worker', 'dashboard', 'extension', 'android/app', 'ios']) mkdirSync(join(root, path), { recursive: true })
  for (const path of ['worker/package.json', 'dashboard/package.json', 'extension/package.json']) {
    writeFileSync(join(root, path), JSON.stringify({ version }))
  }
  for (const path of ['worker/package-lock.json', 'dashboard/package-lock.json', 'extension/package-lock.json']) {
    writeFileSync(join(root, path), JSON.stringify({ version, packages: { '': { version } } }))
  }
  writeFileSync(join(root, 'extension/manifest.json'), JSON.stringify({ version }))
  writeFileSync(join(root, 'android/app/build.gradle.kts'), `versionCode = 20\nversionName = "${version}"\n`)
  writeFileSync(join(root, 'ios/project.yml'), `MARKETING_VERSION: "${version}"\nCURRENT_PROJECT_VERSION: "${version}"\n`)
  writeFileSync(join(root, 'CHANGELOG.md'), changelog)
  if (withGit) {
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: root })
  }
  return root
}

function run(root, tag = 'v2.0.0', extra = []) {
  return spawnSync(process.execPath, [validator, `--root=${root}`, `--tag=${tag}`, '--repository=owner/repo', '--notes-output=notes.md', ...extra], { encoding: 'utf8' })
}

test('selects the highest lower stable tag and ignores RC, build, higher, and malformed tags', () => {
  const root = fixture(undefined, undefined, true)
  for (const [tag, code] of [['v1.8.0', 18], ['v1.9.0', 19], ['v1.9.1-rc.1', 99], ['v1.9.2+build', 99], ['v2.1.0', 99], ['vgarbage', 99]]) {
    writeFileSync(join(root, 'android/app/build.gradle.kts'), `versionCode = ${code}\nversionName = "2.0.0"\n`)
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', tag], { cwd: root })
    execFileSync('git', ['tag', tag], { cwd: root })
  }
  writeFileSync(join(root, 'android/app/build.gradle.kts'), 'versionCode = 20\nversionName = "2.0.0"\n')
  const result = run(root)
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(root, 'notes.md'), 'utf8')).toContain('/compare/v1.9.0...v2.0.0')
})

test('compares arbitrarily large stable SemVer identifiers without precision loss', () => {
  const version = '9007199254740993.0.0'
  const root = fixture(version, `## [${version}]\n\nCurrent notes.\n\n### Upgrade Notes\n\nNone.\n`, true)
  for (const [tag, code] of [['v9007199254740992.0.0', 19], ['v9007199254740994.0.0', 99]]) {
    writeFileSync(join(root, 'android/app/build.gradle.kts'), `versionCode = ${code}\nversionName = "${version}"\n`)
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', tag], { cwd: root })
    execFileSync('git', ['tag', tag], { cwd: root })
  }
  writeFileSync(join(root, 'android/app/build.gradle.kts'), `versionCode = 20\nversionName = "${version}"\n`)

  const result = run(root, `v${version}`)

  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(root, 'notes.md'), 'utf8')).toContain(`/compare/v9007199254740992.0.0...v${version}`)
})

test('validates the exact remote tag before release jobs fan out', () => {
  const workflow = readFileSync(releaseWorkflow, 'utf8')
  const earlyCheck = workflow.indexOf('name: Validate exact remote tag')
  const versionCheck = workflow.indexOf('name: Validate versions, Android versionCode, and release notes')
  const fanOut = workflow.indexOf('\n  android:')

  expect(earlyCheck).toBeGreaterThan(versionCheck)
  expect(fanOut).toBeGreaterThan(earlyCheck)
  expect(workflow.slice(earlyCheck, fanOut)).toContain('refs/tags/$GITHUB_REF_NAME:$remote_ref')
  expect(workflow.slice(earlyCheck, fanOut)).toContain('remote_tag_commit')
  expect(workflow.slice(earlyCheck, fanOut)).toContain('GITHUB_SHA')
  for (const job of ['android', 'extension', 'testflight', 'containers']) {
    expect(workflow).toMatch(new RegExp(`  ${job}:[\\s\\S]*?needs: validate`))
  }
  expect(workflow).toContain('needs: [validate, android, extension, testflight, containers]')
  expect(workflow).toContain('release-extension-${{ github.run_id }}-chromium')
})

test('retains reference definitions inside notes and stops at the next version', () => {
  const root = fixture('2.0.0', `## [2.0.0]\n\nSee [guide][setup].\n\n[setup]: https://example.com/setup\n\n### Upgrade Notes\n\nNone.\n\n## [1.0.0]\n\nOld.\n\n[2.0.0]: https://example.com/releases/2\n`)
  const result = run(root, 'v2.0.0', ['--previous-tag='])
  expect(result.status, result.stderr).toBe(0)
  const notes = readFileSync(join(root, 'notes.md'), 'utf8')
  expect(notes).toContain('[setup]: https://example.com/setup')
  expect(notes).not.toContain('Old.')
  expect(notes).not.toContain('[2.0.0]:')
})

test('accepts a release section ending at EOF', () => {
  const root = fixture()
  expect(run(root, 'v2.0.0', ['--previous-tag=']).status).toBe(0)
})

test.each([
  ['', 'no non-empty section'],
  ['## [2.0.0]\n', 'no non-empty section'],
  ['## [2.0.0]\n\n### Added\n\nNotes only.\n\n### Upgrade Notes\n\nNone.\n', 'must start with a user-facing summary'],
  ['## [2.0.0]\n\nA user-facing summary.\n', 'lacks "### Upgrade Notes"'],
])('rejects missing release requirements', (changelog, error) => {
  const root = fixture('2.0.0', changelog)
  const result = run(root, 'v2.0.0', ['--previous-tag='])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(error)
})

test('rejects manifest and tag version mismatches', () => {
  const root = fixture('2.0.0')
  const result = run(root, 'v2.0.1', ['--previous-tag='])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('expected 2.0.1')
})

test.each(['extension/package.json', 'extension/package-lock.json', 'extension/manifest.json'])('rejects extension version mismatch in %s', (path) => {
  const root = fixture('2.0.0')
  writeFileSync(join(root, path), JSON.stringify({ version: '1.9.9' }))
  const result = run(root, 'v2.0.0', ['--previous-tag='])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${path} is 1.9.9`)
})

test.each(['worker/package-lock.json', 'dashboard/package-lock.json', 'extension/package-lock.json'])(
  'rejects lockfile root package version mismatch in %s',
  (path) => {
    const root = fixture('2.0.0')
    writeFileSync(join(root, path), JSON.stringify({ version: '2.0.0', packages: { '': { version: '1.9.9' } } }))
    const result = run(root, 'v2.0.0', ['--previous-tag='])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${path} packages[""].version is 1.9.9`)
  },
)

test('rejects iOS current project version mismatch', () => {
  const root = fixture('2.0.0')
  writeFileSync(join(root, 'ios/project.yml'), 'MARKETING_VERSION: "2.0.0"\nCURRENT_PROJECT_VERSION: "1.9.9"\n')
  const result = run(root, 'v2.0.0', ['--previous-tag='])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('iOS CURRENT_PROJECT_VERSION is 1.9.9')
})
