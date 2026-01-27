const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

const tempDir = '/tmp/ffmpeg-temp';

async function ensureTempDir() {
  try {
    await fs.mkdir(tempDir, { recursive: true });
  } catch (error) {
    console.error('Error creating temp directory:', error);
  }
}

async function downloadFile(url, outputPath) {
  console.log('Downloading file from:', url);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 5
  });

  const writer = require('fs').createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log('Download completed:', outputPath);
      resolve();
    });
    writer.on('error', reject);
  });
}

app.post('/generate-video', async (req, res) => {
  const requestId = Date.now();
  console.log(`[${requestId}] New request received`);

  try {
    await ensureTempDir();

    const { imageUrl, audioUrl, audioBase64, quote, fontSize = '60', lineHeight = '100' } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl is required' });
    }

    if (!audioUrl && !audioBase64) {
      return res.status(400).json({ error: 'Either audioUrl or audioBase64 is required' });
    }

    // Use unique filenames to avoid conflicts
    const imagePath = path.join(tempDir, `image_${requestId}.jpg`);
    const audioPath = path.join(tempDir, `audio_${requestId}.mp3`);
    const outputPath = path.join(tempDir, `output_${requestId}.mp4`);

    // Download image first
    console.log(`[${requestId}] Downloading image from URL:`, imageUrl);
    await downloadFile(imageUrl, imagePath);

    // Download or write audio
    if (audioUrl) {
      console.log(`[${requestId}] Downloading audio from URL:`, audioUrl);
      await downloadFile(audioUrl, audioPath);
    } else if (audioBase64) {
      console.log(`[${requestId}] Writing audio from base64`);
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      await fs.writeFile(audioPath, audioBuffer);
    }

    let filterComplex = `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v]`;

    if (quote) {
      const escapedQuote = quote
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/\n/g, '\\n');

      filterComplex += `;[v]drawtext=text='${escapedQuote}':fontfile=/usr/share/fonts/noto/NotoSansCJK-Regular.ttc:fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=${lineHeight}:borderw=3:bordercolor=black[vout]`;
    } else {
      filterComplex += `;[v]copy[vout]`;
    }

    const ffmpegArgs = [
      '-loop', '1',
      '-i', imagePath,
      '-i', audioPath,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-shortest',
      '-y',
      outputPath
    ];

    console.log(`[${requestId}] Executing FFmpeg with args:`, ffmpegArgs.join(' '));

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let stderrOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      stderrOutput += output;
      // Log progress (frame info)
      if (output.includes('frame=') || output.includes('time=')) {
        console.log(`[${requestId}] FFmpeg progress:`, output.trim().slice(0, 100));
      }
    });

    ffmpeg.on('close', async (code) => {
      console.log(`[${requestId}] FFmpeg exited with code:`, code);

      if (code !== 0) {
        console.error(`[${requestId}] FFmpeg error:`, stderrOutput.slice(-500));
        // Cleanup
        await fs.unlink(imagePath).catch(() => {});
        await fs.unlink(audioPath).catch(() => {});
        return res.status(500).json({ error: 'Video generation failed', details: stderrOutput.slice(-500) });
      }

      try {
        const videoBuffer = await fs.readFile(outputPath);
        const base64Video = videoBuffer.toString('base64');
        console.log(`[${requestId}] Video generated successfully, size: ${videoBuffer.length} bytes`);

        // Cleanup temp files
        await fs.unlink(imagePath).catch(() => {});
        await fs.unlink(audioPath).catch(() => {});
        await fs.unlink(outputPath).catch(() => {});

        res.json({
          success: true,
          video: base64Video,
          format: 'mp4'
        });
      } catch (readError) {
        console.error(`[${requestId}] Error reading output file:`, readError);
        res.status(500).json({ error: 'Failed to read generated video' });
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[${requestId}] FFmpeg spawn error:`, err);
      res.status(500).json({ error: 'Failed to start FFmpeg', details: err.message });
    });

  } catch (error) {
    console.error(`[${requestId}] Server error:`, error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg server running on port ${PORT}`);
});
