# CAPTCHA preprocessing evidence

## Scope

`extract=ddddocr` preprocessing is opt-in. The existing no-option tensor path remains byte-identical, and `captcha_remove_wavy_lines=false` alone also uses that path. Requested transforms operate on an auto-oriented grayscale working raster capped at 1,200 pixels per side and 1,000,000 pixels. They run in a fixed order: grayscale, threshold/polarity, straight-line removal, wavy-line removal, isolated-component removal, then model resize. The model output remains the model's predicted string; no confidence or correction is added.

## Validation

- `node --test test/captcha-preprocess.test.mjs test/captcha-extraction.test.mjs`: 20/20 passed.
- `npm test`: 70/70 passed, zero skipped.
- The tests cover detached multi-pixel dots, 8-connected specks, horizontal/vertical grid removal, connected glyph branches, a supported wavy path, rejection of thick paths, strict option errors, pre-allocation aspect-ratio checks, exact no-op tensor identity, real model HTTP extraction, and 1 MP event-loop/deadline yielding.
- A deterministic 320 x 120 before/after contact sheet and JSON ground-truth pixel counts were generated and visually inspected at the ignored local path `.local/captcha-preprocess-evidence/captcha-preprocess-contact-sheet.png`. Those generated images are local test evidence and are not part of the API package.

## Synthetic pixel results

These pixel counts measure only the hand-marked foreground in the small synthetic fixtures; they do not measure character accuracy on CAPTCHA datasets.

| Fixture | Marked foreground retained | Observed behavior |
| --- | ---: | --- |
| Detached dots and stems | 106/106 (100%) | Two isolated one-pixel specks removed; four-pixel detached dots and stems retained. |
| Horizontal/vertical grid crossing a glyph | 39/53 (73.6%) | Grid removed; the vertical glyph branch remains, while its horizontal bar aligned with a rule is ambiguous and partly removed. |
| Wavy interference crossing a glyph | 90/90 (100%) | 317 wave pixels removed; the marked crossing strokes remain. |
| Thin `i`/`j` strokes, detached dots, and specks | 132/132 (100%) | Two one-pixel specks removed; the marked stems and detached multi-pixel dots remain. |
| Full-width text-like sinusoid | 0/320 (0%) | The wave heuristic removes the entire smooth, high-coverage curve. This is a known false-positive case. |

The grid and wave modes are intentionally destructive heuristics. Pixels that coincide with interference cannot always be distinguished from text strokes. In particular, a long thin glyph can match a full-width wave candidate; leave wave removal disabled where such shapes may carry meaning.

## Real model observation

The pinned model was run on the existing `captcha-1.png` fixture and a deterministic synthetic variant with a full horizontal rule and two isolated specks:

- Clean fixture: `aBC123`.
- Noisy variant without preprocessing: `aBC123`.
- Same noisy variant with Otsu thresholding, horizontal-line removal, and one-pixel component removal: `ABC123`.

The filtered result changed the lowercase `a` to uppercase `A`. This single observation demonstrates the real inference path and a possible recognition change; it does not establish a general accuracy gain or loss. Preprocessing runs on CPU and may alter glyph shapes.

## Resource and failure behavior

- Source CAPTCHA limits remain 8 MiB per request, 4,000,000 source pixels, 4,096 pixels per side, and a normalized model width of at most 512.
- The optional grayscale work raster is limited to 1,000,000 pixels and 1,200 pixels per side. Raster operations yield to the Node event loop and check the existing request abort/deadline.
- Invalid CAPTCHA preprocessing values return HTTP 422 with `invalid_options`. CAPTCHA-only options outside `extract=ddddocr` return HTTP 422 with `captcha_options_unsupported`; incompatible OCR/PDF/Needle options remain rejected before recognition.
- The installed ONNX Runtime call itself remains native, non-interruptible work; this change does not claim otherwise.

## Historical overlay check (before the 1.1 release)

The normal fresh Dockerfile build was attempted as `oneocr-next:captcha-preprocess-validation-20261101`. It reached `npm ci` but showed no additional progress or error for 4m12; only that build was cancelled. To validate the changed source without repeating an unchanged package install, I built a local overlay from the already-available CAPTCHA image after checking its runtime and pinned assets:

- Base image: `oneocr-next:captcha-validation-20261101`, image ID `sha256:9ef5ed5f398b7c83168e040ec0b2a1df65c2a71cde54b82119c52ad539c2d72f`.
- Base runtime: Node `v24.22.1`, `onnxruntime-node` `1.24.3`, Sharp `0.35.5`, `pdfjs-dist` `6.4.299`, `@napi-rs/canvas` `1.1.0`, and `cactus-needle` `0.3.0`. Bundled CMaps, standard fonts, and PDF.js WASM assets were present.
- CAPTCHA assets verified in the base image: `common_old.onnx` SHA-256 `b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68`; `common_old-charset.json` SHA-256 `342d871c34fd467420cd39b58a4624b505da53114e77a69b43b48b8a3ee1b24d`. The Needle model verification also passed.
- Overlay build context copied the current `src/` and `docs/openapi.json` over that base. Image: `oneocr-next:captcha-preprocess-validation-20261101`, ID `sha256:8fc3d2706a5e3d7b3e14e6353fe595db60f965fc0e29cf0e25298d477ec364e3`, `linux/amd64`, inspect size 238,386,429 bytes.
- A disposable `--rm` container passed readiness and OpenAPI checks. Default image OCR returned HTTP 200; the synthetic noisy image returned HTTP 200 with preprocessing stats (231 straight-line pixels and 2 isolated pixels removed); an invalid threshold returned HTTP 422 `invalid_options`; raw PDF returned HTTP 200 with three source pages and page 1 selected. The container was removed after the smoke run.

This was an overlay check rather than a successful fresh full Dockerfile build. No image had been pushed at that point. The later full build and Docker Hub publication are recorded below.

## Docker Hub 1.1 release

- Source revision: `0ba099ac7dd495fd752c21d7202080b196930208` on `main` (`OrgGem/one-ocr-next`). The source and README were committed and pushed before the image build; no source or Dockerfile changes were made for this release build.
- The first full build hit npm `ECONNRESET` while fetching dependencies. A lock-resolved `onnxruntime-node@1.24.3` archive (85,987,774 bytes) was downloaded in verified byte ranges and matched the lockfile SHA-512. A cache-seed check ran `npm cache add` followed by `ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --offline --no-audit --no-fund`; all 38 production packages installed offline and the installed runtime reported `1.24.3`.
- The standard Dockerfile build then succeeded with exit 0: `docker build --progress=plain --platform linux/amd64 --tag gemvn90/one-ocr-next:1.1 --label org.opencontainers.image.version=1.1 --label org.opencontainers.image.revision=0ba099ac7dd495fd752c21d7202080b196930208 .` The local image ID is `sha256:347b34f5869721865ed4a68b4a7464835e0dd3795c0cbec71f6c9296e3e017cd`, platform `linux/amd64`, inspect size 238,329,867 bytes. OCI version and revision labels match `1.1` and the source revision above.
- The build-time Needle and CAPTCHA asset verifiers passed. A disposable container also verified presence of the OneOCR, DeepDoc, Needle, CAPTCHA ONNX, and charset files plus PDF.js `cmaps`, `standard_fonts`, and `wasm` assets.
- Container HTTP smoke passed readiness and OpenAPI (`captcha_threshold` present); default image OCR returned HTTP 200; opt-in CAPTCHA preprocessing returned HTTP 200 with `ABC123` (Otsu threshold 136; 231 straight-line pixels and 2 isolated pixels removed); invalid threshold returned HTTP 422 `invalid_options`; raw PDF selected page 1 returned HTTP 200 for a three-page source; and real multipart Needle extraction returned `invoice_number: INV-042`, `currency: USD`. The disposable container was removed.
- `docker push gemvn90/one-ocr-next:1.1` exited 0; 17 layers were pushed and 6 already existed. `docker buildx imagetools inspect gemvn90/one-ocr-next:1.1` confirmed OCI index digest `sha256:347b34f5869721865ed4a68b4a7464835e0dd3795c0cbec71f6c9296e3e017cd`, with the `linux/amd64` image manifest `sha256:1e2d3025b3d1141ea48e98e11b27f108e6f11fbd8a82e1d2991e677839168f33` and a BuildKit attestation manifest. The `1.0` and `latest` tags were not changed.
