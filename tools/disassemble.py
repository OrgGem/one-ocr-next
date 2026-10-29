"""Read-only, bounded PE function disassembly using exception-table boundaries."""
import argparse
import pefile
import struct
from capstone import Cs, CS_ARCH_X86, CS_MODE_64

p=argparse.ArgumentParser()
p.add_argument('image')
p.add_argument('rvas',nargs='+',type=lambda v:int(v,16))
a=p.parse_args()
pe=pefile.PE(a.image)
base=pe.OPTIONAL_HEADER.ImageBase
decoder=Cs(CS_ARCH_X86,CS_MODE_64)
entries=[f.struct for f in pe.DIRECTORY_ENTRY_EXCEPTION]
def parent(entry):
    raw=pe.get_data(entry.UnwindData,4)
    if len(raw)!=4:return None
    flags=raw[0]>>3
    if flags&4:
        chain=pe.get_data(entry.UnwindData+4+((raw[2]+1)//2)*4,12)
        return struct.unpack('<III',chain)[0]
    return None
by_start={f.BeginAddress:f for f in entries}
def owner(entry):
    seen=set()
    while (up:=parent(entry)) is not None and up in by_start and up not in seen:
        seen.add(up);entry=by_start[up]
    return entry.BeginAddress
for rva in a.rvas:
    matches=[f for f in entries if f.BeginAddress<=rva<f.EndAddress]
    if len(matches)!=1:
        print(f'UNKNOWN FUNCTION {rva:x}');continue
    root=owner(matches[0]);fragments=[f for f in entries if owner(f)==root]
    print(f'FUNCTION {root:x}, unwind-linked fragments={len(fragments)}')
    for f in fragments:
      print(f'RANGE {f.BeginAddress:x}..{f.EndAddress:x}')
      for ins in decoder.disasm(pe.get_data(f.BeginAddress,f.EndAddress-f.BeginAddress),base+f.BeginAddress):
        print(f'{ins.address-base:x} {ins.mnemonic} {ins.op_str}')
