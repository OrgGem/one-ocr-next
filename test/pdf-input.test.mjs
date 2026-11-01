import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import {serve} from '../src/server.mjs';
import {ocrOptions} from '../src/http.mjs';
import {parsePdfPages,selectPdfPages,validatePdfPageDimensions,PDF_MAX_SELECTED_PAGES,PDF_MAX_PAGE_PIXELS,PDF_MAX_TOTAL_PIXELS} from '../src/pdf-options.mjs';
import {capturePdfWarningOutput} from '../src/pdf-warning-capture.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixture=join(root,'test/fixtures/pdf-invoice-multipage.pdf');
const key='pdf-input-test-api-key-0123456789-abcdef';
const requestHeaders={'content-type':'application/pdf',authorization:`Bearer ${key}`};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const resultFor=(width,height,text='test')=>({text,text_angle:0,lines:[],width,height,elapsed_ms:1,model_sha256:'test-model',provenance:{runtime:'native-nodejs'}});
const start=(engine,options={})=>serve({host:'127.0.0.1',port:0,apiKey:key,logger:()=>{},engine:engine.bundle?engine:{bundle:{sourceSha256:'test-model'},...engine},...options});
const postPdf=(app,pdf,query='',headers={'content-type':'application/pdf',authorization:`Bearer ${key}`})=>fetch(`${app.url}/v1/ocr${query?`?${query}`:''}`,{method:'POST',headers,body:pdf});

test('PDF page selectors and dimensions are strict and bounded before expansion or rendering',()=>{
  assert.deepEqual(parsePdfPages('1,3-5'),[1,3,4,5]);
  assert.equal(parsePdfPages(undefined),null);
  for(const value of ['','0','01','4-2','1,1','1-3,3-4','1,21-1000000','9007199254740992'])assert.throws(()=>parsePdfPages(value),error=>error.status===422);
  assert.throws(()=>ocrOptions(new URLSearchParams('pdf_dpi=71')),error=>error.code==='invalid_options');
  assert.throws(()=>ocrOptions(new URLSearchParams('pdf_dpi=300.1')),error=>error.code==='invalid_options');
  assert.deepEqual(ocrOptions(new URLSearchParams('pdf_dpi=300&pdf_pages=2-3')).pdf,{dpi:300,pages:[2,3]});
  assert.throws(()=>selectPdfPages(null,PDF_MAX_SELECTED_PAGES+1),error=>error.code==='pdf_page_limit');
  assert.throws(()=>selectPdfPages([1,4],3),error=>error.code==='pdf_page_selection');
  assert.throws(()=>validatePdfPageDimensions(5000,3000),error=>error.code==='pdf_page_pixel_limit');
  assert.ok(PDF_MAX_TOTAL_PIXELS>PDF_MAX_PAGE_PIXELS);
});

test('PDF warning capture fails closed for codec console warnings and PDF.js warning logs',()=>{
  const warnings=[],restore=capturePdfWarningOutput(warnings);
  try {
    console.warn('OpenJPEG: JPEG2000 image data was skipped');
    console.log('Warning: Image exceeded maximum allowed size and was removed.');
    console.log('non-warning diagnostic');
  } finally {restore();}
  assert.deepEqual(warnings,['OpenJPEG: JPEG2000 image data was skipped','Warning: Image exceeded maximum allowed size and was removed.']);
});

