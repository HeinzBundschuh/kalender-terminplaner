"use strict";
/* Terminplaner-Ansicht: Monatsraster im Stil klassischer Terminplaner,
 * Daten live aus Thunderbird. Blättern per Mausrad Monat für Monat;
 * Nachbarmonate werden vorab geladen und im Speicher gehalten. */

const api = globalThis.browser ? browser.terminplaner : null; // null = Vorschau ohne Thunderbird
const $ = (id) => document.getElementById(id);

const MONTHS = IS_DE
  ? ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]
  : [...Array(12)].map((_, i) => new Date(2000, i, 1).toLocaleString(LOCALE, { month: "long" }));
// Wochentage ab Montag (5.1.2026 war ein Montag)
const WDAYS = IS_DE
  ? ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
  : [...Array(7)].map((_, i) => new Date(2026, 0, 5 + i).toLocaleString(LOCALE, { weekday: "long" }));
const WSHORT = IS_DE
  ? ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
  : [...Array(7)].map((_, i) => new Date(2026, 0, 5 + i).toLocaleString(LOCALE, { weekday: "short" }).slice(0, 2));
const DAY = 86400000;

let state = { hideEnabled: true, compactEnabled: true, compactAllSeries: false, rules: [] };
let cur = firstOfMonth(new Date());   // angezeigter Monat
let miniCur = cur;                    // Monat im Mini-Kalender
let selected = startOfDay(new Date());
const cache = new Map();              // "JJJJ-MM" -> Array von Terminen
const pending = new Map();            // "JJJJ-MM" -> Promise
let generation = 0;                   // wird bei Datenänderung erhöht
let visibleEvents = new Map();        // Schlüssel -> Termin (für Menü/Doppelklick)

