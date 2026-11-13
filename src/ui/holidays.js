"use strict";
/* Feiertage und Sondertage 1900–2100 – Österreich, Deutschland, Großbritannien (England & Wales), USA.
 * Holidays and special days 1900–2100 – Austria, Germany, United Kingdom (England & Wales), USA.
 *
 * Österreich: Feiertage und Sondertage wie im Endless Calendar Pro (getHolidays/getSpecial),
 * ergänzt um Jahresgrenzen (Nationalfeiertag ab 1965, Sommerzeit ab 1980).
 * Ergebnis: dayMarks(region, y, m, d, withSpecial) -> [{ label, emoji, type: "hol" | "spec" }]
 */
const HOLIDAYS = (() => {
  const cache = new Map();

  // Osterdatum (gregorianisch, Algorithmus wie im Endless Calendar)
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
      f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
      h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
      l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, mo - 1, da);
  }
  const add = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const key = (date) => `${date.getMonth() + 1}-${date.getDate()}`;
  // n-ter Wochentag wd (0 = So) im Monat m (0-basiert); n = -1: letzter
  function nth(y, m, wd, n) {
    if (n > 0) {
      const first = new Date(y, m, 1);
      return new Date(y, m, 1 + ((wd - first.getDay() + 7) % 7) + (n - 1) * 7);
    }
    const last = new Date(y, m + 1, 0);
    return new Date(y, m, last.getDate() - ((last.getDay() - wd + 7) % 7));
  }
  function advent(y, n) { // n = 1..4
    const d24 = new Date(y, 11, 24);
    const a4 = new Date(y, 11, 24 - d24.getDay()); // 4. Advent = Sonntag am/vor 24.12.
    return add(a4, -(4 - n) * 7);
  }

  function builder(y) {
    const map = new Map();
    const put = (date, label, emoji, type) => {
      if (!date || date.getFullYear() !== y) return;
      const k = key(date);
      if (!map.has(k)) map.set(k, []);
      const list = map.get(k);
      if (!list.some((x) => x.label === label)) list.push({ label, emoji, type });
    };
    return {
      map,
      hol: (date, label, emoji = "🏛️") => put(date, label, emoji, "hol"),
      spec: (date, label, emoji = "•") => put(date, label, emoji, "spec"),
    };
  }

  // ---------------- Österreich (Quelle: Endless Calendar Pro) ----------------
  function AT(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    b.hol(D(1, 1), "Neujahr");
    b.hol(D(1, 6), "Hl. Drei Könige");
    b.hol(D(5, 1), "Tag der Arbeit");
    b.hol(D(8, 15), "Mariä Himmelfahrt");
    if (y >= 1965) b.hol(D(10, 26), "Nationalfeiertag");
    b.hol(D(11, 1), "Allerheiligen");
    b.hol(D(12, 8), "Mariä Empfängnis");
    b.hol(D(12, 25), "Christtag");
    b.hol(D(12, 26), "Stefanitag");
    b.hol(add(e, 1), "Ostermontag");
    b.hol(add(e, 39), "Christi Himmelfahrt");
    b.hol(add(e, 50), "Pfingstmontag");
    b.hol(add(e, 60), "Fronleichnam");
    // Sondertage
    b.spec(add(e, -52), "Opernball", "🎭");
    b.spec(add(e, -48), "Rosenmontag", "🌹");
    b.spec(add(e, -47), "Faschingsdienstag", "🎉");
    b.spec(add(e, -46), "Aschermittwoch", "✝");
    b.spec(add(e, -3), "Gründonnerstag", "🍞");
    b.spec(add(e, -2), "Karfreitag", "✝");
    b.spec(add(e, -1), "Karsamstag", "🕯️");
    b.spec(e, "Ostersonntag", "🐣");
    b.spec(add(e, 49), "Pfingstsonntag", "🕊️");
    b.spec(nth(y, 4, 0, 2), "Muttertag", "💐");
    b.spec(nth(y, 5, 0, 2), "Vatertag", "👔");
    if (y >= 1980) {
      b.spec(nth(y, 2, 0, -1), "Sommerzeit +1h", "🕐");
      b.spec(y >= 1996 ? nth(y, 9, 0, -1) : nth(y, 8, 0, -1), "Winterzeit -1h", "🕐");
    }
    for (let i = 1; i <= 4; i++) b.spec(advent(y, i), `${i}. Advent`, "🕯️");
    b.spec(D(4, 15), "Winterreifen Ende", "🛞");
    b.spec(D(11, 11), "Martini", "🦢");
    b.spec(D(12, 24), "Heiliger Abend", "🎄");
    return b.map;
  }

  // ---------------- Deutschland (bundesweit; regionale als Sondertage) ----------------
  function DE(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    b.hol(D(1, 1), "Neujahr");
    b.hol(add(e, -2), "Karfreitag");
    b.hol(add(e, 1), "Ostermontag");
    b.hol(D(5, 1), "Tag der Arbeit");
    b.hol(add(e, 39), "Christi Himmelfahrt");
    b.hol(add(e, 50), "Pfingstmontag");
    if (y >= 1990) b.hol(D(10, 3), "Tag der Deutschen Einheit");
    else if (y >= 1954) b.hol(D(6, 17), "Tag der deutschen Einheit (17. Juni)");
    if (y === 2017) b.hol(D(10, 31), "Reformationstag (500 Jahre)");
    b.hol(D(12, 25), "1. Weihnachtstag");
    b.hol(D(12, 26), "2. Weihnachtstag");
    // regionale Feiertage (nicht bundesweit)
    b.spec(D(1, 6), "Hl. Drei Könige (regional)", "👑");
    if (y >= 2019) b.spec(D(3, 8), "Frauentag (Berlin, ab 2023 auch MV)", "♀");
    b.spec(add(e, 60), "Fronleichnam (regional)", "⛪");
    b.spec(D(8, 15), "Mariä Himmelfahrt (regional)", "⛪");
    if (y >= 2019) b.spec(D(9, 20), "Weltkindertag (Thüringen)", "🧒");
    if (y !== 2017) b.spec(D(10, 31), "Reformationstag (regional)", "📜");
    b.spec(D(11, 1), "Allerheiligen (regional)", "⛪");
    const bussUndBettag = add(advent(y, 1), -11);
    b.spec(bussUndBettag, y >= 1995 ? "Buß- und Bettag (Sachsen)" : "Buß- und Bettag", "🙏");
    // Sondertage
    b.spec(add(e, -52), "Weiberfastnacht", "🎭");
    b.spec(add(e, -48), "Rosenmontag", "🌹");
    b.spec(add(e, -47), "Fastnachtsdienstag", "🎉");
    b.spec(add(e, -46), "Aschermittwoch", "✝");
    b.spec(add(e, -3), "Gründonnerstag", "🍞");
    b.spec(add(e, -1), "Karsamstag", "🕯️");
    b.spec(e, "Ostersonntag", "🐣");
    b.spec(add(e, 49), "Pfingstsonntag", "🕊️");
    b.spec(nth(y, 4, 0, 2), "Muttertag", "💐");
    b.spec(nth(y, 9, 0, 1), "Erntedankfest", "🌾");
    if (y >= 1980) {
      b.spec(nth(y, 2, 0, -1), "Sommerzeit +1h", "🕐");
      b.spec(y >= 1996 ? nth(y, 9, 0, -1) : nth(y, 8, 0, -1), "Winterzeit -1h", "🕐");
    }
    b.spec(D(11, 11), "Martinstag", "🏮");
    b.spec(add(advent(y, 1), -14), "Volkstrauertag", "🕊️");
    b.spec(add(advent(y, 1), -7), "Totensonntag", "🕯️");
    for (let i = 1; i <= 4; i++) b.spec(advent(y, i), `${i}. Advent`, "🕯️");
    b.spec(D(12, 6), "Nikolaus", "🎅");
    b.spec(D(12, 24), "Heiligabend", "🎄");
    b.spec(D(12, 31), "Silvester", "🎆");
    return b.map;
  }

  // ---------------- Großbritannien: England & Wales (bank holidays) ----------------
  function GB(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    const bh = (date, label) => b.hol(date, label, "🇬🇧");
    const substituteMonday = (date) => {
      const wd = date.getDay();
      return wd === 6 ? add(date, 2) : wd === 0 ? add(date, 1) : null;
    };
    if (y >= 1974) {
      bh(D(1, 1), "New Year's Day");
      const s = substituteMonday(D(1, 1));
      if (s) bh(s, "New Year's Day (substitute day)");
    }
    bh(add(e, -2), "Good Friday");
    bh(add(e, 1), "Easter Monday");
    if (y >= 1978) {
      const earlyMay = y === 1995 || y === 2020 ? D(5, 8) : nth(y, 4, 1, 1);
      bh(earlyMay, y === 1995 ? "Early May bank holiday (VE Day 50)" : y === 2020 ? "Early May bank holiday (VE Day 75)" : "Early May bank holiday");
    }
    if (y >= 1971) {
      const spring = { 1977: D(6, 6), 2002: D(6, 4), 2012: D(6, 4), 2022: D(6, 2) }[y] || nth(y, 4, 1, -1);
      bh(spring, "Spring bank holiday");
      bh(nth(y, 7, 1, -1), "Summer bank holiday");
    } else {
      bh(add(e, 50), "Whit Monday");
      bh(nth(y, 7, 1, 1), "August bank holiday");
    }
    // Weihnachten mit Ersatztagen
    const xmas = D(12, 25), wd = xmas.getDay();
    bh(xmas, "Christmas Day");
    bh(D(12, 26), "Boxing Day");
    if (y >= 1971) {
      if (wd === 5) bh(D(12, 28), "Boxing Day (substitute day)");
      if (wd === 6) { bh(D(12, 27), "Christmas Day (substitute day)"); bh(D(12, 28), "Boxing Day (substitute day)"); }
      if (wd === 0) bh(D(12, 27), "Christmas Day (substitute day)");
    }
    // einmalige Feiertage
    const oneOff = {
      1973: [[11, 14, "Royal Wedding"]], 1977: [[6, 7, "Silver Jubilee"]], 1981: [[7, 29, "Royal Wedding"]],
      1999: [[12, 31, "Millennium Celebrations"]], 2002: [[6, 3, "Golden Jubilee"]], 2011: [[4, 29, "Royal Wedding"]],
      2012: [[6, 5, "Diamond Jubilee"]], 2022: [[6, 3, "Platinum Jubilee"], [9, 19, "State Funeral of Queen Elizabeth II"]],
      2023: [[5, 8, "Coronation of King Charles III"]],
    }[y] || [];
    for (const [m, d, label] of oneOff) bh(D(m, d), label);
    // special days
    b.spec(add(e, -47), "Shrove Tuesday (Pancake Day)", "🥞");
    b.spec(add(e, -21), "Mothering Sunday", "💐");
    b.spec(add(e, -7), "Palm Sunday", "🌿");
    b.spec(e, "Easter Sunday", "🐣");
    b.spec(D(2, 14), "Valentine's Day", "❤️");
    b.spec(D(3, 1), "St David's Day", "🏴");
    b.spec(D(3, 17), "St Patrick's Day", "☘️");
    b.spec(D(4, 23), "St George's Day", "🏴");
    if (y >= 1910) b.spec(nth(y, 5, 0, 3), "Father's Day", "👔");
    if (y >= 1972) {
      b.spec(nth(y, 2, 0, -1), "British Summer Time begins", "🕐");
      b.spec(nth(y, 9, 0, -1), "British Summer Time ends", "🕐");
    }
    b.spec(D(10, 31), "Halloween", "🎃");
    b.spec(D(11, 5), "Bonfire Night", "🎆");
    if (y >= 1919) b.spec(nth(y, 10, 0, 2), "Remembrance Sunday", "🌺");
    b.spec(D(11, 30), "St Andrew's Day", "🏴");
    b.spec(D(12, 24), "Christmas Eve", "🎄");
    b.spec(D(12, 31), "New Year's Eve", "🎆");
    return b.map;
  }

  // ---------------- USA (federal holidays) ----------------
  function US(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    const fh = (date, label) => b.hol(date, label, "🇺🇸");
    // Feiertag mit Ersatztag (seit 1971): Samstag -> Freitag, Sonntag -> Montag
    const fixed = (date, label) => {
      fh(date, label);
      if (y >= 1971) {
        const wd = date.getDay();
        if (wd === 6) fh(add(date, -1), `${label} (observed)`);
        if (wd === 0) fh(add(date, 1), `${label} (observed)`);
      }
    };
    fixed(D(1, 1), "New Year's Day");
    // Neujahr des Folgejahres an einem Samstag -> 31.12. frei
    if (y >= 1970 && new Date(y + 1, 0, 1).getDay() === 6) fh(D(12, 31), "New Year's Day (observed)");
    if (y >= 1986) fh(nth(y, 0, 1, 3), "Martin Luther King Jr. Day");
    fh(y >= 1971 ? nth(y, 1, 1, 3) : D(2, 22), "Washington's Birthday");
    fh(y >= 1971 ? nth(y, 4, 1, -1) : D(5, 30), "Memorial Day");
    if (y >= 2021) fixed(D(6, 19), "Juneteenth");
    fixed(D(7, 4), "Independence Day");
    fh(nth(y, 8, 1, 1), "Labor Day");
    if (y >= 1971) fh(nth(y, 9, 1, 2), "Columbus Day");
    else if (y >= 1937) fh(D(10, 12), "Columbus Day");
    if (y >= 1971 && y <= 1977) fh(nth(y, 9, 1, 4), "Veterans Day");
    else if (y >= 1938) fixed(D(11, 11), y >= 1954 ? "Veterans Day" : "Armistice Day");
    fh(y >= 1942 ? nth(y, 10, 4, 4) : nth(y, 10, 4, -1), "Thanksgiving Day");
    fixed(D(12, 25), "Christmas Day");
    // special days
    b.spec(D(2, 2), "Groundhog Day", "🦫");
    b.spec(D(2, 14), "Valentine's Day", "❤️");
    b.spec(D(3, 17), "St. Patrick's Day", "☘️");
    b.spec(e, "Easter Sunday", "🐣");
    if (y >= 1914) b.spec(nth(y, 4, 0, 2), "Mother's Day", "💐");
    if (y >= 1972) b.spec(nth(y, 5, 0, 3), "Father's Day", "👔");
    if (y >= 2007) {
      b.spec(nth(y, 2, 0, 2), "Daylight saving time begins", "🕐");
      b.spec(nth(y, 10, 0, 1), "Daylight saving time ends", "🕐");
    } else if (y >= 1987) {
      b.spec(nth(y, 3, 0, 1), "Daylight saving time begins", "🕐");
      b.spec(nth(y, 9, 0, -1), "Daylight saving time ends", "🕐");
    } else if (y >= 1967 && y !== 1974 && y !== 1975) {
      b.spec(nth(y, 3, 0, -1), "Daylight saving time begins", "🕐");
      b.spec(nth(y, 9, 0, -1), "Daylight saving time ends", "🕐");
    }
    b.spec(D(10, 31), "Halloween", "🎃");
    if (y % 2 === 0) b.spec(add(nth(y, 10, 1, 1), 1), "Election Day", "🗳️");
    if (y >= 1942) b.spec(add(nth(y, 10, 4, 4), 1), "Black Friday", "🛍️");
    b.spec(D(12, 24), "Christmas Eve", "🎄");
    b.spec(D(12, 31), "New Year's Eve", "🎆");
    return b.map;
  }

  // Sommerzeit nach EU-Regel (ab 1981; Ende vor 1996 im September)
  function clockChange(b, y, on, off) {
    if (y < 1981) return;
    b.spec(nth(y, 2, 0, -1), on, "🕐");
    b.spec(y >= 1996 ? nth(y, 9, 0, -1) : nth(y, 8, 0, -1), off, "🕐");
  }

  // ---------------- Schweiz (landesweit übliche Feiertage; kantonale als Sondertage) ----------------
  function CH(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    const hol = (date, label) => b.hol(date, label, "🇨🇭");
    hol(D(1, 1), "Neujahr");
    hol(add(e, -2), "Karfreitag");
    hol(add(e, 1), "Ostermontag");
    hol(add(e, 39), "Auffahrt");
    hol(add(e, 50), "Pfingstmontag");
    if (y >= 1899) hol(D(8, 1), "Bundesfeiertag");
    hol(D(12, 25), "Weihnachten");
    hol(D(12, 26), "Stephanstag");
    // kantonal / regional
    b.spec(D(1, 2), "Berchtoldstag (kantonal)", "🍷");
    b.spec(D(3, 19), "Josefstag (kantonal)", "⛪");
    b.spec(D(5, 1), "Tag der Arbeit (kantonal)", "🛠️");
    b.spec(add(e, 60), "Fronleichnam (kantonal)", "⛪");
    b.spec(D(8, 15), "Mariä Himmelfahrt (kantonal)", "⛪");
    b.spec(D(11, 1), "Allerheiligen (kantonal)", "⛪");
    b.spec(D(12, 8), "Mariä Empfängnis (kantonal)", "⛪");
    // Sondertage
    b.spec(add(e, -46), "Aschermittwoch", "✝");
    b.spec(add(e, -3), "Gründonnerstag", "🍞");
    b.spec(e, "Ostersonntag", "🐣");
    b.spec(add(e, 49), "Pfingstsonntag", "🕊️");
    b.spec(nth(y, 4, 0, 2), "Muttertag", "💐");
    b.spec(nth(y, 8, 0, 3), "Eidg. Dank-, Buss- und Bettag", "🙏");
    clockChange(b, y, "Sommerzeit +1h", "Winterzeit -1h");
    for (let i = 1; i <= 4; i++) b.spec(advent(y, i), `${i}. Advent`, "🕯️");
    b.spec(D(12, 6), "Samichlaus", "🎅");
    b.spec(D(12, 24), "Heiligabend", "🎄");
    b.spec(D(12, 31), "Silvester", "🎆");
    return b.map;
  }

  // ---------------- Frankreich (jours fériés) ----------------
  function FR(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    const hol = (date, label) => b.hol(date, label, "🇫🇷");
    hol(D(1, 1), "Jour de l'An");
    hol(add(e, 1), "Lundi de Pâques");
    if (y >= 1919) hol(D(5, 1), "Fête du Travail");
    if ((y >= 1953 && y <= 1959) || y >= 1981) hol(D(5, 8), "Victoire 1945");
    hol(add(e, 39), "Ascension");
    hol(add(e, 50), "Lundi de Pentecôte");
    if (y >= 1880) hol(D(7, 14), "Fête nationale");
    hol(D(8, 15), "Assomption");
    hol(D(11, 1), "Toussaint");
    if (y >= 1922) hol(D(11, 11), "Armistice 1918");
    hol(D(12, 25), "Noël");
    // Alsace-Moselle
    b.spec(add(e, -2), "Vendredi saint (Alsace-Moselle)", "✝");
    b.spec(D(12, 26), "Saint-Étienne (Alsace-Moselle)", "⛪");
    // journées particulières
    b.spec(D(1, 6), "Épiphanie", "👑");
    b.spec(D(2, 2), "Chandeleur", "🥞");
    b.spec(D(2, 14), "Saint-Valentin", "❤️");
    b.spec(add(e, -47), "Mardi gras", "🎭");
    b.spec(add(e, -7), "Rameaux", "🌿");
    b.spec(e, "Pâques", "🐣");
    b.spec(add(e, 49), "Pentecôte", "🕊️");
    if (y >= 1950) { // dernier dimanche de mai, sauf Pentecôte -> premier dimanche de juin
      let md = nth(y, 4, 0, -1);
      if (md.getTime() === add(e, 49).getTime()) md = nth(y, 5, 0, 1);
      b.spec(md, "Fête des mères", "💐");
    }
    if (y >= 1952) b.spec(nth(y, 5, 0, 3), "Fête des pères", "👔");
    if (y >= 1982) b.spec(D(6, 21), "Fête de la musique", "🎵");
    clockChange(b, y, "Passage à l'heure d'été", "Passage à l'heure d'hiver");
    b.spec(D(12, 24), "Réveillon de Noël", "🎄");
    b.spec(D(12, 31), "Saint-Sylvestre", "🎆");
    return b.map;
  }

  // ---------------- Italien (festività nazionali) ----------------
  function IT(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    const hol = (date, label) => b.hol(date, label, "🇮🇹");
    hol(D(1, 1), "Capodanno");
    if (y < 1978 || y >= 1986) hol(D(1, 6), "Epifania");
    if (y < 1977) hol(D(3, 19), "San Giuseppe");
    hol(add(e, 1), "Lunedì dell'Angelo (Pasquetta)");
    if (y >= 1946) hol(D(4, 25), "Festa della Liberazione");
    if (y >= 1946) hol(D(5, 1), "Festa dei Lavoratori");
    if (y < 1977) { hol(add(e, 39), "Ascensione"); hol(add(e, 60), "Corpus Domini"); hol(D(6, 29), "Santi Pietro e Paolo"); }
    if (y >= 1947) hol(y >= 1977 && y <= 2000 ? nth(y, 5, 0, 1) : D(6, 2), "Festa della Repubblica");
    hol(D(8, 15), "Ferragosto");
    if ((y >= 1958 && y <= 1976) || y >= 2026) hol(D(10, 4), "San Francesco d'Assisi");
    hol(D(11, 1), "Ognissanti");
    if (y >= 1922 && y <= 1976) hol(D(11, 4), "Giorno dell'Unità Nazionale");
    else if (y >= 1977) b.spec(D(11, 4), "Giornata dell'Unità Nazionale e delle Forze Armate", "🇮🇹");
    hol(D(12, 8), "Immacolata Concezione");
    hol(D(12, 25), "Natale");
    hol(D(12, 26), "Santo Stefano");
    // ricorrenze
    if (y >= 1977) b.spec(D(6, 29), "Santi Pietro e Paolo (Roma)", "⛪");
    b.spec(D(2, 14), "San Valentino", "❤️");
    b.spec(add(e, -52), "Giovedì grasso", "🎭");
    b.spec(add(e, -47), "Martedì grasso", "🎉");
    b.spec(add(e, -46), "Mercoledì delle Ceneri", "✝");
    if (y >= 1977) b.spec(D(3, 19), "Festa del papà (San Giuseppe)", "👔");
    b.spec(add(e, -7), "Domenica delle Palme", "🌿");
    b.spec(e, "Pasqua", "🐣");
    if (y >= 1957) b.spec(nth(y, 4, 0, 2), "Festa della mamma", "💐");
    clockChange(b, y, "Inizio ora legale", "Fine ora legale");
    b.spec(D(11, 2), "Commemorazione dei defunti", "🕯️");
    b.spec(D(12, 24), "Vigilia di Natale", "🎄");
    b.spec(D(12, 31), "San Silvestro", "🎆");
    return b.map;
  }

  // ---------------- Spanien (fiestas nacionales; autonómicas als Sondertage) ----------------
  function ES(y) {
    const b = builder(y), e = easter(y), D = (m, d) => new Date(y, m - 1, d);
    const hol = (date, label) => b.hol(date, label, "🇪🇸");
    hol(D(1, 1), "Año Nuevo");
    hol(D(1, 6), "Epifanía del Señor");
    hol(add(e, -2), "Viernes Santo");
    if (y >= 1931) hol(D(5, 1), "Fiesta del Trabajo");
    hol(D(8, 15), "Asunción de la Virgen");
    if (y >= 1918) hol(D(10, 12), y >= 1987 ? "Fiesta Nacional de España" : y >= 1958 ? "Día de la Hispanidad" : "Día de la Raza");
    hol(D(11, 1), "Todos los Santos");
    if (y >= 1983) hol(D(12, 6), "Día de la Constitución");
    hol(D(12, 8), "Inmaculada Concepción");
    hol(D(12, 25), "Navidad");
    // autonómicas / regionales
    b.spec(add(e, -3), "Jueves Santo (casi todas las CC. AA.)", "🍞");
    b.spec(add(e, 1), "Lunes de Pascua (algunas CC. AA.)", "🐣");
    b.spec(D(3, 19), "San José (algunas CC. AA.) · Día del Padre", "👔");
    b.spec(D(4, 23), "Sant Jordi (Cataluña) · Día de Aragón", "🌹");
    b.spec(D(7, 25), "Santiago Apóstol (algunas CC. AA.)", "⛪");
    // fechas señaladas
    b.spec(add(e, -7), "Domingo de Ramos", "🌿");
    b.spec(e, "Domingo de Resurrección", "🐣");
    if (y >= 1965) b.spec(nth(y, 4, 0, 1), "Día de la Madre", "💐");
    clockChange(b, y, "Cambio al horario de verano", "Cambio al horario de invierno");
    b.spec(D(12, 24), "Nochebuena", "🎄");
    b.spec(D(12, 28), "Santos Inocentes", "🤡");
    b.spec(D(12, 31), "Nochevieja", "🎆");
    return b.map;
  }

  const REGIONS = { AT, DE, CH, FR, IT, ES, GB, US };

  function yearMap(region, y) {
    const k = region + y;
    if (!cache.has(k)) cache.set(k, REGIONS[region] ? REGIONS[region](y) : new Map());
    return cache.get(k);
  }

  function dayMarks(region, y, m, d, withSpecial) {
    if (!REGIONS[region] || y < 1900 || y > 2100) return [];
    const list = yearMap(region, y).get(`${m + 1}-${d}`) || [];
    const res = withSpecial ? list : list.filter((x) => x.type === "hol");
    // Feiertage vor Sondertagen
    return [...res].sort((a, b) => (a.type === b.type ? 0 : a.type === "hol" ? -1 : 1));
  }

  return { dayMarks, regions: Object.keys(REGIONS), easter };
})();
