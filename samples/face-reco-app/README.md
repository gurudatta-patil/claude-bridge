# Stitch · Face Detection App

A TypeScript + Express web app that captures live camera frames and runs face
detection via a Python sidecar — connected through Stitch.

```
Browser (camera) → POST /api/analyze → Express server
                                         └─ PythonBridge.analyzeFrame()
                                               └─ Python sidecar (OpenCV)
                                         ← { faces: [{x,y,w,h,confidence}] }
Browser (canvas overlay) ←────────────────────────────────────────────────
```

---

## Step 1 — Install Node deps

```bash
cd face-reco-app
npm install
```

---

## Step 2 — Register the Stitch MCP server (once, globally)

```bash
claude mcp add stitch -- npx tsx /path/to/claude-bridge/mcp-server/src/index.ts
```

Verify:
```bash
claude mcp list
```

---

## Step 3 — Open Claude Code in this folder

```bash
cd face-reco-app
claude
```

---

## Step 4 — Paste this prompt into Claude Code

```
Use the generate_stitch MCP tool to create a bridge with these details:

  bridge_name: face_detector

  target_capability: >
    Expose one method for real-time face detection from a JPEG image.

    Method signature:
      analyze_frame({ image_b64: string }) → { faces: Array<{x, y, w, h, confidence}> }

    Implementation:
    - Decode the base64 string to raw bytes using Python's base64 module
    - Use cv2.imdecode(numpy.frombuffer(bytes, numpy.uint8), cv2.IMREAD_COLOR)
      to decode the JPEG into an OpenCV image
    - Convert to grayscale with cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    - Load the built-in face cascade:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(cascade_path)
      Instantiate the classifier ONCE at module level (not inside the handler).
    - Call face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30,30))
    - For each detected face (x, y, w, h) return:
        { "x": int(x), "y": int(y), "w": int(w), "h": int(h), "confidence": 1.0 }
    - If no faces detected, return { "faces": [] }
    - Do NOT import or use any deep-learning model — Haar cascades only.

  dependencies: ["opencv-python-headless", "numpy"]

After generating the bridge, do NOT modify server.ts — it already imports
.stitch/bridges/face_detector.js and calls analyzeFrame({ image_b64 }).
```

---

## Step 5 — Start the server

```bash
npm start
```

Open **http://localhost:3000** in your browser, click **Start Camera**, and
bounding boxes will appear around detected faces.

---

## What Stitch generates

```
.stitch/
  bridges/
    face_detector.py    ← Python sidecar (cv2 Haar cascade)
    face_detector.ts    ← TypeScript PythonBridge client class
  shared/
    sidecar_base.py
    bridge-client-base.ts
    path-helpers.ts
  venvs/
    face_detector/      ← isolated venv with opencv-python-headless + numpy
```

The Python sidecar starts as a child process, communicates over stdin/stdout
using newline-delimited JSON-RPC, and exits automatically when the Node
process exits.

---

## Image transfer convention

Stitch passes binary data as base64 strings.  
The browser does:

```js
cap.getContext("2d").drawImage(video, 0, 0);
const image_b64 = cap.toDataURL("image/jpeg", 0.75).split(",")[1];
```

The Python handler does:

```python
import base64, numpy as np, cv2
raw   = base64.b64decode(params["image_b64"])
img   = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
```

No temp files, no HTTP multipart — just a plain JSON field.

---

## Architecture diagram

```
analyze.ts (Express)
  └─ new PythonBridge(".stitch/bridges/face_detector.py")
       └─ spawn python face_detector.py
            │  stdin   {"id":"1","method":"analyze_frame","params":{"image_b64":"..."}}
            │  stdout  {"id":"1","result":{"faces":[{"x":120,"y":80,"w":60,"h":60,"confidence":1.0}]}}
            └─ exits when Node closes its stdin pipe
```
