const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Webhook-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));

// Serves the dashboard itself — public/index.html — from this same
// service, at the same URL as the API. Visiting the backend's root URL
// now shows the actual HRMS dashboard instead of nothing.
app.use(express.static(path.join(__dirname, "public")));

// Clean URL for the employee self-service portal — same server, separate page.
app.get("/employee", (req, res) => res.sendFile(path.join(__dirname, "public", "employee.html")));

// ---------------------------------------------------------------------
// Schema + one-time seed. Runs on every startup; all statements are
// idempotent (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO
// NOTHING), so restarts and redeploys never wipe or duplicate data —
// that was the whole problem with the in-memory version this replaces.
// ---------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      attendance_provider TEXT,
      attendance_status TEXT DEFAULT 'Not configured',
      device_id TEXT,
      biometric_status TEXT DEFAULT 'Not configured',
      last_sync TEXT DEFAULT 'No records'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT,
      hotel_id TEXT,
      role TEXT,
      status TEXT DEFAULT 'Active',
      machine_user_id TEXT DEFAULT '',
      monthly_salary NUMERIC DEFAULT 0,
      date_of_joining DATE,
      property_code TEXT DEFAULT ''
    );
  `);
  // The table above already exists in production from before these columns
  // were added — CREATE TABLE IF NOT EXISTS won't retroactively add a
  // column to it, so this covers that case explicitly.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC DEFAULT 0;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_joining DATE;`);
  // Purely a human-readable label (e.g. "VCOR001") — not used for any
  // HRMS or biometric matching logic, unlike id or machine_user_id.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS property_code TEXT DEFAULT '';`);
  // Payroll/statutory fields. fixed_basic_salary is the wage PF and ESI are
  // both actually calculated on (confirmed against a real payroll register —
  // it is NOT the gross salary). pf_applicable/esi_applicable are per-employee
  // enrollment flags, not a live salary threshold: real employees earning
  // well above the ESI/PF ceilings still had contributions deducted, so
  // eligibility has to be something HR sets, not something the system guesses.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS fixed_basic_salary NUMERIC DEFAULT 0;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pf_applicable BOOLEAN DEFAULT true;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS esi_applicable BOOLEAN DEFAULT true;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account_no TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS ifsc_code TEXT DEFAULT '';`);
  // Exit record. last_working_day is also used as a hard stop date for
  // attendance/payroll/leave computation (like date_of_joining is a start
  // bound) — once past it, the employee simply produces no further rows,
  // so they drop off future Attendance/Roster/Payroll/Leaves automatically
  // without needing to be deleted or hidden by hand.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_working_day DATE;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS exit_reason TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS exit_note TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS ffs_amount NUMERIC;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS ffs_status TEXT DEFAULT '';`);

  // Employee self-service login. password_hash/password_salt are set the
  // first time someone actually changes their password (see below); until
  // then must_reset_password stays true and login is checked against the
  // one shared "first login" password in settings instead, so every new
  // employee can log in immediately without HR setting anything per person.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_salt TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN DEFAULT true;`);

  // An employee's own request to take leave. Doesn't touch attendance by
  // itself — only approving it (by HR/admin, in the main dashboard) writes
  // an attendance_overrides row for each date in the range.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT DEFAULT 'Pending',
      requested_at TIMESTAMP DEFAULT now(),
      decided_at TIMESTAMP,
      decision_note TEXT DEFAULT ''
    );
  `);

  // An employee's own request to have a specific day corrected — typically
  // because they forgot to punch the biometric device. Approving it (by
  // HR/admin) writes an attendance_overrides row for that one date.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regularization_requests (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      date DATE NOT NULL,
      reason TEXT NOT NULL,
      requested_status TEXT DEFAULT 'Present',
      status TEXT DEFAULT 'Pending',
      requested_at TIMESTAMP DEFAULT now(),
      decided_at TIMESTAMP,
      decision_note TEXT DEFAULT ''
    );
  `);

  // A running log of every salary change, so a gross-salary increase can
  // require — and keep a record of — a reason (promotion, annual
  // increment, etc). Decreases/corrections are logged too, with an
  // optional reason, for a complete history either way.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_increments (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      old_salary NUMERIC,
      new_salary NUMERIC,
      reason TEXT DEFAULT '',
      note TEXT DEFAULT '',
      changed_at TIMESTAMP DEFAULT now()
    );
  `);

  // Per-employee, per-month manual payroll entries: arrears, ad-hoc
  // deductions, advance recovery, salary hold, and full & final settlement.
  // These change every pay run, so they don't belong on the employee record.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_adjustments (
      employee_id TEXT NOT NULL,
      month TEXT NOT NULL,
      arrear NUMERIC DEFAULT 0,
      pf_abry_benefit NUMERIC DEFAULT 0,
      other_deductions NUMERIC DEFAULT 0,
      advance_recovery NUMERIC DEFAULT 0,
      salary_on_hold BOOLEAN DEFAULT false,
      fnf_amount NUMERIC,
      PRIMARY KEY (employee_id, month)
    );
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS integrations (
      id SERIAL PRIMARY KEY,
      hotel_id TEXT,
      hotel_name TEXT,
      hotel_code TEXT,
      device_sn TEXT,
      provider_name TEXT,
      timezone TEXT,
      method TEXT,
      auth_type TEXT,
      content_type TEXT,
      transport_mode TEXT,
      sync_mode TEXT,
      mapping_mode TEXT,
      endpoint_url TEXT,
      active BOOLEAN DEFAULT true,
      parameter_mappings JSONB DEFAULT '[]',
      status TEXT DEFAULT 'Not configured',
      last_test TEXT DEFAULT 'No records',
      last_sync TEXT DEFAULT 'No records',
      records_sent INT DEFAULT 0,
      records_received INT DEFAULT 0,
      failed_requests INT DEFAULT 0,
      duplicate_events INT DEFAULT 0,
      unmatched_employees INT DEFAULT 0,
      UNIQUE (hotel_id, device_sn)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duty_roster (
      employee_id TEXT NOT NULL,
      date DATE NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (employee_id, date)
    );
  `);

  // A manually-set status for one employee on one day, which takes
  // precedence over whatever the automatic punch/roster logic would
  // compute. Lets an admin correct a specific day (e.g. a device was
  // down, or someone forgot to punch) without touching the underlying
  // punch data.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_overrides (
      employee_id TEXT NOT NULL,
      date DATE NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (employee_id, date)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_logs (
      id SERIAL PRIMARY KEY,
      employee_code TEXT NOT NULL,
      log_datetime TEXT NOT NULL,
      log_time TEXT,
      downloaded_at TEXT,
      device_sn TEXT DEFAULT '',
      received_at TIMESTAMPTZ DEFAULT now(),
      source TEXT DEFAULT 'webhook',
      UNIQUE (employee_code, log_datetime, device_sn)
    );
  `);

  // Seed your real properties, taken from Realtime Biometrics' machine
  // list. ON CONFLICT DO NOTHING means this only inserts hotels that
  // don't already exist — safe to run on every startup.
  const realHotels = [
    ["HAAC", "Hotel Alpine Abode Continental", "HAAC", "RSS20230455731"],
    ["TRR", "The Royal Retreat", "TRR", "RSS20230455826"],
    ["SFR", "Songfum Retreat", "SFR", "RSS20230455737"],
    ["GLZ", "Glenz Resort", "GLZ", "RSS20230455736"],
    ["DVR", "Dream Villa Retreat", "DVR", "RSS20230455740"],
    ["TAR", "The Aryan Regency", "TAR", "RSS20230455949"],
    ["RDH", "Rodhi Resort", "RDH", "RSS20230455734"],
    ["MHB", "Milestone Hotel & Banquet", "MHB", "RSS20230455733"],
    ["EST", "Eastin Suites", "EST", "RSS20230455791"],
    ["CHT", "Chattore", "CHT", "RSS20230455735"],
    ["VEV", "Voyage Eco Village Resort", "VEV", "RSS20230455906"],
    // Corporate Office has two machines, not one — stored comma-separated;
    // the lookup below splits on comma so both serials match this hotel.
    ["HQ", "Corporate Office", "HQ", "RSS20230455946,RSS20230455948"]
  ];
  for (const [id, name, code, device_id] of realHotels) {
    await pool.query(
      `INSERT INTO hotels (id, name, code, attendance_provider, device_id)
       VALUES ($1, $2, $3, 'Realtime Biometrics', $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, code, device_id]
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_types (
      name TEXT PRIMARY KEY,
      code TEXT,
      annual_days NUMERIC DEFAULT 0,
      paid BOOLEAN DEFAULT true
    );
  `);
  // Opening balance per employee per leave type (including "Comp Off"),
  // valid from as_of onward. Uploaded once mid-year from the old spreadsheet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_balances (
      employee_id TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      opening_balance NUMERIC NOT NULL DEFAULT 0,
      as_of DATE NOT NULL,
      PRIMARY KEY (employee_id, leave_type)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Statutory rates — seeded once, never overwritten on restart, so an
  // in-app rate change (e.g. next PF ceiling revision) always sticks.
  // PF rounds to the nearest rupee (EPFO convention); ESI always rounds UP
  // (ESIC convention) — both confirmed against a real payroll register.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('pf_ceiling', '25000') ON CONFLICT (key) DO NOTHING`);
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('pf_rate', '0.12') ON CONFLICT (key) DO NOTHING`);
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('esi_employee_rate', '0.0075') ON CONFLICT (key) DO NOTHING`);
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('esi_employer_rate', '0.0325') ON CONFLICT (key) DO NOTHING`);
  // West Bengal Professional Tax slabs, effective September 2026 (per the
  // gazette notification). Stored as JSON so a future slab revision is a
  // data change, not a code change: [{upto, amount}], upto:null = no upper bound.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('pt_slabs', $1) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify([
      { upto: 20000, amount: 0 }, { upto: 30000, amount: 100 }, { upto: 50000, amount: 140 },
      { upto: 100000, amount: 170 }, { upto: null, amount: 208 }
    ])]);


  // The system no longer invents "Unmapped (...)" employees from unknown
  // punches, so remove the ones created earlier. Safe to run on every
  // start: once they're gone this deletes nothing.
  const cleaned = await pool.query("DELETE FROM employees WHERE name LIKE 'Unmapped (%)'");
  if (cleaned.rowCount) console.log(`Removed ${cleaned.rowCount} auto-created "Unmapped" employees.`);

  console.log("Database ready.");
}

// ==== PURE ENGINE START ====
// Everything between the START/END markers is plain logic with no database
// access, so it can be tested on its own.

// Pull just the YYYY-MM-DD part out of whatever date format shows up.
function ymd(value) {
  if (!value) return null;
  const s = String(value).trim();
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}
function pad2(n) { return String(n).padStart(2, "0"); }
// The hotels are in India and the server runs in UTC, so "today" must be
// worked out in IST or the current day would only appear at 5:30am.
function todayIst() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }
function daysInMonthOf(month) { return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate(); }
function eachDate(start, end, cb) {
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) { cb(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
}
// Minutes since midnight from "2026-09-27 08:45:00" or "2026-09-27T08:45:00".
function timeToMinutes(dt) {
  const m = String(dt || "").match(/[T\s](\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function fmtMins(m) { return m == null ? null : `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; }

// Turns one day's raw punch times into: how many real punches there were,
// first-in, last-out and total duty minutes. Punches within 5 minutes of
// the previous one count as a single punch (people often scan twice), so
// a double-scan at arrival is correctly treated as "no checkout yet".
function summarisePunches(arr) {
  if (!arr || !arr.length) return { count: 0, in: null, out: null, minutes: null };
  const timed = arr.filter(m => m !== null).sort((a, b) => a - b);
  const untimed = arr.length - timed.length;
  const clusters = [];
  let last = null;
  for (const m of timed) { if (last === null || m - last > 5) clusters.push(m); last = m; }
  const count = clusters.length + untimed;
  if (clusters.length >= 2) {
    const first = timed[0], lastT = timed[timed.length - 1];
    return { count, in: first, out: lastT, minutes: lastT - first };
  }
  return { count, in: timed.length ? timed[0] : null, out: null, minutes: null };
}

