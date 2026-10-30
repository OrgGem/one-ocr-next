# Model resources

`oneocr.onemodel` is bundled in this repository and the Docker image. It is the
original caller-supplied asset (~56 MiB), not an alternative OCR model. Docker
loads `/app/models/oneocr.onemodel` directly; no model volume/download is needed.
Passing the `models/` directory also works: a prepared `bundle.json` takes
precedence; otherwise the loader falls back to `models/oneocr.onemodel`.

Run `npm run prepare-models -- /path/to/oneocr.onemodel models` on Linux or Windows.
The Node-only reader produces `bundle.json`, `config.pb` and `resources/`.
All 67 resources retain SHA-256 digests and original names in the manifest.
The runtime checks resource digests before loading a session or alphabet.

The supplied source model has SHA-256:
`076001d9d8ca2982e88d32e20d074efc52dcccf4982119ce1e97b005215220dc`.

`deepdoc-layout.onnx` is the pinned optional semantic page-layout detector
included in this repository and Docker image. It is not loaded into an ONNX
session until a request selects `layout=deepdoc`. The 12,246,147-byte artifact
is from `InfiniFlow/deepdoc` revision
`b47049894cf047c980987af8c8c90fc438217097`, file SHA-256
`fd77f4f78cd8030aee14b0fc38446ee1585de55ad207c0005f69d170961364cb`, licensed
Apache-2.0. The runtime verifies both size and SHA-256 before accepting it.
Its raw graph contract is `images [1,3,640,640] -> output0 [1,15,8400]`.
The matching legacy DeepDoc preprocessing/postprocessing contract is referenced
from RAGFlow v0.10.0; the HF snapshot does not publish a model-to-code manifest,
so compatibility is inferred from the pinned graph metadata and source path.
See [preprocessing and semantic layout](../docs/PREPROCESSING-LAYOUT.md).

`needle3.cact` is the pinned Needle 3 model for optional post-OCR JSON
extraction. It is 35,335,380 bytes from
[`Cactus-Compute/needle3` revision `d6c7d6a2e9655505e0f8e23339356dd1705900eb`](https://huggingface.co/Cactus-Compute/needle3/tree/d6c7d6a2e9655505e0f8e23339356dd1705900eb),
SHA-256 `c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38`,
Apache-2.0 ([pinned model card/license metadata](https://huggingface.co/Cactus-Compute/needle3/blob/d6c7d6a2e9655505e0f8e23339356dd1705900eb/README.md),
[license text](https://www.apache.org/licenses/LICENSE-2.0)).
`cactus-needle` 0.3.0 and its bundled WASM runtime are pinned in
`package-lock.json`; the runtime verifies the local model before inference and
does not download weights at request time. See
[the JSON extraction guide](../docs/NEEDLE-EXTRACTION.md) and
[third-party notices](../THIRD_PARTY_NOTICES.md).

34 resources are ONNX models. Conversion of private `OneOCRFeatureExtract`
operators occurs in memory, using standard ONNX operators; source model bytes
remain unchanged. The other resources contain configuration, alphabets,
composite-character maps, case mappings and detector calibration data.

Generated model conversions, manifests, research captures and binary buffers
are ignored by Git. The source assets documented above remain separate from,
and are not licensed as, the new JavaScript implementation. The explicit Git
inclusions are the original `models/oneocr.onemodel` and the pinned
`models/deepdoc-layout.onnx` and `models/needle3.cact`. Research-only flat
captures in this directory are not required by the runtime or copied into the
Docker image.
