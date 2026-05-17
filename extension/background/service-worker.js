console.log('[Web Scraper] Service worker started');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Web Scraper] Extension installed');
  chrome.storage.local.set({ fields: [], templates: [], scrapedData: [] });
});

// Track which tabs have the content script ready
const readyTabs = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'contentScriptReady') {
    if (sender.tab) {
      readyTabs.add(sender.tab.id);
      console.log('[Web Scraper] Content script ready on tab:', sender.tab.id, msg.url);
    }
    return true;
  }

  if (msg.action === 'isContentScriptReady') {
    sendResponse({ ready: readyTabs.has(msg.tabId) });
    return true;
  }

  // Relay live scroll progress → popup
  if (msg.action === 'scrapeProgress') {
    chrome.runtime.sendMessage({
      action: 'scrapeProgress',
      count: msg.count,
      data: msg.data
    }).catch(() => {});
    return true;
  }

  // Relay scrapeComplete from content script → popup
  if (msg.action === 'scrapeComplete') {
    chrome.runtime.sendMessage({
      action: 'scrapeComplete',
      count: msg.count,
      data: msg.data
    }).catch(() => {});
    return true;
  }

  // Relay selectionStopped → popup
  if (msg.action === 'selectionStopped') {
    chrome.runtime.sendMessage({ action: 'selectionStopped' }).catch(() => {});
    return true;
  }

  // Relay fieldSelected → popup
  if (msg.action === 'fieldSelected') {
    chrome.runtime.sendMessage({ action: 'fieldSelected', field: msg.field }).catch(() => {});
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') readyTabs.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  readyTabs.delete(tabId);
});
