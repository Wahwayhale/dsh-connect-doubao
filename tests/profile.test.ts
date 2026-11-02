/**
 * Tests for Doubao profile discovery.
 *
 * The bug these lock down: the locator used to hardcode
 * `%LOCALAPPDATA%\Doubao\User Data`, so anyone running the app from another
 * drive — or who moved `User Data` there, which the installer offers — got
 * "Doubao user profile not found" on a perfectly working install.
 *
 * The interesting cases are the ordering ones. Cheap-but-wrong must not beat
 * expensive-but-right, and a stale copy must never shadow the live profile.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  describeProfileLocation,
  extractUserDataDir,
  findDoubaoUserDataDir,
  listDoubaoProfiles,
  PROFILE_ENV,
  setProfileOverride,
} from '../src/doubao-profile.ts'

let root: string

/** Build a fake profile directory that `looksLikeProfile` accepts. */
function makeProfile(parent: string, name = 'User Data'): string {
  const dir = join(parent, name)
  mkdirSync(join(dir, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Network', 'Cookies'), 'sqlite-placeholder', 'utf8')
  writeFileSync(join(dir, 'Local State'), '{}', 'utf8')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'doubao-profile-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('extractUserDataDir', () => {
  it('reads an unquoted value up to the next space', () => {
    expect(extractUserDataDir('Doubao.exe --user-data-dir=D:\\Data\\User Data /prefetch:4')).toBe(
      'D:\\Data\\User',
    )
  })

  it('reads a value quoted on its own', () => {
    expect(extractUserDataDir('Doubao.exe --user-data-dir="D:\\My Data\\User Data"')).toBe(
      'D:\\My Data\\User Data',
    )
  })

  it('reads a whole argument quoted, which is how Doubao actually emits it', () => {
    const line =
      'E:\\Doubao\\app\\Doubao.exe --type=crashpad-handler "--user-data-dir=C:\\Users\\u\\AppData\\Local\\Doubao\\User Data" /prefetch:4'
    expect(extractUserDataDir(line)).toBe('C:\\Users\\u\\AppData\\Local\\Doubao\\User Data')
  })

  it('returns undefined when the flag is absent', () => {
    expect(extractUserDataDir('Doubao.exe --type=gpu-process /prefetch:2')).toBeUndefined()
  })

  it('treats an empty value as absent rather than as the current directory', () => {
    expect(extractUserDataDir('Doubao.exe --user-data-dir= --flag')).toBeUndefined()
    expect(extractUserDataDir('Doubao.exe --user-data-dir=""')).toBeUndefined()
  })
})

describe('listDoubaoProfiles ordering', () => {
  it('honours the environment override above everything else', () => {
    const chosen = makeProfile(join(root, 'elsewhere'))
    const profiles = listDoubaoProfiles({
      env: { [PROFILE_ENV]: chosen },
      appDataBases: [],
      processCommandLines: () => [],
      scanRoots: [],
      platform: 'win32',
    })
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toEqual({ dir: chosen, source: 'env' })
  })

  it('accepts the parent directory in the override, since that is the natural reading', () => {
    const chosen = makeProfile(join(root, 'pkg'))
    const profiles = listDoubaoProfiles({
      env: { [PROFILE_ENV]: join(root, 'pkg') },
      appDataBases: [],
      processCommandLines: () => [],
      scanRoots: [],
      platform: 'win32',
    })
    expect(profiles[0]?.dir).toBe(chosen)
  })

  it('ignores an override that points nowhere useful instead of failing outright', () => {
    const fallback = makeProfile(join(root, 'appdata'))
    const profiles = listDoubaoProfiles({
      env: { [PROFILE_ENV]: join(root, 'does-not-exist') },
      appDataBases: [fallback],
      processCommandLines: () => [],
      scanRoots: [],
      platform: 'win32',
    })
    expect(profiles).toEqual([{ dir: fallback, source: 'appdata' }])
  })

  it('picks up the running client when AppData has nothing', () => {
    const live = makeProfile(join(root, 'd-drive'))
    const profiles = listDoubaoProfiles({
      env: {},
      appDataBases: [],
      processCommandLines: () => [`Doubao.exe "--user-data-dir=${live}"`],
      scanRoots: [],
      platform: 'win32',
    })
    expect(profiles).toEqual([{ dir: live, source: 'process' }])
  })

  it('does not trust a --user-data-dir whose Cookies file is missing', () => {
    const empty = join(root, 'empty')
    mkdirSync(join(empty, 'Default'), { recursive: true })
    const profiles = listDoubaoProfiles({
      env: {},
      appDataBases: [],
      processCommandLines: () => [`Doubao.exe "--user-data-dir=${empty}"`],
      scanRoots: [],
      platform: 'win32',
    })
    expect(profiles).toEqual([])
  })

  it('lists the stale AppData copy AND the live one so the caller can pick', () => {
    const stale = makeProfile(join(root, 'appdata'))
    const live = makeProfile(join(root, 'd-drive'))
    const profiles = listDoubaoProfiles({
      env: {},
      appDataBases: [stale],
      processCommandLines: () => [`Doubao.exe "--user-data-dir=${live}"`],
      scanRoots: [],
      platform: 'win32',
    })
    // Order is appdata → process: cheap first, but both are offered because the
    // credential loader retries on the ones that do not decrypt.
    expect(profiles.map((entry) => entry.source)).toEqual(['appdata', 'process'])
  })

  it('deduplicates case-insensitively, since the probe and AppData often agree', () => {
    const live = makeProfile(join(root, 'shared'))
    const profiles = listDoubaoProfiles({
      env: { [PROFILE_ENV]: live.toUpperCase() },
      appDataBases: [live],
      processCommandLines: () => [`Doubao.exe "--user-data-dir=${live}"`],
      scanRoots: [],
      platform: 'win32',
    })
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.source).toBe('env')
  })

  it('returns nothing on a non-Windows platform even with a valid override', () => {
    const chosen = makeProfile(join(root, 'unused'))
    expect(
      listDoubaoProfiles({ env: { [PROFILE_ENV]: chosen }, platform: 'linux' }),
    ).toEqual([])
  })
})

