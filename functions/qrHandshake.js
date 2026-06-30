// ─────────────────────────────────────────────
// functions/qrHandshake.js
// QR code generation & scan verification
// Runs server-side only via Firebase Cloud Functions
// ─────────────────────────────────────────────

const admin = require("firebase-admin");
const crypto = require("crypto");
const { runAntiFraudChecks } = require("./antiFraud");
const { releaseEscrow } = require("./escrow");

// Seller calls this to generate a one-time QR payload
async function generateQR(sellerId, tradeId) {
  const db = admin.firestore();
  const tradeSnap = await db.collection("trades").doc(tradeId).get();
  const trade = tradeSnap.data();

  if (trade.sellerId !== sellerId) throw new Error("UNAUTHORIZED");
  if (trade.status !== "pending") throw new Error("TRADE_NOT_PENDING");
  if (trade.qrVerified) throw new Error("ALREADY_VERIFIED");

  // One-time token — expires in 10 minutes
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await db.collection("trades").doc(tradeId).update({
    qrToken: token,
    qrTokenExpiresAt: expiresAt
  });

  // The QR payload the seller shows on screen
  return {
    payload: JSON.stringify({ tradeId, token }),
    expiresAt
  };
}

// Buyer scans QR and this runs all checks + finalizes trade
async function verifyQRScan(buyerId, qrPayload, scanData) {
  const db = admin.firestore();
  let parsed;

  try {
    parsed = JSON.parse(qrPayload);
  } catch {
    throw new Error("INVALID_QR_PAYLOAD");
  }

  const { tradeId, token } = parsed;
  const tradeRef = db.collection("trades").doc(tradeId);
  const tradeSnap = await tradeRef.get();
  const trade = tradeSnap.data();

  // Validate token
  if (!trade.qrToken || trade.qrToken !== token) throw new Error("INVALID_TOKEN");
  if (new Date() > trade.qrTokenExpiresAt.toDate()) throw new Error("QR_TOKEN_EXPIRED");
  if (trade.buyerId !== buyerId) throw new Error("WRONG_BUYER");
  if (trade.status !== "pending") throw new Error("TRADE_NOT_PENDING");
  if (trade.qrVerified) throw new Error("ALREADY_VERIFIED");

  // Run anti-fraud checks
  const fraudCheck = await runAntiFraudChecks(buyerId, trade.sellerId, scanData);
  if (!fraudCheck.passed) {
    await tradeRef.update({
      fraudAttempt: true,
      fraudErrors: fraudCheck.errors,
      fraudAt: admin.firestore.FieldValue.serverTimestamp()
    });
    throw new Error("FRAUD_DETECTED: " + fraudCheck.errors.join(", "));
  }

  // All checks passed — release escrow, log debt, complete trade
  const result = await releaseEscrow(tradeId);
  return { success: true, ...result };
}

module.exports = { generateQR, verifyQRScan };
