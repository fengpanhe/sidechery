import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NOID } from 'src/defaults'
import { addMPanel, resetMSidebar } from 'src/defaults/mocks.sidebar.fg'
import { addMTTab, resetMTabs, setDefaultMTabPanel } from 'src/defaults/mocks.tabs.fg'
import * as Tabs from 'src/services/tabs.fg'
import { TESTING } from 'src/services/tabs.fg.handlers'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Settings from 'src/services/settings'
import * as Windows from 'src/services/windows.fg'
import * as Links from 'src/services/links'
import type { NativeTab } from 'src/types'

describe('Chromium tab duplication', () => {
  let nativeTabs: NativeTab[]
  let nextId: number
  const duplicate = vi.fn()

  function getNativeTab(id: ID): NativeTab {
    const tab = nativeTabs.find(t => t.id === id)
    if (!tab) throw new Error(`Missing native tab ${id}`)
    return tab
  }

  function syncNativeTabs() {
    nativeTabs = Tabs.list.map(t => ({
      id: t.id,
      index: t.index,
      windowId: 1,
      active: t.active,
      pinned: t.pinned,
      highlighted: t.active,
      incognito: false,
      cookieStoreId: t.cookieStoreId,
      hidden: t.hidden,
      isInReaderMode: t.isInReaderMode,
      lastAccessed: t.lastAccessed,
      discarded: t.discarded,
      url: `https://example.com/${t.id}`,
      title: `Tab ${t.id}`,
      status: 'complete',
    }))
    Sidebar.recalcTabsPanels()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Tabs, 'ready', 'get').mockReturnValue(true)
    vi.spyOn(Tabs, 'saveTabData').mockImplementation(() => {})
    vi.spyOn(Tabs, 'cacheTabsData').mockImplementation(() => {})
    vi.spyOn(Tabs, 'updateSuccessionDebounced').mockImplementation(() => {})
    Settings.state.tabsTree = true
    Settings.state.colorizeTabs = false
    Settings.state.colorizeTabsBranches = false
    Settings.state.autoScrollToNewTab = false
    Settings.state.hideInact = false
    Windows.setCurrentId(1)
    addMPanel({ id: 'a' })
    setDefaultMTabPanel('a')
    nextId = 100

    Object.assign(browser.tabs, {
      get: vi.fn(async (id: ID) => ({ ...getNativeTab(id) })),
      query: vi.fn(async () => nativeTabs.filter(t => t.active)),
      update: vi.fn(async (id: ID, props: browser.tabs.UpdateProperties) => {
        if (props.active) nativeTabs.forEach(t => (t.active = t.id === id))
        return Object.assign(getNativeTab(id), props)
      }),
      move: vi.fn(async (ids: ID | ID[], props: browser.tabs.MoveProps) => {
        const moving = (Array.isArray(ids) ? ids : [ids]).map(getNativeTab)
        nativeTabs = nativeTabs.filter(t => !moving.includes(t))
        nativeTabs.splice(props.index, 0, ...moving)
        nativeTabs.forEach((t, i) => (t.index = i))
        return moving[0]
      }),
      duplicate,
    })
    duplicate.mockImplementation(async (...args: [ID]) => {
      // Chrome rejects Firefox's second options argument.
      if (args.length !== 1) throw new Error('No matching signature')
      const source = getNativeTab(args[0])
      nativeTabs.forEach(t => (t.active = false))
      const tab = { ...source, id: nextId++, index: source.index + 1, active: true }
      nativeTabs.splice(tab.index, 0, tab)
      nativeTabs.forEach((t, i) => (t.index = i))
      await TESTING.onTabCreated({ ...tab })
      return { ...tab }
    })
  })

  afterEach(async () => {
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    vi.restoreAllMocks()
    duplicate.mockReset()
    for (const index of Object.keys(Tabs.newTabsPosition)) delete Tabs.newTabsPosition[+index]
    Tabs.clearDeferredEventHandling()
    resetMTabs()
    resetMSidebar()
    Links.rmAllTabs()
    Settings.resetSettings()
  })

  test('copies a parent after its entire branch without adopting its existing children', async () => {
    addMTTab({ id: 1, active: true })
    addMTTab(0, { id: 2 })
    addMTTab({ id: 3 })
    syncNativeTabs()

    await Tabs.duplicateTabs([1])

    expect(Tabs.list.map(t => t.id)).toEqual([1, 2, 100, 3])
    expect(Tabs.byId[2]?.parentId).toBe(1)
    expect(Tabs.byId[100]?.parentId).toBe(NOID)
    expect(nativeTabs.find(t => t.active)?.id).toBe(100)
    expect(Tabs.newTabsPosition).toEqual({})
    await vi.runAllTimersAsync()
    expect(nativeTabs.map(t => t.id)).toEqual([1, 2, 100, 3])
  })

  test('copies a selected tree with new parent IDs and keeps the original active tab', async () => {
    addMTTab({ id: 1, active: true })
    addMTTab(0, { id: 2 })
    addMTTab(0, 0, { id: 3 })
    addMTTab({ id: 4 })
    syncNativeTabs()

    await Tabs.duplicateTabs([3, 1, 2])

    expect(Tabs.list.map(t => t.id)).toEqual([1, 2, 3, 100, 101, 102, 4])
    expect(Tabs.byId[100]?.parentId).toBe(NOID)
    expect(Tabs.byId[101]?.parentId).toBe(100)
    expect(Tabs.byId[102]?.parentId).toBe(101)
    expect(nativeTabs.find(t => t.active)?.id).toBe(1)
    expect(Tabs.newTabsPosition).toEqual({})
    await vi.runAllTimersAsync()
    expect(nativeTabs.map(t => t.id)).toEqual([1, 2, 3, 100, 101, 102, 4])
  })

  test('can duplicate as a child at the end of the existing branch', async () => {
    addMTTab({ id: 1, active: true })
    addMTTab(0, { id: 2 })
    addMTTab({ id: 3 })
    syncNativeTabs()

    await Tabs.duplicateTabs([1], true)

    expect(Tabs.list.map(t => t.id)).toEqual([1, 2, 100, 3])
    expect(Tabs.byId[100]?.parentId).toBe(1)
  })

  test('keeps a pinned duplicate in the pinned section', async () => {
    addMTTab({ id: 1, pinned: true, active: true })
    addMTTab({ id: 2 })
    syncNativeTabs()

    await Tabs.duplicateTabs([1])

    expect(Tabs.list.map(t => t.id)).toEqual([1, 100, 2])
    expect(Tabs.byId[100]?.pinned).toBe(true)
    expect(Tabs.pinned.map(t => t.id)).toEqual([1, 100])
  })

  test('clears pending placement when native duplication fails', async () => {
    addMTTab({ id: 1, active: true })
    syncNativeTabs()
    duplicate.mockRejectedValueOnce(new Error('Cannot duplicate tab'))

    await expect(Tabs.duplicateTabs([1])).rejects.toThrow('Cannot duplicate tab')

    expect(Tabs.list.map(t => t.id)).toEqual([1])
    expect(Tabs.newTabsPosition).toEqual({})
  })

  test('keeps placement data until a deferred creation event is handled', async () => {
    addMTTab({ id: 1, active: true })
    syncNativeTabs()
    vi.spyOn(Tabs, 'ready', 'get').mockReturnValue(false)

    await Tabs.duplicateTabs([1])

    expect(Tabs.byId[100]).toBeUndefined()
    vi.spyOn(Tabs, 'ready', 'get').mockReturnValue(true)
    for (const handle of Tabs.deferredEventHandling) handle()
    expect(Tabs.byId[100]?.parentId).toBe(NOID)
    expect(Tabs.newTabsPosition).toEqual({})
  })
})
