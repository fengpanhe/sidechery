import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BgWindow, NormalizedSnapshot, Stored } from 'src/types'
import { DEFAULT_CONTAINER_ID } from 'src/defaults'
import * as Settings from 'src/services/settings'
import * as Snapshots from 'src/services/snapshots.bg'
import * as Windows from 'src/services/windows.bg'
import * as Store from 'src/services/storage.bg'
import * as SidebarConf from 'src/services/sidebar-config'

const browserFamily = vi.hoisted(() => ({ firefox: false }))
vi.mock('src/services/info', async importOriginal => ({
  ...(await importOriginal<typeof import('src/services/info')>()),
  get isFirefox() {
    return browserFamily.firefox
  },
  get isChromium() {
    return !browserFamily.firefox
  },
}))
vi.mock('src/services/tabs.bg', () => ({
  updateBgTabsTreeData: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('src/services/windows.bg', () => ({ byId: new Map() }))
vi.mock('src/services/storage.bg', () => ({ set: vi.fn().mockResolvedValue(undefined) }))

describe('background snapshots', () => {
  const originalSettings = { ...Settings.state }
  const createAlarm = vi.fn().mockResolvedValue(undefined)
  const getAlarm = vi.fn()
  const clearAlarm = vi.fn().mockResolvedValue(true)
  const addAlarmListener =
    vi.fn<(listener: (alarm: browser.alarms.Alarm) => Promise<void>) => void>()
  const download = vi.fn().mockResolvedValue(1)
  let stored: Stored

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
    browserFamily.firefox = false
    Object.assign(Settings.state, originalSettings, { snapInterval: 5, snapIntervalUnit: 'min' })
    stored = { lastSnapTime: Date.now() - 120_000, sidebar: snapshot().sidebar }
    getAlarm.mockResolvedValue(undefined)
    download.mockResolvedValue(1)
    // jsdom's Blob lacks text(), which is available in extension workers.
    vi.stubGlobal(
      'Blob',
      class extends Blob {
        constructor(
          private parts: string[],
          options?: BlobPropertyBag
        ) {
          super(parts, options)
        }
        async text(): Promise<string> {
          return this.parts.join('')
        }
      }
    )
    vi.stubGlobal('browser', {
      ...browser,
      alarms: {
        create: createAlarm,
        get: getAlarm,
        clear: clearAlarm,
        onAlarm: { addListener: addAlarmListener },
      },
      downloads: { download },
      storage: {
        ...browser.storage,
        local: { get: vi.fn(async () => structuredClone(stored)) },
      },
    })
  })

  afterEach(() => {
    Windows.byId.clear()
    Object.assign(Settings.state, originalSettings)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function snapshot(): NormalizedSnapshot {
    const panel = SidebarConf.createTabsPanelConfig({ id: 'tabs' })
    return {
      id: 'test',
      time: Date.now(),
      containers: {},
      sidebar: { nav: [panel.id], panels: { [panel.id]: panel } },
      tabs: [[[{ url: 'https://example.com/?q=中文#树', title: '中文 🌳', panelId: panel.id }]]],
    }
  }

  function addWindow() {
    Windows.byId.set(1, {
      id: 1,
      type: 'normal',
      incognito: false,
      tabs: [{ id: 1, ...snapshot().tabs[0][0][0], cookieStoreId: DEFAULT_CONTAINER_ID }],
    } as BgWindow)
  }

  test('uses a repeating Chrome alarm with the remaining interval', async () => {
    await Snapshots.scheduleSnapshots()
    expect(createAlarm).toHaveBeenCalledWith('auto-snapshot', {
      delayInMinutes: 3,
      periodInMinutes: 5,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([
    ['hr', 60],
    ['day', 1440],
  ] as const)('converts %s intervals to alarm minutes', async (unit, period) => {
    Settings.state.snapInterval = 1
    Settings.state.snapIntervalUnit = unit
    await Snapshots.scheduleSnapshots()
    expect(createAlarm).toHaveBeenCalledWith('auto-snapshot', {
      delayInMinutes: period - 2,
      periodInMinutes: period,
    })
  })

  test('waits at least a minute when the last snapshot is overdue', async () => {
    stored.lastSnapTime = Date.now() - 600_000
    await Snapshots.scheduleSnapshots()
    expect(createAlarm).toHaveBeenCalledWith('auto-snapshot', {
      delayInMinutes: 1,
      periodInMinutes: 5,
    })
  })

  test('preserves the existing deadline across worker restarts', async () => {
    getAlarm.mockResolvedValue({
      name: 'auto-snapshot',
      scheduledTime: Date.now() + 1000,
      periodInMinutes: 5,
    })
    await Snapshots.scheduleSnapshots(true)
    expect(createAlarm).not.toHaveBeenCalled()
    expect(clearAlarm).not.toHaveBeenCalled()
  })

  test('recreates an alarm missing after a browser restart', async () => {
    await Snapshots.scheduleSnapshots(true)
    expect(getAlarm).toHaveBeenCalledWith('auto-snapshot')
    expect(createAlarm).toHaveBeenCalledOnce()
  })

  test('replaces an alarm when the configured interval changes', async () => {
    getAlarm.mockResolvedValue({ periodInMinutes: 10 })
    await Snapshots.scheduleSnapshots(true)
    expect(createAlarm).toHaveBeenCalledWith('auto-snapshot', {
      delayInMinutes: 3,
      periodInMinutes: 5,
    })
  })

  test('clears the Chrome alarm when automatic snapshots are disabled', async () => {
    Settings.state.snapInterval = 0
    await Snapshots.scheduleSnapshots()
    expect(clearAlarm).toHaveBeenCalledWith('auto-snapshot')
    expect(createAlarm).not.toHaveBeenCalled()
  })

  test('registers synchronously and waits for initialization before taking a snapshot', async () => {
    const ready = Promise.withResolvers<void>()
    Snapshots.setupListeners(ready.promise)
    const listener = addAlarmListener.mock.calls[0][0]
    const handling = listener({ name: 'auto-snapshot', scheduledTime: Date.now() })
    await Promise.resolve()
    expect(Store.set).not.toHaveBeenCalled()

    addWindow()
    ready.resolve()
    await handling
    expect(Store.set).toHaveBeenCalledWith({
      snapshots: [expect.objectContaining({ tabs: snapshot().tabs })],
      lastSnapTime: Date.now(),
    })
  })

  test('ignores unrelated alarms and disabled automatic snapshots', async () => {
    addWindow()
    Snapshots.setupListeners(Promise.resolve())
    const listener = addAlarmListener.mock.calls[0][0]
    await listener({ name: 'other-feature', scheduledTime: Date.now() })
    Settings.state.snapInterval = 0
    await listener({ name: 'auto-snapshot', scheduledTime: Date.now() })
    expect(Store.set).not.toHaveBeenCalled()
  })

  test('keeps Firefox on its timer without registering an alarm', async () => {
    browserFamily.firefox = true
    Snapshots.setupListeners(Promise.resolve())
    await Snapshots.scheduleSnapshots()
    expect(addAlarmListener).not.toHaveBeenCalled()
    expect(createAlarm).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    addWindow()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(Store.set).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  test('exports JSON and Markdown on Chrome without blob URLs, preserving Unicode', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => {
          throw new Error('Unavailable in service workers')
        })
      }
    )
    Settings.state.snapAutoExportType = 'both'
    const snap = snapshot()
    await Snapshots.exportSnapshot(snap)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(2)
    const [json, md] = download.mock.calls.map(([options]) => options)
    expect(JSON.parse(decodeURIComponent(json.url.split(',')[1]))).toEqual(snap)
    expect(decodeURIComponent(md.url.split(',')[1])).toContain('中文 🌳')
    expect(json.filename).toMatch(/\.json$/)
    expect(md.filename).toMatch(/\.md$/)
    expect(json.saveAs).toBe(false)
  })

  test('saves the local snapshot even if automatic export fails', async () => {
    addWindow()
    Settings.state.snapAutoExport = true
    download.mockRejectedValue(new Error('Download denied'))
    const snap = await Snapshots.createSnapshot(true)
    expect(snap).toBeDefined()
    expect(Store.set).toHaveBeenCalledWith({ snapshots: [snap], lastSnapTime: Date.now() })
  })

  test('preserves Firefox blob URL downloads', async () => {
    browserFamily.firefox = true
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:snapshot')
      }
    )
    await Snapshots.exportSnapshot(snapshot())
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:snapshot' }))
  })
})
