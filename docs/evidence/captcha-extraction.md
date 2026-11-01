# CAPTCHA extraction implementation evidence

Date: 2026-11-01
Workspace: `D:\Git\SPT\new-port`
Feature: opt-in direct image recognition through `POST /v1/ocr?extract=ddddocr`.

## Runtime and model provenance

The service bundles the upstream `sml2h3/ddddocr` default `common_old.onnx` artifact from revision `c40f56f95412e10bcb9bd0bd24411e92f896d238` under the upstream MIT license. The 13,606,051-byte model SHA-256 is `b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68`. Its bundled `common_old-charset.json` has 8,210 entries, begins with the CTC blank token, is 57,249 bytes, and has SHA-256 `342d871c34fd467420cd39b58a4624b505da53114e77a69b43b48b8a3ee1b24d`.

Inference uses the existing pinned `onnxruntime-node@1.24.3` CPU provider and `sharp@0.35.5`; there is no runtime model download. Startup does not create the optional CAPTCHA session. Asset sizes and hashes are checked when the feature is first used and during the container build. Each model session is separate from OneOCR.

The preprocessing path resizes an accepted image to height 64 with width `floor(width * 64 / height)`, converts the RGB raster to normalized grayscale float32 NCHW, and decodes CTC argmax with blank index 0. Repeated IDs collapse unless separated by blank. Output case is preserved without corrections. The model's declared output metadata shape differs from its actual runtime tensor; inference validates actual logits as `[T,1,8210]`, finite, with `T=ceil(normalized_width/8)`. Error-only logging is set only on this CAPTCHA session to suppress the known metadata warning; other OneOCR logging is unaffected.

## API and resource bounds

Use one raw supported image MIME/octet-stream body, or one multipart `file`/`image` part. The entire HTTP body, including multipart framing, is limited to `min(ONEOCR_MAX_BODY_BYTES, 8 MiB)`. A request may not combine this mode with other query options, schema or instruction parts, or PDF input. CAPTCHA inference is direct and does not call the document OCR engine.

The extractor limits decoded images to min(`ONEOCR_MAX_PIXELS`, 4,000,000) source pixels (4,000,000 by default), 4,096 pixels per dimension, normalized width 8–512 pixels, and at most 64 output steps. A single CAPTCHA inference is admitted at a time. HTTP request deadlines apply throughout; ONNX Runtime's native inference cannot be interrupted, so a timed-out call retains its slot until native execution settles and the result is discarded.

A successful response contains `request_id`, top-level `text` (empty for `no_match`), and an `extraction` object with provider, model and charset hashes, runtime/provider, status, input dimensions, and elapsed time. The response does not claim character boxes or confidence scores.

## Validation receipts

- `node tools/verify-captcha-assets.mjs models` — both bundled artifacts matched their pinned byte counts and SHA-256 values.
- `node --test test/captcha-extraction.test.mjs` — 11/11 passed. Includes real local model inference and HTTP inference, unsupported option/PDF/schema rejection, missing-model behavior, one-slot deadline retention, close draining, oversized source/aspect bounds, CTC repeat/blank semantics, and invalid/non-finite logits.
- `npm test` — 61/61 passed on the final source/test snapshot after the container smoke. This includes existing OCR, layout, Needle, PDF, and CAPTCHA tests.

A positive real-model HTTP sample in the test fixture produced `aBC123` for the labelled synthetic `ABC123` image. The four deterministic, locally generated fixtures produced `aBC123`, `k7q9px`, `8zm4tw`, and `r5n2vc` against exact labels `ABC123`, `K7Q9PX`, `8ZM4TW`, and `R5N2VC`: 0/4 exact case-sensitive matches. This smoke proves the pinned CPU model runs through the route; it does not establish useful CAPTCHA accuracy. It is not an evaluation on a representative real challenge corpus, and Python preprocessing parity is unverified.

## Local container receip

- Built with `docker build --progress plain -t oneocr-next:captcha-validation-20261101 .` (exit 0). Docker build ran the pinned Needle and CAPTCHA asset verifiers. The resulting local image is `sha256:9ef5ed5f398b7c83168e040ec0b2a1df65c2a71cde54b82119c52ad539c2d72f`, `linux/amd64`, 238,323,356 bytes. The image description label names OneOCR, PDF input, optional DeepDoc, Needle JSON, and ddddocr CAPTCHA extraction.
- A disposable container (`bb6a59f404e212be0d2eec32c572d62155488c7d535d9ef2808c75f2b681aabb`) became ready and passed the in-container command `node tools/verify-captcha-assets.mjs /app/models` with both expected sizes and hashes.
- Raw HTTP image smoke `POST /v1/ocr?extract=ddddocr` returned `text: "aBC123"` and provider `ddddocr-onnxruntime`; the default `POST /v1/ocr` on the same image returned `text: "ABC123"`. Raw `application/pdf` OCR returned all 3 fixture pages. `GET /openapi.json` advertised `extract: ["needle", "ddddocr"]`.
- The disposable container was stopped and removed. The image remains local only; this task did not push or publish an image.