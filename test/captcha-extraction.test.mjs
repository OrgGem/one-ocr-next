import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {DdddOcrExtractor,CaptchaError,CAPTCHA_MODEL,CAPTCHA_CHARSET} from '../src/captcha-extractor.mjs';
import {serve} from '../src/server.mjs';

const fixtures=new URL('./fixtures/captcha/',import.meta.url);
const png=await readFile(new URL('captcha-1.png',fixtures));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function expectEntered(promise,label){const reached=await Promise.race([promise.then(()=>true),delay(1000).then(()=>false)]);assert.equal(reached,true,`${label} was not reached within 1s`);}
const fakeEngine=(extra={})=>({bundle:{sourceSha256:'test-oneocr'},recognize:async()=>{throw new Error('OneOCR must not be called for extract=ddddocr');},...extra});
async function start(engine,options={}){return serve({host:'127.0.0.1',port:0,logger:()=>{},engine,...options});}
function headers(contentType='image/png'){return {'content-type':contentType};}
async function raw(app,bytes=png,path='/v1/ocr?extract=ddddocr',contentType='image/png'){
  return fetch(app.url+path,{method:'POST',headers:headers(contentType),body:bytes});
}

class FakeTensor {constructor(type,data,dims){this.type=type;this.data=data;this.dims=dims;}}
function delayedRuntime(release){
  let enteredResolve;const entered=new Promise(resolve=>enteredResolve=resolve);let releases=0;
  const session={inputNames:['input1'],outputNames:['387'],inputMetadata:[{type:'float32',shape:[1,1,64,'image_width']}],outputMetadata:[{type:'float32',shape:[1,'seqlen']}],
    run:async feeds=>{enteredResolve();assert.deepEqual(feeds.input1.dims,[1,1,64,217]);await release.promise;const steps=28;return {'387':{type:'float32',dims:[steps,1,8210],data:new Float32Array(steps*8210)}};},
    release:async()=>{releases++;}};
  return {runtime:{Tensor:FakeTensor,InferenceSession:{create:async(_path,options)=>{assert.deepEqual(options.executionProviders,['cpu']);return session;}}},entered,released:()=>releases};
}

test('pinned ddddocr runtime loads local assets and returns observed case-preserving inference',async()=>{
  const extractor=new DdddOcrExtractor();
  try {
    const result=await extractor.extract(png);
    assert.equal(result.text,'aBC123');
    assert.equal(result.status,'success');
    assert.deepEqual(result.input,{width:340,height:100,normalized_width:217});
    assert.ok(Number.isFinite(result.elapsed_ms)&&result.elapsed_ms>=0);
    assert.equal(CAPTCHA_MODEL.sha256,'b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68');
    assert.equal(CAPTCHA_CHARSET.entries,8210);
  } finally {await extractor.close();}
});

test('extract=ddddocr runs direct image inference and returns pinned metadata without OneOCR fields',async()=>{
  const extractor=new DdddOcrExtractor(),app=await start(fakeEngine({extractCaptcha:(input,options)=>extractor.extract(input,options)}));
  try {
    const response=await raw(app);assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.text,'aBC123');assert.equal(body.extraction.status,'success');
    assert.equal(body.extraction.provider,'ddddocr-onnxruntime');
    assert.equal(body.extraction.model.name,'common_old.onnx');assert.equal(body.extraction.model.sha256,CAPTCHA_MODEL.sha256);
    assert.equal(body.extraction.model.charset_sha256,CAPTCHA_CHARSET.sha256);
    assert.deepEqual(body.extraction.runtime,{package:'onnxruntime-node',version:'1.24.3',execution_provider:'cpu'});
    assert.deepEqual(body.extraction.input,{width:340,height:100,normalized_width:217});
    assert.equal(body.request_id,response.headers.get('x-request-id'));
    assert.equal(Object.hasOwn(body,'lines'),false);assert.equal(Object.hasOwn(body.extraction,'text'),false);
    const form=new FormData();form.set('image',new Blob([png],{type:'image/png'}),'captcha.png');
    const multipart=await fetch(app.url+'/v1/ocr?extract=ddddocr',{method:'POST',body:form});
    assert.equal(multipart.status,200);assert.equal((await multipart.json()).text,'aBC123');
  } finally {await app.close();await extractor.close();}
});

