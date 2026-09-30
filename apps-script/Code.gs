/**
 * Viva España 2026 — shared storage for the trip site.
 * Lives inside a Google Sheet (Extensions → Apps Script). The site reads and writes through this script.
 *
 * Setup: paste this whole file, Save, run `setup` once (approve the permissions), then
 * Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → copy the Web app URL.
 */

const ADMIN_PERSON = "Oliver";   // this person's PIN can act for everyone
const PEOPLE = ["Oliver","Meredith","Mia","Chib","Lake","Lam","Joe","Danny"];
const METHODS = ["Venmo","Zelle","PayPal","Cash App","Cash","Bank transfer","Other"];
const LEGS = ["general","madrid","sansebastian","barcelona"];

const SHEETS = {
  people:   ["person","pinHash","phone","venmo","zelle","paypal","cashapp","arriveFlight","arriveWhen","departFlight","departWhen","updated"],
  expenses: ["id","what","amount","currency","paidBy","split","leg","date","by","at"],
  payments: ["id","from","to","amount","currency","method","for","item","by","at"],
  tips:     ["id","title","city","category","note","link","by","at"],
};
const TIP_CATS = ["food","sights","activities","nightlife","other"];
const CONTACT = ["phone","venmo","zelle","paypal","cashapp"];

/* ---------------- entry points ---------------- */
function doGet() { return out({ ok: true, state: state_() }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const res = handle_(req) || {};
    res.ok = true;
    res.state = state_();
    return out(res);
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- actions ---------------- */
function handle_(req) {
  switch (req.action) {
    case "state": return {};
    case "setPin": return setPin_(req);
    case "verify": { const a = auth_(req); return { admin: a.admin }; }
    case "savePerson": return savePerson_(auth_(req), req);
    case "add": return add_(auth_(req), req);
    case "delete": return del_(auth_(req), req);
    case "resetPin": return resetPin_(auth_(req), req);
    default: throw new Error("Unknown action.");
  }
}

function setPin_(req) {
  const person = checkPerson_(req.person), pin = String(req.pin || "");
  if (!/^\d{4}$/.test(pin)) throw new Error("Your PIN needs to be 4 digits.");
  const row = personRow_(person);
  if (row.data.pinHash) throw new Error(person + " already has a PIN. Ask Oliver to reset it if it isn't yours.");
  setCell_("people", row.index, "pinHash", hash_(person, pin));
  setCell_("people", row.index, "updated", new Date());
  return { admin: person === ADMIN_PERSON };
}

function auth_(req) {
  const person = checkPerson_(req.person), pin = String(req.pin || "");
  const cache = CacheService.getScriptCache(), key = "fail_" + person;
  const fails = Number(cache.get(key) || 0);
  if (fails >= 8) throw new Error("Too many wrong PINs. Try again in 10 minutes.");
  const row = personRow_(person);
  if (!row.data.pinHash) throw new Error("Set a PIN for " + person + " first.");
  if (hash_(person, pin) !== row.data.pinHash) {
    cache.put(key, String(fails + 1), 600);
    throw new Error("That PIN doesn't match.");
  }
  return { person: person, admin: person === ADMIN_PERSON };
}

function canActAs_(a, target) {
  if (!(a.admin || a.person === target)) throw new Error("You can only change your own info.");
}

function savePerson_(a, req) {
  const target = checkPerson_(req.target);
  canActAs_(a, target);
  const row = personRow_(target), v = req.value || {};
  if (req.section === "contact") {
    CONTACT.forEach(k => setCell_("people", row.index, k, clean_(v[k], 60)));
  } else if (req.section === "travel") {
    const kind = req.kind === "depart" ? "depart" : "arrive";
    if (row.data[kind + "Flight"] && !a.admin) throw new Error("This flight is already filled in. Ask Oliver to change it.");
    const flight = clean_(v.flight, 60);
    if (!flight) throw new Error("Add a flight number or a short description.");
    setCell_("people", row.index, kind + "Flight", flight);
    setCell_("people", row.index, kind + "When", clean_(v.when, 60));
  } else throw new Error("Unknown section.");
  setCell_("people", row.index, "updated", new Date());
  return {};
}

function add_(a, req) {
  const o = req.obj || {}, now = Date.now(), id = Utilities.getUuid();
  if (req.kind === "expenses") {
    const paidBy = checkPerson_(o.paidBy);
    if (!a.admin && paidBy !== a.person) throw new Error("You can only add costs you paid.");
    const split = (o.split || []).filter(p => PEOPLE.indexOf(p) >= 0);
    if (!split.length) throw new Error("Choose at least one person to split it with.");
    const amount = money_(o.amount);
    append_("expenses", { id: id, what: clean_(o.what, 80) || "Cost", amount: amount, currency: cur_(o.currency), paidBy: paidBy,
      split: split.join(", "), leg: LEGS.indexOf(o.leg) >= 0 ? o.leg : "general", date: clean_(o.date, 10), by: a.person, at: now });
  } else if (req.kind === "payments") {
    const from = checkPerson_(o.from), to = checkPerson_(o.to);
    if (from === to) throw new Error("From and To need to be different people.");
    if (!a.admin && a.person !== from && a.person !== to) throw new Error("You can only record payments you sent or received.");
    append_("payments", { id: id, from: from, to: to, amount: money_(o.amount), currency: cur_(o.currency),
      method: METHODS.indexOf(o.method) >= 0 ? o.method : "Other", "for": clean_(o["for"], 120), item: clean_(o.item, 80), by: a.person, at: now });
  } else if (req.kind === "tips") {
    const title = clean_(o.title, 80);
    if (!title) throw new Error("Name the place or thing.");
    const link = String(o.link || "").trim();
    if (link && !/^https?:\/\/[^\s"'<>]+$/i.test(link)) throw new Error("Links need to start with https://");
    append_("tips", { id: id, title: title, city: LEGS.indexOf(o.city) >= 0 ? o.city : "general",
      category: TIP_CATS.indexOf(o.category) >= 0 ? o.category : "other", note: clean_(o.note, 240), link: link.slice(0, 300), by: a.person, at: now });
  } else throw new Error("Unknown list.");
  return { id: id };
}

function del_(a, req) {
  const name = ["payments","tips"].indexOf(req.kind) >= 0 ? req.kind : "expenses";
  const rows = rows_(name);
  const i = rows.findIndex(r => r.id === req.id);
  if (i < 0) return {};
  if (!a.admin && rows[i].by !== a.person) throw new Error("Only the person who added this, or Oliver, can remove it.");
  sheet_(name).deleteRow(i + 2);
  return {};
}

function resetPin_(a, req) {
  if (!a.admin) throw new Error("Only Oliver can reset PINs.");
  const row = personRow_(checkPerson_(req.target));
  setCell_("people", row.index, "pinHash", "");
  return {};
}

/* ---------------- state ---------------- */
function state_() {
  ensure_();
  const people = rows_("people").map(r => ({
    person: r.person, claimed: !!r.pinHash,
    contact: CONTACT.reduce((c, k) => { if (r[k]) c[k] = String(r[k]); return c; }, {}),
    travel: {
      arrive: r.arriveFlight ? { flight: String(r.arriveFlight), when: String(r.arriveWhen || "") } : null,
      depart: r.departFlight ? { flight: String(r.departFlight), when: String(r.departWhen || "") } : null,
    },
  }));
  const expenses = rows_("expenses").map(r => ({ id: r.id, what: String(r.what), amount: Number(r.amount), currency: r.currency,
    paidBy: r.paidBy, split: String(r.split || "").split(",").map(s => s.trim()).filter(Boolean), leg: r.leg || "general",
    date: dateStr_(r.date), by: r.by, at: Number(r.at) || 0 }));
  const payments = rows_("payments").map(r => ({ id: r.id, from: r.from, to: r.to, amount: Number(r.amount), currency: r.currency,
    method: r.method, "for": String(r["for"] || ""), item: String(r.item || ""), by: r.by, at: Number(r.at) || 0 }));
  const tips = rows_("tips").map(r => ({ id: r.id, title: String(r.title), city: r.city, category: r.category,
    note: String(r.note || ""), link: String(r.link || ""), by: r.by, at: Number(r.at) || 0 }));
  return { people: people, expenses: expenses, payments: payments, tips: tips };
}

/* ---------------- one-time setup ---------------- */
function setup() {
  ensure_();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty("SALT")) props.setProperty("SALT", Utilities.getUuid());
  if (rows_("expenses").length === 0) {
    const all = PEOPLE, ss = ["Oliver","Meredith","Lake","Lam","Joe","Danny"];
    const seed = [
      ["Madrid Rental (Vrbo, 3 Nights)", 1979, "EUR", "Lake", all, "madrid", "2026-08-06"],
      ["San Sebastián Apartment (Vrbo, 2 Nights)", 972, "EUR", "Joe", ss, "sansebastian", "2026-08-29"],
      ["Tuxedo Rental (Trajes Guzmán)", 614.92, "EUR", "Lake", ["Oliver","Joe","Lake","Danny","Chib"], "madrid", "2026-09-29"],
      ["Hertz Van (Incl. $236.25 Due at Pickup)", 250.25, "USD", "Oliver", ss, "sansebastian", "2026-10-04"],
      ["Vueling Flight San Sebastián → Barcelona", 189.32, "USD", "Oliver", ["Oliver","Meredith","Lake","Lam","Joe"], "barcelona", "2026-10-06"],
      ["Barcelona Apartment (Incl. $192.03 City Tax at Check-In)", 973.48, "USD", "Oliver", ["Oliver","Lake","Lam","Joe"], "barcelona", "2026-10-06"],
      ["Iberia Flight to Madrid (Oliver & Meredith)", 923, "USD", "Oliver", ["Oliver","Meredith"], "general", "2026-08-16"],
    ];
    seed.forEach((s, i) => append_("expenses", { id: Utilities.getUuid(), what: s[0], amount: s[1], currency: s[2], paidBy: s[3],
      split: s[4].join(", "), leg: s[5], date: s[6], by: ADMIN_PERSON, at: Date.now() + i }));
  }
  Logger.log("Setup done. Now: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).");
}

/* ---------------- sheet helpers ---------------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name) { return ss_().getSheetByName(name); }
function ensure_() {
  Object.keys(SHEETS).forEach(name => {
    let sh = sheet_(name);
    if (!sh) {
      sh = ss_().insertSheet(name);
      sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight("bold");
      sh.setFrozenRows(1);
      sh.getRange("A:Z").setNumberFormat("@"); // keep everything as plain text so Sheets doesn't reformat it
    }
  });
  const ppl = sheet_("people"), have = rows_("people").map(r => r.person);
  PEOPLE.forEach(p => { if (have.indexOf(p) < 0) ppl.appendRow(SHEETS.people.map(h => h === "person" ? p : "")); });
}
function rows_(name) {
  const sh = sheet_(name), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const head = SHEETS[name];
  return sh.getRange(2, 1, n, head.length).getValues().map(v => head.reduce((o, h, i) => { o[h] = v[i]; return o; }, {}));
}
function append_(name, obj) { sheet_(name).appendRow(SHEETS[name].map(h => obj[h] === undefined ? "" : obj[h])); }
function personRow_(person) {
  const rows = rows_("people"), i = rows.findIndex(r => r.person === person);
  if (i < 0) throw new Error("Unknown person.");
  return { index: i + 2, data: rows[i] };
}
function setCell_(name, rowIndex, col, value) { sheet_(name).getRange(rowIndex, SHEETS[name].indexOf(col) + 1).setValue(value); }

/* ---------------- small helpers ---------------- */
function checkPerson_(p) { if (PEOPLE.indexOf(p) < 0) throw new Error("Pick a name from the list."); return p; }
function clean_(s, max) {
  const t = String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
  return /^[=+\-@]/.test(t) ? "'" + t : t;   // never let typed text become a spreadsheet formula
}
function cur_(c) { return c === "USD" ? "USD" : "EUR"; }
function money_(v) { const n = Math.round(Number(v) * 100) / 100; if (!(n > 0) || n > 100000) throw new Error("Enter an amount greater than zero."); return n; }
function dateStr_(d) { return d instanceof Date ? Utilities.formatDate(d, "UTC", "yyyy-MM-dd") : String(d || ""); }
function hash_(person, pin) {
  const salt = PropertiesService.getScriptProperties().getProperty("SALT") || "";
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + "|" + person + "|" + pin);
  return "h:" + Utilities.base64Encode(bytes);
}
