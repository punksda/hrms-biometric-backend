const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
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

app.use(express.json());

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
      machine_user_id TEXT DEFAULT ''
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
    ["VEV", "Voyage Eco Village Resort", "VEV", "RSS20230455906"]
  ];
  for (const [id, name, code, device_id] of realHotels) {
    await pool.query(
      `INSERT INTO hotels (id, name, code, attendance_provider, device_id)
       VALUES ($1, $2, $3, 'Realtime Biometrics', $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, code, device_id]
    );
  }

  console.log("Database ready.");
}

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

// Computes a day-by-day attendance status per employee, chronologically,
// so a comp-off earned on one day can be spent on any later absence.
// Fetches the raw rows from the DB, then runs the same grouping logic
// as before in JS — the tricky chronological comp-off math stays in
// plain JS rather than being reimplemented as SQL.
async function computeAttendance(hotelId, month) {
  const empRes = (hotelId === "all" || !hotelId)
    ? await pool.query("SELECT * FROM employees")
    : await pool.query("SELECT * FROM employees WHERE hotel_id = $1", [hotelId]);
  const scopeEmployees = empRes.rows;
  if (!scopeEmployees.length) return [];

  const empIds = scopeEmployees.map(e => e.id);
  const matchCodes = Array.from(new Set(
    scopeEmployees.flatMap(e => [e.id, e.machine_user_id]).filter(Boolean)
  ));

  const rosterRes = await pool.query(
    `SELECT employee_id, to_char(date, 'YYYY-MM-DD') AS date, type
     FROM duty_roster WHERE employee_id = ANY($1)`,
    [empIds]
  );
  const logsRes = matchCodes.length
    ? await pool.query(
        `SELECT employee_code, log_datetime, received_at
         FROM attendance_logs WHERE employee_code = ANY($1)`,
        [matchCodes]
      )
    : { rows: [] };

  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`;
  const results = [];

  for (const emp of scopeEmployees) {
    const rosterByDate = {};
    rosterRes.rows.filter(r => String(r.employee_id) === String(emp.id)).forEach(r => {
      rosterByDate[r.date] = r.type;
    });

    const punchesByDate = {};
    logsRes.rows
      .filter(l => String(l.employee_code) === String(emp.machine_user_id) || String(l.employee_code) === String(emp.id))
      .forEach(l => {
        const d = ymd(l.log_datetime || l.received_at);
        if (!d) return;
        punchesByDate[d] = (punchesByDate[d] || 0) + 1;
      });

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

async function findEmployee(code) {
  const r = await pool.query("SELECT * FROM employees WHERE id = $1 OR machine_user_id = $1", [code]);
  return r.rows[0] || null;
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

    if (device_sn) {
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      await pool.query(
        `UPDATE integrations SET records_received = records_received + 1, last_sync = $1 WHERE device_sn = $2`,
        [now, device_sn]
      );
    }

    // Fully automatic pickup: if this punch's employee_code doesn't match
    // any known employee yet, create a placeholder employee for them
    // right now instead of silently dropping the punch, so attendance is
    // captured from the very first time anyone is seen — no manual import
    // required. Rename/assign their hotel later as a cosmetic cleanup step.
    const code = log.employee_code ? String(log.employee_code).trim() : "";
    if (code) {
      const known = await findEmployee(code);
      if (!known) {
        let hotelId = "";
        if (device_sn) {
          const h = await pool.query("SELECT id FROM hotels WHERE device_id = $1", [device_sn]);
          if (h.rows.length) hotelId = h.rows[0].id;
        }
        await pool.query(
          `INSERT INTO employees (id, name, hotel_id, role, status, machine_user_id)
           VALUES ($1, $2, $3, '', 'Active', $1)
           ON CONFLICT (id) DO NOTHING`,
          [code, `Unmapped (${code})`, hotelId]
        );
      }
    }

    await pool.query(
      `INSERT INTO attendance_logs (employee_code, log_datetime, log_time, downloaded_at, device_sn, source)
       VALUES ($1, $2, $3, $4, $5, 'webhook')
       ON CONFLICT (employee_code, log_datetime, device_sn) DO NOTHING`,
      [code, log.log_datetime || "", log.log_time || "", log.downloaded_at || "", device_sn]
    );

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
    const r = await pool.query("SELECT * FROM employees ORDER BY name");
    res.json({ status: "success", records: r.rows });
  } catch (error) {
    console.error("GET /api/employees failed:", error);
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
    let created = 0, updated = 0, skipped = 0;
    for (const row of rows) {
      const employee_id = row.employee_id && String(row.employee_id).trim();
      if (!employee_id) { skipped++; continue; }
      const existingRes = await pool.query("SELECT * FROM employees WHERE id = $1", [employee_id]);
      if (existingRes.rows.length) {
        await pool.query(
          `UPDATE employees SET
             name = COALESCE(NULLIF($2, ''), name),
             machine_user_id = COALESCE(NULLIF($3, ''), machine_user_id),
             hotel_id = COALESCE(NULLIF($4, ''), hotel_id),
             role = COALESCE(NULLIF($5, ''), role),
             status = COALESCE(NULLIF($6, ''), status)
           WHERE id = $1`,
          [employee_id, row.name || "", row.machine_user_id || "", row.hotel_id || "", row.role || "", row.status || ""]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO employees (id, name, hotel_id, role, status, machine_user_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [employee_id, row.name || "", row.hotel_id || "", row.role || "", row.status || "Active", row.machine_user_id || ""]
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
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const records = await computeAttendance(hotelId, month);
    res.json({ status: "success", month, hotel_id: hotelId, records });
  } catch (error) {
    console.error("GET /api/attendance failed:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Upload/replace duty roster rows. Body: { rows: [{ employee_id, date, type }] }
app.post("/api/duty-roster", async (req, res) => {
  try {
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
      await pool.query(
        `INSERT INTO duty_roster (employee_id, date, type) VALUES ($1,$2,$3)
         ON CONFLICT (employee_id, date) DO UPDATE SET type = EXCLUDED.type`,
        [employee_id, date, type]
      );
      applied++;
    }
    res.json({ status: "success", applied, skipped: rows.length - applied });
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

app.get("/api/leave", (req, res) => {
  res.json({ status: "success", records: [] });
});

app.get("/api/payroll", (req, res) => {
  res.json({ status: "success", records: [] });
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
