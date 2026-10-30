// browser.context(request): what the user has open and where they usually go, read in one call
// before guessing. The active tab, the other open tabs, the sites visited in the last two days,
// the sites used most (site memory, from history), and history and bookmark pages matching the
// request's words. Evaluated in the code sandbox with the other APIs; no tab is attached.
export const browserContextApi = `
var __contextStop = new Set(['the','and','for','with','from','open','show','find','what','my','me','to','a','an','of','in','on','go','get','please','that','this','last','most']);
function __contextSafe(work) {
  return Promise.resolve(work).catch((error) => ({error: String(error && error.message || error)}));
}
function __contextHost(url) {
  try { return new URL(url).hostname.replace(/^www[.]/, ''); } catch { return ''; }
}
function __contextPage(item) {
  return {title: item.title, url: item.url, lastVisit: item.lastVisit, visits: item.visits};
}
// The whole request first; when nothing matches, each word on its own, most visited first.
async function __contextHistory(text, days) {
  var whole = await browser.history.search(text, {days, max: 15});
  if (whole.length) return whole.map(__contextPage);
  var words = text.toLowerCase().split(/[^a-z0-9.-]+/).filter((word) => word.length > 2 && !__contextStop.has(word));
  var seen = new Map();
  for (var word of words.slice(0, 5))
    for (var item of await browser.history.search(word, {days, max: 15}))
      if (!seen.has(item.url)) seen.set(item.url, item);
  return [...seen.values()].sort((a, b) => (b.visits || 0) - (a.visits || 0)).slice(0, 15).map(__contextPage);
}
async function __contextBookmarks(text) {
  var found = await browser.bookmarks.search(text, {max: 10});
  return found.filter((item) => item.url).map((item) => ({title: item.title, url: item.url}));
}
function __contextRecent(items) {
  var hosts = [];
  for (var item of Array.isArray(items) ? items : []) {
    var host = __contextHost(item.url);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts.slice(0, 15);
}
function __contextTabs(tabs) {
  if (!Array.isArray(tabs)) return {openTabs: tabs};
  var active = tabs.find((tab) => tab.active && (__focusedWindowId === undefined || tab.windowId === __focusedWindowId)) || tabs.find((tab) => tab.active);
  return {
    activeTab: active ? {id: active.id, title: active.title, url: active.url} : null,
    openTabs: tabs.slice(0, 40).map((tab) => ({id: tab.id, title: tab.title, url: tab.url})),
    ...(tabs.length > 40 ? {moreTabs: tabs.length - 40} : {}),
  };
}
async function __context(request, options) {
  var text = String(request || '').trim();
  var days = options.days || 365;
  var [tabs, recent, top, history, bookmarks] = await Promise.all([
    __contextSafe(browser.tabs()),
    __contextSafe(browser.history.search('', {days: 2, max: 300})),
    __contextSafe(browser.history.top({by: 'site', days: options.siteDays || 90, max: options.sites || 20})),
    text ? __contextSafe(__contextHistory(text, days)) : [],
    text ? __contextSafe(__contextBookmarks(text)) : [],
  ]);
  return {
    ...__contextTabs(tabs),
    recentSites: Array.isArray(recent) ? __contextRecent(recent) : recent,
    topSites: top && top.groups ? top.groups.map((group) => ({site: group.key, visits: group.visits, lastVisit: group.lastVisit, top: group.top && group.top.url})) : top,
    ...(text ? {matches: {history, bookmarks}} : {}),
  };
}
`;
