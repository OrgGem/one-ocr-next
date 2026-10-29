// ONNX wire-preserving lowering for the frozen feature block in OneOCR.
// Other protobuf fields and tensors are retained byte-for-byte as field payloads.
function varint(value) {
  value=BigInt(value);const bytes=[];
  do{let byte=Number(value&127n);value>>=7n;if(value)byte|=128;bytes.push(byte);}while(value);
  return Buffer.from(bytes);
}
export function wireFields(data) {
  let pos=0;const fields=[];
  const integer=()=>{let n=0n,s=0n;for(let i=0;i<10;i++){if(pos>=data.length)throw new Error('Truncated ONNX protobuf');const b=data[pos++];n|=BigInt(b&127)<<s;if(!(b&128))return n;s+=7n;}throw new Error('Malformed ONNX protobuf');};
  while(pos<data.length) {
    const tag=integer(),number=Number(tag>>3n),wire=Number(tag&7n);let value;
    if(!number)throw new Error('Invalid ONNX field tag');
    if(wire===0)value=integer();
    else {
      const size=wire===2?Number(integer()):wire===1?8:wire===5?4:-1;
      if(size<0||!Number.isSafeInteger(size)||size>data.length-pos)throw new Error('Invalid ONNX field length');
      value=data.subarray(pos,pos+size);pos+=size;
    }
    fields.push({number,wire,value});
  }
  return fields;
}
export function wireMessage(fields) {return Buffer.concat(fields.flatMap(f=>{const tag=varint(f.number*8+f.wire);return f.wire===0?[tag,varint(f.value)]:f.wire===2?[tag,varint(f.value.length),f.value]:[tag,f.value];}));}
const bytes=(number,value)=>({number,wire:2,value:Buffer.isBuffer(value)?value:Buffer.from(value)});
const integer=(number,value)=>({number,wire:0,value:BigInt(value)});
const text=(fields,number)=>fields.find(f=>f.number===number)?.value.toString('utf8');
const tensor=(name,shape,values)=>{
  const data=Buffer.alloc(values.length*4);values.forEach((v,i)=>data.writeFloatLE(v,i*4));
  return wireMessage([...shape.map(d=>integer(1,d)),integer(2,1),bytes(8,name),bytes(9,data)]);
};
const node=(op,inputs,outputs,attributes=[])=>wireMessage([...inputs.map(v=>bytes(1,v)),...outputs.map(v=>bytes(2,v)),bytes(4,op),...attributes.map(v=>bytes(5,v))]);

export function frozenFeatureParameters(config) {
  if(config.length%4)throw new Error('Misaligned OneOCR frozen-feature data');
  const values=Array.from({length:config.length/4},(_,i)=>config.readFloatBE(i*4));
  let outputs=-1;
  for(let k=1;k<1024&&k+1<values.length;k++)if(values[k]===k&&values[k+1]===1){outputs=k;break;}
  if(outputs<1)throw new Error('Unknown OneOCR frozen-feature bias layout');
  // The serialized vectors/matrices are stack-ordered, hence reversal before
  // conversion to ONNX row-major output-by-input matrices.
  const kind=values.at(-19)===2?'dense':values.at(-19)===4?'conv':null;
  if(!kind)throw new Error('Unknown OneOCR frozen-feature block type');
  const dimensions=values.length-19-(kind==='dense'?2:4);
  const inputs=values[dimensions+(kind==='dense'?0:2)],declaredOutputs=values[dimensions+(kind==='dense'?1:3)];
  if(kind==='conv'&&(values[dimensions]!==1||values[dimensions+1]!==1))throw new Error('Unsupported frozen-feature convolution kernel');
  if(!Number.isInteger(inputs)||inputs<1||inputs>4096||declaredOutputs!==outputs||dimensions!==(outputs+2+inputs*outputs))throw new Error('Inconsistent frozen-feature dimensions');
  const relu=values.at(-4);if(![0,1].includes(relu))throw new Error('Unsupported frozen-feature activation');
  return {kind,inputs,outputs,relu:Boolean(relu),bias:values.slice(0,outputs).reverse(),weights:values.slice(outputs+2,dimensions).reverse()};
}

export function makePortableOnnx(original) {
  // Most models do not contain a private operator; avoid decoding their large
  // graphs until the byte marker is present.
  if(!original.includes(Buffer.from('OneOCRFeatureExtract')))return {bytes:original,converted:0};
  const model=wireFields(original),graphField=model.find(f=>f.number===7);
  if(!graphField)throw new Error('ONNX graph is missing');
  const graph=wireFields(graphField.value),initializers=new Map();
  for(const f of graph.filter(f=>f.number===5)){const fields=wireFields(f.value);initializers.set(text(fields,8),fields);}
  const replacement=[];const removed=new Set();let converted=0;
  for(const field of graph) {
    if(field.number!==1){replacement.push(field);continue;}
    const fields=wireFields(field.value);
    if(text(fields,4)!=='OneOCRFeatureExtract'){replacement.push(field);continue;}
    if(text(fields,7)!=='com.microsoft.oneocr')throw new Error('Unexpected frozen-feature operator domain');
    const inputs=fields.filter(f=>f.number===1).map(f=>f.value.toString('utf8')),output=fields.find(f=>f.number===2).value.toString('utf8');
    const config=initializers.get(inputs[1])?.find(f=>f.number===6)?.value;
    if(!config)throw new Error('OneOCR frozen-feature configuration is missing');
    const parameters=frozenFeatureParameters(config),prefix=`oneocr_port_${converted++}`;
    const weightName=prefix+'_weights',biasName=prefix+'_bias',temporary=prefix+'_linear';
    replacement.push(bytes(5,tensor(weightName,parameters.kind==='dense'?[parameters.outputs,parameters.inputs]:[parameters.outputs,parameters.inputs,1,1],parameters.weights)),bytes(5,tensor(biasName,[parameters.outputs],parameters.bias)));
    const attributes=parameters.kind==='dense'?[wireMessage([bytes(1,'transB'),integer(3,1),integer(20,2)])]:[];
    replacement.push(bytes(1,node(parameters.kind==='dense'?'Gemm':'Conv',[inputs[0],weightName,biasName],[parameters.relu?temporary:output],attributes)));
    if(parameters.relu)replacement.push(bytes(1,node('Relu',[temporary],[output])));
    removed.add(inputs[1]);
  }
  graphField.value=wireMessage(replacement.filter(f=>f.number!==5||!removed.has(text(wireFields(f.value),8))));
  return {bytes:wireMessage(model),converted};
}
