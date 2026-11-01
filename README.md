# One OCR Next — API service chạy Linux native

Bản port ở thư mục này đọc trực tiếp `oneocr.onemodel`, chạy ONNX Runtime CPU
trên Linux, không dùng Wine hoặc DLL Windows. Node.js giải mã container, xử lý
ảnh, phát hiện dòng, chọn hệ chữ, nhận dạng CTC và trả JSON qua CLI/API HTTP.

**Trạng thái: bản port hoạt động, chưa đạt tương đương đầy đủ với DLL gốc.**
Pipeline chính đã dùng lattice và model confidence/rejection gốc, với 21 đặc
trưng đã khôi phục. Hình học/crop, ghép vùng và một số trường hợp đặc biệt còn
khác engine gốc. Đối chiếu hiện tại khớp text và danh sách từ ở 19/21 ảnh thử;
hai ảnh còn khác là Arabic và Devanagari. Xem
[báo cáo và các giới hạn](docs/PORTING-REPORT.md) trước khi dùng thay thế engine gốc.

## Docker Hub: image 1.1

Image `gemvn90/one-ocr-next:1.1` đóng gói OneOCR (`oneocr.onemodel`, ~56 MiB),
DeepDoc layout (12.2 MB), Needle JSON (35.3 MB), và ddddocr CAPTCHA model cùng
charset (13.6 MB + 57 KB). Các model tùy chọn được xác minh/nạp khi feature
tương ứng được gọi lần đầu; không cần volume model hoặc runtime download.
OneOCR giữ nguyên SHA-256
`076001d9d8ca2982e88d32e20d074efc52dcccf4982119ce1e97b005215220dc`.
Tag `1.1` là phiên bản image; package Node.js và API/OpenAPI contract vẫn là
`0.2.0`.

Ví dụ Linux/macOS Bash. Image được phát hành cho `linux/amd64`; các lệnh chọn
platform đó (host ARM cần hỗ trợ emulation). Key 256-bit được sinh bằng Node có
sẵn trong image, chỉ giữ trong biến môi trường và không in ra terminal. Port
chỉ bind loopback:

```bash
set -e
docker pull --platform linux/amd64 gemvn90/one-ocr-next:1.1
export ONEOCR_API_KEY="$(docker run --platform linux/amd64 --rm \
  --entrypoint node gemvn90/one-ocr-next:1.1 -e \
  "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
: "${ONEOCR_API_KEY:?API key generation failed}"

docker run --detach --name one-ocr-next --init \
  --platform linux/amd64 \
  --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 256 --memory 2g --cpus 2 \
  --publish 127.0.0.1:8001:8001 \
  --env ONEOCR_API_KEY \
  gemvn90/one-ocr-next:1.1

ready=0
for ((attempt = 0; attempt < 30; attempt++)); do
  if curl --silent --fail http://127.0.0.1:8001/health/ready >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  docker logs --tail 100 one-ocr-next
  echo 'Service did not become ready within 30 seconds.' >&2
  exit 1
fi
curl --fail http://127.0.0.1:8001/health/ready
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@image.png \
  'http://127.0.0.1:8001/v1/ocr?language=vi'
```

Trên Windows PowerShell, dùng các lệnh thay thế cho khối Bash trên:

```powershell
$image = 'gemvn90/one-ocr-next:1.1'
docker pull --platform linux/amd64 $image
$env:ONEOCR_API_KEY = (docker run --platform linux/amd64 --rm --entrypoint node $image -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))").Trim()
if (-not $env:ONEOCR_API_KEY) { throw 'API key generation failed' }
docker run --detach --name one-ocr-next --init --platform linux/amd64 --restart unless-stopped --read-only --tmpfs "/tmp:rw,noexec,nosuid,size=64m" --cap-drop ALL --security-opt "no-new-privileges:true" --pids-limit 256 --memory 2g --cpus 2 --publish 127.0.0.1:8001:8001 --env ONEOCR_API_KEY $image
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  curl.exe --silent --fail http://127.0.0.1:8001/health/ready | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { docker logs --tail 100 one-ocr-next; throw 'Service did not become ready within 30 seconds.' }
curl.exe --fail http://127.0.0.1:8001/health/ready
curl.exe --fail-with-body -H "Authorization: Bearer $env:ONEOCR_API_KEY" -F "file=@image.png" "http://127.0.0.1:8001/v1/ocr?language=vi"
```

Để chạy từ checkout bằng Compose, `tools/init-service.mjs` tạo `.env` và key
ngẫu nhiên một lần. Script này nằm trong source repo, không được đóng gói vào
image:

