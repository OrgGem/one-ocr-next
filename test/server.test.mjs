import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {serve} from '../src/server.mjs';
import {serviceConfig} from '../src/http.mjs';

const key='test-only-api-key-0123456789-abcdef';
const result={text:'Tiếng Việt',text_angle:0,lines:[],width:100,height:100,elapsed_ms:1,model_sha256:'test-model',provenance:{runtime:'native-nodejs'}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const headers={'content-type':'image/png',authorization:'Bearer '+key};
const fake=(recognize,extractJson)=>({bundle:{sourceSha256:'test-model'},recognize:recognize??(async()=>result),...(extractJson?{extractJson}:{})});
const start=(options={})=>serve({host:'127.0.0.1',port:0,apiKey:key,logger:()=>{},engine:fake(),...options});
const post=(app,path='/v1/ocr',extra={})=>fetch(app.url+path,{method:'POST',headers,body:Buffer.from([1,2,3]),...extra});
const invoiceSchema={type:'object',properties:{invoice_number:{type:'string'},total_amount:{type:'string'}},required:['invoice_number','total_amount'],additionalProperties:false};
function extractionForm(schema=invoiceSchema,instruction='Extract the invoice number and total amount.') {
  const form=new FormData();form.set('file',new Blob(['test image'],{type:'image/png'}),'invoice.png');
  form.set('schema',typeof schema==='string'?schema:JSON.stringify(schema));if(instruction!==undefined)form.set('instruction',instruction);return form;
}
const postExtraction=(app,schema=invoiceSchema,instruction='Extract the invoice number and total amount.')=>fetch(app.url+'/v1/ocr?extract=needle',{method:'POST',headers:{authorization:headers.authorization},body:extractionForm(schema,instruction)});
async function waitIdle(app) {
  for(let i=0;i<40;i++){const h=await (await fetch(app.url+'/health/ready')).json();if(h.pending===0)return;await delay(10);}
  assert.fail('Request capacity was not released');
}

test('API auth, public health/spec, aliases, request IDs and privacy-safe logs',async()=>{
  const records=[],calls=[];
  const app=await start({logger:r=>records.push(r),engine:fake(async(bytes,options)=>{calls.push({bytes,options});return result;})});
  try {
    assert.equal((await fetch(app.url+'/health/live')).status,200);
    const health=await (await fetch(app.url+'/health/ready')).json();assert.equal(health.status,'ready');assert.equal(health.pending,0);
    const spec=await (await fetch(app.url+'/openapi.json')).json();assert.equal(spec.openapi,'3.0.3');assert.ok(spec.paths['/v1/ocr'].post.security);
    for(const authorization of [undefined,'Bearer wrong','Basic '+key]) {
      const response=await post(app,'/v1/ocr',{headers:{'content-type':'image/png',...(authorization?{authorization}:{})}});
      assert.equal(response.status,401);assert.equal(response.headers.get('www-authenticate'),'Bearer');
      const body=await response.json();assert.equal(body.error,'unauthorized');assert.equal(body.request_id,response.headers.get('x-request-id'));
    }
    for(const path of ['/v1/ocr','/api/v1/ocr','/ocr','/']) {
      const response=await post(app,path+'?language=vi&max_lines=10&min_confidence=0.5&reject_low_quality=false');
      assert.equal(response.status,200);const body=await response.json();assert.equal(body.text,result.text);
      assert.match(body.request_id,/^[0-9a-f-]{36}$/);assert.equal(body.request_id,response.headers.get('x-request-id'));
    }
    assert.equal(calls.length,4);assert.equal(calls[0].options.language,'vi');assert.equal(calls[0].options.maxLines,10);assert.equal(calls[0].options.minConfidence,.5);assert.equal(calls[0].options.rejectLowQuality,false);
    assert.equal((await fetch(app.url+'/v1/ocr')).status,405);
    assert.equal((await fetch(app.url+'/missing')).status,404);
    const logged=JSON.stringify(records);assert.ok(!logged.includes(key));assert.ok(!logged.includes('Tiếng Việt'));
    assert.ok(records.some(r=>r.event==='request'&&r.status===401));
  } finally {await app.close();}
});

test('API rejects invalid/duplicate/unknown options before invoking the engine',async()=>{
  let calls=0;const app=await start({engine:fake(async()=>{calls++;return result;})});
  try {
    for(const query of ['language=bn','language=vi&script=latin','language=vi&language=en','max_lines=1.5','max_lines=','max_lines=1001','resize_short=0','resize_long=1153','min_confidence=NaN','min_confidence=1.1','reject_low_quality=1','unexpected=1']) {
      const response=await post(app,'/v1/ocr?'+query);assert.equal(response.status,422,query);assert.equal((await response.json()).error,'invalid_options');
    }
    assert.equal(calls,0);
  } finally {await app.close();}
  assert.throws(()=>serviceConfig({ONEOCR_MAX_PENDING:'1.5'}),/maxPending/);
  await assert.rejects(start({apiKey:'short'}),/32/);
  await assert.rejects(start({maxPending:0}),/maxPending/);
});

test('API enforces one multipart file, valid content type and non-empty input',async()=>{
  const app=await start();
  try {
    for(const field of ['file','image']) {
      const form=new FormData();form.set(field,new Blob(['data'],{type:'image/png'}),'image.png');
      assert.equal((await post(app,'/v1/ocr',{headers:{authorization:headers.authorization},body:form})).status,200);
    }
    const duplicate=new FormData();duplicate.append('file',new Blob(['x']),'x.png');duplicate.append('image',new Blob(['y']),'y.png');
    assert.equal((await post(app,'/v1/ocr',{headers:{authorization:headers.authorization},body:duplicate})).status,400);
    const text=new FormData();text.set('file','not a file');
    assert.equal((await post(app,'/v1/ocr',{headers:{authorization:headers.authorization},body:text})).status,400);
    assert.equal((await post(app,'/v1/ocr',{headers:{...headers,'content-type':'multipart/form-data'},body:'malformed'})).status,400);
    assert.equal((await post(app,'/v1/ocr',{headers:{...headers,'content-type':'text/plain'}})).status,415);
    assert.equal((await post(app,'/v1/ocr',{body:Buffer.alloc(0)})).status,400);
  } finally {await app.close();}
});

test('Needle extraction is opt-in, validates multipart schema before OCR, and preserves OCR fields',async()=>{
  let ocrCalls=0,extractCalls=0;const output={provider:'cactus-needle-wasm',model:{name:'needle3',sha256:'pinned'},schema_validation:'valid',output_validation:'valid',status:'success',elapsed_ms:2,data:{invoice_number:'INV-042',total_amount:'1250.00'}};
  const engine=fake(async(_image,options)=>{ocrCalls++;assert.equal(options.extraction,ocrCalls===1?undefined:'needle');return result;},async(text,schema,options)=>{
    extractCalls++;assert.equal(text,result.text);assert.equal(schema.properties.invoice_number.type,'string');assert.match(options.instruction,/invoice number/);return output;
  });
  const app=await start({engine});
  try {
    const normal=await post(app);assert.equal(normal.status,200);const base=await normal.json();assert.equal(Object.hasOwn(base,'extraction'),false);assert.equal(ocrCalls,1);assert.equal(extractCalls,0);
    const response=await postExtraction(app);assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.text,result.text);assert.deepEqual(body.lines,result.lines);assert.equal(body.request_id,response.headers.get('x-request-id'));assert.deepEqual(body.extraction,output);
    assert.equal(ocrCalls,2);assert.equal(extractCalls,1);
    const raw=await post(app,'/v1/ocr?extract=needle');assert.equal(raw.status,422);assert.equal((await raw.json()).error,'extract_requires_multipart');
    const unsupported=await postExtraction(app,{type:'object',properties:{id:{type:'string'}},$ref:'https://example.invalid/schema'});
    assert.equal(unsupported.status,422);assert.equal((await unsupported.json()).error,'unsupported_schema');
    const oversized=await postExtraction(app,invoiceSchema,'x'.repeat(1025));assert.equal(oversized.status,422);assert.equal((await oversized.json()).error,'instruction_too_large');
    assert.equal(ocrCalls,2);assert.equal(extractCalls,1,'invalid extraction inputs must not call OCR or Needle');
  } finally {await app.close();}
});

