# Báo cáo port OneOCR sang Linux native

## Kết luận hiện tại

Đã có runtime Node.js chạy OCR thực trên Linux x86-64 bằng đúng model được cung
cấp, không qua Wine/DLL Windows. Đã khôi phục container, alphabet của 9 hệ chữ
và chuyển đổi được toàn bộ toán tử riêng trong 34 model.

**Chưa hoàn thành yêu cầu tương đương đầy đủ mọi hành vi của DLL gốc.**
Phần còn thiếu quan trọng là fit/merge bounding box, rectification và một số
trường hợp giải mã/segmentation. Vector 21 đặc trưng, lattice thưa, 20 đường đi
và các model confidence/rejection đã được khôi phục và đưa vào pipeline chính.
Đầu ra vẫn khác khi crop, ghép vùng hoặc chuỗi nhận dạng khác native.

## Nguồn được kiểm tra

* C++ do người dùng đính kèm: ABI tạo pipeline/options, BGRA32, chạy nhận dạng,
  truy xuất dòng/từ và giải phóng handle.
* `https://github.com/OrgGem/oneocr`, commit
  `796ce6dc08e070070f3d6c104b9ffb5447066833`: Python ctypes wrapper và JSON API.
  Snapshot được kiểm tra không chứa bản Go hoàn chỉnh hoặc model đã giải mã.
* Các binary trong
  `D:\Git\SPT\one-ocr-models-20261028T194856Z-1-001\one-ocr-models`.

| File | Byte | SHA-256 |
|---|---:|---|
| oneocr.dll | 42514504 | `1310e46ffa6971101da73191f7a30580f7f7d983ab02c5fca28b5f6fd4351242` |
| oneocr.onemodel | 58453799 | `076001d9d8ca2982e88d32e20d074efc52dcccf4982119ce1e97b005215220dc` |
| onnxruntime.dll | 13137440 | `595f1fd0fd2c429d894b9850de999e04fb819fe1060bb539ee0e776fdb3a93da` |

REA 6.8.0 cung cấp kiểm tra PE exports/imports và evidence trong
`docs/evidence/`. DLL AMD64 có 24 hàm OCR export và một export dữ liệu ICU.
ORT gốc báo phiên bản 1.19.0. Bản Linux dùng ONNX Runtime Node 1.24.3 và sharp
0.35.5; không suy ra rằng hai phiên bản có toàn bộ hành vi số học giống nhau.

REA/Ghidra 12.1.4 được cài riêng ở `.local/reverse/`, với JDK riêng. Evidence
decompile và bundle trong `docs/evidence/` gắn với SHA-256 đúng DLL. Có dùng
Python Frida 17.24.3 để truy vết cấp phát và thống kê từ trong tiến trình thử do
công cụ tự tạo; Frida MCP của bản REA hiện tại thiếu native binding nên không
được tính là đã kiểm chứng. Các công cụ này không nằm trong image Linux.

Nghiên cứu bổ sung dùng pefile/capstone để đọc PE và ctypes để quan sát tensor
trong chính tiến trình thử Windows. Hook chỉ thay con trỏ của tiến trình thử,
khôi phục ở finally, không sửa file DLL/model đầu vào. Baseline Windows dùng
DLL; runtime triển khai Linux không dùng nó.

## Các điểm đã khôi phục và kiểm chứng

1. Container có index/body length little endian, resource name/offset/length và
   protobuf config. Mã hóa thực tế là AES-256-CFB với feedback 128 bit, SHA-256
   để tạo khóa, IV `Copyright @ OneO`. Quan sát BCrypt xác nhận CFB và
   `MessageBlockLength=16`; các record có độ dài không chia hết cho 16.
2. Node giải mã đủ 67 tài nguyên; toàn bộ 34 ONNX có SHA-256 trùng với các byte
   bắt được lúc engine gốc tạo ORT session. Đường dẫn build Windows trong index
   chỉ dùng làm metadata; tên file chuẩn bị ở local là ID + digest.
