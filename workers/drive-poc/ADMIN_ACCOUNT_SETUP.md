# Create the first studio admin account

Admin accounts are Firebase Authentication users. There is intentionally no public sign-up form: a public sign-up would let clients create admin accounts. The Worker allows only the Firebase UID configured as `FIREBASE_ADMIN_UID`.

## One-time Firebase setup

1. Open Firebase Console for the `mr-studio-photo-gallery` project.
2. Go to **Authentication → Sign-in method** and keep **Email/Password** enabled. Enable **Google** as an additional provider and select the studio support email.
3. Go to **Authentication → Users → Add user**. Create the studio owner's email and a strong, unique password. Use a studio-controlled mailbox.
4. Copy the new user's **UID** from the Users table. Do not share the password or commit it to this repository.
5. Open **Project settings → General → Your apps** and copy the Firebase Web API key. This key is intended for browser Firebase Authentication. Never put the Google service-account JSON key in browser config.
6. From the repository, run:

   ```powershell
   cd "D:\develop\MR Digital Studio\mr-digital-studio\workers\drive-poc"
   .\configure-firebase-admin.ps1
   ```

7. Paste the Web API key and the admin UID when prompted. The script writes them to the local Worker `.dev.vars` (ignored by Git) and the public Firebase web config in `select/gallery-config.js`. The UID is the allow-list entry; the password stays only in Firebase Authentication.
8. In **Authentication → Settings → Authorized domains**, make sure `localhost` and the production website hostname are listed.
9. Restart Wrangler. Open `http://localhost:8010/admin`. The login page supports both the existing email/password method and Google. Email/password accounts must verify their email before continuing.

The Worker is the authority for admin access. It checks each Firebase ID token with Firebase Authentication and compares its UID with the explicitly approved `FIREBASE_ADMIN_UID` or comma-separated `FIREBASE_ADMIN_UIDS` allow-list. A Google account not on that list cannot access the dashboard, even if Google sign-in succeeds. To approve an additional account, add its Firebase UID to `FIREBASE_ADMIN_UIDS` in the local `.dev.vars` and production Worker secrets. Keep the previous password login enabled if you want both methods to remain available.

To approve a separate Google account, first enable the Google provider, then attempt its sign-in once. Firebase creates the Authentication user, but the Worker denies dashboard access until that account's UID is added to the allow-list. Copy the UID from **Authentication → Users**, add it to `FIREBASE_ADMIN_UIDS`, and restart Wrangler or update the production Worker secret. Never allow admin access based only on an email domain.

## Add or replace an admin later

Create the new Firebase user in the Console, verify its email, then run the configuration script with that user's UID. Only one UID is authorized at a time. To revoke an admin, configure a different UID and disable/delete the old Firebase user in Authentication.

## Deploying the Worker

For a deployed Worker, set these Worker secrets in its production environment (do not use `.dev.vars` in production):

```text
FIREBASE_WEB_API_KEY
FIREBASE_ADMIN_UID
```

Set them through the Cloudflare dashboard or Wrangler's interactive `wrangler secret put` command. Also update `ALLOWED_ORIGIN` in `wrangler.jsonc` to the exact HTTPS origin serving the studio site. `gallery-config.js` must contain the matching Firebase Web API key and deployed Worker URL.

The admin can sign in with Firebase Email/Password or Google. Firebase Auth uses local browser persistence, and the page restores the saved user before showing the dashboard. The Worker verifies the Firebase ID token, requires an explicitly allow-listed UID and verified email, and issues a short-lived signed admin session. Login attempts are rate limited.

## Plan and usage check

Checked on 14 October 2026: Firebase lists non-phone Authentication services, including social sign-in, as no-cost on the Spark plan. Google sign-in does not use SMS authentication. Provider quotas and plan terms can change, so recheck the [Firebase pricing page](https://firebase.google.com/pricing) and [Authentication limits](https://firebase.google.com/docs/auth/limits) before public launch.
