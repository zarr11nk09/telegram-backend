const createMTProto = require("../mtproto");

// Helper function to handle different error types
const handleContactError = (error, phone) => {
  if (error.error_code === 400) {
    switch (error.error_message) {
      case "PHONE_NOT_OCCUPIED":
        return {
          phone: phone,
          status: "skipped",
          reason: "Phone number is not registered on Telegram",
        };
      case "PHONE_NUMBER_INVALID":
        return {
          phone: phone,
          status: "skipped",
          reason: "Invalid phone number format",
        };
      case "PHONE_NUMBER_BANNED":
        return {
          phone: phone,
          status: "skipped",
          reason: "Phone number is banned",
        };
      default:
        return {
          phone: phone,
          status: "skipped",
          reason: error.error_message || "Unknown Telegram API error",
        };
    }
  }

  // Handle other error types
  return {
    phone: phone,
    status: "skipped",
    reason: error.error_message || error.message || "Unknown error",
  };
};

async function sendExpoPush(pushToken, title, body) {
  if (!pushToken) return;

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: pushToken, title, body }),
  });
}

exports.bulkCreate = async (req, res) => {
  console.log("[contacts.bulkCreate] called with body:", req.body);
  const { number, name_prefix, generate, phone, push_token } = req.body;

  if (!number || !name_prefix || !generate || !phone) {
    console.warn("[contacts.bulkCreate] Missing required fields");
    return res
      .status(400)
      .json({ error: "Missing number, name_prefix, generate, or phone" });
  }

  // Generate contacts array
  const baseNumber = BigInt(number);
  const contacts = [];
  for (let i = 0; i < generate; i++) {
    contacts.push({
      phone: (baseNumber + BigInt(i)).toString(),
      first_name: name_prefix,
      last_name: (i + 1).toString(),
    });
  }
  console.log(`[contacts.bulkCreate] Generated ${contacts.length} contacts`);

  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;
  console.log("[contacts.bulkCreate] Normalized phone:", normalizedPhone);

  const { call, isAuthenticated } = createMTProto(normalizedPhone);
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Check if session is authenticated
  if (!isAuthenticated) {
    console.warn("[contacts.bulkCreate] Session not authenticated");
    return res.status(401).json({
      error: "AUTH_KEY_UNREGISTERED",
      message: "Session not authenticated. Please login again.",
      action: "REAUTH_REQUIRED",
    });
  }

  console.log("[contacts.bulkCreate] Generating contacts...");

  const results = [];
  const validContacts = [];
  let processedCount = 0;
  let errorCount = 0;

  for (const c of contacts) {
    processedCount++;
    try {
      console.log(
        `[contacts.bulkCreate] Processing ${processedCount}/${contacts.length} - Phone: ${c.phone}`
      );

      // Check if user exists
      const found = await call("contacts.resolvePhone", { phone: c.phone });

      if (!found || !found.users || found.users.length === 0) {
        console.log(
          `[contacts.bulkCreate] Phone ${c.phone} is not a Telegram user`
        );
        results.push({
          phone: c.phone,
          status: "skipped",
          reason: "Not a Telegram user",
        });
        continue;
      }

      const user = found.users[0];

      // Check if contact already exists in user's contact list
      const existingContacts = await call("contacts.getContacts", {});
      const contactExists = existingContacts.users.some(
        (contact) => contact.id === user.id
      );

      if (contactExists) {
        console.log(`[contacts.bulkCreate] Contact ${c.phone} already exists`);
        results.push({
          phone: c.phone,
          status: "skipped",
          reason: "Contact already exist",
        });
        continue;
      }

      // Check last seen
      if (!user.status || !user.status.was_online) {
        console.log(
          `[contacts.bulkCreate] Phone ${c.phone} has no last seen info`
        );
        results.push({
          phone: c.phone,
          status: "skipped",
          reason: "No last seen info",
        });
        continue;
      }

      const lastSeen = user.status.was_online * 1000;
      if (now - lastSeen > THIRTY_DAYS_MS) {
        console.log(
          `[contacts.bulkCreate] Phone ${c.phone} was last active more than 30 days ago`
        );
        results.push({
          phone: c.phone,
          status: "skipped",
          reason: "User inactive for more than 30 days",
        });
        continue;
      }

      // Passed all checks
      validContacts.push({
        phone: c.phone,
        first_name: c.first_name,
        last_name: c.last_name,
      });
      results.push({ phone: c.phone, status: "queued" });
      console.log(`[contacts.bulkCreate] ✓ Phone ${c.phone} queued for import`);
    } catch (err) {
      errorCount++;
      console.error(
        `[contacts.bulkCreate] Error processing phone ${c.phone}:`,
        {
          error_code: err.error_code,
          error_message: err.error_message,
          type: err.constructor?.name,
        }
      );

      // Use enhanced error handling
      const errorResult = handleContactError(err, c.phone);
      results.push(errorResult);

      // Continue processing other contacts instead of stopping
      console.log(`[contacts.bulkCreate] Continuing with next contact...`);
    }

    // Add a small delay to avoid rate limiting
    if (processedCount < contacts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Log summary before import
  console.log(`[contacts.bulkCreate] Processing Summary:`);
  console.log(`  - Total contacts processed: ${processedCount}`);
  console.log(`  - Valid contacts for import: ${validContacts.length}`);
  console.log(`  - Errors encountered: ${errorCount}`);
  console.log(
    `  - Skipped contacts: ${
      results.filter((r) => r.status === "skipped").length
    }`
  );

  // Import valid contacts
  let importResult = null;
  if (validContacts.length > 0) {
    try {
      console.log(
        `[contacts.bulkCreate] Importing ${validContacts.length} valid contacts`
      );
      importResult = await call("contacts.importContacts", {
        contacts: validContacts,
      });
      console.log("[contacts.bulkCreate] Import result:", importResult);

      // Update results for successfully imported contacts
      if (importResult && importResult.imported) {
        const importedPhones = importResult.imported.map(
          (imp) => validContacts[imp.client_id]?.phone
        );
        results.forEach((result) => {
          if (
            result.status === "queued" &&
            importedPhones.includes(result.phone)
          ) {
            result.status = "imported";
            delete result.reason;
          }
        });
      }
    } catch (err) {
      console.error("[contacts.bulkCreate] Failed to import contacts:", {
        error_code: err.error_code,
        error_message: err.error_message,
        type: err.constructor?.name,
      });

      // Mark queued contacts as failed
      results.forEach((result) => {
        if (result.status === "queued") {
          result.status = "import_failed";
          result.reason = err.error_message || "Failed to import contact";
        }
      });

      return res.status(500).json({
        success: false,
        error: "Failed to import contacts",
        details: err.error_message || err.message,
        summary: {
          total: contacts.length,
          processed: processedCount,
          valid: validContacts.length,
          imported: 0,
          errors: errorCount,
        },
        results,
      });
    }
  } else {
    console.log("[contacts.bulkCreate] No valid contacts to import");
  }

  // Final summary
  const summary = {
    total: contacts.length,
    processed: processedCount,
    valid: validContacts.length,
    imported: importResult ? importResult.imported?.length || 0 : 0,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: errorCount,
  };

  console.log(`[contacts.bulkCreate] Final Summary:`, summary);

  if (push_token) {
    await sendExpoPush(
      push_token,
      "Done ✅",
      "Your contacts generator process has completed."
    );
  }

  res.json({
    success: true,
    summary,
    importResult,
    results,
  });
};

// Check if phone numbers are registered on Telegram (without importing)
exports.checkPhones = async (req, res) => {
  console.log("[contacts.checkPhones] called with body:", req.body);
  const { number, generate, phone } = req.body;

  if (!number || !generate || !phone) {
    console.warn("[contacts.checkPhones] Missing required fields");
    return res.status(400).json({
      error: "Missing number, generate, or phone",
    });
  }

  // Generate phone numbers array (same logic as bulkCreate)
  const baseNumber = BigInt(number);
  const phoneNumbers = [];
  for (let i = 0; i < generate; i++) {
    phoneNumbers.push((baseNumber + BigInt(i)).toString());
  }
  console.log(
    `[contacts.checkPhones] Generated ${phoneNumbers.length} phone numbers to check`
  );

  try {
    const { call } = createMTProto(phone);
    const results = [];
    let processedCount = 0;

    console.log(
      `[contacts.checkPhones] Checking ${phoneNumbers.length} phone numbers...`
    );

    for (const phoneNumber of phoneNumbers) {
      processedCount++;
      console.log(
        `[contacts.checkPhones] Checking ${processedCount}/${phoneNumbers.length} - Phone: ${phoneNumber}`
      );

      try {
        const result = await call("contacts.resolvePhone", {
          phone: phoneNumber,
        });

        if (result && result.users && result.users.length > 0) {
          const user = result.users[0];
          results.push({
            phone: phoneNumber,
            hasAccount: true,
            user: {
              id: user.id,
              first_name: user.first_name,
              last_name: user.last_name,
              username: user.username,
              status: user.status,
            },
          });
          console.log(
            `[contacts.checkPhones] ✓ ${phoneNumber} - Has Telegram account`
          );
        } else {
          results.push({
            phone: phoneNumber,
            hasAccount: false,
            reason: "No user data returned",
          });
          console.log(`[contacts.checkPhones] ✗ ${phoneNumber} - No user data`);
        }
      } catch (error) {
        const errorResult = handleContactError(error, phoneNumber);
        results.push({
          phone: phoneNumber,
          hasAccount: false,
          reason: errorResult.reason,
        });
        console.log(
          `[contacts.checkPhones] ✗ ${phoneNumber} - ${errorResult.reason}`
        );
      }

      // Small delay to avoid rate limiting
      if (processedCount < phoneNumbers.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const withAccounts = results.filter((r) => r.hasAccount).length;
    const withoutAccounts = results.filter((r) => !r.hasAccount).length;

    const summary = {
      total: phoneNumbers.length,
      withTelegram: withAccounts,
      withoutTelegram: withoutAccounts,
    };

    console.log(`[contacts.checkPhones] Summary:`, summary);

    res.json({
      success: true,
      summary,
      results,
    });
  } catch (error) {
    console.error("[contacts.checkPhones] Error:", {
      error_code: error.error_code,
      error_message: error.error_message,
      type: error.constructor?.name,
    });

    res.status(500).json({
      success: false,
      error:
        error.error_message || error.message || "Failed to check phone numbers",
    });
  }
};

// Enhanced contacts.get method with session validation
exports.get = async (req, res) => {
  console.log("[contacts.get] === GET CONTACTS REQUEST START ===");
  console.log("[contacts.get] Query params:", req.query);

  const { phone } = req.query;

  if (!phone) {
    console.warn("[contacts.get] No phone number provided");
    return res.status(400).json({
      error: "Phone parameter is required",
      message: "Phone number is required to fetch contacts",
    });
  }

  // Normalize phone number
  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;
  console.log("[contacts.get] Normalized phone:", normalizedPhone);

  try {
    // Create MTProto instance with session validation
    const { call, isAuthenticated } = createMTProto(normalizedPhone);

    // Check if session is authenticated
    if (!isAuthenticated) {
      console.warn("[contacts.get] Session not authenticated");
      return res.status(401).json({
        error: "AUTH_KEY_UNREGISTERED",
        message: "Session not authenticated. Please login again.",
        action: "REAUTH_REQUIRED",
      });
    }

    console.log("[contacts.get] Getting contacts...");

    // Try to get contacts with retry logic for auth errors
    const result = await this.getContactsWithRetry(call, normalizedPhone);

    console.log(
      `[contacts.get] Retrieved ${result.contacts?.length || 0} contacts`
    );

    const responseData = {
      success: true,
      contacts: result.contacts || [],
      users: result.users || [],
      count: result.contacts?.length || 0,
    };

    res.json(responseData);
  } catch (error) {
    console.error("[contacts.get] === GET CONTACTS ERROR ===");
    console.error("[contacts.get] Error details:", {
      error_code: error.error_code,
      error_message: error.error_message,
      type: error.constructor?.name,
      phone: normalizedPhone,
    });

    // Handle specific contact errors
    const errorResponse = this.handleSessionError(error, normalizedPhone);
    res.status(errorResponse.statusCode).json(errorResponse.body);
  }

  console.log("[contacts.get] === GET CONTACTS REQUEST END ===");
};

// Helper method to get contacts with retry logic
exports.getContactsWithRetry = async (call, phone, maxRetries = 2) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `[contacts.getContactsWithRetry] Attempt ${attempt}/${maxRetries}`
      );

      const result = await call("contacts.getContacts", {
        hash: 0,
      });

      return result;
    } catch (error) {
      console.error(
        `[contacts.getContactsWithRetry] Attempt ${attempt} failed:`,
        error.error_message
      );

      // If it's an auth error and we have retries left, try to re-authenticate
      if (
        error.error_message === "AUTH_KEY_UNREGISTERED" &&
        attempt < maxRetries
      ) {
        console.log(
          "[contacts.getContactsWithRetry] Attempting to re-authenticate..."
        );

        // Try to refresh the session
        const refreshed = await this.refreshSession(phone);
        if (!refreshed) {
          throw error; // If refresh fails, throw the original error
        }

        // Create new MTProto instance with refreshed session
        const { call: newCall } = createMTProto(phone);
        call = newCall;
        continue;
      }

      throw error;
    }
  }
};