```bash
git clone https://github.com/OrgGem/one-ocr-next.git
cd one-ocr-next
node tools/init-service.mjs
ONEOCR_IMAGE=gemvn90/one-ocr-next:1.1 docker compose pull ocr
ONEOCR_IMAGE=gemvn90/one-ocr-next:1.1 docker compose up -d --no-build --wait
set -a; . ./.env; set +a
curl --fail http://127.0.0.1:8001/health/ready
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@image.png 'http://127.0.0.1:8001/v1/ocr?language=vi'
```

Mặc định service bind tại `127.0.0.1:8001`, yêu cầu Bearer API key, chạy user
`node`, có healthcheck và giới hạn CPU/RAM. Xem [thiết kế API và vận hành](docs/SERVICE.md)
và [OpenAPI](docs/openapi.json). Layout gắn nhãn vùng semantic nhưng không tạo
hàng/cột bảng: [hướng dẫn](docs/PREPROCESSING-LAYOUT.md),
[receipt](docs/evidence/preprocessing-layout.md). PDF được raster hóa và OCR
từng trang: [hướng dẫn](docs/PDF-INPUT.md), [receipt](docs/evidence/pdf-input.md).
Needle chạy sau OCR với schema JSON: [hướng dẫn](docs/NEEDLE-EXTRACTION.md),
[receipt](docs/evidence/needle-extraction.md). CAPTCHA chạy trực tiếp trên ảnh;
các bộ lọc `captcha_*` mặc định tắt: [hướng dẫn](docs/CAPTCHA-EXTRACTION.md),
[receipt và false positives](docs/evidence/captcha-preprocess.md).
Không commit `.env` hoặc API key.

GitHub Actions cũng kiểm thử runtime, build image, chạy Compose và gọi OCR qua
HTTP; workflow publish riêng tới `ghcr.io/orggem/one-ocr-next`. Tag Docker Hub
`gemvn90/one-ocr-next:1.1` là bản release có version rõ ràng. Xem trạng thái
workflow và kiểm tra manifest registry trước khi coi một lần publish hoàn tất.

## Chạy trên Linux

Yêu cầu Node.js 22.19 trở lên; môi trường đã kiểm tra là Node.js 24.22.1,
Linux x86-64 Debian Bookworm, CPU. Dùng các file trong thư mục này và file model
gốc của bạn. Không cần Python hoặc DLL để chuẩn bị hay chạy model.

```bash
cd /path/to/one-ocr-next
ONNXRUNTIME_NODE_INSTALL=skip npm ci

# Cách 1: dùng container model gốc trực tiếp
node src/cli.mjs recognize /path/to/image.png \
  --models /path/to/oneocr.onemodel --language vi --text

# Cách 2: giải mã một lần để nạp tài nguyên riêng khi cần
npm run prepare-models -- /path/to/oneocr.onemodel models
node src/cli.mjs recognize /path/to/image.png --models models --output result.json
```

`ONNXRUNTIME_NODE_INSTALL=skip` bỏ phần cài bổ sung GPU; bản port sử dụng CPU.
Các thư viện native của ONNX Runtime và sharp vẫn cần binary đúng hệ điều hành.
Chạy `npm ci` trên Linux để có dependency Linux. Không chép `node_modules` Windows
sang Linux.

Repo có sẵn model gốc. Có thể dùng `--models models/oneocr.onemodel` để chạy
trực tiếp hoặc chuẩn bị `models/` như trên. Không cần REA trong tiến trình OCR.

## API JavaScript

```javascript
import {OcrEngine} from './src/index.mjs';

const engine = await OcrEngine.create({modelPath: 'models', threads: 2});
try {
  const result = await engine.recognize('/path/to/image.png', {
    language: 'vi',       // bỏ qua hoặc 'auto' để tự chọn hệ chữ
    maxLines: 1000,
    resizeLong: 1152,
    resizeShort: 768,
    decoder: 'native',    // lattice thưa + 20 đường đi, mặc định
  });
  console.log(result.text, result.lines);
} finally {
  await engine.close();
}
```

Nhận đường dẫn hoặc Buffer ảnh mã hóa. Để chuyển trực tiếp struct ảnh từ ví dụ
C++, nhận thêm `{type: 3, width, height, stride, data: bgraUint8Array}` với BGRA32
và stride dương theo byte; kênh alpha của input raw được bỏ qua.
`delayLoad: false` nạp đủ 34 model khi khởi tạo;
mặc định nạp detector/classifier trước, các model khác theo nhu cầu. Mỗi engine
xử lý tuần tự các yêu cầu để kiểm soát tài nguyên. Hỗ trợ `AbortSignal` giữa các
giai đoạn; không ngắt được một lần chạy ONNX đang diễn ra.

