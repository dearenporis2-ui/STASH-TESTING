// ─────────────────────────────────────────────
// cloudinary.js — Cloudinary upload widget
// Cloud name & upload preset are safe to expose
// API Secret stays in /config/.env (never here)
// ─────────────────────────────────────────────

export const CLOUDINARY_CLOUD_NAME = "dflbqacnt";
export const CLOUDINARY_UPLOAD_PRESET = "stash_items"; // make sure this matches exactly in Cloudinary console

// Opens the Cloudinary upload widget and returns the secure image URL
export function openUploadWidget(onSuccess) {
  if (!window.cloudinary) {
    console.error("Cloudinary script not loaded");
    return;
  }
  window.cloudinary.openUploadWidget(
    {
      cloudName: CLOUDINARY_CLOUD_NAME,
      uploadPreset: CLOUDINARY_UPLOAD_PRESET,
      sources: ["local", "camera"],
      multiple: false,
      maxFiles: 1,
      maxFileSize: 5000000, // 5MB max
      allowedFormats: ["jpg", "jpeg", "png", "webp"],
      cropping: true,
      croppingAspectRatio: 1,
      showSkipCropButton: false,
      styles: {
        palette: {
          window: "#111113",
          windowBorder: "#252528",
          tabIcon: "#D4A017",
          menuIcons: "#D4A017",
          textDark: "#ffffff",
          textLight: "#ffffff",
          link: "#D4A017",
          action: "#D4A017",
          inactiveTabIcon: "#666",
          error: "#ff4d4d",
          inProgress: "#D4A017",
          complete: "#2ecc71",
          sourceBg: "#0B0B0C"
        }
      }
    },
    (error, result) => {
      if (!error && result && result.event === "success") {
        onSuccess(result.info.secure_url);
      }
    }
  );
}