exports.bulkCreateWithRetry = async (
  phone,
  number,
  name_prefix,
  generate,
  push_token,
  maxRetries = 2
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(
      `[contacts.bulkCreateWithRetry] Attempt ${attempt}/${maxRetries}`
    );

    try {
      // Prepare MTProto first
      let { call, isAuthenticated, logIn } = createMTProto(phone);

      if (!isAuthenticated) {
        console.log(
          "[contacts.bulkCreateWithRetry] Session not authenticated. Attempting to authenticate."
        );
        await logIn({ phone });
        // Re-create to refresh `call`
        ({ call } = createMTProto(phone));
      }

      // Prepare contacts first
      const baseNumber = BigInt(number);
      const contacts = [];

      for (let i = 0; i < generate; i++) {
        contacts.push({
          phone: (baseNumber + BigInt(i)).toString(),
          first_name: name_prefix,
          last_name: (i + 1).toString(),
        });
      }
      console.log(
        `[contacts.bulkCreateWithRetry] Prepared ${contacts.length} contacts`
      );

      // Import directly
      const { imported } = await call("contacts.importContacts", { contacts });

      console.log("[contacts.bulkCreateWithRetry] Import successful.");

      // Push notification afterwards if required
      if (push_token) {
        await sendExpoPush(
          push_token,
          "Done ✅",
          "Your contacts have been successfully imported."
        );
      }

      return { success: true, imported };
    } catch (error) {
      console.error(
        `[contacts.bulkCreateWithRetry] Attempt ${attempt} failed:`,
        { code: error.error_code, message: error.error_message }
      );

      if (
        error.error_message === "AUTH_KEY_UNREGISTERED" &&
        attempt < maxRetries
      ) {
        console.log(
          "[contacts.bulkCreateWithRetry] AUTH_KEY_UNREGISTERED, attempting to refresh."
        );

        // Here you might implement a refresh:
        // e.g. refresh phone's MTProto session
        await refreshMTProtoSession(phone);
        continue;
      }

      // If we exhausted attempts or it's another error, throw it
      throw error;
    }
  }
};

