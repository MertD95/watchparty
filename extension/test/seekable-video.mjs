// Creates a short real video element inside the page so Playwright, the page,
// and the content-script world all observe the same media state.

export async function injectSeekableTestVideo(page, targetTimeSeconds = 2) {
  await page.evaluate(async (desiredTime) => {
    for (const existing of [...document.querySelectorAll('video')]) {
      existing.remove();
    }

    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };

    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    recorder.start();
    let frame = 0;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        ctx.fillStyle = frame % 2 === 0 ? '#1d4ed8' : '#16a34a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        frame += 1;
        if (frame >= 35) {
          clearInterval(timer);
          recorder.stop();
          stream.getTracks().forEach((track) => track.stop());
          resolve();
        }
      }, 100);
    });
    await stopped;

    const video = document.createElement('video');
    video.id = 'wp-test-video';
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'none';
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    document.body.appendChild(video);

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('failed to load test media'));
    });

    const safeTime = Math.min(desiredTime, Math.max(0, (video.duration || desiredTime) - 0.1));
    await new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = safeTime;
      setTimeout(resolve, 500);
    });
  }, targetTimeSeconds);

  await page.waitForTimeout(1000);
}