// Walks one employee day by day and decides each day's status.
//  - dense days:  every calendar day from denseStart to endDate
//  - sparse days: earlier days that have any data, only so comp-off credit
//                 earned before denseStart still carries forward
//  - data: { roster:{date:type}, punchMap:{date:[minutes]}, overrides:{date:status}, compOpening:{balance,asOf}|null }
// Rules: scheduled weekly off + punch => "Present (Worked Weekly Off)" and +1
// comp-off; working day with 2+ punches => Present, 1 => Present (Incomplete),
// none => Comp Off if a credit is available, otherwise Absent. A manual
// override always wins. Days before the employee's joining date are skipped.
// If an opening comp-off balance was uploaded, only days on/after its date
// move the balance.
function walkEmployee(emp, data, denseStart, endDate) {
  const roster = data.roster || {}, punchMap = data.punchMap || {}, overrides = data.overrides || {};
  const comp = data.compOpening || null;
  const doj = emp.date_of_joining ? ymd(emp.date_of_joining) : null;
  const lwd = emp.last_working_day ? ymd(emp.last_working_day) : null;

  const dates = new Set();
  [roster, punchMap, overrides].forEach(o => Object.keys(o).forEach(d => { if (d < denseStart && d <= endDate) dates.add(d); }));
  if (denseStart <= endDate) eachDate(denseStart, endDate, d => dates.add(d));
  const sorted = Array.from(dates).sort();

  const compStart = comp ? comp.asOf : null;
  let compBal = comp ? comp.balance : 0;
  const rows = [];
  for (const date of sorted) {
    if (doj && date < doj) continue;
    if (lwd && date > lwd) continue;
    const counts = !compStart || date >= compStart;
    const pd = summarisePunches(punchMap[date]);
    const rosterType = roster[date];
    let status, overridden = false;
    if (Object.prototype.hasOwnProperty.call(overrides, date)) {
      status = overrides[date]; overridden = true;
    } else if (rosterType === "Weekly Off") {
      status = pd.count > 0 ? "Present (Worked Weekly Off)" : "Weekly Off";
    } else if (pd.count >= 2) {
      status = "Present";
    } else if (pd.count === 1) {
      status = "Present (Incomplete)";
    } else if (counts && compBal > 0) {
      status = "Comp Off";
    } else {
      status = "Absent";
    }
    if (counts) {
      if (status === "Present (Worked Weekly Off)") compBal++;
      else if (status === "Comp Off") compBal--;
    }
    rows.push({
      date, status, overridden,
      punches: pd.count,
      in_time: fmtMins(pd.in), out_time: fmtMins(pd.out), duty_minutes: pd.minutes,
      shift: rosterType || null
    });
  }
  return rows;
}

// Leave balance for one leave type. With an uploaded opening balance dated on
// or after the start of the leave year, that balance is the starting point and
// only leaves taken on/after its date are deducted. Otherwise the policy's
// annual entitlement is the starting point from the start of the leave year.
function leaveBalanceFor(rows, type, opening, yearStart) {
  const useOpening = !!opening && opening.asOf >= yearStart;
  const start = useOpening ? opening.asOf : yearStart;
  const base = useOpening ? opening.balance : (Number(type.annual_days) || 0);
  const used = rows.filter(r => r.status === type.name && r.date >= start).length;
  return { opening: base, used, balance: base - used, as_of: useOpening ? opening.asOf : null };
}
function compLedgerFor(rows, opening) {
  const start = opening ? opening.asOf : null;
  const base = opening ? opening.balance : 0;
  let earned = 0, used = 0;
  for (const r of rows) {
    if (start && r.date < start) continue;
    if (r.status === "Present (Worked Weekly Off)") earned++;
    else if (r.status === "Comp Off") used++;
  }
  return { opening: base, earned, used, balance: base + earned - used, as_of: start };
}

// PF rounds to the NEAREST rupee (EPFO convention). ESI always rounds UP
// (ESIC convention: "any fraction of a rupee is rounded to the next higher
// rupee"). Both confirmed against a real payroll register, not assumed.
function roundNearest(x) { return Math.floor(x + 0.5); }
function roundUp(x) { return Math.ceil(x); }

// Computes one employee's statutory pay for a month, given their fixed
// (full-month) basic salary and gross salary, and how many of the month's
// days were actually payable. The wage ceiling applies to the FULL-month
// basic first, then the capped figure is pro-rated — not the other way
// round — matching how partial-month rows in the reference register work.
function computeStatutory(emp, payableDays, totalDays, rates) {
  const proration = totalDays ? payableDays / totalDays : 0;
  const grossP = (Number(emp.monthly_salary) || 0) * proration; // "monthly_salary" is the employee's Gross Salary
  const basicFull = Number(emp.fixed_basic_salary) || 0;
  const cappedBasicFull = Math.min(basicFull, rates.pf_ceiling);
  const basicP = basicFull * proration;           // "Fixed Basic Salary-P"
  const cappedBasicP = cappedBasicFull * proration; // wage PF is actually charged on
  const hraP = grossP - basicP;

  const pf = emp.pf_applicable ? roundNearest(cappedBasicP * rates.pf_rate) : 0;
  const esiEmployee = emp.esi_applicable ? roundUp(basicP * rates.esi_employee_rate) : 0;
  const esiEmployer = emp.esi_applicable ? roundUp(basicP * rates.esi_employer_rate) : 0;
  const pt = ptForSlab(grossP, rates.pt_slabs);
  const ctc = grossP + pf + esiEmployer;

  return { gross_p: grossP, basic_p: basicP, hra_p: hraP,
    pf_employee: pf, pf_employer: pf, esi_employee: esiEmployee, esi_employer: esiEmployer,
    professional_tax: pt, ctc };
}
function ptForSlab(grossP, slabs) {
  for (const s of slabs) { if (s.upto === null || grossP <= s.upto) return s.amount; }
  return 0;
}
// ==== PURE ENGINE END ====

const RESERVED_STATUSES = ["present", "present (incomplete)", "present (worked weekly off)", "weekly off", "comp off", "absent", "half day", "on duty"];
const EMPLOYEE_COLS = `id, name, hotel_id, role, status, machine_user_id, monthly_salary,
  to_char(date_of_joining, 'YYYY-MM-DD') AS date_of_joining, property_code,
  fixed_basic_salary, pf_applicable, esi_applicable, bank_name, bank_account_no, ifsc_code,
  to_char(last_working_day, 'YYYY-MM-DD') AS last_working_day, exit_reason, exit_note, ffs_amount, ffs_status`;

async function getPayrollRates() {
  const [ceiling, pfRate, esiEmpRate, esiEmplrRate, ptSlabs] = await Promise.all([
    getSetting("pf_ceiling", "25000"), getSetting("pf_rate", "0.12"),
    getSetting("esi_employee_rate", "0.0075"), getSetting("esi_employer_rate", "0.0325"),
    getSetting("pt_slabs", "[]")
  ]);
  return { pf_ceiling: Number(ceiling), pf_rate: Number(pfRate),
    esi_employee_rate: Number(esiEmpRate), esi_employer_rate: Number(esiEmplrRate), pt_slabs: JSON.parse(ptSlabs) };
}

// month (optional, "YYYY-MM"): when given, an employee who exited before
// that month started is left out entirely — that's what makes them stop
// appearing in Attendance/Roster/Payroll/Leaves for months after they left,
// without ever deleting their record. Leave month blank to get everyone
// (used by the Employees tab itself, where past exits still need to show).
async function getScopeEmployees(hotelId, month) {
  const scopeClause = hotelId === "all" || !hotelId ? "" : "WHERE hotel_id = $1";
  const params = hotelId === "all" || !hotelId ? [] : [hotelId];
  let sql = `SELECT ${EMPLOYEE_COLS} FROM employees ${scopeClause}`;
  if (month) {
    const monthStart = `${month}-01`;
    sql += `${scopeClause ? " AND" : " WHERE"} (status <> 'Exited' OR last_working_day IS NULL OR last_working_day >= $${params.length + 1}::date)`;
    params.push(monthStart);
  }
  const r = await pool.query(sql + " ORDER BY id", params);
  return r.rows;
}
async function getSetting(key, fallback) {
  const r = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
}

// Loads everything needed to work out attendance for a set of employees in
// one round of queries, then hands back a per-employee slice.
async function loadAttendanceContext(employees) {
  const empIds = employees.map(e => e.id);
  const matchCodes = Array.from(new Set(employees.flatMap(e => [e.id, e.machine_user_id]).filter(Boolean)));
  const [rosterRes, logsRes, overridesRes, compRes] = await Promise.all([
    pool.query(`SELECT employee_id, to_char(date,'YYYY-MM-DD') AS date, type FROM duty_roster WHERE employee_id = ANY($1)`, [empIds]),
    matchCodes.length
      ? pool.query(`SELECT employee_code, log_datetime, received_at FROM attendance_logs WHERE employee_code = ANY($1)`, [matchCodes])
      : Promise.resolve({ rows: [] }),
    pool.query(`SELECT employee_id, to_char(date,'YYYY-MM-DD') AS date, status FROM attendance_overrides WHERE employee_id = ANY($1)`, [empIds]),
    pool.query(`SELECT employee_id, opening_balance, to_char(as_of,'YYYY-MM-DD') AS as_of FROM leave_balances
                WHERE leave_type = 'Comp Off' AND employee_id = ANY($1)`, [empIds])
  ]);
  const rosterBy = {}, overridesBy = {}, compBy = {}, logsByCode = {};
  rosterRes.rows.forEach(r => { (rosterBy[r.employee_id] ??= {})[r.date] = r.type; });
  overridesRes.rows.forEach(o => { (overridesBy[o.employee_id] ??= {})[o.date] = o.status; });
  compRes.rows.forEach(c => { compBy[c.employee_id] = { balance: Number(c.opening_balance), asOf: c.as_of }; });
  logsRes.rows.forEach(l => { (logsByCode[String(l.employee_code)] ??= []).push(l); });
  return {
    forEmployee(emp) {
      // A punch belongs to an employee if its code equals their id or their
      // device card number. Blank values never match anything.
      const codes = new Set([String(emp.id)]);
      if (emp.machine_user_id) codes.add(String(emp.machine_user_id));
      const punchMap = {};
      codes.forEach(c => (logsByCode[c] || []).forEach(l => {
        const d = ymd(l.log_datetime || l.received_at);
        if (!d) return;
        (punchMap[d] ??= []).push(l.log_datetime ? timeToMinutes(l.log_datetime) : null);
      }));
      return { roster: rosterBy[emp.id] || {}, overrides: overridesBy[emp.id] || {}, punchMap, compOpening: compBy[emp.id] || null };
    }
  };
}

