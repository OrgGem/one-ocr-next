"""Keep compact native custom-operator observations for portable regression tests."""
import json,shutil
from pathlib import Path

root=Path(__file__).resolve().parent.parent
models=root/'models'
manifest=json.loads((models/'manifest.json').read_text('utf8'))
by_name={r['name']:r for r in manifest['models']}
observations=json.loads((models/'native-calibration-cases.json').read_text('utf8'))
cases=[]
for observed in observations:
    record=by_name[observed['model']]
    cases.append({'model_sha256':record['sha256'],'input':observed['inputs']['data'],'expected':observed['outputs']})
out={'source':'caller-provided oneocr.dll with original ORT 1.19.0; one synthetic Latin word feature vector, evaluated by all loaded dense private operators','oneocr_sha256':manifest['artifacts']['oneocr.dll']['sha256'],'cases':cases}
layout=json.loads((models/'native-layout-case.json').read_text('utf8'))
if layout:
    shutil.copyfile(models/layout['inputFile'],root/'test/corpus/layout-input.f32')
    cases.append({'model_sha256':by_name[layout['model']]['sha256'],'input':{'shape':layout['inputShape'],'file':'layout-input.f32'},'expected':layout['outputs']})
(root/'test/corpus/calibration-cases.json').write_text(json.dumps(out,indent=2),encoding='utf8')
print(f'Recorded {len(cases)} native operator cases')