// Helper method to handle contacts-specific errors
exports.handleSessionError = (error, phone) => {
  const errorMessage = error.error_message;
  const errorCode = error.error_code;

  switch (errorMessage) {
    case "AUTH_KEY_UNREGISTERED":
      return {
        statusCode: 401,
        body: {
          error: "AUTH_KEY_UNREGISTERED",
          message: "Your session has expired. Please login again.",
          action: "REAUTH_REQUIRED",
          suggestion: "Please go back to login screen and authenticate again",
        },
      };

    case "SESSION_REVOKED":
      return {
        statusCode: 401,
        body: {
          error: "SESSION_REVOKED",
          message: "Your session has been revoked. Please login again.",
          action: "REAUTH_REQUIRED",
        },
      };

    case "USER_DEACTIVATED":
      return {
        statusCode: 403,
        body: {
          error: "USER_DEACTIVATED",
          message: "Your account has been deactivated.",
          action: "ACCOUNT_ISSUE",
        },
      };

    case "FLOOD_WAIT":
      const waitTime = this.extractFloodWaitTime(error);
      return {
        statusCode: 429,
        body: {
          error: "FLOOD_WAIT",
          message: `Too many requests. Please wait ${waitTime} seconds.`,
          action: "WAIT",
          wait_time: waitTime,
        },
      };

    default:
      return {
        statusCode: 500,
        body: {
          error: errorMessage || "UNKNOWN_ERROR",
          message: "Failed to retrieve contacts. Please try again.",
          action: "RETRY",
          suggestion: "If the problem persists, try logging in again",
        },
      };
  }
};

