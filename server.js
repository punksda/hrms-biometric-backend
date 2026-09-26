const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

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

// 1. Auth checkpoint route
app.get("/api/auth/me", (req, res) => {
  res.json({ status: "success", user: { id: 1, role: "admin" } });
});

// 2. Core Workspace summary data endpoint matching the sandbox components
app.get("/api/hotels/status", (req, res) => {
  res.json({
    status: "success",
    hotelsCount: 5,
    employeesCount: 142,
    attendanceRecordsCount: 1204,
    biometricIntegrationsCount: 3,
    payrollRecordsCount: 88
  });
});

// 3. Integration configurations validation route
app.get("/api/biometric/integrations/status", (req, res) => {
  res.json({ status: "success", connection: "active" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
