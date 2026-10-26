import * as Info from 'src/services/info'

export function create(
  createProperties: browser.tabs.CreateProperties = {}
): Promise<browser.tabs.Tab> {
  if (Info.isFirefox) {
    return browser.tabs.create(createProperties)
  }

  const supportedProperties = { ...createProperties }
  delete supportedProperties.cookieStoreId
  delete supportedProperties.discarded
  delete supportedProperties.openInReaderMode
  delete supportedProperties.title
  return browser.tabs.create(supportedProperties)
}

export function update(
  tabId: ID,
  updateProperties: browser.tabs.UpdateProperties
): Promise<browser.tabs.Tab> {
  if (Info.isChromium && updateProperties.openerTabId === tabId) {
    updateProperties = { ...updateProperties }
    delete updateProperties.openerTabId
  }
  return browser.tabs.update(tabId, updateProperties)
}

export async function duplicate(
  tabId: ID,
  options: browser.tabs.DuplOpts = {}
): Promise<browser.tabs.Tab> {
  if (Info.isFirefox) return browser.tabs.duplicate(tabId, options)

  let activeTab: browser.tabs.Tab | undefined
  if (options.active === false) {
    const source = await browser.tabs.get(tabId)
    ;[activeTab] = await browser.tabs.query({ windowId: source.windowId, active: true })
  }

  // Chromium accepts only the ID and always activates the duplicate. The sidebar's
  // predefined new-tab position handles index changes through its normal move queue.
  const tab = await browser.tabs.duplicate(tabId)
  if (activeTab && tab.active) {
    await browser.tabs.update(activeTab.id, { active: true })
    return { ...tab, active: false, highlighted: false }
  }
  return tab
}

export function moveInSuccession(tabIds: ID[], tabId?: ID): Promise<void> {
  if (typeof browser.tabs.moveInSuccession !== 'function') return Promise.resolve()
  return browser.tabs.moveInSuccession(tabIds, tabId)
}

export function warmup(tabId: ID): Promise<void> {
  if (typeof browser.tabs.warmup !== 'function') return Promise.resolve()
  return browser.tabs.warmup(tabId)
}

export function capture(
  tab: browser.tabs.Tab,
  imageDetails: browser.ImageDetails
): Promise<string> {
  if (Info.isFirefox) return browser.tabs.captureTab(tab.id, imageDetails)
  if (!tab.active) return Promise.resolve('')

  const supportedDetails = { ...imageDetails }
  delete supportedDetails.scale
  return browser.tabs.captureVisibleTab(tab.windowId, supportedDetails)
}

export async function discard(tabIds: ID | ID[]): Promise<void> {
  if (Info.isFirefox) {
    await browser.tabs.discard(tabIds)
    return
  }

  const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
  await Promise.all(ids.map(tabId => browser.tabs.discard(tabId)))
}
