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

## Build và deploy Docker

Repo và Docker image có sẵn `models/oneocr.onemodel` (~56 MiB). Container chạy
độc lập, không cần mount model hoặc tải model khi khởi động. Model giữ nguyên
SHA-256 `076001d9d8ca2982e88d32e20d074efc52dcccf4982119ce1e97b005215220dc`.

```bash
git clone https://github.com/OrgGem/one-ocr-next.git
cd one-ocr-next
node tools/init-service.mjs            # tạo .env và API key ngẫu nhiên
docker compose up -d --build --wait
curl --fail http://127.0.0.1:8001/health/ready

set -a; . ./.env; set +a
curl --fail -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@test/vietnamese-tables/fixtures/vi-table-grid.png \
  'http://127.0.0.1:8001/v1/ocr?language=vi'
```

Nếu host chỉ cài Docker, có thể tạo `.env` bằng Node trong image:

```bash
docker build -t oneocr-next:local .
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" \
  -w /workspace --entrypoint node oneocr-next:local tools/init-service.mjs
docker compose up -d --wait
```

Mặc định service publish tại `127.0.0.1:8001`, yêu cầu Bearer API key, chạy user
`node`, filesystem read-only, giới hạn CPU/RAM và có healthcheck. Xem
[thiết kế API và vận hành](docs/SERVICE.md), [OpenAPI](docs/openapi.json).
Không commit `.env`; công cụ tạo key không ghi đè cấu hình đã có.

GitHub Actions kiểm thử runtime, build image có model, chạy Compose và kiểm
tra OCR thật qua HTTP. Sau khi các bước đạt, push trên `main`/tag `v*` sẽ publish
image tới `ghcr.io/orggem/one-ocr-next` với tag `latest`/version và `sha-<commit>`.
Khả năng publish thực tế phụ thuộc quyền Packages/Actions của repo; xem trạng
thái workflow trước khi dùng image từ registry.

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

```bash
ONEOCR_MODEL_PATH=models/oneocr.onemodel node --env-file=.env src/server.mjs
curl --fail http://127.0.0.1:8001/health/ready
curl --fail -H "Authorization: Bearer $ONEOCR_API_KEY" -F file=@image.png \
  'http://127.0.0.1:8001/v1/ocr?language=vi'
```

POST `/v1/ocr` nhận ảnh raw hoặc một file multipart `file`/`image`; các alias
`/`, `/ocr`, `/api/v1/ocr` giữ tương thích. Query hỗ trợ `language`, `script`,
`max_lines`, `resize_long`, `resize_short`, `min_confidence`, `reject_low_quality`.
Giới hạn mặc định: request 20 MiB, ảnh 40 triệu pixel và mỗi chiều tối đa 10.000,
tối đa 8 request đang upload/xử lý/chờ. Có Bearer auth khi đặt `ONEOCR_API_KEY`
(Compose bắt buộc). Request có deadline 60 giây, request ID và log JSON không
ghi nội dung ảnh/text/key. SIGINT/SIGTERM ngừng nhận request và drain session.

## Docker Linux

Dockerfile đóng gói model gốc trong image; runtime đọc/giải mã bằng Node.js.

```bash
docker build -t oneocr-next:local .
docker compose up -d --wait
docker compose logs --tail 100 ocr
docker compose down
```

Image dùng user `node`, có healthcheck, pin base image theo digest. Compose
không mount volume model. Runtime không chứa DLL Windows. Hiện đã kiểm tra
Linux amd64; GPU/ARM64 chưa được kiểm chứng.

## Kiểm tra và đối chiếu

```bash
npm test                             # container, Unicode, 34 model, OCR, HTTP
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
license mã JavaScript cho model. Chỉ model gốc được đưa vào Git/image; tài nguyên
giải mã và DLL nghiên cứu được bỏ qua. Xem [nguồn tham khảo](THIRD_PARTY_NOTICES.md).
