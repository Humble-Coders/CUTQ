const {setGlobalOptions} = require("firebase-functions/v2");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");

setGlobalOptions({maxInstances: 10});

admin.initializeApp();

// ── helpers ───────────────────────────────────────────────────────────────────

function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function randomPassword(length = 8) {
  const all = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += all[bytes[i] % all.length];
  return out;
}

async function getUserProfile(uid) {
  const db = admin.firestore();
  for (const col of ["Users", "users"]) {
    const snap = await db.collection(col).doc(uid).get();
    if (snap.exists) return snap.data();
  }
  return null;
}

function buildEmailHtml(displayName, email, password) {
  const name = displayName || "there";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Your Salon Owner Account</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:#0a0a0a;padding:32px 40px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:10px;">
                <div style="width:10px;height:10px;border-radius:50%;background:#18B79B;display:inline-block;"></div>
                <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">CUTQ</span>
              </div>
              <p style="color:#a1a1aa;font-size:13px;margin:6px 0 0;">Salon Management Platform</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:40px 40px 32px;">
              <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#09090b;">
                Welcome, ${name}!
              </h1>
              <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
                Your salon owner account has been created. You can now sign in to the platform using the credentials below.
              </p>

              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0"
                style="background:#f9fafb;border:1px solid #e4e4e7;border-radius:8px;margin-bottom:28px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:1px;color:#a1a1aa;text-transform:uppercase;">
                      Email
                    </p>
                    <p style="margin:0 0 20px;font-size:15px;color:#18B79B;font-weight:600;">
                      ${email}
                    </p>
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:1px;color:#a1a1aa;text-transform:uppercase;">
                      Temporary Password
                    </p>
                    <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:3px;color:#09090b;font-family:monospace;">
                      ${password}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <a href="#"
                      style="display:inline-block;background:#18B79B;color:#ffffff;font-size:15px;font-weight:600;
                             padding:14px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;">
                      Sign In to CUTQ &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6;">
                For security, please change your password after your first sign-in.
                If you did not expect this email, please contact your administrator.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f4f4f5;padding:20px 40px;text-align:center;border-top:1px solid #e4e4e7;">
              <p style="margin:0;font-size:12px;color:#a1a1aa;">
                This is an automated message from CUTQ Salon Management. Please do not reply to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Cloud Function ────────────────────────────────────────────────────────────

exports.createSalonOwner = onRequest(
  {invoker: "public", secrets: [SMTP_USER, SMTP_PASS]},
  async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({error: {status: "METHOD_NOT_ALLOWED", message: "POST only."}});
      return;
    }

    // Verify Firebase ID token
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({error: {status: "UNAUTHENTICATED", message: "Missing auth token."}});
      return;
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      res.status(401).json({error: {status: "UNAUTHENTICATED", message: "Invalid auth token."}});
      return;
    }

    // Check ADMIN access
    const profile = await getUserProfile(decoded.uid);
    if (!profile || profile.Role !== "ADMIN" || profile.isEnabled !== true) {
      res.status(403).json({error: {status: "PERMISSION_DENIED", message: "Admin access required."}});
      return;
    }

    const data = (req.body && req.body.data) || {};
    const email = String(data.email || "").trim().toLowerCase();
    const name = String(data.name || "").trim();
    const phone = String(data.phone || "").trim();

    if (!email || !email.includes("@")) {
      res.status(400).json({error: {status: "INVALID_ARGUMENT", message: "Valid email is required."}});
      return;
    }

    const smtpUser = SMTP_USER.value();
    const smtpPass = SMTP_PASS.value();

    const password = randomPassword(8);

    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: name || undefined,
        disabled: false,
      });
    } catch (err) {
      logger.error("createUser failed", err);
      res.status(409).json({error: {status: "ALREADY_EXISTS", message: "User already exists or email invalid."}});
      return;
    }

    const uid = userRecord.uid;

    // Write Users doc + send email in parallel
    await Promise.all([
      admin.firestore().collection("Users").doc(uid).set(
        {
          name: name || "",
          phone: phone || "",
          email,
          profile_photo: "",
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          Role: "SALONOWNER",
          isEnabled: true,
        },
        {merge: true},
      ),
      nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {user: smtpUser, pass: smtpPass},
      }).sendMail({
        from: `"CUTQ Salon" <${smtpUser}>`,
        to: email,
        subject: "Your Salon Owner Account — CUTQ",
        text:
          `Hello ${name || "there"},\n\n` +
          "Your salon owner account has been created.\n\n" +
          `Email: ${email}\n` +
          `Temporary password: ${password}\n\n` +
          "Please sign in and change your password.\n",
        html: buildEmailHtml(name, email, password),
      }),
    ]);

    res.status(200).json({result: {uid, email}});
  },
);