Kết quả gồm `text`, `text_angle`, `lines`, mỗi dòng có `text`, `bounding_rect`,
`words`, `script`, `style`, `layout`. Mỗi từ có `text`, `bounding_rect`,
`confidence`. Tọa độ theo ảnh sau khi áp dụng EXIF orientation. Trường
`provenance` ghi rõ phương pháp confidence và hình học đang sử dụng.
`confidence` mặc định đến từ model OneOCR trên đặc trưng được tái tạo;
`token_confidence` giữ điểm token để chẩn đoán. Điểm không được cam kết trùng
DLL khi crop hoặc chuỗi nhận dạng khác. Mỗi dòng có kết quả rejection và ngưỡng
từ config; `rejectLowQuality: false` cho phép xem cả dòng bị loại.

Chế độ `decoder: 'beam'` / `'greedy'` phục vụ so sánh, dùng confidence token và
không chạy rejection. `beamWidth` chỉ định riêng cũng chọn chế độ beam để giữ
cách gọi cũ. Với `decoder: 'native'`, không cần đặt `beamWidth`.

Các model có 9 hệ chữ: Latin (bao gồm tiếng Việt), CJK, Cyrillic, Arabic,
Devanagari, Greek, Thai, Hebrew, Tamil. Các alias phổ biến: `vi`, `en`, `zh`,
`ja`, `ko`, `ru`, `ar`, `hi`, `el`, `th`, `he`, `ta`. Gói model này không có Bengali.

## HTTP

Trong checkout, chạy `node tools/init-service.mjs` một lần để tạo `.env` và API
key nếu chưa có; script không in key và không ghi đè file cũ. Cài dependency
Linux bằng `npm ci` trước khi chạy source server.

```bash
# Terminal 1: local source runtime. Override image-only model paths from .env.
set -a; . ./.env; set +a
ONEOCR_MODEL_PATH=models/oneocr.onemodel \
ONEOCR_LAYOUT_MODEL_PATH=models/deepdoc-layout.onnx \
ONEOCR_NEEDLE_MODEL_PATH=models/needle3.cact \
ONEOCR_CAPTCHA_MODEL_PATH=models/common_old.onnx \
ONEOCR_CAPTCHA_CHARSET_PATH=models/common_old-charset.json \
node src/server.mjs
```

Trong terminal thứ hai, nạp cùng API key rồi gọi các mode trên endpoint chung:

```bash
set -a; . ./.env; set +a
curl --fail http://127.0.0.1:8001/health/ready

# Default OneOCR on an image.
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@image.png \
  'http://127.0.0.1:8001/v1/ocr?language=vi'

# Optional semantic regions and mapped image preprocessing.
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@test/vietnamese-tables/fixtures/vi-table-grid.png \
  'http://127.0.0.1:8001/v1/ocr?language=vi&layout=deepdoc&max_dimension=1600&deskew=true&padding=16'

# OneOCR on selected PDF pages; PDF input is rasterized page by page.
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -H 'Content-Type: application/pdf' --data-binary @invoice.pdf \
  'http://127.0.0.1:8001/v1/ocr?language=vi&pdf_dpi=150&pdf_pages=1-2'

# Opt-in Needle JSON extraction runs after OneOCR on the returned text.
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@invoice.png \
  -F 'schema={"type":"object","properties":{"invoice_number":{"type":"string"},"total":{"type":"string"}},"required":["invoice_number","total"],"additionalProperties":false}' \
  'http://127.0.0.1:8001/v1/ocr?language=vi&extract=needle'

# Direct ddddocr CAPTCHA mode with composable cleanup options (all are optional).
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -H 'Content-Type: image/png' --data-binary @captcha.png \
  'http://127.0.0.1:8001/v1/ocr?extract=ddddocr&captcha_threshold=auto&captcha_polarity=auto&captcha_remove_lines=grid&captcha_line_min_length_px=96&captcha_line_max_width_px=1&captcha_remove_wavy_lines=true&captcha_dots_max_area=2'
```

Các mode trên dùng cùng `POST /v1/ocr`; alias `/`, `/ocr`, `/api/v1/ocr` giữ
tương thích. `layout=deepdoc` thêm nhãn vùng semantic; `lines[].layout` gốc của
OneOCR chỉ mô tả hướng glyph, còn DeepDoc không khôi phục hàng/cột bảng.
`extract=needle` cần multipart kèm trường `schema`; PDF dùng cùng schema riêng
cho từng trang. `extract=ddddocr` chạy model trực tiếp, không chạy OneOCR và trả
response khác. Request bình thường tối đa 20 MiB/40 triệu pixel; PDF và mode
CAPTCHA có giới hạn riêng. Service nhận tối đa 8 request upload/xử lý/chờ, có
Bearer auth khi `ONEOCR_API_KEY` được đặt (Compose bắt buộc), deadline 60 giây,
request ID và log JSON không ghi ảnh/text/key. Xem
[PDF](docs/PDF-INPUT.md), [Needle](docs/NEEDLE-EXTRACTION.md),
[layout/preprocessing](docs/PREPROCESSING-LAYOUT.md) và
[CAPTCHA](docs/CAPTCHA-EXTRACTION.md) để biết giới hạn/response.

