import {createDecipheriv, createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';

const MAX_BYTES = 1024 * 1024 * 1024;
const MAGIC = 0x252b081a4an;
const IV = Buffer.from('Copyright @ OneO');
const PASSWORD = Buffer.from('kj)TGtrK>f]b[Piow.gU+nC@s' + '"'.repeat(6) + '4');

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

class Reader {
  constructor(data) { this.data=data; this.position=0; }
  take(size) {
    if (!Number.isSafeInteger(size) || size<0 || size>this.data.length-this.position) throw new Error('Truncated or invalid OneModel record');
    const result=this.data.subarray(this.position,this.position+size); this.position+=size; return result;
  }
  integer() {
    const value=this.take(8).readBigUInt64LE();
    if (value>BigInt(MAX_BYTES)) throw new Error('OneModel integer exceeds the supported size limit');
    return Number(value);
  }
  blob() {return this.take(this.integer());}
  finish() {if(this.position!==this.data.length) throw new Error('Unexpected trailing OneModel data');}
}

export function decryptRecord(record, {password, salted=true}={}) {
  const reader=new Reader(record);
  const salt=salted?reader.take(16):Buffer.alloc(0);
  const header=password?null:reader.take(16);
  const key=createHash('sha256').update(password??header).update(salt).digest();
  const encrypted=reader.data.subarray(reader.position);
  if (!encrypted.length) throw new Error('Empty OneModel ciphertext');
  // Observed in the supplied DLL: ChainingModeCFB, MessageBlockLength=16.
  // The final record can be a partial block; it is not CBC/PKCS#7.
  const decipher=createDecipheriv('aes-256-cfb',key,IV);
  const plaintext=Buffer.concat([decipher.update(encrypted),decipher.final()]);
  const clear=new Reader(plaintext);
  const length=header?Number(header.readBigUInt64LE(0)):clear.integer();
  const total=header?Number(header.readBigUInt64LE(8)):clear.integer();
  const marker=clear.take(8).readBigUInt64LE();
  if(marker!==MAGIC || total!==length+24 || length>MAX_BYTES) throw new Error('OneModel integrity header does not match');
  const payload=clear.take(length);clear.finish();return payload;
}

export function decodeOneModel(data) {
  if(data.length>MAX_BYTES) throw new Error('OneModel exceeds the 1 GiB input limit');
  const file=new Reader(data);
  const index=new Reader(decryptRecord(file.blob(),{password:PASSWORD}));
  const body=file.blob();file.finish();
  const config=decryptRecord(index.blob());
  const count=index.integer();
  if(count<1 || count>4096) throw new Error('Invalid OneModel resource count');
  const resources=[];const names=new Set();let next=0;
  for(let i=0;i<count;i++) {
    const originalName=new TextDecoder('utf-8',{fatal:true}).decode(decryptRecord(index.blob(),{salted:false}));
    const offset=index.integer(), length=index.integer(), flag=index.take(1)[0];
    if(!originalName || originalName.includes('\0') || names.has(originalName) || flag!==1 || offset!==next || offset+length>body.length) throw new Error('Invalid OneModel resource index');
    names.add(originalName);
    const bytes=decryptRecord(body.subarray(offset,offset+length));
    resources.push({id:i,originalName,bytes,sha256:sha256(bytes)});next=offset+length;
  }
  index.finish();if(next!==body.length) throw new Error('OneModel resource index does not cover the payload');
  return {sha256:sha256(data),config,resources};
}
export async function readOneModel(path) {
  const info=await stat(path);
  if(info.size>MAX_BYTES)throw new Error('OneModel exceeds the 1 GiB input limit');
  return decodeOneModel(await readFile(path));
}
