require("dotenv").config();
const MTProto = require("@mtproto/core");
const path = require("path");
const fs = require("fs");

const createMTProto = (phone) => {
  console.log(`[mtproto] === CREATING MTPROTO INSTANCE ===`);
  console.log(`[mtproto] Phone:`, phone);
  console.log(
    `[mtproto] API_ID:`,
    process.env.TELEGRAM_API_ID ? "✓ Set" : "✗ Missing"
  );
  console.log(
    `[mtproto] API_HASH:`,
    process.env.TELEGRAM_API_HASH ? "✓ Set" : "✗ Missing"
  );

  // Check if required env vars are present
  if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
    console.error(
      "[mtproto] Missing TELEGRAM_API_ID or TELEGRAM_API_HASH environment variables"
    );
    throw new Error(
      "Missing TELEGRAM_API_ID or TELEGRAM_API_HASH environment variables"
    );
  }

  const sessionsDir = path.resolve(__dirname, "sessions");
  const sessionPath = path.resolve(sessionsDir, `${phone}.json`);

  console.log("[mtproto] Sessions directory:", sessionsDir);
  console.log("[mtproto] Session path:", sessionPath);

  // Create sessions directory if it doesn't exist
  if (!fs.existsSync(sessionsDir)) {
    console.log("[mtproto] Creating sessions directory...");
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  try {
    console.log("[mtproto] Initializing MTProto...");
    const mtproto = new MTProto({
      api_id: parseInt(process.env.TELEGRAM_API_ID),
      api_hash: process.env.TELEGRAM_API_HASH,
      storageOptions: {
        path: sessionPath,
      },
    });
    console.log("[mtproto] MTProto initialized successfully");

    // Check if session is authenticated
    const isAuthenticated = fs.existsSync(sessionPath);

    const call = async (method, params) => {
      console.log(`[mtproto] === CALLING ${method} ===`);
      console.log(`[mtproto] Params:`, params);

      try {
        const result = await mtproto.call(method, params);
        console.log(`[mtproto] ${method} successful.`);
        return result;
      } catch (error) {
        console.error(`[mtproto] ${method} error:`);
        console.error(
          `[mtproto] Error type:`,
          error.constructor ? error.constructor.name : typeof error
        );
        console.error(`[mtproto] Error:`, error._);
        console.error(`[mtproto] Error code:`, error.error_code);
        console.error(`[mtproto] Error message:`, error.error_message);

        if (error.error_message && /_MIGRATE_/.test(error.error_message)) {
          console.log("[mtproto] Handling DC migration...");
          const dcId = parseInt(error.error_message.split("_").pop(), 10);
          console.log("[mtproto] Migrating to DC:", dcId);
          mtproto.setDefaultDc(dcId);

          console.log(`[mtproto] Retrying ${method} after migration...`);
          const retryResult = await mtproto.call(method, params);
          console.log(
            `[mtproto] ${method} successful after migration:`,
            retryResult
          );
          return retryResult;
        }
        throw error;
      }
    };

    return { mtproto, call, isAuthenticated };
  } catch (error) {
    console.error("[mtproto] Failed to create MTProto instance:");
    console.error(
      "[mtproto] Error type:",
      error.constructor ? error.constructor.name : typeof error
    );
    console.error("[mtproto] Error message:", error.error_message);
    console.error("[mtproto] Error stack:", error.stack);
    console.error("[mtproto] Full error object:", error);
    throw error;
  }
};

module.exports = createMTProto;
