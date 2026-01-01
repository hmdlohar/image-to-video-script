const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

/**
 * Robust SRT Parser that handles both dots and commas in timestamps
 */
function parseSRT(data) {
    const segments = [];
    const blocks = data.trim().split(/\n\s*\n/);

    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length >= 2) {
            const timeMatch = lines[1].match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{1,2}:\d{2}:\d{2}[.,]\d{3})/);
            if (timeMatch) {
                segments.push({
                    startTime: timeMatch[1].replace('.', ','),
                    endTime: timeMatch[2].replace('.', ','),
                    text: lines.slice(2).join('\n')
                });
            }
        }
    }
    return segments;
}

// Configuration
const FPS = 60;
const TARGET_SIZE = { width: 1080, height: 1920 }; // Portrait 9:16
const CROSSFADE_DURATION = 0.3; // seconds
const ZOOM_RATE = 0.08; // Ken Burns zoom rate

/**
 * Parse SRT time string to milliseconds
 */
function srtTimeToMs(timeStr) {
  const parts = timeStr.split(/[:,]/);
  return (
    parseInt(parts[0]) * 3600000 +
    parseInt(parts[1]) * 60000 +
    parseInt(parts[2]) * 1000 +
    parseInt(parts[3])
  );
}

/**
 * Convert SRT content and image list to scenes data
 */
