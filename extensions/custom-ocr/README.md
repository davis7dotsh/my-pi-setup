# custom-ocr

One tool — `parse-file(path, question?, pages?)` — with two backends:

- **Default (Luna):** pages are rendered locally, then sent to
  `openai-codex/gpt-5.6-luna` through Pi's existing model registry and OAuth
  (no extra SDK or credentials).
- **Private (`/private-image`):** a fail-closed, fully local pipeline.
  DeepSeek-OCR transcribes each page on MLX, then Qwen fuses the page image,
  the OCR evidence, and your question into the final answer. Private mode
  never calls Luna, never downloads weights, and never falls back to any
  network service.

```text
parse-file(path, question?, pages?)
        │
        ├─ resolve path, validate type/size, normalize pages
        ├─ rasterize locally (PyMuPDF + Pillow → PNG pages)
        │
        ├─ default mode ──► GPT-5.6 Luna via Pi OAuth
        └─ private mode ──► DeepSeek-OCR ──► Qwen (image + OCR + question)
```

## Usage

```text
parse-file /tmp/scan.pdf
parse-file ~/Desktop/screenshot.png  question="What error is shown?"
parse-file report.pdf                pages={start: 3, end: 7}
```

- Accepts PNG, JPEG, WebP, GIF, TIFF, and PDF (detected by magic bytes, up to
  50 MB).
- Strips a leading `@`, expands `~`, resolves relative paths against the
  session cwd, and canonicalizes with `realpath`.
- PDFs/multi-page TIFFs process up to 20 pages per call (pages 1–20 when no
  range is given). Animated GIF, WebP, and PNG files use the first frame with
  a warning.
- Without `question`, returns exact text, visual structure, notable state,
  and uncertainty.
- Output is truncated at Pi's tool limits (50 KB / 2,000 lines); full results
  are saved to an owner-only file under `~/.cache/custom-ocr/results/`, with
  the newest 100 files retained.

## `/private-image`

```text
/private-image           # toggle
/private-image on        # switch to the local pipeline and prewarm workers
/private-image off       # back to Luna; local workers unload immediately
/private-image status    # mode, worker health, models
```

The mode is branch-local session state: it survives reload/resume, follows
the branch when forked, and every genuinely new session defaults to Luna.

### One-time setup for private mode

Private mode is fail-closed: workers run with `HF_HUB_OFFLINE=1` and only
load weights that already exist locally. Download them once, ahead of time:

```bash
uv tool run --from huggingface_hub hf download mlx-community/DeepSeek-OCR-2-4bit \
  --local-dir ~/.cache/custom-ocr/models/DeepSeek-OCR-2-4bit
uv tool run --from huggingface_hub hf download mlx-community/Qwen3.5-4B-MLX-4bit \
  --local-dir ~/.cache/custom-ocr/models/Qwen3.5-4B-MLX-4bit
```

(`/private-image on` and `status` print these commands when weights are
missing.)

### Worker security model

- Two persistent MLX worker processes (one per model — switching models in a
  single MLX-VLM server evicts the previous model).
- Bound to `127.0.0.1` on randomly allocated ports; every request requires a
  per-worker bearer token passed through the environment, and workers accept
  only rendered PNGs from custom-ocr's private temporary directories.
- Hard offline flags (`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, …); file
  contents never appear in command-line arguments.
- One inference request active at a time.
- Both process groups are killed on `/private-image off`, cancellation of an
  in-flight inference, `/reload`, and session shutdown.

## Requirements

- `uv` on PATH (renders files and runs the workers; the Python project under
  `python/` is locked with `uv.lock`).
- Luna mode: a Codex OAuth login in Pi (`/login`).
- Private mode: Apple silicon Mac + the model weights above.

## Development

```bash
cd extensions/custom-ocr
npm install
npm run check   # typecheck
npm test        # unit tests (includes the privacy sentinel)
```

The privacy sentinel test (`privacy.test.ts`) fails if the Luna backend is
ever invoked while private mode is active — including as a fallback when the
local pipeline errors.
