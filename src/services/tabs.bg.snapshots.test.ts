import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BgTab, BgWindow } from 'src/types'
import { NOID } from 'src/defaults'
import * as Tabs from 'src/services/tabs.bg'
import * as Windows from 'src/services/windows.bg'
import * as IPC from 'src/services/ipc'
import * as SessionValues from 'src/services/session-values'

const browserFamily = vi.hoisted(() => ({ firefox: false }))
vi.mock('src/services/info', async importOriginal => ({
  ...(await importOriginal<typeof import('src/services/info')>()),
  get isChromium() {
    return !browserFamily.firefox
  },
}))
vi.mock('src/services/windows.bg', () => ({ byId: new Map() }))
vi.mock('src/services/session-values', () => ({ getTabValue: vi.fn() }))
vi.mock('src/services/ipc', () => ({ getConnection: vi.fn(), sidebar: vi.fn() }))

describe('snapshot tree data after a background worker restart', () => {
  let root: BgTab
  let child: BgTab

  beforeEach(() => {
    browserFamily.firefox = false
    root = { id: 1, url: 'https://example.com/', folded: true } as BgTab
    child = { id: 2, url: 'https://example.com/child' } as BgTab
    Tabs.byId[root.id] = root
    Tabs.byId[child.id] = child
    Windows.byId.set(1, { id: 1, tabs: [root, child] } as BgWindow)
    vi.mocked(IPC.getConnection).mockReturnValue(undefined)
    vi.mocked(SessionValues.getTabValue).mockImplementation(async id => ({
      id,
      panelId: 'tabs',
      parentId: id === 1 ? NOID : 1,
      folded: id === 1,
      customTitle: id === 2 ? 'Child title' : undefined,
      customColor: id === 2 ? 'red' : undefined,
    }))
  })

  afterEach(() => {
    Windows.byId.clear()
    delete Tabs.byId[1]
    delete Tabs.byId[2]
    vi.resetAllMocks()
  })

  test('restores panels, nesting, folding and custom metadata without an open sidebar', async () => {
    await Tabs.updateBgTabsTreeData()
    expect(SessionValues.getTabValue).toHaveBeenCalledWith(1, 'data')
    expect(SessionValues.getTabValue).toHaveBeenCalledWith(2, 'data')
    expect(root).toMatchObject({ panelId: 'tabs', parentId: NOID, lvl: 0, folded: true })
    expect(child).toMatchObject({
      panelId: 'tabs',
      parentId: 1,
      lvl: 1,
      folded: false,
      customTitle: 'Child title',
      customColor: 'red',
    })
  })

  test('uses the connected sidebar instead of older session data', async () => {
    vi.mocked(IPC.getConnection).mockReturnValue({} as IPC.ConnectionInfo)
    vi.mocked(IPC.sidebar).mockResolvedValue([
      { id: 1, pid: 'new-panel' },
      { id: 2, pid: 'new-panel' },
    ])
    await Tabs.updateBgTabsTreeData()
    expect(SessionValues.getTabValue).not.toHaveBeenCalled()
    expect(root).toMatchObject({ panelId: 'new-panel', parentId: NOID, folded: false })
    expect(child).toMatchObject({ panelId: 'new-panel', parentId: NOID, lvl: 0 })
  })

  test('tolerates missing or unavailable saved tab data', async () => {
    vi.mocked(SessionValues.getTabValue).mockResolvedValueOnce(undefined)
    vi.mocked(SessionValues.getTabValue).mockRejectedValueOnce(new Error('Tab removed'))
    await expect(Tabs.updateBgTabsTreeData()).resolves.toBeUndefined()
    expect(root.panelId).toBe(NOID)
    expect(child.parentId).toBe(NOID)
  })

  test('keeps Firefox tree handling unchanged', async () => {
    browserFamily.firefox = true
    await Tabs.updateBgTabsTreeData()
    expect(SessionValues.getTabValue).not.toHaveBeenCalled()
    expect(root.panelId).toBe(NOID)
    expect(child.parentId).toBe(NOID)
  })
})