function srtToScenes(srtContent, imageDir) {
  const srtData = parseSRT(srtContent);
  const images = fs.readdirSync(imageDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort((a, b) => {
      // Natural sort for filenames like 1.png, 2.png, 10.png
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

  return srtData.map((item, index) => {
    return {
      image: path.join(imageDir, images[index] || images[images.length - 1]),
      start_ms: srtTimeToMs(item.startTime),
      end_ms: srtTimeToMs(item.endTime),
      text: item.text
    };
  });
}

/**
 * Create a video clip from an image with Ken Burns effect and fade transitions
 */
function createImageClip(scene, index, totalScenes, outputDir, imageDir) {
  return new Promise((resolve, reject) => {
    const duration = (scene.end_ms - scene.start_ms) / 1000.0;
    const outputPath = path.join(outputDir, `clip_${index}.mp4`);
    
    // Calculate zoom parameters for Ken Burns effect
    const startZoom = 1.0;
    const endZoom = 1.0 + (duration * ZOOM_RATE);
    
    // Use zoompan but generate extra frames, let -t cut to exact duration
    // Generate enough frames: add 2 extra seconds worth of frames to be safe
    const safetyBuffer = 2.0;
    const totalFrames = Math.ceil((duration + safetyBuffer) * FPS);
    const zoomIncrement = (endZoom - startZoom) / (duration * FPS);
    
    // scale and crop to target aspect ratio first, then apply zoompan
    // 1. scale=w:h:force_original_aspect_ratio=increase makes the image fill the area
    // 2. crop=w:h centers the crop
    const scaleCropFilter = `scale=${TARGET_SIZE.width}:${TARGET_SIZE.height}:force_original_aspect_ratio=increase,crop=${TARGET_SIZE.width}:${TARGET_SIZE.height}`;
    
    // zoompan filter: d is total frames to generate
    // The -t flag will cut this to exact duration
    const zoomFilter = `zoompan=z='min(${startZoom}+on*${zoomIncrement},${endZoom})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${TARGET_SIZE.width}x${TARGET_SIZE.height}:fps=${FPS}`;
    
    // Fade filters - apply fades within the exact duration
    let fadeFilters = [];
    if (index > 0) {
      fadeFilters.push(`fade=t=in:st=0:d=${CROSSFADE_DURATION}`);
    }
    if (index < totalScenes - 1) {
      const fadeOutStart = Math.max(0, duration - CROSSFADE_DURATION);
      fadeFilters.push(`fade=t=out:st=${fadeOutStart}:d=${CROSSFADE_DURATION}`);
    }
    
    // Combine all filters: scale/crop first, then zoom, then fade
    let filters = [scaleCropFilter, zoomFilter];
    if (fadeFilters.length > 0) {
      filters = filters.concat(fadeFilters);
    }
    const filterComplex = filters.join(',');
    
    // Resolve image path
    const imagePath = scene.image;
    
    if (!fs.existsSync(imagePath)) {
      reject(new Error(`Image not found: ${imagePath}`));
      return;
    }
    
    console.log(`  Creating clip ${index + 1}: duration=${duration.toFixed(6)}s, zoom ${startZoom.toFixed(2)}x -> ${endZoom.toFixed(2)}x, frames=${totalFrames}`);
    
    // Create clip with EXACT duration
    // zoompan generates extra frames, but -t cuts to exact duration
    // This ensures timing is perfect while maintaining zoom effect
    ffmpeg()
      .input(imagePath)
      .inputOptions([
        '-loop', '1',
        '-framerate', FPS.toString()
      ])
      .videoFilters(filterComplex)
      .outputOptions([
        '-t', duration.toFixed(6),  // EXACT duration from scenes.json - THIS controls output duration
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-r', FPS.toString(),  // Output framerate
        '-vsync', 'cfr',  // Constant framerate
        '-g', Math.round(FPS).toString(),  // Keyframe interval
        '-fps_mode', 'cfr'  // Force constant frame rate mode
      ])
      .output(outputPath)
      .on('end', () => {
        console.log(`✓ Created clip ${index + 1}/${totalScenes}: ${duration.toFixed(3)}s`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`✗ Error creating clip ${index + 1}:`, err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Create concatenation file for FFmpeg
 */
function createConcatFile(clipPaths, outputDir) {
  const concatPath = path.join(outputDir, 'concat.txt');
  const content = clipPaths.map(clipPath => `file '${clipPath}'`).join('\n');
  fs.writeFileSync(concatPath, content);
  return concatPath;
}

/**
 * Concatenate all clips with exact timing preservation
 * Note: Crossfades are already applied to individual clips via fade in/out
 */
function concatenateClips(clipPaths, outputDir, outputFile, totalDuration = 0) {
  return new Promise((resolve, reject) => {
    const concatFile = createConcatFile(clipPaths, outputDir);
    const outputPath = path.resolve(outputFile);
    
    if (totalDuration > 0) {
      console.log(`  Concatenating ${clipPaths.length} clips, expected total duration: ${totalDuration.toFixed(3)}s`);
    } else {
      console.log(`  Concatenating ${clipPaths.length} clips...`);
    }
    
    ffmpeg()
      .input(concatFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'medium',
        '-crf', '23',
        '-r', FPS.toString(),  // Maintain framerate
        '-vsync', 'cfr',  // Constant frame rate
        '-avoid_negative_ts', 'make_zero',  // Fix timestamp issues
        '-fflags', '+genpts'  // Generate presentation timestamps for accurate timing
      ])
      .output(outputPath)
      .on('end', () => {
        console.log(`✓ Concatenated clips to: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('✗ Error concatenating clips:', err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Add audio to video with proper sync
 */
function addAudio(videoPath, audioPath, outputFile) {
  return new Promise((resolve, reject) => {
    const outputPath = path.resolve(outputFile);
    
    // Get video duration first to ensure audio matches
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      
      const videoDuration = metadata.format.duration;
      console.log(`  Video duration: ${videoDuration.toFixed(3)}s, adding audio...`);
      
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v', 'copy',  // Copy video stream (no re-encoding)
          '-c:a', 'aac',
          '-b:a', '192k',  // Audio bitrate
          '-map', '0:v:0',  // Use video from first input
          '-map', '1:a:0',  // Use audio from second input
          '-shortest',  // End when shortest stream ends
          '-avoid_negative_ts', 'make_zero',  // Fix timestamp issues
          '-fflags', '+genpts'  // Generate presentation timestamps
        ])
        .output(outputPath)
        .on('end', () => {
          console.log(`✓ Added audio to: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('✗ Error adding audio:', err.message);
          reject(err);
        })
        .run();
    });
  });
}

/**
 * Main function to create story video
 */
async function createStoryVideo(options) {
  const {
    srtContent,
    imageDir,
    audioPath,
    outputName = 'output.mp4',
    onProgress = () => {}
  } = options;

  const tempDir = path.join(__dirname, 'temp_clips_' + Date.now());
  
  // Create temp directory
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  try {
    onProgress({ status: 'parsing', message: 'Parsing SRT and images...' });
    const scenesData = srtToScenes(srtContent, imageDir);

    console.log('🎬 Starting video creation...\n');
    
    // Step 1: Create individual clips
    console.log('📹 Creating individual clips...');
    const clipPaths = [];
    for (let i = 0; i < scenesData.length; i++) {
      onProgress({ 
        status: 'clipping', 
        message: `Creating clip ${i + 1}/${scenesData.length}`,
        progress: (i / scenesData.length) * 50 // First 50% of progress
      });
      const clipPath = await createImageClip(scenesData[i], i, scenesData.length, tempDir, imageDir);
      clipPaths.push(clipPath);
    }
    
    // Step 2: Concatenate clips
    onProgress({ status: 'concatenating', message: 'Merging clips', progress: 60 });
    console.log('\n🔗 Concatenating clips...');
    const totalDuration = scenesData.reduce((sum, scene) => sum + (scene.end_ms - scene.start_ms) / 1000.0, 0);
    const tempVideo = path.join(tempDir, 'temp_concatenated.mp4');
    await concatenateClips(clipPaths, tempDir, tempVideo, totalDuration);
    
    // Step 3: Add audio
    onProgress({ status: 'audio', message: 'Adding audio...', progress: 80 });
    console.log('\n🎵 Adding audio...');
    const audioFilePath = path.resolve(audioPath);
    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }
    
    await addAudio(tempVideo, audioFilePath, outputName);
    
    // Cleanup temp files
    onProgress({ status: 'cleanup', message: 'Cleaning up...', progress: 95 });
    console.log('\n🧹 Cleaning up temporary files...');
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    onProgress({ status: 'done', message: 'Video created successfully!', progress: 100 });
    console.log(`\n✅ Video created successfully: ${path.resolve(outputName)}`);
    return path.resolve(outputName);
    
  } catch (error) {
    console.error('\n❌ Error creating video:', error);
    onProgress({ status: 'error', message: error.message });
    // Cleanup on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    throw error;
  }
}

// Run the script
if (require.main === module) {
  const srtPath = process.argv[2];
  const imageDir = process.argv[3];
  const audioPath = process.argv[4];
  const outputName = process.argv[5] || 'output.mp4';

  if (!srtPath || !imageDir || !audioPath) {
    console.log('Usage: node script.js <srt_path> <image_dir> <audio_path> [output_name]');
    process.exit(1);
  }

  const srtContent = fs.readFileSync(srtPath, 'utf8');
  
  createStoryVideo({ srtContent, imageDir, audioPath, outputName })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { createStoryVideo, srtToScenes };

