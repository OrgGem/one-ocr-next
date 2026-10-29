import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {evaluate} from '../test/vietnamese-metrics.mjs';

const root=resolve(import.meta.dirname,'..');
const baseUrl=process.env.ONEOCR_BASE_URL??'http://127.0.0.1:8001';
let key=process.env.ONEOCR_API_KEY;
if(!key){try{key=(await readFile(join(root,'.env'),'utf8')).match(/^ONEOCR_API_KEY=(.+)$/m)?.[1].trim();}catch{}}
assert.ok(key&&key.length>=32,'Supply ONEOCR_API_KEY or generate .env with npm run init:service');
const checks=[];
async function call(name,path,options,expected=200) {
  const response=await fetch(baseUrl+path,{signal:AbortSignal.timeout(30000),...options});
  assert.equal(response.status,expected,name);
  const body=await response.json();
  if(path.startsWith('/v1/ocr'))assert.equal(response.headers.get('x-request-id'),body.request_id);
  checks.push({name,status:response.status,requestId:body.request_id});return body;
}
const headers={authorization:'Bearer '+key,'content-type':'image/png'};
const health=await call('readiness','/health/ready');assert.equal(health.status,'ready');assert.equal(health.platform,'linux');
await call('liveness','/health/live');
const spec=await call('openapi','/openapi.json');assert.equal(spec.openapi,'3.0.3');
const image=await readFile(join(root,'test/corpus/fixtures/vietnamese.png'));
await call('missing API key','/v1/ocr',{method:'POST',headers:{'content-type':'image/png'},body:image},401);
await call('wrong API key','/v1/ocr',{method:'POST',headers:{...headers,authorization:'Bearer invalid'},body:image},401);
for(const [mime,bytes] of [['image/png',image],['image/jpeg',await sharp(image).jpeg({quality:95}).toBuffer()],['image/webp',await sharp(image).webp({lossless:true}).toBuffer()]]) {
  const ocr=await call(mime+' Vietnamese','/v1/ocr?language=vi',{method:'POST',headers:{...headers,'content-type':mime},body:bytes});
  assert.equal(ocr.text,'Tiếng Việt có dấu\nHóa đơn tổng cộng 123.45');assert.equal(ocr.provenance.platform,'linux');
  assert.equal(ocr.provenance.decoder,'reconstructed-native-lattice-20-best');assert.equal(ocr.model_sha256,health.model_sha256);
}
const corpus=join(root,'test/vietnamese-tables');
const manifest=JSON.parse(await readFile(join(corpus,'manifest.json'),'utf8'));
const sample=manifest.samples.find(s=>s.id==='vi-table-grid');
const form=new FormData();form.set('file',new Blob([await readFile(join(corpus,sample.file))],{type:'image/png'}),'table.png');
const table=await call('multipart Vietnamese table','/v1/ocr?language=vi',{method:'POST',headers:{authorization:headers.authorization},body:form});
const score=evaluate(sample,table);assert.equal(score.passed,true,JSON.stringify(score.cells.filter(c=>!c.exact)));
await call('bad options','/v1/ocr?language=bn',{method:'POST',headers,body:image},422);
await call('invalid image','/v1/ocr',{method:'POST',headers,body:Buffer.from('invalid image')},400);
await call('bad content type','/v1/ocr',{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'text'},415);
const sourceSha256={};
for(const file of ['src/server.mjs','src/http.mjs','Dockerfile','compose.yaml','docs/openapi.json'])sourceSha256[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
const report={status:'passed',verifiedAt:new Date().toISOString(),baseUrl,health,
  scope:'Actual deployed Docker Compose service over HTTP; synthetic Vietnamese PNG/JPEG/WebP and table fixtures',
  table:{id:sample.id,exactCells:score.exactCells,totalCells:score.totalCells,exactNumericCells:score.exactNumericCells,numericCells:score.numericCells,readingOrderExact:score.readingOrderExact},
  sourceSha256,checks};
await mkdir(join(root,'docs/evidence'),{recursive:true});
await writeFile(join(root,'docs/evidence/service-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
