# Kiểm thử tiếng Việt và bảng biểu

Chạy tại thư mục gốc project sau khi đã chuẩn bị `models/` và dependencies:

```bash
npm test
npm run test:vi
```

`npm test` kiểm tra runtime và cách tính điểm. `npm run test:vi` chạy OCR thật
trên 8 PNG, chấm theo `manifest.json`, rồi so sánh thêm engine Windows gốc trong
`native-oracle.json`. Chạy suite trên Linux không cần DLL, Python hoặc font.

Kết quả nằm ở `test/results/vietnamese-tables/<platform>-<arch>/report.html`
và `report.json`. HTML tự chứa ảnh, polygon đáp án (cam), bounding box từ OCR
(xanh), bảng đối chiếu từng ô và lỗi. Mỗi ảnh còn có JSON đầy đủ. SHA-256 ràng
buộc ảnh, manifest, model và source runtime với kết quả. Baseline cũ hoặc ảnh
bị sửa sẽ làm runner dừng ngay.

Đặt `ONEOCR_TEST_OUTPUT=/path/to/writable/directory` để đổi nơi ghi báo cáo
(hữu ích khi container dùng user không có quyền ghi vào source mount).

## Các ảnh thử

| Ảnh | Nội dung | Nhóm |
| --- | --- | --- |
| `vi-diacritics.png` | Câu tiếng Việt và các tổ hợp nguyên âm/dấu đứng riêng | Bắt buộc |
| `vi-invoice.png` | Hóa đơn, địa chỉ, ngày tháng, mã số thuế, số tiền | Bắt buộc |
| `vi-table-grid.png` | Bảng kẻ ô, 4 cột, 4 hàng hàng hóa và tổng tiền | Bắt buộc |
| `vi-table-borderless.png` | Cùng dữ liệu, không có đường kẻ | Bắt buộc |
| `vi-table-merged.png` | Tiêu đề cột và dòng tổng có ô gộp | Bắt buộc |
| `vi-table-small.png` | Chữ 23 px thay cho 34 px | Thử giới hạn |
| `vi-table-skew3.png` | Bảng nghiêng 3 độ; polygon đáp án xoay cùng ảnh | Thử giới hạn |
| `vi-table-faded.png` | Tương phản 0,32 và Gaussian blur 1,1 | Thử giới hạn |

Ảnh và nhãn dựng từ nội dung viết trước bằng Pillow/Arial; đáp án không lấy
từ OCR. Không phân phối font. Đây là ảnh chữ in tổng hợp, chưa đại diện cho
scan/chụp điện thoại, giấy nhàu, chữ viết tay hay mọi font tiếng Việt.

## Tiêu chí

- Chuẩn hóa Unicode NFC và khoảng trắng; giữ dấu tiếng Việt, chữ hoa và dấu
  chấm/phẩy trong số. Chấm toàn văn, CER/WER, nội dung và giá trị số từng ô.
- Gán từ vào ô theo tâm bounding box trong polygon đáp án. Từ thừa, thiếu,
  lặp, sai ô hoặc nằm trên biên chung nhiều ô đều bị tính lỗi.
- Giữ thứ tự dòng/từ thật của engine, không sắp xếp lại theo đáp án.
- Bounding box từ phải hữu hạn, diện tích dương, nằm trong ảnh với dung sai
  biên 2 px. Chưa đo IoU độ chính xác hình học.
- Ca bắt buộc phải đúng toàn bộ điều kiện. Một ca sai trả exit code **1**,
  nhưng mọi kết quả vẫn được ghi. Ca thử giới hạn chấm cùng tiêu chí, báo riêng
  và không ảnh hưởng exit code.

Polygon ô chuẩn **không truyền vào OCR**. Runtime vẫn trả dòng và từ; suite
không chứng minh khả năng tự suy ra hàng/cột, ô gộp hoặc xuất bảng Excel/HTML.

## Kết quả Linux x64, Node.js 24.22.1, ngày 2026-10-29

11/11 nhóm test runtime/cách chấm đạt. Suite ảnh đạt 4/5 ca bắt buộc và 3/3
ca thử giới hạn, tổng 7/8 ảnh. Sáu bảng đúng toàn bộ nội dung ô, thứ tự đọc
và 78/78 giá trị số; hóa đơn đúng toàn văn.

`vi-diacritics` sai 5/6 dòng: mất/nhầm dấu, ghép từ và mất dòng. Engine Windows
gốc cũng chỉ đúng 1/6 dòng trên ảnh này, nhưng lỗi cụ thể khác bản port. Suite
giữ nhãn và exit code 1 để theo dõi lỗi còn mở. Chưa thể kết luận tương đương
engine gốc hoặc khái quát độ chính xác này sang tài liệu thực tế.

Đã sửa lỗi thứ tự ô do crop chữ số đứng riêng gần vuông làm lệch góc trang.
Runtime lấy góc từ dòng có trục dài rõ ràng khi có thể. Integration test có
assertion hồi quy bảng kẻ ô. Corpus cũ vẫn giữ mức 19/21 ảnh khớp engine gốc.

## Dựng lại fixture và baseline

```powershell
python tools/generate-vietnamese-tables.py --font-dir C:/Windows/Fonts
python tools/record-vietnamese-oracle.py --reference PATH_TO_ORGGEM_ONEOCR `
  --artifacts PATH_TO_ORIGINAL_ONEOCR_FILES
```

Pillow là dependency của công cụ sinh ảnh. Có thể dựng trên Linux với
`--font-dir` chứa `arial.ttf`, `arialbd.ttf` tương ứng. Chỉ bước ghi baseline
cần Windows/DLL gốc. Đổi manifest/ảnh phải ghi lại baseline; không chỉnh đáp án
theo output để che lỗi.
