(() => {
  const form = document.getElementById("connect-form");
  const status = document.getElementById("status");
  const photosElement = document.getElementById("photos");
  const summary = document.getElementById("selection-summary");
  const galleryTitle = document.getElementById("gallery-title");
  const gallerySubtitle = document.getElementById("gallery-subtitle");
  const submitPanel = document.getElementById("submit-panel");
  const submitButton = document.getElementById("submit-selection");
  const submitMessage = document.getElementById("submit-message");
  const viewer = document.getElementById("photo-viewer");
  const viewerImage = document.getElementById("viewer-image");
  const viewerFilename = document.getElementById("viewer-filename");
  const viewerCounter = document.getElementById("viewer-counter");
  const viewerSelect = document.getElementById("viewer-select");
  const galleryTools = document.getElementById("gallery-tools");
  const photoSearch = document.getElementById("photo-search");
  const photoSort = document.getElementById("photo-sort");
  const visibleCount = document.getElementById("visible-count");
  const galleryLinkParams = new URLSearchParams(window.location.search);
  const configuredWorkerUrl = window.MRDS_GALLERY_CONFIG?.workerUrl || "";
  document.getElementById("worker-url").value = configuredWorkerUrl;
  const linkedProjectId = galleryLinkParams.get("project") || "";
  let workerUrl = "";
  let sessionToken = "";
  let photos = [];
  let selected = new Set();
  let submittedAt = null;
  let resubmissionEnabled = false;
  let pendingSaves = 0;
  let selectionLimit = null;
  let viewerIndex = -1;
  let viewerPhotoId = "";
  let viewerFullUrl = "";
  let viewerRequestId = 0;
  let imageGeneration = 0;
  const imageQueue = [];
  let activeImageLoads = 0;
  const maxConcurrentImageLoads = 4;
  const previewObserver = "IntersectionObserver" in window
    ? new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const image = entry.target;
      previewObserver.unobserve(image);
      queuePreview(image._photo, image, image._generation);
    }), { rootMargin: "500px 0px" })
    : null;

  function setStatus(message, type = "") {
    status.textContent = message;
    status.className = `status ${type}`.trim();
  }

  async function refreshSubmissionStatus() {
    if (!sessionToken || !submittedAt) return;
    try {
      const response = await fetch(`${workerUrl}/api/submission`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const latest = await response.json();
      const wasReopened = resubmissionEnabled;
      const wasLocked = Boolean(submittedAt) && !resubmissionEnabled;
      submittedAt = latest.submittedAt || null;
      resubmissionEnabled = latest.resubmissionEnabled === true;
      const isLocked = Boolean(submittedAt) && !resubmissionEnabled;
      if (wasLocked !== isLocked || wasReopened !== resubmissionEnabled) {
        renderSelectionState();
        submitButton.hidden = isLocked;
        if (resubmissionEnabled) {
          submitButton.textContent = "RESUBMIT UPDATED SELECTION";
          submitMessage.textContent = "The photographer reopened your gallery. You can update your choices and send the selection again.";
          setStatus("The photographer reopened your gallery. You can now update your selection.", "success");
        } else if (isLocked) {
          submitMessage.textContent = `Selection submitted on ${new Date(submittedAt).toLocaleString()}. Your choices are now locked.`;
          submitButton.textContent = "SEND SELECTION";
          setStatus("Your selection has been submitted and locked.", "success");
        }
      }
    } catch {
      // A transient status refresh failure should not interrupt gallery browsing.
    }
  }

  function renderSelectionState() {
    summary.textContent = selectionLimit
      ? `${selected.size} / ${selectionLimit} selected${selected.size >= selectionLimit ? " · limit reached" : ""} · changes save automatically`
      : `${selected.size} selected · changes save to Firestore automatically`;
    photosElement.querySelectorAll(".photo").forEach(figure => {
      const photoId = figure.dataset.photoId;
      const isSelected = selected.has(photoId);
      figure.classList.toggle("is-selected", isSelected);
      const button = figure.querySelector(".selection-toggle");
      button.textContent = isSelected ? "✓  SELECTED" : "+  SELECT PHOTO";
      button.setAttribute("aria-pressed", String(isSelected));
      button.disabled = Boolean(submittedAt) && !resubmissionEnabled || pendingSaves > 0;
    });
    renderGallery();
    renderViewerSelectionState();
  }

  function visiblePhotos() {
    const query = photoSearch.value.trim().toLocaleLowerCase();
    return photos.filter(photo => photo.name.toLocaleLowerCase().includes(query));
  }

  function renderGallery() {
    const currentViewerId = viewer.open && photos[viewerIndex] ? photos[viewerIndex].id : null;
    const mode = photoSort.value;
    photos.sort((left, right) => {
      if (mode === "selected" && selected.has(left.id) !== selected.has(right.id)) return selected.has(left.id) ? -1 : 1;
      const byName = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      return mode === "name-desc" ? -byName : byName;
    });
    const query = photoSearch.value.trim().toLocaleLowerCase();
    photos.forEach(photo => {
      const card = photosElement.querySelector(`[data-photo-id="${CSS.escape(photo.id)}"]`);
      if (!card) return;
      card.hidden = !photo.name.toLocaleLowerCase().includes(query);
      photosElement.append(card);
    });
    if (currentViewerId) {
      viewerIndex = photos.findIndex(photo => photo.id === currentViewerId);
      renderViewer();
    }
    const count = visiblePhotos().length;
    visibleCount.textContent = `${count} of ${photos.length} photos`;
  }

  function renderViewer() {
    const currentPhotos = visiblePhotos();
    const photo = currentPhotos[viewerIndex];
    if (!photo) return;
    const cardImage = photosElement.querySelector(`[data-photo-id="${CSS.escape(photo.id)}"] img`);
    if (photo.id !== viewerPhotoId) {
      viewerRequestId += 1;
      if (viewerFullUrl) URL.revokeObjectURL(viewerFullUrl);
      viewerFullUrl = "";
      viewerPhotoId = photo.id;
      viewerImage.src = cardImage?.src || "";
      loadFullViewerPhoto(photo, viewerRequestId);
    } else if (viewerFullUrl) {
      viewerImage.src = viewerFullUrl;
    } else if (cardImage?.src) {
      viewerImage.src = cardImage.src;
    }
    viewerImage.alt = photo.name;
    viewerFilename.textContent = photo.name;
    viewerCounter.textContent = `${viewerIndex + 1} of ${currentPhotos.length}`;
    renderViewerSelectionState();
  }

  async function loadFullViewerPhoto(photo, requestId) {
    try {
      const response = await fetch(`${workerUrl}/api/photos/${encodeURIComponent(photo.id)}`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) return;
      const fullUrl = URL.createObjectURL(await response.blob());
      if (!viewer.open || viewerPhotoId !== photo.id || requestId !== viewerRequestId) {
        URL.revokeObjectURL(fullUrl);
        return;
      }
      if (viewerFullUrl) URL.revokeObjectURL(viewerFullUrl);
      viewerFullUrl = fullUrl;
      viewerImage.src = fullUrl;
    } catch {
      // The preview remains visible if the original cannot be loaded.
    }
  }

  function renderViewerSelectionState() {
    const currentPhotos = visiblePhotos();
    if (viewerIndex < 0 || !currentPhotos[viewerIndex]) return;
    const isSelected = selected.has(currentPhotos[viewerIndex].id);
    viewerSelect.textContent = isSelected ? "✓  SELECTED" : "+  SELECT PHOTO";
    viewerSelect.classList.toggle("is-selected", isSelected);
    viewerSelect.setAttribute("aria-pressed", String(isSelected));
    viewerSelect.disabled = Boolean(submittedAt) && !resubmissionEnabled || pendingSaves > 0;
  }

  function openViewer(photo) {
    viewerIndex = visiblePhotos().findIndex(item => item.id === photo.id);
    if (viewerIndex < 0) return;
    viewer.showModal();
    renderViewer();
  }

  function moveViewer(direction) {
    const count = visiblePhotos().length;
    if (!count) return;
    viewerIndex = (viewerIndex + direction + count) % count;
    renderViewer();
  }

  async function toggleSelection(photo, button) {
    const wasSelected = selected.has(photo.id);
    if (!wasSelected && selectionLimit && selected.size >= selectionLimit) {
      setStatus(`This gallery allows ${selectionLimit} selected photos. Deselect a photo before choosing another.`, "error");
      return;
    }
    wasSelected ? selected.delete(photo.id) : selected.add(photo.id);
    pendingSaves += 1;
    submitButton.disabled = true;
    button.disabled = true;
    renderSelectionState();
    setStatus(`Saving ${photo.name} selection…`);
    try {
      const response = await fetch(`${workerUrl}/api/selections/${encodeURIComponent(photo.id)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ selected: !wasSelected }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save this selection");
      setStatus("Selection saved to Firestore.", "success");
    } catch (error) {
      wasSelected ? selected.add(photo.id) : selected.delete(photo.id);
      renderSelectionState();
      setStatus(error.message || "Could not save this selection.", "error");
    } finally {
      pendingSaves -= 1;
      button.disabled = Boolean(submittedAt) && !resubmissionEnabled || pendingSaves > 0;
      submitButton.disabled = Boolean(submittedAt) && !resubmissionEnabled || pendingSaves > 0;
      renderSelectionState();
      renderViewerSelectionState();
    }
  }

  function queuePreview(photo, image, generation) {
    if (image.dataset.previewState) return;
    image.dataset.previewState = "queued";
    imageQueue.push(async () => {
      if (generation !== imageGeneration || !image.isConnected) return;
      image.dataset.previewState = "loading";
      try {
        const response = await fetch(`${workerUrl}/api/photos/${encodeURIComponent(photo.id)}?size=preview`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        });
        if (!response.ok) throw new Error(`Could not load ${photo.name}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        if (generation !== imageGeneration || !image.isConnected) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        image.src = objectUrl;
        image.dataset.previewState = "loaded";
      } catch {
        image.dataset.previewState = "failed";
        image.alt = `Preview unavailable: ${photo.name}`;
      }
    });
    drainImageQueue();
  }

  function drainImageQueue() {
    while (activeImageLoads < maxConcurrentImageLoads && imageQueue.length) {
      const load = imageQueue.shift();
      activeImageLoads += 1;
      load().finally(() => {
        activeImageLoads -= 1;
        drainImageQueue();
      });
    }
  }

  function loadPhoto(photo, token) {
    const figure = document.createElement("figure");
    figure.className = "photo";
    figure.dataset.photoId = photo.id;
    const image = document.createElement("img");
    image.alt = photo.name;
    image.loading = "lazy";
    image.tabIndex = 0;
    image.setAttribute("role", "button");
    image.setAttribute("aria-label", `View ${photo.name} full screen`);
    image._photo = photo;
    image._generation = imageGeneration;
    image.addEventListener("click", () => openViewer(photo));
    image.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openViewer(photo);
      }
    });
    const caption = document.createElement("figcaption");
    caption.textContent = photo.name;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "selection-toggle";
    const isSelected = selected.has(photo.id);
    figure.classList.toggle("is-selected", isSelected);
    button.textContent = isSelected ? "✓  SELECTED" : "+  SELECT PHOTO";
    button.setAttribute("aria-pressed", String(isSelected));
      button.disabled = Boolean(submittedAt) && !resubmissionEnabled;
    button.addEventListener("click", () => toggleSelection(photo, button));
    figure.append(image, caption, button);
    photosElement.append(figure);
    renderGallery();
    if (previewObserver) previewObserver.observe(image);
    else queuePreview(photo, image, imageGeneration);
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    imageGeneration += 1;
    imageQueue.length = 0;
    previewObserver?.disconnect();
    photosElement.replaceChildren();
    summary.textContent = "";
    selected = new Set();
    selectionLimit = null;
    galleryTools.hidden = true;
    submitPanel.hidden = true;
    workerUrl = configuredWorkerUrl.trim().replace(/\/$/, "");
    const code = document.getElementById("access-code").value;
    if (!/^https?:\/\//i.test(workerUrl)) return setStatus("This gallery link is incomplete. Ask the photographer for a new link.", "error");
    setStatus("Checking access code and connecting to Drive and Firestore…");

    try {
      const sessionResponse = await fetch(`${workerUrl}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, projectId: linkedProjectId || undefined }),
      });
      const session = await sessionResponse.json();
      if (!sessionResponse.ok) throw new Error(session.error || "Could not start a gallery session");
      sessionToken = session.token;
      submittedAt = session.project?.submittedAt || null;
      resubmissionEnabled = session.project?.resubmissionEnabled === true;
      selectionLimit = session.project?.selectionLimit || null;
      galleryTitle.textContent = session.project?.clientName || "Your wedding gallery";
      gallerySubtitle.textContent = session.project?.projectName || "Select the photographs you would like.";

      const headers = { Authorization: `Bearer ${sessionToken}` };
      const [photoResponse, selectionResponse] = await Promise.all([
        fetch(`${workerUrl}/api/photos`, { headers }),
        fetch(`${workerUrl}/api/selections`, { headers }),
      ]);
      const photoResult = await photoResponse.json();
      const selectionResult = await selectionResponse.json();
      if (!photoResponse.ok) throw new Error(photoResult.error || "Could not list Drive photos");
      if (!selectionResponse.ok) throw new Error(selectionResult.error || "Could not load Firestore selections");

      photos = photoResult.photos || [];
      selected = new Set(selectionResult.selections || []);
      galleryTools.hidden = false;
      photoSearch.value = "";
      photoSort.value = "name-asc";
      renderGallery();
      submitPanel.hidden = false;
      if (!photos.length) {
        renderSelectionState();
        setStatus("Connected, but no images were found in the configured Drive folder.", "success");
        return;
      }
      renderSelectionState();
      if (submittedAt && !resubmissionEnabled) {
        submitMessage.textContent = `Selection submitted on ${new Date(submittedAt).toLocaleString()}. Your choices are now locked.`;
        submitButton.hidden = true;
      } else {
        submitMessage.textContent = resubmissionEnabled
          ? "The photographer reopened your gallery. You can update your choices and send the selection again."
          : "Review your choices, then send your final selection to the photographer.";
        submitButton.textContent = resubmissionEnabled ? "RESUBMIT UPDATED SELECTION" : "SEND SELECTION";
        submitButton.hidden = false;
      }
      photos.forEach(photo => loadPhoto(photo, sessionToken));
      setStatus(`Connected. ${photos.length} photos are ready; previews load as you browse.`, "success");
      window.setInterval(refreshSubmissionStatus, 30000);
    } catch (error) {
      setStatus(error.message || "Could not connect to the Worker.", "error");
    }
  });

  photoSearch.addEventListener("input", renderGallery);
  photoSort.addEventListener("change", renderGallery);

  document.getElementById("viewer-close").addEventListener("click", () => viewer.close());
  document.getElementById("viewer-previous").addEventListener("click", () => moveViewer(-1));
  document.getElementById("viewer-next").addEventListener("click", () => moveViewer(1));
  viewer.addEventListener("click", event => { if (event.target === viewer) viewer.close(); });
  viewer.addEventListener("close", () => {
    viewerRequestId += 1;
    viewerPhotoId = "";
    if (viewerFullUrl) URL.revokeObjectURL(viewerFullUrl);
    viewerFullUrl = "";
    viewerImage.removeAttribute("src");
  });
  viewer.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") moveViewer(-1);
    if (event.key === "ArrowRight") moveViewer(1);
  });
  viewerSelect.addEventListener("click", () => {
    const photo = visiblePhotos()[viewerIndex];
    if (!photo) return;
    const cardButton = photosElement.querySelector(`[data-photo-id="${CSS.escape(photo.id)}"] .selection-toggle`);
    if (cardButton) toggleSelection(photo, cardButton);
  });

  submitButton.addEventListener("click", async () => {
    if (pendingSaves > 0) return setStatus("Wait for photo changes to finish saving before submitting.", "error");
    if (!selected.size) return setStatus("Select at least one photo before sending your selection.", "error");
    const confirmed = window.confirm(`${resubmissionEnabled ? "Resubmit" : "Send"} your selection of ${selected.size} photo${selected.size === 1 ? "" : "s"}? You will not be able to change it after submission.`);
    if (!confirmed) return;
    submitButton.disabled = true;
    setStatus("Sending your final selection…");
    try {
      const response = await fetch(`${workerUrl}/api/submission`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not submit your selection.");
      submittedAt = result.submittedAt;
      resubmissionEnabled = result.resubmissionEnabled === true;
      submitButton.disabled = false;
      renderSelectionState();
      submitMessage.textContent = `Selection submitted successfully on ${new Date(submittedAt).toLocaleString()}. Your choices are now locked.`;
      submitButton.hidden = true;
      setStatus(`${result.selectedCount || selected.size} photos sent to the photographer.`, "success");
    } catch (error) {
      submitButton.disabled = false;
      setStatus(error.message || "Could not submit your selection.", "error");
    }
  });
})();
