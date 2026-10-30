import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NeedleJsonExtractor,NEEDLE_MODEL,NEEDLE_MAX_CONTEXT_BYTES} from '../src/needle-extractor.mjs';
import {validateNeedleValue} from '../src/needle-schema.mjs';
import {OcrEngine} from '../src/index.mjs';
import {serve} from '../src/server.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const modelPath=join(root,'models/needle3.cact');
const englishText='INVOICE\nSupplier: Acme Tools Ltd.\nInvoice number: INV-042\nTotal amount: 1250.00 USD';
const englishSchema={type:'object',properties:{supplier:{type:'string'},invoice_number:{type:'string'},total_amount:{type:'string'},currency:{type:'string'}},required:['supplier','invoice_number','total_amount','currency'],additionalProperties:false};
const vietnameseText='HÓA ĐƠN GIÁ TRỊ GIA TĂNG\nCông ty Cổ phần Thương mại Việt Nam\nMã số thuế: 0101234567\nTổng thanh toán: 1.234.567 VND';
const vietnameseSchema={type:'object',properties:{vendor:{type:'string'},tax_id:{type:'string'},total_amount:{type:'string'},currency:{type:'string'}},required:['vendor','tax_id','total_amount','currency'],additionalProperties:false};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('pinned local Needle model extracts a bounded English invoice object and reports Vietnamese no-match explicitly',async()=>{
  const extractor=new NeedleJsonExtractor({modelPath});
  try {
    const english=await extractor.extract(englishText,englishSchema);
    assert.equal(english.status,'success');assert.equal(english.schema_validation,'valid');assert.equal(english.output_validation,'valid');
    assert.deepEqual(english.data,{supplier:'Acme Tools Ltd.',invoice_number:'INV-042',total_amount:'1250.00',currency:'USD'});
    assert.ok(validateNeedleValue(englishSchema,english.data));assert.equal(english.model.sha256,NEEDLE_MODEL.sha256);assert.ok(english.elapsed_ms>0);
    const vietnamese=await extractor.extract(vietnameseText,vietnameseSchema);
    assert.ok(['success','no_match','invalid_model_output'].includes(vietnamese.status));
    if(vietnamese.status==='success')assert.deepEqual(vietnamese.data,{vendor:'Công ty Cổ phần Thương mại Việt Nam',tax_id:'0101234567',total_amount:'1.234.567',currency:'VND'});
    else {assert.ok(vietnamese.error?.code);assert.equal(Object.hasOwn(vietnamese,'data'),false);}
  } finally {await extractor.close();}
});

test('real HTTP multipart OCR extracts exact invoice number and currency from the pinned image fixture',async()=>{
  const manifest=JSON.parse(await readFile(join(root,'test/needle/fixtures/manifest.json'),'utf8'));
  const image=await readFile(join(root,'test/needle/fixtures',manifest.file));
  assert.equal(image.length,manifest.bytes);assert.equal(createHash('sha256').update(image).digest('hex'),manifest.sha256);
  const schema={type:'object',properties:{
    invoice_number:{type:'string',description:'The value printed after INVOICE NUMBER:'},
    currency:{type:'string',description:'The three-letter currency printed after the total amount.'}
  },required:['invoice_number','currency'],additionalProperties:false};
  const engine=await OcrEngine.create({modelPath:join(root,'models'),needleModelPath:modelPath,threads:2});
  const key='real-english-invoice-http-test-key-000001';
  const app=await serve({engine,host:'127.0.0.1',port:0,apiKey:key,logger:()=>{}});
  try {
    const form=new FormData();form.set('file',new Blob([image],{type:'image/png'}),'en-invoice.png');form.set('schema',JSON.stringify(schema));form.set('instruction','Extract only these fields exactly as printed.');
    const response=await fetch(`${app.url}/v1/ocr?extract=needle`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form});
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.text,manifest.expected_ocr_text);assert.equal(body.lines.length,5);assert.match(body.request_id,/^[0-9a-f-]{36}$/);
    assert.equal(body.extraction.status,'success');assert.equal(body.extraction.schema_validation,'valid');assert.equal(body.extraction.output_validation,'valid');
    assert.deepEqual(body.extraction.data,manifest.expected_data);assert.equal(body.extraction.model.sha256,NEEDLE_MODEL.sha256);
  } finally {await app.close();await engine.close();}
});

test('closing during lazy model verification cannot create a Needle worker afterward',async()=>{
  const extractor=new NeedleJsonExtractor({modelPath:'unused'}),entered=deferred(),release=deferred();
  extractor.verifyModel=async()=>{entered.resolve();await release.promise;};
  const pending=extractor.extract('source',englishSchema).then(()=>assert.fail('close should abort extraction'),error=>error);
  await entered.promise;const closing=extractor.close();release.resolve();
  const error=await pending;await closing;
  assert.equal(error.code,'extractor_closed');assert.equal(extractor.session,undefined);
});

