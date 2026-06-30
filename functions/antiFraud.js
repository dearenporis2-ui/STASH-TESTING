// ─────────────────────────────────────────────
// functions/antiFraud.js
// Anti-fraud checks for QR handshake verification
// Runs server-side only — never exposed to client
// ─────────────────────────────────────────────

const admin = require("firebase-admin");

const VELOCITY_LIMIT_PER_PEER_PER_DAY = 1;
const MAX_DAILY_TRADES = 10;

async function runAntiFraudChecks(buyerId, sellerId, scanData) {
  const db = admin.firestore();
  const errors = [];

  const [buyerSnap, sellerSnap] = await Promise.all([
    db.collection("users").doc(buyerId).get(),
    db.collection("users").doc(sellerId).get()
  ]);

  const buyer = buyerSnap.data();
  const seller = sellerSnap.data();

  // ─── 1. Device Fingerprint Check ───
  // Block if same device is logged into both accounts
  if (
    scanData.buyerDeviceId &&
    scanData.sellerDeviceId &&
    scanData.buyerDeviceId === scanData.sellerDeviceId
  ) {
    errors.push("DEVICE_FINGERPRINT_MATCH");
  }

  // ─── 2. GPS Spatial Variance Check ───
  // Both devices must be physically close but not identical coords
  if (scanData.buyerGPS && scanData.sellerGPS) {
    const distance = getDistanceMeters(
      scanData.buyerGPS.lat, scanData.buyerGPS.lng,
      scanData.sellerGPS.lat, scanData.sellerGPS.lng
    );
    if (distance < 1) {
      // Exactly same GPS = same device spoofing
      errors.push("GPS_ZERO_DISTANCE");
    }
    if (distance > 500) {
      // More than 500m apart = not a real meetup
      errors.push("GPS_TOO_FAR_APART");
    }
  }

  // ─── 3. IP / Network Check ───
  if (
    scanData.buyerIP &&
    scanData.sellerIP &&
    scanData.buyerIP === scanData.sellerIP
  ) {
    errors.push("SHARED_IP_ADDRESS");
  }

  // Same WiFi BSSID = same router
  if (
    scanData.buyerBSSID &&
    scanData.sellerBSSID &&
    scanData.buyerBSSID === scanData.sellerBSSID
  ) {
    errors.push("SHARED_WIFI_NETWORK");
  }

  // ─── 4. Velocity Throttling ───
  // Check if these two users already traded today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const recentTradeSnap = await db.collection("trades")
    .where("buyerId", "==", buyerId)
    .where("sellerId", "==", sellerId)
    .where("completedAt", ">=", todayStart)
    .get();

  if (recentTradeSnap.size >= VELOCITY_LIMIT_PER_PEER_PER_DAY) {
    errors.push("VELOCITY_LIMIT_EXCEEDED");
  }

  // Check global daily trade cap
  const globalTradesSnap = await db.collection("trades")
    .where("buyerId", "==", buyerId)
    .where("completedAt", ">=", todayStart)
    .get();

  if (globalTradesSnap.size >= MAX_DAILY_TRADES) {
    errors.push("GLOBAL_DAILY_LIMIT_EXCEEDED");
  }

  // ─── 5. Self-trade Check ───
  if (buyerId === sellerId) {
    errors.push("SELF_TRADE_DETECTED");
  }

  return {
    passed: errors.length === 0,
    errors
  };
}

// Haversine formula — distance between two GPS coords in meters
function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * (Math.PI / 180); }

module.exports = { runAntiFraudChecks };
