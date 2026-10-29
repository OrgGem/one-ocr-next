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

34 resources are ONNX models. Conversion of private `OneOCRFeatureExtract`
operators occurs in memory, using standard ONNX operators; source model bytes
remain unchanged. The other resources contain configuration, alphabets,
composite-character maps, case mappings and detector calibration data.

Generated weights, manifests, research captures and binary buffers are ignored
by Git. They remain the caller-supplied model assets and are not licensed as the
new JavaScript implementation. The one explicit Git exception is the original
`models/oneocr.onemodel`. Research-only flat captures in this directory are not
required by the runtime or copied into the Docker image.
