const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

// NOTE: DATABASE_URL is not currently set on Render (the deploy log showed
// "injected env (0) from .env"), so this Pool exists but nothing queries it
// yet. Everything below runs on in-memory mock data so the dashboard has
// something real to render. Swap the in-memory arrays for pool.query(...)
// calls once your Postgres connection string is actually configured.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Webhook-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// ---------------------------------------------------------------------
// In-memory mock data. Replace with real DB reads/writes when ready.
// ---------------------------------------------------------------------
// Your real properties, taken from Realtime Biometrics' machine list
// (Device Setup > Machine List). device_id is that machine's serial number.
// attendance_status/biometric_status start as "Not configured" until you
// actually set each one up on the Biometric Integration tab — this list
// alone doesn't mean the integration is live, just that the property exists.
let hotels = [
  { id: "HAAC", name: "Hotel Alpine Abode Continental", code: "HAAC", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455731", biometric_status: "Not configured", last_sync: "No records" },
  { id: "TRR", name: "The Royal Retreat", code: "TRR", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455826", biometric_status: "Not configured", last_sync: "No records" },
  { id: "SFR", name: "Songfum Retreat", code: "SFR", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455737", biometric_status: "Not configured", last_sync: "No records" },
  { id: "GLZ", name: "Glenz Resort", code: "GLZ", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455736", biometric_status: "Not configured", last_sync: "No records" },
  { id: "DVR", name: "Dream Villa Retreat", code: "DVR", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455740", biometric_status: "Not configured", last_sync: "No records" },
  { id: "TAR", name: "The Aryan Regency", code: "TAR", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455949", biometric_status: "Not configured", last_sync: "No records" },
  { id: "RDH", name: "Rodhi Resort", code: "RDH", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455734", biometric_status: "Not configured", last_sync: "No records" },
  { id: "MHB", name: "Milestone Hotel & Banquet", code: "MHB", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455733", biometric_status: "Not configured", last_sync: "No records" },
  { id: "EST", name: "Eastin Suites", code: "EST", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455791", biometric_status: "Not configured", last_sync: "No records" },
  { id: "CHT", name: "Chattore", code: "CHT", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455735", biometric_status: "Not configured", last_sync: "No records" },
  { id: "VEV", name: "Voyage Eco Village Resort", code: "VEV", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "RSS20230455906", biometric_status: "Not configured", last_sync: "No records" }
];

// id is the HRMS-side employee code (e.g. "VCOR001"), what you use everywhere
// in this system — the duty roster, this table, etc.
// machine_user_id is the separate numeric User ID / Card No. configured on
// the physical biometric device — this is what actually shows up as
// employee_code in incoming punches, and is NOT the same as id. Nothing
// links them automatically; that's what the mapping below is for.
let employees = [
  { id: "VCOR001", name: "Souradeep Das", hotel_id: "HAAC", role: "Digital Marketing Executive", status: "Active", machine_user_id: "00000001" },
  { id: "VCOR002", name: "Tanmay Bhowmick", hotel_id: "HAAC", role: "Graphic Designer", status: "Active", machine_user_id: "00000002" },
  { id: "VCOR003", name: "Raj Majhi", hotel_id: "TRR", role: "Guest Relations Executive", status: "Active", machine_user_id: "00000003" }
];

function findEmployeeByMachineId(machineUserId) {
  return employees.find(e => String(e.machine_user_id) === String(machineUserId));
}

let integrations = []; // populated via POST /api/biometric/integrations/config
let attendanceLogs = []; // populated via POST /api/biometric/attendance (the real device webhook)

// Duty roster: one row per employee per date. type is "Weekly Off" or a
// working-shift label (e.g. "Morning", "Evening", "General"). Uploaded via
// POST /api/duty-roster as parsed CSV/Excel rows from the frontend.
// { employee_id, date: "YYYY-MM-DD", type }
let dutyRoster = [];

// Pull just the YYYY-MM-DD part out of whatever date format shows up
// (biometric punches send "YYYY-MM-DD HH:mm:ss", roster rows send plain dates).
function ymd(value) {
  if (!value) return null;
  const s = String(value).trim();
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

// Computes a day-by-day attendance status per employee, chronologically, so
// a comp-off earned on one day can be spent on any later absence — not just
// the next calendar day.
//
// Rules:
//  - Roster says "Weekly Off" + employee has punches that day  -> "Present (Worked Weekly Off)", +1 comp-off credit
//  - Roster says "Weekly Off" + no punches                      -> "Weekly Off"
//  - Working day (roster says a shift, or no roster entry at all) + 2+ punches -> "Present"
//  - Working day + exactly 1 punch                              -> "Present (Incomplete)" (missing checkout)
//  - Working day + 0 punches + comp-off balance available       -> "Comp Off" (auto-applied, balance -1)
//  - Working day + 0 punches + no comp-off balance               -> "Absent"
function computeAttendance(hotelId, month) {
  const scopeEmployees = employees.filter(e => hotelId === "all" || !hotelId || String(e.hotel_id) === String(hotelId));
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`; // simple upper bound, fine for string comparison of YYYY-MM-DD

  const results = [];

  for (const emp of scopeEmployees) {
    const rosterByDate = {};
    dutyRoster.filter(r => String(r.employee_id) === String(emp.id)).forEach(r => {
      const d = ymd(r.date);
      if (d) rosterByDate[d] = r.type;
    });

    const punchesByDate = {};
    attendanceLogs.filter(l => String(l.employee_code) === String(emp.machine_user_id)).forEach(l => {
      const d = ymd(l.log_datetime || l.received_at);
      if (!d) return;
      punchesByDate[d] = (punchesByDate[d] || 0) + 1;
    });

    // Walk every date that has either a roster entry or a punch, in order,
    // up through the end of the requested month, so comp-off balance carries
    // forward correctly from earlier months.
    const allDates = Array.from(new Set([...Object.keys(rosterByDate), ...Object.keys(punchesByDate)]))
      .filter(d => d <= monthEnd)
      .sort();

    let compOffBalance = 0;

    for (const date of allDates) {
      const punches = punchesByDate[date] || 0;
      const rosterType = rosterByDate[date];
      const isWeeklyOff = rosterType === "Weekly Off";
      let status;

      if (isWeeklyOff) {
        if (punches > 0) {
          status = "Present (Worked Weekly Off)";
          compOffBalance += 1;
        } else {
          status = "Weekly Off";
        }
      } else {
        if (punches >= 2) {
          status = "Present";
        } else if (punches === 1) {
          status = "Present (Incomplete)";
        } else if (compOffBalance > 0) {
          status = "Comp Off";
          compOffBalance -= 1;
        } else {
          status = "Absent";
        }
      }

      if (date >= monthStart && date <= monthEnd) {
        results.push({
          employee_id: emp.id,
          employee_name: emp.name,
          hotel_id: emp.hotel_id,
          date,
          punches,
          status,
          shift: rosterType || null
        });
      }
    }
  }

  return results.sort((a, b) => (a.date === b.date ? a.employee_name.localeCompare(b.employee_name) : a.date.localeCompare(b.date)));
}

function findIntegration(hotel_id, device_sn) {
  return integrations.find(x => String(x.hotel_id) === String(hotel_id) && String(x.device_sn) === String(device_sn));
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
app.get("/api/hotels/status", (req, res) => {
  // The dashboard's KPI cards read employees_count / attendance_records /
  // payroll_records from this same response (alongside the hotels array),
  // so all three must be sent explicitly or the frontend falls back to
  // using hotels.length for every card.
  res.json({
    status: "success",
    records: hotels,
    employees_count: employees.length,
    attendance_records: attendanceLogs.length,
    payroll_records: 0
  });
});

app.post("/api/hotels/:hotelId/biometric/:action", (req, res) => {
  const { hotelId, action } = req.params;
  const hotel = hotels.find(h => String(h.id) === String(hotelId));
  if (!hotel) return res.status(404).json({ status: "error", message: "Hotel not found" });

  if (action === "test") {
    hotel.biometric_status = "Connected";
  } else if (action === "sync") {
    hotel.last_sync = new Date().toISOString().slice(0, 19).replace("T", " ");
  } else {
    return res.status(400).json({ status: "error", message: `Unknown action: ${action}` });
  }
  res.json({ status: "success", hotel });
});

// ---------------------------------------------------------------------
// 3. Biometric integrations — also must return an ARRAY
// ---------------------------------------------------------------------
app.get("/api/biometric/integrations/status", (req, res) => {
  res.json({ status: "success", records: integrations });
});

app.post("/api/biometric/integrations/config", (req, res) => {
  const body = req.body || {};
  if (!body.hotel_id || !body.device_sn || !body.provider_name || !body.endpoint_url) {
    return res.status(400).json({ status: "error", message: "hotel_id, device_sn, provider_name, and endpoint_url are required." });
  }
  let existing = findIntegration(body.hotel_id, body.device_sn);
  const hotel = hotels.find(h => String(h.id) === String(body.hotel_id));
  const record = {
    id: existing ? existing.id : `INT-${Date.now()}`,
    hotel_id: body.hotel_id,
    hotel_name: hotel ? hotel.name : body.hotel_id,
    hotel_code: hotel ? hotel.code : "",
    device_sn: body.device_sn,
    provider_name: body.provider_name,
    timezone: body.timezone,
    method: body.method,
    auth_type: body.auth_type,
    content_type: body.content_type,
    transport_mode: body.transport_mode,
    sync_mode: body.sync_mode,
    mapping_mode: body.mapping_mode,
    endpoint_url: body.endpoint_url,
    active: body.active !== false,
    parameter_mappings: body.parameter_mappings || [],
    status: existing ? existing.status : "Not configured",
    last_test: existing ? existing.last_test : "No records",
    last_sync: existing ? existing.last_sync : "No records",
    records_sent: existing ? existing.records_sent : 0,
    records_received: existing ? existing.records_received : 0,
    failed_requests: existing ? existing.failed_requests : 0,
    duplicate_events: existing ? existing.duplicate_events : 0,
    unmatched_employees: existing ? existing.unmatched_employees : 0
  };
  // NOTE: credentials (body.credentials) are intentionally NOT stored on the
  // record above or ever sent back in a GET response. Persist them only in
  // a real secret store, never in a plain in-memory object or a DB column
  // that gets returned to the browser.
  if (existing) {
    integrations = integrations.map(x => (x.id === existing.id ? record : x));
  } else {
    integrations.push(record);
  }
  res.json({ status: "success", integration: record });
});

app.post("/api/biometric/integrations/test", (req, res) => {
  const body = req.body || {};
  const existing = findIntegration(body.hotel_id, body.device_sn);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (existing) {
    existing.status = "Connected";
    existing.last_test = now;
  }
  // A real implementation would attempt an actual call to body.endpoint_url
  // here and reflect genuine success/failure instead of always succeeding.
  res.json({ status: "Connected", tested_at: now });
});

app.post("/api/biometric/integrations/sync", (req, res) => {
  const body = req.body || {};
  const existing = findIntegration(body.hotel_id, body.device_sn);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (existing) {
    existing.last_sync = now;
    existing.records_sent = (existing.records_sent || 0) + 1;
    existing.records_received = (existing.records_received || 0) + 1;
  }
  res.json({ status: "success", synced_at: now });
});

// Handles both "disable" and "delete" from the dashboard today, because the
// frontend currently sends an identical payload for both actions — there is
// no field distinguishing them. This route treats every call as a disable
// (soft, reversible). True delete needs a frontend change (a new distinct
// action/body) before the backend can tell the two apart.
app.post("/api/biometric/integrations/disconnect", (req, res) => {
  const body = req.body || {};
  const existing = findIntegration(body.hotel_id, body.device_sn);
  if (existing) {
    existing.active = false;
    existing.status = "Not configured";
  }
  res.json({ status: "success", active: false });
});

// ---------------------------------------------------------------------
// 4. The actual device webhook. This is the URL configured in Realtime
//    Biometrics ("Parallel Data Export Setting" -> API URL) and matches
//    https://hrms-biometric-backend-1.onrender.com/api/biometric/attendance
// ---------------------------------------------------------------------
app.post("/api/biometric/attendance", (req, res) => {
  try {
    const log = req.body;
    console.log("Received biometric punch:", log);

    const integration = integrations.find(x => String(x.device_sn) === String(log.device_sn));
    if (integration) {
      integration.records_received = (integration.records_received || 0) + 1;
      integration.last_sync = new Date().toISOString().slice(0, 19).replace("T", " ");
    }

    attendanceLogs.push({ ...log, received_at: new Date().toISOString() });

    return res.status(200).json({ status: "success", message: "Attendance log synchronized successfully." });
  } catch (error) {
    console.error("Error processing attendance webhook:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------------------------------------------------------------------
// 5. Stub routes for the other dashboard tabs (Employees, Attendance
//    Register, Leave, Payroll). The frontend does not call these yet —
//    those tabs currently have no fetch logic at all — but the routes
//    are here so that work can plug in without also needing backend
//    changes later.
// ---------------------------------------------------------------------
// Bulk import/update employees — built to accept rows shaped like the
// Realtime Biometrics employee export (EmpName, Cardno, EmpCode, Dept_Name,
// Desig_Name, Branch), but works with any rows using these field names.
// Body: { rows: [{ employee_id, name, machine_user_id, hotel_id, role }] }
// Upserts by employee_id: creates new employees, updates existing ones.
app.post("/api/employees/import", (req, res) => {
  const rows = (req.body && req.body.rows) || [];
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ status: "error", message: "rows must be a non-empty array." });
  }
  let created = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const employee_id = row.employee_id && String(row.employee_id).trim();
    if (!employee_id) { skipped++; continue; }
    const existing = employees.find(e => String(e.id) === employee_id);
    const fields = {
      name: row.name ? String(row.name).trim() : (existing ? existing.name : ""),
      machine_user_id: row.machine_user_id ? String(row.machine_user_id).trim() : (existing ? existing.machine_user_id : ""),
      hotel_id: row.hotel_id ? String(row.hotel_id).trim() : (existing ? existing.hotel_id : ""),
      role: row.role ? String(row.role).trim() : (existing ? existing.role : ""),
      status: row.status ? String(row.status).trim() : (existing ? existing.status : "Active")
    };
    if (existing) {
      Object.assign(existing, fields);
      updated++;
    } else {
      employees.push({ id: employee_id, ...fields });
      created++;
    }
  }
  res.json({ status: "success", created, updated, skipped, total_employees: employees.length });
});

app.get("/api/employees", (req, res) => {
  res.json({ status: "success", records: employees });
});

// Set or update one employee's biometric machine User ID / Card No.
// Body: { machine_user_id: "000001" }
app.post("/api/employees/:id/mapping", (req, res) => {
  const emp = employees.find(e => String(e.id) === String(req.params.id));
  if (!emp) return res.status(404).json({ status: "error", message: "Employee not found" });
  const machineUserId = req.body && req.body.machine_user_id ? String(req.body.machine_user_id).trim() : "";
  if (!machineUserId) return res.status(400).json({ status: "error", message: "machine_user_id is required" });
  emp.machine_user_id = machineUserId;
  res.json({ status: "success", employee: emp });
});

// Punches whose employee_code doesn't match any employee's machine_user_id —
// these are real device punches that can't be attributed to anyone yet,
// usually because that person's mapping hasn't been set up.
app.get("/api/biometric/unmapped-punches", (req, res) => {
  const mappedIds = new Set(employees.map(e => String(e.machine_user_id)));
  const unmapped = attendanceLogs.filter(l => !mappedIds.has(String(l.employee_code)));
  res.json({ status: "success", records: unmapped });
});

// Query params: hotel_id ("all" or a specific id), month ("YYYY-MM").
// Defaults to the current server month if not given.
app.get("/api/attendance", (req, res) => {
  const hotelId = req.query.hotel_id || "all";
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const records = computeAttendance(hotelId, month);
  res.json({ status: "success", month, hotel_id: hotelId, records });
});

// Upload/replace duty roster rows. Body: { rows: [{ employee_id, date, type }] }
// Existing entries for the same employee_id + date are overwritten; anything
// not included in this upload is left untouched (so partial re-uploads for
// just one hotel or one month don't wipe out the rest of the roster).
app.post("/api/duty-roster", (req, res) => {
  const rows = (req.body && req.body.rows) || [];
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ status: "error", message: "rows must be a non-empty array of { employee_id, date, type }." });
  }
  let applied = 0;
  for (const row of rows) {
    const employee_id = row.employee_id && String(row.employee_id).trim();
    const date = ymd(row.date);
    const type = row.type && String(row.type).trim();
    if (!employee_id || !date || !type) continue;
    dutyRoster = dutyRoster.filter(r => !(String(r.employee_id) === employee_id && ymd(r.date) === date));
    dutyRoster.push({ employee_id, date, type });
    applied++;
  }
  res.json({ status: "success", applied, skipped: rows.length - applied });
});

app.get("/api/duty-roster", (req, res) => {
  const hotelId = req.query.hotel_id || "all";
  const month = req.query.month;
  const employeeIds = hotelId === "all" ? null : employees.filter(e => String(e.hotel_id) === String(hotelId)).map(e => e.id);
  const rows = dutyRoster.filter(r => {
    if (employeeIds && !employeeIds.includes(String(r.employee_id))) return false;
    if (month && !String(r.date).startsWith(month)) return false;
    return true;
  });
  res.json({ status: "success", records: rows });
});

app.get("/api/leave", (req, res) => {
  res.json({ status: "success", records: [] });
});

app.get("/api/payroll", (req, res) => {
  res.json({ status: "success", records: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
