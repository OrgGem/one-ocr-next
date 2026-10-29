"""Record supplied Windows OneOCR outputs without changing fixtures or labels."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--reference', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    p.add_argument('--corpus', type=Path, default=ROOT / 'test/vietnamese-tables')
    args = p.parse_args()
    manifest_path = args.corpus / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    sys.path.insert(0, str(args.reference.resolve()))
    import oneocr
    oneocr.CONFIG_DIR = str(args.artifacts.resolve())
    engine = oneocr.OcrEngine()
    samples = {}
    for sample in manifest['samples']:
        image_path = args.corpus / sample['file']
        assert hashlib.sha256(image_path.read_bytes()).hexdigest() == sample['imageSha256']
        with Image.open(image_path) as image:
            result = engine.recognize_pil(image)
        result['width'], result['height'] = sample['width'], sample['height']
        samples[sample['id']] = result
        print(sample['id'], 'lines:', len(result['lines']), flush=True)
    result = dict(source='caller-supplied Windows OneOCR; comparator, not ground truth',
                  manifestSha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                  modelSha256=hashlib.sha256((args.artifacts / 'oneocr.onemodel').read_bytes()).hexdigest(),
                  dllSha256=hashlib.sha256((args.artifacts / 'oneocr.dll').read_bytes()).hexdigest(), samples=samples)
    (args.corpus / 'native-oracle.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
