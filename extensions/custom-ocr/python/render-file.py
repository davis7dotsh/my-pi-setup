#!/usr/bin/env python3
"""Rasterize a PDF/TIFF/GIF/PNG/JPEG/WebP file into normalized PNG pages.

Runs entirely locally (PyMuPDF + Pillow). Emits a single JSON manifest line
on stdout: {"pages": [{"page": N, "path": ...}], "total_pages": N,
"warnings": [...]}. On failure, emits {"error": "..."} and exits non-zero.
"""

import argparse
import json
import sys
from pathlib import Path

# Rendering target for PDF pages before clamping to --max-side.
PDF_TARGET_DPI = 200


def fail(message: str) -> None:
    print(json.dumps({"error": message}), flush=True)
    sys.exit(1)


def clamp(image, max_side: int):
    from PIL import Image

    width, height = image.size
    longest = max(width, height)
    if longest <= max_side:
        return image
    scale = max_side / longest
    return image.resize(
        (max(1, round(width * scale)), max(1, round(height * scale))),
        Image.LANCZOS,
    )


def save_page(image, page_number: int, outdir: Path, max_side: int) -> dict:
    from PIL import Image

    if image.has_transparency_data:
        foreground = image.convert("RGBA")
        background = Image.new("RGBA", image.size, "white")
        image = Image.alpha_composite(background, foreground).convert("RGB")
    elif image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image = clamp(image, max_side)
    path = outdir / f"page-{page_number:04d}.png"
    image.save(path, format="PNG")
    return {"page": page_number, "path": str(path)}


def render_pdf(
    path: Path, start: int, end: int, outdir: Path, max_side: int, warnings: list
):
    import pymupdf
    from PIL import Image

    with pymupdf.open(path) as document:
        total = document.page_count
        if start > total:
            fail(f"Page {start} does not exist: the PDF has {total} page(s).")
        end = min(end, total)

        pages = []
        for number in range(start, end + 1):
            page = document[number - 1]
            rect = page.rect
            zoom = PDF_TARGET_DPI / 72.0
            longest_pt = max(rect.width, rect.height)
            if longest_pt * zoom > max_side:
                zoom = max_side / longest_pt
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            image = Image.frombytes(
                "RGB", (pixmap.width, pixmap.height), pixmap.samples
            )
            pages.append(save_page(image, number, outdir, max_side))
        return pages, total


def render_image(
    path: Path, start: int, end: int, outdir: Path, max_side: int, warnings: list
):
    from PIL import Image, ImageOps, ImageSequence

    with Image.open(path) as image:
        frames = getattr(image, "n_frames", 1)
        fmt = (image.format or "").upper()

        if fmt == "TIFF" and frames > 1:
            if start > frames:
                fail(f"Page {start} does not exist: the file has {frames} page(s).")
            end = min(end, frames)
            pages = []
            for index, frame in enumerate(ImageSequence.Iterator(image), start=1):
                if index < start:
                    continue
                if index > end:
                    break
                normalized = ImageOps.exif_transpose(frame.copy())
                pages.append(save_page(normalized, index, outdir, max_side))
            return pages, frames

        if frames > 1:
            label = fmt or "image"
            warnings.append(
                f"Animated {label} with {frames} frames: using the first frame only."
            )
        if start > 1:
            fail("Non-TIFF images are treated as a single page (the first frame).")
        image.seek(0)
        normalized = ImageOps.exif_transpose(image)
        return [save_page(normalized, 1, outdir, max_side)], 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--max-side", type=int, default=2048)
    args = parser.parse_args()

    path = Path(args.input)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    warnings: list = []

    try:
        with path.open("rb") as handle:
            header = handle.read(4)
        if header.startswith(b"%PDF"):
            pages, total = render_pdf(
                path, args.start, args.end, outdir, args.max_side, warnings
            )
        else:
            pages, total = render_image(
                path, args.start, args.end, outdir, args.max_side, warnings
            )
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - surfaced to the extension
        fail(f"{type(error).__name__}: {error}")
        return

    print(
        json.dumps({"pages": pages, "total_pages": total, "warnings": warnings}),
        flush=True,
    )


if __name__ == "__main__":
    main()