// Helper method to refresh session (you'll need to implement this based on your session storage)
exports.refreshSession = async (phone) => {
  try {
    console.log(
      "[contacts.refreshSession] Attempting to refresh session for:",
      phone
    );

    // This is where you'd implement session refresh logic
    // You might need to:
    // 1. Check if you have stored session data
    // 2. Try to restore the session
    // 3. If that fails, require re-authentication

    // For now, return false to indicate refresh failed
    // You'll need to implement proper session management
    return false;
  } catch (error) {
    console.error(
      "[contacts.refreshSession] Failed to refresh session:",
      error
    );
    return false;
  }
};

// Helper method to extract flood wait time (reused from auth.js)
exports.extractFloodWaitTime = (error) => {
  const match = error.error_message?.match(/FLOOD_WAIT_(\d+)/);
  return match ? parseInt(match[1]) : 60;
};

// ===== SESSION VALIDATION MIDDLEWARE =====
// You can use this middleware to validate sessions before API calls
exports.validateSession = async (req, res, next) => {
  const { phone } = req.query || req.body;

  if (!phone) {
    return res.status(400).json({
      error: "Phone number required for session validation",
    });
  }

  try {
    const { isAuthenticated } = createMTProto(phone);

    if (!isAuthenticated) {
      return res.status(401).json({
        error: "AUTH_KEY_UNREGISTERED",
        message: "Session not authenticated. Please login again.",
        action: "REAUTH_REQUIRED",
      });
    }

    next();
  } catch (error) {
    console.error("[middleware.validateSession] Error:", error);
    res.status(500).json({
      error: "Session validation failed",
    });
  }
};
