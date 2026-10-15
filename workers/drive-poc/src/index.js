const SESSION_TTL_SECONDS = 6 * 60 * 60;
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/datastore";
let cachedGoogleToken;
let cachedGoogleTokenExpiresAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      if (request.headers.has("Origin") && !cors["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403, { "Vary": "Origin" });
      return new Response(null, { status: 204, headers: cors });
    }
    if (!cors["Access-Control-Allow-Origin"] && request.headers.has("Origin")) return json({ error: "Origin not allowed" }, 403, cors);

    try {
      if (url.pathname === "/api/session" && request.method === "POST") return await createClientSession(request, env, cors);
      if (url.pathname === "/api/admin/session" && request.method === "POST") return await createAdminSession(request, env, cors);
      if (url.pathname === "/api/admin/projects" && request.method === "GET") {
        await requireSession(request, env, "admin");
        return json({ projects: await listProjects(env) }, 200, { ...cors, "Cache-Control": "no-store" });
      }
      if (url.pathname === "/api/admin/projects" && request.method === "POST") {
        await requireSession(request, env, "admin");
        return await createProject(request, env, cors);
      }
      const projectMatch = url.pathname.match(/^\/api\/admin\/projects\/([A-Za-z0-9_-]+)$/);
      if (projectMatch && request.method === "PUT") {
        await requireSession(request, env, "admin");
        return await updateProjectDetails(projectMatch[1], request, env, cors);
      }
      if (projectMatch && request.method === "PATCH") {
        await requireSession(request, env, "admin");
        return await updateProjectStatus(projectMatch[1], request, env, cors);
      }
      if (projectMatch && request.method === "DELETE") {
        await requireSession(request, env, "admin");
        return await deleteProject(projectMatch[1], env, cors);
      }
      const accessCodeMatch = url.pathname.match(/^\/api\/admin\/projects\/([A-Za-z0-9_-]+)\/access-code$/);
      if (accessCodeMatch && request.method === "POST") {
        await requireSession(request, env, "admin");
        return await rotateClientCode(accessCodeMatch[1], env, cors);
      }
      const selectionLimitMatch = url.pathname.match(/^\/api\/admin\/projects\/([A-Za-z0-9_-]+)\/selection-limit$/);
      if (selectionLimitMatch && request.method === "PATCH") {
        await requireSession(request, env, "admin");
        return await updateSelectionLimit(selectionLimitMatch[1], request, env, cors);
      }
      const resubmissionMatch = url.pathname.match(/^\/api\/admin\/projects\/([A-Za-z0-9_-]+)\/resubmission$/);
      if (resubmissionMatch && request.method === "POST") {
        await requireSession(request, env, "admin");
        return await enableResubmission(resubmissionMatch[1], env, cors);
      }
      const adminResultsMatch = url.pathname.match(/^\/api\/admin\/projects\/([A-Za-z0-9_-]+)\/selections$/);
      if (adminResultsMatch && request.method === "GET") {
        await requireSession(request, env, "admin");
        return json(await getProjectResults(adminResultsMatch[1], env), 200, { ...cors, "Cache-Control": "no-store" });
      }
      if (url.pathname === "/api/photos" && request.method === "GET") {
        const session = await requireSession(request, env, "client");
        await requireActiveProject(session.projectId, env);
        const pageSize = Math.min(60, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "10", 10) || 10));
        const pageToken = url.searchParams.get("pageToken") || "";
        return json(await listPhotoPage(env, session, pageSize, pageToken), 200, { ...cors, "Cache-Control": "no-store" });
      }
      if (url.pathname === "/api/selections" && request.method === "GET") {
        const session = await requireSession(request, env, "client");
        await requireActiveProject(session.projectId, env);
        return json({ selections: await listSelections(env, session) }, 200, { ...cors, "Cache-Control": "no-store" });
      }
      if (url.pathname === "/api/submission" && request.method === "POST") {
        const session = await requireSession(request, env, "client");
        await requireActiveProject(session.projectId, env);
        return await submitSelection(request, env, cors, session);
      }
      if (url.pathname === "/api/submission" && request.method === "GET") {
        const session = await requireSession(request, env, "client");
        await requireActiveProject(session.projectId, env);
        return json(await getSubmissionStatus(env, session), 200, { ...cors, "Cache-Control": "no-store" });
      }
      const selectionMatch = url.pathname.match(/^\/api\/selections\/([A-Za-z0-9_-]+)$/);
      if (selectionMatch && request.method === "PUT") {
        const session = await requireSession(request, env, "client");
        await requireActiveProject(session.projectId, env);
        return await saveSelection(selectionMatch[1], request, env, cors, session);
      }
      const photoMatch = url.pathname.match(/^\/api\/photos\/([A-Za-z0-9_-]+)$/);
      if (photoMatch && request.method === "GET") {
        const session = await requireSession(request, env, "client");
        await requireActiveProject(session.projectId, env);
        return await streamPhoto(photoMatch[1], env, cors, session, url.searchParams.get("size") === "preview");
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      const status = error.status || 500;
      // Keep the client response generic, but expose safe diagnostics in Wrangler's
      // server-side log so upstream failures can be identified without leaking credentials.
      console.error("Worker request failed", {
        path: url.pathname,
        status,
        name: error.name || "Error",
        message: String(error.message || "Unknown error").slice(0, 240),
      });
      return json({ error: status === 500 ? "Photo service is temporarily unavailable" : error.message }, status, cors);
    }
  },
};

