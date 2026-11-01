import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {OcrEngine} from './index.mjs';
import {HttpError,authorized,imageInput,integer,ocrOptions,readBody,serviceConfig,CAPTCHA_PREPROCESS_QUERY_KEYS} from './http.mjs';
import {CaptchaError,CAPTCHA_MODEL,CAPTCHA_CHARSET,CAPTCHA_RUNTIME,CAPTCHA_MAX_INPUT_BYTES,CAPTCHA_MAX_INPUT_PIXELS} from './captcha-extractor.mjs';
import {ExtractionSchemaError,parseNeedleSchema} from './needle-schema.mjs';
import {NEEDLE_MODEL,NEEDLE_MAX_INSTRUCTION_BYTES,NEEDLE_MAX_OUTPUT_TOKENS,NEEDLE_RUNTIME} from './needle-extractor.mjs';
import {PdfRenderer} from './pdf-renderer.mjs';
import {PdfInputError,PDF_DEFAULT_DPI,PDF_MAX_PAGE_PIXELS,PDF_MAX_TOTAL_PIXELS} from './pdf-options.mjs';

const ocrPaths=new Set(['/v1/ocr','/api/v1/ocr','/ocr','/']);
const readinessPaths=new Set(['/health','/api/health','/health/ready']);
const defaultLogger=record=>console.error(JSON.stringify(record));

