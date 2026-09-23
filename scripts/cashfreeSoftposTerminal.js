/**
 * One-time setup for the Cashfree softPOS AGENT terminal used by booking
 * Dynamic QR payments. The payment path never creates terminals; it only
 * reads CASHFREE_SOFTPOS_TERMINAL_ID.
 *
 *   Verify an existing terminal (read-only):
 *     node scripts/cashfreeSoftposTerminal.js verify <10-digit-phone>
 *
 *   Create a new AGENT terminal (dry run unless --apply):
 *     node scripts/cashfreeSoftposTerminal.js create \
 *       --terminal-id MRBIKE_AGENT_1 --name "MR Bike Doctor" \
 *       --email ops@example.com --phone 9876543210 [--apply]
 *
 * Refuses to create when CASHFREE_SOFTPOS_TERMINAL_ID is already set, so a
 * second terminal is never minted by accident. Prints no credentials.
 */
require("dotenv").config()
const { getTerminalByPhone, createAgentTerminal } = require("../services/cashfreeSoftposService")

const args = process.argv.slice(2)
const command = args[0]
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index > -1 ? args[index + 1] : undefined
}

const printTerminal = (terminal) =>
  console.log(
    JSON.stringify(
      {
        cf_terminal_id: terminal.cf_terminal_id,
        terminal_id: terminal.terminal_id,
        terminal_type: terminal.terminal_type,
        terminal_status: terminal.terminal_status,
        terminal_name: terminal.terminal_name,
        terminal_phone_no: terminal.terminal_phone_no,
        added_on: terminal.added_on,
      },
      null,
      2,
    ),
  )

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

;(async () => {
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    fail("CASHFREE_APP_ID / CASHFREE_SECRET_KEY are not set.")
  }

  if (command === "verify") {
    const phone = args[1]
    if (!/^\d{10}$/.test(phone || "")) fail("Usage: verify <10-digit-phone>")
    const terminal = await getTerminalByPhone(phone)
    printTerminal(terminal)
    const configured = process.env.CASHFREE_SOFTPOS_TERMINAL_ID
    if (configured && String(configured) !== String(terminal.cf_terminal_id)) {
      console.warn(`WARNING: CASHFREE_SOFTPOS_TERMINAL_ID=${configured} does not match this terminal.`)
    }
    if (terminal.terminal_type && terminal.terminal_type !== "AGENT") {
      console.warn(`WARNING: terminal_type is ${terminal.terminal_type}, expected AGENT.`)
    }
    return
  }

  if (command === "create") {
    if (process.env.CASHFREE_SOFTPOS_TERMINAL_ID) {
      fail(`CASHFREE_SOFTPOS_TERMINAL_ID is already set (${process.env.CASHFREE_SOFTPOS_TERMINAL_ID}); not creating another terminal.`)
    }
    const input = {
      terminalId: flag("terminal-id"),
      name: flag("name"),
      email: flag("email"),
      phone: flag("phone"),
      note: flag("note"),
    }
    if (!input.terminalId || !input.name || !input.email || !/^\d{10}$/.test(input.phone || "")) {
      fail("Required: --terminal-id --name --email --phone <10 digits>")
    }
    if (!args.includes("--apply")) {
      console.log("DRY RUN — would POST /pg/terminal with terminal_type AGENT:", { ...input })
      console.log("Re-run with --apply to create it.")
      return
    }
    const terminal = await createAgentTerminal(input)
    printTerminal(terminal)
    console.log(`\nSet CASHFREE_SOFTPOS_TERMINAL_ID=${terminal.cf_terminal_id} and CASHFREE_SOFTPOS_TERMINAL_PHONE=${input.phone}`)
    return
  }

  fail("Usage: node scripts/cashfreeSoftposTerminal.js verify <phone> | create --terminal-id .. --name .. --email .. --phone .. [--apply]")
})().catch((error) => {
  console.error("Cashfree softPOS terminal request failed:", error.response?.status, error.response?.data?.message || error.message)
  process.exit(1)
})
