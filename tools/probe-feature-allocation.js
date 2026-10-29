// Analysis-only instrumentation of the supplied DLL in an owned test process.
const module=Process.getModuleByName('oneocr.dll');
const ort=Process.getModuleByName('onnxruntime.dll');
const apiBase=new NativeFunction(ort.getExportByName('OrtGetApiBase'),'pointer',[])();
const api=new NativeFunction(apiBase.readPointer(),'pointer',['uint'])(7);
const ortFunction=(index,result,args)=>new NativeFunction(api.add(index*8).readPointer(),result,args);
const tensorShape=ortFunction(65,'pointer',['pointer','pointer']);
const dimensionCount=ortFunction(61,'pointer',['pointer','pointer']);
const dimensions=ortFunction(62,'pointer',['pointer','pointer','uint64']);
const tensorData=ortFunction(51,'pointer',['pointer','pointer']);
const releaseShape=ortFunction(99,'void',['pointer']);
Interceptor.attach(api.add(9*8).readPointer(),{
  onEnter(args){
    this.outputNames=Array.from({length:args[6].toUInt32()},(_,i)=>args[5].add(i*8).readPointer().readUtf8String());
    this.values=args[7];
  },
  onLeave(status){
    const index=this.outputNames.indexOf('logsoftmax');if(index<0||!status.isNull())return;
    const value=this.values.add(index*8).readPointer(),shapePointer=Memory.alloc(8);
    if(!tensorShape(value,shapePointer).isNull())return;
    const shape=shapePointer.readPointer(),countPointer=Memory.alloc(8);dimensionCount(shape,countPointer);
    const count=countPointer.readU64().toNumber(),dimensionPointer=Memory.alloc(count*8);
    dimensions(shape,dimensionPointer,count);
    const dims=Array.from({length:count},(_,i)=>dimensionPointer.add(i*8).readS64().toNumber());releaseShape(shape);
    const size=dims.reduce((a,b)=>a*b,1);if(size<1||size>20000000)return;
    const data=Memory.alloc(8);tensorData(value,data);
    send({kind:'recognizer-logits',shape:dims},data.readPointer().readByteArray(size*4));
  },
});
const allocations=new Map();
let captured=0;
const lattices=new Set();
const relative=p=>p.sub(module.base).toString();
function wordText(word) {
  const length=word.add(0x10).readU64().toNumber(),capacity=word.add(0x18).readU64().toNumber();
  if(length>8192)return '<invalid-length>';
  return (capacity>15?word.readPointer():word).readUtf8String(length);
}
for(const rva of [0x2ada0,0x78ef70])Interceptor.attach(module.base.add(rva),{
  onEnter(args) {
    this.size=args[0].toInt32();
    this.active=this.size>=4&&this.size<=1048576&&captured<20000;
    if(this.active)this.stack=Thread.backtrace(this.context,Backtracer.ACCURATE).filter(p=>p.compare(module.base)>=0&&p.compare(module.base.add(module.size))<0).map(relative);
  },
  onLeave(result) {
    if(this.active&&!result.isNull()){allocations.set(result.toString(),{size:this.size,stack:this.stack});captured++;}
  },
});
function allocationOf(pointer) {
  const exact=allocations.get(pointer.toString());if(exact)return exact;
  for(const [address,entry] of allocations) {
    const start=ptr(address);
    if(pointer.compare(start)>=0&&pointer.compare(start.add(entry.size))<0)return {...entry,interiorOffset:pointer.sub(start).toInt32()};
  }
  return null;
}
function traceWords(line,offset,stage) {
    const start=line.add(offset).readPointer(),end=line.add(offset+8).readPointer();
    const count=end.sub(start).toInt32()/120;
    if(!Number.isInteger(count)||count<0||count>1000){send({error:'Unexpected native word vector',count});return;}
    for(let i=0;i<count;i++) {
      const word=start.add(i*120),data=word.add(0x40).readPointer(),limit=word.add(0x48).readPointer();
      const length=limit.sub(data).toInt32()/4;
      if(length!==21){send({error:'Unexpected native feature vector',length});continue;}
      send({kind:'word-features',stage,word:wordText(word),features:Array.from({length:21},(_,j)=>data.add(j*4).readFloat()),allocation:allocations.get(data.toString())??null});
    }
}
Interceptor.attach(module.base.add(0xc6fa0),{onEnter(args){traceWords(args[1],0xf8,'confidence');}});
Interceptor.attach(module.base.add(0xcb740),{onEnter(args){traceWords(args[1],0xe0,'rejection');}});
Interceptor.attach(module.base.add(0xaf740),{onEnter(args){traceWords(args[0],0xe0,'before-copy');}});
Interceptor.attach(module.base.add(0x9ea50),{onEnter(args){
  const source=args[1],scorePointer=source.add(0x28).readPointer();
  send({kind:'lattice-copy-source',flag:source.readU8(),dimensions:[source.add(8).readU64().toString(),source.add(0x10).readU64().toString()],scoreAllocation:allocationOf(scorePointer),stack:Thread.backtrace(this.context,Backtracer.ACCURATE).filter(p=>p.compare(module.base)>=0&&p.compare(module.base.add(module.size))<0).map(relative)});
}});
Interceptor.attach(module.base.add(0xb1820),{onEnter(args){
  const lattice=args[0],key=lattice.toString();
  if(lattices.has(key))return;
  lattices.add(key);
  const frames=lattice.add(0x20).readS32(),offsetPointer=lattice.add(0x40).readPointer();
  if(frames<1||frames>20000)return;
  const offsets=Array.from({length:frames+1},(_,i)=>offsetPointer.add(i*4).readS32());
  const count=offsets.at(-1);if(count<0||count>1000000)return;
  const scores=lattice.add(0x50).readPointer(),labels=lattice.add(0x58).readPointer();
  send({kind:'word-lattice',frames,offsets,scores:Array.from({length:count},(_,i)=>scores.add(i*4).readFloat()),labels:Array.from({length:count},(_,i)=>labels.add(i*4).readS32()),allocations:{captured,offsets:allocationOf(offsetPointer),scores:allocationOf(scores),labels:allocationOf(labels)}});
}});
Interceptor.attach(module.base.add(0xcc410),{onEnter(args){
  this.word=args[0];
  const word=args[0],start=word.add(0x28).readPointer(),end=word.add(0x30).readPointer();
  const count=end.sub(start).toInt32()/40;
  if(!Number.isInteger(count)||count<0||count>1000)return;
  const chars=Array.from({length:count},(_,i)=>{
    const p=start.add(i*40);
    const character=p.readPointer(),raw=p.add(0x20).readPointer();
    return {integers:Array.from({length:4},(_,j)=>p.add(j*4).readS32()),floats:Array.from({length:4},(_,j)=>p.add(16+j*4).readFloat()),character:{id:character.readS32(),physicalId:character.add(4).readS32(),type:character.add(8).readS32(),text:wordText(character.add(0x10))},rawCharacter:{id:raw.readS32(),physicalId:raw.add(4).readS32(),type:raw.add(8).readS32(),text:wordText(raw.add(0x10))}};
  });
  this.chars=chars;
},onLeave(){
  if(!this.chars)return;
  const word=this.word,start=word.add(0x58).readPointer(),end=word.add(0x60).readPointer(),count=end.sub(start).toInt32()/40;
  const alternatives=Number.isInteger(count)&&count>=0&&count<1000?Array.from({length:count},(_,i)=>{const p=start.add(i*40);return {text:wordText(p),score:p.add(0x20).readFloat()};}):null;
  const data=word.add(0x40).readPointer(),limit=word.add(0x48).readPointer(),length=limit.sub(data).toInt32()/4;
  send({kind:'feature-characters',word:wordText(word),startFrame:word.add(0x20).readS32(),endFrame:word.add(0x24).readS32(),chars:this.chars,alternatives,features:length===21?Array.from({length:21},(_,i)=>data.add(i*4).readFloat()):null});
}});
send({kind:'ready',module:module.name,frida:Frida.version});
