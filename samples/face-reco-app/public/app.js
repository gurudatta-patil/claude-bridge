/**
 * app.js — browser-side camera capture + face overlay.
 *
 * Flow:
 *   1. getUserMedia → <video>
 *   2. Every INTERVAL ms: draw video frame to hidden <canvas>, export JPEG base64
 *   3. POST /api/analyze { image_b64 }  →  { faces: [{x,y,w,h,confidence}] }
 *   4. Draw bounding boxes + confidence labels on the overlay canvas
 */

(() => {
  const video    = document.getElementById("video");
  const overlay  = document.getElementById("overlay");
  const btnStart = document.getElementById("btn-start");
  const btnStop  = document.getElementById("btn-stop");
  const statusEl = document.getElementById("status");
  const countEl  = document.getElementById("face-count");
  const fpsBadge = document.getElementById("fps-badge");

  const ctx      = overlay.getContext("2d");
  const cap      = document.createElement("canvas"); // hidden capture canvas

  const INTERVAL_MS  = 200;  // ~5 fps to server
  const JPEG_QUALITY = 0.75;
  const BOX_COLOR    = "#00e5ff";
  const LABEL_BG     = "rgba(0,0,0,0.55)";

  let stream      = null;
  let timerId     = null;
  let lastFps     = 0;
  let frameCount  = 0;
  let fpsInterval = null;
  let inFlight    = false;

  // ── helpers ────────────────────────────────────────────────────────────────

  function setStatus(msg, cls = "") {
    statusEl.textContent = msg;
    statusEl.className   = cls;
  }

  function syncOverlaySize() {
    overlay.width  = video.videoWidth  || 640;
    overlay.height = video.videoHeight || 480;
  }

  function captureBase64() {
    cap.width  = video.videoWidth;
    cap.height = video.videoHeight;
    cap.getContext("2d").drawImage(video, 0, 0);
    // Strip the data:image/jpeg;base64, prefix
    return cap.toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1];
  }

  function drawFaces(faces) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const scaleX = overlay.offsetWidth  / (video.videoWidth  || 640);
    const scaleY = overlay.offsetHeight / (video.videoHeight || 480);

    for (const { x, y, w, h, confidence } of faces) {
      const dx = x * scaleX;
      const dy = y * scaleY;
      const dw = w * scaleX;
      const dh = h * scaleY;

      // Box
      ctx.strokeStyle = BOX_COLOR;
      ctx.lineWidth   = 2;
      ctx.strokeRect(dx, dy, dw, dh);

      // Corner accents
      const cs = Math.min(dw, dh) * 0.18;
      ctx.lineWidth = 3;
      [[dx, dy], [dx+dw, dy], [dx, dy+dh], [dx+dw, dy+dh]].forEach(([cx, cy], i) => {
        const sx = i % 2 === 0 ? cs : -cs;
        const sy = i < 2 ? cs : -cs;
        ctx.beginPath();
        ctx.moveTo(cx + sx, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy);
        ctx.stroke();
      });

      // Label
      const label = `${Math.round((confidence ?? 0) * 100)}%`;
      ctx.font      = `bold ${Math.max(11, dw * 0.1)}px monospace`;
      const tw      = ctx.measureText(label).width;
      const lx      = dx;
      const ly      = dy > 20 ? dy - 6 : dy + dh + 16;
      ctx.fillStyle = LABEL_BG;
      ctx.fillRect(lx - 2, ly - 13, tw + 8, 17);
      ctx.fillStyle = BOX_COLOR;
      ctx.fillText(label, lx + 2, ly);
    }

    countEl.childNodes[0].textContent = faces.length > 0 ? String(faces.length) : "–";
  }

  // ── capture loop ───────────────────────────────────────────────────────────

  async function tick() {
    if (inFlight || !video.videoWidth) return;
    inFlight = true;

    try {
      syncOverlaySize();
      const image_b64 = captureBase64();

      const res  = await fetch("/api/analyze", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ image_b64 }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      if (data.stub) {
        setStatus("⚠ Bridge not loaded — run Ghost-Bridge (see README)", "error");
        drawFaces([]);
        return;
      }

      drawFaces(data.faces ?? []);
      setStatus(data.faces.length ? `${data.faces.length} face(s) detected` : "No faces detected", "ok");
      frameCount++;
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      inFlight = false;
    }
  }

  // ── camera lifecycle ───────────────────────────────────────────────────────

  btnStart.addEventListener("click", async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();

      btnStart.disabled = true;
      btnStop.disabled  = false;
      setStatus("Camera active — connecting to Python bridge…");

      timerId    = setInterval(tick, INTERVAL_MS);
      fpsInterval = setInterval(() => {
        fpsBadge.textContent = `${frameCount} fps`;
        frameCount = 0;
      }, 1000);
    } catch (err) {
      setStatus(`Camera error: ${err.message}`, "error");
    }
  });

  btnStop.addEventListener("click", () => {
    clearInterval(timerId);
    clearInterval(fpsInterval);
    timerId = fpsInterval = null;

    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    btnStart.disabled = false;
    btnStop.disabled  = true;
    fpsBadge.textContent = "– fps";
    countEl.childNodes[0].textContent = "–";
    setStatus("Camera stopped.");
  });
})();
