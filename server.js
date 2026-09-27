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
let hotels = [
  { id: "1", name: "Voyage Riverside", code: "VR-01", attendance_provider: "Realtime Biometrics", attendance_status: "Connected", device_id: "SN-009128", biometric_status: "Connected", last_sync: "2026-09-27 02:20:00" },
  { id: "2", name: "Voyage Hillview", code: "VH-02", attendance_provider: "Realtime Biometrics", attendance_status: "Not configured", device_id: "—", biometric_status: "Not configured", last_sync: "No records" },
  { id: "3", name: "Voyage Marina", code: "VM-03", attendance_provider: "—", attendance_status: "Not configured", device_id: "—", biometric_status: "Not configured", last_sync: "No records" }
];

let employees = [
  { id: "E1001", name: "Asha Rao", hotel_id: "1", role: "Front Desk", status: "Active" },
  { id: "E1023", name: "Vikram Shah", hotel_id: "1", role: "Housekeeping", status: "Active" }
];

let integrations = []; // populated via POST /api/biometric/integrations/config
let attendanceLogs = []; // populated via POST /api/biometric/attendance (the real device webhook)

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
app.get("/api/employees", (req, res) => {
  res.json({ status: "success", records: employees });
});

app.get("/api/attendance", (req, res) => {
  res.json({ status: "success", records: attendanceLogs });
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