export async function serve(options={}) {
  const config={...serviceConfig(),...options};
  for(const [name,min,max] of [['port',0,65535],['threads',1,16],['maxBodyBytes',1,100*1024*1024],['maxPending',1,64],['requestTimeoutMs',10,600000],['extractionTimeoutMs',10,600000],['shutdownTimeoutMs',10,660000],['maxPixels',4,100_000_000]])config[name]=integer(config[name],name,min,max);
  if(typeof config.apiKey!=='string'||(config.apiKey.length>0&&config.apiKey.length<32))throw new RangeError('API key must contain at least 32 characters');
  const {modelPath,layoutModelPath,needleModelPath,captchaModelPath,captchaCharsetPath,host,port,threads,maxBodyBytes,maxPending,requestTimeoutMs,extractionTimeoutMs,shutdownTimeoutMs,maxPixels,apiKey}=config;
  const logger=config.logger??defaultLogger;
  const spec=JSON.parse(await readFile(new URL('../docs/openapi.json',import.meta.url),'utf8'));
  const providedEngine=config.engine,engine=providedEngine??await OcrEngine.create({modelPath,layoutModelPath,needleModelPath,captchaModelPath,captchaCharsetPath,threads});
  let ready=true,pending=0,extractionPending=0,pdfPending=0,captchaPending=0,closing;
  const active=new Set();
  const emit=record=>{try{logger(record);}catch{/* logging must not interrupt request cleanup */}};
  const server=createServer(async(request,response)=>{
    request.on('error',()=>{});
    const requestId=randomUUID(),started=performance.now(),deadlineAt=started+requestTimeoutMs;
    response.setHeader('x-request-id',requestId);response.setHeader('x-content-type-options','nosniff');
    response.once('finish',()=>emit({event:'request',request_id:requestId,method:request.method,status:response.statusCode,duration_ms:Math.round(performance.now()-started)}));
    const json=(status,value)=>{
      if(response.destroyed||response.writableEnded)return;
      response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      response.end(JSON.stringify(value));
    };
    const fail=(status,error,message)=>{
      if(response.destroyed||response.writableEnded)return;
      response.setHeader('connection','close');
      json(status,{error,message,request_id:requestId});
    };
    let url;
    try{url=new URL(request.url,'http://localhost');}
    catch{fail(400,'invalid_url','Invalid request URL');request.resume();return;}
    if(request.method==='GET'&&url.pathname==='/health/live'){json(200,{status:'alive'});return;}
    if(request.method==='GET'&&readinessPaths.has(url.pathname)){
      json(ready?200:503,{status:ready?'ready':'closing',engine:'oneocr-native',platform:process.platform,
        model_sha256:engine.bundle.sourceSha256,semantic_layout_available:!!engine.layoutProvider,
        semantic_layout_provider:engine.layoutProvider?.metadata.provider??null,
        json_extraction_model_available:typeof needleModelPath==='string'&&existsSync(needleModelPath),json_extraction_provider:NEEDLE_RUNTIME.provider,
        extraction_pending:extractionPending,max_extraction_pending:1,pending,max_pending:maxPending,version:'0.2.0'});return;
    }
    if(request.method==='GET'&&url.pathname==='/openapi.json'){json(200,spec);return;}
    if(!ocrPaths.has(url.pathname)){fail(404,'not_found','Route not found');request.resume();return;}
    if(request.method!=='POST'){response.setHeader('allow','POST');fail(405,'method_not_allowed','Use POST for OCR');request.resume();return;}
    if(!authorized(request.headers.authorization,apiKey)){
      response.setHeader('www-authenticate','Bearer');fail(401,'unauthorized','A valid Bearer API key is required');request.resume();return;
    }
    if(!ready||pending>=maxPending){response.setHeader('retry-after','1');fail(503,'busy','OCR queue is full or service is closing; retry later');request.resume();return;}
    const controller=new AbortController();active.add(controller);pending++;
    const disconnect=()=>{if(!response.writableEnded)controller.abort(new HttpError(499,'client_disconnected','Client disconnected'));};
    response.once('close',disconnect);
    const timeout=setTimeout(()=>{
      controller.abort(new HttpError(504,'request_timeout','OCR request deadline exceeded'));
      fail(504,'request_timeout','OCR request deadline exceeded');request.resume();
    },requestTimeoutMs);timeout.unref();
    let extractionReserved=false,pdfReserved=false,captchaReserved=false;
    try {
      if(url.searchParams.get('extract')==='ddddocr') {
        for(const key of url.searchParams.keys())if(key!=='extract'&&!CAPTCHA_PREPROCESS_QUERY_KEYS.has(key))throw new HttpError(422,'ddddocr_options_unsupported','extract=ddddocr accepts only captcha_* preprocessing options');
      } else if([...url.searchParams.keys()].some(key=>key.startsWith('captcha_')))throw new HttpError(422,'captcha_options_unsupported','captcha_* options require extract=ddddocr');
      const ocr=ocrOptions(url.searchParams);
      if(ocr.extraction==='ddddocr') {
        if(captchaPending>=1){response.setHeader('retry-after','1');throw new HttpError(503,'captcha_busy','CAPTCHA recognition is busy; retry later');}
        captchaPending++;captchaReserved=true;
      }
      if(ocr.extraction==='needle') {
        if(extractionPending>=1)throw new HttpError(503,'extraction_busy','Needle extraction is busy; retry later');
        extractionPending++;extractionReserved=true;
      }
      if(ocr.layout==='deepdoc'&&!engine.layoutProvider)throw new HttpError(422,'layout_unavailable','Semantic layout requires ONEOCR_LAYOUT_MODEL_PATH to point to the pinned local DeepDoc ONNX model');
      const length=request.headers['content-length'];
      const bodyLimit=ocr.extraction==='ddddocr'?Math.min(maxBodyBytes,CAPTCHA_MAX_INPUT_BYTES):maxBodyBytes;
      const tooLargeCode=ocr.extraction==='ddddocr'?'captcha_image_too_large':'image_too_large';
      if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>bodyLimit))throw new HttpError(413,tooLargeCode,'Request body exceeds the configured limit');
      const body=await readBody(request,bodyLimit,controller.signal,{tooLargeCode});
      const input=await imageInput(body,request.headers['content-type'],{extract:ocr.extraction??false});
      const pdfRequest=!!(input&&typeof input==='object'&&!Buffer.isBuffer(input)&&Object.hasOwn(input,'pdf'));
      if(ocr.extraction==='ddddocr'&&pdfRequest)throw new HttpError(422,'ddddocr_requires_image','extract=ddddocr accepts an image, not a PDF');
      if(ocr.pdf&&!pdfRequest)throw new HttpError(422,'invalid_options','pdf_dpi and pdf_pages can only be used with a PDF request');
      if(pdfRequest) {
        if(pdfPending>=1){response.setHeader('retry-after','1');throw new HttpError(503,'pdf_renderer_busy','A PDF is already being rendered; retry later');}
        pdfPending++;pdfReserved=true;
      }
      let schema;
      if(ocr.extraction==='needle') {
        if(Buffer.byteLength(input.instruction,'utf8')>NEEDLE_MAX_INSTRUCTION_BYTES)throw new HttpError(422,'instruction_too_large','Instruction exceeds the 1 KiB limit');
        try{schema=parseNeedleSchema(input.schemaText);}
        catch(error){if(error instanceof ExtractionSchemaError)throw new HttpError(422,error.code,error.message);throw error;}
      }
      if(controller.signal.aborted)throw controller.signal.reason;
      const {pdf:pdfOptions,...engineOptions}=ocr;
      const responseBody=ocr.extraction==='ddddocr'
        ?await recognizeCaptcha({input,engine,maxPixels,captchaPreprocess:ocr.captchaPreprocess,requestId,controller,deadlineAt})
        :pdfRequest
          ?await recognizePdf({input:input.pdf,pdfOptions:pdfOptions??{dpi:PDF_DEFAULT_DPI,pages:null},engine,engineOptions,schema,instruction:input.instruction,maxPixels,requestId,controller,deadlineAt,extractionTimeoutMs,emit})
          :await recognizeImage({input:ocr.extraction==='needle'?input.image:input,engine,engineOptions,schema,instruction:input.instruction,maxPixels,requestId,controller,deadlineAt,extractionTimeoutMs,emit});
      assertRequestActive(controller,deadlineAt);
      json(200,responseBody);
    } catch(error) {
      if(error instanceof HttpError){if(error.status===503)response.setHeader('retry-after','1');fail(error.status,error.code,error.message);}
      else if(error instanceof CaptchaError){if(error.status===503)response.setHeader('retry-after','1');fail(error.status,error.code,error.message);}
      else if(error instanceof ExtractionSchemaError)fail(422,error.code,error.message);
      else if(error instanceof RangeError)fail(422,'invalid_image',error.message);
      else if(error.code==='request_timeout')fail(504,'request_timeout','OCR request deadline exceeded');
      else if(error.name==='PdfInputError')fail(error.status,error.code,error.message);
      else if(error.code==='invalid_pdf'||(error.code&&error.code.startsWith('pdf_')))fail(pdfErrorStatus(error.code),error.code,pdfErrorMessage(error.code));
      else if(/unsupported image|corrupt|invalid image|image dimensions|input buffer|input file|heif|tiff|jpeg|png|vips|pixel limit/i.test(error.message))fail(400,'invalid_image','Unable to decode the supplied image');
      else {emit({event:'ocr_error',request_id:requestId,name:error.name});fail(500,'internal_error','OCR processing failed');}
      request.resume();
    } finally {
      clearTimeout(timeout);response.off('close',disconnect);active.delete(controller);pending--;if(extractionReserved)extractionPending--;if(pdfReserved)pdfPending--;if(captchaReserved)captchaPending--;
    }
  });
  server.requestTimeout=requestTimeoutMs;server.headersTimeout=Math.min(15000,requestTimeoutMs);
  server.keepAliveTimeout=5000;server.maxConnections=128;server.maxRequestsPerSocket=100;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});}
  catch(error){if(!providedEngine)await engine.close();throw error;}
  const address=server.address(),origin=`http://${host.includes(':')?'['+host+']':host}:${address.port}`;
  emit({event:'listening',host,port:address.port,auth_enabled:!!apiKey,model_sha256:engine.bundle.sourceSha256});
  return {server,engine,url:origin,close:()=>{
    if(closing)return closing;
    ready=false;
    closing=(async()=>{
      const stopped=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
      const timer=setTimeout(()=>{
        for(const controller of active)controller.abort(new HttpError(503,'shutting_down','Service is shutting down'));
        server.closeAllConnections();
      },shutdownTimeoutMs);timer.unref();
      try{await stopped;if(!providedEngine)await engine.close();}
      finally{clearTimeout(timer);}
    })();
    return closing;
  }};
}

