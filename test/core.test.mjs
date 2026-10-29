import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createHash} from 'node:crypto';
import {decodeOneModel} from '../src/onemodel.mjs';
import {parseAlphabet,resolveScript} from '../src/models.mjs';
import {readFields} from '../src/protobuf.mjs';
import {decodeCtc,decodeBeam,logicalRtl,segmentWords} from '../src/recognizer.mjs';
import {readingOrder} from '../src/geometry.mjs';
import {wireFields,wireMessage} from '../src/onnx-portable.mjs';

const integer=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const blob=b=>Buffer.concat([integer(b.length),b]);
function encrypt(payload,{password,salted=true}={}) {
  const salt=salted?Buffer.alloc(16,7):Buffer.alloc(0),header=Buffer.concat([integer(payload.length),integer(payload.length+24)]);
  const key=createHash('sha256').update(password??header).update(salt).digest();
  const c=createCipheriv('aes-256-cfb',key,Buffer.from('Copyright @ OneO'));
  const clear=Buffer.concat([...(password?[header]:[]),integer(0x252b081a4an),payload]);
  return Buffer.concat([salt,...(password?[]:[header]),c.update(clear),c.final()]);
}

test('OneModel native CFB reader handles partial blocks, exact resources and invalid headers',()=>{
  const data=Buffer.from('This is a small synthetic ONNX carrier, not model weights.');
  const resource=encrypt(data),config=Buffer.from([8,1]);
  const index=Buffer.concat([blob(encrypt(config)),integer(1),blob(encrypt(Buffer.from('C:\\model\\data.bin'),{salted:false})),integer(0),integer(resource.length),Buffer.from([1])]);
  const password=Buffer.from('kj)TGtrK>f]b[Piow.gU+nC@s'+'"'.repeat(6)+'4');
  const container=Buffer.concat([blob(encrypt(index,{password})),blob(resource)]);
  const result=decodeOneModel(container);assert.deepEqual(result.config,config);assert.deepEqual(result.resources[0].bytes,data);assert.equal(result.resources[0].originalName,'C:\\model\\data.bin');
  assert.throws(()=>decodeOneModel(container.subarray(0,-1)),/Truncated/);
  const bad=Buffer.from(container);bad[8+16+16]^=0xff;assert.throws(()=>decodeOneModel(bad),/integrity/);
});

test('alphabet indices, supplementary-plane composites and language aliases retain exact identity',()=>{
  const vocabulary=parseAlphabet('<space> 0\na 1\n\u{F0000} 2\n<blank> 3\n','\u{F0000} a\u0301\n');
  assert.equal(vocabulary.alphabet[2],'á');assert.equal(vocabulary.blank,3);
  assert.throws(()=>parseAlphabet('<space> 0\na 2\n<blank> 3'),/Incomplete/);
  assert.throws(()=>parseAlphabet('a 0\nb 0\n<blank> 1'),/duplicate/);
  assert.equal(resolveScript('vi'),'latin');assert.equal(resolveScript('ta'),'tamil');assert.throws(()=>resolveScript('bn'),/Unsupported/);
});

test('CTC retains repeats separated by blanks, aligns beam output and preserves RTL numbers',()=>{
  const vocabulary={alphabet:[' ','a',''],blank:2};
  const values=[[-8,-.01,-9],[-9,-.02,-8],[-9,-8,-.01],[-9,-.01,-8]];
  const logits={dims:[4,1,3],data:Float32Array.from(values.flat())};
  assert.equal(decodeCtc(logits,vocabulary).text,'aa');
  const beam=decodeBeam(logits,vocabulary,{beamWidth:5});assert.equal(beam.text,'aa');assert.equal(beam.runs.length,2);assert.ok(beam.runs.every(r=>r.frames>0));
  assert.equal(logicalRtl('שלום 2026','hebrew'),'2026 םולש');
  const runs=text=>Array.from(text,(char,i)=>({char,start:i,end:i+1}));
  assert.deepEqual(segmentWords(runs('中文 OCR 2026'),'cjk').map(w=>w.text),['中','文','OCR','2026']);
  assert.deepEqual(segmentWords(runs('สวัสดีชาวโลก'),'thai').map(w=>w.text),['สวัสดี','ชาว','โลก']);
});

test('protobuf lowering preserves unknown fields and uint64 values without numeric loss',()=>{
  const fields=[{number:1000,wire:2,value:Buffer.from([0,0xff])},{number:9,wire:0,value:0xffffffffffffffffn},{number:3,wire:5,value:Buffer.from([0,0,128,63])}];
  const encoded=wireMessage(fields);assert.deepEqual(wireFields(encoded),fields);
  assert.equal(readFields(encoded).get(9)[0],0xffffffffffffffffn);assert.throws(()=>wireFields(Buffer.from([10,20,1])),/length/);
});

test('reading order groups lines by page coordinates',()=>{
  const q=(x,y)=>[[x,y],[x+100,y],[x+100,y+20],[x,y+20]];
  const first={id:1,quad:q(10,10)},second={id:2,quad:q(10,50)};
  assert.deepEqual(readingOrder([second,first],0).map(x=>x.id),[1,2]);
});
