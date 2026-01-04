const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");

/**
 * Mix main audio with background audio and apply to a video or image
 * Based on the shell script provided.
 */
async function createMixedVideo(options) {
  const {
    inputPath,
    mainAudioPath,
    bgAudioPath,
    outputPath,
    bgVolume = 0.3,
    framerate = 30,
    onProgress = () => {},
  } = options;

  return new Promise(async (resolve, reject) => {
    try {
      const isImage = /\.(jpg|jpeg|png|bmp|gif|webp)$/i.test(inputPath);

      // Get duration of main audio
      ffmpeg.ffprobe(mainAudioPath, async (err, metadata) => {
        if (err)
          return reject(
            new Error("Failed to probe main audio: " + err.message)
          );
        const duration = metadata.format.duration;

        onProgress({
          status: "mixing",
          message: "Analyzing media...",
          progress: 10,
        });

        let command = ffmpeg();

        // Input 0: Image or Video
        if (isImage) {
          command = command.input(inputPath).inputOptions(["-loop", "1"]);
        } else {
          command = command
            .input(inputPath)
            .inputOptions(["-stream_loop", "-1"]);
        }

        // Input 1: Main Audio
        command = command.input(mainAudioPath);

        // Input 2: Background Audio
        command = command
          .input(bgAudioPath)
          .inputOptions(["-stream_loop", "-1"]);

        const filterComplex = [
          // [2:a] is background audio
          `[2:a]volume=${bgVolume}[bg]`,
          // [1:a] is main audio, [bg] is adjusted background
          `[1:a][bg]amix=inputs=2:normalize=1[a]`,
        ];

        command
          .complexFilter(filterComplex)
          .outputOptions([
            "-map 0:v", // Use video from input 0
            "-map [a]", // Use mixed audio
            "-c:v libx264",
            "-c:a aac",
            "-shortest", // Stop when the shortest stream (video loop usually) ends - but we set -t
            `-t ${duration}`, // Set duration to main audio length
            `-r ${framerate}`,
            "-pix_fmt yuv420p",
          ])
          .output(outputPath)
          .on("start", (cmd) => console.log("FFmpeg command:", cmd))
          .on("progress", (progress) => {
            if (progress.percent) {
              onProgress({
                status: "rendering",
                message: `Rendering mixed video... ${Math.round(
                  progress.percent
                )}%`,
                progress: 10 + progress.percent * 0.85,
              });
            }
          })
          .on("end", () => {
            onProgress({
              status: "done",
              message: "Mixed video created successfully!",
              progress: 100,
            });
            resolve(outputPath);
          })
          .on("error", (err) => {
            console.error("FFmpeg error:", err);
            reject(new Error("FFmpeg processing failed: " + err.message));
          })
          .run();
      });
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { createMixedVideo };
