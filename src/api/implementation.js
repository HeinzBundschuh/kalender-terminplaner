/* Experiment-API „terminplaner“ (Add-on Kalender-Terminplaner / Calendar Month Planner)
 * Liefert Termine für die Monatsansicht im Stil klassischer Terminplaner,
 * öffnet Thunderbirds Termin-Dialoge, exportiert und löscht (mit Backup).
 * Die Ausblenden-/Kompakt-Regeln liegen in derselben Einstellung wie beim
 * Add-on „Kalender-Ansicht“ (extensions.kalender-ansicht.state) – beide
 * Add-ons teilen sie und reagieren gegenseitig auf Änderungen.
 */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { cal } = ChromeUtils.importESModule(
  "resource:///modules/calendar/calUtils.sys.mjs"
);
var { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const PREF = "extensions.kalender-ansicht.state";

// ---------------- Kalenderdaten: Liste, Export, Löschen ----------------
function pad(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function dt(d) {
  if (!d) return null;
  return {
    ms: Math.round(d.nativeTime / 1000),
    allDay: !!d.isDate,
    day: `${d.year}-${pad(d.month + 1)}-${pad(d.day)}`,
  };
}

// Vorkommen (Serien aufgelöst) im Bereich [from, to) als Array
async function occurrencesIn(calendar, fromYmd, toYmd) {
  const filter =
    Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
  const start = cal.createDateTime(fromYmd);
  const end = cal.createDateTime(toYmd);
  if (typeof calendar.getItemsAsArray === "function") {
    return calendar.getItemsAsArray(filter, 0, start, end);
  }
  const out = [];
  const reader = calendar.getItems(filter, 0, start, end).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  return out;
}

// Farbe der ersten Kategorie mit hinterlegter Farbe (wie Thunderbird selbst)
function categoryColor(occ) {
  try {
    for (const c of occ.getCategories()) {
      const col = Services.prefs.getStringPref(
        "calendar.category.color." + cal.view.formatStringForCSSRule(c),
        ""
      );
      if (col) return col;
    }
  } catch (e) {}
  return "";
}

function occToJson(occ) {
  const calendar = occ.calendar;
  const parent = occ.parentItem || occ;
  return {
    categoryColor: categoryColor(occ),
    id: occ.id,
    rid: occ.recurrenceId ? String(occ.recurrenceId.nativeTime) : null,
    title: occ.title || "",
    location: occ.getProperty("LOCATION") || "",
    calendarId: calendar.id,
    calendarName: calendar.name,
    color: calendar.getProperty("color") || "",
    readOnly: !!calendar.readOnly,
    recurring: !!parent.recurrenceInfo,
    when: occ.startDate ? occ.startDate.icalString : "",
    start: dt(occ.startDate),
    end: dt(occ.endDate),
  };
}

// Vorkommen anhand von UID + recurrence-id wiederfinden (Suche rund um den Tag)
async function findOccurrence(calendar, ref) {
  if (!ref.rid) {
    return null;
  }
  const base = ref.start ? new Date(ref.start.ms) : new Date();
  const from = new Date(base);
  from.setDate(from.getDate() - 2);
  const to = new Date(base);
  to.setDate(to.getDate() + 3);
  const occs = await occurrencesIn(calendar, ymd(from), ymd(to));
  return (
    occs.find(
      (o) => o.id === ref.id && o.recurrenceId && String(o.recurrenceId.nativeTime) === ref.rid
    ) || null
  );
}

function serialize(items) {
  const ser = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(Ci.calIIcsSerializer);
  ser.addItems(items);
  return ser.serializeToString();
}

function safeName(s) {
  return (s || "termin").replace(/[^\wäöüÄÖÜß-]+/g, "_").replace(/^_+|_+$/g, "").substring(0, 40) || "termin";
}

async function writeToDownloads(baseName, text) {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

// ---------------- Sprache (Deutsch / Englisch) ----------------
const TR_EN = {
  "Kalender nicht gefunden": "Calendar not found",
  "Kalender nicht gefunden ({0})": "Calendar not found ({0})",
  "„{0}“ ist schreibgeschützt": "“{0}” is read-only",
  "„{0}“ nicht mehr vorhanden": "“{0}” no longer exists",
  "Termin nicht gefunden": "Event not found",
  "Termin nicht mehr vorhanden": "Event no longer exists",
  "Termin nicht mehr vorhanden ({0})": "Event no longer exists ({0})",
  "Hauptfenster nicht gefunden": "Main window not found",
  "Vorkommen von „{0}“ nicht gefunden": "Occurrence of “{0}” not found",
  "„{0}“: {1}": "“{0}”: {1}",
  "„{0}“ in „{1}“: {2}": "“{0}” in “{1}”: {2}",
  "Als ICS exportieren": "Export as ICS",
  "Serie ausblenden": "Hide series",
  "Termin ausblenden": "Hide event",
  "Nur dieses Vorkommen ausblenden": "Hide this occurrence only",
  "Wieder normal anzeigen": "Show normally again",
  "Serie kompakt anzeigen": "Show series compactly",
  "Termin kompakt anzeigen": "Show event compactly",
  "Kalender-Ansicht": "Calendar Hide & Compact",
  "Termin exportiert:": "Event exported:",
  "Export fehlgeschlagen:": "Export failed:",
};
function tr(de, ...args) {
  let s = de;
  try {
    if (!/^de\b/i.test(Services.locale.appLocaleAsBCP47)) s = TR_EN[de] ?? de;
  } catch (e) {}
  return s.replace(/\{(\d+)\}/g, (_, i) => String(args[+i] ?? ""));
}

  const dir = await Downloads.getPreferredDownloadsDirectory();
  let path = PathUtils.join(dir, `${baseName}.ics`);
  for (let i = 2; await IOUtils.exists(path); i++) {
    path = PathUtils.join(dir, `${baseName}-${i}.ics`);
  }
  await IOUtils.writeUTF8(path, text);
  return path;
}

function stamp() {
  const n = new Date();
  return `${ymd(n)}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
}

// Master-Einträge (ganze Serien) zu den Referenzen holen, doppelte zusammenfassen
async function mastersFor(refs) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const key = ref.calendarId + "\u0000" + ref.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const calendar = cal.manager.getCalendarById(ref.calendarId);
    const item = calendar ? await calendar.getItem(ref.id) : null;
    if (item) out.push({ calendar, item });
  }
  return out;
}

async function exportRefs(refs) {
  const masters = await mastersFor(refs);
  if (!masters.length) {
    throw new Error(tr("Termin nicht gefunden"));
  }
  const name = masters.length === 1 ? safeName(masters[0].item.title) : `termine-${stamp()}`;
  return writeToDownloads(name, serialize(masters.map((m) => m.item)));
}

const DEFAULT_STATE = {
  hideEnabled: true,       // Ausblenden aktiv
  compactEnabled: true,    // Kompaktmodus aktiv
  compactAllSeries: false, // alle Serientermine kompakt
  rules: [],               // [{key, mode:"hidden"|"compact", id, rid, title, calendarName, recurring, when}]
};

// ---------------- Zustand ----------------
function loadState() {
  try {
    const s = JSON.parse(Services.prefs.getStringPref(PREF, "{}"));
    return { ...DEFAULT_STATE, ...s, rules: Array.isArray(s.rules) ? s.rules : [] };
  } catch (e) {
    return { ...DEFAULT_STATE, rules: [] };
  }
}
function saveState(state) {
  Services.prefs.setStringPref(PREF, JSON.stringify(state));
}

var terminplaner = class extends ExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.changeListeners = new Set();
    this.itemListeners = new Set();
    this.started = false;

    // Kalenderänderungen (neu/geändert/gelöscht/neu geladen) gebündelt melden
    let timer = null;
    const notify = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const fire of this.itemListeners) fire.async();
      }, 400);
    };
    this.calObserver = {
      QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
      onStartBatch() {},
      onEndBatch: notify,
      onLoad: notify,
      onAddItem: notify,
      onModifyItem: notify,
      onDeleteItem: notify,
      onError() {},
      onPropertyChanged: notify,
      onPropertyDeleting() {},
    };
    // Regeln geändert (hier oder im Add-on Kalender-Ansicht)
    this.prefObserver = {
      observe: () => {
        for (const fire of this.changeListeners) fire.async();
      },
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    try {
      cal.manager.addCalendarObserver(this.calObserver);
    } catch (e) {
      console.error("Kalender-Terminplaner: Kalender-Beobachter nicht registriert", e);
    }
    Services.prefs.addObserver(PREF, this.prefObserver);
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown || !this.started) return;
    try {
      cal.manager.removeCalendarObserver(this.calObserver);
    } catch (e) {}
    Services.prefs.removeObserver(PREF, this.prefObserver);
    this.started = false;
  }

  getAPI(context) {
    const self = this;
    self.start();
    return {
      terminplaner: {
        async getState() {
          return loadState();
        },
        async setState(state) {
          const clean = {
            hideEnabled: !!state.hideEnabled,
            compactEnabled: !!state.compactEnabled,
            compactAllSeries: !!state.compactAllSeries,
            rules: Array.isArray(state.rules) ? state.rules : [],
          };
          saveState(clean); // Beobachter der Einstellung meldet die Änderung
          return clean;
        },

        async exportEvents(refs) {
          return exportRefs(refs);
        },

        async getRangeEvents(fromYmd, toYmd) {
          // Bereich [from, to) im Format JJJJMMTT, alle aktiven Kalender
          const result = [];
          for (const calendar of cal.manager.getCalendars()) {
            if (calendar.getProperty("disabled")) continue;
            try {
              const occs = await occurrencesIn(calendar, fromYmd, toYmd);
              for (const occ of occs) result.push(occToJson(occ));
            } catch (e) {
              console.error(`Kalender-Terminplaner: ${calendar.name} nicht lesbar`, e);
            }
          }
          return result;
        },

        async openEvent(ref) {
          const win = Services.wm.getMostRecentWindow("mail:3pane");
          const calendar = cal.manager.getCalendarById(ref.calendarId);
          if (!win || !calendar) throw new Error(tr("Kalender nicht gefunden"));
          let item = null;
          if (ref.rid) item = await findOccurrence(calendar, ref);
          if (!item) item = await calendar.getItem(ref.id);
          if (!item) throw new Error(tr("Termin nicht mehr vorhanden"));
          // Bei Serien fragt Thunderbird selbst: dieses Vorkommen oder ganze Serie
          win.modifyEventWithDialog(item, true);
        },

        async newEvent(dayYmd) {
          const win = Services.wm.getMostRecentWindow("mail:3pane");
          if (!win) throw new Error(tr("Hauptfenster nicht gefunden"));
          const start = cal.createDateTime(`${dayYmd}T090000`);
          start.timezone = cal.dtz.defaultTimezone;
          win.createEventWithDialog(null, start, null);
        },

        onItemsChanged: new ExtensionCommon.EventManager({
          context,
          name: "terminplaner.onItemsChanged",
          register(fire) {
            self.itemListeners.add(fire);
            return () => self.itemListeners.delete(fire);
          },
        }).api(),

        async deleteEvents(refs, scope) {
          // scope: "series" = ganze Serie/Termin, "occurrence" = nur dieses Vorkommen
          const errors = [];
          const jobs = [];
          const backup = [];
          for (const ref of refs) {
            const calendar = cal.manager.getCalendarById(ref.calendarId);
            if (!calendar) {
              errors.push(tr("Kalender nicht gefunden"));
              continue;
            }
            if (calendar.readOnly) {
              errors.push(tr("„{0}“ ist schreibgeschützt", calendar.name));
              continue;
            }
            const master = await calendar.getItem(ref.id);
            if (!master) {
              errors.push(tr("„{0}“ nicht mehr vorhanden", ref.title || ref.id));
              continue;
            }
            if (scope === "occurrence" && ref.rid && master.recurrenceInfo) {
              const occ = await findOccurrence(calendar, ref);
              if (!occ) {
                errors.push(tr("Vorkommen von „{0}“ nicht gefunden", master.title));
                continue;
              }
              jobs.push({ calendar, master, rid: occ.recurrenceId });
            } else {
              jobs.push({ calendar, master, rid: null });
            }
            backup.push(master);
          }

          // Backup zuerst – ohne Backup wird nichts gelöscht
          let backupPath = "";
          if (backup.length) {
            backupPath = await writeToDownloads(
              `kalender-terminplaner-backup-${stamp()}`,
              serialize(backup)
            );
          }

          let deleted = 0;
          const state = loadState();
          for (const job of jobs) {
            try {
              if (job.rid) {
                const changedItem = job.master.clone();
                changedItem.recurrenceInfo.removeOccurrenceAt(job.rid);
                await job.calendar.modifyItem(changedItem, job.master);
                const r = String(job.rid.nativeTime);
                state.rules = state.rules.filter((x) => !(x.id === job.master.id && x.rid === r));
              } else {
                await job.calendar.deleteItem(job.master);
                state.rules = state.rules.filter((x) => x.id !== job.master.id);
              }
              deleted++;
            } catch (e) {
              errors.push(tr("„{0}“: {1}", job.master.title, e.message || e));
            }
          }
          saveState(state); // Regeln zu gelöschten Terminen aufräumen
          return { deleted, backupPath, errors };
        },
        onChanged: new ExtensionCommon.EventManager({
          context,
          name: "terminplaner.onChanged",
          register(fire) {
            self.changeListeners.add(fire);
            return () => self.changeListeners.delete(fire);
          },
        }).api(),
      },
    };
  }
};