test('real PDF.js renderer preflights all selected pages, handles rotation, and yields sequential PNG pages',async()=>{
  const {PdfRenderer}=await import('../src/pdf-renderer.mjs');
  const pdf=await readFile(fixture),receipt=JSON.parse(await readFile(join(root,'test/fixtures/pdf-invoice-multipage.json'),'utf8'));
  assert.equal(pdf.length,receipt.bytes);assert.equal(createHash('sha256').update(pdf).digest('hex'),receipt.sha256);
  const renderer=new PdfRenderer({deadlineAt:performance.now()+30000});
  try {
    const opened=await renderer.open(pdf,{dpi:72,pages:[1,2,3]});
    assert.equal(opened.pageCount,3);assert.deepEqual(opened.pages.map(page=>page.pageNumber),[1,2,3]);
    assert.deepEqual(opened.pages.map(page=>[page.width,page.height]),[[596,842],[842,596],[842,596]]);
    assert.equal(opened.pages[2].rotation,90);assert.ok(opened.totalPixels<PDF_MAX_TOTAL_PIXELS);
    const page=await renderer.render(1);assert.equal(page.pageNumber,1);
    assert.equal((await sharp(page.png).metadata()).format,'png');
    assert.deepEqual([(await sharp(page.png).metadata()).width,(await sharp(page.png).metadata()).height],[596,842]);
  } finally {await renderer.close();}
  assert.equal(renderer.child.exitCode,0,'PDF.js loadingTask must be destroyed before the isolated process exits cleanly');
});

test('oversized embedded PDF image is rejected instead of silently omitted',async()=>{
  const {PdfRenderer}=await import('../src/pdf-renderer.mjs');
  const png=await sharp({create:{width:3600,height:3600,channels:3,background:'#fff'}}).png().toBuffer();
  const pdf=await PDFDocument.create({updateMetadata:false}),page=pdf.addPage([72,72]),image=await pdf.embedPng(png);
  page.drawImage(image,{x:0,y:0,width:12,height:12});
  const renderer=new PdfRenderer({deadlineAt:performance.now()+30000});
  try {
    await renderer.open(Buffer.from(await pdf.save({useObjectStreams:false})),{dpi:72,pages:[1]});
    await assert.rejects(renderer.render(1),error=>error.code==='pdf_render_failed');
  } finally {await renderer.close();}
});

test('HTTP accepts raw and multipart PDFs and reports page count, exact selection, transforms, and rendered-pixel coordinates',async()=>{
  const pdf=await readFile(fixture),calls=[];
  const engine={recognize:async(image,options)=>{
    const meta=await sharp(image).metadata();calls.push({width:meta.width,height:meta.height,options});
    return resultFor(meta.width,meta.height,`PAGE ${calls.length}`);
  }};
  const app=await start(engine);
  try {
    const response=await postPdf(app,pdf,'pdf_dpi=72&pdf_pages=1,3');
    assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual(body.source,{type:'pdf',page_count:3,selected_pages:[1,3],processed_pages:2,dpi:72,total_rendered_pixels:1_003_664,coordinate_space:'rendered_page_pixels'});
    assert.equal(body.text,'PAGE 1\n\f\nPAGE 2');assert.deepEqual(body.pages.map(page=>page.page_number),[1,3]);
    assert.deepEqual(body.pages.map(page=>page.rendered),[{width:596,height:842,dpi:72},{width:842,height:596,dpi:72}]);
    assert.equal(body.pages[0].status,'success');assert.equal(body.pages[0].coordinate_space,'rendered_page_pixels');
    assert.equal(body.pages[0].result.coordinate_space,'rendered_page_pixels');assert.equal(body.pages[0].result.request_id,body.request_id);
    assert.deepEqual(body.pages[1].source_page.rotation,90);assert.ok(Array.isArray(body.pages[1].pdf_user_space_to_rendered_pixels));
    for(const page of body.pages) {
      const view=page.source_page.view,point=[(view[0]+view[2])/2,(view[1]+view[3])/2];
      const rendered=applyTransform(page.pdf_user_space_to_rendered_pixels,point);
      const roundTrip=applyTransform(page.rendered_pixels_to_pdf_user_space,rendered);
      assert.ok(Math.abs(roundTrip[0]-point[0])<1e-6&&Math.abs(roundTrip[1]-point[1])<1e-6);
    }
    assert.equal(calls.length,2);assert.ok(calls.every(call=>call.options.signal instanceof AbortSignal));
    const form=new FormData();form.set('file',new Blob([pdf],{type:'application/pdf'}),'invoice.pdf');
    const multipart=await fetch(`${app.url}/v1/ocr`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form});
    assert.equal(multipart.status,200);const multipartBody=await multipart.json();assert.equal(multipartBody.source.page_count,3);assert.equal(multipartBody.pages.length,3);
    assert.equal(calls.length,5,'pages are rendered and OCRed sequentially, with no page silently dropped');
    const prefixed=await postPdf(app,Buffer.concat([Buffer.from('\n%'),pdf]),'pdf_pages=1&pdf_dpi=72');
    assert.equal(prefixed.status,200,'PDF.js accepts a valid header within the first 1024 bytes');
  } finally {await app.close();}
});

