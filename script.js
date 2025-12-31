const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const IMAGE_DIR = "../2";
const AUDIO_PATH = "../2/2.wav";
const OUTPUT_FILE = "../2/chotu_khargosh.mp4";

// Configuration
const FPS = 30;
const TARGET_SIZE = { width: 1080, height: 1920 }; // Portrait 9:16
const CROSSFADE_DURATION = 0.3; // seconds
const ZOOM_RATE = 0.08; // Ken Burns zoom rate

// Load scenes data
const scenesData = JSON.parse(fs.readFileSync('scenes.json', 'utf8'));

/**
 * Create a video clip from an image with Ken Burns effect and fade transitions
 */
function createImageClip(scene, index, totalScenes, outputDir) {
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
    
    // zoompan filter: d is total frames to generate
    // The -t flag will cut this to exact duration
    const zoomFilter = `zoompan=z='min(${startZoom}+on*${zoomIncrement},${endZoom})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${TARGET_SIZE.width}x${TARGET_SIZE.height}`;
    
    // Fade filters - apply fades within the exact duration
    let fadeFilters = [];
    if (index > 0) {
      fadeFilters.push(`fade=t=in:st=0:d=${CROSSFADE_DURATION}`);
    }
    if (index < totalScenes - 1) {
      const fadeOutStart = Math.max(0, duration - CROSSFADE_DURATION);
      fadeFilters.push(`fade=t=out:st=${fadeOutStart}:d=${CROSSFADE_DURATION}`);
    }
    
    // Combine all filters: zoom first, then fade
    // The -t flag ensures exact duration regardless of zoompan frame generation
    let filters = [zoomFilter];
    if (fadeFilters.length > 0) {
      filters = filters.concat(fadeFilters);
    }
    const filterComplex = filters.join(',');
    
    // Resolve image path
    const imagePath = path.isAbsolute(scene.image) 
      ? scene.image 
      : path.resolve(IMAGE_DIR, scene.image);
    
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
function concatenateClips(clipPaths, outputDir, outputFile) {
  return new Promise((resolve, reject) => {
    const concatFile = createConcatFile(clipPaths, outputDir);
    const outputPath = path.resolve(outputFile);
    
    // Calculate total expected duration for verification
    const totalDuration = scenesData.reduce((sum, scene) => {
      return sum + (scene.end_ms - scene.start_ms) / 1000.0;
    }, 0);
    
    console.log(`  Concatenating ${clipPaths.length} clips, expected total duration: ${totalDuration.toFixed(3)}s`);
    
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
async function createStoryVideo(imageData, audioPath, outputName = 'chotu_khargosh.mp4') {
  const tempDir = path.join(__dirname, 'temp_clips');
  
  // Create temp directory
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  try {
    console.log('🎬 Starting video creation...\n');
    
    // Step 1: Create individual clips
    console.log('📹 Creating individual clips...');
    const clipPaths = [];
    for (let i = 0; i < imageData.length; i++) {
      const clipPath = await createImageClip(imageData[i], i, imageData.length, tempDir);
      clipPaths.push(clipPath);
    }
    
    // Step 2: Concatenate clips
    console.log('\n🔗 Concatenating clips...');
    const tempVideo = path.join(tempDir, 'temp_concatenated.mp4');
    await concatenateClips(clipPaths, tempDir, tempVideo);
    
    // Step 3: Add audio
    console.log('\n🎵 Adding audio...');
    const audioFilePath = path.resolve(audioPath);
    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }
    
    await addAudio(tempVideo, audioFilePath, outputName);
    
    // Cleanup temp files
    console.log('\n🧹 Cleaning up temporary files...');
    // fs.rmSync(tempDir, { recursive: true, force: true });
    
    console.log(`\n✅ Video created successfully: ${path.resolve(outputName)}`);
    
  } catch (error) {
    console.error('\n❌ Error creating video:', error);
    throw error;
  }
}

// Run the script
if (require.main === module) {
  const audioPath = process.argv[2] || AUDIO_PATH;
  const outputName = process.argv[3] || OUTPUT_FILE;
  
  createStoryVideo(scenesData, audioPath, outputName)
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { createStoryVideo };

