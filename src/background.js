// Schaltfläche „Terminplaner“ und Extras → „Terminplaner öffnen“:
// öffnet die Monatsansicht in einem eigenen Tab (bzw. holt ihn nach vorne).
const PLANER = browser.runtime.getURL("ui/planer.html");

async function openPlaner() {
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(PLANER));
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
  } else {
    await browser.tabs.create({ url: PLANER });
  }
}

browser.action.onClicked.addListener(openPlaner);

browser.runtime.onInstalled.addListener(() => {
  browser.menus.removeAll().then(() => {
    browser.menus.create({ id: "tp-open", title: browser.i18n.getMessage("menuOpen"), contexts: ["tools_menu"] });
  });
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === "tp-open") openPlaner();
});
