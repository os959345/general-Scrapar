// Chrome storage helpers (M5+)
const Storage = {
  get: (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve)),
  set: (data) => new Promise((resolve) => chrome.storage.local.set(data, resolve)),
  remove: (keys) => new Promise((resolve) => chrome.storage.local.remove(keys, resolve)),
};