test('no-match response uses empty top-level text and explicit status',async()=>{
  const engine=fakeEngine({extractCaptcha:async()=>({text:'',status:'no_match',input:{width:100,height:100,normalized_width:64},elapsed_ms:1})});
  const app=await start(engine);
  try {
    const response=await raw(app);assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.text,'');assert.equal(body.extraction.status,'no_match');
  } finally {await app.close();}
});

test('CAPTCHA mode rejects incompatible options, schema parts and PDFs before model or document OCR',async()=>{
  let calls=0;const engine=fakeEngine({extractCaptcha:async()=>{calls++;return {text:'x'};},recognize:async()=>{calls++;return {text:'document'};}}),app=await start(engine);
  try {
    for(const option of ['language=vi','layout=deepdoc','rotation=2','pdf_dpi=150']){
      const response=await raw(app,png,`/v1/ocr?extract=ddddocr&${option}`);assert.equal(response.status,422);assert.equal((await response.json()).error,'ddddocr_options_unsupported');
    }
    const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'captcha.png');form.set('schema','{}');
    const schemaResponse=await fetch(app.url+'/v1/ocr?extract=ddddocr',{method:'POST',body:form});assert.equal(schemaResponse.status,422);assert.equal((await schemaResponse.json()).error,'ddddocr_options_unsupported');
    const pdf=await raw(app,Buffer.from('%PDF-1.7\nnot rendered'),'/v1/ocr?extract=ddddocr','application/pdf');assert.equal(pdf.status,422);assert.equal((await pdf.json()).error,'ddddocr_requires_image');
    assert.equal(calls,0);
  } finally {await app.close();}
});

test('CAPTCHA body limit is applied before image parsing',async()=>{
  const app=await start(fakeEngine({extractCaptcha:async()=>{assert.fail('oversized body must not reach model');}}),{maxBodyBytes:4096});
  try {
    const response=await raw(app,Buffer.alloc(4097));assert.equal(response.status,413);assert.equal((await response.json()).error,'captcha_image_too_large');
  } finally {await app.close();}
});

test('missing optional CAPTCHA model files do not block real OneOCR startup',async()=>{
  const app=await serve({host:'127.0.0.1',port:0,logger:()=>{},modelPath:'models',layoutModelPath:undefined,
    captchaModelPath:'models/missing-captcha.onnx',captchaCharsetPath:'models/missing-captcha-charset.json'});
  try {
    assert.equal((await fetch(app.url+'/health/ready')).status,200);
    const normal=await raw(app,png,'/v1/ocr','image/png');assert.equal(normal.status,200);
    const response=await raw(app);assert.equal(response.status,503);assert.equal((await response.json()).error,'captcha_unavailable');
  } finally {await app.close();}
});

test('one native inference is admitted; timeout retains its slot until native work settles',async()=>{
  const release=deferred(),runtime=delayedRuntime(release),extractor=new DdddOcrExtractor({runtime:runtime.runtime});
  const app=await start(fakeEngine({extractCaptcha:(input,options)=>extractor.extract(input,options)}),{maxPending:4,requestTimeoutMs:180});
  try {
    const first=raw(app);await expectEntered(runtime.entered,'fake native inference');
    const busy=await raw(app);assert.equal(busy.status,503);assert.equal((await busy.json()).error,'captcha_busy');
    assert.equal((await first).status,504);
    const stillBusy=await raw(app);assert.equal(stillBusy.status,503);assert.equal((await stillBusy.json()).error,'captcha_busy');
    release.resolve();
    for(let i=0;i<40;i++){const response=await raw(app);if(response.status===200){assert.equal((await response.json()).text,'');return;}assert.equal(response.status,503);await delay(10);}
    assert.fail('CAPTCHA reservation was not released after native run settled');
  } finally {release.resolve();await app.close();await extractor.close();}
});

