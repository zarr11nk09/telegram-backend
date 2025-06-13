const createMTProto = require("../mtproto");

// ===== LOGIN METHOD WITH RETRY LOGIC =====
exports.login = async (req, res) => {
  console.log("[auth.login] === LOGIN REQUEST START ===");
  console.log("[auth.login] Request body:", req.body);

  const { phone } = req.body;

  if (!phone) {
    console.warn("[auth.login] ERROR: No phone number provided");
    return res.status(400).json({ error: "Phone number is required" });
  }

  // Normalize phone number (ensure it starts with country code)
  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;
  console.log("[auth.login] Normalized phone:", normalizedPhone);

  // Configuration
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000; // 2 seconds

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[auth.login] Attempt ${attempt}/${MAX_RETRIES}`);

      const { call } = createMTProto(normalizedPhone);
      console.log("[auth.login] MTProto instance created successfully");

      console.log("[auth.login] Calling auth.sendCode...");
      const result = await call("auth.sendCode", {
        phone_number: normalizedPhone,
        settings: { _: "codeSettings" },
      });

      return res.json({
        phone_code_hash: result.phone_code_hash,
        phone: normalizedPhone,
        success: true,
      });
    } catch (error) {
      lastError = error;
      console.error(`[auth.login] Attempt ${attempt} failed`);
      console.error("[auth.login] Error type:", error.constructor.name);
      console.error("[auth.login] Error code:", error.error_code);
      console.error("[auth.login] Error message:", error.error_message);

      // Check if it's a retryable error and we have retries left
      if (this.shouldRetryLogin(error) && attempt < MAX_RETRIES) {
        console.log(
          `[auth.login] Retryable error detected, retrying in ${RETRY_DELAY}ms...`
        );

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        continue;
      }

      // If it's not retryable or we're out of retries, break the loop
      break;
    }
  }

  // If we get here, all retries failed
  console.error("[auth.login] === LOGIN ERROR - ALL RETRIES EXHAUSTED ===");
  console.error("[auth.login] Final error:", lastError);

  // Return appropriate error response
  const errorResponse = this.handleLoginError(lastError, MAX_RETRIES);
  res.status(errorResponse.statusCode).json(errorResponse.body);

  console.log("[auth.login] === LOGIN REQUEST END ===");
};

// ===== VERIFY METHOD WITH COMPREHENSIVE ERROR HANDLING =====
exports.verify = async (req, res) => {
  console.log("[auth.verify] === VERIFY REQUEST START ===");
  console.log("[auth.verify] Request body:", req.body);

  const { phone, code, phone_code_hash } = req.body;

  if (!phone || !code || !phone_code_hash) {
    console.warn("[auth.verify] Missing required fields");
    return res.status(400).json({
      error: "Phone, code, and phone_code_hash are required",
      missing: {
        phone: !phone,
        code: !code,
        phone_code_hash: !phone_code_hash,
      },
    });
  }

  // Normalize phone number
  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;
  console.log("[auth.verify] Normalized phone:", normalizedPhone);

  try {
    const { call } = createMTProto(normalizedPhone);
    console.log("[auth.verify] Calling auth.signIn...");

    const result = await call("auth.signIn", {
      phone_number: normalizedPhone,
      phone_code_hash,
      phone_code: code,
    });

    console.log("[auth.verify] auth.signIn successful");

    // Return user info and session data
    const responseData = {
      success: true,
      user: result.user,
      session: {
        phone: normalizedPhone,
        user_id: result.user?.id,
        access_hash: result.user?.access_hash,
        session_created: new Date().toISOString(),
      },
    };

    res.json(responseData);
  } catch (error) {
    console.error("[auth.verify] === VERIFY ERROR ===");
    console.error("[auth.verify] Error details:", {
      type: error.constructor.name,
      code: error.error_code,
      message: error.error_message,
      phone: normalizedPhone,
      code_length: code?.length,
    });

    // Handle specific verification errors
    const errorResponse = this.handleVerificationError(error, normalizedPhone);

    res.status(errorResponse.statusCode).json(errorResponse.body);
  }

  console.log("[auth.verify] === VERIFY REQUEST END ===");
};

// ===== RESEND CODE METHOD =====
exports.resendCode = async (req, res) => {
  console.log("[auth.resendCode] === RESEND CODE REQUEST START ===");

  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  try {
    // Use the same retry logic as login
    const result = await this.sendVerificationCode(phone);

    res.json({
      success: true,
      phone_code_hash: result.phone_code_hash,
      phone: phone.startsWith("+") ? phone : `+${phone}`,
      message: "New verification code sent",
    });
  } catch (error) {
    console.error("[auth.resendCode] Error:", error);

    const errorResponse = this.handleLoginError(error, 1);
    res.status(errorResponse.statusCode).json({
      ...errorResponse.body,
      message: "Failed to send new verification code",
    });
  }

  console.log("[auth.resendCode] === RESEND CODE REQUEST END ===");
};

// ===== HELPER METHODS =====

// Helper method to determine if login error should trigger retry
exports.shouldRetryLogin = (error) => {
  const retryableErrors = [
    "AUTH_RESTART",
    "NETWORK_MIGRATE",
    "PHONE_MIGRATE",
    "INTERNAL",
  ];

  return (
    retryableErrors.includes(error.error_message) ||
    error.error_code === 500 ||
    error.error_code === -503
  );
};

// Helper method to handle login errors
exports.handleLoginError = (error, attempts) => {
  const errorMessage = error.error_message;
  const errorCode = error.error_code;

  console.error("[auth.handleLoginError] Processing error:", {
    message: errorMessage,
    code: errorCode,
    attempts,
  });

  switch (errorMessage) {
    case "AUTH_RESTART":
      return {
        statusCode: 500,
        body: {
          error: "AUTH_RESTART",
          message: "Authentication session restarted. Please try again.",
          action: "RETRY",
          attempts,
        },
      };

    case "PHONE_NUMBER_INVALID":
      return {
        statusCode: 400,
        body: {
          error: "PHONE_NUMBER_INVALID",
          message:
            "The phone number format is invalid. Please check and try again.",
          action: "CHECK_PHONE_FORMAT",
          suggestion: "Ensure your phone number includes the country code",
        },
      };

    case "PHONE_NUMBER_BANNED":
      return {
        statusCode: 403,
        body: {
          error: "PHONE_NUMBER_BANNED",
          message: "This phone number has been banned from Telegram.",
          action: "CONTACT_SUPPORT",
        },
      };

    case "FLOOD_WAIT":
      const waitTime = this.extractFloodWaitTime(error);
      return {
        statusCode: 429,
        body: {
          error: "FLOOD_WAIT",
          message: `Too many requests. Please wait ${waitTime} seconds before trying again.`,
          action: "WAIT",
          wait_time: waitTime,
        },
      };

    default:
      return {
        statusCode: 500,
        body: {
          error: errorMessage || "UNKNOWN_ERROR",
          message: "Failed to send verification code. Please try again.",
          action: "RETRY",
          attempts,
          suggestion: "If the problem persists, please contact support",
        },
      };
  }
};

// Helper method to handle verification errors
exports.handleVerificationError = (error, phone) => {
  const errorMessage = error.error_message;
  const errorCode = error.error_code;

  switch (errorMessage) {
    case "PHONE_CODE_EXPIRED":
      return {
        statusCode: 400,
        body: {
          error: "PHONE_CODE_EXPIRED",
          message:
            "The verification code has expired. Please request a new code.",
          action: "REQUEST_NEW_CODE",
          suggestion: 'Click "Resend Code" to get a new verification code',
        },
      };

    case "PHONE_CODE_INVALID":
      return {
        statusCode: 400,
        body: {
          error: "PHONE_CODE_INVALID",
          message:
            "The verification code is incorrect. Please check and try again.",
          action: "RETRY_CODE",
          suggestion: "Double-check the code from your SMS/call and try again",
        },
      };

    case "PHONE_CODE_EMPTY":
      return {
        statusCode: 400,
        body: {
          error: "PHONE_CODE_EMPTY",
          message: "Please enter the verification code.",
          action: "ENTER_CODE",
        },
      };

    case "PHONE_NUMBER_UNOCCUPIED":
      return {
        statusCode: 400,
        body: {
          error: "PHONE_NUMBER_UNOCCUPIED",
          message: "This phone number is not registered with Telegram.",
          action: "SIGNUP_REQUIRED",
          suggestion: "You need to sign up for Telegram first",
        },
      };

    case "SESSION_PASSWORD_NEEDED":
      return {
        statusCode: 200, // This is actually a valid next step
        body: {
          error: "SESSION_PASSWORD_NEEDED",
          message:
            "Two-factor authentication is enabled. Please enter your password.",
          action: "REQUIRE_PASSWORD",
          next_step: "password",
        },
      };

    case "FLOOD_WAIT":
      const waitTime = this.extractFloodWaitTime(error);
      return {
        statusCode: 429,
        body: {
          error: "FLOOD_WAIT",
          message: `Too many attempts. Please wait ${waitTime} seconds before trying again.`,
          action: "WAIT",
          wait_time: waitTime,
        },
      };

    default:
      console.error("[auth.verify] Unhandled error:", errorMessage);
      return {
        statusCode: 500,
        body: {
          error: errorMessage || "UNKNOWN_ERROR",
          message: "An unexpected error occurred during verification.",
          action: "RETRY",
          suggestion:
            "Please try again or contact support if the problem persists",
        },
      };
  }
};

// Helper method to extract flood wait time
exports.extractFloodWaitTime = (error) => {
  // Telegram usually includes wait time in error message like "FLOOD_WAIT_X"
  const match = error.error_message?.match(/FLOOD_WAIT_(\d+)/);
  return match ? parseInt(match[1]) : 60; // Default to 60 seconds
};

// Helper method to send verification code (reusable)
exports.sendVerificationCode = async (phone) => {
  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[auth.sendVerificationCode] Attempt ${attempt}/${MAX_RETRIES}`
      );

      const { call } = createMTProto(normalizedPhone);

      const result = await call("auth.sendCode", {
        phone_number: normalizedPhone,
        settings: { _: "codeSettings" },
      });

      console.log("[auth.sendVerificationCode] Success");
      return result;
    } catch (error) {
      console.error(
        `[auth.sendVerificationCode] Attempt ${attempt} failed:`,
        error.error_message
      );

      if (this.shouldRetryLogin(error) && attempt < MAX_RETRIES) {
        console.log(
          `[auth.sendVerificationCode] Retrying in ${RETRY_DELAY}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      throw error;
    }
  }
};
