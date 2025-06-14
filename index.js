const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const auth = require("./api/auth");
const contacts = require("./api/contacts");

const app = express();
const PORT = process.env.PORT || 3000;

// Add process error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

app.use(cors());
app.use(bodyParser.json());

// Add request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check (fixed typo)
app.get("/health-check", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// API Routes
app.post("/auth/send-code", auth.login);
app.post("/auth/verify", auth.verify);
app.post("/auth/resend-code", auth.resendCode);
app.get("/contacts", contacts.get);
app.post("/contacts/import", contacts.import);
app.post("/contacts/bulk", contacts.bulkCreate);
app.post("/contacts/check", contacts.checkPhones);

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: error.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

app.listen(PORT, () => {
  console.log(`Telegram MTProto Backend Server running on port ${PORT}`);
  console.log(
    `Health check available at: http://localhost:${PORT}/health-check`
  );
});

module.exports = app;