test('abort before active-session assignment closes the cached Needle worker',async()=>{
  const extractor=new NeedleJsonExtractor({modelPath:'unused'});let closed=0;
  extractor.verified=true;
  extractor.session={complete:async()=>assert.fail('aborted request must not generate'),close:async()=>{closed++;}};
  const controller=new AbortController(),reason=new Error('caller cancelled');reason.code='caller_cancelled';
  extractor.verifyModel=async()=>{queueMicrotask(()=>controller.abort(reason));await Promise.resolve();};
  await assert.rejects(extractor.extract('source',englishSchema,{signal:controller.signal}),error=>error.code==='caller_cancelled');
  assert.equal(extractor.session,undefined);assert.equal(closed,1);
  await extractor.close();assert.equal(closed,1,'teardown must not leak or close the cached worker twice');
});

test('mixed live and suppressed model calls are rejected without returning data',async()=>{
  const extractor=new NeedleJsonExtractor({modelPath:'unused'});extractor.verifyModel=async()=>{};
  extractor.session={complete:async()=>({success:true,function_calls:[{name:'extract',arguments:{supplier:'Acme Tools Ltd.',invoice_number:'INV-042',total_amount:'1250.00',currency:'USD'}}],suppressed_calls:[{name:'extract',arguments:{supplier:'invented'}}],validation:{},error:null}),close:async()=>{}};
  try {
    const result=await extractor.extract(englishText,englishSchema);
    assert.equal(result.status,'invalid_model_output');assert.equal(result.error.code,'model_withheld_call_present');assert.equal(Object.hasOwn(result,'data'),false);
  } finally {await extractor.close();}
});

test('OCR invoice fixture reaches the real HTTP extraction route with untouched OCR output',async()=>{
  const manifest=JSON.parse(await readFile(join(root,'test/vietnamese-tables/manifest.json'),'utf8'));
  const sample=manifest.samples.find(item=>item.id==='vi-invoice');assert.ok(sample);
  const image=await readFile(join(root,'test/vietnamese-tables',sample.file));
  const schema={type:'object',properties:{vendor:{type:'string'},invoice_date:{type:'string'},tax_id:{type:'string'},total_amount:{type:'string'},currency:{type:'string'}},required:['vendor','invoice_date','tax_id','total_amount','currency'],additionalProperties:false};
  const engine=await OcrEngine.create({modelPath:join(root,'models'),needleModelPath:modelPath,threads:2});
  const key='real-invoice-test-api-key-0123456789';
  const app=await serve({engine,host:'127.0.0.1',port:0,apiKey:key,logger:()=>{}});
  try {
    const form=new FormData();form.set('file',new Blob([image],{type:'image/png'}),'vi-invoice.png');form.set('schema',JSON.stringify(schema));form.set('instruction','Extract fields exactly as printed in the invoice.');
    const response=await fetch(`${app.url}/v1/ocr?extract=needle&language=vi`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form});
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.text,sample.expectedText);assert.ok(body.lines.length>0);assert.match(body.request_id,/^[0-9a-f-]{36}$/);
    assert.equal(body.extraction.model.sha256,NEEDLE_MODEL.sha256);assert.equal(body.extraction.schema_validation,'valid');
    assert.ok(['success','no_match','invalid_model_output','unavailable','input_too_large','timeout'].includes(body.extraction.status));
    if(body.extraction.status==='success') {
      assert.ok(validateNeedleValue(schema,body.extraction.data));
      assert.deepEqual(body.extraction.data,{vendor:'Công ty Cổ phần Thương mại Việt Nam',invoice_date:'29/10/2026',tax_id:'0101234567',total_amount:'1.234.567',currency:'VND'});
    } else assert.equal(Object.hasOwn(body.extraction,'data'),false);
  } finally {await app.close();await engine.close();}
});

test('extractor returns explicit context overflow without truncating OCR text',async()=>{
  const extractor=new NeedleJsonExtractor({modelPath:'unused',maxContextBytes:32});extractor.verifyModel=async()=>assert.fail('context overflow must not load model');
  try {
    const result=await extractor.extract('x'.repeat(64),{type:'object',properties:{value:{type:'string'}}});
    assert.equal(result.status,'input_too_large');assert.equal(result.error.code,'context_limit');assert.equal(result.input_bytes,64);assert.equal(result.max_context_bytes,32);
  } finally {await extractor.close();}
});