test('PDF validation errors are explicit and happen before OCR',async()=>{
  let calls=0;const app=await start({recognize:async()=>{calls++;return resultFor(10,10);}});
  try {
    for(const [pdf,query,status,code] of [
      [Buffer.from('%PDF-1.7\nnot a document'),'','400','invalid_pdf'],
      [Buffer.from('not a pdf'),'','400','invalid_pdf'],
      [await readFile(fixture),'pdf_pages=4','422','pdf_page_selection'],
      [await readFile(fixture),'pdf_dpi=301','422','invalid_options'],
    ]) {
      const response=await postPdf(app,pdf,query);assert.equal(response.status,Number(status));assert.equal((await response.json()).error,code);
    }
    const image=await postPdf(app,Buffer.from('image bytes'),'pdf_pages=1',{'content-type':'image/png',authorization:`Bearer ${key}`});
    assert.equal(image.status,422);assert.equal((await image.json()).error,'invalid_options');
    assert.equal(calls,0);
  } finally {await app.close();}
});

test('PDF and Needle schema failures are rejected before OCR; extraction is applied per selected page',async()=>{
  let calls=0,extracts=0;const schema={type:'object',properties:{invoice_number:{type:'string'}},required:['invoice_number'],additionalProperties:false};
  const engine={recognize:async(image)=>{calls++;const meta=await sharp(image).metadata();return resultFor(meta.width,meta.height,`page${calls}`);},
    extractJson:async(text)=>{extracts++;return {status:'success',data:{invoice_number:text},schema_validation:'valid',output_validation:'valid'};}};
  const app=await start(engine),pdf=await readFile(fixture);
  try {
    const badSchema=new FormData();badSchema.set('file',new Blob([pdf],{type:'application/pdf'}),'x.pdf');badSchema.set('schema','{"type":"object","properties":{},"$ref":"https://example.invalid"}');
    const invalid=await fetch(`${app.url}/v1/ocr?extract=needle`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:badSchema});
    assert.equal(invalid.status,422);assert.equal((await invalid.json()).error,'unsupported_schema');assert.equal(calls,0);
    const form=new FormData();form.set('file',new Blob([pdf],{type:'application/pdf'}),'x.pdf');form.set('schema',JSON.stringify(schema));form.set('instruction','Read invoice number');
    const response=await fetch(`${app.url}/v1/ocr?extract=needle&pdf_pages=1-2`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form});
    assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.pages.map(page=>page.result.extraction.data.invoice_number),['page1','page2']);
    assert.equal(extracts,2);assert.equal(calls,2);
  } finally {await app.close();}
});

test('PDF renderer admits one document and a failed page never returns a partial success',async()=>{
  const entered=deferred(),release=deferred();let calls=0;
  const app=await start({recognize:async(image)=>{calls++;const meta=await sharp(image).metadata();if(calls===1){entered.resolve();await release.promise;}return resultFor(meta.width,meta.height);}});
  const pdf=await readFile(fixture);
  try {
    const first=postPdf(app,pdf);await entered.promise;
    const second=await postPdf(app,pdf);assert.equal(second.status,503);assert.equal((await second.json()).error,'pdf_renderer_busy');
    release.resolve();assert.equal((await first).status,200);
  } finally {release.resolve();await app.close();}

  const failing=await start({recognize:async(image)=>{const meta=await sharp(image).metadata();if(++calls===4)throw new Error('private OCR failure');return resultFor(meta.width,meta.height);}});
  try {
    const response=await postPdf(failing,pdf);assert.equal(response.status,500);const body=await response.json();assert.equal(body.error,'internal_error');assert.equal(Object.hasOwn(body,'pages'),false);
  } finally {await failing.close();}
});

