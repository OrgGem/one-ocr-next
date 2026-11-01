# CAPTCHA text recognition with ddddocr

Use the existing `POST /v1/ocr` endpoint with `extract=ddddocr` for a direct,
single-image CAPTCHA OCR mode. This mode runs the pinned ddddocr model and does
not run OneOCR; its response is the prediction plus model metadata, without
document OCR lines, boxes, or confidence. The default `/v1/ocr` image path is
unchanged when `extract` is omitted. `extract=needle` remains the separate
post-OneOCR JSON extraction mode.

## Requests

Send one supported image as a raw body:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -H 'Content-Type: image/png' \
  --data-binary @captcha.png \
  'http://127.0.0.1:8001/v1/ocr?extract=ddddocr'
```

Multipart is also supported with one file in `file` or `image`:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F 'file=@captcha.png;type=image/png' \
  'http://127.0.0.1:8001/v1/ocr?extract=ddddocr'
```

`application/octet-stream` is accepted for raw image bytes. Do not send PDF,
`schema`, or `instruction`. CAPTCHA mode rejects OneOCR language/script, layout,
general preprocessing, and PDF page options with HTTP 422 rather than silently
ignoring them. Its own optional cleanup parameters are described below. The
feature is a separate recognition mode on the same route, not an additional
OneOCR result or a document OCR operation.

## Response

The response has top-level `request_id`, `text`, and `extraction` fields.
`text` is the model output when `status` is `success`, or an empty string for
`no_match`. `extraction` reports provider, pinned model and charset digests,
CPU runtime, input dimensions, normalized width, status, and elapsed time. The
API does not return a confidence value or bounding boxes and does not change the
model's character casing.

| `extraction` field | Meaning |
| --- | --- |
| `provider` | `ddddocr-onnxruntime` |
| `model` | `common_old.onnx`, pinned upstream revision and model/charset SHA-256 values |
| `runtime` | `onnxruntime-node` 1.24.3 using the CPU execution provider |
| `status` | `success` or `no_match` |
| `input` | Decoder-reported `width`/`height` and model `normalized_width` |
| `elapsed_ms` | Full CAPTCHA phase, including first-use asset verification/session setup, preprocessing, and inference |

## Model and limits

The bundled model is upstream `sml2h3/ddddocr`'s default `common_old.onnx` from
commit `c40f56f95412e10bcb9bd0bd24411e92f896d238` (13,606,051 bytes,
SHA-256 `b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68`).
Its default charset has 8,210 entries and SHA-256
`342d871c34fd467420cd39b58a4624b505da53114e77a69b43b48b8a3ee1b24d`. Both
assets are verified against their pinned size and digest before use. They are
bundled locally; the feature does not add a Python runtime or download model
files at request time. See [model files](../models/README.md) and
[third-party notices](../THIRD_PARTY_NOTICES.md). The default paths are
`models/common_old.onnx` and `models/common_old-charset.json`; override them
with `ONEOCR_CAPTCHA_MODEL_PATH` and `ONEOCR_CAPTCHA_CHARSET_PATH`. The model
session and checksum verification are lazy-loaded on the first CAPTCHA request.

The model expects one text line. The port sets normalized width to
`floor(original_width * 64 / original_height)`, resizes to that width by 64
pixels, converts to grayscale, normalizes pixels to `[0,1]`, and decodes CTC
output through the pinned default charset. Widths outside 8..512 are rejected
before resizing or allocating the tensor. Sharp's
Lanczos3/BT.601 operations approximate upstream Pillow preprocessing; pixel
parity with Pillow has not been established.

## Optional noise cleanup

Cleanup is off by default. With no `captcha_*` parameters, the existing CAPTCHA
input path and response stay unchanged. These options are composable and are
accepted only with `extract=ddddocr`:

| Query parameter | Values | Meaning |
| --- | --- | --- |
| `captcha_threshold` | `auto` or `0..255` | Grayscale threshold; numeric values use 8-bit levels. |
| `captcha_polarity` | `auto`, `dark`, `light` | Which side of the threshold is foreground. |
| `captcha_remove_lines` | `horizontal`, `vertical`, `grid` | Remove straight lines on the selected axes. |
| `captcha_line_min_length_px` | `8..1024` | Minimum straight/wavy-line length in working-raster pixels. |
| `captcha_line_max_width_px` | `1..3` | Maximum straight/wavy-line width in working-raster pixels; defaults to 1. |
| `captcha_remove_wavy_lines` | `true`, `false` | Enable the bounded thin-wave heuristic. |
| `captcha_dots_max_area` | `1..8` | Remove connected foreground components up to this area in working-raster pixels. |

Line tuning parameters require `captcha_remove_lines` or enabled
`captcha_remove_wavy_lines`; orphaned tuning options return HTTP 422
`invalid_options`. When `captcha_line_min_length_px` is omitted, horizontal
straight lines default to `max(8, ceil(65% of working-raster width))` and
vertical lines to `max(8, ceil(90% of working-raster height))`. `grid` applies
both defaults. Wavy paths use the greater of `max(8, ceil(80% of working-raster width))`
and the explicit minimum, if supplied. Supplying
`captcha_remove_wavy_lines=false` alone leaves the model tensor on its existing
path and returns `preprocessing.enabled: false`. If another cleanup setting
activates the pipeline, omitted threshold and polarity resolve to `auto`.
Supplying either threshold or polarity explicitly (including `auto`), line
removal, enabled wave removal, or dot removal opts in to preprocessing. `auto`
threshold uses Otsu; `auto` polarity chooses the less populated side of that
threshold as foreground.