describe('scan fallback', () => {
  it('finds a profile nested a few levels down when every other strategy missed', () => {
    const deep = makeProfile(join(root, 'Apps', 'Tools', 'Doubao'))
    const profiles = listDoubaoProfiles({
      env: {},
      appDataBases: [],
      processCommandLines: () => [],
      scanRoots: [root],
      platform: 'win32',
    })
    expect(profiles).toEqual([{ dir: deep, source: 'scan' }])
  })

  it('skips the directories that never hold a profile and are expensive to walk', () => {
    const skipped = makeProfile(join(root, 'node_modules', 'pkg'))
    const profiles = listDoubaoProfiles({
      env: {},
      appDataBases: [],
      processCommandLines: () => [],
      scanRoots: [root],
      platform: 'win32',
    })
    expect(profiles.map((entry) => entry.dir)).not.toContain(skipped)
  })

  it('stops once the time budget is gone instead of walking a whole drive', () => {
    makeProfile(join(root, 'a'))
    mkdirSync(join(root, 'b', 'c', 'd'), { recursive: true })
    // First call establishes the deadline; every later call reports that the
    // budget is already spent, which is what a slow drive looks like.
    let calls = 0
    const profiles = listDoubaoProfiles({
      env: {},
      appDataBases: [],
      processCommandLines: () => [],
      scanRoots: [root],
      scanBudgetMs: 1500,
      now: () => (calls++ === 0 ? 0 : 10_000),
      platform: 'win32',
    })
    expect(profiles).toEqual([])
  })

  it('is not consulted at all when a cheaper strategy already answered', () => {
    const cheap = makeProfile(join(root, 'appdata'))
    let scanned = false
    const profiles = listDoubaoProfiles({
      env: {},
      appDataBases: [cheap],
      processCommandLines: () => [],
      get scanRoots() {
        scanned = true
        return []
      },
      platform: 'win32',
    })
    expect(profiles).toHaveLength(1)
    expect(scanned).toBe(false)
  })
})