async function createClientSession(request, env, cors) {
  const limited = await enforceRateLimit(request, env.CLIENT_CODE_LIMITER, cors);
  if (limited) return limited;
  assertConfigured(env);
  const body = await readJson(request);
  if (!body || typeof body.code !== "string" || body.code.length > 120) return json({ error: "That access code is not valid" }, 401, cors);
  const codeHash = await sign(body.code.trim().toUpperCase(), env.SESSION_SECRET);
  const codeDocument = await getFirestoreDocument(`projectAccessCodes/${codeHash}`, env);
  const projectId = codeDocument?.fields?.projectId?.stringValue;
  if (!projectId || (body.projectId && body.projectId !== projectId)) return json({ error: "That access code is not valid for this gallery link" }, 401, cors);
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project || project.fields?.status?.stringValue !== "active") return json({ error: "This gallery is unavailable" }, 404, cors);
  if (project.fields?.accessCodeHash?.stringValue && project.fields.accessCodeHash.stringValue !== codeHash) {
    return json({ error: "That access code has been replaced. Ask the photographer for the current code." }, 401, cors);
  }
  const fields = project.fields;
  const claims = {
    role: "client",
    projectId,
    folder: fields.driveFolderId.stringValue,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  return createSignedSession(claims, env, cors, {
    clientName: fields.clientName.stringValue,
    projectName: fields.projectName.stringValue,
    submittedAt: fields.submittedAt?.timestampValue || null,
    resubmissionEnabled: fields.resubmissionEnabled?.booleanValue === true,
    selectionLimit: fields.selectionLimit?.integerValue ? Number(fields.selectionLimit.integerValue) : null,
  });
}

async function createAdminSession(request, env, cors) {
  const limited = await enforceRateLimit(request, env.ADMIN_LOGIN_LIMITER, cors);
  if (limited) return limited;
  assertConfigured(env);
  const body = await readJson(request);
  const approvedAdminUids = new Set([
    env.FIREBASE_ADMIN_UID || "",
    ...(env.FIREBASE_ADMIN_UIDS || "").split(","),
  ].map(uid => uid.trim()).filter(Boolean));
  const firebaseAdminConfigured = Boolean(env.FIREBASE_WEB_API_KEY || approvedAdminUids.size);
  if (firebaseAdminConfigured) {
    if (!env.FIREBASE_WEB_API_KEY || !approvedAdminUids.size) {
      return json({ error: "Firebase admin authentication is not fully configured." }, 503, cors);
    }
    if (!body || typeof body.idToken !== "string") return json({ error: "Sign in with the studio Firebase account." }, 401, cors);
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: body.idToken }),
    });
    if (!response.ok) return json({ error: "The studio account could not be verified." }, 401, cors);
    const result = await response.json();
    const user = result.users?.[0];
    if (!user || !approvedAdminUids.has(user.localId) || user.emailVerified !== true) {
      return json({ error: "This verified Firebase account is not authorized for the studio admin." }, 403, cors);
    }
  } else if (!body || typeof body.code !== "string" || !env.ADMIN_ACCESS_CODE || !constantTimeEqual(body.code, env.ADMIN_ACCESS_CODE)) {
    return json({ error: "Admin code is not valid" }, 401, cors);
  }
  return createSignedSession({ role: "admin", exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, env, cors);
}

async function enforceRateLimit(request, limiter, cors) {
  if (!limiter) return null;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown-client";
  const result = await limiter.limit({ key: ip });
  return result.success ? null : json({ error: "Too many sign-in attempts. Wait a minute and try again." }, 429, { ...cors, "Retry-After": "60" });
}

