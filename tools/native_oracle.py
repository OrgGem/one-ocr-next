"""Generate a deterministic corpus and record the supplied Windows engine's output."""
import argparse,ctypes as C,hashlib,json,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

SAMPLES={
 'latin':('arial.ttf',['Native OCR 2026','Invoice total 123.45']),
 'vietnamese':('arial.ttf',['Tiếng Việt có dấu','Hóa đơn tổng cộng 123.45']),
 'cyrillic':('arial.ttf',['Привет мир','Проверка текста 2026']),
 'cjk':('msyh.ttc',['中文文字识别','日本語 OCR 2026']),
 'arabic':('arial.ttf',['مرحبا بالعالم','اختبار النص 2026']),
 'devanagari':('Nirmala.ttf',['नमस्ते दुनिया','पाठ पहचान 2026']),
 'greek':('arial.ttf',['Καλημέρα κόσμε','Αναγνώριση 2026']),
 'thai':('LeelawUI.ttf',['สวัสดีชาวโลก','ทดสอบข้อความ 2026']),
 'hebrew':('arial.ttf',['שלום עולם','בדיקת טקסט 2026']),
 'tamil':('Nirmala.ttf',['வணக்கம் உலகம்','உரை சோதனை 2026']),
}

def main():
 p=argparse.ArgumentParser();p.add_argument('--artifacts',type=Path,required=True);p.add_argument('--reference',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 a.output.mkdir(parents=True,exist_ok=True); fixtures=a.output/'fixtures';fixtures.mkdir(exist_ok=True)
 for name,(fontname,lines) in SAMPLES.items():
  image=Image.new('RGB',(1200,360),'white');draw=ImageDraw.Draw(image);font=ImageFont.truetype('C:/Windows/Fonts/'+fontname,52)
  for i,text in enumerate(lines):draw.text((45,35+i*125),text,fill='black',font=font)
  image.save(fixtures/(name+'.png'))
 latin=Image.open(fixtures/'latin.png')
 Image.open(fixtures/'cjk.png').rotate(90,expand=True,fillcolor='white').save(fixtures/'cjk-rot90.png')
 for angle in (90,180,270):latin.rotate(angle,expand=True,fillcolor='white').save(fixtures/f'latin-rot{angle}.png')
 latin.rotate(7,expand=True,fillcolor='white').save(fixtures/'latin-skew7.png')
 latin.convert('L').save(fixtures/'grayscale.png')
 Image.new('RGB',(1200,360),'white').save(fixtures/'blank.png')
 # Additional development cases exercise vertical glyphs, columns and mixed
 # scripts; they are observations against this exact DLL, not accuracy labels.
 vertical=Image.new('RGB',(440,700),'white');draw=ImageDraw.Draw(vertical);font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',52)
 for column,text in enumerate(['中文文字识别','日本語文字']):
  for row,char in enumerate(text):draw.text((300-column*160,35+row*92),char,fill='black',font=font)
 vertical.save(fixtures/'vertical-cjk.png')
 columns=Image.new('RGB',(1400,850),'white');draw=ImageDraw.Draw(columns);font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',40)
 for column in range(2):
  for row in range(5):draw.text((45+column*700,35+row*130),f'Column {column+1} line {row+1}',fill='black',font=font)
 columns.save(fixtures/'columns.png')
 mixed=Image.new('RGB',(1200,600),'white');draw=ImageDraw.Draw(mixed)
 for row,(fontname,text) in enumerate([('arial.ttf','Invoice Tiếng Việt 2026'),('msyh.ttc','中文 OCR 123.45'),('arial.ttf','Проверка текста')]):
  draw.text((45,35+row*160),text,fill='black',font=ImageFont.truetype('C:/Windows/Fonts/'+fontname,52))
 mixed.save(fixtures/'mixed-scripts.png')
 print_font=Path('C:/Windows/Fonts/segoepr.ttf')
 if print_font.exists():
  handwritten=Image.new('RGB',(1200,360),'white');draw=ImageDraw.Draw(handwritten);font=ImageFont.truetype(str(print_font),52)
  for row,text in enumerate(['Native OCR sample','Invoice total 123.45']):draw.text((45,25+row*135),text,fill='black',font=font)
  handwritten.save(fixtures/'handwriting-font.png')
 sys.path.insert(0,str(a.reference.resolve()));import oneocr
 oneocr.CONFIG_DIR=str(a.artifacts.resolve());engine=oneocr.OcrEngine()
 style=engine.ocr_dll.GetOcrLineStyle;style.argtypes=[C.c_int64,C.POINTER(C.c_int32),C.POINTER(C.c_float)];style.restype=C.c_int64
 getresize=engine.ocr_dll.OcrProcessOptionsGetResizeResolution;getresize.argtypes=[C.c_int64,C.POINTER(C.c_int64),C.POINTER(C.c_int64)];getresize.restype=C.c_int64
 w=C.c_int64();h=C.c_int64();getresize(engine.process_options,C.byref(w),C.byref(h))
 results={}
 original=engine._process_line
 def process_line(handle,index):
  line=original(handle,index);lh=C.c_int64();engine.ocr_dll.GetOcrLine(handle,index,C.byref(lh));flag=C.c_int32();score=C.c_float();status=style(lh,C.byref(flag),C.byref(score));line['style']={'flag':flag.value,'score':score.value,'status':status};return line
 engine._process_line=process_line
 for file in sorted(fixtures.glob('*.png')):
  result=engine.recognize_pil(Image.open(file));results[file.name]=result;print(file.name,repr(result['text']),flush=True)
 output={'source':'caller-supplied oneocr.dll','resize_resolution':[w.value,h.value],'model_sha256':hashlib.sha256((a.artifacts/'oneocr.onemodel').read_bytes()).hexdigest(),'samples':results}
 (a.output/'native-oracle.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
 print('Written native-oracle.json',flush=True)

if __name__=='__main__':main()
