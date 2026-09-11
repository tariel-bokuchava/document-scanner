// Opens the scanner in a full tab. Popups close on focus loss and camera
// permission prompts are awkward there, so a dedicated tab is used instead.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('scanner.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
