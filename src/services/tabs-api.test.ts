import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as TabsApi from 'src/services/tabs-api'

const browserFamily = vi.hoisted(() => ({ firefox: false }))
vi.mock('src/services/info', () => ({
  get isFirefox() {
    return browserFamily.firefox
  },
  get isChromium() {
    return !browserFamily.firefox
  },
}))

describe('TabsApi.duplicate()', () => {
  const duplicate = vi.fn()
  const get = vi.fn()
  const query = vi.fn()
  const update = vi.fn()

  beforeEach(() => {
    browserFamily.firefox = false
    Object.assign(browser.tabs, { duplicate, get, query, update })
    duplicate.mockResolvedValue({ id: 3, active: true, index: 2 })
    get.mockResolvedValue({ id: 1, windowId: 7 })
    query.mockResolvedValue([{ id: 2 }])
    update.mockResolvedValue({ id: 2, active: true })
  })

  afterEach(() => vi.resetAllMocks())

  test('passes only the tab ID on Chromium', async () => {
    const tab = await TabsApi.duplicate(1, { active: true, index: 5 })

    expect(duplicate).toHaveBeenCalledExactlyOnceWith(1)
    expect(tab.id).toBe(3)
    expect(tab.active).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })

  test('restores the active tab in the source window for background duplication', async () => {
    const tab = await TabsApi.duplicate(1, { active: false, index: 5 })

    expect(duplicate).toHaveBeenCalledExactlyOnceWith(1)
    expect(query).toHaveBeenCalledExactlyOnceWith({ windowId: 7, active: true })
    expect(update).toHaveBeenCalledExactlyOnceWith(2, { active: true })
    expect(tab.active).toBe(false)
  })

  test('preserves Firefox duplication options', async () => {
    browserFamily.firefox = true
    const options = { active: false, index: 5 }

    await TabsApi.duplicate(1, options)

    expect(duplicate).toHaveBeenCalledExactlyOnceWith(1, options)
    expect(get).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('TabsApi.discard()', () => {
  const discard = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    browserFamily.firefox = false
    discard.mockClear()
    ;(browser.tabs as any).discard = discard
  })

  test('discards Chromium tabs individually', async () => {
    await TabsApi.discard([1, 2])

    expect(discard).toHaveBeenCalledTimes(2)
    expect(discard).toHaveBeenNthCalledWith(1, 1)
    expect(discard).toHaveBeenNthCalledWith(2, 2)
  })
})
