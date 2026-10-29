"""Locate direct x64 RIP-relative LEA references to literal UTF-8 strings."""
import argparse,bisect,re,struct
import pefile
p=argparse.ArgumentParser();p.add_argument('image');p.add_argument('needles',nargs='+');a=p.parse_args()
pe=pefile.PE(a.image);data=pe.__data__;targets={}
for needle in a.needles:
 for match in re.finditer(re.escape(needle.encode()),data):
  start=data.rfind(b'\0',max(0,match.start()-1024),match.start())+1
  targets[pe.get_rva_from_offset(start)]=needle
functions=sorted((f.struct.BeginAddress,f.struct.EndAddress) for f in pe.DIRECTORY_ENTRY_EXCEPTION)
starts=[f[0] for f in functions]
for section in pe.sections:
 if not section.Characteristics&0x20000000:continue
 code=section.get_data()
 for match in re.finditer(rb'[\x48-\x4f]\x8d[\x05\x0d\x15\x1d\x25\x2d\x35\x3d]....',code,re.S):
  rva=section.VirtualAddress+match.start();target=rva+7+struct.unpack('<i',match.group()[-4:])[0]
  if target not in targets:continue
  index=bisect.bisect_right(starts,rva)-1
  function=functions[index] if index>=0 and functions[index][1]>rva else None
  print(f'{targets[target]} xref={rva:x} function={function}')