async function createSignedSession(claims, env, cors, project) {
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await sign(payload, env.SESSION_SECRET);
  return json({ token: `${payload}.${signature}`, expiresAt: claims.exp, project }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function requireSession(request, env, role) {
  assertConfigured(env);
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
  if (!match) throw httpError(401, "Your session has expired. Sign in again.");
  const [payload, signature, extra] = match[1].split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, await sign(payload, env.SESSION_SECRET))) {
    throw httpError(401, "Your session has expired. Sign in again.");
  }
  let session;
  try { session = JSON.parse(base64UrlDecode(payload)); } catch { throw httpError(401, "Your session has expired. Sign in again."); }
  if (session.exp <= Math.floor(Date.now() / 1000) || session.role !== role || (role === "client" && (!session.projectId || !session.folder))) {
    throw httpError(401, "Your session has expired. Sign in again.");
  }
  return session;
}

async function createProject(request, env, cors) {
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request" }, 400, cors);
  const clientName = cleanText(body.clientName, 100);
  const projectName = cleanText(body.projectName, 120);
  const clientPhone = cleanText(body.clientPhone, 30);
  const folderId = extractFolderId(body.driveFolder);
  const phoneDigits = clientPhone.replace(/\D/g, "");
  if (!clientPhone || !/^\+?[\d\s().-]+$/.test(clientPhone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
    return json({ error: "Enter a valid client phone number with 7 to 15 digits." }, 400, cors);
  }
  const selectionLimit = body.selectionLimit === null || body.selectionLimit === undefined || body.selectionLimit === ""
    ? null
    : Number(body.selectionLimit);
  if (selectionLimit !== null && (!Number.isSafeInteger(selectionLimit) || selectionLimit < 1 || selectionLimit > 1000)) {
    return json({ error: "The photo selection limit must be a whole number from 1 to 1,000." }, 400, cors);
  }
  if (!clientName || !projectName || !folderId) return json({ error: "Enter a client name, project name, and valid Google Drive folder link or ID." }, 400, cors);

  const googleToken = await googleAccessToken(env);
  const folderParams = new URLSearchParams({ fields: "id,name,mimeType,trashed", supportsAllDrives: "true" });
  const folderResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${folderParams}`, {
    headers: { Authorization: `Bearer ${googleToken}` },
  });
  if (!folderResponse.ok) throw await driveError(folderResponse);
  const folder = await folderResponse.json();
  if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder") return json({ error: "That Drive link does not point to an accessible folder." }, 400, cors);

  const projectId = randomId(12);
  const clientCode = `MRDS-${randomId(16)}`.toUpperCase();
  const codeHash = await sign(clientCode, env.SESSION_SECRET);
  const createdAt = new Date().toISOString();
  const photoCount = await countDrivePhotos(googleToken, folderId);
  const projectFields = {
    clientName: { stringValue: clientName }, clientPhone: { stringValue: clientPhone }, projectName: { stringValue: projectName },
    driveFolderId: { stringValue: folderId }, createdAt: { timestampValue: createdAt }, updatedAt: { timestampValue: createdAt },
    photoCount: { integerValue: String(photoCount) },
    status: { stringValue: "active" }, selectedCount: { integerValue: "0" }, accessCodeHash: { stringValue: codeHash },
  };
  if (selectionLimit !== null) projectFields.selectionLimit = { integerValue: String(selectionLimit) };
  const writes = [
    { update: { name: firestoreDocumentName(`projects/${projectId}`, env), fields: projectFields }, currentDocument: { exists: false } },
    { update: { name: firestoreDocumentName(`projectAccessCodes/${codeHash}`, env), fields: { projectId: { stringValue: projectId } } }, currentDocument: { exists: false } },
  ];
  const commitResponse = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (!commitResponse.ok) throw await firestoreError(commitResponse);
  const clientUrl = new URL(`${env.ALLOWED_ORIGIN.replace(/\/$/, "")}/select`);
  clientUrl.searchParams.set("project", projectId);
  return json({ project: { id: projectId, clientName, clientPhone, projectName, driveFolderName: folder.name, createdAt, selectionLimit }, clientCode, clientUrl: clientUrl.toString() }, 201, { ...cors, "Cache-Control": "no-store" });
}

async function updateProjectDetails(projectId, request, env, cors) {
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid project details." }, 400, cors);
  const clientName = cleanText(body.clientName, 100);
  const projectName = cleanText(body.projectName, 120);
  const clientPhone = cleanText(body.clientPhone, 30);
  const folderId = extractFolderId(body.driveFolder);
  const phoneDigits = clientPhone.replace(/\D/g, "");
  if (!clientName || !projectName || !folderId) return json({ error: "Enter a client name, project name, and valid Google Drive folder link or ID." }, 400, cors);
  if (!clientPhone || !/^\+?[\d\s().-]+$/.test(clientPhone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
    return json({ error: "Enter a valid client phone number with 7 to 15 digits." }, 400, cors);
  }
  const rawLimit = body.selectionLimit;
  const selectionLimit = rawLimit === null || rawLimit === "" ? null : Number(rawLimit);
  if (selectionLimit !== null && (!Number.isSafeInteger(selectionLimit) || selectionLimit < 1 || selectionLimit > 1000)) {
    return json({ error: "The photo selection limit must be a whole number from 1 to 1,000, or blank for no limit." }, 400, cors);
  }

  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project || project.fields?.status?.stringValue === "deleted") throw httpError(404, "Project not found.");
  if (!project.updateTime) throw httpError(409, "This project changed. Refresh the admin page and try again.");
  const session = { projectId, folder: project.fields.driveFolderId?.stringValue || "" };
  const selectedCount = project.fields?.selectedCount?.integerValue !== undefined
    ? Number(project.fields.selectedCount.integerValue)
    : (await listSelections(env, session)).length;
  if (selectionLimit !== null && selectionLimit < selectedCount) {
    return json({ error: `This project already has ${selectedCount} selected photos. Set a limit of at least ${selectedCount}, or remove selections first.` }, 409, cors);
  }

  const token = await googleAccessToken(env);
  const folderParams = new URLSearchParams({ fields: "id,name,mimeType,trashed", supportsAllDrives: "true" });
  const folderResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${folderParams}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!folderResponse.ok) throw await driveError(folderResponse);
  const folder = await folderResponse.json();
  if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder") return json({ error: "That Drive link does not point to an accessible folder." }, 400, cors);

  const updatedAt = new Date().toISOString();
  const photoCount = await countDrivePhotos(token, folderId);
  const selectionLimitValue = selectionLimit === null ? { nullValue: "NULL_VALUE" } : { integerValue: String(selectionLimit) };
  await commitFirestoreWrites(env, token, [{
    update: {
      name: firestoreDocumentName(`projects/${projectId}`, env),
      fields: {
        clientName: { stringValue: clientName },
        clientPhone: { stringValue: clientPhone },
        projectName: { stringValue: projectName },
        driveFolderId: { stringValue: folderId },
        photoCount: { integerValue: String(photoCount) },
        selectionLimit: selectionLimitValue,
        updatedAt: { timestampValue: updatedAt },
      },
    },
    updateMask: { fieldPaths: ["clientName", "clientPhone", "projectName", "driveFolderId", "photoCount", "selectionLimit", "updatedAt"] },
    currentDocument: { updateTime: project.updateTime },
  }]);
  return json({ project: { id: projectId, clientName, clientPhone, projectName, driveFolderName: folder.name, driveFolderId: folderId, photoCount, updatedAt, selectionLimit } }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function rotateClientCode(projectId, env, cors) {
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project || project.fields?.status?.stringValue !== "active") throw httpError(404, "Project not found.");
  if (!project.updateTime) throw httpError(409, "This project changed. Refresh the admin page and try again.");
  const clientCode = `MRDS-${randomId(16)}`.toUpperCase();
  const codeHash = await sign(clientCode, env.SESSION_SECRET);
  const updatedAt = new Date().toISOString();
  const token = await googleAccessToken(env);
  await commitFirestoreWrites(env, token, [{
    update: { name: firestoreDocumentName(`projectAccessCodes/${codeHash}`, env), fields: { projectId: { stringValue: projectId } } },
    currentDocument: { exists: false },
  }, {
    update: { name: firestoreDocumentName(`projects/${projectId}`, env), fields: { accessCodeHash: { stringValue: codeHash }, updatedAt: { timestampValue: updatedAt } } },
    updateMask: { fieldPaths: ["accessCodeHash", "updatedAt"] },
    currentDocument: { updateTime: project.updateTime },
  }]);
  return json({ projectId, clientCode }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function updateProjectStatus(projectId, request, env, cors) {
  const body = await readJson(request);
  if (!body || !["active", "locked"].includes(body.status)) return json({ error: "Project status must be active or locked." }, 400, cors);
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project || project.fields?.status?.stringValue === "deleted") throw httpError(404, "Project not found.");
  if (!project.updateTime) throw httpError(409, "This project changed. Refresh the admin page and try again.");
  const updatedAt = new Date().toISOString();
  const token = await googleAccessToken(env);
  await commitFirestoreWrites(env, token, [{
    update: { name: firestoreDocumentName(`projects/${projectId}`, env), fields: { status: { stringValue: body.status }, updatedAt: { timestampValue: updatedAt } } },
    updateMask: { fieldPaths: ["status", "updatedAt"] },
    currentDocument: { updateTime: project.updateTime },
  }]);
  return json({ projectId, status: body.status, updatedAt }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function deleteProject(projectId, env, cors) {
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project) throw httpError(404, "Project not found.");
  const token = await googleAccessToken(env);
  const selectionParams = new URLSearchParams({ pageSize: "1000" });
  const selectionDocuments = [];
  do {
    const response = await fetch(`${firestoreDocumentUrl(`projects/${projectId}/selections`, env)}?${selectionParams}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await firestoreError(response);
    const result = await response.json();
    selectionDocuments.push(...(result.documents || []));
    if (result.nextPageToken) selectionParams.set("pageToken", result.nextPageToken);
    else selectionParams.delete("pageToken");
  } while (selectionParams.has("pageToken"));

  for (let offset = 0; offset < selectionDocuments.length; offset += 400) {
    await commitFirestoreWrites(env, token, selectionDocuments.slice(offset, offset + 400).map(document => ({ delete: document.name })));
  }
  const deletes = [];
  const codeHash = project.fields?.accessCodeHash?.stringValue;
  if (codeHash) deletes.push({ delete: firestoreDocumentName(`projectAccessCodes/${codeHash}`, env) });
  deletes.push({ delete: firestoreDocumentName(`projects/${projectId}`, env) });
  await commitFirestoreWrites(env, token, deletes);
  return json({ projectId, deleted: true }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function requireActiveProject(projectId, env) {
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project || project.fields?.status?.stringValue !== "active") throw httpError(404, "This gallery is unavailable.");
  return project;
}

async function listProjects(env) {
  const token = await googleAccessToken(env);
  const params = new URLSearchParams({ pageSize: "100" });
  const documents = [];
  do {
    const response = await fetch(`${firestoreDocumentUrl("projects", env)}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await firestoreError(response);
    const result = await response.json();
    documents.push(...(result.documents || []));
    if (result.nextPageToken) params.set("pageToken", result.nextPageToken);
    else params.delete("pageToken");
  } while (params.has("pageToken"));
  const projects = await Promise.all(documents.filter(document => document.fields?.status?.stringValue !== "deleted").map(async document => {
    const fields = document.fields || {};
    const id = document.name.split("/").pop();
    const selectedCount = fields.selectedCount?.integerValue !== undefined
      ? Number(fields.selectedCount.integerValue)
      : (await listSelections(env, { projectId: id })).length;
    const photoCount = await countDrivePhotos(token, fields.driveFolderId?.stringValue || "");
    return {
      id,
      clientName: fields.clientName?.stringValue || "",
      clientPhone: fields.clientPhone?.stringValue || "",
      projectName: fields.projectName?.stringValue || "",
      driveFolderId: fields.driveFolderId?.stringValue || "",
      createdAt: fields.createdAt?.timestampValue || "",
      updatedAt: fields.updatedAt?.timestampValue || document.updateTime || fields.createdAt?.timestampValue || "",
      status: fields.status?.stringValue || "inactive",
      submittedAt: fields.submittedAt?.timestampValue || null,
      resubmissionEnabled: fields.resubmissionEnabled?.booleanValue === true,
      selectedCount,
      photoCount,
      selectionLimit: fields.selectionLimit?.integerValue ? Number(fields.selectionLimit.integerValue) : null,
    };
  }));
  return projects.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function countDrivePhotos(token, folderId) {
  if (!folderId) return 0;
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    pageSize: "1000",
    fields: "files(id,mimeType),nextPageToken",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  let count = 0;
  do {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await driveError(response);
    const result = await response.json();
    count += (result.files || []).filter(file => file.mimeType?.startsWith("image/")).length;
    if (result.nextPageToken) params.set("pageToken", result.nextPageToken);
    else params.delete("pageToken");
  } while (params.has("pageToken"));
  return count;
}

async function listPhotos(env, session) {
  const token = await googleAccessToken(env);
  const params = new URLSearchParams({
    q: `'${session.folder}' in parents and trashed = false`, pageSize: "1000", orderBy: "name",
    fields: "files(id,name,mimeType),nextPageToken", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  });
  const files = [];
  do {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await driveError(response);
    const result = await response.json();
    files.push(...(result.files || []));
    if (result.nextPageToken) params.set("pageToken", result.nextPageToken);
    else params.delete("pageToken");
  } while (params.has("pageToken"));
  return files.filter(file => file.mimeType?.startsWith("image/"))
    .map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType }));
}

async function listPhotoPage(env, session, pageSize, pageToken) {
  const token = await googleAccessToken(env);
  const params = new URLSearchParams({
    q: `'${session.folder}' in parents and trashed = false`,
    pageSize: String(pageSize),
    orderBy: "name",
    fields: "files(id,name,mimeType),nextPageToken",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (pageToken && pageToken.length <= 4096) params.set("pageToken", pageToken);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await driveError(response);
  const result = await response.json();
  return {
    photos: (result.files || []).filter(file => file.mimeType?.startsWith("image/")).map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType })),
    nextPageToken: result.nextPageToken || null,
  };
}

async function streamPhoto(fileId, env, cors, session, preview = false) {
  const token = await googleAccessToken(env);
  const metadata = await getDriveFile(fileId, token);
  if (metadata.trashed || !metadata.parents?.includes(session.folder) || !metadata.mimeType?.startsWith("image/")) {
    throw httpError(404, "Photo not found in this gallery");
  }
  let response;
  if (preview && metadata.thumbnailLink) {
    try {
      const thumbnailUrl = new URL(metadata.thumbnailLink);
      if (thumbnailUrl.protocol === "https:" && (thumbnailUrl.hostname === "googleusercontent.com" || thumbnailUrl.hostname.endsWith(".googleusercontent.com"))) {
        response = await fetch(thumbnailUrl, { headers: { Authorization: `Bearer ${token}` } });
      }
    } catch { /* Fall back to Drive media if the thumbnail is unavailable. */ }
  }
  if (!response?.ok) response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await driveError(response);
  const headers = new Headers(cors);
  headers.set("Content-Type", response.headers.get("Content-Type") || metadata.mimeType);
  headers.set("Cache-Control", preview ? "private, max-age=1800" : "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(metadata.name)}`);
  return new Response(response.body, { status: 200, headers });
}

async function listSelections(env, session) {
  const token = await googleAccessToken(env);
  const params = new URLSearchParams({ pageSize: "1000" });
  const ids = [];
  do {
    const response = await fetch(`${firestoreDocumentUrl(`projects/${session.projectId}/selections`, env)}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await firestoreError(response);
    const result = await response.json();
    ids.push(...(result.documents || []).filter(document => document.fields?.selected?.booleanValue === true).map(document => document.name.split("/").pop()));
    if (result.nextPageToken) params.set("pageToken", result.nextPageToken);
    else params.delete("pageToken");
  } while (params.has("pageToken"));
  return ids;
}

async function saveSelection(fileId, request, env, cors, session) {
  const body = await readJson(request);
  if (!body || typeof body.selected !== "boolean") return json({ error: "Selection value must be true or false" }, 400, cors);
  const token = await googleAccessToken(env);
  const project = await getFirestoreDocument(`projects/${session.projectId}`, env);
  if (project?.fields?.submittedAt?.timestampValue && project.fields?.resubmissionEnabled?.booleanValue !== true) throw httpError(409, "This selection has already been submitted and is locked.");
  const selectionLimit = Number(project?.fields?.selectionLimit?.integerValue || 0);
  if (!project?.updateTime) throw httpError(404, "This gallery is unavailable.");
  const currentCount = project.fields?.selectedCount?.integerValue !== undefined
    ? Number(project.fields.selectedCount.integerValue)
    : (await listSelections(env, session)).length;
  const path = `projects/${session.projectId}/selections/${encodeURIComponent(fileId)}`;
  const existing = await getFirestoreDocument(path, env);
  const wasSelected = existing?.fields?.selected?.booleanValue === true;
  if (body.selected && !wasSelected && selectionLimit && currentCount >= selectionLimit) {
    throw httpError(409, `This gallery allows ${selectionLimit} selected photos. Deselect a photo before choosing another.`);
  }
  if (wasSelected === body.selected) return json({ id: fileId, selected: body.selected, selectedCount: currentCount }, 200, { ...cors, "Cache-Control": "no-store" });
  const photo = await getDriveFile(fileId, token);
  if (photo.trashed || !photo.parents?.includes(session.folder) || !photo.mimeType?.startsWith("image/")) throw httpError(404, "Photo not found in this gallery");
  const selectedCount = Math.max(0, currentCount + (body.selected ? 1 : -1));
  const updatedAt = new Date().toISOString();
  await commitFirestoreWrites(env, token, [{
    update: { name: firestoreDocumentName(path, env), fields: { selected: { booleanValue: body.selected }, updatedAt: { timestampValue: updatedAt } } },
    updateMask: { fieldPaths: ["selected", "updatedAt"] },
  }, {
    update: { name: firestoreDocumentName(`projects/${session.projectId}`, env), fields: { selectedCount: { integerValue: String(selectedCount) }, updatedAt: { timestampValue: updatedAt } } },
    updateMask: { fieldPaths: ["selectedCount", "updatedAt"] },
    currentDocument: { updateTime: project.updateTime },
  }]);
  return json({ id: fileId, selected: body.selected, selectedCount }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function submitSelection(request, env, cors, session) {
  const body = await readJson(request);
  if (!body || body.confirm !== true) return json({ error: "Confirm that you are ready to send your selection." }, 400, cors);
  const project = await getFirestoreDocument(`projects/${session.projectId}`, env);
  if (!project || project.fields?.status?.stringValue !== "active") throw httpError(404, "This gallery is unavailable.");
  if (project.fields?.submittedAt?.timestampValue && project.fields?.resubmissionEnabled?.booleanValue !== true) return json({ submittedAt: project.fields.submittedAt.timestampValue, alreadySubmitted: true, resubmissionEnabled: false }, 200, { ...cors, "Cache-Control": "no-store" });
  const selectedCount = project.fields?.selectedCount?.integerValue !== undefined
    ? Number(project.fields.selectedCount.integerValue)
    : (await listSelections(env, session)).length;
  if (!selectedCount) return json({ error: "Select at least one photo before sending your selection." }, 400, cors);
  const submittedAt = new Date().toISOString();
  const token = await googleAccessToken(env);
  await commitFirestoreWrites(env, token, [{
    update: { name: firestoreDocumentName(`projects/${session.projectId}`, env), fields: { submittedAt: { timestampValue: submittedAt }, selectedCount: { integerValue: String(selectedCount) }, updatedAt: { timestampValue: submittedAt }, resubmissionEnabled: { booleanValue: false } } },
    updateMask: { fieldPaths: ["submittedAt", "selectedCount", "updatedAt", "resubmissionEnabled"] },
    currentDocument: { updateTime: project.updateTime },
  }]);
  return json({ submittedAt, selectedCount, resubmissionEnabled: false }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function getSubmissionStatus(env, session) {
  const project = await getFirestoreDocument(`projects/${session.projectId}`, env);
  if (!project || project.fields?.status?.stringValue !== "active") throw httpError(404, "This gallery is unavailable.");
  return {
    submittedAt: project.fields?.submittedAt?.timestampValue || null,
    resubmissionEnabled: project.fields?.resubmissionEnabled?.booleanValue === true,
  };
}

async function enableResubmission(projectId, env, cors) {
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project || project.fields?.status?.stringValue !== "active") throw httpError(404, "Project not found.");
  if (!project.fields?.submittedAt?.timestampValue) throw httpError(409, "This project has not been submitted yet.");
  if (project.fields?.resubmissionEnabled?.booleanValue === true) {
    return json({ projectId, resubmissionEnabled: true }, 200, { ...cors, "Cache-Control": "no-store" });
  }
  const updatedAt = new Date().toISOString();
  const token = await googleAccessToken(env);
  await commitFirestoreWrites(env, token, [{
    update: { name: firestoreDocumentName(`projects/${projectId}`, env), fields: { resubmissionEnabled: { booleanValue: true }, updatedAt: { timestampValue: updatedAt } } },
    updateMask: { fieldPaths: ["resubmissionEnabled", "updatedAt"] },
    currentDocument: { updateTime: project.updateTime },
  }]);
  return json({ projectId, resubmissionEnabled: true }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function getProjectResults(projectId, env) {
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project) throw httpError(404, "Project not found.");
  const fields = project.fields || {};
  const session = { projectId, folder: fields.driveFolderId?.stringValue || "" };
  const selectedIds = new Set(await listSelections(env, session));
  const photos = await listPhotos(env, session);
  return {
    project: {
      id: projectId,
      clientName: fields.clientName?.stringValue || "",
      projectName: fields.projectName?.stringValue || "",
      submittedAt: fields.submittedAt?.timestampValue || null,
      resubmissionEnabled: fields.resubmissionEnabled?.booleanValue === true,
      selectedCount: selectedIds.size,
      selectionLimit: fields.selectionLimit?.integerValue ? Number(fields.selectionLimit.integerValue) : null,
    },
    photos: photos.filter(photo => selectedIds.has(photo.id)).map(({ id, name }) => ({ id, name })),
  };
}

async function updateSelectionLimit(projectId, request, env, cors) {
  const body = await readJson(request);
  if (!body) {
    return json({ error: "Enter a whole number from 1 to 1,000, or leave it blank for no limit." }, 400, cors);
  }
  const rawLimit = body.selectionLimit;
  const isUnlimited = rawLimit === null || rawLimit === "";
  const selectionLimit = isUnlimited ? null : typeof rawLimit === "number" ? rawLimit : typeof rawLimit === "string" && rawLimit.trim() ? Number(rawLimit) : NaN;
  if (selectionLimit !== null && (!Number.isSafeInteger(selectionLimit) || selectionLimit < 1 || selectionLimit > 1000)) {
    return json({ error: "The photo selection limit must be a whole number from 1 to 1,000, or blank for no limit." }, 400, cors);
  }
  const project = await getFirestoreDocument(`projects/${projectId}`, env);
  if (!project || project.fields?.status?.stringValue !== "active") throw httpError(404, "Project not found.");
  const session = { projectId, folder: project.fields.driveFolderId?.stringValue || "" };
  const selectedCount = project.fields?.selectedCount?.integerValue !== undefined
    ? Number(project.fields.selectedCount.integerValue)
    : (await listSelections(env, session)).length;
  if (selectionLimit !== null && selectionLimit < selectedCount) {
    return json({ error: `This project already has ${selectedCount} selected photos. Set a limit of at least ${selectedCount}, or remove selections first.` }, 409, cors);
  }
  const value = selectionLimit === null ? { nullValue: "NULL_VALUE" } : { integerValue: String(selectionLimit) };
  const token = await googleAccessToken(env);
  await commitFirestoreWrites(env, token, [{
    update: { name: firestoreDocumentName(`projects/${projectId}`, env), fields: { selectionLimit: value, selectedCount: { integerValue: String(selectedCount) }, updatedAt: { timestampValue: new Date().toISOString() } } },
    updateMask: { fieldPaths: ["selectionLimit", "selectedCount", "updatedAt"] },
    currentDocument: { updateTime: project.updateTime },
  }]);
  return json({ selectionLimit, selectedCount }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function getDriveFile(fileId, token) {
  const params = new URLSearchParams({ fields: "id,name,mimeType,parents,trashed,thumbnailLink", supportsAllDrives: "true" });
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await driveError(response);
  return response.json();
}

async function getFirestoreDocument(path, env) {
  const token = await googleAccessToken(env);
  const response = await fetch(firestoreDocumentUrl(path, env), { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw await firestoreError(response);
  return response.json();
}

async function commitFirestoreWrites(env, token, writes) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (!response.ok) throw await firestoreError(response);
}

async function googleAccessToken(env) {
  if (cachedGoogleToken && cachedGoogleTokenExpiresAt > Date.now() + 60_000) return cachedGoogleToken;
  let account;
  try { account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch { throw new Error("Google service account secret is not valid JSON"); }
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: account.private_key_id }));
  const claims = base64UrlEncode(JSON.stringify({ iss: account.client_email, scope: GOOGLE_SCOPES, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const base = `${header}.${claims}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(base));
  const assertion = `${base}.${bytesToBase64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  const result = await response.json();
  cachedGoogleToken = result.access_token;
  cachedGoogleTokenExpiresAt = Date.now() + result.expires_in * 1000;
  return cachedGoogleToken;
}

async function importPrivateKey(pem) {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = (env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Vary": "Origin" };
}

function assertConfigured(env) {
  for (const name of ["FIREBASE_PROJECT_ID", "SESSION_SECRET", "GOOGLE_SERVICE_ACCOUNT_JSON"]) {
    if (!env[name]) throw new Error(`Missing Worker setting: ${name}`);
  }
  if (!env.ALLOWED_ORIGINS && !env.ALLOWED_ORIGIN) throw new Error("Missing Worker setting: ALLOWED_ORIGINS");
}

function firestoreDocumentUrl(path, env) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/${path}`;
}
function firestoreDocumentName(path, env) {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}
function cleanText(value, limit) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, limit) : "";
}
function extractFolderId(value) {
  if (typeof value !== "string") return "";
  const input = value.trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(input)) return input;
  return input.match(/drive\.google\.com\/drive\/folders\/([A-Za-z0-9_-]+)/)?.[1] || "";
}
function randomId(bytesLength) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytesLength)));
}
function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}
function base64UrlEncode(value) { return bytesToBase64Url(new TextEncoder().encode(value)); }
function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
}
function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers } });
}
async function driveError(response) {
  if (response.status === 401 || response.status === 403) return httpError(502, "Drive access failed. Check that the folder is shared with the service account and the Drive API is enabled.");
  if (response.status === 404) return httpError(404, "Photo or Drive folder not found");
  return new Error(`Google Drive request failed (${response.status})`);
}
async function firestoreError(response) {
  if (response.status === 409 || response.status === 412) return httpError(409, "This gallery changed in another request. Refresh the page and try again.");
  if (response.status === 400) {
    try {
      const detail = await response.clone().json();
      if (["ABORTED", "FAILED_PRECONDITION"].includes(detail.error?.status)) {
        return httpError(409, "This gallery changed in another request. Refresh the page and try again.");
      }
    } catch { /* Fall through to the generic Firestore error. */ }
  }
  if (response.status === 401 || response.status === 403) return httpError(502, "Firestore access failed. Grant the Worker service account the Cloud Datastore User role and confirm the project ID.");
  if (response.status === 404) return httpError(404, "Firestore database or document not found");
  return new Error(`Firestore request failed (${response.status})`);
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