3. 9 recognizer được ghép alphabet qua tên resource và config. Không suy ra
   ngôn ngữ chỉ từ số chiều vocab. Gói này có Tamil, không có Bengali. CJK và
   Cyrillic dùng stride 8; các profile còn lại stride 4.
4. Input detector RGB 0..255, padding trắng; classifier/recognizer RGB 0..1,
   crop cao 60 và chiều rộng thay đổi theo tỉ lệ. Không có padding 16 pixel ở
   hai mép như một số bản tham khảo. Recognizer dùng chiều rộng ở stride kế
   tiếp và `seq_lengths` tương ứng.
5. Detector dùng cả ba FPN level, hai hướng, segment score, link score và box
   regression. Các ngưỡng được lấy từ protobuf đi kèm model.
6. 23 `OneOCRFeatureExtract` được hạ thành ONNX chuẩn. 22 block dense dùng
   Gemm + ReLU; một block layout dùng Conv 1x1 không ReLU. Thứ tự tham số trong
   cấu hình đóng băng là thứ tự stack, cần đảo khi khôi phục trọng số/bias.
   Sai vị trí ReLU ở layout đã được loại bằng đối chiếu hidden activation.
7. Bộ tạo đặc trưng native tại RVA `0xcc410` đã được khôi phục: độ dài, điểm
   acoustic, edit distance, margin, posterior sau gộp hoa/thường, blank/space/
   competitor, min/mean và histogram. Lattice dùng ngưỡng từ config, chỉ giữ
   tối đa 20 đường đi riêng rồi mới gộp xác suất sau CTC collapse. Native có
   trạng thái riêng để lược chuỗi blank; không dùng prefix beam thay thế.
8. Alphabet giữ đúng blank, space và composite supplementary private-use
   character; đầu ra composite được chuẩn hóa NFC. Có thêm prefix beam/greedy
   để chẩn đoán, và xử lý RTL giữ thứ tự số.
9. Model line layout chạy trực tiếp để phân biệt dòng CJK có glyph viết dọc
   với dòng ngang bị xoay; hướng trang và thứ tự cột dùng kết quả này.

## Phạm vi chức năng

| Chức năng | Trạng thái | Giới hạn |
|---|---|---|
| Đọc `.onemodel` trực tiếp trên Linux | Có | Format của bộ model được cung cấp |
| Chuẩn bị resource trên Linux | Có | Giữ manifest + checksum, không cần Windows |
| Nạp đủ 34 model | Có | CPU, Linux x86-64 đã kiểm tra |
| Detection, script, flip, handwriting head | Có | Pre/post-processing là bản khôi phục |
| Nhận dạng cả 9 hệ chữ | Có | Còn ca khác văn bản với native |
| Chữ Việt có dấu, composite ký tự | Có | Đã thử synthetic font |
| 90/180/270 độ và ảnh nghiêng | Có | Không bảo đảm mọi góc/ảnh khó |
| CJK viết dọc | Có | Đã thử hai cột dựng bằng font |
| Trộn hệ chữ, ảnh nhiều cột | Có | Thứ tự đọc chưa chứng minh tổng quát |
| Text/dòng/từ/quadrilateral/angle | Có | Hình học từ là chiếu CTC, chưa khớp native |
| Style | Có, chưa chứng minh mọi trường hợp | Head, calibration map, category từ ngưỡng config; không giả định tương thích ABI flag |
| Confidence của từ | Có | Model gốc + đặc trưng/lattice tái tạo; crop khác làm điểm khác |
| Confidence/Rejection ONNX | Có | Cả pipeline mặc định và API cấp thấp 21 float |
| Rejection tự động | Có | Trung bình có trọng số ký tự và ngưỡng theo profile; kiểm tra tổng quát còn mở |
| Word segmentation | Có, chưa tương đương tổng quát | Khoảng trắng, Han từng glyph và ICU Thai; 19/21 mẫu khớp danh sách từ |
| Lifecycle/options/lazy load | Có | API JS thay API handle C++; không binary ABI compatible |
| CLI và HTTP | Có | Raw/multipart, bounded queue/body, health, close |
| Linux ARM64/GPU | Chưa kiểm tra | Không suy từ Linux x86-64 CPU |

