# Tiền xử lý ảnh và bố cục ngữ nghĩa

API giữ nguyên đường chạy OneOCR hiện tại khi không yêu cầu layout hoặc tiền xử lý. Các tùy chọn dưới đây đều bật tường minh trên từng request; kết quả OCR bình thường không bị đổi mặc định.

```bash
curl --fail-with-body -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F file=@page.png \
  'http://127.0.0.1:8001/v1/ocr?language=vi&layout=deepdoc&max_dimension=1600&rotation=90&deskew=true&padding=16'
```

## Tùy chọn HTTP

| Tham số | Mặc định | Phạm vi | Tác dụng |
| --- | --- | --- | --- |
| `layout` | Không bật | `deepdoc` | Phát hiện vùng bố cục của trang trước khi chạy OneOCR trên các vùng phù hợp. |
| `layout_threshold` | `0.2` | `0..1` | Ngưỡng điểm layout. Chỉ áp dụng khi có `layout=deepdoc`. |
| `max_regions` | `32` | `1..64` | Số vùng tối đa trả về và xử lý. |
| `max_dimension` | Không resize | `32..4096` | Giới hạn cạnh dài; chỉ thu nhỏ và giữ tỉ lệ. |
| `rotation` | `0` | `-180..180` độ | Xoay theo góc chỉ định; canvas mở rộng và phần trống được tô trắng. |
| `deskew` | `false` | `true` hoặc `false` | Ước lượng và hiệu chỉnh nghiêng nhỏ nếu có tín hiệu đủ rõ. |
| `padding` | `0` | `0..128` pixel | Thêm phần trắng bằng số pixel chỉ định vào mỗi cạnh. |

Tham số truy vấn phải xuất hiện tối đa một lần. Giá trị lạ, lặp hoặc ngoài giới hạn trả HTTP 422. Các giới hạn ảnh hiện có vẫn áp dụng: ảnh giải mã tối đa 40 triệu pixel, mỗi cạnh tối đa 10.000 pixel; phép xoay có thể làm canvas lớn hơn.

Nếu không truyền `max_dimension`, `rotation`, `deskew` hoặc `padding`, API không thay đổi hình học ảnh. Nếu bật một trong chúng, thứ tự xử lý là resize → rotation → deskew → padding; cùng một ảnh đã xử lý được đưa vào layout và OCR, rồi tọa độ kết quả được đổi ngược về ảnh đã giải mã sau khi áp dụng EXIF.

## Ánh xạ tọa độ

Ảnh được giải mã và áp dụng EXIF orientation trước. `decoded_image_pixels_after_exif` là hệ tọa độ nguồn của `width`, `height`, các dòng OCR và vùng layout. `processed_image_pixels` là hệ tọa độ sau resize, rotation, deskew và padding.

Khi tiền xử lý được bật, phản hồi có `coordinate_space` và `preprocessing`. Metadata ghi kích thước nguồn/đã xử lý, danh sách phép biến đổi, cùng ma trận affine 3×3 `source_to_processed` và `processed_to_source`. Các đỉnh hộp dòng/từ và layout được ánh xạ trở lại hệ tọa độ nguồn. Với layout đã xoay, `bounding_rect` giữ bốn đỉnh; `bbox` là hình chữ nhật bao quanh các đỉnh đó. Không gửi tọa độ layout đã xử lý về client như tọa độ ảnh gốc.

Nếu không bật layout và cũng không tiền xử lý, API giữ nguyên response tương thích hiện tại, trong đó không có các trường tùy chọn `layout`, `coordinate_space` và `preprocessing`.

## OneOCR đã cung cấp gì

OneOCR đã trả `lines[].layout` để mô tả hướng glyph của từng dòng (`horizontal-glyphs` hoặc `vertical-glyphs`), cùng quadrilateral của dòng/từ và thứ tự đọc hình học. Đây là định hướng dòng OCR, không phải phân loại thành phần trang: nó không gắn nhãn vùng là title, body, figure hay table. `layout=deepdoc` bổ sung các vùng ngữ nghĩa đó trước khi OneOCR đọc crop tương ứng; hướng glyph và hình học dòng vẫn do OneOCR quyết định.

## Cách hoạt động của layout

`layout=deepdoc` dùng một model DeepDoc ONNX cục bộ. Container mặc định có model tại `/app/models/deepdoc-layout.onnx`; đường dẫn có thể đổi bằng `ONEOCR_LAYOUT_MODEL_PATH`. Model được kiểm tra kích thước và SHA-256 khi tạo engine; ONNX session CPU chỉ được khởi tạo ở lần nhận diện layout đầu tiên. Không cần Python, PyTorch, package Ultralytics hoặc dịch vụ OCR ngoài. Khi dùng `OcrEngine` trực tiếp, truyền `layoutModelPath` lúc tạo engine, ví dụ `OcrEngine.create({modelPath: 'models', layoutModelPath: 'models/deepdoc-layout.onnx'})`; nếu không cấu hình provider, request chọn layout sẽ bị từ chối.

Model có input `images [1,3,640,640]` và output thô `output0 [1,15,8400]`. Decoder resize RGB trực tiếp về 640×640, chuẩn hóa về 0..1 và chuyển sang CHW; phép resize này kéo giãn ảnh để vừa input, không letterbox. Mỗi proposal có `cx, cy, width, height` theo pixel input và 11 điểm lớp. Điểm lớp trong ONNX đã qua sigmoid; decoder lấy max/argmax, lọc theo ngưỡng, đổi hộp từ `xywh` sang `xyxy`, scale riêng trục X/Y về kích thước ảnh và chạy NMS theo lớp với IoU 0.2.

