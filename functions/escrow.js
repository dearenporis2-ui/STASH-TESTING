// ─────────────────────────────────────────────
// functions/escrow.js
// Gold Block escrow logic — freeze, refund, penalty
// Runs server-side only via Firebase Cloud Functions
// ─────────────────────────────────────────────

const admin = require("firebase-admin");

const ESCROW_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours

// Freeze buyer's Gold Blocks and reserve listing
async function lockEscrow(buyerId, listingId, goldBlockAmount) {
  const db = admin.firestore();
  const batch = db.batch();

  const userRef = db.collection("users").doc(buyerId);
  const listingRef = db.collection("listings").doc(listingId);
  const tradeRef = db.collection("trades").doc();

  const userSnap = await userRef.get();
  const user = userSnap.data();

  if (user.goldBlocks < goldBlockAmount) {
    throw new Error("INSUFFICIENT_GOLD_BLOCKS");
  }

  // Deduct Gold Blocks from buyer
  batch.update(userRef, {
    goldBlocks: admin.firestore.FieldValue.increment(-goldBlockAmount)
  });

  // Mark listing as reserved
  batch.update(listingRef, {
    status: "reserved",
    reservedBy: buyerId,
    reservedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Create trade document
  const listingSnap = await listingRef.get();
  const listing = listingSnap.data();

  batch.set(tradeRef, {
    buyerId,
    sellerId: listing.sellerId,
    listingId,
    goldBlocksLocked: goldBlockAmount,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: new Date(Date.now() + ESCROW_DURATION_MS),
    qrVerified: false
  });

  await batch.commit();
  return { tradeId: tradeRef.id };
}

// Refund Gold Blocks after successful QR handshake
async function releaseEscrow(tradeId) {
  const db = admin.firestore();
  const tradeRef = db.collection("trades").doc(tradeId);
  const tradeSnap = await tradeRef.get();
  const trade = tradeSnap.data();

  if (trade.status !== "pending") throw new Error("TRADE_ALREADY_SETTLED");
  if (trade.refundProcessed) throw new Error("DOUBLE_REFUND_BLOCKED"); // exploit guard

  const batch = db.batch();

  // Refund 100% Gold Blocks to buyer
  batch.update(db.collection("users").doc(trade.buyerId), {
    goldBlocks: admin.firestore.FieldValue.increment(trade.goldBlocksLocked),
    traderRep: admin.firestore.FieldValue.increment(1)
  });

  // Increment seller rep too
  batch.update(db.collection("users").doc(trade.sellerId), {
    traderRep: admin.firestore.FieldValue.increment(1)
  });

  // Calculate 5% debt on seller
  const listingSnap = await db.collection("listings").doc(trade.listingId).get();
  const listing = listingSnap.data();
  const debtAmount = listing.priceSCR * 0.05;

  batch.update(db.collection("users").doc(trade.sellerId), {
    pendingDebt: admin.firestore.FieldValue.increment(debtAmount),
    accountLocked: true
  });

  // Log debt
  batch.set(db.collection("debtLedger").doc(), {
    userId: trade.sellerId,
    tradeId,
    amountSCR: debtAmount,
    status: "unpaid",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Mark trade complete — set refundProcessed flag to block double refund
  batch.update(tradeRef, {
    status: "completed",
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    refundProcessed: true,
    qrVerified: true
  });

  // Unlist item
  batch.update(db.collection("listings").doc(trade.listingId), {
    status: "sold"
  });

  await batch.commit();
  return { success: true, debtOwed: debtAmount };
}

// Penalize buyer if timer expires without QR scan
async function expireEscrow(tradeId) {
  const db = admin.firestore();
  const tradeRef = db.collection("trades").doc(tradeId);
  const tradeSnap = await tradeRef.get();
  const trade = tradeSnap.data();

  if (trade.status !== "pending") return;
  if (new Date() < trade.expiresAt.toDate()) return; // not expired yet

  const batch = db.batch();

  // Forfeited Gold Blocks go to platform (just don't refund them)
  batch.update(tradeRef, {
    status: "expired",
    expiredAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Re-list item
  batch.update(db.collection("listings").doc(trade.listingId), {
    status: "active",
    reservedBy: null,
    reservedAt: null
  });

  await batch.commit();
  return { success: true, penaltyApplied: trade.goldBlocksLocked };
}

module.exports = { lockEscrow, releaseEscrow, expireEscrow };
