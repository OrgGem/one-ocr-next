# Sources and dependencies

The new runtime is implemented in `src/`. The provided model and Windows DLLs
are caller-supplied Microsoft OneOCR artifacts; this project does not assign a
new license to those assets. No Windows DLL is required or included in the
Linux image.

At the project owner's request, the original `models/oneocr.onemodel` is included
in the repository and Docker image. It retains its original provenance and is
not relicensed as part of the JavaScript service. Its SHA-256 is
`076001d9d8ca2982e88d32e20d074efc52dcccf4982119ce1e97b005215220dc`.

The optional `models/deepdoc-layout.onnx` is an InfiniFlow model asset from
[`InfiniFlow/deepdoc` revision b47049894cf047c980987af8c8c90fc438217097](https://huggingface.co/InfiniFlow/deepdoc/tree/b47049894cf047c980987af8c8c90fc438217097),
licensed Apache-2.0. Its SHA-256 is
`fd77f4f78cd8030aee14b0fc38446ee1585de55ad207c0005f69d170961364cb`.
The model is bundled in the repository and Docker image at the owner's request;
it is used only when a request opts into `layout=deepdoc`. Apache License 2.0:
https://www.apache.org/licenses/LICENSE-2.0 .

The optional `models/needle3.cact` is the Cactus Compute Needle 3 model from
[`Cactus-Compute/needle3` revision `d6c7d6a2e9655505e0f8e23339356dd1705900eb`](https://huggingface.co/Cactus-Compute/needle3/tree/d6c7d6a2e9655505e0f8e23339356dd1705900eb).
It is 35,335,380 bytes, SHA-256
`c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38`, and is
licensed Apache-2.0; see the upstream
[model card and license metadata](https://huggingface.co/Cactus-Compute/needle3/blob/d6c7d6a2e9655505e0f8e23339356dd1705900eb/README.md)
and [Apache License 2.0 text](https://www.apache.org/licenses/LICENSE-2.0).
The local JavaScript/WASM runtime dependency
[`cactus-needle` 0.3.0](https://github.com/afshinm/cactus-needle/tree/e32e2f0437d3eb9d8ae2bf1a9ac07b530b733d01)
is also Apache-2.0. The bundled `needle.wasm` is 923,348 bytes with SHA-256
`c43f48e11f302087250d1e406024956781cd2f02595a5e343b3d7ddd5ef707fa`.
The runtime verifies the local model before inference; the model and WASM are
packaged with the app and no runtime weight download is required. See
[the extraction guide](docs/NEEDLE-EXTRACTION.md).

The semantic layout tensor contract follows the legacy implementation in
[`RAGFlow v0.10.0 deepdoc/vision/recognizer.py`](https://github.com/infiniflow/ragflow/blob/v0.10.0/deepdoc/vision/recognizer.py)
and [`layout_recognizer.py`](https://github.com/infiniflow/ragflow/blob/v0.10.0/deepdoc/vision/layout_recognizer.py).
The HF snapshot does not state that source revision as an artifact manifest;
the relationship is a compatibility inference, pinned locally by the ONNX
graph metadata and checksum.

* `OrgGem/oneocr`, commit `796ce6dc08e070070f3d6c104b9ffb5447066833`:
  https://github.com/OrgGem/oneocr . MIT Python wrapper used as the Windows
  reference/oracle. Its ctypes ABI and result shape guided compatibility.
  Original wrapper authors credited by that project include Aurora Wright,
  Cecilia and b1tg. The wrapper is not bundled in the Linux runtime.
* `bropines/oneocr-onnx-python`, commit
  `75cc12666503425ffd6ea0cb052c0bcaaff21058`:
  https://github.com/bropines/oneocr-onnx-python . MIT, Copyright (c) 2026 bropines.
  Its ORT interception methodology and pipeline exploration informed the
  Windows analysis tool. Vocabulary identities, container mode, tensor shapes
  and private feature operators were independently checked against the supplied
  artifacts. The following MIT notice applies to that reference contribution.
* `shiyori/oneocr-native`: https://github.com/shiyori/oneocr-native . AGPL-3.0;
  documentation and resource-format hypotheses were consulted during research.
  Its implementation was not copied into this runtime. Hypotheses were checked
  against the supplied files; in particular, the supplied container uses CFB128.

MIT permission notice for the bropines reference:

Copyright (c) 2026 bropines

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Runtime dependencies, pinned in `package-lock.json`, retain their own notices:
ONNX Runtime Node 1.24.3 (Microsoft, MIT), sharp 0.35.5 (Apache-2.0, including
its separately licensed native dependencies), and bidi-js 1.0.3 (MIT). Their
packages include license files. Python analysis dependencies are not needed
in production.