Thứ tự lớp tương thích với bảng nhãn nền của DeepDoc:

| ID | Nhãn model | Nhãn trả về |
| --- | --- | --- |
| 0 | `_background_` | Bị loại khỏi vùng semantic trong API |
| 1 | `Text` | `text` |
| 2 | `Title` | `title` |
| 3 | `Figure` | `figure` |
| 4 | `Figure caption` | `figure caption` |
| 5 | `Table` | `table` |
| 6 | `Table caption` | `table caption` |
| 7 | `Header` | `header` |
| 8 | `Footer` | `footer` |
| 9 | `Reference` | `reference` |
| 10 | `Equation` | `equation` |

Model được khóa tại [InfiniFlow/deepdoc revision b470498](https://huggingface.co/InfiniFlow/deepdoc/tree/b47049894cf047c980987af8c8c90fc438217097), file `layout.onnx`, 12.246.147 byte, SHA-256 `fd77f4f78cd8030aee14b0fc38446ee1585de55ad207c0005f69d170961364cb`, license Apache-2.0. Bảng nhãn và cách giải mã dựa trên [RAGFlow v0.10.0 `layout_recognizer.py`](https://github.com/infiniflow/ragflow/blob/v0.10.0/deepdoc/vision/layout_recognizer.py) và [Recognizer](https://github.com/infiniflow/ragflow/blob/v0.10.0/deepdoc/vision/recognizer.py). Snapshot Hugging Face không công bố manifest ghép model với revision mã nguồn này; tính tương thích được suy ra từ graph và hợp đồng tensor, không phải một cam kết của upstream. Decoder hiện tại bỏ class 0 như chính sách semantic của API; decoder legacy upstream có thể phát nhãn `_background_`.

Đây là gói nhẹ chỉ cho DLA/layout: một model ONNX khoảng 12.2 MB cùng preprocessing/decoder và ONNX Runtime Node đang có. [OSS DeepDoc server](https://github.com/infiniflow/ragflow/blob/main/deepdoc/server/README.md) là service rộng hơn gồm DLA, OCR và TSR với các model `layout.onnx`, `det.onnx`, `rec.onnx`, `tsr.onnx` và `ocr.res`. API này dùng OneOCR cho crop text nên không đóng gói OCR/TSR stack đó; source reference của [Recognizer](https://github.com/infiniflow/ragflow/blob/v0.10.0/deepdoc/vision/recognizer.py) gọi ONNX Runtime trực tiếp, không cần Ultralytics/PyTorch runtime.

Để giới hạn tài nguyên, decoder giữ tối đa 1.024 proposal có điểm cao nhất trước NMS, tối đa 300 hộp/lớp trong NMS và áp dụng tiếp `max_regions`; chọn region theo score trước rồi mới xếp thứ tự hình học. Mỗi crop giới hạn 4.000.000 pixel, tổng crop 16.000.000 pixel và tối đa 256 lần thử nhận dạng cho cả request. `max_lines` (tối đa 1.000) giới hạn số dòng trả về và phân bổ ngân sách dòng theo thứ tự; nó không có nghĩa mỗi crop sẽ chạy 1.000 lần nhận dạng. Các lớp text, title, reference, caption, table, header, footer và equation được OCR bằng cùng pipeline OneOCR hiện có trên crop vùng. `figure` chỉ được trả về như vùng, không OCR. `ocr_status` phân biệt vùng đã nhận dạng, không có chữ, không chứa text, bị giới hạn hình học/pixel/dòng/công việc hoặc bị bỏ qua vì nằm trong table đã OCR thành công.

Layout chỉ phân loại vùng; nó không thay thế OneOCR line direction, không suy ra cấu trúc hàng/cột và không chạy Table Structure Recognition (TSR). Vùng `table` được đưa qua OCR OneOCR như một ảnh crop thông thường; API chưa trả cell/row/column hay cấu trúc bảng. Child region nằm trong một table đã OCR thành công được bỏ qua để giảm lặp chữ. Thứ tự vùng và dòng là heuristic hình học; bố cục nhiều cột, đọc RTL, chữ dọc, hoặc trang xoay có thể cần xử lý riêng.

Deskew dùng projection profile trên thumbnail tối đa 512 px, tìm trong khoảng ±10° theo bước 0,25°. Nó trả 0° khi threshold Otsu vượt 245, foreground dưới 80 pixel hoặc trên 55% thumbnail, hay column energy lớn hơn 1,2× row energy (dấu hiệu trang dọc/ngang lẫn). Chỉ áp dụng góc nếu peak score cải thiện hơn 1,5% so với baseline 0°. Đây là heuristic cho skew nhỏ, không phải phát hiện hướng trang tổng quát; OneOCR vẫn xử lý hướng dòng riêng. Kiểm tra `preprocessing.operations` để biết góc thực tế và tọa độ đã ánh xạ.

## Phạm vi chất lượng

Các kết quả đo trong [receipt layout](evidence/preprocessing-layout.md) chỉ phản ánh một fixture tổng hợp và môi trường ghi trong receipt; không phải benchmark tài liệu thực hay cam kết độ chính xác/tốc độ cho hệ thống khác. Bộ chất lượng tiếng Việt hiện vẫn có lỗi dấu tách rời; xem receipt trước khi dùng cho tài liệu cần độ chính xác cao. Layout không sửa lỗi nhận dạng văn bản của OneOCR.
