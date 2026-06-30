// ─────────────────────────────────────────────
// firebase.js — Firebase initialization
// Public config only — safe to commit to GitHub
// API secrets live in /config/.env (never public)
// ─────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyBGRAvfOR1AcTAy6PL65BX11Vgkyydez7c",
  authDomain: "stash-77055.firebaseapp.com",
  projectId: "stash-77055",
  storageBucket: "stash-77055.firebasestorage.app",
  messagingSenderId: "664529545516",
  appId: "1:664529545516:web:3ed4d602071af81e976489"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);