function extractionUnavailable(code) {
  return {provider:NEEDLE_RUNTIME.provider,model:{name:NEEDLE_MODEL.name,revision:NEEDLE_MODEL.revision,sha256:NEEDLE_MODEL.sha256,runtime:NEEDLE_RUNTIME.package,runtime_version:NEEDLE_RUNTIME.version},schema_validation:'valid',output_validation:'not_run',status:'unavailable',error:{code},elapsed_ms:0};
}

async function recognizeCaptcha({input,engine,maxPixels,captchaPreprocess,requestId,controller,deadlineAt}) {
  assertRequestActive(controller,deadlineAt);
  if(typeof engine.extractCaptcha!=='function')throw new CaptchaError(503,'captcha_unavailable','CAPTCHA recognition is unavailable');
  const result=await engine.extractCaptcha(input,{signal:controller.signal,deadlineAt,maxPixels:Math.min(maxPixels,CAPTCHA_MAX_INPUT_PIXELS),captchaPreprocess});
  assertRequestActive(controller,deadlineAt);
  return {request_id:requestId,text:result.text,extraction:{
    provider:'ddddocr-onnxruntime',
    model:{name:CAPTCHA_MODEL.name,revision:CAPTCHA_MODEL.revision,sha256:CAPTCHA_MODEL.sha256,charset_sha256:CAPTCHA_CHARSET.sha256},
    runtime:{package:CAPTCHA_RUNTIME.package,version:CAPTCHA_RUNTIME.version,execution_provider:CAPTCHA_RUNTIME.executionProvider},
    status:result.status,input:result.input,elapsed_ms:result.elapsed_ms,...(result.preprocessing?{preprocessing:result.preprocessing}:{})
  }};
}

