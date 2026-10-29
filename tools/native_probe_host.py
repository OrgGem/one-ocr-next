"""Owned interactive Windows oracle process for debugger/instrumentation work."""
import argparse,ctypes as C,json,os,sys
from pathlib import Path
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('--artifacts',required=True);p.add_argument('--reference',required=True);p.add_argument('--image',required=True);a=p.parse_args()
sys.path.insert(0,a.reference)
import oneocr
oneocr.CONFIG_DIR=a.artifacts
engine=oneocr.OcrEngine()
print(json.dumps({'ready':True,'pid':os.getpid()}),flush=True)
try:
 for command in sys.stdin:
  if command.strip()=='run':print(json.dumps(engine.recognize_pil(Image.open(a.image)),ensure_ascii=True),flush=True)
  elif command.strip()=='exit':break
finally:
 for name,handle in [('ReleaseOcrProcessOptions',engine.process_options),('ReleaseOcrPipeline',engine.pipeline),('ReleaseOcrInitOptions',engine.init_options)]:
  function=getattr(engine.ocr_dll,name);function.argtypes=[C.c_int64];function.restype=None;function(handle)
 engine.ocr_dll=None
