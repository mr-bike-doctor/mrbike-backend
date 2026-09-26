const { getSoftposTerminalConfig } = require("../services/cashfreeSoftposService");

// Startup report for the booking softPOS Dynamic QR terminal. Informational
// only: an unconfigured terminal disables booking QR (generate-qr answers
// 503) but must never stop the server. Reads nothing but the softPOS
// variables — Cashfree APP_ID / SECRET_KEY are never read or logged here.
//
// This cannot know the terminal's Cashfree status (e.g. DOCS_AWAITED); that
// needs `node scripts/cashfreeSoftposTerminal.js verify <phone>`.
function reportSoftposConfig(log = console.log) {
  const raw = String(process.env.CASHFREE_SOFTPOS_TERMINAL_ID || "").trim();
  const terminal = getSoftposTerminalConfig();
  const phone = String(process.env.CASHFREE_SOFTPOS_TERMINAL_PHONE || "").trim();

  const summary = {
    terminal_configured: terminal ? "yes" : "no",
    cf_terminal_id: terminal ? terminal.cfTerminalId : null,
    ...(raw && !terminal ? { problem: "CASHFREE_SOFTPOS_TERMINAL_ID is set but is not a positive integer" } : {}),
    terminal_phone: terminal?.terminalPhoneNo
      ? `******${terminal.terminalPhoneNo.slice(-4)}`
      : phone
        ? "invalid (must be 10 digits)"
        : "not set",
    api_version: process.env.CASHFREE_SOFTPOS_API_VERSION || "2026-01-01 (default)",
  };
  log("[CASHFREE_SOFTPOS] config", summary);
  return summary;
}

module.exports = reportSoftposConfig;
