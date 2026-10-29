"""One-time Windows extraction of caller-provided OneOCR artifacts.

The Linux runtime does not load these DLLs. This process intercepts the ORT
session constructors in its own address space and records decrypted ONNX bytes.
API-table indices follow onnxruntime_c_api.h; extraction methodology also
documented by bropines/oneocr-onnx-python (MIT, see THIRD_PARTY_NOTICES).
"""
import argparse, ctypes as C, hashlib, json, os, struct
from pathlib import Path
import onnx

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--artifacts',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--trace-images',type=Path,nargs='*',default=[])
    parser.add_argument('--trace-features',action='store_true')
    args=parser.parse_args()
    if os.name!='nt': raise SystemExit('Extraction requires Windows; prepared models run natively on Linux.')
    root=args.artifacts.resolve(); out=args.output.resolve(); out.mkdir(parents=True,exist_ok=True)
    dll_dir=os.add_dll_directory(str(root))
    kernel=C.WinDLL('kernel32',use_last_error=True)
    kernel.VirtualProtect.argtypes=[C.c_void_p,C.c_size_t,C.c_ulong,C.POINTER(C.c_ulong)]
    kernel.VirtualProtect.restype=C.c_int
    ort=C.WinDLL(str(root/'onnxruntime.dll'))
    ort.OrtGetApiBase.restype=C.c_void_p
    base=ort.OrtGetApiBase()
    get_api=C.WINFUNCTYPE(C.c_void_p,C.c_uint32)(C.c_void_p.from_address(base).value)
    api=get_api(7)
    if not api: raise RuntimeError('ORT C API v7 is unavailable')
    get_version=C.WINFUNCTYPE(C.c_char_p)(C.c_void_p.from_address(base+8).value)
    records=[]; hooks=[]; restores=[];sessions={}
    def patch(address,value):
        old=C.c_ulong(); previous=C.c_void_p.from_address(address).value
        if not kernel.VirtualProtect(address,8,0x40,C.byref(old)): raise C.WinError(C.get_last_error())
        C.c_void_p.from_address(address).value=value
        kernel.VirtualProtect(address,8,old.value,C.byref(C.c_ulong()))
        return previous
    def capture(data,size):
        blob=C.string_at(data,size); digest=hashlib.sha256(blob).hexdigest()
        for x in records:
            if x['sha256']==digest:return x
        model=onnx.load_model_from_string(blob)
        outputs=[x.name for x in model.graph.output]
        if 'script_id_score' in outputs: name='classifier'
        elif any('fpn' in x for x in outputs): name='detector'
        elif 'logsoftmax' in outputs:
            value=next(x for x in model.graph.output if x.name=='logsoftmax')
            size_v=value.type.tensor_type.shape.dim[-1].dim_value
            # Vocab dimensions alone do not identify scripts. The caller's
            # resource index (prepared bundle) supplies the authoritative name.
            name='recognizer_v'+str(size_v)
        else: name='auxiliary_'+str(len(records))
        path=out/(name+'.onnx'); path.write_bytes(blob)
        def shape(v): return [d.dim_value if d.HasField('dim_value') else d.dim_param for d in v.type.tensor_type.shape.dim]
        rec={'name':name,'file':path.name,'bytes':len(blob),'sha256':digest,'inputs':{v.name:shape(v) for v in model.graph.input},'outputs':{v.name:shape(v) for v in model.graph.output},'opsets':{x.domain:x.version for x in model.opset_import}}
        records.append(rec); print(json.dumps(rec),flush=True);return rec
    constructor=C.WINFUNCTYPE(C.c_void_p,C.c_void_p,C.c_void_p,C.c_size_t,C.c_void_p,C.c_void_p)
    prepacked=C.WINFUNCTYPE(C.c_void_p,C.c_void_p,C.c_void_p,C.c_size_t,C.c_void_p,C.c_void_p,C.c_void_p)
    for index,typ in [(8,constructor),(151,prepacked)]:
        addr=api+index*8; original=typ(C.c_void_p.from_address(addr).value)
        def make_hook(orig):
            def hook(*a):
                record=capture(a[1],a[2])
                if args.trace_features and (record['inputs'].get('data')==[1,21,1,1] or record['name']=='auxiliary_2'):
                    model=onnx.load_model_from_string(C.string_at(a[1],a[2]))
                    feature=next(n for n in model.graph.node if n.op_type=='OneOCRFeatureExtract')
                    output_shape=[1,16,4,None] if record['name']=='auxiliary_2' else [1,50]
                    input_shape=[1,256,4,None] if record['name']=='auxiliary_2' else [1,21]
                    model.graph.output.extend([onnx.helper.make_tensor_value_info(feature.output[0],onnx.TensorProto.FLOAT,output_shape),onnx.helper.make_tensor_value_info(feature.input[0],onnx.TensorProto.FLOAT,input_shape)])
                    buffer=C.create_string_buffer(model.SerializeToString());hooks.append(buffer)
                    arguments=list(a);arguments[1]=C.addressof(buffer);arguments[2]=len(buffer.raw)-1
                    status=orig(*arguments)
                else:status=orig(*a)
                if not status:sessions[C.c_void_p.from_address(a[-1]).value]=record['name']
                return status
            return hook
        cb=typ(make_hook(original)); hooks.append(cb); restores.append((addr,patch(addr,C.cast(cb,C.c_void_p).value)))
    dll=C.WinDLL(str(root/'oneocr.dll'))
    # Capture decrypted container buffers, if available, for byte-exact vocabulary recovery.
    import pefile
    pe=pefile.PE(str(root/'oneocr.dll'))
    decrypt=C.WINFUNCTYPE(C.c_long,C.c_void_p,C.c_void_p,C.c_ulong,C.c_void_p,C.c_void_p,C.c_ulong,C.c_void_p,C.c_ulong,C.POINTER(C.c_ulong),C.c_ulong)
    decrypted=[]; crypto_events=[]
    def install_crypto_trace(name, function_type, describe):
        for descriptor in pe.DIRECTORY_ENTRY_IMPORT:
            for imp in descriptor.imports:
                if imp.name!=name.encode(): continue
                address=dll._handle+imp.address-pe.OPTIONAL_HEADER.ImageBase
                original=function_type(C.c_void_p.from_address(address).value)
                def hook(*a):
                    if len(crypto_events)<16: crypto_events.append({'operation':name,**describe(a)})
                    return original(*a)
                cb=function_type(hook);hooks.append(cb);restores.append((address,patch(address,C.cast(cb,C.c_void_p).value)))
    install_crypto_trace('BCryptSetProperty',C.WINFUNCTYPE(C.c_long,C.c_void_p,C.c_wchar_p,C.c_void_p,C.c_ulong,C.c_ulong),lambda a:{'property':a[1],'value':C.string_at(a[2],a[3]).hex()})
    install_crypto_trace('BCryptHashData',C.WINFUNCTYPE(C.c_long,C.c_void_p,C.c_void_p,C.c_ulong,C.c_ulong),lambda a:{'bytes':a[2],'data':C.string_at(a[1],min(a[2],80)).hex()})
    install_crypto_trace('BCryptGenerateSymmetricKey',C.WINFUNCTYPE(C.c_long,C.c_void_p,C.c_void_p,C.c_void_p,C.c_ulong,C.c_void_p,C.c_ulong,C.c_ulong),lambda a:{'bytes':a[5],'key':C.string_at(a[4],a[5]).hex()})
    for descriptor in pe.DIRECTORY_ENTRY_IMPORT:
        for imp in descriptor.imports:
            if imp.name!=b'BCryptDecrypt': continue
            address=dll._handle+imp.address-pe.OPTIONAL_HEADER.ImageBase
            original=decrypt(C.c_void_p.from_address(address).value)
            def decrypt_hook(*a):
                if len(crypto_events)<16: crypto_events.append({'operation':'BCryptDecrypt','inputBytes':a[2],'inputHead':C.string_at(a[1],32).hex(),'inputTail':C.string_at(a[1]+a[2]-32,32).hex(),'iv':C.string_at(a[4],a[5]).hex() if a[4] else None,'flags':a[9]})
                status=original(*a)
                if status>=0 and a[6] and a[8] and a[8][0]>1024:
                    data=C.string_at(a[6],a[8][0]); digest=hashlib.sha256(data).hexdigest()
                    if digest not in decrypted:
                        decrypted.append(digest); (out/f'decrypted_{len(decrypted)}.bin').write_bytes(data)
                        print(f'Captured decrypted container: {len(data)} bytes',flush=True)
                return status
            cb=decrypt(decrypt_hook); hooks.append(cb); restores.append((address,patch(address,C.cast(cb,C.c_void_p).value)))
    dll.CreateOcrInitOptions.argtypes=[C.POINTER(C.c_int64)]; dll.CreateOcrInitOptions.restype=C.c_int64
    dll.OcrInitOptionsSetUseModelDelayLoad.argtypes=[C.c_int64,C.c_char]; dll.OcrInitOptionsSetUseModelDelayLoad.restype=C.c_int64
    dll.CreateOcrPipeline.argtypes=[C.c_char_p,C.c_char_p,C.c_int64,C.POINTER(C.c_int64)];dll.CreateOcrPipeline.restype=C.c_int64
    opts=C.c_int64(); pipeline=C.c_int64()
    def check(status):
        if status: raise RuntimeError(f'OneOCR returned status {status}')
    try:
        check(dll.CreateOcrInitOptions(C.byref(opts)))
        check(dll.OcrInitOptionsSetUseModelDelayLoad(opts, b'\0'))
        check(dll.CreateOcrPipeline(str(root/'oneocr.onemodel').encode(),b'kj)TGtrK>f]b[Piow.gU+nC@s""""""4',opts,C.byref(pipeline)))
        manifest={'artifacts':{p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.iterdir() if p.is_file()},'ort_version':get_version().decode(),'models':records}
        (out/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
        (out/'crypto-trace.json').write_text(json.dumps(crypto_events,indent=2),encoding='utf-8')
        if len(records)<11: raise RuntimeError(f'Expected at least 11 models; captured {len(records)}')
        if args.trace_images:
            def api_fn(index,types,result=C.c_void_p):return C.WINFUNCTYPE(result,*types)(C.c_void_p.from_address(api+index*8).value)
            get_data=api_fn(51,[C.c_void_p,C.POINTER(C.c_void_p)])
            get_shape=api_fn(65,[C.c_void_p,C.POINTER(C.c_void_p)])
            get_ndim=api_fn(61,[C.c_void_p,C.POINTER(C.c_size_t)])
            get_dims=api_fn(62,[C.c_void_p,C.POINTER(C.c_int64),C.c_size_t])
            release_shape=api_fn(99,[C.c_void_p],None)
            def tensor(value,values=False):
                shape=C.c_void_p();get_shape(value,C.byref(shape));ndim=C.c_size_t();get_ndim(shape,C.byref(ndim));dims=(C.c_int64*ndim.value)();get_dims(shape,dims,ndim.value);release_shape(shape)
                size=1
                for d in dims:size*=d
                result={'shape':list(dims)}
                if values:
                    data=C.c_void_p();get_data(value,C.byref(data));result['values']=list((C.c_float*min(size,50)).from_address(data.value))
                    if len(dims)==4 and dims[1]==3 and dims[2]==60:
                        import numpy as np
                        matrix=np.ctypeslib.as_array((C.c_float*size).from_address(data.value)).reshape(tuple(dims))[0]
                        ys,xs=np.nonzero(np.any(matrix<0.9,axis=0))
                        result['ink_bounds']=[int(xs.min()),int(ys.min()),int(xs.max()),int(ys.max())] if len(xs) else None
                return result
            run_type=C.WINFUNCTYPE(C.c_void_p,C.c_void_p,C.c_void_p,C.POINTER(C.c_char_p),C.POINTER(C.c_void_p),C.c_size_t,C.POINTER(C.c_char_p),C.c_size_t,C.POINTER(C.c_void_p))
            original_run=run_type(C.c_void_p.from_address(api+9*8).value)
            trace=[];current_image='';calibration_cases=[];calibration_done=False;layout_case=None
            kernel.RtlCaptureStackBackTrace.argtypes=[C.c_ulong,C.c_ulong,C.POINTER(C.c_void_p),C.c_void_p];kernel.RtlCaptureStackBackTrace.restype=C.c_ushort
            def run_hook(*a):
                nonlocal calibration_done,layout_case
                status=original_run(*a)
                if not status:
                    role=sessions.get(a[0],'unknown')
                    entry={'image':current_image,'model':role,'inputs':{a[2][i].decode():tensor(a[3][i],i==0) for i in range(a[4])},'outputs':{a[5][i].decode():tensor(a[7][i],role=='classifier' or args.trace_features) for i in range(a[6])}}
                    if role.startswith('auxiliary_') and args.trace_features:
                        stack=(C.c_void_p*48)();depth=kernel.RtlCaptureStackBackTrace(0,48,stack,None)
                        entry['native_stack_rva']=[hex(stack[i]-dll._handle) for i in range(depth) if stack[i] and dll._handle<=stack[i]<dll._handle+pe.OPTIONAL_HEADER.SizeOfImage]
                    if args.trace_features and role.startswith('recognizer_'):
                        value=C.c_void_p();get_data(a[7][0],C.byref(value));shape=entry['outputs'][a[5][0].decode()]['shape'];count=1
                        for dim in shape:count*=dim
                        filename=f'native-logits-{len(trace)}.bin';(out/filename).write_bytes(C.string_at(value.value,count*4));entry['logits_file']=filename
                    if args.trace_features and role=='classifier' and layout_case is None:
                        layout_case={'pending':True}
                        session_id=next(k for k,v in sessions.items() if v=='auxiliary_2')
                        names=(C.c_char_p*2)(b'line_layout_score',b'oneocr_feature');values=(C.c_void_p*2)()
                        status=original_run(session_id,a[1],a[2],a[3],a[4],names,2,values)
                        if not status:
                            data=C.c_void_p();get_data(a[3][0],C.byref(data));shape=entry['inputs']['data']['shape'];count=1
                            for d in shape:count*=d
                            filename=f'native-layout-{shape[-1]}.bin';(out/filename).write_bytes(C.string_at(data.value,count*4))
                            layout_case={'model':'auxiliary_2','inputFile':filename,'inputShape':shape,'outputs':{'line_layout_score':tensor(values[0],True),'oneocr_feature':tensor(values[1],True)}}
                            release_value=api_fn(96,[C.c_void_p],None)
                            for value in values:release_value(value)
                    if args.trace_features and role.startswith('auxiliary_') and entry['inputs'].get('data',{}).get('shape')==[1,21,1,1]:
                        names=(C.c_char_p*2)(b'oneocr_feature',b'29' if int(role.split('_')[1])<23 else b'24')
                        values=(C.c_void_p*2)();result=original_run(a[0],a[1],a[2],a[3],a[4],names,2,values)
                        if not result:
                            entry['custom_feature']=tensor(values[0],True);entry['normalized_features']=tensor(values[1],True)
                            release_value=api_fn(96,[C.c_void_p],None)
                            for v in values:release_value(v)
                        if not calibration_done:
                            calibration_done=True
                            for session_id,name in list(sessions.items()):
                                if not name.startswith('auxiliary_') or int(name.split('_')[1])<12:continue
                                names=(C.c_char_p*2)(b'softmax',b'oneocr_feature');values=(C.c_void_p*2)()
                                status=original_run(session_id,a[1],a[2],a[3],a[4],names,2,values)
                                if not status:
                                    calibration_cases.append({'model':name,'inputs':entry['inputs'],'outputs':{'softmax':tensor(values[0],True),'oneocr_feature':tensor(values[1],True)}})
                                    for value in values:release_value(value)
                    trace.append(entry)
                return status
            cb=run_type(run_hook);hooks.append(cb);restores.append((api+9*8,patch(api+9*8,C.cast(cb,C.c_void_p).value)))
            class Img(C.Structure):_fields_=[('type',C.c_int32),('width',C.c_int32),('height',C.c_int32),('reserved',C.c_int32),('stride',C.c_int64),('data',C.c_void_p)]
            dll.CreateOcrProcessOptions.argtypes=[C.POINTER(C.c_int64)];dll.CreateOcrProcessOptions.restype=C.c_int64
            dll.RunOcrPipeline.argtypes=[C.c_int64,C.POINTER(Img),C.c_int64,C.POINTER(C.c_int64)];dll.RunOcrPipeline.restype=C.c_int64
            dll.ReleaseOcrResult.argtypes=[C.c_int64];dll.ReleaseOcrResult.restype=None
            dll.ReleaseOcrProcessOptions.argtypes=[C.c_int64];dll.ReleaseOcrProcessOptions.restype=None
            process=C.c_int64();check(dll.CreateOcrProcessOptions(C.byref(process)))
            from PIL import Image
            for file in args.trace_images:
                current_image=file.name;image=Image.open(file).convert('RGBA');b,g,r,a=image.split();raw=Image.merge('RGBA',(b,g,r,a)).tobytes();buffer=C.create_string_buffer(raw);img=Img(3,image.width,image.height,0,image.width*4,C.addressof(buffer));result=C.c_int64()
                check(dll.RunOcrPipeline(pipeline,C.byref(img),process,C.byref(result)))
                if result.value:dll.ReleaseOcrResult(result)
            dll.ReleaseOcrProcessOptions(process)
            (out/'native-tensor-trace.json').write_text(json.dumps(trace,indent=2),encoding='utf-8')
            (out/'native-calibration-cases.json').write_text(json.dumps(calibration_cases,indent=2),encoding='utf-8')
            (out/'native-layout-case.json').write_text(json.dumps(layout_case,indent=2),encoding='utf-8')
    finally:
        for name,h in [('ReleaseOcrPipeline',pipeline),('ReleaseOcrInitOptions',opts)]:
            if h.value:
                f=getattr(dll,name);f.argtypes=[C.c_int64];f.restype=None;f(h)
        for a,v in restores: patch(a,v)
    print(f'Extracted {len(records)} ONNX models to {out}')

if __name__=='__main__': main()
