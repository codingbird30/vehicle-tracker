# PaddleOCR Plate Detection Service

Small Python sidecar that does the actual OCR. The Node.js backend calls this on `localhost:5001`.

## Setup (one-time)

```bash
cd python-ocr
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

First install takes 5-10 minutes — PaddleOCR pulls in a couple hundred MB of model weights and dependencies.

## Run

```bash
# from python-ocr/ with venv activated
python app.py
```

You'll see:
```
[python-ocr] Loading PaddleOCR (first request only, ~10s)...
[python-ocr] PaddleOCR ready.
[python-ocr] Starting on port 5001
```

Leave it running. Now start the Node.js server in another terminal — it talks to this service automatically.

## Verify

```bash
curl http://localhost:5001/health
# {"ok": true, "service": "paddleocr"}

curl -F "image=@/path/to/plate.jpg" http://localhost:5001/detect
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `ModuleNotFoundError: paddleocr` | Run `pip install -r requirements.txt` again |
| First request times out | Model loads on first request (~10s). Subsequent requests are fast. |
| `paddlepaddle` install fails on Mac M1/M2 | Use `pip install paddlepaddle` directly (without version pin) |
| Port 5001 already in use | Run `python app.py 5002` and set `PYTHON_OCR_URL=http://localhost:5002` in `.env` |
