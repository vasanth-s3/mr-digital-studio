import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

(() => {
  const $ = selector => document.querySelector(selector);
  const config = window.MRDS_GALLERY_CONFIG || {};
  const loginScreen = $("#login-screen");
  const authLoading = $("#auth-loading");
  const adminApp = $("#admin-app");
  const loginForm = $("#login-form");
  const googleLoginButton = $("#google-login");
  const loginStatus = $("#login-status");
  const status = $("#status");
  const projectsElement = $("#projects");
  const projectTable = $(".project-table");
  const projectsPanel = $("#projects-panel");
  const projectCount = $("#project-count");
  const emptyProjects = $("#empty-projects");
  const createdDialog = $("#created-dialog");
  const confirmDialog = $("#confirm-dialog");
  const emailLoginButton = loginForm.querySelector("button[type=submit]");
  let workerUrl = (config.workerUrl || "").replace(/\/$/, "");
  let firebaseAuth = null;
  let firebaseInitError = "";
  let authReady = false;
  let authPersistenceReady = false;
  let authBusy = false;
  let adminToken = "";
  let signedInEmail = "";
  let projectsCache = [];
  let projectsLoaded = false;
  let refreshTimer = null;
  let sortColumn = "updated";
  let sortDirection = "desc";
  let statusTimer;
  let confirmResolver = null;

  try {
    if (!config.firebaseApiKey) throw new Error("Firebase Authentication is not configured yet.");
    const firebaseProjectId = config.firebaseProjectId || "mr-studio-photo-gallery";
    const firebaseApp = initializeApp({
      apiKey: config.firebaseApiKey,
      authDomain: config.firebaseAuthDomain || `${firebaseProjectId}.firebaseapp.com`,
      projectId: firebaseProjectId,
    });
    firebaseAuth = getAuth(firebaseApp);
  } catch (error) {
    firebaseInitError = error.message;
  }

  function updateLoginButtons() {
    const disabled = !authReady || !authPersistenceReady || !firebaseAuth || authBusy;
    emailLoginButton.disabled = disabled;
    googleLoginButton.disabled = disabled;
  }

  function showLogin() {
    authLoading.hidden = true;
    loginScreen.hidden = false;
    adminApp.hidden = true;
  }

  function showAuthLoading() {
    loginScreen.hidden = true;
    adminApp.hidden = true;
    authLoading.hidden = false;
  }

  function confirmAction({ title, message, confirmLabel = "Confirm", danger = false, iconName = "lock" }) {
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-accept").textContent = confirmLabel;
    $("#confirm-accept").classList.toggle("danger-button", danger);
    $("#confirm-icon use").setAttribute("href", `#i-${iconName}`);
    confirmDialog.showModal();
    return new Promise(resolve => { confirmResolver = resolve; });
  }

  function finishConfirmation(accepted) {
    confirmDialog.close();
    confirmResolver?.(accepted);
    confirmResolver = null;
  }

  function setStatus(message, type = "") {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.className = `toast-status ${type}`.trim();
    if (message) statusTimer = window.setTimeout(() => {
      status.textContent = "";
      status.className = "toast-status";
    }, 5000);
  }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
    let response;
    try {
      response = await fetch(`${workerUrl}${path}`, { ...options, headers, cache: "no-store" });
    } catch {
      throw new Error(`The browser could not reach the Worker at ${workerUrl}. Check that Wrangler is running and that this page is opened at http://localhost:8010 (the configured allowed origin).`);
    }
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) {
      const error = new Error(result.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function formatDate(value, includeTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, includeTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" }).format(date);
  }

  function icon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${id}`);
    svg.append(use);
    return svg;
  }

  function makeButton(label, className, dataName, projectId, iconName) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset[dataName] = projectId;
    if (iconName) button.append(icon(iconName));
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    return button;
  }

  async function loadProjects(showMessage = false) {
    const showInitialLoader = !projectsLoaded;
    const loadingStartedAt = performance.now();
    if (showInitialLoader) {
      projectsPanel.setAttribute("aria-busy", "true");
      projectCount.textContent = "Loading…";
      emptyProjects.hidden = true;
      projectsElement.innerHTML = '<tr class="loading-row"><td colspan="8"><span class="loading-spinner" aria-hidden="true"></span><span>Loading project details…</span></td></tr>';
    }
    try {
      const result = await api("/api/admin/projects");
      if (showInitialLoader) {
        const visibleFor = performance.now() - loadingStartedAt;
        if (visibleFor < 450) await new Promise(resolve => window.setTimeout(resolve, 450 - visibleFor));
      }
      projectsCache = result.projects || [];
      projectsLoaded = true;
      renderProjects();
      if (showMessage) setStatus("Project list refreshed.", "success");
    } catch (error) {
      if (!projectsLoaded) {
        projectsElement.replaceChildren();
        projectCount.textContent = "Could not load projects";
        $("#empty-projects h3").textContent = "Projects could not be loaded";
        $("#empty-projects p").textContent = "Use Refresh to try again.";
        emptyProjects.hidden = false;
      }
      throw error;
    } finally {
      projectsPanel.setAttribute("aria-busy", "false");
    }
  }

  function updateSummary() {
    $("#total-projects").textContent = String(projectsCache.length);
    $("#submitted-projects").textContent = String(projectsCache.filter(project => project.submittedAt && !project.resubmissionEnabled).length);
    $("#total-selections").textContent = new Intl.NumberFormat().format(projectsCache.reduce((sum, project) => sum + (Number(project.selectedCount) || 0), 0));
  }

  function sortedProjects(projects) {
    const search = $("#project-search").value.trim().toLocaleLowerCase();
    const statusFilter = $("#project-status-filter").value;
    const found = projects.filter(project => {
      const submitted = Boolean(project.submittedAt) && !project.resubmissionEnabled;
      const statusMatches = statusFilter === "all" || (statusFilter === "submitted"
        ? submitted
        : statusFilter === "reopened"
          ? project.resubmissionEnabled
          : statusFilter === "locked"
            ? project.status === "locked"
            : !project.submittedAt && project.status !== "locked");
      const text = `${project.projectName} ${project.clientName} ${project.id}`.toLocaleLowerCase();
      return statusMatches && text.includes(search);
    });
    const select = $("#project-sort").value;
    const specs = {
      "updated-desc": ["updatedAt", -1], "created-desc": ["createdAt", -1], "created-asc": ["createdAt", 1],
      "name-asc": ["projectName", 1], "name-desc": ["projectName", -1], "photos-desc": ["photoCount", -1],
      "photos-asc": ["photoCount", 1], "selected-desc": ["selectedCount", -1], "selected-asc": ["selectedCount", 1],
    };
    const [key, multiplier] = specs[select] || specs["updated-desc"];
    return found.sort((a, b) => {
      const av = a[key] ?? "";
      const bv = b[key] ?? "";
      if (typeof av === "number" || typeof bv === "number") return ((Number(av) || 0) - (Number(bv) || 0)) * multiplier;
      return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * multiplier;
    });
  }

  function renderProjects() {
    projectsElement.replaceChildren();
    updateSummary();
    const matches = sortedProjects(projectsCache);
    projectCount.textContent = `${matches.length} of ${projectsCache.length} projects`;
    emptyProjects.hidden = matches.length > 0;
    if (!projectsCache.length) $("#empty-projects h3").textContent = "No projects yet";
    else $("#empty-projects h3").textContent = "No matching projects";
    $("#empty-projects p").textContent = projectsCache.length ? "Try changing your search or status filter." : "Create your first gallery to see it listed here.";

    for (const project of matches) {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.dataset.col = "project";
      nameCell.className = "project-name-cell";
      const name = document.createElement("strong");
      name.textContent = project.projectName || "Untitled project";
      const client = document.createElement("span");
      client.textContent = project.clientName || "Client name unavailable";
      nameCell.append(name, client);

      const idCell = document.createElement("td");
      idCell.dataset.col = "projectId";
      const code = document.createElement("code");
      code.textContent = project.id;
      idCell.append(code);

      const dateCell = document.createElement("td");
      dateCell.className = "date-cell";
      dateCell.dataset.col = "dates";
      const created = document.createElement("span");
      created.textContent = `Created ${formatDate(project.createdAt)}`;
      const updated = document.createElement("small");
      updated.textContent = `Updated ${formatDate(project.updatedAt)}`;
      dateCell.append(created, updated);

      const photoCell = document.createElement("td");
      photoCell.dataset.col = "photos";
      photoCell.textContent = new Intl.NumberFormat().format(Number(project.photoCount) || 0);
      const limitCell = document.createElement("td");
      limitCell.className = "limit-cell";
      limitCell.dataset.col = "limit";
      const limitValue = document.createElement("span");
      limitValue.textContent = project.selectionLimit ? `${project.selectionLimit} max` : "Unlimited";
      const limitEditor = document.createElement("div");
      limitEditor.className = "limit-editor";
      limitEditor.hidden = true;
      const limitInput = document.createElement("input");
      limitInput.type = "number";
      limitInput.min = "1";
      limitInput.max = "1000";
      limitInput.step = "1";
      limitInput.placeholder = "Unlimited";
      limitInput.value = project.selectionLimit || "";
      limitInput.dataset.limitInput = project.id;
      const saveLimit = makeButton("Save", "mini-button", "saveLimit", project.id);
      limitEditor.append(limitInput, saveLimit);
      limitCell.append(limitValue, makeButton("Edit", "text-button", "editLimit", project.id, "edit"), limitEditor);

      const selectedCell = document.createElement("td");
      selectedCell.className = "selected-cell";
      selectedCell.dataset.col = "selected";
      const selected = Number(project.selectedCount) || 0;
      selectedCell.textContent = `${selected}${project.selectionLimit ? ` / ${project.selectionLimit}` : ""}`;

      const submissionCell = document.createElement("td");
      submissionCell.dataset.col = "submission";
      const badge = document.createElement("span");
      const isSubmitted = Boolean(project.submittedAt) && !project.resubmissionEnabled;
      badge.className = `status-badge ${project.status === "locked" ? "locked" : project.resubmissionEnabled ? "reopened" : isSubmitted ? "submitted" : "pending"}`;
      badge.textContent = project.status === "locked" ? "Locked" : project.resubmissionEnabled ? "Resubmit enabled" : isSubmitted ? "Submitted" : "Waiting";
      submissionCell.append(badge);
      if (project.submittedAt) {
        const time = document.createElement("small");
        time.className = "submission-time";
        time.textContent = `${project.resubmissionEnabled ? "Last sent" : "Submitted"} ${formatDate(project.submittedAt, true)}`;
        submissionCell.append(time);
      }

      const actionsCell = document.createElement("td");
      actionsCell.className = "actions-cell";
      actionsCell.dataset.col = "actions";
      const actionTrigger = document.createElement("button");
      actionTrigger.type = "button";
      actionTrigger.className = "project-actions-trigger";
      actionTrigger.setAttribute("aria-label", `Actions for ${project.projectName || "project"}`);
      actionTrigger.setAttribute("aria-haspopup", "true");
      actionTrigger.setAttribute("aria-controls", `project-actions-${project.id}`);
      actionTrigger.append(icon("more-vertical"));
      const actionMenu = document.createElement("div");
      actionMenu.id = `project-actions-${project.id}`;
      actionMenu.className = "project-actions-menu";
      actionMenu.setAttribute("popover", "auto");
      actionMenu.setAttribute("aria-label", `Project actions for ${project.projectName || "project"}`);
      actionMenu.addEventListener("toggle", event => {
        const open = event.newState === "open";
        actionTrigger.setAttribute("aria-expanded", String(open));
        if (!open) return;
        const triggerRect = actionTrigger.getBoundingClientRect();
        const menuRect = actionMenu.getBoundingClientRect();
        const left = Math.max(12, Math.min(triggerRect.right - menuRect.width, window.innerWidth - menuRect.width - 12));
        const top = triggerRect.bottom + menuRect.height + 8 > window.innerHeight
          ? Math.max(12, triggerRect.top - menuRect.height - 8)
          : triggerRect.bottom + 4;
        actionMenu.style.left = `${left}px`;
        actionMenu.style.top = `${top}px`;
      });
      actionTrigger.addEventListener("click", () => {
        if (actionMenu.matches(":popover-open")) actionMenu.hidePopover();
        else actionMenu.showPopover();
      });
      actionMenu.append(
        makeButton("CSV", "action-button download-action", "downloadProject", project.id, "download"),
        makeButton("New code", "action-button", "reissueCode", project.id, "lock"),
        makeButton(project.status === "locked" ? "Unlock" : "Lock", "action-button", "toggleProjectLock", project.id, project.status === "locked" ? "unlock" : "lock"),
        makeButton("Delete", "action-button delete-action", "deleteProject", project.id, "trash"),
      );
      if (project.submittedAt) {
        const reopenButton = makeButton(
          project.resubmissionEnabled ? "Enabled" : "Allow resubmit",
          `action-button ${project.resubmissionEnabled ? "reopened-action" : "reopen-action"}`,
          "enableResubmission",
          project.id,
          project.resubmissionEnabled ? "check" : "resubmit",
        );
        reopenButton.disabled = project.resubmissionEnabled;
        actionMenu.append(reopenButton);
      }
      actionsCell.append(actionTrigger, actionMenu);
      row.append(nameCell, idCell, dateCell, photoCell, limitCell, selectedCell, submissionCell, actionsCell);
      projectsElement.append(row);
    }
    applyColumnVisibility();
  }

  function applyColumnVisibility() {
    const visibleColumns = new Set();
    document.querySelectorAll("[data-column-toggle]").forEach(input => {
      if (input.checked) visibleColumns.add(input.dataset.columnToggle);
    });
    projectTable.querySelectorAll("[data-col]").forEach(cell => {
      cell.hidden = !visibleColumns.has(cell.dataset.col);
    });
  }

  const columnPreferencesKey = "mrds-admin-project-columns-v1";
  try {
    const savedColumns = JSON.parse(localStorage.getItem(columnPreferencesKey) || "null");
    if (savedColumns && typeof savedColumns === "object") {
      document.querySelectorAll("[data-column-toggle]").forEach(input => {
        if (typeof savedColumns[input.dataset.columnToggle] === "boolean") input.checked = savedColumns[input.dataset.columnToggle];
      });
    }
  } catch { /* Keep the default columns if saved preferences are unavailable. */ }
  document.querySelectorAll("[data-column-toggle]").forEach(input => input.addEventListener("change", () => {
    const preferences = Object.fromEntries([...document.querySelectorAll("[data-column-toggle]")].map(item => [item.dataset.columnToggle, item.checked]));
    try { localStorage.setItem(columnPreferencesKey, JSON.stringify(preferences)); } catch { /* The current view still updates. */ }
    applyColumnVisibility();
  }));
  applyColumnVisibility();

  const columnPicker = document.querySelector(".column-picker");
  const columnMenu = document.querySelector("#column-menu");
  function positionColumnMenu() {
    if (!columnPicker.open) return;
    const trigger = columnPicker.querySelector("summary").getBoundingClientRect();
    const gap = 8;
    const edge = 12;
    const roomBelow = window.innerHeight - trigger.bottom - gap - edge;
    const roomAbove = trigger.top - gap - edge;
    const menuHeight = Math.min(columnMenu.scrollHeight, 360, window.innerHeight - edge * 2);
    const openAbove = roomBelow < menuHeight && roomAbove > roomBelow;
    const availableHeight = Math.max(0, Math.min(menuHeight, openAbove ? roomAbove : roomBelow));
    const top = openAbove ? trigger.top - availableHeight - gap : trigger.bottom + gap;
    const left = Math.max(edge, Math.min(trigger.right - columnMenu.offsetWidth, window.innerWidth - columnMenu.offsetWidth - edge));
    columnMenu.style.top = `${top}px`;
    columnMenu.style.left = `${left}px`;
    columnMenu.style.maxHeight = `${availableHeight}px`;
  }
  columnPicker.addEventListener("toggle", positionColumnMenu);
  window.addEventListener("resize", positionColumnMenu);
  window.addEventListener("scroll", positionColumnMenu, true);

  function downloadCsv(result) {
    const rows = ["filename", ...result.photos.map(photo => `"${String(photo.name).replace(/"/g, '""')}"`)];
    const blob = new Blob([`\uFEFF${rows.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(result.project.clientName || "project").replace(/[^a-z0-9-_]+/gi, "_")}-selection.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function projectLink(projectId) {
    const link = new URL("/select/worker-poc.html", window.location.origin);
    link.searchParams.set("project", projectId);
    return link.toString();
  }

  async function copyText(value, successMessage) {
    try { await navigator.clipboard.writeText(value); }
    catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("Clipboard access failed. Copy the value manually.");
    }
    setStatus(successMessage, "success");
  }

  async function enterAdminDashboard(user) {
    if (!workerUrl || !/^https?:\/\//i.test(workerUrl)) throw new Error("The Worker URL is missing from gallery-config.js.");
    loginStatus.textContent = "Verifying your approved studio account…";
    const idToken = await user.getIdToken();
    const session = await api("/api/admin/session", { method: "POST", body: JSON.stringify({ idToken }) });
    adminToken = session.token;
    signedInEmail = user.email || "Studio admin";
    $("#admin-password").value = "";
    $("#account-email").textContent = signedInEmail;
    $("#account-avatar").textContent = (signedInEmail[0] || "M").toUpperCase();
    loginScreen.hidden = true;
    authLoading.hidden = true;
    adminApp.hidden = false;
    await loadProjects();
    loginStatus.textContent = "";
    setStatus("Signed in. Your project list is up to date.", "success");
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible" && adminToken) loadProjects().catch(error => setStatus(error.message, "error"));
    }, 60000);
  }

  async function restoreOrValidateAdmin(user) {
    authReady = true;
    if (!user) {
      adminToken = "";
      adminApp.hidden = true;
      showLogin();
      authBusy = false;
      if (!loginStatus.classList.contains("error")) {
        loginStatus.textContent = "Use an approved studio account to sign in.";
        loginStatus.className = "login-status";
      }
      updateLoginButtons();
      return;
    }

    authBusy = true;
    updateLoginButtons();
    loginStatus.textContent = "Restoring your studio session…";
    loginStatus.className = "login-status";
    try {
      if (!user.emailVerified) {
        await sendEmailVerification(user);
        await firebaseSignOut(firebaseAuth);
        loginStatus.textContent = "We sent an email verification link. Verify your address, then sign in again.";
        loginStatus.className = "login-status error";
        return;
      }
      await enterAdminDashboard(user);
    } catch (error) {
      adminToken = "";
      if (adminApp.hidden) {
        showLogin();
        loginStatus.textContent = error.message;
        loginStatus.className = "login-status error";
        if (error.status === 403) await firebaseSignOut(firebaseAuth).catch(() => {});
      } else {
        setStatus(error.message, "error");
      }
    } finally {
      authBusy = false;
      updateLoginButtons();
    }
  }

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!firebaseAuth) return;
    authBusy = true;
    updateLoginButtons();
    loginStatus.textContent = "Signing in with Firebase…";
    loginStatus.className = "login-status";
    try {
      await signInWithEmailAndPassword(firebaseAuth, $("#admin-email").value.trim(), $("#admin-password").value);
    } catch (error) {
      loginStatus.textContent = error.code === "auth/invalid-credential" || error.code === "auth/invalid-login-credentials"
        ? "Email or password is incorrect."
        : error.message || "Email and password sign-in failed.";
      loginStatus.className = "login-status error";
      authBusy = false;
      updateLoginButtons();
    } finally {
      if (!firebaseAuth.currentUser) {
        authBusy = false;
        updateLoginButtons();
      }
    }
  });

  googleLoginButton.addEventListener("click", async () => {
    if (!firebaseAuth) return;
    authBusy = true;
    updateLoginButtons();
    loginStatus.textContent = "Opening secure Google sign-in…";
    loginStatus.className = "login-status";
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(firebaseAuth, provider);
    } catch (error) {
      loginStatus.textContent = error.code === "auth/popup-closed-by-user"
        ? "Google sign-in was cancelled."
        : error.code === "auth/operation-not-allowed"
          ? "Google sign-in is disabled for this Firebase project. In Firebase Console, open Authentication → Sign-in method, enable Google, choose a support email, and save."
        : error.message || "Google sign-in failed.";
      loginStatus.className = "login-status error";
      authBusy = false;
      updateLoginButtons();
    } finally {
      if (!firebaseAuth.currentUser) {
        authBusy = false;
        updateLoginButtons();
      }
    }
  });

  if (!firebaseAuth) {
    authReady = true;
    showLogin();
    loginStatus.textContent = firebaseInitError || "Firebase Authentication could not be initialized.";
    loginStatus.className = "login-status error";
    updateLoginButtons();
  } else {
    showAuthLoading();
    setPersistence(firebaseAuth, browserLocalPersistence).then(() => {
      authPersistenceReady = true;
      onAuthStateChanged(firebaseAuth, user => { void restoreOrValidateAdmin(user); }, error => {
        authReady = true;
        authBusy = false;
        showLogin();
        loginStatus.textContent = error.message || "Could not restore the Firebase login session.";
        loginStatus.className = "login-status error";
        updateLoginButtons();
      });
    }).catch(error => {
      authReady = true;
      showLogin();
      loginStatus.textContent = error.message || "Could not initialize Firebase Authentication.";
      loginStatus.className = "login-status error";
      updateLoginButtons();
    });
  }

  $("#sign-out").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    adminToken = "";
    signedInEmail = "";
    projectsCache = [];
    projectsLoaded = false;
    if (refreshTimer) clearInterval(refreshTimer);
    adminApp.hidden = true;
    loginScreen.hidden = false;
    loginStatus.textContent = "Signing out…";
    loginStatus.className = "login-status";
    try {
      await firebaseSignOut(firebaseAuth);
      loginStatus.textContent = "You have signed out.";
    } catch (error) {
      loginStatus.textContent = error.message || "Could not sign out of Firebase.";
      loginStatus.className = "login-status error";
    } finally {
      button.disabled = false;
    }
  });

  $("#refresh-projects").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await loadProjects(true); }
    catch (error) { setStatus(error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#project-search").addEventListener("input", renderProjects);
  $("#project-status-filter").addEventListener("change", renderProjects);
  $("#project-sort").addEventListener("change", renderProjects);

  document.querySelectorAll(".sort-button").forEach(button => button.addEventListener("click", () => {
    const column = button.dataset.sort;
    const select = $("#project-sort");
    const defaults = { project: "asc", created: "desc", photos: "desc", selected: "desc" };
    if (sortColumn === column) sortDirection = sortDirection === "asc" ? "desc" : "asc";
    else { sortColumn = column; sortDirection = defaults[column] || "desc"; }
    const options = { project: { asc: "name-asc", desc: "name-desc" }, created: { asc: "created-asc", desc: "created-desc" }, photos: { asc: "photos-asc", desc: "photos-desc" }, selected: { asc: "selected-asc", desc: "selected-desc" } };
    select.value = options[column]?.[sortDirection] || "updated-desc";
    renderProjects();
  }));

  projectsElement.addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button === button.closest(".actions-cell")?.querySelector(".project-actions-trigger")) return;
    button.closest(".project-actions-menu")?.hidePopover();
    const id = button.dataset.downloadProject || button.dataset.editLimit || button.dataset.saveLimit || button.dataset.reissueCode || button.dataset.enableResubmission || button.dataset.toggleProjectLock || button.dataset.deleteProject;
    if (button.dataset.editLimit) {
      const editor = button.parentElement.querySelector(".limit-editor");
      editor.hidden = !editor.hidden;
      if (!editor.hidden) editor.querySelector("input").focus();
      return;
    }
    if (button.dataset.saveLimit) {
      const input = projectsElement.querySelector(`[data-limit-input="${CSS.escape(id)}"]`);
      button.disabled = true;
      try {
        const result = await api(`/api/admin/projects/${encodeURIComponent(id)}/selection-limit`, { method: "PATCH", body: JSON.stringify({ selectionLimit: input.value || null }) });
        await loadProjects();
        setStatus(result.selectionLimit ? `Selection limit set to ${result.selectionLimit}.` : "Selection limit removed.", "success");
      } catch (error) { setStatus(error.message, "error"); button.disabled = false; }
      return;
    }
    if (button.dataset.reissueCode) {
      const project = projectsCache.find(item => item.id === id);
      const confirmed = await confirmAction({ title: "Create a new client code?", message: `Replace the client access code for ${project?.projectName || "this project"}? The old code will no longer open new sessions.`, confirmLabel: "Create new code", iconName: "lock" });
      if (!confirmed) return;
      button.disabled = true;
      try {
        const result = await api(`/api/admin/projects/${encodeURIComponent(id)}/access-code`, { method: "POST", body: JSON.stringify({}) });
        $("#client-link").value = projectLink(id);
        $("#client-code").value = result.clientCode;
        $("#client-access-title").textContent = `New client code · ${project?.projectName || "Project"}`;
        createdDialog.showModal();
        await loadProjects();
        setStatus("Replacement access code created. Copy it now; the old code is revoked.", "success");
      } catch (error) { setStatus(error.message, "error"); }
      finally { button.disabled = false; }
      return;
    }
    if (button.dataset.enableResubmission) {
      const project = projectsCache.find(item => item.id === id);
      const confirmed = await confirmAction({ title: "Allow resubmission?", message: `Allow the client to change and submit their selection again for ${project?.projectName || "this project"}? Their current selections and last submission time will be kept.`, confirmLabel: "Allow resubmission", iconName: "resubmit" });
      if (!confirmed) return;
      button.disabled = true;
      try {
        await api(`/api/admin/projects/${encodeURIComponent(id)}/resubmission`, { method: "POST", body: JSON.stringify({}) });
        await loadProjects();
        setStatus("Resubmission enabled. An open client gallery will unlock within about 30 seconds.", "success");
      } catch (error) {
        setStatus(error.message, "error");
        button.disabled = false;
      }
      return;
    }
    if (button.dataset.toggleProjectLock) {
      const project = projectsCache.find(item => item.id === id);
      const nextStatus = project.status === "locked" ? "active" : "locked";
      const verb = nextStatus === "locked" ? "Lock" : "Unlock";
      const confirmed = await confirmAction({
        title: `${verb} this project?`,
        message: nextStatus === "locked"
          ? `Clients will no longer be able to open or use ${project.projectName}. You can unlock it later.`
          : `Clients will be able to open and use ${project.projectName} again.`,
        confirmLabel: verb,
        iconName: nextStatus === "locked" ? "lock" : "unlock",
      });
      if (!confirmed) return;
      button.disabled = true;
      try {
        await api(`/api/admin/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
        await loadProjects();
        setStatus(`Project ${nextStatus === "locked" ? "locked" : "unlocked"}.`, "success");
      } catch (error) { setStatus(error.message, "error"); button.disabled = false; }
      return;
    }
    if (button.dataset.deleteProject) {
      const project = projectsCache.find(item => item.id === id);
      const confirmed = await confirmAction({
        title: "Delete this project permanently?",
        message: `This will delete ${project.projectName}, its client access code, and all saved photo selections. This cannot be undone.`,
        confirmLabel: "Delete project",
        danger: true,
        iconName: "trash",
      });
      if (!confirmed) return;
      button.disabled = true;
      try {
        await api(`/api/admin/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
        await loadProjects();
        setStatus("Project and its saved selections deleted.", "success");
      } catch (error) { setStatus(error.message, "error"); button.disabled = false; }
      return;
    }
    if (button.dataset.downloadProject) {
      button.disabled = true;
      setStatus("Preparing the selected photos CSV…");
      try {
        const result = await api(`/api/admin/projects/${encodeURIComponent(id)}/selections`);
        downloadCsv(result);
        setStatus("Selection CSV downloaded.", "success");
      }
      catch (error) { setStatus(error.message, "error"); }
      finally { button.disabled = false; }
    }
  });

  $("#project-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    setStatus("Checking the Drive folder and creating the gallery…");
    try {
      const result = await api("/api/admin/projects", { method: "POST", body: JSON.stringify({
        clientName: $("#client-name").value,
        projectName: $("#project-name").value,
        driveFolder: $("#drive-folder").value,
        selectionLimit: $("#selection-limit").value || null,
      }) });
      $("#client-link").value = result.clientUrl;
      $("#client-code").value = result.clientCode;
      $("#client-access-title").textContent = `${result.project.clientName} · ${result.project.projectName}`;
      createdDialog.showModal();
      event.currentTarget.reset();
      event.currentTarget.closest("details").open = false;
      await loadProjects();
      setStatus("Gallery created. Copy the one-time client access code now.", "success");
    } catch (error) { setStatus(error.message, "error"); }
    finally { button.disabled = false; }
  });

  $("#close-created").addEventListener("click", () => createdDialog.close());
  $("#done-created").addEventListener("click", () => createdDialog.close());
  createdDialog.addEventListener("click", event => {
    if (event.target === createdDialog) createdDialog.close();
  });
  $("#confirm-cancel").addEventListener("click", () => finishConfirmation(false));
  $("#confirm-accept").addEventListener("click", () => finishConfirmation(true));
  confirmDialog.addEventListener("cancel", event => { event.preventDefault(); finishConfirmation(false); });
  confirmDialog.addEventListener("click", event => {
    if (event.target === confirmDialog) finishConfirmation(false);
  });
  document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
    const input = $(`#${button.dataset.copy}`);
    try { await copyText(input.value, button.dataset.copy === "client-code" ? "Access code copied. Send it through a separate message." : "Gallery link copied."); }
    catch (error) { input.select(); setStatus(error.message, "error"); }
  }));

})();
