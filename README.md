# 🟨 STASH — Setup Guide

## Project Structure
```
stash/
  index.html          → Main app UI
  app.js              → All app logic (Firebase, screens, interactions)
  firebase.js         → Firebase init (safe to commit)
  cloudinary.js       → Cloudinary upload widget (safe to commit)
  styles.css          → All styling
  firestore.rules     → Firestore security rules
  functions/          → Firebase Cloud Functions (backend)
    index.js          → Main entry point
    escrow.js         → Gold Block escrow logic
    antiFraud.js      → GPS, device, IP fraud checks
    qrHandshake.js    → QR generation & verification
    debtLedger.js     → 5% fee & admin tools
  config/             → ⚠️ NEVER commit this folder
    .env.example      → Template (copy to .env and fill in)
```

## Step 1 — Firebase Setup
1. Go to https://console.firebase.google.com
2. Create a new project called "stash"
3. Enable **Authentication** → Email/Password
4. Enable **Firestore Database** → Start in production mode
5. Go to Project Settings → Your Apps → Add Web App
6. Copy the config values into `firebase.js`

## Step 2 — Cloudinary Setup
1. Go to https://cloudinary.com and create an account
2. Dashboard → Copy your **Cloud Name**
3. Settings → Upload → Add Upload Preset → Name it `stash_items`, set to **Unsigned**
4. Replace values in `cloudinary.js`

## Step 3 — Deploy Firestore Rules
```bash
npm install -g firebase-tools
firebase login
firebase init firestore
firebase deploy --only firestore:rules
```

## Step 4 — Deploy Cloud Functions
```bash
cd functions
npm install firebase-admin firebase-functions dotenv
cp ../config/.env.example ../config/.env
# Fill in your .env values
firebase deploy --only functions
```

## Step 5 — Deploy to GitHub Pages
1. Push this folder to your GitHub repo
2. Go to Settings → Pages → Source: main branch / root
3. Your app is live at https://yourusername.github.io/stash

## Currency System
- **SCR** — Seychellois Rupee. Used for all physical item pricing. Never stored or transferred by the app — paid cash in person.
- **🟨 Gold Blocks (GB)** — In-app digital tokens. Purchased from admin (cash → GB), used for cosmetics and trade collateral. Cannot be cashed out.

## How Trades Work
1. Buyer sees listing → clicks Reserve → 100 GB frozen as collateral
2. 48-hour window for meetup at Safe Zone
3. Seller generates QR → Buyer scans it
4. Backend runs GPS + device + IP fraud checks
5. On success: GB refunded to buyer, 5% SCR debt logged on seller, Trader Rep +1 for both
6. On timeout: Buyer forfeits GB as flake penalty, item re-listed

## Admin Tools
1. Set your account as admin in Firestore: `users/{your_uid}` → `isAdmin: true`
2. Admin Panel appears in sidebar
3. Use it to manually credit GB (face-to-face cash top-ups) and settle seller debts
