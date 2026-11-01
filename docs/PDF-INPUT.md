# Nhận PDF và OCR theo trang

`POST /v1/ocr` nhận PDF thô (`Content-Type: application/pdf`) hoặc PDF trong
multipart field `file`/`image`. Service raster hóa từng trang được chọn rồi gửi
ảnh trang qua cùng pipeline OneOCR; các tùy chọn layout, tiền xử lý và Needle
được áp dụng độc lập trên từng trang. Service không lấy text layer gốc của PDF
và không tạo một lần trích xuất Needle ở cấp toàn tài liệu. DeepDoc vẫn chỉ gắn
nhãn vùng semantic; kết quả PDF không chứa hàng/cột hay cấu trúc ô bảng.
`extract=ddddocr` chỉ nhận ảnh; kết hợp với PDF sẽ trả 422
`ddddocr_requires_image`.

## Gọi API

Gửi PDF trực tiếp khi không cần Needle:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -H 'Content-Type: application/pdf' \
  --data-binary @document.pdf \
  'http://127.0.0.1:8001/v1/ocr?language=vi&pdf_dpi=180&pdf_pages=1,3-5&layout=deepdoc'
```

Để bật Needle, dùng multipart, gửi schema một lần; cùng schema và instruction
được dùng cho text OCR của mỗi trang:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ONEOCR_API_KEY" \
  -F 'file=@invoice.pdf;type=application/pdf' \
  -F 'schema={"type":"object","properties":{"invoice_number":{"type":"string"},"total":{"type":"string"}},"required":["invoice_number","total"],"additionalProperties":false}' \
  'http://127.0.0.1:8001/v1/ocr?language=en&extract=needle&pdf_pages=1-2'
```

## Trang, độ phân giải và giới hạn

| Tùy chọn | Hợp đồng |
| --- | --- |
| `pdf_dpi` | DPI raster là số nguyên từ 72 đến 300; mặc định 150. |
| `pdf_pages` | Danh sách số trang 1-based và dải tăng dần, ví dụ `1,3-5`. Service xử lý theo thứ tự trang PDF tăng dần. Tối đa 20 trang được chọn; không chấp nhận trang lặp, dải chồng nhau hoặc dải giảm dần. Số trang tối đa 1.000.000; chuỗi lựa chọn tối đa 256 ký tự, không có khoảng trắng. |
| Không có `pdf_pages` | Xử lý toàn bộ PDF khi tài liệu có tối đa 20 trang. Tài liệu dài hơn phải chỉ định trang; service không tự cắt còn 20 trang đầu. |

Request body mặc định tối đa 20 MiB (`ONEOCR_MAX_BODY_BYTES`). Mỗi trang raster
tối đa 12 triệu pixel, mỗi chiều tối đa 10.000 pixel; tổng tất cả trang được
chọn tối đa 80 triệu pixel. PDF có hơn 1.000.000 trang, PDF mã hóa hoặc trang
vượt các giới hạn bị từ chối. Các trang được raster hóa, nhận dạng và giải phóng
tuần tự; nếu một trang lỗi, request trả lỗi thay vì response một phần.

Một renderer child process xử lý một tài liệu tại một thời điểm, với giới hạn
512 MiB cho V8 old-space. Giới hạn đó không đặt trần cứng cho bộ nhớ native của
canvas và renderer không phải sandbox bảo mật. Deadline request hiện có bao
trùm upload, queue, raster, OCR và extraction; nếu deadline tổng hết, HTTP trả
504.

## Response và tọa độ

PDF response có `source` metadata, `pages[]` và `text` ghép từ các trang theo
thứ tự, ngăn cách bởi line feed, form feed, line feed. Mỗi phần tử `pages[]`
chứa số trang gốc, trạng thái `success`, kích thước raster/DPI, metadata về
trang trong PDF, hai phép biến đổi tọa độ và `result` theo schema OCR ảnh hiện
có. `result.extraction` xuất hiện riêng cho mỗi trang khi dùng `extract=needle`.
`result.elapsed_ms` tính preprocessing và OCR trên trang, không tính thời gian
raster PDF; `duration_ms` trong log request bao gồm toàn bộ vòng đời request.

Ví dụ rút gọn:

```json
{
  "source": {
    "type": "pdf",
    "page_count": 5,
    "selected_pages": [1, 3, 4, 5],
    "processed_pages": 4,
    "dpi": 180,
    "total_rendered_pixels": 12345678,
    "coordinate_space": "rendered_page_pixels"
  },
  "pages": [{
    "page_number": 1,
    "status": "success",
    "source_page": {"view": [0, 0, 612, 792], "user_unit": 1, "rotation": 0},
    "rendered": {"width": 1530, "height": 1980, "dpi": 180},
    "coordinate_space": "rendered_page_pixels",
    "pdf_user_space_to_rendered_pixels": [2.5, 0, 0, -2.5, 0, 1980],
    "rendered_pixels_to_pdf_user_space": [0.4, 0, 0, -0.4, 0, 792],
    "result": {"text": "...", "lines": []}
  }],
  "text": "..."
}
```

`pdf_user_space_to_rendered_pixels` and its inverse are six-value affine
matrices `[a,b,c,d,e,f]` using `x' = a*x + c*y + e` and
`y' = b*x + d*y + f`. Returned OCR boxes and DeepDoc layout boxes use
`rendered_page_pixels`; apply `rendered_pixels_to_pdf_user_space` directly to
map them to PDF user space. Preprocessing metadata uses
`coordinate_space: rendered_page_pixels` and
`processed_coordinate_space: processed_image_pixels`; to map a point that is
still in processed-image coordinates, first apply
`preprocessing.processed_to_source`, then the PDF inverse matrix. PDF rotation
and `user_unit` are included in the forward matrix.

## Errors and processing details

Malformed PDFs or unsupported page counts return 400 `invalid_pdf`. Encrypted
PDFs return 422 `pdf_password_required`; PDFs containing XFA forms return 422
`pdf_xfa_unsupported`. Invalid selections, the page-count selection cap,
render-pixel limits, render failures and geometry mismatches return 422 with a
specific `pdf_*` error. A concurrent document render returns
503 `pdf_renderer_busy` and `Retry-After: 1`; when Needle's single extraction
slot is occupied, PDF extraction can instead return 503 `extraction_busy` first.
The usual 413 body limit, 415 media type handling, and 504 overall deadline
still apply. The renderer rejects render warnings rather than returning partial
page results. PDF.js embedded images above its 12-million-pixel decode cap also
cause `pdf_render_failed` instead of being silently omitted.

PDF.js runs locally against the uploaded bytes. Character maps, standard fonts,
and WASM decoder assets are loaded from the pinned `pdfjs-dist` package; worker
fetch is disabled. No PDF is sent to an external renderer. Dependency versions
and licenses are listed in [third-party notices](../THIRD_PARTY_NOTICES.md).
For scope limits and measured integration evidence, see the
[PDF evidence receipt](evidence/pdf-input.md).
