const socket = io();

const sessionId = Math.random().toString(36).substring(2, 15);
let uploadedFiles = {
    audio: false,
    srt: false,
    images: 0
};

// UI Elements
const audioInput = document.getElementById('audio');
const srtInput = document.getElementById('srt');
const imagesInput = document.getElementById('images');
const generateBtn = document.getElementById('generate-btn');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const statusText = document.getElementById('status-text');
const resultContainer = document.getElementById('result-container');
const downloadLink = document.getElementById('download-link');
const imageCount = document.getElementById('image-count');
const previewContainer = document.getElementById('preview-container');
const previewGrid = document.getElementById('preview-grid');

let srtData = [];
let imagePreviews = [];

// Handle File Selection and Upload
async function uploadFile(file, fieldname) {
    const formData = new FormData();
    formData.append(fieldname, file);
    formData.append('sessionId', sessionId);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        if (!response.ok) throw new Error('Upload failed');
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

let requiredImages = 0;

// Update UI on file selection
audioInput.addEventListener('change', (e) => {
    if (e.target.files[0]) {
        updateLabel('audio-wrapper', e.target.files[0].name);
        uploadedFiles.audio = true;
    }
});

srtInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        updateLabel('srt-wrapper', file.name);
        uploadedFiles.srt = true;
        
        // Parse SRT to count segments
        const text = await file.text();
        const matches = [...text.matchAll(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{1,2}:\d{2}:\d{2}[.,]\d{3})/g)];
        const textMatches = text.trim().split(/\n\s*\n/).map(block => block.split('\n').slice(2).join(' '));
        
        srtData = matches.map((m, i) => ({
            startTime: m[1],
            endTime: m[2],
            text: textMatches[i] || ''
        }));
        
        requiredImages = srtData.length;
        
        // Enable images input
        imagesInput.disabled = false;
        updateLabel('images-wrapper', `Choose ${requiredImages} Images`);
        imageCount.innerText = `SRT loaded: ${requiredImages} scenes detected.`;
        imageCount.style.color = 'var(--primary)';
        
        if (imagePreviews.length > 0) renderPreview();
    }
});

imagesInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files.length > 0) {
        if (files.length !== requiredImages) {
            updateLabel('images-wrapper', `Error: Selected ${files.length}/${requiredImages}`, 'red');
            imageCount.innerText = `Please select exactly ${requiredImages} images. You selected ${files.length}.`;
            imageCount.style.color = '#ef4444';
            uploadedFiles.images = 0;
        } else {
            updateLabel('images-wrapper', `${files.length} images selected`, 'var(--success)');
            imageCount.innerText = `Perfect! Correct number of images selected.`;
            imageCount.style.color = 'var(--success)';
            uploadedFiles.images = files.length;
            
            // Generate previews
            imagePreviews = Array.from(files)
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                .map(file => URL.createObjectURL(file));
            
            renderPreview();
        }
    }
});

function renderPreview() {
    if (srtData.length === 0 || imagePreviews.length === 0) return;
    
    previewGrid.innerHTML = '';
    previewContainer.classList.remove('hidden');
    
    srtData.forEach((scene, i) => {
        const imgSrc = imagePreviews[i] || imagePreviews[imagePreviews.length - 1];
        const card = document.createElement('div');
        card.className = 'preview-card';
        card.innerHTML = `
            <img src="${imgSrc}" alt="Scene ${i+1}">
            <div class="preview-info">
                <div class="preview-time">${scene.startTime}</div>
                <div class="preview-text">${scene.text}</div>
            </div>
        `;
        previewGrid.appendChild(card);
    });
}

function updateLabel(wrapperId, text, borderColor = 'var(--success)') {
    const wrapper = document.getElementById(wrapperId);
    wrapper.querySelector('.file-label').innerText = text;
    wrapper.style.borderColor = borderColor;
}

// Generate Video
generateBtn.addEventListener('click', async () => {
    if (!uploadedFiles.audio || !uploadedFiles.srt || uploadedFiles.images === 0) {
        alert('Please select all required files.');
        return;
    }

    generateBtn.disabled = true;
    progressContainer.classList.remove('hidden');
    resultContainer.classList.add('hidden');
    
    statusText.innerText = 'Uploading assets...';
    progressFill.style.width = '5%';

    try {
        // Upload All Files
        const audioFile = audioInput.files[0];
        const srtFile = srtInput.files[0];
        const imageFiles = Array.from(imagesInput.files);

        // Upload audio & srt
        await uploadToBackend(audioFile, 'audio');
        await uploadToBackend(srtFile, 'srt');

        // Upload images
        statusText.innerText = 'Uploading images...';
        for (let i = 0; i < imageFiles.length; i++) {
            await uploadToBackend(imageFiles[i], 'images');
            const p = 5 + ((i + 1) / imageFiles.length) * 15; // 5% to 20%
            progressFill.style.width = `${p}%`;
        }

        // Trigger generation
        socket.emit('start-generation', { sessionId });

    } catch (err) {
        statusText.innerText = 'Error: ' + err.message;
        generateBtn.disabled = false;
    }
});

async function uploadToBackend(file, fieldname) {
    const formData = new FormData();
    formData.append(fieldname, file);

    const res = await fetch(`/upload?sessionId=${sessionId}`, {
        method: 'POST',
        body: formData
    });
    if (!res.ok) throw new Error(`Failed to upload ${fieldname}`);
}

// Socket progress listeners
socket.on('progress', (data) => {
    statusText.innerText = data.message;
    if (data.progress) {
        // Map backend 0-100 to 20-100 (since upload took first 20%)
        const totalProgress = 20 + (data.progress * 0.8);
        progressFill.style.width = `${totalProgress}%`;
    }
});

socket.on('finished', (data) => {
    statusText.innerText = 'Complete!';
    progressFill.style.width = '100%';
    resultContainer.classList.remove('hidden');
    downloadLink.href = data.url;
    generateBtn.disabled = false;
});

socket.on('error', (data) => {
    statusText.innerText = 'Error: ' + data.message;
    generateBtn.disabled = false;
});