test('Needle extraction admits one request and reports concurrent extraction as busy',async()=>{
  const entered=deferred(),release=deferred();let ocrCalls=0;
  const output={provider:'cactus-needle-wasm',model:{name:'needle3'},schema_validation:'valid',output_validation:'valid',status:'success',elapsed_ms:1,data:{invoice_number:'INV-042',total_amount:'1250.00'}};
  const engine=fake(async()=>{ocrCalls++;return result;},async()=>{entered.resolve();await release.promise;return output;});
  const app=await start({engine});
  try {
    const first=postExtraction(app);await entered.promise;
    const second=await postExtraction(app);assert.equal(second.status,503);assert.equal(second.headers.get('retry-after'),'1');assert.equal((await second.json()).error,'extraction_busy');
    assert.equal(ocrCalls,1,'busy extraction must be rejected before OCR');
    release.resolve();assert.equal((await first).status,200);
  } finally {release.resolve();await app.close();}
});

test('body limit applies to content-length and chunked transfers',async()=>{
  const app=await start({maxBodyBytes:16});
  try {
    assert.equal((await post(app,'/v1/ocr',{body:Buffer.alloc(17)})).status,413);
    const body=new ReadableStream({start(c){c.enqueue(Buffer.alloc(10));c.enqueue(Buffer.alloc(10));c.close();}});
    const response=await post(app,'/v1/ocr',{body,duplex:'half'});assert.equal(response.status,413);
    assert.equal((await response.json()).error,'image_too_large');await waitIdle(app);
  } finally {await app.close();}
});

