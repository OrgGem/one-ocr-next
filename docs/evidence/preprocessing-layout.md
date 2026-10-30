# Preprocessing and layout verification receipt

Recorded 2026-10-29 for the pinned DeepDoc layout model and the optional HTTP path. Results below are scoped to this revision and the stated synthetic fixture.

## Automated checks

- `npm test`: 28/28 passed, 0 skipped.
- Focused preprocessing/layout tests: 8/8 passed, 0 skipped.
- Docker build: `docker build -t oneocr-next:layout-validation-20261029 .` succeeded. Build context was 12.30 MB and copied the OneOCR and DeepDoc model assets.

The container was started separately for an HTTP smoke and then stopped and removed. The existing service/Compose deployment was not replaced. `/health/ready` reported `semantic_layout_provider: "deepdoc-onnx"`.

## HTTP smoke

Fixture: `test/vietnamese-tables/fixtures/vi-table-grid.png`.

- Compatibility path: `POST /v1/ocr?language=vi` returned 23 lines and no `layout` property.
- Opt-in path: `POST /v1/ocr?language=vi&layout=deepdoc&max_dimension=1024&padding=20` returned five layout regions, including a recognized `table` region whose OneOCR crop text contains `Mặt hàng`. The top-level coordinate space was `decoded_image_pixels_after_exif`.
- The smoke does not demonstrate cell/row/column reconstruction; the returned table region is OCR text from a crop.

## Local timing observation

Measured with an inline Node script (no benchmark script was added), on AMD Ryzen 7 7840HS, Windows x64, Node.js 24.21.0, ONNX Runtime Node 1.24.3 and two threads. Input was the same 1360×760 synthetic Vietnamese table fixture.

| Observation | Result |
| --- | --- |
| First layout detection, including warm-up | 121.0 ms |
| Five subsequent detections | 55.8, 49.2, 50.2, 45.6, 45.9 ms |
| RSS before layout inference | 84.8 MB |
| RSS after layout-provider warm-up | 182.9 MB |
| RSS observed with the full OneOCR + layout engine | 286 MB |
| Full semantic OCR request, wall / engine time | 432.0 / 426.7 ms |
| Lines / characters returned | 23 / 180 |

These are single-machine measurements on one synthetic image, not a throughput or accuracy benchmark and not a performance guarantee.

## OCR quality boundary

The fresh `npm run test:vi` quality suite exited 1 because the detached-diacritics case still fails: only 1 of 6 cells matched exactly (5 of 6 did not), with CER 0.3922. The other four required cases (including grid, borderless and merged tables) passed; all three stress checks passed; numeric table values matched in 39/39 cells. This does not establish broad Vietnamese or document accuracy. The existing detached-mark limitation remains open, and the optional layout detector does not fix OneOCR recognition errors.

## Model/source identity

The model is `InfiniFlow/deepdoc` revision [`b47049894cf047c980987af8c8c90fc438217097`](https://huggingface.co/InfiniFlow/deepdoc/tree/b47049894cf047c980987af8c8c90fc438217097), `layout.onnx`, 12,246,147 bytes, SHA-256 `fd77f4f78cd8030aee14b0fc38446ee1585de55ad207c0005f69d170961364cb`, Apache-2.0. The raw graph is `[1,3,640,640] -> [1,15,8400]`. The class/preprocessing decoder is compatible with the legacy [RAGFlow v0.10.0 `Recognizer`](https://github.com/infiniflow/ragflow/blob/v0.10.0/deepdoc/vision/recognizer.py) and [layout label table](https://github.com/infiniflow/ragflow/blob/v0.10.0/deepdoc/vision/layout_recognizer.py); the Hugging Face snapshot does not publish a manifest pinning that source revision to the ONNX file, so this relationship is an inference from the artifact contract.
