# Needle extraction evidence

**Observed 2026-10-29.** This receipt covers the focused local schema/runtime and
HTTP tests for optional post-OCR extraction. It is not a broad language-accuracy
benchmark.

## Asset and focused checks

The pinned model is 35,335,380 bytes from
[`Cactus-Compute/needle3` revision `d6c7d6a2e9655505e0f8e23339356dd1705900eb`](https://huggingface.co/Cactus-Compute/needle3/tree/d6c7d6a2e9655505e0f8e23339356dd1705900eb),
SHA-256 `c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38`.
`node tools/verify-needle-model.mjs models/needle3.cact` passed its pinned size
and digest check. `cactus-needle` 0.3.0 is installed from the exact lockfile
version; its packaged `needle.wasm` is 923,348 bytes, SHA-256
`c43f48e11f302087250d1e406024956781cd2f02595a5e343b3d7ddd5ef707fa`.

Focused test commands reported passing:

```text
node --test test/needle-schema.test.mjs test/server.test.mjs  13/13 passed
node --test test/needle-extraction.test.mjs                   7/7 passed
npm test                                                   40/40 passed, 0 skipped, 0 failed (~12 s)
```

The seven extraction tests include real local WASM inference, model-lifecycle and
schema-limit checks, and a real OneOCR image through an ephemeral HTTP server.
The full suite includes the generated English image-to-JSON HTTP success case
and the Vietnamese image-to-extraction non-success case below.

Docker checks reported passing:

```text
docker build --tag oneocr-needle-smoke:20261029-8f4c .
```

The image build verified the pinned model in the image. Image manifest digest:
`sha256:92c0bbb8346e34eec6f91ee4df3299d17277a004619f2bf0db026bdfe04eebfe`.
A disposable container on a random localhost port reported ready with the
Needle model available; its multipart English invoice request to
`/v1/ocr?extract=needle` returned HTTP 200 with exact OneOCR text, the pinned
model SHA, and the expected extraction object. The container was removed after
the smoke check.

## Observed extraction results

- **English text-only smoke:** Needle returned `supplier: "Acme Tools Ltd."`,
  `invoice_number: "INV-042"`, `total_amount: "1250.00"` (string), and
  `currency: "USD"`; both schema and output validation were `valid`. The call
  took 1,892 ms for 83 UTF-8 input bytes and 337 context bytes. This was a direct
  model call with supplied text, not OCR/HTTP end-to-end. `extraction.elapsed_ms`
  includes schema/context checks, model hash verification, first-use runtime and
  worker initialization, inference, and abort cleanup when applicable.
- **English invoice image over HTTP:** the generated 2000×560 fixture
  `test/needle/fixtures/en-invoice.png` (SHA-256
  `687b6892f120bdf71ded6a72a65a318ea96ea40e18868bd0975fb1ffd84b1627`) returned
  HTTP 200, exact OneOCR text `INVOICE / SUPPLIER: ACME TOOLS LTD. / INVOICE
  NUMBER: / INV-042 / TOTAL: 1250.00 USD`, and valid extraction data
  `{invoice_number: "INV-042", currency: "USD"}` in 2,315 ms. The same result
  was observed in the disposable Docker container. The expected OCR
  text and JSON values are recorded in the generated fixture
  [manifest](../../test/needle/fixtures/manifest.json).
- **Vietnamese invoice over HTTP:** `test/vietnamese-tables/fixtures/vi-invoice.png`
  returned HTTP 200 and the exact existing OneOCR expected text (6 lines, 208
  UTF-8 bytes). Extraction reported `schema_validation: valid`,
  `status: invalid_model_output`, `error.code: model_withheld_call_present`,
  `output_validation: failed`, and no `data` field. OCR text and lines remained
  in the response.
- **Vietnamese text-only smoke:** a short invoice sample returned `no_match`.
  A numeric schema variant for the English amount was rejected during grounding;
  the successful example used a string amount.

These observations show the runtime and response path work while extraction
quality remains uncertain, especially for Vietnamese. Schema-valid output checks
structure and types; it does not establish factual correctness. No confidence
score is returned.
