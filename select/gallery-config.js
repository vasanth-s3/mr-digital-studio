// Use the local Worker for localhost and the deployed Worker for hosted pages.
const isLocalGallery = ["localhost", "127.0.0.1"].includes(window.location.hostname);
window.MRDS_GALLERY_CONFIG = Object.freeze({
  workerUrl: isLocalGallery ? "http://localhost:8787" : "https://mrds-drive-gallery-poc.mrvasanthakumar12.workers.dev",
  firebaseProjectId: "mr-studio-photo-gallery",
  // Public Firebase web configuration for email/password and Google admin sign-in.
  firebaseApiKey: "AIzaSyBbKpkhBJ7eW872_RfXD2OIZIU3sO5fPDY",
});
