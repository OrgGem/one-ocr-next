# PDF input verification receipt

## Deterministic fixture

`test/fixtures/pdf-invoice-multipage.pdf` is a generated three-page fixture
(portrait invoice, landscape text, and a 90-degree rotated page). It is 2,611
bytes with SHA-256
`ce58d4c75d96acc0b3376502a5d2862e190cc1c4ce23c511ee65f73f0a26b659`.
`test/fixtures/pdf-invoice-multipage.json` records the manifest; the generator
uses the test-only `pdf-lib@1.17.1` dependency.

At 150 DPI, the renderer produced page dimensions 1241×1754, 1754×1241, and
1754×1241, for 6,530,142 rendered pixels total. The PDF.js page-1 raster was
visually compared with a Poppler reference and the invoice text/layout were
legible. This was a visual spot check, not a general PDF fidelity benchmark.

## Tests and HTTP receipts

- `node --test test/pdf-input.test.mjs`: 10/10 passed.
- `npm test`: 50/50 passed, 0 skipped, 0 failed (12.35 seconds).
- Real PDF.js renderer tests cover the three page orientations, selected-page
  ordering, raw and multipart HTTP input, 422/400 validation paths, sequential
  page processing, renderer busy behavior, no partial response after page
  failure, oversized embedded-image rejection, known-image MIME handling, and
  fail-closed capture of PDF.js and codec warnings.
- A real HTTP request using the pinned OneOCR model returned page 1 text exactly
  as `ONEOCR PDF PAGE 1\nINVOICE NUMBER: INV-042\nTOTAL: 1250.00 USD`; the result
  was 1241×1754 pixels in `rendered_page_pixels` coordinates.
- A real multipart `extract=needle` PDF request returned
  `{ "invoice_number": "INV-042", "currency": "USD" }` with `success` for the
  selected invoice page. A real DeepDoc/preprocessing PDF request retained the
  original page dimensions as preprocessing source coordinates and labeled
  layout regions in `rendered_page_pixels`.

These are bounded fixture checks, not broad PDF fidelity, OCR, or extraction
accuracy claims.

## Local Docker build and disposable container

- `docker build --tag oneocr-next:pdf-validation-20261101 .` succeeded for
  `linux/amd64`. The local image ID is
  `sha256:c7ba416c5fa1ca17fac6b8c02bd0ab5110241dd04896cda6177a1bcc2a2dd3ef`,
  image size 231,648,384 bytes (24,045,493 bytes above the 207,602,891-byte
  baseline image).
- A disposable container reported readiness, loaded `pdfjs-dist` 6.4.299 and
  `@napi-rs/canvas`, found the bundled CMap/standard-font/WASM assets and all
  three pinned model files, and verified the Needle model SHA-256.
- In that container, default PNG OCR returned the existing invoice text; raw
  three-page PDF OCR returned the exact page-1 invoice text; multipart PDF plus
  Needle returned `{"invoice_number":"INV-042","currency":"USD"}`.
- The disposable container was stopped and removed. This was a local build and
  smoke check; no image push, deployment, or change to the already-published
  `1.0` image occurred.