test('known image MIME stays on image OCR even when PNG metadata contains a PDF marker',async()=>{
  const base=await sharp({create:{width:40,height:40,channels:3,background:'#fff'}}).png().toBuffer();
  const marker=Buffer.from('ImageDescription\0contains %PDF-1.7 marker');
  const chunk=Buffer.alloc(12+marker.length);chunk.writeUInt32BE(marker.length,0);chunk.write('tEXt',4,'ascii');marker.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'),marker])),8+marker.length);
  const png=Buffer.concat([base.subarray(0,base.length-12),chunk,base.subarray(base.length-12)]);
  assert.equal((await sharp(png).metadata()).format,'png');assert.ok(png.subarray(0,1024).includes(Buffer.from('%PDF-1.7')));
  const inputs=[],app=await start({recognize:async(input)=>{inputs.push(input);return resultFor(40,40,'image');}});
  try {
    const raw=await fetch(`${app.url}/v1/ocr`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'image/png'},body:png});
    assert.equal(raw.status,200);assert.equal((await raw.json()).text,'image');assert.ok(inputs[0].equals(png));
    const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'metadata.png');
    const multipart=await fetch(`${app.url}/v1/ocr`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form});
    assert.equal(multipart.status,200);assert.ok(inputs[1].equals(png));assert.equal(inputs.length,2);
  } finally {await app.close();}
});

test('real HTTP PDF invoice passes through PDF rasterization and the pinned OneOCR model',async()=>{
  const {OcrEngine}=await import('../src/index.mjs');
  const engine=await OcrEngine.create({modelPath:join(root,'models'),layoutModelPath:join(root,'models/deepdoc-layout.onnx'),needleModelPath:join(root,'models/needle3.cact'),threads:2});
  const app=await start(engine);
  try {
    const pdf=await readFile(fixture),response=await postPdf(app,pdf,'pdf_pages=1');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.source.page_count,3);assert.deepEqual(body.source.selected_pages,[1]);
    assert.equal(body.pages[0].result.text,'ONEOCR PDF PAGE 1\nINVOICE NUMBER: INV-042\nTOTAL: 1250.00 USD');
    assert.equal(body.pages[0].result.width,1241);assert.equal(body.pages[0].result.height,1754);
    assert.equal(body.pages[0].result.coordinate_space,'rendered_page_pixels');
    const form=new FormData(),schema={type:'object',properties:{invoice_number:{type:'string'},currency:{type:'string'}},required:['invoice_number','currency'],additionalProperties:false};
    form.set('file',new Blob([pdf],{type:'application/pdf'}),'invoice.pdf');form.set('schema',JSON.stringify(schema));form.set('instruction','Extract the invoice number and currency exactly as printed.');
    const extracted=await fetch(`${app.url}/v1/ocr?extract=needle&pdf_pages=1`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form});
    assert.equal(extracted.status,200);const extractedBody=await extracted.json();
    assert.equal(extractedBody.pages[0].result.extraction.status,'success');
    assert.deepEqual(extractedBody.pages[0].result.extraction.data,{invoice_number:'INV-042',currency:'USD'});
    const layout=await postPdf(app,pdf,'layout=deepdoc&max_dimension=1500&padding=4&pdf_pages=1');
    assert.equal(layout.status,200);const layoutBody=await layout.json(),layoutPage=layoutBody.pages[0];
    assert.equal(layoutPage.result.preprocessing.coordinate_space,'rendered_page_pixels');
    assert.deepEqual(layoutPage.result.preprocessing.source_dimensions,{width:1241,height:1754});
    assert.equal(layoutPage.result.layout.coordinate_space,'rendered_page_pixels');
    assert.ok(layoutPage.result.layout.regions.every(region=>region.coordinate_space==='rendered_page_pixels'));
  } finally {await app.close();await engine.close();}
});

function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;}
  return (crc^0xffffffff)>>>0;
}

function applyTransform([a,b,c,d,e,f],[x,y]) {return [a*x+c*y+e,b*x+d*y+f];}
