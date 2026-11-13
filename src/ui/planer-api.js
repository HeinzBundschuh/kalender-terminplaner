"use strict";
/* Datenzugriff des Terminplaners über den veröffentlichten Calendar-API-Entwurf
 * (https://github.com/thunderbird/webext-experiments, Ordner "calendar"; die
 * Dateien unter experiments/ sind unveränderte Kopien davon).
 *
 * Ersetzt die frühere eigene Experiment-API "terminplaner" mit derselben
 * Schnittstelle (getState, setState, getRangeEvents, exportEvents, deleteEvents,
 * openEvent, newEvent, onItemsChanged, onChanged), damit planer.js unverändert
 * bleiben kann. openEvent/newEvent öffnen ein eigenes Termin-Formular, weil
 * Thunderbirds Dialoge über den Entwurf nicht erreichbar sind.
 *
 * Data access through the published Calendar API draft (unmodified copies under
 * experiments/). Same interface as the former custom "terminplaner" API.
 */

const PlanerApi = (() => {
  const STATE_KEY = "state";
  const LAST_CAL_KEY = "lastCalendarId";
  const DEFAULT_STATE = { hideEnabled: true, compactEnabled: true, compactAllSeries: false, rules: [] };
  const LOCAL_TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
  })();

  // =====================================================================
  // iCalendar lesen / reading iCalendar
  // =====================================================================
  const pad = (n) => String(n).padStart(2, "0");

  function unfold(text) {
    return String(text || "").replace(/\r?\n[ \t]/g, "").replace(/\r?\n/g, "\r\n");
  }
  function unescapeText(v) {
    return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
  }
  function escapeText(v) {
    return String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  function components(text, name) {
    return text.match(new RegExp(`^BEGIN:${name}\\r?$[\\s\\S]*?^END:${name}(?=\\r?$)`, "gm")) || [];
  }
  // Eigene Zeilen eines VEVENT ohne verschachtelte Komponenten (z. B. VALARM)
  function ownLines(vevent) {
    const inner = vevent.replace(/^BEGIN:VEVENT\r?\n/, "").replace(/^END:VEVENT\r?$/m, "");
    return inner.replace(/^BEGIN:(\w[\w-]*)\r?$[\s\S]*?^END:\1\r?$/gm, "");
  }
  function prop(lines, name) {
    const m = lines.match(new RegExp(`^${name}((?:;[^:\\r\\n]*)?):([^\\r\\n]*)`, "m"));
    if (!m) return null;
    const params = {};
    for (const p of m[1].split(";").slice(1)) {
      const i = p.indexOf("=");
      if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, "");
    }
    return { params, value: m[2].trim() };
  }
  const textProp = (lines, name) => {
    const p = prop(lines, name);
    return p ? unescapeText(p.value) : "";
  };
  // Ersetzt genau einen Textblock, ohne $-Sonderzeichen im Ersatz zu deuten.
  function swap(text, from, to) {
    const i = text.indexOf(from);
    return i < 0 ? text : text.slice(0, i) + to + text.slice(i + from.length);
  }
  const isException = (vevent) => /^RECURRENCE-ID[;:]/m.test(ownLines(vevent));

  function cleanTzid(tzid) {
    return String(tzid || "").replace(/^\/mozilla\.org\/[^/]+\//, "").replace(/^\//, "");
  }
  const tzFormatters = new Map();
  function tzFormatter(tz) {
    if (!tzFormatters.has(tz)) {
      let fmt = null;
      try {
        fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tz, hourCycle: "h23",
          year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
      } catch (e) {
        fmt = null;
      }
      tzFormatters.set(tz, fmt);
    }
    return tzFormatters.get(tz);
  }
  function zonedToUtc(y, mo, d, h, mi, s, tz) {
    const fmt = tzFormatter(tz);
    if (!fmt) return null;
    const wall = Date.UTC(y, mo - 1, d, h, mi, s);
    const offsetAt = (ms) => {
      const p = {};
      for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
    };
    let ms = wall - offsetAt(wall);
    ms = wall - offsetAt(ms);
    return ms;
  }
  const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // DTSTART/DTEND/… -> { ms, allDay, day }
  function parseDate(p) {
    if (!p) return null;
    const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (!h) {
      return { ms: new Date(+y, +mo - 1, +d).getTime(), allDay: true, day: `${y}-${mo}-${d}` };
    }
    let ms = null;
    if (z) ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    else if (p.params.TZID) ms = zonedToUtc(+y, +mo, +d, +h, +mi, +s, cleanTzid(p.params.TZID));
    if (ms == null) ms = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
    return { ms, allDay: false, day: localDay(new Date(ms)) };
  }
  function parseDuration(value) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value || "");
    if (!m) return null;
    const [, sign, w, d, h, mi, s] = m;
    const ms = ((((+(w || 0) * 7 + +(d || 0)) * 24 + +(h || 0)) * 60 + +(mi || 0)) * 60 + +(s || 0)) * 1000;
    return sign === "-" ? -ms : ms;
  }
  function endOf(lines, start) {
    const end = parseDate(prop(lines, "DTEND"));
    if (end) return end;
    const dur = parseDuration(prop(lines, "DURATION")?.value);
    if (start.allDay) {
      const [y, mo, d] = start.day.split("-").map(Number);
      const e = new Date(y, mo - 1, d + (dur != null ? Math.round(dur / 86400000) : 1));
      return { ms: e.getTime(), allDay: true, day: localDay(e) };
    }
    const ms = start.ms + (dur ?? 0);
    return { ms, allDay: false, day: localDay(new Date(ms)) };
  }

  // `instance` der API ("2026-10-06T16:00:00Z" oder "2026-03-20") -> ms bzw. iCal-Wert
  function instanceInfo(instance) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z?)?$/.exec(instance || "");
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    if (!h) return { allDay: true, ms: new Date(+y, +mo - 1, +d).getTime(), ical: `;VALUE=DATE:${y}${mo}${d}` };
    return { allDay: false, ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), ical: `:${y}${mo}${d}T${h}${mi}${s}Z` };
  }

  // =====================================================================
  // iCalendar schreiben / writing iCalendar
  // =====================================================================
  function fold(line) {
    if (line.length <= 74) return line;
    const parts = [line.slice(0, 74)];
    for (let i = 74; i < line.length; i += 73) parts.push(" " + line.slice(i, i + 73));
    return parts.join("\r\n");
  }
  function utcStamp(d = new Date()) {
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  const ymdOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  function dateLine(name, date, allDay) {
    if (allDay) return `${name};VALUE=DATE:${ymdOf(date)}`;
    const local = `${ymdOf(date)}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
    return LOCAL_TZ && tzFormatter(LOCAL_TZ) ? `${name};TZID=${LOCAL_TZ}:${local}` : `${name}:${utcStamp(date)}`;
  }

  // Ersetzt Eigenschaften auf oberster Ebene eines VEVENT (VALARM bleibt unberührt).
  function setProps(vevent, removeNames, newLines) {
    const lines = vevent.split(/\r\n/);
    const out = [];
    let depth = 0;
    const rx = new RegExp(`^(${removeNames.join("|")})[;:]`, "i");
    for (const line of lines) {
      if (/^BEGIN:/i.test(line)) depth++;
      if (depth === 1 && removeNames.length && rx.test(line)) continue;
      if (/^END:/i.test(line)) depth--;
      out.push(line);
    }
    out.splice(1, 0, ...newLines.filter(Boolean).map(fold));
    return out.join("\r\n");
  }

  // Termine mit Zeitzonen, die der Browser nicht kennt (z. B. Windows-Namen aus
  // Exchange), werden nicht über die Erweiterung geändert: ohne passende
  // VTIMEZONE könnte Thunderbird die Uhrzeit sonst falsch übernehmen.
  function unknownTimezones(text) {
    const tzids = new Set();
    for (const m of text.matchAll(/;TZID=("?)([^;:"\r\n]+)\1/g)) tzids.add(cleanTzid(m[2]));
    return [...tzids].filter((tz) => !tzFormatter(tz));
  }

  // =====================================================================
  // Kalender, Termine
  // =====================================================================
  async function calendars() {
    const list = await browser.calendar.calendars.query({});
    return (list || []).map((c) => ({
      id: c.id, name: c.name, color: c.color || "", readOnly: !!c.readOnly, enabled: c.enabled !== false,
    }));
  }

  function toEvent(apiItem, calendar) {
    const text = unfold(apiItem.item);
    const vevents = components(text, "VEVENT");
    const v = apiItem.instance
      ? vevents.find(isException) || vevents[0]
      : vevents.find((x) => !isException(x)) || vevents[0];
    if (!v) return null;
    const lines = ownLines(v);
    const startProp = prop(lines, "DTSTART");
    const start = parseDate(startProp);
    if (!start) return null;
    return {
      categoryColor: "", // Kategoriefarben sind über den API-Entwurf nicht lesbar
      id: apiItem.id,
      rid: apiItem.instance || null,
      title: textProp(lines, "SUMMARY"),
      location: textProp(lines, "LOCATION"),
      description: textProp(lines, "DESCRIPTION"),
      calendarId: calendar.id,
      calendarName: calendar.name,
      color: calendar.color,
      readOnly: calendar.readOnly,
      recurring: !!apiItem.instance,
      when: startProp.value,
      start,
      end: endOf(lines, start),
    };
  }

  async function getMaster(calendarId, id) {
    let item = null;
    try {
      item = await browser.calendar.items.get(calendarId, id, { returnFormat: "ical" });
    } catch (e) {
      item = null;
    }
    return item ? unfold(item.item) : null;
  }
  const masterBlock = (text) => components(text, "VEVENT").find((v) => !isException(v)) || null;

  // =====================================================================
  // Dateien im Download-Ordner
  // =====================================================================
  function waitForDownload(id) {
    return new Promise((resolve, reject) => {
      const done = (ok) => {
        browser.downloads.onChanged.removeListener(listener);
        ok ? resolve() : reject(new Error(t("Datei konnte nicht gespeichert werden.")));
      };
      const listener = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === "complete") done(true);
        else if (delta.state.current === "interrupted") done(false);
      };
      browser.downloads.onChanged.addListener(listener);
      browser.downloads.search({ id }).then(([d]) => {
        if (d?.state === "complete") done(true);
        else if (d?.state === "interrupted") done(false);
      });
    });
  }
  async function saveToDownloads(baseName, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
    try {
      const id = await browser.downloads.download({ url, filename: `${baseName}.ics`, saveAs: false, conflictAction: "uniquify" });
      await waitForDownload(id);
      const [d] = await browser.downloads.search({ id });
      return d?.filename || `${baseName}.ics`;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }
  function mergeCalendars(texts) {
    const timezones = new Map();
    const events = [];
    for (const text of texts) {
      for (const tz of components(text, "VTIMEZONE")) {
        const id = prop(tz, "TZID")?.value || tz;
        if (!timezones.has(id)) timezones.set(id, tz.trim());
      }
      for (const ev of components(text, "VEVENT")) events.push(ev.trim());
    }
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Heinz Bundschuh//Kalender-Terminplaner//DE",
      ...timezones.values(), ...events, "END:VCALENDAR", ""].join("\r\n");
  }
  function stamp() {
    const n = new Date();
    return `${ymdOf(n)}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
  }
  function safeName(s) {
    return (s || "termin").replace(/[^\wäöüÄÖÜß-]+/g, "_").replace(/^_+|_+$/g, "").substring(0, 40) || "termin";
  }

  // =====================================================================
  // Zustand (Ausblenden-/Kompakt-Regeln)
  // =====================================================================
  function cleanState(s) {
    s = s || {};
    return {
      hideEnabled: s.hideEnabled !== undefined ? !!s.hideEnabled : DEFAULT_STATE.hideEnabled,
      compactEnabled: s.compactEnabled !== undefined ? !!s.compactEnabled : DEFAULT_STATE.compactEnabled,
      compactAllSeries: !!s.compactAllSeries,
      rules: Array.isArray(s.rules) ? s.rules : [],
    };
  }
  async function getState() {
    const stored = await browser.storage.local.get(STATE_KEY);
    return cleanState(stored[STATE_KEY]);
  }
  async function setState(state) {
    const clean = cleanState(state);
    await browser.storage.local.set({ [STATE_KEY]: clean });
    return clean;
  }

  // =====================================================================
  // Öffentliche Funktionen
  // =====================================================================
  // Kalender, die nicht (rechtzeitig) antworten, blockieren sonst die ganze Ansicht:
  // höchstens 10 s warten, dann 2 Minuten überspringen und im Planer melden.
  const CALENDAR_TIMEOUT_MS = 10000;
  const RETRY_AFTER_MS = 2 * 60 * 1000;
  const slowUntil = new Map();
  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function getRangeEvents(fromYmd, toYmd) {
    const result = [];
    const skipped = [];
    for (const calendar of (await calendars()).filter((c) => c.enabled)) {
      if ((slowUntil.get(calendar.id) || 0) > Date.now()) { skipped.push(calendar.name); continue; }
      let items;
      try {
        items = await withTimeout(browser.calendar.items.query({
          calendarId: calendar.id, type: "event", expand: true,
          rangeStart: fromYmd, rangeEnd: toYmd, returnFormat: "ical",
        }), CALENDAR_TIMEOUT_MS);
        slowUntil.delete(calendar.id);
      } catch (e) {
        console.error(`Kalender-Terminplaner: ${calendar.name} nicht lesbar`, e);
        if (e && e.message === "timeout") { slowUntil.set(calendar.id, Date.now() + RETRY_AFTER_MS); skipped.push(calendar.name); }
        continue;
      }
      for (const item of items || []) {
        try {
          const ev = toEvent(item, calendar);
          if (ev) result.push(ev);
        } catch (e) {
          console.error("Kalender-Terminplaner: Termin nicht lesbar", item?.id, e);
        }
      }
    }
    return { events: result, skipped };
  }

  async function exportEvents(refs) {
    const seen = new Set();
    const texts = [];
    let firstTitle = "";
    for (const ref of refs) {
      const key = ref.calendarId + "\u0000" + ref.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = await getMaster(ref.calendarId, ref.id);
      if (!text) continue;
      if (!firstTitle) firstTitle = textProp(ownLines(masterBlock(text) || ""), "SUMMARY");
      texts.push(text);
    }
    if (!texts.length) throw new Error(t("Termin nicht gefunden"));
    const name = texts.length === 1 ? safeName(firstTitle) : `termine-${stamp()}`;
    return saveToDownloads(name, mergeCalendars(texts));
  }

  async function deleteEvents(refs, scope) {
    const cals = await calendars();
    const errors = [];
    const jobs = [];
    for (const ref of refs) {
      const calendar = cals.find((c) => c.id === ref.calendarId);
      if (!calendar) { errors.push(t("Kalender nicht gefunden")); continue; }
      if (calendar.readOnly) { errors.push(t("„{0}“ ist schreibgeschützt", calendar.name)); continue; }
      const text = await getMaster(ref.calendarId, ref.id);
      const master = text && masterBlock(text);
      if (!master) { errors.push(t("„{0}“ nicht mehr vorhanden", ref.title || ref.id)); continue; }
      const title = textProp(ownLines(master), "SUMMARY");
      if (scope === "occurrence" && ref.rid) {
        const inst = instanceInfo(ref.rid);
        if (!inst || !/^(RRULE|RDATE)[;:]/m.test(ownLines(master))) {
          errors.push(t("Vorkommen von „{0}“ nicht gefunden", title));
          continue;
        }
        const unknown = unknownTimezones(text);
        if (unknown.length) {
          errors.push(t("„{0}“: unbekannte Zeitzone ({1}) – bitte im Thunderbird-Kalender löschen", title, unknown.join(", ")));
          continue;
        }
        jobs.push({ ref, text, master, title, inst });
      } else {
        jobs.push({ ref, text, master, title, inst: null });
      }
    }

    // Backup zuerst – schlägt es fehl, wird nichts gelöscht.
    let backupPath = "";
    if (jobs.length) {
      backupPath = await saveToDownloads(`kalender-terminplaner-backup-${stamp()}`, mergeCalendars(jobs.map((j) => j.text)));
    }

    let deleted = 0;
    const state = await getState();
    for (const job of jobs) {
      try {
        if (job.inst) {
          // Einzelnes Vorkommen: EXDATE ergänzen, eine evtl. vorhandene Ausnahme entfernen.
          let text = swap(job.text, job.master, setProps(job.master, [], [`EXDATE${job.inst.ical}`]));
          for (const ex of components(text, "VEVENT").filter(isException)) {
            const rid = parseDate(prop(ownLines(ex), "RECURRENCE-ID"));
            if (rid && rid.ms === job.inst.ms) text = text.includes(ex + "\r\n") ? swap(text, ex + "\r\n", "") : swap(text, ex, "");
          }
          await browser.calendar.items.update(job.ref.calendarId, job.ref.id, { format: "ical", item: text });
          state.rules = state.rules.filter((x) => !(x.id === job.ref.id && x.rid === job.ref.rid));
        } else {
          await browser.calendar.items.remove(job.ref.calendarId, job.ref.id);
          state.rules = state.rules.filter((x) => x.id !== job.ref.id);
        }
        deleted++;
      } catch (e) {
        errors.push(t("„{0}“: {1}", job.title, e.message || e));
      }
    }
    await setState(state);
    return { deleted, backupPath, errors };
  }

  // =====================================================================
  // Termin-Formular (statt Thunderbirds Dialog)
  // =====================================================================
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }
  const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function fromInputs(dateStr, timeStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0);
  }

  /* Zeigt das Formular. opts: { heading, values, calendars (für neu), readOnly, lockTimes, note }
     Liefert die eingegebenen Werte oder null bei Abbruch. */
  function showEditor(opts) {
    return new Promise((resolve) => {
      const v = opts.values;
      const f = {
        title: el("input", { type: "text", value: v.title || "" }),
        allDay: el("input", { type: "checkbox" }),
        startDate: el("input", { type: "date", value: dateInput(v.start) }),
        startTime: el("input", { type: "time", value: timeInput(v.start) }),
        endDate: el("input", { type: "date", value: dateInput(v.end) }),
        endTime: el("input", { type: "time", value: timeInput(v.end) }),
        location: el("input", { type: "text", value: v.location || "" }),
        description: el("textarea", { rows: "4" }),
        calendar: null,
      };
      f.allDay.checked = !!v.allDay;
      f.description.value = v.description || "";
      if (opts.calendars) {
        f.calendar = el("select", {}, opts.calendars.map((c) => el("option", { value: c.id }, c.name)));
        if (opts.calendarId) f.calendar.value = opts.calendarId;
      }
      const err = el("div", { class: "ed-error" });
      const syncTimes = () => {
        f.startTime.disabled = f.endTime.disabled = f.allDay.checked || !!opts.lockTimes || !!opts.readOnly;
      };
      f.allDay.addEventListener("change", syncTimes);
      const row = (label, ...inputs) => el("label", { class: "ed-row" }, el("span", {}, label), el("span", { class: "ed-fields" }, inputs));

      const backdrop = el("div", { class: "dialog-backdrop editor-backdrop" });
      const close = (value) => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const save = () => {
        const title = f.title.value.trim();
        const allDay = f.allDay.checked;
        const start = fromInputs(f.startDate.value, allDay ? "00:00" : f.startTime.value);
        let end = fromInputs(f.endDate.value, allDay ? "00:00" : f.endTime.value);
        if (!f.startDate.value || !f.endDate.value || isNaN(start) || isNaN(end)) {
          err.textContent = t("Bitte gültiges Datum eingeben.");
          return;
        }
        if (allDay ? end < start : end <= start) {
          err.textContent = t("Das Ende muss nach dem Beginn liegen.");
          return;
        }
        close({
          title, allDay, start, end,
          location: f.location.value.trim(),
          description: f.description.value.replace(/\s+$/, ""),
          calendarId: f.calendar ? f.calendar.value : null,
        });
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && !opts.readOnly) { e.preventDefault(); save(); }
      };

      const buttons = opts.readOnly
        ? [el("button", { onclick: () => close(null) }, t("Schließen"))]
        : [el("button", { class: "primary", onclick: save }, t("Speichern")), el("button", { onclick: () => close(null) }, t("Abbrechen"))];

      backdrop.append(
        el("div", { class: "dialog editor", role: "dialog", "aria-modal": "true" },
          el("h3", {}, opts.heading),
          opts.note ? el("p", { class: "ed-note" }, opts.note) : null,
          row(t("Titel"), f.title),
          f.calendar ? row(t("Kalender"), f.calendar) : null,
          row(t("Ganztägig"), f.allDay),
          row(t("Beginn"), f.startDate, f.startTime),
          row(t("Ende"), f.endDate, f.endTime),
          row(t("Ort"), f.location),
          row(t("Beschreibung"), f.description),
          err,
          el("div", { class: "dlg-buttons" }, buttons)
        )
      );
      for (const input of Object.values(f)) if (input && opts.readOnly) input.disabled = true;
      if (opts.lockTimes) f.allDay.disabled = f.startDate.disabled = f.endDate.disabled = true;
      syncTimes();
      document.body.append(backdrop);
      document.addEventListener("keydown", onKey, true);
      (opts.readOnly ? buttons[0] : f.title).focus();
    });
  }

  // Werte des Formulars -> iCal-Zeilen
  function valueLines(vals, withTimes) {
    const now = utcStamp();
    const lines = [
      `SUMMARY:${escapeText(vals.title)}`,
      vals.location ? `LOCATION:${escapeText(vals.location)}` : null,
      vals.description ? `DESCRIPTION:${escapeText(vals.description)}` : null,
      `DTSTAMP:${now}`,
      `LAST-MODIFIED:${now}`,
    ];
    if (withTimes) {
      // Ganztägig: Ende exklusiv (Tag nach dem letzten Tag)
      const end = vals.allDay ? new Date(vals.end.getFullYear(), vals.end.getMonth(), vals.end.getDate() + 1) : vals.end;
      lines.push(dateLine("DTSTART", vals.start, vals.allDay), dateLine("DTEND", end, vals.allDay));
    }
    return lines;
  }
  const TEXT_PROPS = ["SUMMARY", "LOCATION", "DESCRIPTION", "DTSTAMP", "LAST-MODIFIED"];
  const TIME_PROPS = ["DTSTART", "DTEND", "DURATION"];

  function valuesFromEvent(ev, fallbackTitle) {
    const start = new Date(ev.start.ms);
    let end = new Date(ev.end ? ev.end.ms : ev.start.ms);
    if (ev.start.allDay) {
      const [y, m, d] = ev.start.day.split("-").map(Number);
      const [ey, em, ed] = (ev.end?.day || ev.start.day).split("-").map(Number);
      end = new Date(ey, em - 1, ed - 1);
      if (end < new Date(y, m - 1, d)) end = new Date(y, m - 1, d);
      return { title: ev.title ?? fallbackTitle, location: ev.location, description: ev.description, allDay: true, start: new Date(y, m - 1, d), end };
    }
    return { title: ev.title ?? fallbackTitle, location: ev.location, description: ev.description, allDay: false, start, end };
  }

  async function openEvent(ev) {
    const cals = await calendars();
    const calendar = cals.find((c) => c.id === ev.calendarId);
    if (!calendar) throw new Error(t("Kalender nicht gefunden"));
    const text = await getMaster(ev.calendarId, ev.id);
    const master = text && masterBlock(text);
    if (!master) throw new Error(t("Termin nicht mehr vorhanden"));
    const masterLines = ownLines(master);

    // Beschreibung ist in den Listendaten nicht immer vollständig: frisch lesen.
    const current = { ...ev };
    if (!ev.rid) current.description = textProp(masterLines, "DESCRIPTION");

    const readOnly = calendar.readOnly;
    let scope = "single";
    if (ev.rid && !readOnly) {
      scope = await globalThis.dialog(
        t("„{0}“ bearbeiten", ev.title || t("(ohne Titel)")),
        t("Das ist ein Serientermin. Was soll bearbeitet werden?"),
        [{ label: t("Nur diesen Termin"), value: "occurrence" }, { label: t("Ganze Serie"), value: "series" }]
      );
      if (!scope) return;
    }
    const unknown = unknownTimezones(text);
    const vals = await showEditor({
      heading: readOnly ? t("Termin (schreibgeschützt)") : scope === "series" ? t("Serie bearbeiten") : t("Termin bearbeiten"),
      values: scope === "series"
        ? { ...valuesFromEvent(current), description: textProp(masterLines, "DESCRIPTION") }
        : valuesFromEvent(current),
      readOnly: readOnly || unknown.length > 0,
      lockTimes: scope === "series",
      note: readOnly
        ? t("Kalender „{0}“ ist schreibgeschützt.", calendar.name)
        : unknown.length
          ? t("Unbekannte Zeitzone ({0}) – bitte im Thunderbird-Kalender bearbeiten.", unknown.join(", "))
          : scope === "series"
            ? t("Titel, Ort und Beschreibung gelten für alle Termine der Serie. Datum und Uhrzeit einer Serie bitte im Thunderbird-Kalender ändern.")
            : null,
    });
    if (!vals) return;

    let newText;
    if (scope === "occurrence") {
      const inst = instanceInfo(ev.rid);
      if (!inst) throw new Error(t("Vorkommen von „{0}“ nicht gefunden", ev.title));
      const existing = components(text, "VEVENT").filter(isException).find((ex) => {
        const rid = parseDate(prop(ownLines(ex), "RECURRENCE-ID"));
        return rid && rid.ms === inst.ms;
      });
      if (existing) {
        newText = swap(text, existing, setProps(existing, [...TEXT_PROPS, ...TIME_PROPS], valueLines(vals, true)));
      } else {
        // Neue Ausnahme: Kopie des Serien-Eintrags ohne Wiederholungsregeln
        const base = setProps(master, ["RRULE", "RDATE", "EXDATE", "EXRULE", ...TEXT_PROPS, ...TIME_PROPS],
          [`RECURRENCE-ID${inst.ical}`, ...valueLines(vals, true)]);
        const endAt = text.lastIndexOf("END:VCALENDAR");
        newText = text.slice(0, endAt) + base + "\r\n" + text.slice(endAt);
      }
    } else {
      newText = swap(text, master, setProps(master, scope === "series" ? TEXT_PROPS : [...TEXT_PROPS, ...TIME_PROPS],
        valueLines(vals, scope !== "series")));
    }
    await browser.calendar.items.update(ev.calendarId, ev.id, { format: "ical", item: newText });
  }

  async function newEvent(dayYmd) {
    const writable = (await calendars()).filter((c) => c.enabled && !c.readOnly);
    if (!writable.length) throw new Error(t("Kein beschreibbarer Kalender vorhanden."));
    const stored = await browser.storage.local.get(LAST_CAL_KEY);
    const y = +dayYmd.slice(0, 4), m = +dayYmd.slice(4, 6), d = +dayYmd.slice(6, 8);
    const vals = await showEditor({
      heading: t("Neuer Termin"),
      values: { title: "", allDay: false, start: new Date(y, m - 1, d, 9, 0), end: new Date(y, m - 1, d, 10, 0) },
      calendars: writable,
      calendarId: writable.some((c) => c.id === stored[LAST_CAL_KEY]) ? stored[LAST_CAL_KEY] : writable[0].id,
    });
    if (!vals) return;
    await browser.storage.local.set({ [LAST_CAL_KEY]: vals.calendarId });
    const uid = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const ical = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Heinz Bundschuh//Kalender-Terminplaner//DE",
      "BEGIN:VEVENT", `UID:${uid}`, `CREATED:${utcStamp()}`,
      ...valueLines(vals, true).filter(Boolean).map(fold),
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    await browser.calendar.items.create(vals.calendarId, { type: "event", format: "ical", item: ical });
  }

  // =====================================================================
  // Ereignisse
  // =====================================================================
  const onItemsChanged = {
    addListener(fn) {
      let timer = null;
      const notify = () => {
        clearTimeout(timer);
        timer = setTimeout(fn, 400); // Serien/Sync lösen viele Meldungen auf einmal aus
      };
      for (const name of ["onCreated", "onUpdated", "onRemoved"]) {
        try {
          browser.calendar.items[name].addListener(notify);
        } catch (e) {
          console.error(`Kalender-Terminplaner: ${name} nicht verfügbar`, e);
        }
      }
    },
  };
  const onChanged = {
    addListener(fn) {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[STATE_KEY]) fn();
      });
    },
  };

  return {
    getState, setState, getRangeEvents, exportEvents, deleteEvents, openEvent, newEvent,
    onItemsChanged, onChanged,
    _internal: { toEvent, setProps, instanceInfo, parseDate, unfold, components, ownLines, prop, masterBlock },
  };
})();