test('queue remains bounded after deadline until the outstanding engine call settles',async()=>{
  const entered=deferred(),release=deferred();
  const app=await start({maxPending:1,requestTimeoutMs:150,engine:fake(async()=>{entered.resolve();await release.promise;return result;})});
  try {
    const first=post(app);await entered.promise;
    const busy=await post(app);assert.equal(busy.status,503);assert.equal(busy.headers.get('retry-after'),'1');
    assert.equal((await first).status,504);
    assert.equal((await post(app)).status,503,'timeout must not release occupied model capacity');
    release.resolve();await waitIdle(app);assert.equal((await post(app)).status,200);
  } finally {release.resolve();await app.close();}
});

test('upload deadline stops stalled bodies and releases capacity',async()=>{
  const app=await start({requestTimeoutMs:150,maxPending:1});
  try {
    const status=await new Promise((resolve,reject)=>{
      const request=httpRequest(app.url+'/v1/ocr',{method:'POST',headers:{...headers,'content-length':'1000'}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});
      request.on('error',reject);request.write(Buffer.from([1]));
    });
    assert.equal(status,504);await waitIdle(app);assert.equal((await post(app)).status,200);
  } finally {await app.close();}
});

test('client disconnect aborts work without crashing or leaking a queue slot',async()=>{
  const entered=deferred();
  const app=await start({engine:fake(async(_input,{signal})=>{
    entered.resolve();return new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  })});
  try {
    const controller=new AbortController();const pending=post(app,'/v1/ocr',{signal:controller.signal});
    const rejected=assert.rejects(pending);await entered.promise;controller.abort();await rejected;await waitIdle(app);
    assert.equal((await fetch(app.url+'/health/ready')).status,200);
  } finally {await app.close();}
});

test('internal failures do not expose exception details; graceful close drains in-flight work',async()=>{
  const app=await start({engine:fake(async()=>{throw new Error('private disk path or credentials');})});
  try {
    const response=await post(app);assert.equal(response.status,500);assert.ok(!(await response.text()).includes('private disk'));
  } finally {await app.close();}
  const entered=deferred(),release=deferred();
  const draining=await start({engine:fake(async()=>{entered.resolve();await release.promise;return result;})});
  const request=post(draining);await entered.promise;
  const closed=draining.close();assert.equal(closed,draining.close());release.resolve();
  assert.equal((await request).status,200);await closed;
});
