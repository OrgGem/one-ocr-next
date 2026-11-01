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
`schema`, or `instruction`. CAPTCHA mode rejects OneOCR language/script,
layout, preprocessing, and PDF page options with HTTP 422 rather than silently
ignoring them. It is a separate recognition mode on the same route, not an
additional OneOCR result or a document OCR operation.

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
| `input` | Original `width`, `height`, and `normalized_width` used for inference |
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
document OCR. In four locally rendered noisy 340×100 synthetic CAPTCHA images,
exact-case matches were 0/4 while case-insensitive matches were 4/4. This is a
small fixture observation, not a broad accuracy benchmark: no representative
real CAPTCHA corpus or Python pixel-parity comparison was used. The API returns
the predicted casing unchanged.

Provenance and the pinned upstream inference/preprocessing/charset source are
listed in [third-party notices](../THIRD_PARTY_NOTICES.md) and the
[upstream repository](https://github.com/sml2h3/ddddocr/tree/c40f56f95412e10bcb9bd0bd24411e92f896d238).
