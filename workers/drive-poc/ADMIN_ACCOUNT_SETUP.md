# Create the first studio admin account

Admin accounts are Firebase Authentication users. There is intentionally no public sign-up form: a public sign-up would let clients create admin accounts. The Worker allows only the Firebase UID configured as `FIREBASE_ADMIN_UID`.

## One-time Firebase setup

1. Open Firebase Console for the `mr-studio-photo-gallery` project.
2. Go to **Authentication → Sign-in method** and enable **Email/Password**.
3. Go to **Authentication → Users → Add user**. Create the studio owner's email and a strong, unique password. Use a studio-controlled mailbox.
4. Copy the new user's **UID** from the Users table. Do not share the password or commit it to this repository.
5. Open **Project settings → General → Your apps** and copy the Firebase Web API key. This key is intended for browser Firebase Authentication. Never put the Google service-account JSON key in browser config.
6. From the repository, run:

   ```powershell
   cd "D:\develop\MR Digital Studio\mr-digital-studio\workers\drive-poc"
   .\configure-firebase-admin.ps1
   ```

7. Paste the Web API key and the admin UID when prompted. The script writes them to the local Worker `.dev.vars` (ignored by Git) and the public Firebase web config in `select/gallery-config.js`. The UID is the allow-list entry; the password stays only in Firebase Authentication.
8. Restart Wrangler. Open `http://localhost:8010/admin`. On the first login, the page sends an email verification link. Verify it, then sign in again.

## Add or replace an admin later

Create the new Firebase user in the Console, verify its email, then run the configuration script with that user's UID. Only one UID is authorized at a time. To revoke an admin, configure a different UID and disable/delete the old Firebase user in Authentication.

## Deploying the Worker

For a deployed Worker, set these Worker secrets in its production environment (do not use `.dev.vars` in production):

```text
FIREBASE_WEB_API_KEY
FIREBASE_ADMIN_UID
```

Set them through the Cloudflare dashboard or Wrangler's interactive `wrangler secret put` command. Also update `ALLOWED_ORIGIN` in `wrangler.jsonc` to the exact HTTPS origin serving the studio site. `gallery-config.js` must contain the matching Firebase Web API key and deployed Worker URL.

The admin signs in with Firebase Email/Password. The Worker verifies the Firebase ID token, requires the configured UID and verified email, and issues a short-lived signed admin session. Login attempts are rate limited.
