"""Project deterministic, portable test inputs from native instrumentation."""
import json,argparse
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('traces',nargs='+',type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
cases=[];digest=None
for file in a.traces:
 trace=json.loads(file.read_text('utf8'));digest=trace['oneocr_sha256']
 for message in trace['messages']:
  v=message.get('payload',{})
  if v.get('kind')!='feature-characters' or v.get('features') is None:continue
  characters=[{'character':c['character'],'rawCharacter':c['rawCharacter'],'firstFrame':c['integers'][2],'lastFrame':c['integers'][3],'posterior':c['floats'][0],'blank':c['floats'][1],'space':c['floats'][2],'competitor':c['floats'][3]}for c in v['chars']]
  cases.append({'sourceImage':Path(trace['image']).name,'text':v['word'],'characters':characters,'alternatives':v['alternatives'],'expected':v['features']})
a.output.write_text(json.dumps({'source':'native feature generator at RVA 0xcc410; observed intermediate character statistics and lattice alternatives','oneocr_sha256':digest,'cases':cases},ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'cases':len(cases),'output':str(a.output)}))
