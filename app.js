const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { createStoryVideo } = require("./script");
const { createMixedVideo } = require("./mixer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 7860; // Default Hugging Face port

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sId = req.query.sessionId || req.body.sessionId || "default";
    const sessionDir = path.join(UPLOADS_DIR, sId);

    // Sub-directories for different types
    let subDir = "others";
    if (file.fieldname === "audio") subDir = "audio";
    if (file.fieldname === "srt") subDir = "srt";
    if (file.fieldname === "bgAudio") subDir = "bgAudio";
    if (file.fieldname === "visual") subDir = "visual";
    if (file.fieldname === "images") subDir = "images";

    const finalDir = path.join(sessionDir, subDir);
    console.log(
      `[Upload] Saving ${file.fieldname} to ${finalDir} (Session: ${sId})`
    );

    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }
    cb(null, finalDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

app.use(express.static("public"));
app.use("/output", express.static(path.join(__dirname, "output")));

// Upload endpoint
app.post(
  "/upload",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "srt", maxCount: 1 },
    { name: "images", maxCount: 100 },
    { name: "bgAudio", maxCount: 1 },
    { name: "visual", maxCount: 1 },
  ]),
  (req, res) => {
    res.json({ success: true });
  }
);

// Store active processes
const activeProcesses = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("start-generation", async (data) => {
    const { sessionId } = data;
    const sessionDir = path.join(UPLOADS_DIR, sessionId);
    const audioDir = path.join(sessionDir, "audio");
    const srtDir = path.join(sessionDir, "srt");
    const imageDir = path.join(sessionDir, "images");
    const outputDir = path.join(__dirname, "output");

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    try {
      if (!fs.existsSync(audioDir))
        throw new Error("Audio directory not found. Upload may have failed.");
      if (!fs.existsSync(srtDir))
        throw new Error("SRT directory not found. Upload may have failed.");
      if (!fs.existsSync(imageDir))
        throw new Error("Images directory not found. Upload may have failed.");

      const audioFiles = fs.readdirSync(audioDir);
      const srtFiles = fs.readdirSync(srtDir);

      if (audioFiles.length === 0 || srtFiles.length === 0) {
        throw new Error("Missing audio or SRT file");
      }

      const audioPath = path.join(audioDir, audioFiles[0]);
      const srtContent = fs.readFileSync(
        path.join(srtDir, srtFiles[0]),
        "utf8"
      );
      const outputName = `video_${sessionId}_${Date.now()}.mp4`;
      const outputPath = path.join(outputDir, outputName);

      socket.emit("progress", {
        status: "starting",
        message: "Initializing...",
      });

      await createStoryVideo({
        srtContent,
        imageDir,
        audioPath,
        outputName: outputPath,
        onProgress: (p) => {
          socket.emit("progress", p);
        },
      });

      socket.emit("finished", {
        url: `/output/${outputName}`,
        filename: outputName,
      });

      // Cleanup session uploads after successful generation
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.error("Generation error:", err);
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("start-mixed-generation", async (data) => {
    const { sessionId, bgVolume, framerate } = data;
    const sessionDir = path.join(UPLOADS_DIR, sessionId);
    const audioDir = path.join(sessionDir, "audio");
    const bgAudioDir = path.join(sessionDir, "bgAudio");
    const visualDir = path.join(sessionDir, "visual");
    const outputDir = path.join(__dirname, "output");

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    try {
      if (!fs.existsSync(audioDir) || fs.readdirSync(audioDir).length === 0)
        throw new Error("Main audio missing");
      if (!fs.existsSync(bgAudioDir) || fs.readdirSync(bgAudioDir).length === 0)
        throw new Error("Background audio missing");
      if (!fs.existsSync(visualDir) || fs.readdirSync(visualDir).length === 0)
        throw new Error("Visual (Image/Video) missing");

      const mainAudio = path.join(audioDir, fs.readdirSync(audioDir)[0]);
      const bgAudio = path.join(bgAudioDir, fs.readdirSync(bgAudioDir)[0]);
      const visualInput = path.join(visualDir, fs.readdirSync(visualDir)[0]);

      const outputName = `mixed_${sessionId}_${Date.now()}.mp4`;
      const outputPath = path.join(outputDir, outputName);

      socket.emit("progress", {
        status: "starting",
        message: "Initializing Mix...",
      });

      await createMixedVideo({
        inputPath: visualInput,
        mainAudioPath: mainAudio,
        bgAudioPath: bgAudio,
        outputPath: outputPath,
        bgVolume: parseFloat(bgVolume) || 0.3,
        framerate: parseInt(framerate) || 30,
        onProgress: (p) => {
          socket.emit("progress", p);
        },
      });

      socket.emit("finished", {
        url: `/output/${outputName}`,
        filename: outputName,
      });

      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.error("Mixed generation error:", err);
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