async function computeAttendance(hotelId, month) {
  const employees = await getScopeEmployees(hotelId, month);
  if (!employees.length) return [];
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${pad2(daysInMonthOf(month))}`;
  const today = todayIst();
  const endDate = today < monthEnd ? today : monthEnd; // never mark future days
  if (endDate < monthStart) return [];
  const ctx = await loadAttendanceContext(employees);
  const results = [];
  for (const emp of employees) {
    walkEmployee(emp, ctx.forEmployee(emp), monthStart, endDate)
      .filter(r => r.date >= monthStart && r.date <= endDate)
      .forEach(r => results.push({ employee_id: emp.id, employee_name: emp.name, hotel_id: emp.hotel_id, ...r }));
  }
  return results.sort((a, b) => a.date === b.date ? String(a.employee_id).localeCompare(String(b.employee_id)) : a.date.localeCompare(b.date));
}

// Monthly pay = monthly_salary / calendar days in month, per paid day. Paid
// days: present, weekly off, comp off and paid leave. Unpaid: absent and any
// leave type marked unpaid in the leave policy. Days before someone's joining
// date are not counted, so a mid-month joiner is pro-rated automatically.
// PF, ESI, Professional Tax and CTC are computed the same way your payroll
// processor does it (verified against a real pay register): PF/ESI are
// charged on Fixed Basic Salary (not Gross), PF rounds to the nearest rupee,
// ESI always rounds up, and both only apply when the employee is flagged
// pf_applicable / esi_applicable.
async function computePayroll(hotelId, month) {
  const employees = await getScopeEmployees(hotelId, month);
  if (!employees.length) return [];
  const attendance = await computeAttendance(hotelId, month);
  const types = (await pool.query("SELECT name, paid FROM leave_types")).rows;
  const paidByType = {};
  types.forEach(t => { paidByType[t.name] = t.paid; });
  const dim = daysInMonthOf(month);
  const rates = await getPayrollRates();
  const adjRes = await pool.query(
    "SELECT * FROM payroll_adjustments WHERE month = $1 AND employee_id = ANY($2)", [month, employees.map(e => e.id)]);
  const adjBy = {};
  adjRes.rows.forEach(a => { adjBy[a.employee_id] = a; });

  const tallies = {};
  for (const row of attendance) {
    const t = (tallies[row.employee_id] ??= { present: 0, absent: 0, weekly_off: 0, comp_off: 0, half_day: 0, on_duty: 0, leave: 0, unpaid_leave: 0 });
    const s = row.status;
    if (s === "Absent") t.absent++;
    else if (s === "Weekly Off") t.weekly_off++;
    else if (s === "Comp Off") t.comp_off++;
    else if (s === "Half Day") t.half_day++;      // counts as 0.5 payable day
    else if (s === "On Duty") t.on_duty++;         // official duty elsewhere — fully paid, tracked separately from Present
    else if (s.indexOf("Present") === 0) t.present++;
    else if (paidByType[s] === false) t.unpaid_leave++;
    else t.leave++;
  }
  return employees.map(emp => {
    const t = tallies[emp.id] || { present: 0, absent: 0, weekly_off: 0, comp_off: 0, half_day: 0, on_duty: 0, leave: 0, unpaid_leave: 0 };
    const monthlySalary = Number(emp.monthly_salary) || 0;
    const perDay = dim ? monthlySalary / dim : 0;
    const payable = t.present + t.weekly_off + t.comp_off + t.on_duty + t.leave + t.half_day * 0.5;
    const gross = Math.round(perDay * payable * 100) / 100;
    const stat = computeStatutory(emp, payable, dim, rates);
    const a = adjBy[emp.id] || { arrear: 0, pf_abry_benefit: 0, other_deductions: 0, advance_recovery: 0, salary_on_hold: false, fnf_amount: null };
    const arrear = Number(a.arrear) || 0, otherDed = Number(a.other_deductions) || 0, advRec = Number(a.advance_recovery) || 0;
    const onHold = !!a.salary_on_hold;
    const fnfAmount = a.fnf_amount === null || a.fnf_amount === undefined ? null : Number(a.fnf_amount);
    const netBeforeHold = Math.round((gross + arrear - stat.pf_employee - stat.esi_employee - stat.professional_tax - otherDed - advRec) * 100) / 100;
    const netPay = fnfAmount !== null ? fnfAmount : (onHold ? 0 : netBeforeHold);
    return {
      employee_id: emp.id, employee_name: emp.name, hotel_id: emp.hotel_id,
      designation: emp.role, bank_name: emp.bank_name || "", bank_account_no: emp.bank_account_no || "", ifsc_code: emp.ifsc_code || "",
      monthly_salary: monthlySalary, fixed_basic_salary: Number(emp.fixed_basic_salary) || 0, days_in_month: dim,
      present_days: t.present, absent_days: t.absent, weekly_off_days: t.weekly_off,
      comp_off_days: t.comp_off, half_days: t.half_day, on_duty_days: t.on_duty, leave_days: t.leave, unpaid_leave_days: t.unpaid_leave,
      payable_days: payable, per_day_rate: Math.round(perDay * 100) / 100,
      gross_pay: gross, basic_pay: Math.round(stat.basic_p * 100) / 100, hra_pay: Math.round(stat.hra_p * 100) / 100,
      pf_applicable: !!emp.pf_applicable, esi_applicable: !!emp.esi_applicable,
      pf_employee: stat.pf_employee, pf_employer: stat.pf_employer,
      esi_employee: stat.esi_employee, esi_employer: stat.esi_employer,
      professional_tax: stat.professional_tax,
      arrear, pf_abry_benefit: Number(a.pf_abry_benefit) || 0, other_deductions: otherDed, advance_recovery: advRec,
      salary_on_hold: onHold, fnf_amount: fnfAmount,
      ctc: Math.round(stat.ctc * 100) / 100, net_pay: netPay
    };
  }).sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name)));
}

// Leave balances and comp-off for everyone in scope, as of the end of the
// selected month (or today if that month is still running).
async function computeLeaves(hotelId, month) {
  const employees = await getScopeEmployees(hotelId, month);
  const types = (await pool.query("SELECT name, code, annual_days, paid FROM leave_types ORDER BY name"))
    .rows.map(t => ({ name: t.name, code: t.code, annual_days: Number(t.annual_days), paid: t.paid }));
  const startMonth = Number(await getSetting("leave_year_start_month", "1")) || 1;
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const yearStart = `${m >= startMonth ? y : y - 1}-${pad2(startMonth)}-01`;
  const monthEnd = `${month}-${pad2(daysInMonthOf(month))}`;
  const today = todayIst();
  const endDate = today < monthEnd ? today : monthEnd;
  if (!employees.length) return { leave_types: types, year_start: yearStart, end_date: endDate, records: [] };

  const ctx = await loadAttendanceContext(employees);
  const balRes = await pool.query(
    `SELECT employee_id, leave_type, opening_balance, to_char(as_of,'YYYY-MM-DD') AS as_of
     FROM leave_balances WHERE employee_id = ANY($1)`, [employees.map(e => e.id)]);
  const openBy = {};
  balRes.rows.forEach(b => { (openBy[b.employee_id] ??= {})[b.leave_type] = { balance: Number(b.opening_balance), asOf: b.as_of }; });

  const records = employees.map(emp => {
    const rows = walkEmployee(emp, ctx.forEmployee(emp), yearStart, endDate);
    const opens = openBy[emp.id] || {};
    const balances = {};
    types.forEach(t => { balances[t.name] = leaveBalanceFor(rows, t, opens[t.name] || null, yearStart); });
    return {
      employee_id: emp.id, employee_name: emp.name, hotel_id: emp.hotel_id,
      balances, comp_off: compLedgerFor(rows, opens["Comp Off"] || null)
    };
  });
  return { leave_types: types, year_start: yearStart, end_date: endDate, records };
}


async function findHotelByName(name) {
  if (!name) return null;
  const r = await pool.query("SELECT * FROM hotels WHERE lower(trim(name)) = lower(trim($1))", [name]);
  return r.rows[0] || null;
}

async function findIntegration(hotel_id, device_sn) {
  const r = await pool.query("SELECT * FROM integrations WHERE hotel_id = $1 AND device_sn = $2", [hotel_id, device_sn]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------
// 1. Auth checkpoint route
// IMPORTANT: the frontend checks (role === "Admin") with a capital A.
// ---------------------------------------------------------------------
app.get("/api/auth/me", (req, res) => {
  res.json({ status: "success", user: { id: 1, role: "Admin" } });
});

// ---------------------------------------------------------------------
// 2. Hotel network — must return an ARRAY, the frontend does
//    Array.isArray(data) ? data : (data.records || data.data || [])
// ---------------------------------------------------------------------
app.get("/api/hotels/status", async (req, res) => {
  try {
    const hotelsRes = await pool.query("SELECT * FROM hotels ORDER BY name");
    const employeesCount = await pool.query("SELECT COUNT(*) FROM employees");
    const attendanceCount = await pool.query("SELECT COUNT(*) FROM attendance_logs");
    res.json({
      status: "success",
      records: hotelsRes.rows,
      employees_count: Number(employeesCount.rows[0].count),
      attendance_records: Number(attendanceCount.rows[0].count),
      payroll_records: 0
    });
  } catch (error) {
    console.error("GET /api/hotels/status failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Add a new hotel from the dashboard. Body: { name, code, device_id }.
// code becomes the hotel's id (uppercased, alphanumeric only) — this is
// what gets stored on employees.hotel_id, so it needs to be short and
// unique. device_id can hold a single serial or several comma-separated
// (see Corporate Office, which has two machines) — the webhook already
// splits on comma when matching a punch's device to a hotel.
app.post("/api/hotels", async (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name ? String(body.name).trim() : "";
    const rawCode = body.code ? String(body.code).trim() : "";
    const device_id = body.device_id ? String(body.device_id).split(",").map(x => x.trim()).filter(Boolean).join(",") : "";
    if (!name || !rawCode) {
      return res.status(400).json({ status: "error", message: "name and code are required." });
    }
    const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) {
      return res.status(400).json({ status: "error", message: "code must contain at least one letter or number." });
    }
    const existing = await pool.query("SELECT id FROM hotels WHERE id = $1", [code]);
    if (existing.rows.length) {
      return res.status(409).json({ status: "error", message: `A hotel with code "${code}" already exists.` });
    }
    const r = await pool.query(
      `INSERT INTO hotels (id, name, code, attendance_provider, device_id)
       VALUES ($1, $2, $3, 'Realtime Biometrics', $4)
       RETURNING *`,
      [code, name, code, device_id]
    );
    res.json({ status: "success", hotel: r.rows[0] });
  } catch (error) {
    console.error("POST /api/hotels failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/api/hotels/:hotelId/biometric/:action", async (req, res) => {
  try {
    const { hotelId, action } = req.params;
    const hotelRes = await pool.query("SELECT * FROM hotels WHERE id = $1", [hotelId]);
    if (!hotelRes.rows.length) return res.status(404).json({ status: "error", message: "Hotel not found" });

    if (action === "test") {
      await pool.query("UPDATE hotels SET biometric_status = 'Connected' WHERE id = $1", [hotelId]);
    } else if (action === "sync") {
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      await pool.query("UPDATE hotels SET last_sync = $1 WHERE id = $2", [now, hotelId]);
    } else {
      return res.status(400).json({ status: "error", message: `Unknown action: ${action}` });
    }
    const updated = await pool.query("SELECT * FROM hotels WHERE id = $1", [hotelId]);
    res.json({ status: "success", hotel: updated.rows[0] });
  } catch (error) {
    console.error("POST /api/hotels/:hotelId/biometric/:action failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------------------------------------------------------------------
// 3. Biometric integrations — also must return an ARRAY
// ---------------------------------------------------------------------
app.get("/api/biometric/integrations/status", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM integrations ORDER BY id");
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/biometric/integrations/status failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/api/biometric/integrations/config", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.hotel_id || !body.device_sn || !body.provider_name || !body.endpoint_url) {
      return res.status(400).json({ status: "error", message: "hotel_id, device_sn, provider_name, and endpoint_url are required." });
    }
    const hotelRes = await pool.query("SELECT * FROM hotels WHERE id = $1", [body.hotel_id]);
    const hotel = hotelRes.rows[0];

    // NOTE: credentials (body.credentials) are intentionally NOT stored —
    // there's no column for them. Persist them only in a real secret
    // store, never in a DB column that gets returned to the browser.
    const r = await pool.query(
      `INSERT INTO integrations
        (hotel_id, hotel_name, hotel_code, device_sn, provider_name, timezone, method, auth_type,
         content_type, transport_mode, sync_mode, mapping_mode, endpoint_url, active, parameter_mappings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (hotel_id, device_sn) DO UPDATE SET
         hotel_name = EXCLUDED.hotel_name,
         hotel_code = EXCLUDED.hotel_code,
         provider_name = EXCLUDED.provider_name,
         timezone = EXCLUDED.timezone,
         method = EXCLUDED.method,
         auth_type = EXCLUDED.auth_type,
         content_type = EXCLUDED.content_type,
         transport_mode = EXCLUDED.transport_mode,
         sync_mode = EXCLUDED.sync_mode,
         mapping_mode = EXCLUDED.mapping_mode,
         endpoint_url = EXCLUDED.endpoint_url,
         active = EXCLUDED.active,
         parameter_mappings = EXCLUDED.parameter_mappings
       RETURNING *`,
      [
        body.hotel_id, hotel ? hotel.name : body.hotel_id, hotel ? hotel.code : "",
        body.device_sn, body.provider_name, body.timezone, body.method, body.auth_type,
        body.content_type, body.transport_mode, body.sync_mode, body.mapping_mode,
        body.endpoint_url, body.active !== false, JSON.stringify(body.parameter_mappings || [])
      ]
    );
    res.json({ status: "success", integration: r.rows[0] });
  } catch (error) {
    console.error("POST /api/biometric/integrations/config failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/api/biometric/integrations/test", async (req, res) => {
  try {
    const body = req.body || {};
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await pool.query(
      "UPDATE integrations SET status = 'Connected', last_test = $1 WHERE hotel_id = $2 AND device_sn = $3",
      [now, body.hotel_id, body.device_sn]
    );
    res.json({ status: "Connected", tested_at: now });
  } catch (error) {
    console.error("POST /api/biometric/integrations/test failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/api/biometric/integrations/sync", async (req, res) => {
  try {
    const body = req.body || {};
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await pool.query(
      `UPDATE integrations SET last_sync = $1, records_sent = records_sent + 1, records_received = records_received + 1
       WHERE hotel_id = $2 AND device_sn = $3`,
      [now, body.hotel_id, body.device_sn]
    );
    res.json({ status: "success", synced_at: now });
  } catch (error) {
    console.error("POST /api/biometric/integrations/sync failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Handles both "disable" and "delete" from the dashboard today, because the
// frontend currently sends an identical payload for both actions. Treats
// every call as a disable (soft, reversible). True delete needs a
// frontend change (a new distinct action/body) before the backend can
// tell the two apart.
app.post("/api/biometric/integrations/disconnect", async (req, res) => {
  try {
    const body = req.body || {};
    await pool.query(
      "UPDATE integrations SET active = false, status = 'Not configured' WHERE hotel_id = $1 AND device_sn = $2",
      [body.hotel_id, body.device_sn]
    );
    res.json({ status: "success", active: false });
  } catch (error) {
    console.error("POST /api/biometric/integrations/disconnect failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------------------------------------------------------------------
// 4. The actual device webhook. This is the URL configured in Realtime
//    Biometrics ("Parallel Data Export Setting" -> API URL):
//    https://hrms-biometric-backend-1.onrender.com/api/biometric/attendance
// ---------------------------------------------------------------------
app.post("/api/biometric/attendance", async (req, res) => {
  try {
    const log = req.body || {};
    console.log("Received biometric punch:", log);

    const device_sn = log.device_sn ? String(log.device_sn).trim() : "";
    const code = log.employee_code ? String(log.employee_code).trim() : "";
    const log_datetime = log.log_datetime ? String(log.log_datetime).trim() : "";
    if (!code || !log_datetime) {
      return res.status(400).json({ status: "error", message: "employee_code and log_datetime are required." });
    }

    // The punch is stored as-is. It is matched to an employee later, by the
    // employee's id or device card number, whenever attendance is worked
    // out — so a punch from someone not yet added to HRMS is kept and starts
    // counting the moment they are added. No placeholder employees are made.
    await pool.query(
      `INSERT INTO attendance_logs (employee_code, log_datetime, log_time, downloaded_at, device_sn, source)
       VALUES ($1, $2, $3, $4, $5, 'webhook')
       ON CONFLICT (employee_code, log_datetime, device_sn) DO NOTHING`,
      [code, log_datetime, log.log_time || "", log.downloaded_at || "", device_sn]
    );

    if (device_sn) {
      const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });
      await pool.query(
        `UPDATE hotels SET last_sync = $1, biometric_status = 'Connected'
         WHERE $2 = ANY(string_to_array(replace(device_id, ' ', ''), ','))`, [now, device_sn]);
    }

    return res.status(200).json({ status: "success", message: "Attendance log synchronized successfully." });
  } catch (error) {
    console.error("Error processing attendance webhook:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

// Bulk backfill for historical punches (e.g. exported from Realtime
// Biometrics' raw "Data Download"), same shape as a single live punch,
// just many at once. Duplicate-safe via the same DB constraint the
// webhook uses.
app.post("/api/biometric/attendance/import", async (req, res) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", message: "rows must be a non-empty array." });
    }
    let imported = 0, duplicates = 0, skipped = 0;
    for (const row of rows) {
      const employee_code = row.employee_code && String(row.employee_code).trim();
      const log_datetime = row.log_datetime && String(row.log_datetime).trim();
      if (!employee_code || !log_datetime) { skipped++; continue; }
      const device_sn = row.device_sn ? String(row.device_sn).trim() : "";
      const r = await pool.query(
        `INSERT INTO attendance_logs (employee_code, log_datetime, log_time, downloaded_at, device_sn, source)
         VALUES ($1,$2,$3,$4,$5,'historical_import')
         ON CONFLICT (employee_code, log_datetime, device_sn) DO NOTHING
         RETURNING id`,
        [employee_code, log_datetime, row.log_time || "", row.downloaded_at || "", device_sn]
      );
      if (r.rows.length) imported++; else duplicates++;
    }
    res.json({ status: "success", imported, duplicates, skipped });
  } catch (error) {
    console.error("POST /api/biometric/attendance/import failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Import Realtime Biometrics' "Download Attendance" daily export — one
// row per employee for a single day, with resolved Employee Code, Name,
// Branch, Dept_Name, Desig_Name, In Time, Out-Time. No date column in
// that export, so the date is supplied alongside the rows.
// Body: { date: "YYYY-MM-DD", rows: [{ employee_code, employee_name,
// branch, dept_name, desig_name, in_time, out_time }] }
app.post("/api/attendance/daily-summary/import", async (req, res) => {
  try {
    const date = ymd(req.body && req.body.date);
    const rows = (req.body && req.body.rows) || [];
    if (!date) return res.status(400).json({ status: "error", message: "A valid date (YYYY-MM-DD) is required." });
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", message: "rows must be a non-empty array." });
    }

    let employeesCreated = 0, employeesUpdated = 0, punchesImported = 0, duplicates = 0, unmatchedHotel = 0, skipped = 0;

    for (const row of rows) {
      const employee_code = row.employee_code && String(row.employee_code).trim();
      if (!employee_code) { skipped++; continue; }

      const hotel = await findHotelByName(row.branch);
      if (row.branch && !hotel) unmatchedHotel++;

      const existingRes = await pool.query("SELECT * FROM employees WHERE id = $1", [employee_code]);
      if (existingRes.rows.length) {
        await pool.query(
          `UPDATE employees SET
             name = COALESCE(NULLIF($2, ''), name),
             hotel_id = COALESCE($3, hotel_id),
             role = COALESCE(NULLIF($4, ''), role)
           WHERE id = $1`,
          [employee_code, row.employee_name || "", hotel ? hotel.id : null, row.desig_name || row.dept_name || ""]
        );
        employeesUpdated++;
      } else {
        await pool.query(
          `INSERT INTO employees (id, name, hotel_id, role, status, machine_user_id)
           VALUES ($1,$2,$3,$4,'Active','')`,
          [employee_code, row.employee_name || employee_code, hotel ? hotel.id : "", row.desig_name || row.dept_name || ""]
        );
        employeesCreated++;
      }

      for (const timeValue of [row.in_time, row.out_time]) {
        const t = timeValue && String(timeValue).trim();
        if (!t || t === "00:00") continue;
        const log_datetime = `${date} ${t}:00`;
        const r = await pool.query(
          `INSERT INTO attendance_logs (employee_code, log_datetime, log_time, device_sn, source)
           VALUES ($1,$2,$3,'','daily_summary_import')
           ON CONFLICT (employee_code, log_datetime, device_sn) DO NOTHING
           RETURNING id`,
          [employee_code, log_datetime, t]
        );
        if (r.rows.length) punchesImported++; else duplicates++;
      }
    }

    res.json({
      status: "success",
      date,
      employees_created: employeesCreated,
      employees_updated: employeesUpdated,
      punches_imported: punchesImported,
      duplicates,
      unmatched_hotel_rows: unmatchedHotel,
      skipped
    });
  } catch (error) {
    console.error("POST /api/attendance/daily-summary/import failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------------------------------------------------------------------
// 5. Employees, attendance register, roster, leave, payroll
// ---------------------------------------------------------------------
app.get("/api/employees", async (req, res) => {
  try {
    const r = await pool.query(`SELECT ${EMPLOYEE_COLS} FROM employees ORDER BY id`);
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/employees failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Creates exactly one new employee, entered directly (not from a CSV
// import). Errors if the id already exists, rather than silently
// updating — use PATCH /api/employees/:id to edit an existing one.
// Body: { id, name, hotel_id, role, monthly_salary, date_of_joining,
// machine_user_id }. Only id and name are required.
app.post("/api/employees", async (req, res) => {
  try {
    const body = req.body || {};
    const id = body.id ? String(body.id).trim() : "";
    const name = body.name ? String(body.name).trim() : "";
    if (!id || !name) {
      return res.status(400).json({ status: "error", message: "id and name are required." });
    }
    const existing = await pool.query("SELECT id FROM employees WHERE id = $1", [id]);
    if (existing.rows.length) {
      return res.status(409).json({ status: "error", message: `Employee ${id} already exists. Use edit instead.` });
    }
    const salary = body.monthly_salary !== undefined && !isNaN(Number(body.monthly_salary)) ? Number(body.monthly_salary) : 0;
    const basicSalary = body.fixed_basic_salary !== undefined && !isNaN(Number(body.fixed_basic_salary)) ? Number(body.fixed_basic_salary) : 0;
    const pfApplicable = body.pf_applicable === undefined ? true : !!body.pf_applicable;
    const esiApplicable = body.esi_applicable === undefined ? true : !!body.esi_applicable;
    const doj = ymd(body.date_of_joining);
    const r = await pool.query(
      `INSERT INTO employees (id, name, hotel_id, role, status, machine_user_id, monthly_salary, date_of_joining, property_code,
         fixed_basic_salary, pf_applicable, esi_applicable, bank_name, bank_account_no, ifsc_code)
       VALUES ($1,$2,$3,$4,'Active',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, name, body.hotel_id ? String(body.hotel_id).trim() : "", body.role ? String(body.role).trim() : "",
       body.machine_user_id ? String(body.machine_user_id).trim() : "", salary, doj,
       body.property_code ? String(body.property_code).trim() : "",
       basicSalary, pfApplicable, esiApplicable,
       body.bank_name ? String(body.bank_name).trim() : "", body.bank_account_no ? String(body.bank_account_no).trim() : "",
       body.ifsc_code ? String(body.ifsc_code).trim().toUpperCase() : ""]
    );
    res.json({ status: "success", employee: r.rows[0] });
  } catch (error) {
    console.error("POST /api/employees failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Edits an existing employee's core fields. Any field left out keeps its
// current value. Body: any of { name, hotel_id, role, monthly_salary,
// date_of_joining, machine_user_id, status, property_code, fixed_basic_salary,
// pf_applicable, esi_applicable, bank_name, bank_account_no, ifsc_code }.
// Edits an existing employee's core fields. Any field left out keeps its
// current value. Body: any of { name, hotel_id, role, monthly_salary,
// date_of_joining, machine_user_id, status, property_code, fixed_basic_salary,
// pf_applicable, esi_applicable, bank_name, bank_account_no, ifsc_code,
// last_working_day, exit_reason, exit_note, ffs_amount, ffs_status }.
//
// If monthly_salary (gross salary) is being raised, increment_reason is
// required (e.g. "Promotion", "Annual Increment") — the edit is rejected
// without it. Every actual salary change, up or down, is logged to
// salary_increments for the Increment Report, whether or not a reason was
// required for it.
app.patch("/api/employees/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const existing = await pool.query("SELECT * FROM employees WHERE id = $1", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ status: "error", message: "Employee not found" });
    const current = existing.rows[0];
    const salary = body.monthly_salary !== undefined && !isNaN(Number(body.monthly_salary)) ? Number(body.monthly_salary) : Number(current.monthly_salary);
    const currentSalary = Number(current.monthly_salary);
    if (salary > currentSalary && !(body.increment_reason && String(body.increment_reason).trim())) {
      return res.status(400).json({ status: "error", message: "Please give a reason for the salary increase (e.g. Promotion, Annual Increment)." });
    }
    const basicSalary = body.fixed_basic_salary !== undefined && !isNaN(Number(body.fixed_basic_salary)) ? Number(body.fixed_basic_salary) : current.fixed_basic_salary;
    const pfApplicable = body.pf_applicable !== undefined ? !!body.pf_applicable : current.pf_applicable;
    const esiApplicable = body.esi_applicable !== undefined ? !!body.esi_applicable : current.esi_applicable;
    const doj = body.date_of_joining !== undefined ? ymd(body.date_of_joining) : current.date_of_joining;
    const lwd = body.last_working_day !== undefined ? ymd(body.last_working_day) : current.last_working_day;
    const ffsAmount = body.ffs_amount !== undefined ? (body.ffs_amount === null || body.ffs_amount === "" ? null : Number(body.ffs_amount)) : current.ffs_amount;
    const r = await pool.query(
      `UPDATE employees SET name=$2, hotel_id=$3, role=$4, machine_user_id=$5, monthly_salary=$6, date_of_joining=$7, status=$8, property_code=$9,
         fixed_basic_salary=$10, pf_applicable=$11, esi_applicable=$12, bank_name=$13, bank_account_no=$14, ifsc_code=$15,
         last_working_day=$16, exit_reason=$17, exit_note=$18, ffs_amount=$19, ffs_status=$20
       WHERE id=$1 RETURNING *`,
      [
        req.params.id,
        body.name !== undefined ? String(body.name).trim() : current.name,
        body.hotel_id !== undefined ? String(body.hotel_id).trim() : current.hotel_id,
        body.role !== undefined ? String(body.role).trim() : current.role,
        body.machine_user_id !== undefined ? String(body.machine_user_id).trim() : current.machine_user_id,
        salary, doj,
        body.status !== undefined ? String(body.status).trim() : current.status,
        body.property_code !== undefined ? String(body.property_code).trim() : current.property_code,
        basicSalary, pfApplicable, esiApplicable,
        body.bank_name !== undefined ? String(body.bank_name).trim() : current.bank_name,
        body.bank_account_no !== undefined ? String(body.bank_account_no).trim() : current.bank_account_no,
        body.ifsc_code !== undefined ? String(body.ifsc_code).trim().toUpperCase() : current.ifsc_code,
        lwd,
        body.exit_reason !== undefined ? String(body.exit_reason).trim() : current.exit_reason,
        body.exit_note !== undefined ? String(body.exit_note).trim() : current.exit_note,
        ffsAmount,
        body.ffs_status !== undefined ? String(body.ffs_status).trim() : current.ffs_status
      ]
    );
    if (salary !== currentSalary) {
      await pool.query(
        `INSERT INTO salary_increments (employee_id, old_salary, new_salary, reason, note) VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, currentSalary, salary,
         body.increment_reason ? String(body.increment_reason).trim() : (salary > currentSalary ? "" : "Salary revised"),
         body.increment_note ? String(body.increment_note).trim() : ""]
      );
    }
    res.json({ status: "success", employee: r.rows[0] });
  } catch (error) {
    console.error("PATCH /api/employees/:id failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Marks an employee as exited: last working day (required), a reason
// (required), an optional note, and optional full & final settlement
// amount/status. From this point the engine stops generating attendance,
// roster, leave or payroll rows for them past their last working day, so
// they naturally drop out of future months without being deleted.
app.post("/api/employees/:id/exit", async (req, res) => {
  try {
    const body = req.body || {};
    const lwd = ymd(body.last_working_day);
    const reason = body.exit_reason ? String(body.exit_reason).trim() : "";
    if (!lwd) return res.status(400).json({ status: "error", message: "last_working_day (a valid date) is required." });
    if (!reason) return res.status(400).json({ status: "error", message: "exit_reason is required." });
    const existing = await pool.query("SELECT id FROM employees WHERE id = $1", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ status: "error", message: "Employee not found" });
    const ffsAmount = body.ffs_amount === undefined || body.ffs_amount === null || body.ffs_amount === "" ? null : Number(body.ffs_amount);
    const r = await pool.query(
      `UPDATE employees SET status = 'Exited', last_working_day = $2, exit_reason = $3, exit_note = $4, ffs_amount = $5, ffs_status = $6
       WHERE id = $1 RETURNING *`,
      [req.params.id, lwd, reason, body.exit_note ? String(body.exit_note).trim() : "", ffsAmount, body.ffs_status ? String(body.ffs_status).trim() : "Pending"]
    );
    res.json({ status: "success", employee: r.rows[0] });
  } catch (error) {
    console.error("POST /api/employees/:id/exit failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Undoes an exit — sets the employee back to Active and clears their exit
// details, for when one was marked by mistake.
app.post("/api/employees/:id/reactivate", async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE employees SET status = 'Active', last_working_day = NULL, exit_reason = '', exit_note = '', ffs_amount = NULL, ffs_status = ''
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ status: "error", message: "Employee not found" });
    res.json({ status: "success", employee: r.rows[0] });
  } catch (error) {
    console.error("POST /api/employees/:id/reactivate failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Every salary change on record, newest first — the Increment Report.
app.get("/api/increments", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT si.id, si.employee_id, e.name AS employee_name, e.hotel_id,
             si.old_salary, si.new_salary, si.reason, si.note,
             to_char(si.changed_at, 'YYYY-MM-DD HH24:MI') AS changed_at
      FROM salary_increments si
      LEFT JOIN employees e ON e.id = si.employee_id
      ORDER BY si.changed_at DESC
      LIMIT 1000
    `);
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/increments failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Deletes every employee record. Requires { confirm: true } in the body
// as a guard against accidental calls. Attendance logs, duty roster
// entries, and overrides are left untouched — they'll just stop matching
// anyone until new employee records exist again (the webhook will
// auto-recreate placeholder employees the next time a punch comes in).
app.delete("/api/employees", async (req, res) => {
  try {
    const confirm = req.body && req.body.confirm === true;
    if (!confirm) {
      return res.status(400).json({ status: "error", message: "Pass { confirm: true } to delete all employees. This cannot be undone." });
    }
    const r = await pool.query("DELETE FROM employees");
    res.json({ status: "success", deleted: r.rowCount });
  } catch (error) {
    console.error("DELETE /api/employees failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Bulk import/update employees — built to accept rows shaped like the
// Realtime Biometrics employee export (EmpName, Cardno, EmpCode,
// Dept_Name, Desig_Name, Branch), but works with any rows using these
// field names. Upserts by employee_id.
app.post("/api/employees/import", async (req, res) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", message: "rows must be a non-empty array." });
    }
    const hotelLookup = new Map();
    (await pool.query("SELECT id, name FROM hotels")).rows.forEach(h => {
      hotelLookup.set(String(h.id).toLowerCase(), h.id);
      hotelLookup.set(String(h.name).trim().toLowerCase(), h.id);
    });
    let created = 0, updated = 0, skipped = 0;
    for (const row of rows) {
      const employee_id = row.employee_id && String(row.employee_id).trim();
      if (!employee_id) { skipped++; continue; }
      const salary = row.monthly_salary !== undefined && row.monthly_salary !== "" && !isNaN(Number(row.monthly_salary))
        ? Number(row.monthly_salary) : null;
      const basicSalary = row.fixed_basic_salary !== undefined && row.fixed_basic_salary !== "" && !isNaN(Number(row.fixed_basic_salary))
        ? Number(row.fixed_basic_salary) : null;
      const pfApplicable = row.pf_applicable === undefined || row.pf_applicable === "" ? null : !/^(n|no|false|0)$/i.test(String(row.pf_applicable).trim());
      const esiApplicable = row.esi_applicable === undefined || row.esi_applicable === "" ? null : !/^(n|no|false|0)$/i.test(String(row.esi_applicable).trim());
      const doj = row.date_of_joining ? ymd(row.date_of_joining) : null;
      // The CSV's Branch column holds a hotel *name*, but employees.hotel_id
      // stores the hotel's id ("HAAC"). Accept either.
      let resolvedHotelId = row.hotel_id ? String(row.hotel_id).trim() : "";
      if (resolvedHotelId) {
        resolvedHotelId = hotelLookup.get(resolvedHotelId.toLowerCase()) || resolvedHotelId;
      }
      const existingRes = await pool.query("SELECT * FROM employees WHERE id = $1", [employee_id]);
      if (existingRes.rows.length) {
        await pool.query(
          `UPDATE employees SET
             name = COALESCE(NULLIF($2, ''), name),
             machine_user_id = COALESCE(NULLIF($3, ''), machine_user_id),
             hotel_id = COALESCE(NULLIF($4, ''), hotel_id),
             role = COALESCE(NULLIF($5, ''), role),
             status = COALESCE(NULLIF($6, ''), status),
             monthly_salary = COALESCE($7, monthly_salary),
             date_of_joining = COALESCE($8, date_of_joining),
             property_code = COALESCE(NULLIF($9, ''), property_code),
             fixed_basic_salary = COALESCE($10, fixed_basic_salary),
             pf_applicable = COALESCE($11, pf_applicable),
             esi_applicable = COALESCE($12, esi_applicable),
             bank_name = COALESCE(NULLIF($13, ''), bank_name),
             bank_account_no = COALESCE(NULLIF($14, ''), bank_account_no),
             ifsc_code = COALESCE(NULLIF($15, ''), ifsc_code)
           WHERE id = $1`,
          [employee_id, row.name || "", row.machine_user_id || "", resolvedHotelId, row.role || "", row.status || "", salary, doj, row.property_code || "",
           basicSalary, pfApplicable, esiApplicable, row.bank_name || "", row.bank_account_no || "", (row.ifsc_code || "").toUpperCase()]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO employees (id, name, hotel_id, role, status, machine_user_id, monthly_salary, date_of_joining, property_code,
             fixed_basic_salary, pf_applicable, esi_applicable, bank_name, bank_account_no, ifsc_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [employee_id, row.name || "", resolvedHotelId, row.role || "", row.status || "Active", row.machine_user_id || "", salary || 0, doj, row.property_code || "",
           basicSalary || 0, pfApplicable === null ? true : pfApplicable, esiApplicable === null ? true : esiApplicable,
           row.bank_name || "", row.bank_account_no || "", (row.ifsc_code || "").toUpperCase()]
        );
        created++;
      }
    }
    const total = await pool.query("SELECT COUNT(*) FROM employees");
    res.json({ status: "success", created, updated, skipped, total_employees: Number(total.rows[0].count) });
  } catch (error) {
    console.error("POST /api/employees/import failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Set or update one employee's biometric machine User ID / Card No.
app.post("/api/employees/:id/mapping", async (req, res) => {
  try {
    const machineUserId = req.body && req.body.machine_user_id ? String(req.body.machine_user_id).trim() : "";
    if (!machineUserId) return res.status(400).json({ status: "error", message: "machine_user_id is required" });
    const r = await pool.query(
      "UPDATE employees SET machine_user_id = $1 WHERE id = $2 RETURNING *",
      [machineUserId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ status: "error", message: "Employee not found" });
    res.json({ status: "success", employee: r.rows[0] });
  } catch (error) {
    console.error("POST /api/employees/:id/mapping failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Set or update one employee's monthly salary, used by the Payroll tab's
// quick inline editor. Same rule as PATCH: raising it needs increment_reason,
// and every change (either direction) is logged for the Increment Report.
app.post("/api/employees/:id/salary", async (req, res) => {
  try {
    const raw = req.body && req.body.monthly_salary;
    const salary = Number(raw);
    if (raw === undefined || raw === null || isNaN(salary) || salary < 0) {
      return res.status(400).json({ status: "error", message: "monthly_salary must be a non-negative number." });
    }
    const existing = await pool.query("SELECT monthly_salary FROM employees WHERE id = $1", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ status: "error", message: "Employee not found" });
    const currentSalary = Number(existing.rows[0].monthly_salary);
    const reason = req.body && req.body.increment_reason ? String(req.body.increment_reason).trim() : "";
    if (salary > currentSalary && !reason) {
      return res.status(400).json({ status: "error", message: "Please give a reason for the salary increase (e.g. Promotion, Annual Increment)." });
    }
    const r = await pool.query(
      "UPDATE employees SET monthly_salary = $1 WHERE id = $2 RETURNING *",
      [salary, req.params.id]
    );
    if (salary !== currentSalary) {
      await pool.query(
        `INSERT INTO salary_increments (employee_id, old_salary, new_salary, reason) VALUES ($1,$2,$3,$4)`,
        [req.params.id, currentSalary, salary, reason || "Salary revised"]
      );
    }
    res.json({ status: "success", employee: r.rows[0] });
  } catch (error) {
    console.error("POST /api/employees/:id/salary failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Punches whose employee_code doesn't match any employee — real device
// punches that can't be attributed to anyone yet. With the webhook's
// auto-create behavior above, this should normally be empty; it mainly
// catches anything imported before an employee existed.
app.get("/api/biometric/unmapped-punches", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT al.* FROM attendance_logs al
      WHERE NOT EXISTS (
        SELECT 1 FROM employees e WHERE e.id = al.employee_code OR e.machine_user_id = al.employee_code
      )
    `);
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/biometric/unmapped-punches failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Query params: hotel_id ("all" or a specific id), month ("YYYY-MM").
app.get("/api/attendance", async (req, res) => {
  try {
    const hotelId = req.query.hotel_id || "all";
    const month = req.query.month || todayIst().slice(0, 7);
    const records = await computeAttendance(hotelId, month);
    res.json({ status: "success", month, hotel_id: hotelId, records });
  } catch (error) {
    console.error("GET /api/attendance failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Manually set (or clear) one employee's status for one day, overriding
// whatever the automatic punch/roster logic would compute for that day.
// Body: { employee_id, date, status }. Pass an empty/missing status to
// clear the override and revert that day back to the computed value.
app.post("/api/attendance/override", async (req, res) => {
  try {
    const body = req.body || {};
    const employee_id = body.employee_id ? String(body.employee_id).trim() : "";
    const date = ymd(body.date);
    const status = body.status ? String(body.status).trim() : "";
    if (!employee_id || !date) {
      return res.status(400).json({ status: "error", message: "employee_id and a valid date are required." });
    }
    if (!status) {
      await pool.query("DELETE FROM attendance_overrides WHERE employee_id = $1 AND date = $2", [employee_id, date]);
      return res.json({ status: "success", cleared: true });
    }
    await pool.query(
      `INSERT INTO attendance_overrides (employee_id, date, status) VALUES ($1,$2,$3)
       ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status`,
      [employee_id, date, status]
    );
    res.json({ status: "success", cleared: false });
  } catch (error) {
    console.error("POST /api/attendance/override failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Upload duty roster rows. Body: { rows: [{ employee_id, date, type }] }.
// A row with a blank type CLEARS that employee's roster entry for that date,
// so re-uploading a corrected sheet makes the roster match the sheet exactly
// for the dates it covers. Done in batches, since a month for a whole hotel
// is thousands of rows.
app.post("/api/duty-roster", async (req, res) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", message: "rows must be a non-empty array of { employee_id, date, type }." });
    }
    const upserts = [], clears = [];
    let skipped = 0;
    for (const row of rows) {
      const employee_id = row.employee_id ? String(row.employee_id).trim() : "";
      const date = ymd(row.date);
      const type = row.type ? String(row.type).trim() : "";
      if (!employee_id || !date) { skipped++; continue; }
      (type ? upserts : clears).push([employee_id, date, type]);
    }
    const BATCH = 2000;
    for (let i = 0; i < upserts.length; i += BATCH) {
      const part = upserts.slice(i, i + BATCH);
      await pool.query(
        `INSERT INTO duty_roster (employee_id, date, type)
         SELECT * FROM unnest($1::text[], $2::date[], $3::text[])
         ON CONFLICT (employee_id, date) DO UPDATE SET type = EXCLUDED.type`,
        [part.map(p => p[0]), part.map(p => p[1]), part.map(p => p[2])]);
    }
    for (let i = 0; i < clears.length; i += BATCH) {
      const part = clears.slice(i, i + BATCH);
      await pool.query(
        `DELETE FROM duty_roster d USING unnest($1::text[], $2::date[]) AS t(employee_id, date)
         WHERE d.employee_id = t.employee_id AND d.date = t.date`,
        [part.map(p => p[0]), part.map(p => p[1])]);
    }
    res.json({ status: "success", applied: upserts.length, cleared: clears.length, skipped });
  } catch (error) {
    console.error("POST /api/duty-roster failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/api/duty-roster", async (req, res) => {
  try {
    const hotelId = req.query.hotel_id || "all";
    const month = req.query.month;
    let query = `SELECT dr.employee_id, to_char(dr.date, 'YYYY-MM-DD') AS date, dr.type
                 FROM duty_roster dr JOIN employees e ON e.id = dr.employee_id WHERE 1=1`;
    const params = [];
    if (hotelId !== "all") { params.push(hotelId); query += ` AND e.hotel_id = $${params.length}`; }
    if (month) { params.push(`${month}%`); query += ` AND to_char(dr.date,'YYYY-MM-DD') LIKE $${params.length}`; }
    const r = await pool.query(query, params);
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/duty-roster failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Query params: hotel_id ("all" or a specific id), month ("YYYY-MM").
app.get("/api/payroll", async (req, res) => {
  try {
    const hotelId = req.query.hotel_id || "all";
    const month = req.query.month || todayIst().slice(0, 7);
    const records = await computePayroll(hotelId, month);
    res.json({ status: "success", month, hotel_id: hotelId, records });
  } catch (error) {
    console.error("GET /api/payroll failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------------------------------------------------------------------
// Leaves: policy, opening balances, and live balances
// ---------------------------------------------------------------------
app.get("/api/leave-policy", async (req, res) => {
  try {
    const types = await pool.query("SELECT name, code, annual_days, paid FROM leave_types ORDER BY name");
    const startMonth = Number(await getSetting("leave_year_start_month", "1")) || 1;
    res.json({
      status: "success",
      leave_year_start_month: startMonth,
      records: types.rows.map(t => ({ name: t.name, code: t.code, annual_days: Number(t.annual_days), paid: t.paid }))
    });
  } catch (error) {
    console.error("GET /api/leave-policy failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Body: { rows?: [{ leave_type, code, annual_days, paid }], leave_year_start_month?: 1-12 }
// When rows are sent they REPLACE the whole policy (the upload is the policy).
app.post("/api/leave-policy", async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (body.leave_year_start_month !== undefined) {
      const mth = Number(body.leave_year_start_month);
      if (!Number.isInteger(mth) || mth < 1 || mth > 12) {
        return res.status(400).json({ status: "error", message: "leave_year_start_month must be 1-12." });
      }
      await setSetting("leave_year_start_month", mth);
    }
    let saved = 0;
    if (rows && rows.length) {
      const clean = [], seen = new Set();
      for (const r of rows) {
        const name = r.leave_type ? String(r.leave_type).trim() : "";
        if (!name) continue;
        if (RESERVED_STATUSES.includes(name.toLowerCase())) {
          return res.status(400).json({ status: "error", message: `"${name}" is a built-in attendance status and can't be used as a leave type. (Comp Off is handled automatically.)` });
        }
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        const days = Number(r.annual_days);
        if (isNaN(days) || days < 0) {
          return res.status(400).json({ status: "error", message: `Annual days for "${name}" must be a number, 0 or more.` });
        }
        const paidRaw = r.paid === undefined || r.paid === null ? "yes" : String(r.paid).trim().toLowerCase();
        const paid = !/^(n|no|false|0|unpaid)$/.test(paidRaw);
        const code = r.code && String(r.code).trim() ? String(r.code).trim().toUpperCase()
          : name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
        clean.push([name, code, days, paid]);
      }
      if (!clean.length) return res.status(400).json({ status: "error", message: "No valid leave types found in the upload." });
      await client.query("BEGIN");
      await client.query("DELETE FROM leave_types");
      for (const [name, code, days, paid] of clean) {
        await client.query("INSERT INTO leave_types (name, code, annual_days, paid) VALUES ($1,$2,$3,$4)", [name, code, days, paid]);
      }
      await client.query("COMMIT");
      saved = clean.length;
    }
    res.json({ status: "success", saved });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("POST /api/leave-policy failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  } finally {
    client.release();
  }
});

// Opening leave balances from the old spreadsheet.
// Body: { as_of: "YYYY-MM-DD", rows: [{ employee_id, leave_type, balance }] }
// Balances count from the START of as_of: leaves taken on or after that date
// are deducted automatically. leave_type may be a policy leave name, its code,
// or "Comp Off".
app.post("/api/leave-balances/import", async (req, res) => {
  try {
    const as_of = ymd(req.body && req.body.as_of);
    const rows = (req.body && req.body.rows) || [];
    if (!as_of) return res.status(400).json({ status: "error", message: "as_of date (YYYY-MM-DD) is required." });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ status: "error", message: "rows must be a non-empty array." });

    const typeLookup = new Map();
    (await pool.query("SELECT name, code FROM leave_types")).rows.forEach(t => {
      typeLookup.set(t.name.toLowerCase(), t.name);
      if (t.code) typeLookup.set(String(t.code).toLowerCase(), t.name);
    });
    ["comp off", "compoff", "comp-off", "co"].forEach(k => typeLookup.set(k, "Comp Off"));
    const empIds = new Set((await pool.query("SELECT id FROM employees")).rows.map(r => r.id));

    const good = [], unknownEmployees = new Set(), unknownTypes = new Set();
    let skipped = 0;
    for (const r of rows) {
      const employee_id = r.employee_id ? String(r.employee_id).trim() : "";
      const type = typeLookup.get(String(r.leave_type || "").trim().toLowerCase());
      const balance = Number(String(r.balance ?? "").replace(/,/g, ""));
      if (!employee_id || r.balance === "" || r.balance === undefined || isNaN(balance)) { skipped++; continue; }
      if (!empIds.has(employee_id)) { unknownEmployees.add(employee_id); continue; }
      if (!type) { unknownTypes.add(String(r.leave_type)); continue; }
      good.push([employee_id, type, balance]);
    }
    const BATCH = 2000;
    for (let i = 0; i < good.length; i += BATCH) {
      const part = good.slice(i, i + BATCH);
      await pool.query(
        `INSERT INTO leave_balances (employee_id, leave_type, opening_balance, as_of)
         SELECT e, t, b, $4::date FROM unnest($1::text[], $2::text[], $3::numeric[]) AS x(e, t, b)
         ON CONFLICT (employee_id, leave_type) DO UPDATE
           SET opening_balance = EXCLUDED.opening_balance, as_of = EXCLUDED.as_of`,
        [part.map(p => p[0]), part.map(p => p[1]), part.map(p => p[2]), as_of]);
    }
    res.json({
      status: "success", applied: good.length, skipped,
      unknown_employees: Array.from(unknownEmployees).slice(0, 30), unknown_employee_count: unknownEmployees.size,
      unknown_leave_types: Array.from(unknownTypes).slice(0, 10)
    });
  } catch (error) {
    console.error("POST /api/leave-balances/import failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Query params: hotel_id ("all" or a specific id), month ("YYYY-MM").
app.get("/api/leaves", async (req, res) => {
  try {
    const hotelId = req.query.hotel_id || "all";
    const month = req.query.month || todayIst().slice(0, 7);
    const result = await computeLeaves(hotelId, month);
    res.json({ status: "success", month, hotel_id: hotelId, ...result });
  } catch (error) {
    console.error("GET /api/leaves failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------------------------------------------------------------------
// Employee self-service: login, password, attendance, leave requests,
// regularization requests, payslip data. Every /api/self/* route below
// (other than login) requires a valid token from that login.
// ---------------------------------------------------------------------

// Small, dependency-free password hashing (Node's built-in scrypt) and
// signed tokens (HMAC), so this doesn't add any new npm package to the
// build — nothing that could fail to install on Render.
const TOKEN_SECRET = process.env.EMPLOYEE_TOKEN_SECRET || process.env.BIOMETRIC_WEBHOOK_SECRET || "voyage-hrms-dev-secret";
const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — a phone shouldn't need to re-login often

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  // Fixed-time comparison so response timing can't leak how much of the
  // password was correct.
  const a = Buffer.from(check, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_LIFETIME_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
// Attaches req.employeeId from the Authorization: Bearer <token> header,
// or rejects the request with 401 if it's missing, malformed, or expired.
async function requireEmployeeAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload || !payload.employee_id) {
    return res.status(401).json({ status: "error", message: "Please log in again." });
  }
  const r = await pool.query(`SELECT ${EMPLOYEE_COLS} FROM employees WHERE id = $1`, [payload.employee_id]);
  if (!r.rows.length) return res.status(401).json({ status: "error", message: "Please log in again." });
  req.employee = r.rows[0];
  next();
}

// Employee ID is the username. On someone's very first login there's no
// password_hash yet, so the shared "first login" password (set by HR,
// stored in settings) is accepted instead — but the response always says
// must_reset: true in that case, and the employee portal is built to force
// a password change before anything else is usable.
app.post("/api/self/login", async (req, res) => {
  try {
    const id = req.body && req.body.employee_id ? String(req.body.employee_id).trim() : "";
    const password = req.body && req.body.password ? String(req.body.password) : "";
    if (!id || !password) return res.status(400).json({ status: "error", message: "Employee ID and password are required." });
    // A deliberately separate, narrower query from EMPLOYEE_COLS: this is
    // the one place that needs password_hash/password_salt/must_reset_password,
    // and EMPLOYEE_COLS must never include them — it's reused to build the
    // JSON the admin dashboard's Employees tab receives, so adding auth
    // secrets there would leak every password hash to the browser.
    const r = await pool.query(
      "SELECT id, name, hotel_id, role, status, must_reset_password, password_hash, password_salt FROM employees WHERE id = $1",
      [id]
    );
    if (!r.rows.length) return res.status(401).json({ status: "error", message: "Employee ID or password is incorrect." });
    const emp = r.rows[0];
    if (emp.status === "Exited") return res.status(403).json({ status: "error", message: "This account is no longer active." });
    let ok;
    if (emp.must_reset_password) {
      const defaultPassword = await getSetting("default_employee_password", "Welcome@123");
      ok = password === defaultPassword;
    } else {
      ok = verifyPassword(password, emp.password_hash, emp.password_salt);
    }
    if (!ok) return res.status(401).json({ status: "error", message: "Employee ID or password is incorrect." });
    const token = signToken({ employee_id: emp.id });
    res.json({ status: "success", token, must_reset_password: !!emp.must_reset_password,
      employee: { id: emp.id, name: emp.name, hotel_id: emp.hotel_id, role: emp.role } });
  } catch (error) {
    console.error("POST /api/self/login failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Sets a new password and clears must_reset_password. Called immediately
// after first login (forced by the employee portal before anything else
// is usable), and also available any time after as "change password."
app.post("/api/self/set-password", requireEmployeeAuth, async (req, res) => {
  try {
    const pw = req.body && req.body.new_password ? String(req.body.new_password) : "";
    if (pw.length < 6) return res.status(400).json({ status: "error", message: "Password must be at least 6 characters." });
    const { hash, salt } = hashPassword(pw);
    await pool.query("UPDATE employees SET password_hash = $1, password_salt = $2, must_reset_password = false WHERE id = $3",
      [hash, salt, req.employee.id]);
    res.json({ status: "success" });
  } catch (error) {
    console.error("POST /api/self/set-password failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/api/self/me", requireEmployeeAuth, async (req, res) => {
  const emp = req.employee;
  const hotel = (await pool.query("SELECT name FROM hotels WHERE id = $1", [emp.hotel_id])).rows[0];
  res.json({ status: "success", employee: { id: emp.id, name: emp.name, role: emp.role, hotel_id: emp.hotel_id,
    hotel_name: hotel ? hotel.name : "", date_of_joining: emp.date_of_joining } });
});

// Query param: month ("YYYY-MM"). Reuses the exact same engine the admin
// dashboard uses, so an employee always sees the identical numbers HR does.
app.get("/api/self/attendance", requireEmployeeAuth, async (req, res) => {
  try {
    const month = req.query.month || todayIst().slice(0, 7);
    const all = await computeAttendance(req.employee.hotel_id, month);
    res.json({ status: "success", month, records: all.filter(r => r.employee_id === req.employee.id) });
  } catch (error) {
    console.error("GET /api/self/attendance failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Query param: month ("YYYY-MM"). Same balances the Leaves tab shows.
app.get("/api/self/leaves", requireEmployeeAuth, async (req, res) => {
  try {
    const month = req.query.month || todayIst().slice(0, 7);
    const result = await computeLeaves(req.employee.hotel_id, month);
    const mine = result.records.find(r => r.employee_id === req.employee.id) || { balances: {}, comp_off: null };
    res.json({ status: "success", month, leave_types: result.leave_types, balances: mine.balances, comp_off: mine.comp_off });
  } catch (error) {
    console.error("GET /api/self/leaves failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Query param: month ("YYYY-MM"). Same figures the Payroll tab computes.
app.get("/api/self/payslip", requireEmployeeAuth, async (req, res) => {
  try {
    const month = req.query.month || todayIst().slice(0, 7);
    const all = await computePayroll(req.employee.hotel_id, month);
    const mine = all.find(r => r.employee_id === req.employee.id);
    if (!mine) return res.status(404).json({ status: "error", message: "No payroll data for that month yet." });
    res.json({ status: "success", month, payslip: mine });
  } catch (error) {
    console.error("GET /api/self/payslip failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Submits a leave request. Doesn't touch attendance — sits as Pending
// until HR approves it from the main dashboard.
app.post("/api/self/leave-requests", requireEmployeeAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const leaveType = body.leave_type ? String(body.leave_type).trim() : "";
    const start = ymd(body.start_date), end = ymd(body.end_date);
    const reason = body.reason ? String(body.reason).trim() : "";
    if (!leaveType || !start || !end) return res.status(400).json({ status: "error", message: "Leave type, start date and end date are required." });
    if (end < start) return res.status(400).json({ status: "error", message: "End date can't be before the start date." });
    const validType = leaveType === "Comp Off" || (await pool.query("SELECT 1 FROM leave_types WHERE name = $1", [leaveType])).rows.length;
    if (!validType) return res.status(400).json({ status: "error", message: `"${leaveType}" isn't a recognised leave type.` });
    const r = await pool.query(
      `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.employee.id, leaveType, start, end, reason]
    );
    res.json({ status: "success", request: r.rows[0] });
  } catch (error) {
    console.error("POST /api/self/leave-requests failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/api/self/leave-requests", requireEmployeeAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM leave_requests WHERE employee_id = $1 ORDER BY requested_at DESC", [req.employee.id]);
  res.json({ status: "success", records: r.rows });
});

// Submits a regularization request for one day (typically a missed punch).
// requested_status defaults to "Present" — what approving it will set the
// day to — but an employee can ask for a different status if that fits
// better (e.g. they were actually on leave and forgot to mark it).
app.post("/api/self/regularization", requireEmployeeAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const date = ymd(body.date);
    const reason = body.reason ? String(body.reason).trim() : "";
    const requestedStatus = body.requested_status ? String(body.requested_status).trim() : "Present";
    if (!date) return res.status(400).json({ status: "error", message: "A date is required." });
    if (!reason) return res.status(400).json({ status: "error", message: "Please give a reason." });
    const r = await pool.query(
      `INSERT INTO regularization_requests (employee_id, date, reason, requested_status) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.employee.id, date, reason, requestedStatus]
    );
    res.json({ status: "success", request: r.rows[0] });
  } catch (error) {
    console.error("POST /api/self/regularization failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/api/self/regularization", requireEmployeeAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM regularization_requests WHERE employee_id = $1 ORDER BY requested_at DESC", [req.employee.id]);
  res.json({ status: "success", records: r.rows });
});

// ---------------------------------------------------------------------
// HR/admin side of the above: the approval queue, and account controls.
// ---------------------------------------------------------------------

// Query param: status ("Pending" by default, or "all"). Joins in the
// employee's name/hotel so the approval queue doesn't need a second call.
app.get("/api/leave-requests", async (req, res) => {
  try {
    const status = req.query.status || "Pending";
    const where = status === "all" ? "" : "WHERE lr.status = $1";
    const params = status === "all" ? [] : [status];
    const r = await pool.query(
      `SELECT lr.*, e.name AS employee_name, e.hotel_id FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id ${where} ORDER BY lr.requested_at DESC`, params);
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/leave-requests failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Body: { decision: "Approved" | "Rejected", note }. Approving writes an
// attendance_overrides row for every date in the request's range.
app.post("/api/leave-requests/:id/decide", async (req, res) => {
  try {
    const decision = req.body && req.body.decision;
    if (!["Approved", "Rejected"].includes(decision)) return res.status(400).json({ status: "error", message: "decision must be Approved or Rejected." });
    const existing = await pool.query("SELECT * FROM leave_requests WHERE id = $1", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ status: "error", message: "Request not found." });
    const lr = existing.rows[0];
    if (lr.status !== "Pending") return res.status(409).json({ status: "error", message: `This request was already ${lr.status.toLowerCase()}.` });
    if (decision === "Approved") {
      const dates = [];
      eachDate(ymd(lr.start_date), ymd(lr.end_date), d => dates.push(d));
      for (const date of dates) {
        await pool.query(
          `INSERT INTO attendance_overrides (employee_id, date, status) VALUES ($1,$2,$3)
           ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status`,
          [lr.employee_id, date, lr.leave_type]
        );
      }
    }
    const r = await pool.query(
      "UPDATE leave_requests SET status = $2, decided_at = now(), decision_note = $3 WHERE id = $1 RETURNING *",
      [req.params.id, decision, req.body.note ? String(req.body.note).trim() : ""]
    );
    res.json({ status: "success", request: r.rows[0] });
  } catch (error) {
    console.error("POST /api/leave-requests/:id/decide failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/api/regularization-requests", async (req, res) => {
  try {
    const status = req.query.status || "Pending";
    const where = status === "all" ? "" : "WHERE rr.status = $1";
    const params = status === "all" ? [] : [status];
    const r = await pool.query(
      `SELECT rr.*, e.name AS employee_name, e.hotel_id FROM regularization_requests rr
       JOIN employees e ON e.id = rr.employee_id ${where} ORDER BY rr.requested_at DESC`, params);
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/regularization-requests failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Body: { decision: "Approved" | "Rejected", note, status_to_apply }.
// status_to_apply lets HR override what the employee originally asked for
// (defaults to whatever they requested). Approving writes one
// attendance_overrides row for that single date.
app.post("/api/regularization-requests/:id/decide", async (req, res) => {
  try {
    const decision = req.body && req.body.decision;
    if (!["Approved", "Rejected"].includes(decision)) return res.status(400).json({ status: "error", message: "decision must be Approved or Rejected." });
    const existing = await pool.query("SELECT * FROM regularization_requests WHERE id = $1", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ status: "error", message: "Request not found." });
    const rr = existing.rows[0];
    if (rr.status !== "Pending") return res.status(409).json({ status: "error", message: `This request was already ${rr.status.toLowerCase()}.` });
    if (decision === "Approved") {
      const statusToApply = req.body.status_to_apply ? String(req.body.status_to_apply).trim() : rr.requested_status;
      await pool.query(
        `INSERT INTO attendance_overrides (employee_id, date, status) VALUES ($1,$2,$3)
         ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status`,
        [rr.employee_id, ymd(rr.date), statusToApply]
      );
    }
    const r = await pool.query(
      "UPDATE regularization_requests SET status = $2, decided_at = now(), decision_note = $3 WHERE id = $1 RETURNING *",
      [req.params.id, decision, req.body.note ? String(req.body.note).trim() : ""]
    );
    res.json({ status: "success", request: r.rows[0] });
  } catch (error) {
    console.error("POST /api/regularization-requests/:id/decide failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// HR resetting someone's password (they forgot it, or it's a new hire who
// needs to log in again with the shared first-login password).
app.post("/api/employees/:id/reset-password", async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE employees SET password_hash = '', password_salt = '', must_reset_password = true WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ status: "error", message: "Employee not found." });
    res.json({ status: "success" });
  } catch (error) {
    console.error("POST /api/employees/:id/reset-password failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// The one shared password every new employee (or anyone HR has reset)
// logs in with the first time, before being forced to set their own.
app.get("/api/settings/default-password", async (req, res) => {
  res.json({ status: "success", default_employee_password: await getSetting("default_employee_password", "Welcome@123") });
});
app.post("/api/settings/default-password", async (req, res) => {
  const pw = req.body && req.body.default_employee_password ? String(req.body.default_employee_password).trim() : "";
  if (pw.length < 6) return res.status(400).json({ status: "error", message: "Password must be at least 6 characters." });
  await setSetting("default_employee_password", pw);
  res.json({ status: "success" });
});

// ---------------------------------------------------------------------
// Punches from card numbers that match no employee (grouped, so you can
// see who still needs adding to HRMS).
// ---------------------------------------------------------------------
app.get("/api/biometric/unrecognised", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT al.employee_code, COUNT(*)::int AS punches, MAX(al.log_datetime) AS last_punch, MAX(al.device_sn) AS device_sn
      FROM attendance_logs al
      WHERE al.employee_code <> ''
        AND NOT EXISTS (SELECT 1 FROM employees e
                        WHERE e.id = al.employee_code OR (e.machine_user_id <> '' AND e.machine_user_id = al.employee_code))
      GROUP BY al.employee_code
      ORDER BY punches DESC, al.employee_code`);
    const hotels = (await pool.query("SELECT name, device_id FROM hotels")).rows;
    const records = r.rows.map(row => {
      const h = hotels.find(x => String(x.device_id || "").split(",").map(s => s.trim()).includes(row.device_sn));
      return { ...row, hotel_name: h ? h.name : "" };
    });
    res.json({ status: "success", records });
  } catch (error) {
    console.error("GET /api/biometric/unrecognised failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Permanently deletes stored punches that match no employee. Requires
// { confirm: true }. Punches of people you add later are never touched.
app.delete("/api/biometric/unrecognised", async (req, res) => {
  try {
    if (!(req.body && req.body.confirm === true)) {
      return res.status(400).json({ status: "error", message: "Pass { confirm: true } to delete unrecognised punches." });
    }
    const r = await pool.query(`
      DELETE FROM attendance_logs al
      WHERE NOT EXISTS (SELECT 1 FROM employees e
                        WHERE e.id = al.employee_code OR (e.machine_user_id <> '' AND e.machine_user_id = al.employee_code))`);
    res.json({ status: "success", deleted: r.rowCount });
  } catch (error) {
    console.error("DELETE /api/biometric/unrecognised failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Bulk-fill or correct actual device punches for a whole month in one go —
// the sheet-based counterpart to individual webhook punches. Body:
// { rows: [{ employee_id, date, in_time, out_time }] }. in_time/out_time are
// "HH:MM" (out_time optional). Both blank clears that day's uploaded punches.
// Re-uploading a corrected sheet replaces exactly the days it covers, so it's
// safe to run again after fixing a mistake.
app.post("/api/attendance/bulk-import", async (req, res) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", message: "rows must be a non-empty array of { employee_id, date, in_time, out_time }." });
    }
    const timeRe = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
    const pairs = [], codes = [], datetimes = [], logTimes = [], deviceSns = [], sources = [];
    let skipped = 0, badTimes = 0;
    for (const row of rows) {
      const employee_id = row.employee_id ? String(row.employee_id).trim() : "";
      const date = ymd(row.date);
      if (!employee_id || !date) { skipped++; continue; }
      pairs.push([employee_id, date]);
      for (const raw of [row.in_time, row.out_time]) {
        const t = raw ? String(raw).trim() : "";
        if (!t) continue;
        if (!timeRe.test(t)) { badTimes++; continue; }
        const hhmm = t.length === 5 ? t + ":00" : t;
        codes.push(employee_id); datetimes.push(`${date} ${hhmm}`); logTimes.push(hhmm); deviceSns.push(""); sources.push("bulk_import");
      }
    }
    if (!pairs.length) return res.status(400).json({ status: "error", message: "No valid employee_id/date rows found." });
    const BATCH = 2000;
    for (let i = 0; i < pairs.length; i += BATCH) {
      const part = pairs.slice(i, i + BATCH);
      await pool.query(
        `DELETE FROM attendance_logs d USING unnest($1::text[], $2::text[]) AS t(employee_code, date)
         WHERE d.source = 'bulk_import' AND d.employee_code = t.employee_code AND substring(d.log_datetime, 1, 10) = t.date`,
        [part.map(p => p[0]), part.map(p => p[1])]);
    }
    for (let i = 0; i < codes.length; i += BATCH) {
      const end = i + BATCH;
      await pool.query(
        `INSERT INTO attendance_logs (employee_code, log_datetime, log_time, downloaded_at, device_sn, source)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         ON CONFLICT (employee_code, log_datetime, device_sn) DO NOTHING`,
        [codes.slice(i, end), datetimes.slice(i, end), logTimes.slice(i, end), datetimes.slice(i, end), deviceSns.slice(i, end), sources.slice(i, end)]);
    }
    res.json({ status: "success", days_covered: pairs.length, punches_saved: codes.length, skipped, bad_times: badTimes });
  } catch (error) {
    console.error("POST /api/attendance/bulk-import failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------------------------------------------------------------------
// Payroll: per-employee monthly adjustments, and the statutory rates
// ---------------------------------------------------------------------
// Body: { employee_id, month "YYYY-MM", arrear?, pf_abry_benefit?, other_deductions?,
//         advance_recovery?, salary_on_hold?, fnf_amount? }. Any field left out keeps
// its current value for that employee/month; this always upserts one row.
app.post("/api/payroll/adjustments", async (req, res) => {
  try {
    const body = req.body || {};
    const employee_id = body.employee_id ? String(body.employee_id).trim() : "";
    const month = body.month ? String(body.month).trim() : "";
    if (!employee_id || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ status: "error", message: "employee_id and month (YYYY-MM) are required." });
    }
    const num = (v, d) => v === undefined ? d : (v === "" || v === null ? null : Number(v));
    const existing = await pool.query("SELECT * FROM payroll_adjustments WHERE employee_id = $1 AND month = $2", [employee_id, month]);
    const cur = existing.rows[0] || { arrear: 0, pf_abry_benefit: 0, other_deductions: 0, advance_recovery: 0, salary_on_hold: false, fnf_amount: null };
    const arrear = num(body.arrear, cur.arrear) ?? 0;
    const abry = num(body.pf_abry_benefit, cur.pf_abry_benefit) ?? 0;
    const otherDed = num(body.other_deductions, cur.other_deductions) ?? 0;
    const advRec = num(body.advance_recovery, cur.advance_recovery) ?? 0;
    const onHold = body.salary_on_hold !== undefined ? !!body.salary_on_hold : !!cur.salary_on_hold;
    const fnf = body.fnf_amount !== undefined ? num(body.fnf_amount, null) : cur.fnf_amount;
    const r = await pool.query(
      `INSERT INTO payroll_adjustments (employee_id, month, arrear, pf_abry_benefit, other_deductions, advance_recovery, salary_on_hold, fnf_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (employee_id, month) DO UPDATE SET
         arrear = EXCLUDED.arrear, pf_abry_benefit = EXCLUDED.pf_abry_benefit, other_deductions = EXCLUDED.other_deductions,
         advance_recovery = EXCLUDED.advance_recovery, salary_on_hold = EXCLUDED.salary_on_hold, fnf_amount = EXCLUDED.fnf_amount
       RETURNING *`,
      [employee_id, month, arrear, abry, otherDed, advRec, onHold, fnf]
    );
    res.json({ status: "success", adjustment: r.rows[0] });
  } catch (error) {
    console.error("POST /api/payroll/adjustments failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// The PF/ESI rates and PT slabs currently in effect. Stored in the
// database (not hard-coded) so a future rate change — like this month's
// PF ceiling revision — is a data update, not a redeploy.
app.get("/api/payroll/rates", async (req, res) => {
  try { res.json({ status: "success", rates: await getPayrollRates() }); }
  catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});
// Body: any of { pf_ceiling, pf_rate, esi_employee_rate, esi_employer_rate, pt_slabs }.
// pt_slabs, if given, replaces the whole table: [{upto, amount}], upto:null = no upper bound.
app.post("/api/payroll/rates", async (req, res) => {
  try {
    const body = req.body || {};
    if (body.pf_ceiling !== undefined) await setSetting("pf_ceiling", Number(body.pf_ceiling));
    if (body.pf_rate !== undefined) await setSetting("pf_rate", Number(body.pf_rate));
    if (body.esi_employee_rate !== undefined) await setSetting("esi_employee_rate", Number(body.esi_employee_rate));
    if (body.esi_employer_rate !== undefined) await setSetting("esi_employer_rate", Number(body.esi_employer_rate));
    if (body.pt_slabs !== undefined) await setSetting("pt_slabs", JSON.stringify(body.pt_slabs));
    res.json({ status: "success", rates: await getPayrollRates() });
  } catch (error) {
    console.error("POST /api/payroll/rates failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
