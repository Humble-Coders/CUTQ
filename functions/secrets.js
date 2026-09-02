/**
 * Single place where every Secret Manager parameter is declared.
 *
 * `defineSecret` registers the parameter by name, so declaring the same secret in two
 * modules would register it twice. Both index.js and auth.js import from here instead.
 *
 * Set values with:
 *   firebase functions:secrets:set <NAME> --project cutq-e133a
 */
const {defineSecret} = require("firebase-functions/params");

// Gmail SMTP used for transactional/admin email.
exports.SMTP_USER = defineSecret("SMTP_USER");
exports.SMTP_PASS = defineSecret("SMTP_PASS");

// Pexels stock-photo search used by the admin panel.
exports.PEXELS_API_KEY = defineSecret("PEXELS_API_KEY");

// Fast2SMS DLT API key (customer phone OTP).
exports.FAST2SMS_API_KEY = defineSecret("FAST2SMS_API_KEY");

// 32 random bytes (hex). Derives the OTP itself — rotating it invalidates live OTPs.
exports.OTP_HMAC_SECRET = defineSecret("OTP_HMAC_SECRET");

// 32 random bytes (hex). Hashes phone/ip/install identifiers in rate-limit docs and
// audit rows. Kept separate from OTP_HMAC_SECRET so rotating one does not disturb the
// other (rotating the pepper only resets counters).
exports.OTP_HASH_PEPPER = defineSecret("OTP_HASH_PEPPER");
