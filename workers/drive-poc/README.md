# Drive gallery and project admin proof of concept

This project provides the working gallery, photographer admin, Google Drive proxy, and Firestore selection API. Local development is ready. Before a public launch, finish the Firebase admin setup and replace the localhost URLs/origin with the live site and Worker URLs.

## Services and access

- Drive images remain in Google Drive. The service account needs Viewer access to each project folder.
- Firestore stores project metadata, HMAC hashes of client access codes, and selections. It does not store the images.
- The service account needs **Cloud Datastore User** (`roles/datastore.user`) on Google Cloud project `mr-studio-photo-gallery`.
- Firestore REST calls using the service account are authorized by Google Cloud IAM and bypass Firestore Security Rules. The Worker validates codes and scopes signed client sessions to a project; production admin requests also require a verified Firebase account whose UID matches the configured studio UID.
- Firebase Authentication secures the admin login with Google or the existing email/password provider. The Worker accepts only explicitly allow-listed Firebase UIDs; the old shared admin code is a local-only fallback when Firebase admin configuration is absent.
- The Firebase Web API key in `select/gallery-config.js` is public app configuration; it is not a credential for Google Drive or Firestore. Restrict it to Firebase APIs and apply reasonable Identity Toolkit quotas.

The dedicated admin dashboard is at `/admin`. Create the first Firebase admin account and authorize its UID by following [ADMIN_ACCOUNT_SETUP.md](./ADMIN_ACCOUNT_SETUP.md). There is no public admin sign-up form.

## Local setup

The service-account JSON key and Worker secrets belong in the ignored `workers/drive-poc/.dev.vars` file. Do not commit it or paste its contents into chat.

If you have not created the local secrets file yet, run:

```powershell
.\setup-local-secrets.ps1
```

The script asks for the key path and writes the private key locally. It prints a random local admin code once; keep that code private. Run it only for a fresh local setup with no `.dev.vars` yet: it generates a new session secret, so rerunning it invalidates existing client codes.

If you lost the local admin code but still have `.dev.vars`, run `.eset-local-admin-code.ps1` from this folder. It changes only `ADMIN_ACCESS_CODE`; it preserves the session secret and existing client codes. If Firebase admin sign-in is configured, use that Firebase account instead.

Start the static site from the repository root:

```powershell
$env:PORT = 8010
node server.js
```

Start or restart the Worker from `workers/drive-poc`:

```powershell
npx wrangler dev --port 8787
```

Use `http://localhost:8010/admin`:

1. Sign in with Worker URL `http://localhost:8787` and the local admin code.
2. Enter client name, project name, and the Drive folder URL or folder ID.
3. Create the project. The Worker confirms that the service account can read the folder.
4. Copy the generated client link and one-time code. Store/send the code separately; only its HMAC hash is saved in Firestore, so the original code cannot be recovered later. If it is lost, sign in to Admin and use **REISSUE CLIENT CODE** on that project; the previous code will no longer start a new session and saved selections remain.
5. The client opens the link, enters the code, and can select images in the folder. A configured selection limit is enforced in the gallery and Worker. Drive listing is paginated (up to 1,000 files per page).

The page origin must exactly match `ALLOWED_ORIGIN` in `wrangler.jsonc` (`http://localhost:8010`). The Worker address is configured in `select/gallery-config.js`. New client links contain their project ID, so the client only enters the access code. The gallery fetches thumbnails as cards approach the screen and requests the original only when a client opens the lightbox.

## Enable the production admin login

1. In Firebase Console, enable **Authentication → Sign-in method → Email/Password**.
2. Create the studio admin account, verify its email, and copy its Firebase UID from the Users list.
3. Copy the Web API key from Firebase Project settings → General → Web app configuration. It is public configuration, but restrict the key to Firebase APIs.
4. From `workers/drive-poc`, run `.configure-firebase-admin.ps1` and enter the Web API key and admin UID when prompted. It updates `select/gallery-config.js` and the ignored `.dev.vars` without rotating the existing session secret or client codes; it does not print either value.
5. Restart Wrangler. For deployment, set `FIREBASE_WEB_API_KEY` and `FIREBASE_ADMIN_UID` as Worker secrets with Wrangler too. When both are configured, the Worker accepts only a verified Firebase ID whose UID exactly matches `FIREBASE_ADMIN_UID`.

