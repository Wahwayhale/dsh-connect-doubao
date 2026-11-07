/**
 * Tests for the plugin's own settings file.
 *
 * These matter more than the average unit test: this file is the ONLY place a
 * setting can be persisted (the host settings path is closed to this plugin —
 * see `src/doubao-store.ts`), so a regression here is the silent-revert bug
 * coming back.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readStoredSettings,
  settingsFilePath,
  withStoredSettings,
  writeStoredSetting,
} from '../src/doubao-store.ts'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doubao-store-'))
  file = join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readStoredSettings', () => {
  it('returns {} when the file does not exist', () => {
    expect(readStoredSettings(file)).toEqual({})
  })

  it('returns {} for corrupt JSON rather than throwing', () => {
    writeFileSync(file, '{not json', 'utf8')
    expect(readStoredSettings(file)).toEqual({})
  })

  it('keeps only recognised, correctly typed fields', () => {
    writeFileSync(file, JSON.stringify({
      enabledModelIds: ['0', 7, '3'],
      toolEmulation: 'yes',
      somethingElse: 'ignored',
    }), 'utf8')
    const stored = readStoredSettings(file)
    expect(stored.enabledModelIds).toEqual(['0', '3'])
    expect(stored.toolEmulation).toBeUndefined()
  })
})

describe('writeStoredSetting', () => {
  it('creates the file and the parent directory on first write', () => {
    const nested = join(dir, 'a', 'b', 'settings.json')
    writeStoredSetting('toolEmulation', true, nested)
    expect(readStoredSettings(nested)).toEqual({ toolEmulation: true })
  })

  it('merges into existing fields instead of replacing the object', () => {
    writeStoredSetting('enabledModelIds', ['0'], file)
    writeStoredSetting('toolEmulation', true, file)
    expect(readStoredSettings(file)).toEqual({ enabledModelIds: ['0'], toolEmulation: true })
  })

  it('overwrites the same field', () => {
    writeStoredSetting('toolEmulation', true, file)
    writeStoredSetting('toolEmulation', false, file)
    expect(readStoredSettings(file)).toEqual({ toolEmulation: false })
  })

  it('leaves no temp file behind', () => {
    writeStoredSetting('toolEmulation', true, file)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects an unknown field', () => {
    expect(() => { writeStoredSetting('nope', true, file) }).toThrow('not persistable')
  })

  it('rejects a wrong value type without touching the file', () => {
    writeStoredSetting('toolEmulation', true, file)
    expect(() => { writeStoredSetting('toolEmulation', 'true', file) }).toThrow('invalid value')
    expect(readStoredSettings(file)).toEqual({ toolEmulation: true })
  })

  it('rejects a non-string element in the model list', () => {
    expect(() => { writeStoredSetting('enabledModelIds', ['0', 3], file) }).toThrow('invalid value')
  })

  it('writes valid JSON that a fresh read can parse', () => {
    writeStoredSetting('enabledModelIds', ['0', '3'], file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ enabledModelIds: ['0', '3'] })
  })
})

describe('withStoredSettings', () => {
  it('falls back to the Loader config when no file exists', () => {
    const merged = withStoredSettings({ enabledModelIds: ['0'], toolEmulation: true }, file)
    expect(merged).toEqual({ enabledModelIds: ['0'], toolEmulation: true, profileDir: '' })
  })

  it('lets the file win over the Loader config', () => {
    // The file is the only place a write can land, so a disagreeing Loader
    // config is stale by definition — trusting it would resurrect the bug.
    writeStoredSetting('toolEmulation', false, file)
    const merged = withStoredSettings({ enabledModelIds: ['0'], toolEmulation: true }, file)
    expect(merged.toolEmulation).toBe(false)
    expect(merged.enabledModelIds).toEqual(['0'])
  })

  it('stores and returns the manual profile directory', () => {
    writeStoredSetting('profileDir', 'D:/Doubao/User Data', file)
    expect(readStoredSettings(file)).toEqual({ profileDir: 'D:/Doubao/User Data' })
  })

  it('lets a stored profile directory win over the Loader config', () => {
    // A recorded pick is the one value we know reached disk, so a disagreeing
    // Loader entry is stale by definition.
    writeStoredSetting('profileDir', 'D:/Doubao/User Data', file)
    const merged = withStoredSettings({ profileDir: 'C:/stale' }, file)
    expect(merged.profileDir).toBe('D:/Doubao/User Data')
  })

  it('falls back to the Loader profile directory before the empty default', () => {
    const merged = withStoredSettings({ profileDir: 'E:/Doubao/User Data' }, file)
    expect(merged.profileDir).toBe('E:/Doubao/User Data')
  })

  it('treats a blank profile directory as unset so auto-detection resumes', () => {
    writeStoredSetting('profileDir', '', file)
    const merged = withStoredSettings({ profileDir: 'E:/Doubao/User Data' }, file)
    expect(merged.profileDir).toBe('')
  })

  it('rejects a non-string profile directory', () => {
    expect(() => { writeStoredSetting('profileDir', 42, file) }).toThrow('invalid value')
  })

  it('defaults to an empty model list, tools off and automatic discovery', () => {
    expect(withStoredSettings(undefined, file)).toEqual({
      enabledModelIds: [],
      toolEmulation: false,
      profileDir: '',
    })
  })
})

describe('settingsFilePath', () => {
  it('lives next to the credential cache under ~/.dsh', () => {
    expect(settingsFilePath()).toMatch(/[\\/]\.dsh[\\/]dsh-connect-doubao\.settings\.json$/)
  })
})
