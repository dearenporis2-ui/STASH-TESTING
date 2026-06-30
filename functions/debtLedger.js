// ─────────────────────────────────────────────
// functions/debtLedger.js
// 5% platform fee debt tracking & account lockout
// Runs server-side only via Firebase Cloud Functions
// ─────────────────────────────────────────────

const admin = require("firebase-admin");

// Admin settles a seller's debt manually after receiving cash
async function settleDebt(adminId, userId, debtId) {
  const db = admin.firestore();

  // Verify caller is admin
  const adminSnap = await db.collection("users").doc(adminId).get();
  if (!adminSnap.data().isAdmin) throw new Error("UNAUTHORIZED");

  const debtRef = db.collection("debtLedger").doc(debtId);
  const debtSnap = await debtRef.get();
  const debt = debtSnap.data();

  if (debt.userId !== userId) throw new Error("DEBT_USER_MISMATCH");
  if (debt.status === "paid") throw new Error("ALREADY_PAID");

  const batch = db.batch();

  // Mark debt paid
  batch.update(debtRef, {
    status: "paid",
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
    settledByAdmin: adminId
  });

  // Check if user has any remaining unpaid debts
  const unpaidSnap = await db.collection("debtLedger")
    .where("userId", "==", userId)
    .where("status", "==", "unpaid")
    .get();

  // Only unlock account if this was their last unpaid debt
  const remainingUnpaid = unpaidSnap.docs.filter(d => d.id !== debtId);
  if (remainingUnpaid.length === 0) {
    batch.update(db.collection("users").doc(userId), {
      accountLocked: false,
      pendingDebt: 0
    });
  }

  await batch.commit();
  return { success: true, accountUnlocked: remainingUnpaid.length === 0 };
}

// Admin manually credits Gold Blocks (face-to-face cash top-up)
async function adminCreditGoldBlocks(adminId, userId, amount, note) {
  const db = admin.firestore();

  const adminSnap = await db.collection("users").doc(adminId).get();
  if (!adminSnap.data().isAdmin) throw new Error("UNAUTHORIZED");

  const batch = db.batch();

  batch.update(db.collection("users").doc(userId), {
    goldBlocks: admin.firestore.FieldValue.increment(amount)
  });

  batch.set(db.collection("gbTransactions").doc(), {
    userId,
    amount,
    type: "admin_credit",
    note: note || "Face-to-face cash top-up",
    processedBy: adminId,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await batch.commit();
  return { success: true };
}

module.exports = { settleDebt, adminCreditGoldBlocks };
