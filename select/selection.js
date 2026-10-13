(() => {
  const photos = Array.from({ length: 9 }, (_, index) => {
    const name = `${String(index + 1).padStart(2, "0")}.jpg`;
    return { id: name, name, src: `../img/gallery/${name}` };
  });
  const storageKey = "mrds-photo-selection-demo-v1";
  let selected = new Set();
  try { selected = new Set(JSON.parse(localStorage.getItem(storageKey) || "[]")); } catch { selected = new Set(); }
  const grid = document.getElementById("photo-grid");
  const count = document.getElementById("selected-count");
  const box = document.getElementById("lightbox");
  const lightboxImage = document.getElementById("lightbox-image");
  const lightboxCaption = document.getElementById("lightbox-caption");
  const lightboxSelect = document.getElementById("lightbox-select");
  const notice = document.getElementById("notice");
  let currentIndex = 0;
  let noticeTimer;

  function persist() {
    localStorage.setItem(storageKey, JSON.stringify([...selected]));
    count.textContent = selected.size;
    grid.querySelectorAll(".photo-card").forEach((card, index) => {
      const active = selected.has(photos[index].id);
      card.classList.toggle("is-selected", active);
      card.setAttribute("aria-pressed", String(active));
      card.querySelector(".select-mark").textContent = active ? "✓" : "+";
      card.querySelector(".photo-number").textContent = `${photos[index].name} · ${active ? "SELECTED" : ""}`;
    });
    updateLightboxButton();
  }

  function toggle(photo) {
    selected.has(photo.id) ? selected.delete(photo.id) : selected.add(photo.id);
    persist();
  }

  function openPhoto(index) {
    currentIndex = (index + photos.length) % photos.length;
    const photo = photos[currentIndex];
    lightboxImage.src = photo.src;
    lightboxImage.alt = photo.name;
    lightboxCaption.textContent = `${photo.name}  ·  ${String(currentIndex + 1).padStart(2, "0")} / ${String(photos.length).padStart(2, "0")}`;
    updateLightboxButton();
    box.classList.add("open");
    box.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    document.getElementById("lightbox-close").focus();
  }

  function closePhoto() {
    box.classList.remove("open");
    box.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function updateLightboxButton() {
    const photo = photos[currentIndex];
    if (!photo) return;
    lightboxSelect.textContent = selected.has(photo.id) ? "✓  SELECTED" : "+  SELECT THIS PHOTO";
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.classList.add("visible");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.classList.remove("visible"), 2800);
  }

  photos.forEach((photo, index) => {
    const card = document.createElement("article");
    card.className = "photo-card";
    card.innerHTML = `<img src="${photo.src}" alt="Wedding photograph ${photo.name}" loading="${index < 2 ? "eager" : "lazy"}"><span class="card-sheen"></span><button class="photo-select" type="button" aria-label="Select ${photo.name}" aria-pressed="false"><span class="photo-number"></span><span class="select-mark" aria-hidden="true">+</span></button>`;
    card.querySelector("img").addEventListener("click", () => openPhoto(index));
    card.querySelector(".photo-select").addEventListener("click", () => toggle(photo));
    grid.append(card);
  });
  document.getElementById("photo-total").textContent = String(photos.length).padStart(2, "0");
  document.getElementById("send-selection").addEventListener("click", () => {
    const names = photos.filter(photo => selected.has(photo.id)).map(photo => photo.name);
    if (!names.length) return showNotice("Choose at least one photo to continue.");
    showNotice(`Demo selection saved: ${names.length} photo${names.length === 1 ? "" : "s"}.`);
    console.info("Static demo selection (not submitted to a server):", names);
  });
  document.getElementById("lightbox-close").addEventListener("click", closePhoto);
  document.getElementById("photo-previous").addEventListener("click", () => openPhoto(currentIndex - 1));
  document.getElementById("photo-next").addEventListener("click", () => openPhoto(currentIndex + 1));
  lightboxSelect.addEventListener("click", () => toggle(photos[currentIndex]));
  box.addEventListener("click", event => { if (event.target === box) closePhoto(); });
  document.addEventListener("keydown", event => {
    if (!box.classList.contains("open")) return;
    if (event.key === "Escape") closePhoto();
    if (event.key === "ArrowLeft") openPhoto(currentIndex - 1);
    if (event.key === "ArrowRight") openPhoto(currentIndex + 1);
  });
  persist();
})();