async function recognizeImage({input,engine,engineOptions,schema,instruction,maxPixels,requestId,controller,deadlineAt,extractionTimeoutMs,emit}) {
  const result=await engine.recognize(input,{...engineOptions,maxPixels,signal:controller.signal,deadlineAt});
  assertRequestActive(controller,deadlineAt);
  const responseBody={...result,request_id:requestId};
  if(engineOptions.extraction==='needle')responseBody.extraction=await extractNeedle(engine,result.text,schema,instruction,controller,deadlineAt,extractionTimeoutMs,emit,requestId);
  assertRequestActive(controller,deadlineAt);
  return responseBody;
}

async function recognizePdf({input,pdfOptions,engine,engineOptions,schema,instruction,maxPixels,requestId,controller,deadlineAt,extractionTimeoutMs,emit}) {
  const renderer=new PdfRenderer({signal:controller.signal,deadlineAt});
  try {
    let opened;
    try{opened=await renderer.open(input,pdfOptions);}
    catch(error){if(error.code==='pdf_renderer_timeout'){throw new HttpError(504,'request_timeout','OCR request deadline exceeded');}throw error;}
    if(!Number.isSafeInteger(opened.totalPixels)||opened.totalPixels>PDF_MAX_TOTAL_PIXELS)throw new HttpError(422,'pdf_total_pixel_limit',`Selected PDF pages exceed the ${PDF_MAX_TOTAL_PIXELS} total pixel limit`);
    const pages=[];
    for(const pageInfo of opened.pages) {
      assertRequestActive(controller,deadlineAt);
      const rendered=await renderer.render(pageInfo.pageNumber);
      const result=await engine.recognize(rendered.png,{...engineOptions,maxPixels:Math.min(maxPixels,PDF_MAX_PAGE_PIXELS),signal:controller.signal,deadlineAt});
      assertRequestActive(controller,deadlineAt);
      if(result.width!==pageInfo.width||result.height!==pageInfo.height)throw new HttpError(422,'pdf_ocr_geometry_mismatch','OCR dimensions differ from the rendered PDF page');
      const pageResult=useRenderedPixelCoordinates(result);
      pageResult.request_id=requestId;
      if(engineOptions.extraction==='needle')pageResult.extraction=await extractNeedle(engine,pageResult.text,schema,instruction,controller,deadlineAt,extractionTimeoutMs,emit,requestId);
      assertRequestActive(controller,deadlineAt);
      pages.push({page_number:pageInfo.pageNumber,status:'success',source_page:{view:pageInfo.sourceView,user_unit:pageInfo.userUnit,rotation:pageInfo.rotation},
        rendered:{width:pageInfo.width,height:pageInfo.height,dpi:pdfOptions.dpi},coordinate_space:'rendered_page_pixels',
        pdf_user_space_to_rendered_pixels:pageInfo.transform,rendered_pixels_to_pdf_user_space:invertPdfTransform(pageInfo.transform),result:pageResult});
    }
    assertRequestActive(controller,deadlineAt);
    return {request_id:requestId,source:{type:'pdf',page_count:opened.pageCount,selected_pages:opened.pages.map(page=>page.pageNumber),processed_pages:pages.length,
      dpi:pdfOptions.dpi,total_rendered_pixels:opened.totalPixels,coordinate_space:'rendered_page_pixels'},
      text:pages.map(page=>page.result.text).join('\n\f\n'),pages};
  } finally {await renderer.close();}
}