## Đối chiếu

Các kết quả máy đọc được nằm ở `test/results/`, log trong `work/`.
`npm test` kiểm tra 8 nhóm: container và lỗi dữ liệu, Unicode/alias, CTC/RTL,
protobuf không mất uint64, reading order, tạo 21 đặc trưng, nạp 34 model, và
OCR/HTTP/lifecycle (gồm upload chunked quá giới hạn).

23 ca component được ghi trực tiếp từ DLL gồm một input 21 chiều áp vào 22
model confidence/rejection và một crop ảnh áp vào layout. Hidden activation và
output được so sánh. Sai số tối đa quan sát trên Windows và Linux là
`7.152557373046875e-7`, ngưỡng kiểm tra `2e-5`. Phạm vi này xác nhận phép chuyển
đổi trên các input đã ghi; không chứng minh mọi input.

14 từ Latin/Arabic được đối chiếu tiếp từ thống kê ký tự và các giả thuyết đã
ghi, qua bộ tạo 21 đặc trưng và model confidence, tới `GetOcrWordConfidence`.
Sai số tối đa quan sát `5.960464477539063e-8`.

Đường logits -> lattice -> 20-best -> đặc trưng được kiểm tra trên 8 hệ chữ,
1.677 frame và 56 trường hợp từ. Word label/span native được dùng để ghép và
đối chiếu trường hợp; line text được tái tạo độc lập từ logits cũng khớp trên
16 dòng đó. Sai số score lattice tối đa khoảng `1.2e-7`; sai số feature lớn
nhất thuộc Tamil khoảng `1.64e-5` (ngưỡng `2e-5`). Phần đối chiếu này tách biệt
với detector, crop, page ordering và box. Native trace Devanagari có nhiều đầu
vào recognizer ngắn và các vùng cùng chiều dài; luồng ghép/đối chiếu đầy đủ
chưa được xác minh. Không coi nó là một ca component đã qua.

Bộ phát triển ban đầu gồm 16 ảnh từ font (10 trường hợp ngôn ngữ, xoay,
nghiêng, grayscale, blank); bản đầu khớp toàn bộ text 14/16. Sau đó mở rộng
thêm CJK dọc, nhiều cột, trộn hệ chữ, font giả nét tay và CJK ngang bị xoay
thành 21 ảnh. Cấu hình hiện tại khớp text và word sequence 19/21; còn khác
Arabic và Devanagari. Tài liệu
`test/results/comparison-linux.json` lưu nguyên văn cả hai phía, không coi
kết quả native là ground truth ngôn ngữ hoặc suy ra accuracy trên tài liệu thực.

Font giả nét tay không thay thế kiểm thử chữ viết tay thực. Chưa có tập ảnh
nghiệp vụ của người dùng, so sánh GPU, ARM64 hay benchmark độ chính xác độc lập.
Giá trị confidence, toàn bộ word segmentation và tọa độ không được tính vào
chỉ số text match. Nạp model, component parity và end-to-end parity là các bằng
chứng riêng biệt.

## Công việc còn lại để đạt full parity

* Khôi phục bộ fit/trim/expand polygon, phép rectification và frame trimming.
  Thử cùng box native cho thấy Devanagari có thể khớp khi crop đúng; Arabic và
  Tamil đã có thay đổi sau khi dùng lattice gốc: Tamil khớp, Arabic còn khác.
  Không quy hết sai khác cho một bước duy nhất khi chưa có phép đối chiếu crop.
* Hoàn thiện ghép vùng, word segmentation, punctuation, ICU và composite span;
  đối chiếu luồng nhiều vùng/đầu vào ngắn đã thấy ở Devanagari.