CAPTCHA cleanup mặc định tắt; không truyền `captcha_*` thì tensor path giữ nguyên.
Có thể kết hợp `captcha_threshold=auto|0..255`,
`captcha_polarity=auto|dark|light`, `captcha_remove_lines=horizontal|vertical|grid`,
`captcha_line_min_length_px=8..1024`, `captcha_line_max_width_px=1..3`,
`captcha_remove_wavy_lines=true|false` và `captcha_dots_max_area=1..8`.
`captcha_*` chỉ hợp lệ với `extract=ddddocr`; line tuning cần bật line/wave removal;
work raster bị giới hạn 1 MP/1200 px
mỗi cạnh. Bộ lọc có thể xóa chi tiết chữ: test tổng hợp từng thấy grid xóa vạch
glyph thẳng hàng và wave xóa nét glyph cong phủ ngang; chúng không khẳng định
tăng accuracy chung. Xem [receipt preprocessing CAPTCHA](docs/evidence/captcha-preprocess.md).

## Docker Linux

Dockerfile đóng gói OneOCR, DeepDoc layout, Needle và ddddocr model/charset trong
image. Build local dùng tag `oneocr-next:local`; container chạy bằng Node.js CPU.

```bash
docker build -t oneocr-next:local .
docker compose up -d --build --wait
docker compose logs --tail 100 ocr
docker compose down
```

Image dùng user `node`, có healthcheck, pin base image theo digest. Compose
không mount volume model. Runtime không chứa DLL Windows. Linux amd64 đã được
kiểm chứng; GPU/ARM64 chưa được kiểm chứng.

## Kiểm tra và đối chiếu

```bash
npm test                             # full functional/regression suite; gần nhất 70/70, không phải điểm accuracy
npm run test:unit                    # không cần model, kiểm tra HTTP bằng fake engine
npm run test:service                 # gọi service Docker đang chạy, đọc key từ .env
node test/calibration-parity.mjs      # 23 quan sát input/output từ DLL gốc
node test/native-confidence-parity.mjs # 14 từ: đặc trưng -> GetOcrWordConfidence
node test/lattice-parity.mjs          # logits native, 8 hệ chữ, 56 trường hợp từ
node test/compare-corpus.mjs          # báo cáo đối chiếu, không phải test 100% parity
npm run test:vi                      # 8 ảnh tiếng Việt/bảng, đáp án viết trước
```

`test/corpus/native-oracle.json` ghi kết quả từ đúng DLL được cung cấp. Ảnh thử
được dựng từ font để kiểm tra chức năng, không phải benchmark tài liệu thực tế
hoặc chữ viết tay thực. Các script Python trong `tools/` chỉ phục vụ nghiên cứu
Windows và tạo baseline; không nằm trong đường chạy Linux.

Bộ [test tiếng Việt và bảng biểu](test/vietnamese-tables/README.md) kiểm tra
nội dung từng ô, số tiền, thứ tự đọc và bounding box, kèm báo cáo HTML.
Hiện đạt 7/8 ảnh tổng hợp; dãy ký tự dấu rời còn lỗi nên `test:vi` trả exit code 1.

`ModelBundle.evaluateFeatures(role, profile, features)` cho phép chạy riêng các
model Confidence/Rejection với đúng 21 float đầu vào. `assembleWordFeatures`
được export để tạo vector từ thống kê ký tự và các giả thuyết lattice. Đây cũng
chính là đường chạy trong decoder mặc định. Các kiểm tra component dùng logits
hoặc thống kê native đã ghi; chúng không thay thế đối chiếu ảnh end-to-end.

Model giữ nguyên nguồn gốc của bộ file được cung cấp; việc đóng gói không gán
license mã JavaScript cho model OneOCR. Git và image có model OneOCR, DeepDoc,
Needle, ddddocr và charset được pin; tài nguyên nghiên cứu Windows/DLL không
được đóng gói trong runtime. `npm test` gần nhất đạt 70/70 functional tests;
suite chất lượng riêng `npm run test:vi` đạt 7/8 ảnh tổng hợp và trả exit 1 vì
dấu tiếng Việt rời còn lỗi. Điều này không phải tuyên bố accuracy/parity chung.
CAPTCHA cleanup có các false positive đã ghi nhận và một thay đổi output trên
fixture; xem [receipt CAPTCHA](docs/evidence/captcha-preprocess.md). Xem
[nguồn tham khảo](THIRD_PARTY_NOTICES.md).