async function extractNeedle(engine,text,schema,instruction,controller,deadlineAt,extractionTimeoutMs,emit,requestId) {
  const remainingMs=deadlineAt-performance.now();
  if(remainingMs<=0){const error=new HttpError(504,'request_timeout','OCR request deadline exceeded');controller.abort(error);throw error;}
  const extractionController=new AbortController();
  const extractionTimer=setTimeout(()=>extractionController.abort(new HttpError(504,'extraction_timeout','Needle extraction deadline exceeded')),
    Math.max(1,Math.min(extractionTimeoutMs,remainingMs)));
  extractionTimer.unref();
  try {
    if(typeof engine.extractJson!=='function')return extractionUnavailable('extractor_unavailable');
    return await engine.extractJson(text,schema,{instruction,signal:AbortSignal.any([controller.signal,extractionController.signal]),maxNewTokens:NEEDLE_MAX_OUTPUT_TOKENS});
  } catch(error) {
    if(controller.signal.aborted)throw controller.signal.reason??error;
    if(error instanceof ExtractionSchemaError)throw new HttpError(422,error.code,error.message);
    emit({event:'needle_extraction_error',request_id:requestId,name:error.name});
    return extractionUnavailable(extractionController.signal.aborted?'extraction_timeout':'runtime_unavailable');
  } finally {clearTimeout(extractionTimer);}
}

function useRenderedPixelCoordinates(result) {
  const normalized={...result,coordinate_space:'rendered_page_pixels'};
  if(result.preprocessing)normalized.preprocessing={...result.preprocessing,coordinate_space:'rendered_page_pixels'};
  if(result.layout)normalized.layout={...result.layout,coordinate_space:'rendered_page_pixels',regions:result.layout.regions.map(region=>({...region,coordinate_space:'rendered_page_pixels'}))};
  return normalized;
}

function invertPdfTransform(transform) {
  const [a,b,c,d,e,f]=transform,det=a*d-b*c;
  if(![a,b,c,d,e,f,det].every(Number.isFinite)||Math.abs(det)<1e-12)throw new HttpError(422,'pdf_render_failed','PDF page has an invalid coordinate transform');
  return [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];
}

function assertRequestActive(controller,deadlineAt) {
  if(controller.signal.aborted)throw controller.signal.reason??new HttpError(499,'client_disconnected','Client disconnected');
  if(performance.now()>=deadlineAt){const error=new HttpError(504,'request_timeout','OCR request deadline exceeded');controller.abort(error);throw error;}
}

function pdfErrorStatus(code) {
  if(code==='pdf_renderer_timeout')return 504;
  if(code==='invalid_pdf')return 400;
  if(code==='pdf_renderer_busy')return 503;
  return 422;
}

function pdfErrorMessage(code) {
  const messages={pdf_password_required:'Encrypted PDFs are not supported; submit an unencrypted PDF',invalid_pdf:'Unable to read the supplied PDF',pdf_page_limit:'PDF selection exceeds the page limit; select at most 20 pages',
    pdf_page_selection:'PDF page selection is invalid or outside the document',pdf_page_pixel_limit:'A selected PDF page exceeds the render pixel limit',pdf_total_pixel_limit:'Selected PDF pages exceed the total render pixel limit',pdf_xfa_unsupported:'PDFs containing XFA forms are not supported',
    pdf_render_failed:'Unable to render a selected PDF page',pdf_renderer_timeout:'PDF rendering exceeded the request deadline',pdf_ocr_geometry_mismatch:'OCR dimensions differ from the rendered PDF page'};
  return messages[code]??'PDF processing failed';
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const app=await serve();
    const stop=()=>{app.close().catch(error=>{console.error(JSON.stringify({event:'shutdown_failed',name:error.name}));process.exitCode=1;});};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  } catch(error){console.error(JSON.stringify({event:'startup_failed',message:error.message}));process.exitCode=1;}
}