test('close waits for active native inference and then releases its session',async()=>{
  const release=deferred(),runtime=delayedRuntime(release),extractor=new DdddOcrExtractor({runtime:runtime.runtime}),controller=new AbortController();
  const pending=extractor.extract(png,{signal:controller.signal});
  try {
    await expectEntered(runtime.entered,'fake native inference');
    controller.abort(new CaptchaError(504,'request_timeout','OCR request deadline exceeded'));
    const closing=extractor.close();
    assert.equal(await Promise.race([closing.then(()=>true),delay(20).then(()=>false)]),false);
    release.resolve();await assert.rejects(pending,error=>error.code==='request_timeout');await closing;
    assert.equal(runtime.released(),1);
  } finally {release.resolve();await extractor.close();}
});

test('wide image rejects normalized width before resize, tensor allocation or model loading',async()=>{
  let sessionCreates=0,resizes=0,pipelines=0;
  const runtime={Tensor:FakeTensor,InferenceSession:{create:async()=>{sessionCreates++;throw new Error('must not create session');}}};
  const imageProcessor=()=>{pipelines++;return {metadata:async()=>({width:4096,height:500}),resize(){resizes++;throw new Error('must not resize');}};};
  const extractor=new DdddOcrExtractor({runtime,imageProcessor});
  try {
    await assert.rejects(extractor.extract(Buffer.from('bounded metadata probe')),error=>error.status===422&&error.code==='captcha_image_dimensions');
    assert.equal(pipelines,1);assert.equal(resizes,0);assert.equal(sessionCreates,0);
  } finally {await extractor.close();}
});

test('CTC decoding collapses repeats, resets at blank, and rejects bad model tensors',async()=>{
  const charset=JSON.parse(await readFile(new URL('../models/common_old-charset.json',import.meta.url),'utf8'));
  const steps=28,classes=8210,a=charset.indexOf('A'),b=charset.indexOf('B');
  const logits=new Float32Array(steps*classes);for(const [step,index] of [[0,a],[1,a],[3,a],[4,b],[5,b],[7,b]])logits[step*classes+index]=1;
  const makeRuntime=output=>({Tensor:FakeTensor,InferenceSession:{create:async()=>({inputNames:['input1'],outputNames:['387'],inputMetadata:[{type:'float32',shape:[1,1,64,'image_width']}],outputMetadata:[{type:'float32',shape:[1,'seqlen']}],run:async()=>({'387':output}),release:async()=>{}})}});
  const good=new DdddOcrExtractor({runtime:makeRuntime({type:'float32',dims:[steps,1,classes],data:logits})});
  try {assert.equal((await good.extract(png)).text,'AABB');} finally {await good.close();}
  const badShape=new DdddOcrExtractor({runtime:makeRuntime({type:'float32',dims:[steps,classes],data:new Float32Array(steps*classes)})});
  try {await assert.rejects(badShape.extract(png),error=>error.status===502&&error.code==='captcha_model_output_invalid');} finally {await badShape.close();}
  const nonFinite=new Float32Array(steps*classes);nonFinite[0]=Number.NaN;
  const badValues=new DdddOcrExtractor({runtime:makeRuntime({type:'float32',dims:[steps,1,classes],data:nonFinite})});
  try {await assert.rejects(badValues.extract(png),error=>error.status===502&&error.code==='captcha_model_output_invalid');} finally {await badValues.close();}
});

test('oversized image dimensions and unsupported image bytes fail with explicit errors',async()=>{
  const extractor=new DdddOcrExtractor();
  try {
    const oversized=await sharp({create:{width:2001,height:2000,channels:3,background:'white'}}).png().toBuffer();
    await assert.rejects(extractor.extract(oversized),error=>error.status===422&&error.code==='captcha_image_dimensions');
    await assert.rejects(extractor.extract(Buffer.from('not an image')),error=>error.status===400&&error.code==='invalid_image');
  } finally {await extractor.close();}
});