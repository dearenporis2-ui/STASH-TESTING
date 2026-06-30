// ─────────────────────────────────────────────
// functions/index.js
// Firebase Cloud Functions entry point
// All sensitive logic lives here on the server
// ─────────────────────────────────────────────

require("dotenv").config({ path: "../config/.env" });
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { lockEscrow, releaseEscrow, expireEscrow } = require("./escrow");
const { generateQR, verifyQRScan } = require("./qrHandshake");
const { settleDebt, adminCreditGoldBlocks } = require("./debtLedger");

admin.initializeApp();

// ─── Payment Webhook ───
// Mobile money provider pings this when payment succeeds
exports.paymentWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Verify webhook signature from payment provider
  const signature = req.headers["x-webhook-signature"];
  const expected = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== expected) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { userId, goldBlockAmount, transactionId } = req.body;

  try {
    const db = admin.firestore();

    // Idempotency check — prevent double crediting
    const existingTx = await db.collection("gbTransactions")
      .where("transactionId", "==", transactionId).get();
    if (!existingTx.empty) {
      return res.status(200).json({ message: "Already processed" });
    }

    const batch = db.batch();
    batch.update(db.collection("users").doc(userId), {
      goldBlocks: admin.firestore.FieldValue.increment(goldBlockAmount)
    });
    batch.set(db.collection("gbTransactions").doc(), {
      userId, goldBlockAmount, transactionId,
      type: "purchase",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await batch.commit();

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Lock Escrow ───
exports.lockEscrow = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  return await lockEscrow(context.auth.uid, data.listingId, data.goldBlockAmount);
});

// ─── Generate QR ───
exports.generateQR = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  return await generateQR(context.auth.uid, data.tradeId);
});

// ─── Verify QR Scan ───
exports.verifyQRScan = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  return await verifyQRScan(context.auth.uid, data.qrPayload, data.scanData);
});

// ─── Settle Debt (Admin only) ───
exports.settleDebt = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  return await settleDebt(context.auth.uid, data.userId, data.debtId);
});

// ─── Admin Credit Gold Blocks ───
exports.adminCreditGoldBlocks = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  return await adminCreditGoldBlocks(context.auth.uid, data.userId, data.amount, data.note);
});

// ─── Scheduled: Auto-expire stale escrows every hour ───
exports.checkExpiredEscrows = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    const db = admin.firestore();
    const now = new Date();
    const expiredTrades = await db.collection("trades")
      .where("status", "==", "pending")
      .where("expiresAt", "<=", now)
      .get();

    const promises = expiredTrades.docs.map(doc => expireEscrow(doc.id));
    await Promise.all(promises);
    console.log(`Expired ${expiredTrades.size} stale escrows`);
  });
