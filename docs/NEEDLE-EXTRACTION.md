# Trích xuất JSON tùy chọn sau OCR

`extract=needle` chạy Needle 3 sau OneOCR để chuyển `text` OCR thành một object
theo JSON Schema con được hỗ trợ. Mặc định không bật tính năng này và response
OCR không đổi. Đây là trích xuất văn bản có schema, không phân tích ảnh hoặc
khôi phục cấu trúc hàng/cột của bảng. Runtime chỉ tạo JSON theo schema; không có
tool callback hoặc hành động ứng dụng nào được thực thi.

## HTTP

Chỉ dùng multipart khi bật extraction. Gửi đúng một file trong trường `file`
hoặc `image`, một trường văn bản `schema` chứa JSON Schema, và tùy chọn một
trường văn bản `instruction`:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@invoice.png \
  -F 'schema={"type":"object","properties":{"supplier":{"type":"string"},"invoice_number":{"type":"string"},"total_amount":{"type":"string"},"currency":{"type":"string"}},"required":["supplier","invoice_number","total_amount","currency"],"additionalProperties":false}' \
  -F 'instruction=Extract only values visible in the OCR text.' \
  'http://127.0.0.1:8001/v1/ocr?language=en&extract=needle'
```

Service chạy OCR trước rồi mới trích xuất từ `result.text`. Response giữ nguyên
các trường OCR cấp cao nhất và thêm `extraction`. Ví dụ dưới đây là phần mới của
response; model metadata vẫn xác định đúng model và runtime đã pin:

```json
{
  "extraction": {
    "provider": "cactus-needle-wasm",
    "model": {
      "name": "needle3",
      "revision": "d6c7d6a2e9655505e0f8e23339356dd1705900eb",
      "sha256": "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
      "runtime": "cactus-needle",
      "runtime_version": "0.3.0"
    },
    "schema_validation": "valid",
    "output_validation": "valid",
    "status": "success",
    "elapsed_ms": 1892,
    "data": {
      "supplier": "Acme Tools Ltd.",
      "invoice_number": "INV-042",
      "total_amount": "1250.00",
      "currency": "USD"
    }
  }
}
```

Measured values above come from a direct model smoke using the OCR text
`INVOICE / Supplier: Acme Tools Ltd. / Invoice number: INV-042 / Total amount: 1250.00 USD`;
it took 1.892 seconds with 83 input bytes and 337 context bytes on the worker's
test machine. That run validates the local model call and output shape, not HTTP
or image-to-extraction end-to-end behavior. `extraction.elapsed_ms` measures the
whole extraction phase, including schema/context checks, hash verification,
first-use runtime/worker setup, inference, and abort cleanup when applicable.

`schema_validation` means the supplied schema passed this service's supported
subset checks. `output_validation` checks the generated JSON value's structure
and types against that normalized schema. `success` does not prove that the
values are factually correct; this API does not return a confidence score.
Validate important extracted fields in the calling application. After
schema/context accounting, the result includes `schema_sha256`, `input_bytes`, and
`context_bytes`; `max_context_bytes` appears when context exceeds its limit.
Early timeout, busy, or unavailable outcomes may omit those byte/hash fields.
`error` is present for non-success outcomes, and `data` is present only on
success.

## Schema limits

The root must be an object. Supported types are `object`, `array`, `string`,
`number`, `integer`, `boolean`, and `null`. Objects use `properties` and optional
`required`; arrays use `items`; scalar types can use `enum`. `description`,
`title`, and `$schema` text are accepted. Objects are closed: the service forces
`additionalProperties: false`; if supplied, only `false` is accepted.

| Limit | Maximum |
| --- | ---: |
| Raw schema JSON | 8 KiB UTF-8 |
| Schema nesting depth (root is level 1) | 7 |
| Schema nodes | 96 |
| Properties in one object | 32 |
| Values in one scalar enum | 32 |
| Items in a generated array | 64 |
| One description | 2 KiB UTF-8 |
| All descriptions together | 4 KiB UTF-8 |
| Optional instruction | 1 KiB UTF-8 |
| OCR text + normalized schema and instruction | 6 KiB UTF-8 |
| Generated output | 512 tokens |

`$ref`, composition keywords, unknown keywords, and `additionalProperties` schemas
are rejected. Oversized context is reported as `input_too_large`; the service
does not truncate OCR text, schema, or instruction.

## Status and resource behavior

`extraction.status` can be `success`, `no_match`, `invalid_model_output`,
`unavailable`, `input_too_large`, or `timeout`. The direct engine API can also
return `busy`; the HTTP service reserves one extraction slot and returns HTTP
503 with `Retry-After: 1` (`extraction_busy`) for a concurrent extraction before
running OCR. Invalid or unsupported schema, an instruction over 1 KiB, and
raw-image extraction requests return HTTP 422 before OCR. After OCR, extraction
timeout, missing model, runtime failure, no match, invalid model output, and
context-size outcomes stay in the HTTP 200 response and preserve the OCR fields.
If the overall 60-second request deadline expires, the request still returns
HTTP 504.

The default extraction budget is 15 seconds inside the 60-second request
deadline. The timeout can be changed with `ONEOCR_EXTRACTION_TIMEOUT_MS`; the
overall request timeout uses `ONEOCR_REQUEST_TIMEOUT_MS`. Extraction uses a
single local Needle slot per service instance. `GET /health/ready` reports
`json_extraction_model_available`, `json_extraction_provider`, and pending-slot
counts. The availability field checks whether the configured model path exists;
model hash verification and runtime initialization happen on first extraction.

In the observed direct-model smoke, a numeric schema variant for `total_amount`
was rejected during grounding, and one Vietnamese invoice returned `no_match`.
These single examples do not establish language accuracy; evaluate representative
documents before relying on extracted values.

With the JavaScript API, run OCR first and pass its text and a JavaScript schema
object to `extractJson`:

```js
const ocr = await engine.recognize(image, {language: 'en'});
const extraction = await engine.extractJson(ocr.text, schema, {
  instruction: 'Extract only values printed in the OCR text.',
});
```

The model and runtime stay local. The service checks the bundled model size and
SHA-256 before use and constructs the runtime with downloading disabled. The
provider is `cactus-needle-wasm`; no remote inference service is called. See
[model provenance](../models/README.md) and
[third-party notices](../THIRD_PARTY_NOTICES.md).

Needle's published structured-extraction description is in the
[`cactus-compute/needle` project](https://github.com/cactus-compute/needle).
This service pins the JavaScript runtime to
[`cactus-needle` commit `e32e2f0437d3eb9d8ae2bf1a9ac07b530b733d01`](https://github.com/afshinm/cactus-needle/tree/e32e2f0437d3eb9d8ae2bf1a9ac07b530b733d01)
and its weights to
[`Cactus-Compute/needle3` revision `d6c7d6a2e9655505e0f8e23339356dd1705900eb`](https://huggingface.co/Cactus-Compute/needle3/tree/d6c7d6a2e9655505e0f8e23339356dd1705900eb).