On the opt-in path, the service makes a bounded grayscale working raster no
larger than 1200 pixels on its longest edge or 1 megapixel, then applies
threshold/polarity, straight lines, the wavy-line heuristic, dots, and finally
the model resize in that order. Line lengths/widths and dot area are measured
on the working raster. It applies EXIF auto-orientation before sizing this
raster; `working_raster.scale_x` and `.scale_y` are relative to those oriented
dimensions, while `input.width` and `.height` retain decoder-reported
dimensions. For example:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -H 'Content-Type: image/png' \
  --data-binary @captcha.png \
  'http://127.0.0.1:8001/v1/ocr?extract=ddddocr&captcha_remove_lines=grid&captcha_remove_wavy_lines=true&captcha_dots_max_area=2'
```

When any `captcha_*` parameter is supplied, `extraction.preprocessing` reports
`enabled`, the `configured` values actually supplied, `applied_order`, and a
`working_raster` object with dimensions, X/Y scales, whether a raster was
created, and its pixel count. `applied_order` records the stages actually run:
`grayscale`, `threshold`, `polarity`, optional `straight_lines`, `wavy_lines`,
`isolated_components`, and `resize_to_model`. Its `threshold` record gives
method (`otsu` or `fixed`), selected value, foreground polarity, and before/after
foreground pixel counts. `straight_lines` includes selected axes, resolved
length/width bounds, candidate run count, removed pixels, and preserved
crossings, and rejected thick components; `wavy_lines` reports its bounds,
candidate paths, removed pixels, preserved branch pixels, and rejected thick
columns; `dots` reports 8-connected component counts and removed pixels. With
no such parameter this field is absent. `captcha_*` parameters on normal OneOCR or Needle
requests return HTTP 422 `captcha_options_unsupported`; other query options in
CAPTCHA mode return `ddddocr_options_unsupported`.

These filters are destructive heuristics. Dot removal can erase detached glyph
dots or thin strokes. Straight-line filters use the configured geometric
bounds. Wavy removal only targets smooth, thin paths spanning at least 80% of
the working-raster width; detected branches/crossings are preserved and counted
by this heuristic, but that is not a general guarantee. It is not general wave
removal or page dewarping. No universal recognition improvement
is claimed. In the local synthetic contact sheet, grid cleanup erased an
aligned glyph bar and wavy cleanup erased a full-width wave-like glyph stroke.
The [preprocessing evidence receipt](evidence/captcha-preprocess.md) records
these false positives and the one-fixture real-model output change. Compare
results on representative images before enabling filters.

| Bound | Limit |
| --- | ---: |
| Whole HTTP body (raw bytes or multipart envelope) | `min(ONEOCR_MAX_BODY_BYTES, 8 MiB)`; multipart boundaries count |
| Decoded image pixels | `min(ONEOCR_MAX_PIXELS, 4 million)` (4 million by default) |
| Width or height | 2..4096 pixels |
| Normalized width | 8..512 pixels (at most 64 output steps) |
| Active CAPTCHA inference per service process | 1 |
| HTTP request deadline | Shared `ONEOCR_REQUEST_TIMEOUT_MS` (60 seconds by default) |

Oversized bytes return HTTP 413 `captcha_image_too_large`; invalid dimensions
or aspect ratio return 422 `captcha_image_dimensions`. Invalid image bytes return
400 `invalid_image`. PDF input returns 422 `ddddocr_requires_image`; unsupported
query options, schema, or instruction parts return 422
`ddddocr_options_unsupported`. Missing or invalid model assets and a busy
CAPTCHA slot return 503 `captcha_unavailable` or `captcha_busy`. Inference and
image-processing failures return 502 `captcha_inference_failed` or
`captcha_image_processing_failed`; invalid model output returns 502
`captcha_model_output_invalid`. The overall request deadline returns 504
`request_timeout`.

## Recognition limits

The bundled charset includes ASCII letters and digits, but omits Vietnamese
specific letters `Đ đ ă â ê ô ơ ư`. Do not use this mode as general Vietnamese
document OCR. With cleanup disabled, four locally rendered noisy 340×100
synthetic CAPTCHA images had 0/4 exact-case matches and 4/4 case-insensitive
matches. This is a
small fixture observation, not a broad accuracy benchmark: no representative
real CAPTCHA corpus or Python pixel-parity comparison was used. The API returns
the predicted casing unchanged.

Provenance and the pinned upstream inference/preprocessing/charset source are
listed in [third-party notices](../THIRD_PARTY_NOTICES.md) and the
[upstream repository](https://github.com/sml2h3/ddddocr/tree/c40f56f95412e10bcb9bd0bd24411e92f896d238).