## Deploy

1. Deploy the Worker with `npx wrangler login` and `npx wrangler deploy` from `workers/drive-poc`.
2. Before deploying, change `ALLOWED_ORIGIN` in `wrangler.jsonc` to the exact HTTPS origin serving the studio website. Keep the `FIREBASE_PROJECT_ID` value aligned with the Firestore project.
3. Set Worker secrets `GOOGLE_SERVICE_ACCOUNT_JSON`, `SESSION_SECRET`, `FIREBASE_WEB_API_KEY`, and `FIREBASE_ADMIN_UID` using `npx wrangler secret put SECRET_NAME`. Do not commit the JSON key or `.dev.vars`.
4. Set `workerUrl` in `select/gallery-config.js` to the deployed `https://…workers.dev` URL (or the Worker custom domain), then publish the updated static site through the studio's existing hosting provider.
5. Confirm the exact hosted origin is in `ALLOWED_ORIGIN`, then complete the manual checklist below on the published site.

Cloudflare login, Worker deployment, the public site hostname, and the hosting provider are account-specific. The repository does not contain those account details, so the deploy commands above require the studio owner to run them while signed in to the correct accounts.

## Manual launch checklist

- Sign into the admin with the verified Firebase studio account; confirm a different Firebase account is denied.
- Create a test project from a private Drive folder; confirm the service account is a Viewer and that the folder itself has no public link access.
- Open the generated client link, enter the one-time code, and confirm an incorrect code and a code paired with another project's link are rejected.
- Check the complete photo list, lazy preview loading, full-size lightbox, selection state after refresh/reopen, and selection cap (including attempting a second choice at the cap).
- Confirm a selection can be submitted once, later edits are rejected, and the admin sees the submitted filenames and downloads a readable CSV.
- Test on a phone and on a slow connection. Check a large gallery before inviting a client.

Cloudflare's rate-limit binding reduces repeated sign-in attempts per Cloudflare location; it is not a globally exact request counter. Client access codes are random and project-scoped, and admin access additionally requires the verified Firebase UID.

## Firestore documents

```text
projects/{randomProjectId}
  clientName, projectName, driveFolderId, photoCount, selectionLimit (optional), createdAt, updatedAt, status, submittedAt, selectedCount

projectAccessCodes/{HMAC-SHA256(code, SESSION_SECRET)}
  projectId

projects/{randomProjectId}/selections/{driveFileId}
  selected, updatedAt
```

The raw client access code is returned only at project creation. In production, admin sign-in uses Firebase Authentication and a single configured Firebase UID. The local shared admin code is only for development.

## API outline

- `POST /api/admin/session` validates a Firebase ID token (production) or exchanges the local admin code (local fallback) for a signed admin session.
- `GET /api/admin/projects` lists project metadata.
- `POST /api/admin/projects` verifies a Drive folder and atomically creates project and hashed-code documents.
- `PATCH /api/admin/projects/:projectId/selection-limit` changes or removes a project's optional photo limit, refusing limits below the current number selected.
- `POST /api/admin/projects/:projectId/resubmission` allows the client to edit and submit an already submitted selection again; existing photo choices and the last submission time remain available.
- `GET /api/admin/projects/:projectId/selections` returns selected filenames for the admin page.
- `POST /api/session` exchanges a project client code for a signed, project-scoped session.
- `GET /api/photos`, `GET /api/photos/:fileId` list and stream images only from the session's Drive folder; `?size=preview` proxies Drive thumbnails for gallery cards.
- `GET /api/selections`, `PUT /api/selections/:fileId` read and save project-specific selection flags.
- `POST /api/submission` records the final submission time and selected count; subsequent selection changes are rejected.
- `GET /api/submission` returns the current lock/resubmission state so an already-open client gallery can update when the photographer reopens it.

The client can submit and lock a final selection. Selection changes, submission, and selection-limit changes use Firestore preconditions so competing requests cannot silently bypass the limit or change a submitted gallery.

The admin project list loads all Firestore pages, supports client/project name search and submission-status filters, and refreshes periodically while the admin tab is visible.
