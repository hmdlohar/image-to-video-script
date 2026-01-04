const socket = io();

// State management
let sessionId = Math.random().toString(36).substring(7);
let currentMode = "story"; // 'story' or 'mixer'

// Elements - Shared
const progressContainer = document.getElementById("progress-container");
const progressFill = document.getElementById("progress-fill");
const statusText = document.getElementById("status-text");
const resultContainer = document.getElementById("result-container");
const downloadLink = document.getElementById("download-link");
const resetBtn = document.getElementById("reset-btn");

// Elements - Story Mode
const sectionStory = document.getElementById("section-story");
const audioInput = document.getElementById("audio");
const srtInput = document.getElementById("srt");
const imagesInput = document.getElementById("images");
const generateStoryBtn = document.getElementById("generate-story-btn");
const previewContainer = document.getElementById("preview-container");
const previewGrid = document.getElementById("preview-grid");
const imageCount = document.getElementById("image-count");

// Elements - Mixer Mode
const sectionMixer = document.getElementById("section-mixer");
const mixerMainAudio = document.getElementById("mixer-main-audio");
const mixerBgAudio = document.getElementById("mixer-bg-audio");
const mixerVisual = document.getElementById("mixer-visual");
const mixerBgVol = document.getElementById("mixer-bg-vol");
const generateMixerBtn = document.getElementById("generate-mixer-btn");

// Tabs
const tabStory = document.getElementById("tab-story");
const tabMixer = document.getElementById("tab-mixer");

// Tab Switching logic
tabStory.addEventListener("click", () => switchMode("story"));
tabMixer.addEventListener("click", () => switchMode("mixer"));

function switchMode(mode) {
  currentMode = mode;
  tabStory.classList.toggle("active", mode === "story");
  tabMixer.classList.toggle("active", mode === "mixer");
  sectionStory.classList.toggle("hidden", mode !== "story");
  sectionMixer.classList.toggle("hidden", mode !== "mixer");

  // Hide preview/results when switching
  previewContainer.classList.add("hidden");
  resultContainer.classList.add("hidden");
  progressContainer.classList.add("hidden");
}

// --- Story Mode Logic ---

srtInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    const blocks = parseSRT(content);

    previewGrid.innerHTML = "";
    blocks.forEach((block, i) => {
      const item = document.createElement("div");
      item.className = "preview-item";
      item.innerHTML = `<span class="time-tag">${block.startTime}</span>`;
      item.style.backgroundColor = "rgba(255,255,255,0.05)";
      previewGrid.appendChild(item);
    });

    previewContainer.classList.remove("hidden");
    imagesInput.disabled = false;
    imagesInput.nextElementSibling.textContent = `Select ${blocks.length} images`;
  };
  reader.readAsText(file);
});

imagesInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  imageCount.textContent = `${files.length} images selected`;

  const previews = previewGrid.querySelectorAll(".preview-item");
  files.slice(0, previews.length).forEach((file, i) => {
    const url = URL.createObjectURL(file);
    previews[i].style.backgroundImage = `url(${url})`;
  });
});

generateStoryBtn.addEventListener("click", async () => {
  if (
    !audioInput.files[0] ||
    !srtInput.files[0] ||
    imagesInput.files.length === 0
  ) {
    alert("Please select audio, SRT, and images.");
    return;
  }

  setProcessing(true);

  try {
    const formData = new FormData();
    formData.append("audio", audioInput.files[0]);
    formData.append("srt", srtInput.files[0]);
    Array.from(imagesInput.files).forEach((f) => formData.append("images", f));
    formData.append("sessionId", sessionId);

    statusText.textContent = "Uploading files...";
    const res = await fetch(`/upload?sessionId=${sessionId}`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error("Upload failed");

    socket.emit("start-generation", { sessionId });
  } catch (err) {
    alert(err.message);
    setProcessing(false);
  }
});

// --- Mixer Mode Logic ---

generateMixerBtn.addEventListener("click", async () => {
  if (
    !mixerMainAudio.files[0] ||
    !mixerBgAudio.files[0] ||
    !mixerVisual.files[0]
  ) {
    alert("Please select all required files.");
    return;
  }

  setProcessing(true);

  try {
    const formData = new FormData();
    formData.append("audio", mixerMainAudio.files[0]);
    formData.append("bgAudio", mixerBgAudio.files[0]);
    formData.append("visual", mixerVisual.files[0]);
    formData.append("sessionId", sessionId);

    statusText.textContent = "Uploading files...";
    const res = await fetch(`/upload?sessionId=${sessionId}`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error("Upload failed");

    socket.emit("start-mixed-generation", {
      sessionId,
      bgVolume: mixerBgVol.value,
      framerate: 30,
    });
  } catch (err) {
    alert(err.message);
    setProcessing(false);
  }
});

// --- Shared Socket Events ---

socket.on("progress", (data) => {
  progressContainer.classList.remove("hidden");
  progressFill.style.width = `${data.progress || 0}%`;
  statusText.textContent = data.message;
});

socket.on("finished", (data) => {
  setProcessing(false);
  resultContainer.classList.remove("hidden");
  downloadLink.href = data.url;
  downloadLink.download = data.filename;
});

socket.on("error", (data) => {
  alert("Error: " + data.message);
  setProcessing(false);
});

resetBtn.addEventListener("click", () => {
  sessionId = Math.random().toString(36).substring(7);
  resultContainer.classList.add("hidden");
  progressContainer.classList.add("hidden");
  progressFill.style.width = "0%";
  statusText.textContent = "Ready to start...";

  // Reset forms
  audioInput.value = "";
  srtInput.value = "";
  imagesInput.value = "";
  imagesInput.disabled = true;
  imageCount.textContent = "";
  previewGrid.innerHTML = "";
  previewContainer.classList.add("hidden");

  mixerMainAudio.value = "";
  mixerBgAudio.value = "";
  mixerVisual.value = "";
});

// Utilities
function setProcessing(isProcessing) {
  generateStoryBtn.disabled = isProcessing;
  generateMixerBtn.disabled = isProcessing;
  if (isProcessing) {
    progressContainer.classList.remove("hidden");
    resultContainer.classList.add("hidden");
  }
}

function parseSRT(data) {
  const segments = [];
  const blocks = data.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length >= 2) {
      const timeMatch = lines[1].match(
        /(\d{1,2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{1,2}:\d{2}:\d{2}[.,]\d{3})/
      );
      if (timeMatch) {
        segments.push({
          startTime: timeMatch[1].replace(".", ","),
        });
      }
    }
  }
  return segments;
}

// Update file labels
document.querySelectorAll('input[type="file"]').forEach((input) => {
  input.addEventListener("change", (e) => {
    const label = e.target.nextElementSibling;
    if (label && e.target.files.length > 0) {
      label.textContent =
        e.target.files.length === 1
          ? e.target.files[0].name
          : `${e.target.files.length} files selected`;
    }
  });
});
