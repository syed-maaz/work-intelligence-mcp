// Background service worker for Work Intelligence extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('✅ Work Intelligence Extension installed');

  // Set default settings
  chrome.storage.local.set({
    enabled: true,
    collectionCount: 0,
    lastSync: Date.now()
  });
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateStats') {
    chrome.storage.local.get(['collectionCount'], (result) => {
      const newCount = (result.collectionCount || 0) + (request.count || 0);
      chrome.storage.local.set({
        collectionCount: newCount,
        lastSync: Date.now()
      });
    });
  }

  sendResponse({ status: 'ok' });
  return true;
});

// Keep service worker alive
setInterval(() => {
  console.log('Service worker heartbeat');
}, 20000);