// ---------- Datum ----------
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function pad(n) { return String(n).padStart(2, "0"); }
function ymd(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
function monthKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function dayIndex(d) { return Math.round((startOfDay(d) - new Date(1970, 0, 1)) / DAY); } // lokal, DST-fest
function mondayBefore(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / DAY + 1) / 7);
}
function dayFromStr(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function fmtTime(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
const fmtDateIntl = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" });
function fmtDate(d) { return IS_DE ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` : fmtDateIntl.format(d); }

// ---------- DOM ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer = null;
function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 9000 : 5000);
}

function dialog(title, text, buttons) {
  return new Promise((resolve) => {
    $("dlgTitle").textContent = title;
    $("dlgText").textContent = text;
    const box = $("dlgButtons");
    box.textContent = "";
    const close = (v) => { $("dialog").hidden = true; resolve(v); };
    for (const b of buttons) box.append(h("button", { class: b.cls || "", onclick: () => close(b.value) }, b.label));
    box.append(h("button", { onclick: () => close(null) }, t("Abbrechen")));
    $("dialog").hidden = false;
    box.firstChild.focus();
  });
}

// ---------- Einstellungen der Seite (nur lokal) ----------
const prefs = { pastel: true, side: true, holidays: defaultRegion(), special: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem("planerPrefs") || "{}")); } catch (e) {}

// Vorgabe für die Feiertage: aus den Spracheinstellungen (de-AT, de-DE, en-GB, en-US), sonst AT/keine
function defaultRegion() {
  const langs = [...(navigator.languages || []), navigator.language || "", UI_LANG || ""].map((x) => x.toUpperCase());
  for (const l of langs) {
    if (/-AT$/.test(l)) return "AT";
    if (/-DE$/.test(l)) return "DE";
    if (/-CH$/.test(l)) return "CH";
    if (/-FR$/.test(l)) return "FR";
    if (/-IT$/.test(l)) return "IT";
    if (/-ES$/.test(l)) return "ES";
    if (/-GB$/.test(l)) return "GB";
    if (/-US$/.test(l)) return "US";
  }
  return IS_DE ? "AT" : "none";
}
// Feiertage/Sondertage eines Tages (leer, wenn „keine“ gewählt)
function marksFor(d) {
  return typeof HOLIDAYS === "undefined" ? [] : HOLIDAYS.dayMarks(prefs.holidays, d.getFullYear(), d.getMonth(), d.getDate(), prefs.special);
}
function markEl(mk) {
  return h("div", { class: mk.type === "hol" ? "hol" : "spec", title: mk.type === "hol" ? t("Feiertag") + ": " + mk.label : mk.label },
    h("span", { class: "mk-emoji" }, mk.emoji), mk.label);
}
function savePrefs() { try { localStorage.setItem("planerPrefs", JSON.stringify(prefs)); } catch (e) {} }

// ---------- Farben ----------
function parseColor(c) {
  if (!c) return null;
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return m[1].split("").map((x) => parseInt(x + x, 16));
  m = /^#([0-9a-f]{6})/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16));
  m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}
function colorsFor(ev) {
  let rgb = parseColor(ev.categoryColor) || parseColor(ev.color) || [160, 190, 225];
  if (prefs.pastel) rgb = rgb.map((v) => Math.round(v + (255 - v) * 0.55));
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return { bg: `rgb(${rgb.join(",")})`, fg: prefs.pastel || lum > 0.5 ? "#111" : "#fff" };
}

// ---------- Ausblenden/Kompakt-Regeln (gleiche wie in der Monatsansicht) ----------
function isHidden(ev) {
  return state.hideEnabled && state.rules.some((r) => r.mode === "hidden" && r.id === ev.id && (!r.rid || r.rid === ev.rid));
}
function hasCompactRule(ev) { return state.rules.some((r) => r.mode === "compact" && r.id === ev.id); }
function isCompact(ev) { return state.compactEnabled && (hasCompactRule(ev) || (state.compactAllSeries && !!ev.rid)); }

// ---------- Daten ----------
function evKey(ev) { return `${ev.calendarId}|${ev.id}|${ev.rid || ""}`; }

function prepare(ev) {
  // Anfangs- und (inklusive) Endtag, Sortierschlüssel
  if (!ev.start) return null;
  let s, e;
  if (ev.start.allDay) {
    s = dayFromStr(ev.start.day);
    e = ev.end && ev.end.allDay ? addDays(dayFromStr(ev.end.day), -1) : s;
  } else {
    s = startOfDay(new Date(ev.start.ms));
    if (ev.end) {
      const endMs = ev.end.ms;
      e = startOfDay(new Date(endMs));
      if (endMs === e.getTime() && endMs > ev.start.ms) e = addDays(e, -1); // Ende um 00:00
    } else e = s;
  }
  if (e < s) e = s;
  ev._s = dayIndex(s);
  ev._e = dayIndex(e);
  ev._multi = ev._e > ev._s;
  ev._sort = ev.start.allDay ? -1 : ev.start.ms;
  return ev;
}

function loadMonth(d) {
  const key = monthKey(d);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key);
  const gen = generation;
  const p = (api ? api.getRangeEvents(ymd(d), ymd(addMonths(d, 1))) : Promise.resolve(demoEvents(d)))
    .then((list) => {
      const out = list.map(prepare).filter(Boolean);
      if (gen === generation) cache.set(key, out);
      pending.delete(key);
      return out;
    })
    .catch((e) => {
      pending.delete(key);
      throw e;
    });
  pending.set(key, p);
  return p;
}

async function eventsForGrid(first) {
  const months = [addMonths(first, -1), first, addMonths(first, 1)];
  const lists = await Promise.all(months.map(loadMonth));
  const map = new Map();
  for (const l of lists) for (const ev of l) map.set(evKey(ev), ev); // mehrmonatige Termine nur einmal
  return [...map.values()];
}

function prefetch(first) {
  for (const n of [2, -2, 3, -3]) loadMonth(addMonths(first, n)).catch(() => {});
}

function invalidate() {
  generation++;
  cache.clear();
  pending.clear();
  render();
  renderWeekList();
}

// ---------- Monatsraster ----------
let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const first = cur;
  $("monthTitle").textContent = `${MONTHS[first.getMonth()]} ${first.getFullYear()}`;
  renderMini();

  let events;
  try {
    events = await eventsForGrid(first);
  } catch (e) {
    if (token === renderToken) toast(t("Termine konnten nicht geladen werden: {0}", e.message || e), true);
    events = [];
  }
  if (token !== renderToken) return; // inzwischen weitergeblättert
  drawGrid(first, events);
  prefetch(first);
}

// Zeilenhöhe eines Eintrags im Raster (px) und Höhe des Tageskopfs
const ROW = 19, HEAD = 30;

/* Monatsraster mit „Platz“-Verfahren: Jede Woche hat Zeilen (Slots). Mehrtägige Balken
 * bekommen die niedrigste Zeile, die an allen ihren Tagen frei ist; danach füllt jeder Tag
 * seine Sondertage und Termine in die jeweils freien Zeilen. So entstehen keine Leerplätze,
 * und was nicht mehr in die Zeilenhöhe passt, zeigt „↓ n“ an (kein Überlaufen in die
 * nächste Woche). Feiertage stehen im Tageskopf statt des Wochentags. */
function drawGrid(first, events) {
  const grid = $("grid");
  const start = mondayBefore(first);
  const today = startOfDay(new Date());
  const month = first.getMonth();
  visibleEvents = new Map();
  let countInMonth = 0;
  const monthFrom = dayIndex(first), monthTo = dayIndex(addMonths(first, 1)) - 1;

  const shown = events.filter((ev) => !isHidden(ev));
  for (const ev of shown) {
    visibleEvents.set(evKey(ev), ev);
    if (ev._e >= monthFrom && ev._s <= monthTo) countInMonth++;
  }

  // wie viele Eintragszeilen passen in eine Woche?
  const weekH = Math.max(60, (grid.clientHeight || 600) / 6);
  const fit = Math.max(1, Math.floor((weekH - HEAD - 3) / ROW));

  const frag = document.createDocumentFragment();
  for (let w = 0; w < 6; w++) {
    const wStart = addDays(start, w * 7);
    const w0 = dayIndex(wStart), w6 = w0 + 6;
    const days = [...Array(7)].map((_, i) => addDays(wStart, i));
    const occ = [...Array(7)].map(() => []);
    const isFree = (s, e, slot) => { for (let d = s; d <= e; d++) if (occ[d][slot]) return false; return true; };
    const place = (s, e) => {
      let slot = 0;
      while (!isFree(s, e, slot)) slot++;
      for (let d = s; d <= e; d++) occ[d][slot] = true;
      return slot;
    };
    const items = [];

    // 1) mehrtägige Termine als Balken
    const multis = shown
      .filter((ev) => ev._multi && ev._s <= w6 && ev._e >= w0)
      .sort((a, b) => a._s - b._s || (b._e - b._s) - (a._e - a._s) || a._sort - b._sort || a.title.localeCompare(b.title, LOCALE));
    for (const ev of multis) {
      const s = Math.max(ev._s, w0) - w0, e = Math.min(ev._e, w6) - w0;
      items.push({ kind: "bar", ev, s, e, slot: place(s, e) });
    }

    // 2) je Tag: Sondertage, dann eintägige Termine (ganztägig zuerst, dann nach Uhrzeit)
    const marksByDay = days.map((d) => marksFor(d));
    for (let i = 0; i < 7; i++) {
      for (const mk of marksByDay[i].filter((x) => x.type === "spec")) items.push({ kind: "mark", mk, s: i, e: i, slot: place(i, i) });
      const di = w0 + i;
      const dayEvents = shown
        .filter((ev) => !ev._multi && ev._s === di)
        .sort((a, b) => a._sort - b._sort || a.title.localeCompare(b.title, LOCALE));
      for (const ev of dayEvents) items.push({ kind: "ev", ev, s: i, e: i, slot: place(i, i) });
    }

    // ausgeblendete (nicht passende) Einträge je Tag zählen
    const hiddenPerDay = Array(7).fill(0);
    for (const it of items) if (it.slot >= fit) for (let d = it.s; d <= it.e; d++) hiddenPerDay[d]++;

    const wg = h("div", { class: "wgrid", style: `grid-template-rows: ${HEAD}px repeat(${fit}, ${ROW}px)` });
    for (let i = 0; i < 7; i++) {
      const d = days[i];
      const other = d.getMonth() !== month;
      const hols = marksByDay[i].filter((x) => x.type === "hol");
      const isHol = hols.length > 0;
      const we = i >= 5 || isHol;
      const cell = h("div", {
        class: "dcell" + (other ? " other" : "") + (sameDay(d, selected) ? " sel" : ""),
        style: `grid-column: ${i + 1}`, "data-day": ymd(d),
      });
      wg.append(cell);
      const holLabel = hols.map((x) => x.label).join(" · ");
      wg.append(h("div", {
        class: "dhdr" + (other ? " other" : we ? " we" : "") + (isHol ? " holiday" : "") + (sameDay(d, today) ? " today" : ""),
        style: `grid-column: ${i + 1}`, "data-day": ymd(d),
        title: isHol ? `${WDAYS[i]}, ${fmtDate(d)} – ${t("Feiertag")}: ${holLabel}` : `${WDAYS[i]}, ${fmtDate(d)}`,
      }, h("span", { class: "num" }, d.getDate()),
        hiddenPerDay[i] ? h("span", { class: "more", title: t("Alle Termine dieses Tages anzeigen") }, `↓ ${hiddenPerDay[i]}`) : null,
        h("span", { class: "hname" }, isHol ? holLabel : WDAYS[i])));
    }

    for (const it of items) {
      if (it.slot >= fit) continue;
      let el;
      if (it.kind === "mark") el = markEl(it.mk);
      else if (it.kind === "ev") el = evEl(it.ev, "ev");
      else {
        el = evEl(it.ev, "bar");
        if (it.ev._s < w0) el.classList.add("cont-l");
        if (it.ev._e > w6) el.classList.add("cont-r");
      }
      el.style.gridColumn = `${it.s + 1} / ${it.e + 2}`;
      el.style.gridRow = `${it.slot + 2}`;
      const allOther = days.slice(it.s, it.e + 1).every((d) => d.getMonth() !== month);
      if (allOther) el.classList.add("dim");
      wg.append(el);
    }

    frag.append(h("div", { class: "week" }, h("div", { class: "kwcol" }, isoWeek(wStart)), wg));
  }
  grid.textContent = "";
  grid.append(frag);
  $("countText").textContent = t("Termine: {0}", countInMonth);
}

function evEl(ev, cls, full = false) {
  const { bg, fg } = colorsFor(ev);
  const compact = !full && isCompact(ev);
  // 00:00 wie bei Geburtstagen nicht anzeigen – steht im Tooltip
  const timed = ev.start && !ev.start.allDay && fmtTime(ev.start.ms) !== "00:00";
  const el = h("div", {
    class: cls + (compact ? " compact" : ""),
    style: `background:${bg};color:${fg}`,
    "data-key": evKey(ev),
    title: tooltip(ev),
  });
  if (timed) el.append(h("span", { class: "tm" }, fmtTime(ev.start.ms)));
  el.append(ev.title || t("(ohne Titel)"));
  return el;
}

function tooltip(ev) {
  const lines = [ev.title || t("(ohne Titel)")];
  if (ev.start) {
    if (ev.start.allDay) {
      const s = dayFromStr(ev.start.day);
      const e = ev.end && ev.end.allDay ? addDays(dayFromStr(ev.end.day), -1) : s;
      lines.push((e > s ? `${fmtDate(s)} – ${fmtDate(e)}` : fmtDate(s)) + " " + t("(ganztägig)"));
    } else {
      const s = new Date(ev.start.ms);
      const e = ev.end ? new Date(ev.end.ms) : null;
      lines.push(`${fmtDate(s)} ${fmtTime(ev.start.ms)}` + (e ? ` – ${sameDay(s, e) ? "" : fmtDate(e) + " "}${fmtTime(ev.end.ms)}` : ""));
    }
  }
  if (ev.location) lines.push(t("Ort: {0}", ev.location));
  lines.push(t("Kalender: {0}", ev.calendarName) + (ev.recurring ? " · " + t("Serie") : ""));
  return lines.join("\n");
}


// ---------- Mini-Kalender ----------
let miniDays = new Set();
async function renderMini() {
  const first = miniCur;
  $("miniTitle").textContent = `${MONTHS[first.getMonth()]} ${first.getFullYear()}`;
  const t = $("miniGrid");
  t.textContent = "";
  t.append(h("tr", {}, h("th", {}, ""), WSHORT.map((w) => h("th", {}, w))));
  const start = mondayBefore(first);
  const today = startOfDay(new Date());
  const shownFrom = dayIndex(mondayBefore(cur)), shownTo = shownFrom + 41;
  for (let w = 0; w < 6; w++) {
    const row = h("tr", {}, h("td", { class: "kw" }, isoWeek(addDays(start, w * 7))));
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, w * 7 + i);
      const di = dayIndex(d);
      const cls = [
        d.getMonth() !== first.getMonth() ? "other" : "",
        sameDay(d, today) ? "today" : "",
        miniDays.has(di) ? "has" : "",
        marksFor(d).some((x) => x.type === "hol") ? "hol" : "",
        di >= shownFrom && di <= shownTo && d.getMonth() === cur.getMonth() ? "shown" : "",
      ].join(" ");
      row.append(h("td", { class: cls, onclick: () => goTo(d) }, d.getDate()));
    }
    t.append(row);
  }
  // fett = Tage mit Terminen
  try {
    const list = await loadMonth(first);
    if (first !== miniCur) return;
    const set = new Set();
    for (const ev of list) if (!isHidden(ev)) for (let k = ev._s; k <= ev._e; k++) set.add(k);
    const changed = set.size !== miniDays.size || [...set].some((x) => !miniDays.has(x));
    miniDays = set;
    if (changed) renderMini();
  } catch (e) {}
}

// ---------- Woche voraus (Seitenleiste) ----------
async function renderWeekList() {
  const box = $("weekList");
  const today = startOfDay(new Date());
  $("todayText").textContent = fmtDate(today);
  let list = [];
  try {
    list = api ? await api.getRangeEvents(ymd(today), ymd(addDays(today, 7))) : demoEvents(firstOfMonth(today));
  } catch (e) { return; }
  list = list.map(prepare).filter((ev) => ev && !isHidden(ev));
  box.textContent = "";
  let any = false;
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i), di = dayIndex(d);
    const evs = list.filter((ev) => ev._s <= di && ev._e >= di).sort((a, b) => a._sort - b._sort);
    const marks = marksFor(d);
    if (!evs.length && !marks.length) continue;
    any = true;
    box.append(h("div", { class: "wl-day", onclick: () => goTo(d) }, `${WSHORT[(d.getDay() + 6) % 7]}, ${fmtDate(d)}`));
    for (const mk of marks) {
      box.append(h("div", { class: "wl-ev wl-" + mk.type }, h("span", { class: "t" }, mk.emoji), h("span", { class: "n" }, mk.label)));
    }
    for (const ev of evs) {
      const tm = ev.start && !ev.start.allDay && ev._s === di ? fmtTime(ev.start.ms) : "";
      box.append(h("div", { class: "wl-ev", title: tooltip(ev) }, h("span", { class: "t" }, tm), h("span", { class: "n" }, ev.title)));
    }
  }
  if (!any) box.append(h("div", { class: "wl-empty" }, t("Keine Termine.")));
}

// ---------- Navigation ----------
function goMonth(n) {
  cur = addMonths(cur, n);
  miniCur = cur;
  const today = startOfDay(new Date());
  selected = today.getMonth() === cur.getMonth() && today.getFullYear() === cur.getFullYear() ? today : cur;
  hidePopups();
  render();
}
function goTo(d) {
  cur = firstOfMonth(d);
  miniCur = cur;
  selected = startOfDay(d);
  hidePopups();
  render();
}

// Mausrad: je Raste ein Monat (Touchpad: gesammelte Bewegung)
let wheelAcc = 0, wheelLock = 0;
function onWheel(e) {
  if (!$("dialog").hidden) return;
  e.preventDefault();
  const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  wheelAcc += delta;
  const now = performance.now();
  if (Math.abs(wheelAcc) >= 60 && now - wheelLock > 70) {
    goMonth(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
    wheelLock = now;
  }
}

// ---------- Kontextmenü ----------
function hidePopups() {
  $("ctxMenu").hidden = true;
  $("dayPop").hidden = true;
  document.querySelectorAll(".hl").forEach((x) => x.classList.remove("hl"));
}

function showMenu(x, y, head, items) {
  const m = $("ctxMenu");
  m.textContent = "";
  if (head) m.append(h("div", { class: "head" }, head));
  for (const it of items) {
    if (it === "-") { m.append(h("div", { class: "sep" })); continue; }
    m.append(h("div", {
      class: "mi" + (it.disabled ? " disabled" : ""),
      onclick: () => { if (it.disabled) return; hidePopups(); it.action(); },
    }, it.label));
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + "px";
  m.style.top = Math.min(y, innerHeight - r.height - 4) + "px";
}

function eventMenu(e, ev, el) {
  e.preventDefault();
  hidePopups();
  el.classList.add("hl");
  const series = ev.recurring && ev.rid;
  showMenu(e.clientX, e.clientY, ev.title, [
    { label: "✏️ " + t("Öffnen / Bearbeiten"), action: () => openEv(ev) },
    "-",
    { label: "🙈 " + (series ? t("Serie ausblenden") : t("Termin ausblenden")), action: () => addRule("hidden", ev, false) },
    series && { label: "🙈 " + t("Nur dieses Vorkommen ausblenden"), action: () => addRule("hidden", ev, true) },
    state.compactEnabled && state.compactAllSeries && ev.rid && !hasCompactRule(ev)
      ? { label: "↕ " + t("„Alle Serien kompakt“ ausschalten"), action: () => { state.compactAllSeries = false; saveState(); } }
      : { label: hasCompactRule(ev) ? "↕ " + t("Wieder normal anzeigen") : "▬ " + (series ? t("Serie kompakt anzeigen") : t("Termin kompakt anzeigen")), action: () => toggleCompact(ev) },
    "-",
    { label: "📤 " + (series ? t("Serie als ICS exportieren") : t("Als ICS exportieren")), action: () => exportEv(ev) },
    "-",
    { label: "🗑 " + (ev.readOnly ? t("Löschen (Kalender schreibgeschützt)") : t("Löschen …")), disabled: ev.readOnly, action: () => deleteEv(ev) },
  ].filter(Boolean));
}

function dayMenu(e, d) {
  e.preventDefault();
  hidePopups();
  selectDay(d);
  showMenu(e.clientX, e.clientY, `${WDAYS[(d.getDay() + 6) % 7]}, ${fmtDate(d)}`, [
    { label: "➕ " + t("Neuer Termin …"), action: () => newEv(d) },
    { label: "📋 " + t("Alle Termine dieses Tages"), action: () => showDay(d, e.clientX, e.clientY) },
  ]);
}

function selectDay(d) {
  selected = startOfDay(d);
  document.querySelectorAll(".dcell.sel").forEach((c) => c.classList.remove("sel"));
  const c = document.querySelector(`.dcell[data-day="${ymd(d)}"]`);
  if (c) c.classList.add("sel");
}

function showDay(d, x, y) {
  const di = dayIndex(d);
  const evs = [...visibleEvents.values()]
    .filter((ev) => ev._s <= di && ev._e >= di)
    .sort((a, b) => (a._multi === b._multi ? 0 : a._multi ? -1 : 1) || a._sort - b._sort);
  const p = $("dayPop");
  p.textContent = "";
  const marks = marksFor(d);
  const we = (d.getDay() + 6) % 7 >= 5 || marks.some((x) => x.type === "hol");
  p.append(h("div", { class: "dp-head" + (we ? " we" : "") }, `${WDAYS[(d.getDay() + 6) % 7]}, ${fmtDate(d)}`));
  const body = h("div", { class: "dp-body" });
  for (const mk of marks) body.append(markEl(mk));
  if (!evs.length && !marks.length) body.append(h("div", { class: "ev", style: "border:0" }, t("Keine Termine.")));
  for (const ev of evs) body.append(evEl(ev, "ev", true));
  p.append(body);
  p.hidden = false;
  const r = p.getBoundingClientRect();
  p.style.left = Math.max(4, Math.min(x - 20, innerWidth - r.width - 8)) + "px";
  p.style.top = Math.max(4, Math.min(y - 20, innerHeight - r.height - 8)) + "px";
}

// ---------- Liste der ausgeblendeten/kompakten Termine ----------
function updateHiddenBtn() {
  const n = state.rules.filter((r) => r.mode === "hidden").length;
  const c = state.rules.filter((r) => r.mode === "compact").length;
  const allSeries = state.compactEnabled && state.compactAllSeries;
  $("hiddenBtn").textContent = `🙈 ${t("{0} ausgeblendet", n)} · ▬ ${allSeries ? t("alle Serien kompakt") : t("{0} kompakt", c)}`;
  $("hiddenBtn").classList.toggle("warn", allSeries);
}
function toggleHiddenPop() {
  const p = $("hiddenPop");
  if (!p.hidden) { p.hidden = true; return; }
  renderHiddenPop();
  p.hidden = false;
}
function renderHiddenPop() {
  const p = $("hiddenPop");
  p.textContent = "";
  const sw = (key, label) => h("label", { class: "hp-sw" },
    h("input", { type: "checkbox", checked: !!state[key], onchange: (e) => { state[key] = e.target.checked; saveState(); } }), label);
  p.append(h("div", { class: "hp-head" }, t("Ausblenden & Kompakt")),
    sw("hideEnabled", t("Ausblenden aktiv")), sw("compactEnabled", t("Kompaktmodus aktiv")), sw("compactAllSeries", t("alle Serientermine kompakt")));
  for (const [mode, title, btn] of [["hidden", "🙈 " + t("Ausgeblendet"), t("👁 Einblenden")], ["compact", "▬ " + t("Kompakt"), t("Normal")]]) {
    const rules = state.rules.filter((r) => r.mode === mode).sort((a, b) => a.title.localeCompare(b.title, LOCALE));
    p.append(h("div", { class: "hp-sec" }, `${title} (${rules.length})`,
      rules.length ? h("button", { class: "hp-all", onclick: () => { state.rules = state.rules.filter((r) => r.mode !== mode); saveState(); } }, t("alle")) : null));
    if (!rules.length) p.append(h("div", { class: "hp-empty" }, t("keine")));
    for (const r of rules) {
      p.append(h("div", { class: "hp-row" },
        h("span", { class: "hp-t", title: r.title }, r.title || t("(ohne Titel)"), h("small", {}, r.rid ? " · " + t("ein Vorkommen") : r.recurring ? " · " + t("Serie") : "")),
        h("button", { onclick: () => { state.rules = state.rules.filter((x) => x.key !== r.key); saveState(); } }, btn)));
    }
  }
}

// ---------- Aktionen ----------
async function saveState() {
  if (api) state = await api.setState(state);
  refreshAfterState();
}
function refreshAfterState() {
  updateHiddenBtn();
  if (!$("hiddenPop").hidden) renderHiddenPop();
  render();
  renderWeekList();
}
function addRule(mode, ev, single) {
  const rid = single ? ev.rid : null;
  const key = `${mode}|${ev.id}|${rid || ""}`;
  if (!state.rules.some((r) => r.key === key)) {
    state.rules.push({ key, mode, id: ev.id, rid, title: ev.title, calendarName: ev.calendarName, recurring: ev.recurring, when: ev.when });
  }
  if (mode === "hidden") { state.hideEnabled = true; toast("🙈 " + t("„{0}“ ausgeblendet – wieder einblenden unten rechts über „🙈 … ausgeblendet“", ev.title)); }
  if (mode === "compact") state.compactEnabled = true;
  return saveState();
}
function toggleCompact(ev) {
  if (hasCompactRule(ev)) state.rules = state.rules.filter((r) => !(r.mode === "compact" && r.id === ev.id));
  else return addRule("compact", ev, false);
  return saveState();
}
async function openEv(ev) {
  if (!api) return;
  try { await api.openEvent(ev); } catch (e) { toast(t("Öffnen fehlgeschlagen: {0}", e.message || e), true); }
}
async function newEv(d) {
  if (!api) return;
  try { await api.newEvent(ymd(d)); } catch (e) { toast(t("Neuer Termin fehlgeschlagen: {0}", e.message || e), true); }
}
async function exportEv(ev) {
  if (!api) return;
  try {
    const path = await api.exportEvents([{ calendarId: ev.calendarId, id: ev.id }]);
    toast("📤 " + t(ev.recurring ? "„{0}“ exportiert (ganze Serie):" : "„{0}“ exportiert:", ev.title) + "\n" + path);
  } catch (e) { toast(t("Export fehlgeschlagen: {0}", e.message || e), true); }
}
async function deleteEv(ev) {
  if (!api) return;
  const series = ev.recurring && ev.rid;
  const when = tooltip(ev).split("\n")[1] || "";
  const scope = await dialog(t("„{0}“ löschen", ev.title),
    `${when} · ${ev.calendarName}\n` + t("Vorher wird ein ICS-Backup im Download-Ordner gespeichert."),
    series
      ? [{ label: t("Nur dieses Vorkommen"), value: "occurrence", cls: "danger" }, { label: t("Ganze Serie"), value: "series", cls: "danger" }]
      : [{ label: t("Löschen"), value: "series", cls: "danger" }]);
  if (!scope) return;
  try {
    const res = await api.deleteEvents([ev], scope);
    let text = res.deleted ? "🗑 " + t(scope === "occurrence" ? "„{0}“ gelöscht (nur dieses Vorkommen)." : "„{0}“ gelöscht.", ev.title) : t("Nichts gelöscht.");
    if (res.backupPath) text += "\n" + t("Backup: {0}", res.backupPath);
    if (res.errors.length) text += "\n" + res.errors.join("\n");
    toast(text, res.errors.length > 0);
    invalidate();
  } catch (e) { toast(t("Löschen fehlgeschlagen: {0}", e.message || e), true); }
}

// ---------- Ereignisse ----------
function evFromTarget(t) {
  const el = t.closest("[data-key]");
  return el ? { el, ev: visibleEvents.get(el.dataset.key) } : null;
}
function dayFromTarget(t) {
  const el = t.closest("[data-day]");
  if (!el) return null;
  const s = el.dataset.day;
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}
function dayFromPoint(x, y) {
  // Klick auf Balken/Kopf: Tag über die Spaltenposition bestimmen
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.classList && el.classList.contains("dcell")) return dayFromTarget(el);
  }
  return null;
}

function wire() {
  const grid = $("grid");
  grid.addEventListener("wheel", onWheel, { passive: false });
  $("side").addEventListener("wheel", (e) => {
    if (e.target.closest("#weekList")) return; // Liste darf normal scrollen
    onWheel(e);
  }, { passive: false });

  grid.addEventListener("click", (e) => {
    if (e.target.classList.contains("more")) {
      const d = dayFromTarget(e.target);
      if (d) { selectDay(d); showDay(d, e.clientX, e.clientY); }
      return;
    }
    hidePopups();
    const d = dayFromTarget(e.target) || dayFromPoint(e.clientX, e.clientY);
    if (d) selectDay(d);
    grid.focus();
  });
  grid.addEventListener("dblclick", (e) => {
    const hit = evFromTarget(e.target);
    if (hit && hit.ev) return openEv(hit.ev);
    const d = dayFromTarget(e.target) || dayFromPoint(e.clientX, e.clientY);
    if (d) newEv(d);
  });
  grid.addEventListener("contextmenu", (e) => {
    const hit = evFromTarget(e.target);
    if (hit && hit.ev) return eventMenu(e, hit.ev, hit.el);
    const d = dayFromTarget(e.target) || dayFromPoint(e.clientX, e.clientY);
    if (d) dayMenu(e, d);
  });

  $("dayPop").addEventListener("dblclick", (e) => { const hit = evFromTarget(e.target); if (hit && hit.ev) openEv(hit.ev); });
  $("dayPop").addEventListener("contextmenu", (e) => { const hit = evFromTarget(e.target); if (hit && hit.ev) eventMenu(e, hit.ev, hit.el); else e.preventDefault(); });

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#hiddenPop") && !e.target.closest("#hiddenBtn")) $("hiddenPop").hidden = true;
    if (!e.target.closest("#ctxMenu") && !e.target.closest("#dayPop") && e.button === 0) {
      $("ctxMenu").hidden = true;
      if (!e.target.closest(".more")) $("dayPop").hidden = true;
      document.querySelectorAll(".hl").forEach((x) => x.classList.remove("hl"));
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!$("dialog").hidden) {
      if (e.key === "Escape") $("dlgButtons").lastChild.click();
      return;
    }
    if (e.key === "Escape") return hidePopups();
    if (e.key === "PageDown" || (e.ctrlKey && e.key === "ArrowRight")) { e.preventDefault(); goMonth(1); }
    else if (e.key === "PageUp" || (e.ctrlKey && e.key === "ArrowLeft")) { e.preventDefault(); goMonth(-1); }
    else if (e.key === "Home") { e.preventDefault(); goTo(new Date()); }
    else if (e.key === "F5") { e.preventDefault(); invalidate(); }
  });

  $("prevBtn").addEventListener("click", () => goMonth(-1));
  $("nextBtn").addEventListener("click", () => goMonth(1));
  $("miniPrev").addEventListener("click", () => { miniCur = addMonths(miniCur, -1); miniDays = new Set(); renderMini(); });
  $("miniNext").addEventListener("click", () => { miniCur = addMonths(miniCur, 1); miniDays = new Set(); renderMini(); });
  $("todayBtn").addEventListener("click", () => goTo(new Date()));
  $("refreshBtn").addEventListener("click", invalidate);
  $("hiddenBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleHiddenPop(); });
  // Feiertage: Radiobuttons + Sondertage
  for (const r of document.querySelectorAll('input[name="holRegion"]')) {
    r.checked = r.value === prefs.holidays;
    r.addEventListener("change", () => {
      prefs.holidays = r.value; savePrefs();
      $("holSpecial").disabled = prefs.holidays === "none";
      render(); renderWeekList();
    });
  }
  $("holSpecial").checked = prefs.special;
  $("holSpecial").disabled = prefs.holidays === "none";
  $("holSpecial").addEventListener("change", (e) => { prefs.special = e.target.checked; savePrefs(); render(); renderWeekList(); });
  $("pastel").checked = prefs.pastel;
  $("pastel").addEventListener("change", (e) => { prefs.pastel = e.target.checked; savePrefs(); render(); });
  document.body.classList.toggle("no-side", !prefs.side);
  $("sideToggle").addEventListener("click", () => {
    prefs.side = !prefs.side; savePrefs();
    document.body.classList.toggle("no-side", !prefs.side);
    render();
  });

  let resizeT = null;
  addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(render, 120); });

  // Tageswechsel (z. B. über Nacht offen gelassen)
  let lastDay = ymd(new Date());
  setInterval(() => { const d = ymd(new Date()); if (d !== lastDay) { lastDay = d; render(); renderWeekList(); } }, 60000);

  if (api) {
    api.onItemsChanged.addListener(invalidate);
    api.onChanged.addListener(async () => { state = await api.getState(); refreshAfterState(); });
  }
}

// ---------- Vorschau ohne Thunderbird (Datei direkt im Browser geöffnet) ----------
function demoEvents(first) {
  const y = first.getFullYear(), m = first.getMonth();
  const out = [];
  const mk = (d, hh, mm, title, color, extra = {}) => {
    const s = new Date(y, m, d, hh ?? 0, mm ?? 0);
    const allDay = hh == null;
    const dayStr = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
    const endDay = addDays(s, extra.days || 1);
    out.push({
      id: `demo-${m}-${d}-${title}`, rid: extra.rid ? String(s.getTime()) : null, title, location: "", calendarId: "demo",
      calendarName: "Demo", color, categoryColor: "", readOnly: false, recurring: !!extra.rid, when: "",
      start: { ms: s.getTime(), allDay, day: dayStr },
      end: allDay ? { ms: endDay.getTime(), allDay: true, day: `${endDay.getFullYear()}-${pad(endDay.getMonth() + 1)}-${pad(endDay.getDate())}` } : { ms: s.getTime() + 3600000, allDay: false, day: dayStr },
    });
  };
  const days = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const wd = new Date(y, m, d).getDay();
    if (wd === 1 || wd === 3) mk(d, 7, 30, t("Frühsport"), "#9a9a9a", { rid: true });
    if (wd === 6) mk(d, null, null, t("Wochenmarkt"), "#fff3a0", { rid: true });
    if (wd === 5) mk(d, 19, 30, t("Chorprobe"), "#fff3a0", { rid: true });
    if (wd === 2) mk(d, 9, 0, t("Team-Besprechung"), "#a8c8f0", { rid: true });
    if (d % 14 === 1) { mk(d, null, null, t("Biomüll"), "#00f0ff"); mk(d, null, null, t("Restmüll"), "#00f0ff"); }
  }
  mk(8, null, null, t("Geburtstag Anna"), "#ff7a8c");
  mk(17, null, null, t("Stadtfest"), "#ff00ff");
  mk(24, 10, 30, t("Zahnarzt"), "#a8c8f0");
  mk(12, 14, 0, t("Elternabend"), "#c9a8f0");
  mk(26, null, null, t("Herbstferien"), "#40e060", { days: 5 });
  return out;
}

// ---------- Start ----------
(async function init() {
  translatePage();
  wire();
  $("todayText").textContent = fmtDate(new Date());
  if (api) {
    try { state = await api.getState(); } catch (e) {}
  }
  updateHiddenBtn();
  render();
  renderWeekList();
  $("grid").focus();
})();