* So sánh style flag/score với đúng ABI `int32*` và `float*`; không diễn giải
  float bit pattern thành script ID. Baseline lưu raw flag/score.
* Mở rộng kiểm tra bằng ảnh scan/ảnh chụp/chữ viết tay thực, mixed orientation,
  nhiều độ phân giải và tài liệu nhiều cột; không hard-code đáp án của corpus.

Không có commit/push hoặc thay đổi repo tham khảo. Mã port, model đã chuẩn bị
và công cụ nghiên cứu nằm riêng trong `D:\Git\SPT\new-port`.

## Bổ sung kiểm thử tiếng Việt và bảng biểu — 2026-10-29

Đã thêm 8 ảnh có đáp án viết trước, generator và baseline riêng từ DLL gốc.
Runner `npm run test:vi` kiểm tra toàn văn, dấu tiếng Việt, CER/WER, từng ô,
giá trị số, thứ tự đọc và tính hợp lệ bounding box từ. Polygon đáp án chỉ dùng
để chấm, không đưa vào OCR. Xem [hướng dẫn suite](../test/vietnamese-tables/README.md)
và [kết quả Linux](evidence/vietnamese-tables-linux.json).

Suite phát hiện lỗi góc trang bị crop chữ số gần vuông làm lệch, dẫn tới thứ
tự ô sai. Đã sửa cách chọn dòng đóng góp vào góc trang và thêm assertion hồi
quy bảng kẻ ô. Chạy trên image Docker Linux x64 mới, user `node`: 11/11 nhóm
runtime/cách chấm đạt; 4/5 ảnh bắt buộc và 3/3 ảnh thử giới hạn đạt. Sáu ảnh
bảng đúng toàn bộ nội dung ô, thứ tự đọc và 78/78 giá trị số. Hóa đơn đúng
toàn văn. Corpus cũ vẫn khớp nội dung và danh sách từ 19/21 ảnh.

Ảnh dãy nguyên âm/dấu đứng riêng còn sai 5/6 dòng ở cả hai engine, lỗi cụ thể
khác nhau. Runner giữ tiêu chí nghiêm ngặt, ghi báo cáo và trả exit code 1.
Các ảnh tổng hợp này chưa kiểm chứng chất lượng scan thực tế hoặc khả năng
tự khôi phục cấu trúc bảng/ô gộp. Receipt bổ sung này phản ánh source sau bản
`final-verification.json` trước đó; không diễn giải snapshot cũ là test mới.

## API service và Docker image có model — v0.2.0

Service có route chuẩn `/v1/ocr`, Bearer auth, request ID, OpenAPI, health/live,
health/ready, giới hạn body/pixel/pending, deadline và graceful shutdown. Các
route OCR cũ được giữ. Thiết kế/vận hành tại [SERVICE.md](SERVICE.md).

Theo yêu cầu đóng gói của chủ project, repo/image hiện có model gốc
`models/oneocr.onemodel` (58.453.799 byte), thay cho yêu cầu mount model trước
đó. Không đổi model hoặc SHA-256. Docker Compose chạy read-only, user `node`,
không mount model; API key nằm trong `.env` không commit. Công cụ
`verify-image.ps1` đã nạp 34 model và nhận dạng tiếng Việt trong container
không có mount hoặc DLL Windows. `verify-service.mjs` kiểm tra deployment
Compose qua HTTP, gồm PNG/JPEG/WebP và bảng 23 ô/13 giá trị số.

19/19 nhóm test runtime/HTTP đạt trên Linux amd64. Receipt mới tại
`evidence/docker-verification.json` và `evidence/service-verification.json`.
Các receipt/lịch sử nghiên cứu trước đó phản ánh source ở thời điểm ghi;
không dùng chúng để thay cho kiểm chứng API mới. Chất lượng OCR/giới hạn parity
vẫn theo các mục phía trên và suite tiếng Việt 7/8 ảnh.
