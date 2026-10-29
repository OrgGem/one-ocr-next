"""Render reproducible OCR fixtures; labels come from authored text, never OCR.

Requires Pillow. Use --font-dir to regenerate on Linux with supplied Arial TTFs.
The checked-in PNGs make running the Node test suite independent of fonts/Python.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, __version__

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--font-dir', type=Path, default=Path('C:/Windows/Fonts'))
    parser.add_argument('--output', type=Path, default=ROOT / 'test/vietnamese-tables')
    args = parser.parse_args()
    fixtures = args.output / 'fixtures'
    fixtures.mkdir(parents=True, exist_ok=True)
    fonts = {name: args.font_dir / name for name in ('arial.ttf', 'arialbd.ttf')}
    samples = []

    def font(size, bold=False):
        return ImageFont.truetype(str(fonts['arialbd.ttf' if bold else 'arial.ttf']), size)

    def polygon(rect):
        x1, y1, x2, y2 = rect
        return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]

    def save(identifier, image, cells, description, tier='required', transformation=None):
        filename = identifier + '.png'
        image.save(fixtures / filename)
        sample = dict(id=identifier, file='fixtures/' + filename, description=description,
                      tier=tier, width=image.width, height=image.height, cells=cells,
                      expectedText='\n'.join(cell['text'] for cell in cells),
                      imageSha256=hashlib.sha256((fixtures / filename).read_bytes()).hexdigest())
        if transformation:
            sample['transformation'] = transformation
        samples.append(sample)
        return sample

    def prose(identifier, lines, description):
        image = Image.new('RGB', (1500, 180 + 100 * len(lines)), 'white')
        draw = ImageDraw.Draw(image)
        cells = []
        for i, text in enumerate(lines):
            y = 65 + i * 100
            f = font(44)
            draw.text((65, y), text, font=f, fill='#151515')
            assert draw.textlength(text, font=f) < image.width - 130, text
            cells.append(dict(id=f'line-{i+1}', row=i, column=0, text=text,
                              polygon=polygon([35, y-10, image.width-35, y+85])))
        save(identifier, image, cells, description)

    prose('vi-diacritics', [
        'Tiếng Việt có dấu: Trường Đại học Bách khoa',
        'ă â ê ô ơ ư đ - Ă Â Ê Ô Ơ Ư Đ',
        'á à ả ã ạ - ắ ằ ẳ ẵ ặ - ấ ầ ẩ ẫ ậ',
        'é è ẻ ẽ ẹ - ế ề ể ễ ệ - í ì ỉ ĩ ị',
        'ó ò ỏ õ ọ - ố ồ ổ ỗ ộ - ớ ờ ở ỡ ợ',
        'ú ù ủ ũ ụ - ứ ừ ử ữ ự - ý ỳ ỷ ỹ ỵ',
    ], 'NFC Vietnamese letters, upper/lowercase and all vowel tone combinations')
    prose('vi-invoice', [
        'HÓA ĐƠN GIÁ TRỊ GIA TĂNG',
        'Công ty Cổ phần Thương mại Việt Nam',
        'Địa chỉ: 123 Nguyễn Trãi, Hà Nội',
        'Ngày lập: 29/10/2026',
        'Mã số thuế: 0101234567',
        'Tổng thanh toán: 1.234.567 VND',
    ], 'Invoice fields with Vietnamese accents, date, tax identifier and amount')

    def table(identifier, *, borders=True, merged=False, size=34, tier='required'):
        widths = [470, 215, 265, 280]
        xs = [65]
        for width in widths:
            xs.append(xs[-1] + width)
        height = 850 if merged else 760
        image = Image.new('RGB', (1360, height), 'white')
        draw = ImageDraw.Draw(image)
        cells = []
        draw.text((65, 32), 'HÓA ĐƠN BÁN HÀNG', font=font(42, True), fill='#111111')
        cells.append(dict(id='title', row=-2, column=0, text='HÓA ĐƠN BÁN HÀNG',
                          polygon=polygon([40, 20, 1300, 110])))
        row_y = 145

        def cell(row, col, span, text, y, bold=False, numeric=False):
            rect = [xs[col], y, xs[col+span], y+90]
            if borders:
                draw.rectangle(rect, outline='#626262', width=2)
            f = font(size, bold)
            length = draw.textlength(text, font=f)
            assert length < rect[2]-rect[0]-24, text
            x = rect[2]-22-length if numeric else rect[0]+22
            draw.text((x, y+22), text, font=f, fill='#151515')
            cells.append(dict(id=f'r{row}c{col}', row=row, column=col, columnSpan=span,
                              text=text, numeric=numeric, polygon=polygon(rect)))

        if merged:
            cell(-1, 0, 2, 'Thông tin hàng hóa', row_y, True)
            cell(-1, 2, 2, 'Giá trị (VND)', row_y, True)
            row_y += 90
        headers = ['Mặt hàng', 'Số lượng', 'Đơn giá', 'Thành tiền']
        rows = [headers,
                ['Cà phê sữa', '2', '25.000', '50.000'],
                ['Bánh mì thịt', '3', '30.000', '90.000'],
                ['Nước ép cam', '1', '45.000', '45.000'],
                ['Sữa chua', '4', '15.000', '60.000']]
        for row, texts in enumerate(rows):
            for col, text in enumerate(texts):
                cell(row, col, 1, text, row_y+row*90, row == 0, row > 0 and col > 0)
        cell(5, 0, 3, 'Tổng cộng', row_y+450, True)
        cell(5, 3, 1, '245.000', row_y+450, True, True)
        sample = save(identifier, image, cells,
                      f'Vietnamese invoice table; borders={borders}, merged headers={merged}, font={size}px', tier)
        return image, sample

    base, baseline = table('vi-table-grid')
    table('vi-table-borderless', borders=False)
    table('vi-table-merged', merged=True)
    table('vi-table-small', size=23, tier='stress')

    angle = 3
    rotated = base.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor='white')
    cells = copy.deepcopy(baseline['cells'])
    radians = math.radians(angle)
    for cell in cells:
        points = []
        for x, y in cell['polygon']:
            dx, dy = x-base.width/2, y-base.height/2
            points.append([round(math.cos(radians)*dx+math.sin(radians)*dy+rotated.width/2, 4),
                           round(-math.sin(radians)*dx+math.cos(radians)*dy+rotated.height/2, 4)])
        cell['polygon'] = points
    save('vi-table-skew3', rotated, cells, 'Grid table rotated 3 degrees; labels transformed geometrically',
         'stress', dict(rotationDegrees=3, source=baseline['id']))
    faded = ImageEnhance.Contrast(base).enhance(.32).filter(ImageFilter.GaussianBlur(1.1))
    save('vi-table-faded', faded, copy.deepcopy(baseline['cells']),
         'Low contrast grid table with Gaussian blur radius 1.1', 'stress',
         dict(contrast=.32, blurRadius=1.1, source=baseline['id']))

    manifest = dict(schemaVersion=1, language='vi',
                    scope='Synthetic printed text and table cell OCR; no table-structure extraction or real-scan accuracy claim',
                    generator=dict(script='tools/generate-vietnamese-tables.py', pillow=__version__,
                                   fonts={name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in fonts.items()}),
                    policy=dict(required='Full text and every required cell exact after NFC and whitespace normalization; exact reading order; valid word geometry; no unassigned words',
                                stress='Same measurements, diagnostic only; never silently lowers required accuracy thresholds',
                                cellAssignment='Center of each word quadrilateral in the authored cell polygon; preserve detected line/word order'),
                    samples=samples)
    (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f'Generated {len(samples)} fixtures and authored labels in {args.output}')


if __name__ == '__main__':
    main()
