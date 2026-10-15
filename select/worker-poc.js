(() => {
  const form = document.getElementById("connect-form");
  const status = document.getElementById("status");
  const accessScreen = document.getElementById("access-screen");
  const galleryScreen = document.getElementById("gallery-screen");
  const accessButton = document.getElementById("open-gallery");
  const photosElement = document.getElementById("photos");
  const summary = document.getElementById("selection-summary");
  const galleryTitle = document.getElementById("gallery-heading");
  const gallerySubtitle = document.getElementById("gallery-description");
  const submitPanel = document.getElementById("submit-panel");
  const submitButton = document.getElementById("submit-selection");
  const saveSelectionsButton = document.getElementById("save-selections");
  const galleryLoading = document.getElementById("gallery-loading");
  const submitConfirmDialog = document.getElementById("submit-confirm-dialog");
  let submitConfirmResolver = null;
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
  const paginationBars = [...document.querySelectorAll("[data-gallery-pagination]")];
  const leaveGalleryButton = document.getElementById("leave-gallery");
  const galleryLinkParams = new URLSearchParams(window.location.search);
  const configuredWorkerUrl = window.MRDS_GALLERY_CONFIG?.workerUrl || "";
  document.getElementById("worker-url").value = configuredWorkerUrl;
  const linkedProjectId = galleryLinkParams.get("project") || "";
  let workerUrl = "";
  let sessionToken = "";
  let photos = [];
  let pageTokens = [null];
  let pageIndex = 0;
  let hasNextPage = false;
  let pageRequestPending = false;
  let selected = new Set();
  let savedSelected = new Set();
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
  const pageSize = 12;
  const previewObserver = "IntersectionObserver" in window
    ? new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const image = entry.target;
      previewObserver.unobserve(image);
      queuePhotoImage(image._photo, image, image._generation);
    }), { rootMargin: "500px 0px" })
    : null;

  function setStatus(message, type = "") {
    status.textContent = message;
    status.className = `status ${type}`.trim();
  }

  function renderSelectionState() {
    const hasUnsavedChanges = selected.size !== savedSelected.size || [...selected].some(photoId => !savedSelected.has(photoId));
    summary.textContent = selectionLimit
      ? `${selected.size} / ${selectionLimit} selected${selected.size >= selectionLimit ? " · limit reached" : ""}${hasUnsavedChanges ? " · unsaved changes" : ""}`
      : `${selected.size} selected${hasUnsavedChanges ? " · unsaved changes" : ""}`;
    saveSelectionsButton.disabled = !hasUnsavedChanges || pendingSaves > 0 || Boolean(submittedAt) && !resubmissionEnabled;
    saveSelectionsButton.classList.toggle("has-changes", hasUnsavedChanges);
    submitButton.disabled = hasUnsavedChanges || pendingSaves > 0 || Boolean(submittedAt) && !resubmissionEnabled;
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
    visibleCount.textContent = `${count} on page ${pageIndex + 1}`;
  }

  function updatePagination() {
    const lastAvailablePage = pageIndex + (hasNextPage ? 1 : 0);
    paginationBars.forEach(pagination => {
      pagination.hidden = lastAvailablePage === 0;
      const pageButtons = Array.from({ length: lastAvailablePage + 1 }, (_, index) => {
        const isCurrent = index === pageIndex;
        return `<button class="gallery-page-number${isCurrent ? " is-current" : ""}" type="button" data-page="${index}" aria-label="Page ${index + 1}"${isCurrent ? ' aria-current="page"' : ""}${pageRequestPending || (index > pageIndex && !hasNextPage) ? " disabled" : ""}>${index + 1}</button>`;
      }).join("");
      pagination.innerHTML = `<button class="gallery-page-previous" type="button" data-page-action="previous" aria-label="Previous page"${pageRequestPending || pageIndex === 0 ? " disabled" : ""}>← <span>Previous</span></button><div class="gallery-page-numbers" aria-live="polite">${pageButtons}</div><button class="gallery-page-next" type="button" data-page-action="next" aria-label="Next page"${pageRequestPending || !hasNextPage ? " disabled" : ""}><span>Next</span> →</button>`;
    });
    leaveGalleryButton.disabled = pageRequestPending;
  }

  function clearCurrentPage() {
    imageGeneration += 1;
    imageQueue.length = 0;
    previewObserver?.disconnect();
    if (viewer.open) viewer.close();
    photosElement.querySelectorAll("img").forEach(image => {
      if (image.src.startsWith("blob:")) URL.revokeObjectURL(image.src);
    });
    photosElement.replaceChildren();
  }

  async function changeGalleryPage(nextPageIndex) {
    if (pageRequestPending || nextPageIndex < 0 || nextPageIndex > pageIndex + 1) return;
    const pageToken = pageTokens[nextPageIndex];
    if (nextPageIndex > 0 && !pageToken) return;
    pageRequestPending = true;
    galleryLoading.hidden = false;
    galleryLoading.querySelector("span:last-child").textContent = `Loading page ${nextPageIndex + 1}…`;
    updatePagination();
    try {
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await fetch(`${workerUrl}/api/photos?${params}`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load this gallery page.");
      clearCurrentPage();
      pageIndex = nextPageIndex;
      pageTokens[pageIndex + 1] = result.nextPageToken || null;
      hasNextPage = Boolean(result.nextPageToken);
      photos = result.photos || [];
      renderSelectionState();
      photos.forEach(photo => loadPhoto(photo, sessionToken));
      updatePagination();
    } catch (error) {
      setStatus(error.message || "Could not load this gallery page.", "error");
    } finally {
      pageRequestPending = false;
      galleryLoading.hidden = true;
      updatePagination();
    }
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
      if (cardImage?.dataset.imageState !== "loaded") loadFullViewerPhoto(photo, viewerRequestId);
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
    renderSelectionState();
    setStatus(`${photo.name} ${wasSelected ? "removed from" : "added to"} your draft. Save changes to keep it.`, "success");
  }

  async function saveSelectionChanges() {
    if (pendingSaves || saveSelectionsButton.disabled) return;
    const changedPhotoIds = new Set([...savedSelected, ...selected]);
    const changes = [...changedPhotoIds].filter(photoId => selected.has(photoId) !== savedSelected.has(photoId));
    if (!changes.length) return;
    pendingSaves = 1;
    saveSelectionsButton.classList.add("is-loading");
    saveSelectionsButton.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span> Saving…';
    renderSelectionState();
    try {
      const results = await Promise.allSettled(changes.map(async photoId => {
        const isSelected = selected.has(photoId);
        const response = await fetch(`${workerUrl}/api/selections/${encodeURIComponent(photoId)}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ selected: isSelected }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Could not save ${photoId}`);
        return { photoId, isSelected };
      }));
      const successfulChanges = results.filter(result => result.status === "fulfilled").map(result => result.value);
      successfulChanges.forEach(({ photoId, isSelected }) => {
        if (isSelected) savedSelected.add(photoId);
        else savedSelected.delete(photoId);
      });
      const failedChanges = results.length - successfulChanges.length;
      if (failedChanges) setStatus(`${successfulChanges.length} change${successfulChanges.length === 1 ? "" : "s"} saved; ${failedChanges} could not be saved. Please retry.`, "error");
      else setStatus(`${successfulChanges.length} selection change${successfulChanges.length === 1 ? "" : "s"} saved.`, "success");
    } catch (error) {
      setStatus(`${error.message || "Some changes could not be saved."} Please save again to retry remaining changes.`, "error");
    } finally {
      pendingSaves = 0;
      saveSelectionsButton.classList.remove("is-loading");
      saveSelectionsButton.textContent = "Save changes";
      renderSelectionState();
      renderViewerSelectionState();
    }
  }

  function queuePhotoImage(photo, image, generation) {
    if (image.dataset.imageState) return;
    image.dataset.imageState = "queued";
    imageQueue.push(async () => {
      if (generation !== imageGeneration || !image.isConnected) return;
      image.dataset.imageState = "loading";
      try {
        const response = await fetch(`${workerUrl}/api/photos/${encodeURIComponent(photo.id)}`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        });
        if (!response.ok) throw new Error(`Could not load ${photo.name}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        if (generation !== imageGeneration || !image.isConnected) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        image.src = objectUrl;
        image.dataset.imageState = "loaded";
      } catch {
        image.dataset.imageState = "failed";
        image.alt = `Photo unavailable: ${photo.name}`;
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
    else queuePhotoImage(photo, image, imageGeneration);
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    accessButton.disabled = true;
    accessButton.classList.add("is-loading");
    accessButton.querySelector("span").textContent = "Opening your gallery…";
    imageGeneration += 1;
    imageQueue.length = 0;
    previewObserver?.disconnect();
    photosElement.replaceChildren();
    summary.textContent = "";
    selected = new Set();
    savedSelected = new Set();
    selectionLimit = null;
    galleryTools.hidden = true;
    submitPanel.hidden = true;
    workerUrl = configuredWorkerUrl.trim().replace(/\/$/, "");
    const code = document.getElementById("access-code").value;
    if (!/^https?:\/\//i.test(workerUrl)) {
      setStatus("This gallery link is incomplete. Ask the photographer for a new link.", "error");
      accessButton.disabled = false;
      accessButton.classList.remove("is-loading");
      accessButton.querySelector("span").textContent = "Enter your gallery";
      return;
    }
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
        fetch(`${workerUrl}/api/photos?pageSize=${pageSize}`, { headers }),
        fetch(`${workerUrl}/api/selections`, { headers }),
      ]);
      const photoResult = await photoResponse.json();
      const selectionResult = await selectionResponse.json();
      if (!photoResponse.ok) throw new Error(photoResult.error || "Could not list Drive photos");
      if (!selectionResponse.ok) throw new Error(selectionResult.error || "Could not load Firestore selections");

      photos = photoResult.photos || [];
      pageTokens = [null, photoResult.nextPageToken || null];
      pageIndex = 0;
      hasNextPage = Boolean(photoResult.nextPageToken);
      selected = new Set(selectionResult.selections || []);
      savedSelected = new Set(selected);
      accessScreen.hidden = true;
      galleryScreen.hidden = false;
      leaveGalleryButton.hidden = false;
      galleryTools.hidden = false;
      updatePagination();
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
    } catch (error) {
      setStatus(error.message || "Could not connect to the Worker.", "error");
    } finally {
      accessButton.disabled = false;
      accessButton.classList.remove("is-loading");
      accessButton.querySelector("span").textContent = "Enter your gallery";
    }
  });

  leaveGalleryButton.addEventListener("click", () => {
    if (hasUnsavedSelectionChanges() && !window.confirm("Your selection changes are not saved. Exit the gallery and discard them?")) return;
    clearCurrentPage();
    photos = [];
    selected = new Set();
    savedSelected = new Set();
    sessionToken = "";
    submittedAt = null;
    resubmissionEnabled = false;
    galleryScreen.hidden = true;
    leaveGalleryButton.hidden = true;
    accessScreen.hidden = false;
    document.getElementById("access-code").value = "";
    setStatus("Your gallery is locked. Enter your access code to return.");
  });

  function hasUnsavedSelectionChanges() {
    return selected.size !== savedSelected.size || [...selected].some(photoId => !savedSelected.has(photoId));
  }

  saveSelectionsButton.addEventListener("click", saveSelectionChanges);
  window.addEventListener("beforeunload", event => {
    if (!hasUnsavedSelectionChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  photoSearch.addEventListener("input", renderGallery);
  photoSort.addEventListener("change", renderGallery);
  paginationBars.forEach(pagination => pagination.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || !pagination.contains(button)) return;
    if (button.dataset.pageAction === "previous") changeGalleryPage(pageIndex - 1);
    else if (button.dataset.pageAction === "next") changeGalleryPage(pageIndex + 1);
    else if (button.dataset.page !== undefined) changeGalleryPage(Number(button.dataset.page));
  }));

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

  function confirmSubmission() {
    document.getElementById("submit-confirm-title").textContent = resubmissionEnabled ? "Resubmit your selection?" : "Send your selection?";
    document.getElementById("submit-confirm-message").textContent = `You have selected ${selected.size} photo${selected.size === 1 ? "" : "s"}. After submitting, your choices will be locked until the photographer allows resubmission.`;
    submitConfirmDialog.showModal();
    return new Promise(resolve => { submitConfirmResolver = resolve; });
  }

  function finishSubmitConfirmation(accepted) {
    submitConfirmDialog.close();
    submitConfirmResolver?.(accepted);
    submitConfirmResolver = null;
  }

  document.getElementById("submit-confirm-cancel").addEventListener("click", () => finishSubmitConfirmation(false));
  document.getElementById("submit-confirm-accept").addEventListener("click", () => finishSubmitConfirmation(true));
  submitConfirmDialog.addEventListener("cancel", event => { event.preventDefault(); finishSubmitConfirmation(false); });
  submitConfirmDialog.addEventListener("click", event => {
    if (event.target === submitConfirmDialog) finishSubmitConfirmation(false);
  });

  submitButton.addEventListener("click", async () => {
    if (hasUnsavedSelectionChanges()) return setStatus("Save your selection changes before submitting.", "error");
    if (pendingSaves > 0) return setStatus("Wait for photo changes to finish saving before submitting.", "error");
    if (!selected.size) return setStatus("Select at least one photo before sending your selection.", "error");
    const confirmed = await confirmSubmission();
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
