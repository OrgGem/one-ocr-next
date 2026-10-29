// Bounded protobuf-wire reader for the configuration embedded in OneModel.
export function readFields(data) {
  const result=new Map();let offset=0;
  const integer=()=>{let value=0n,shift=0n;for(let i=0;i<10;i++){if(offset>=data.length)throw new Error('Truncated protobuf varint');const byte=data[offset++];value|=BigInt(byte&127)<<shift;if(!(byte&128))return value;shift+=7n;}throw new Error('Invalid protobuf varint');};
  const take=size=>{if(!Number.isSafeInteger(size)||size<0||size>data.length-offset)throw new Error('Truncated protobuf field');const value=data.subarray(offset,offset+size);offset+=size;return value;};
  while(offset<data.length) {
    const tag=integer(),field=Number(tag>>3n),wire=Number(tag&7n);if(field<1)throw new Error('Invalid protobuf tag');let value;
    if(wire===0){const raw=integer();value=raw>BigInt(Number.MAX_SAFE_INTEGER)?raw:Number(raw);}
    else if(wire===1)value=take(8).readDoubleLE();
    else if(wire===2)value=take(Number(integer()));
    else if(wire===5)value=take(4).readFloatLE();
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
    if(!result.has(field))result.set(field,[]);result.get(field).push(value);
  }
  return result;
}