describe('findDoubaoUserDataDir / describeProfileLocation', () => {
  it('returns the highest-priority directory', () => {
    const chosen = makeProfile(join(root, 'chosen'))
    expect(
      findDoubaoUserDataDir({
        env: { [PROFILE_ENV]: chosen },
        appDataBases: [],
        processCommandLines: () => [],
        scanRoots: [],
        platform: 'win32',
      }),
    ).toBe(chosen)
  })

  it('reports the source so a failing install is diagnosable', () => {
    const chosen = makeProfile(join(root, 'chosen'))
    expect(
      describeProfileLocation({
        env: { [PROFILE_ENV]: chosen },
        appDataBases: [],
        processCommandLines: () => [],
        scanRoots: [],
        platform: 'win32',
      }),
    ).toBe(`${chosen} (via env)`)
  })

  it('says <not found> rather than throwing when nothing matches', () => {
    expect(
      describeProfileLocation({
        env: {},
        appDataBases: [],
        processCommandLines: () => [],
        scanRoots: [],
        platform: 'win32',
      }),
    ).toBe('<not found>')
  })
})

describe('manual override', () => {
  it('wins over every automatic strategy', () => {
    // Someone who picks a folder in the card has already answered the question
    // the probes are asking, so no probe is consulted at all.
    const manual = makeProfile(root, 'Chosen')
    const appdata = makeProfile(join(root, 'appdata'), 'User Data')
    // `processCommandLines` is stubbed because this machine runs a real client:
    // without it the probe returns the developer's own profile and the test
    // would pass or fail depending on whose laptop it runs on.
    const profiles = listDoubaoProfiles({
      manual,
      appDataBases: [join(root, 'appdata', 'User Data')],
      processCommandLines: () => [],
    })
    expect(profiles[0]).toEqual({ dir: manual, source: 'manual' })
    expect(profiles.some(entry => entry.dir === appdata)).toBe(true)
  })

  it('is ignored when the folder holds no Doubao data', () => {
    // A stale pick must not brick credential loading: the automatic probes run
    // instead, so the user sees their quota with a wrong-but-working path
    // rather than "not found" forever.
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    const appdata = makeProfile(join(root, 'appdata'), 'User Data')
    const profiles = listDoubaoProfiles({
      manual: empty,
      appDataBases: [join(root, 'appdata', 'User Data')],
      processCommandLines: () => [],
    })
    expect(profiles).toEqual([{ dir: appdata, source: 'appdata' }])
  })

  it('accepts the parent folder and looks one level down', () => {
    // The picker hands back whatever the user clicked, and people click the
    // install folder (`D:\Doubao`) rather than the `User Data` inside it.
    const manual = makeProfile(root, 'User Data')
    const profiles = listDoubaoProfiles({ manual: root, appDataBases: [], processCommandLines: () => [] })
    expect(profiles[0]).toEqual({ dir: manual, source: 'manual' })
  })

  it('survives a module-level override being set and cleared', () => {
    const manual = makeProfile(root, 'Chosen')
    setProfileOverride(manual)
    try {
      expect(listDoubaoProfiles({ appDataBases: [], processCommandLines: () => [] })[0]?.source).toBe('manual')
      setProfileOverride(undefined)
      // Nothing left to find: no appdata candidate, no client process, and the
      // drive scan is kept out of the way with a zero budget.
      expect(listDoubaoProfiles({
        appDataBases: [],
        processCommandLines: () => [],
        scanRoots: [],
      })).toEqual([])
    } finally {
      setProfileOverride(undefined)
    }
  })

  it('ignores a module-level override pointing at nothing', () => {
    setProfileOverride(join(root, 'missing'))
    try {
      const profiles = listDoubaoProfiles({ appDataBases: [], processCommandLines: () => [] })
      expect(profiles.some(entry => entry.source === 'manual')).toBe(false)
    } finally {
      setProfileOverride(undefined)
    }
  })
})
