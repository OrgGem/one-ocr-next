import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {OcrEngine} from './index.mjs';
import {HttpError,authorized,imageInput,integer,ocrOptions,readBody,serviceConfig} from './http.mjs';
import {ExtractionSchemaError,parseNeedleSchema} from './needle-schema.mjs';
import {NEEDLE_MODEL,NEEDLE_MAX_INSTRUCTION_BYTES,NEEDLE_MAX_OUTPUT_TOKENS,NEEDLE_RUNTIME} from './needle-extractor.mjs';

const ocrPaths=new Set(['/v1/ocr','/api/v1/ocr','/ocr','/']);
const readinessPaths=new Set(['/health','/api/health','/health/ready']);
const defaultLogger=record=>console.error(JSON.stringify(record));

export async function serve(options={}) {
  const config={...serviceConfig(),...options};
  for(const [name,min,max] of [['port',0,65535],['threads',1,16],['maxBodyBytes',1,100*1024*1024],['maxPending',1,64],['requestTimeoutMs',10,600000],['extractionTimeoutMs',10,600000],['shutdownTimeoutMs',10,660000],['maxPixels',4,100_000_000]])config[name]=integer(config[name],name,min,max);
  if(typeof config.apiKey!=='string'||(config.apiKey.length>0&&config.apiKey.length<32))throw new RangeError('API key must contain at least 32 characters');
  const {modelPath,layoutModelPath,needleModelPath,host,port,threads,maxBodyBytes,maxPending,requestTimeoutMs,extractionTimeoutMs,shutdownTimeoutMs,maxPixels,apiKey}=config;
  const logger=config.logger??defaultLogger;
  const spec=JSON.parse(await readFile(new URL('../docs/openapi.json',import.meta.url),'utf8'));
  const providedEngine=config.engine,engine=providedEngine??await OcrEngine.create({modelPath,layoutModelPath,needleModelPath,threads});
  let ready=true,pending=0,extractionPending=0,closing;
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
    let extractionReserved=false;
    try {
      const ocr=ocrOptions(url.searchParams);
      if(ocr.extraction==='needle') {
        if(extractionPending>=1)throw new HttpError(503,'extraction_busy','Needle extraction is busy; retry later');
        extractionPending++;extractionReserved=true;
      }
      if(ocr.layout==='deepdoc'&&!engine.layoutProvider)throw new HttpError(422,'layout_unavailable','Semantic layout requires ONEOCR_LAYOUT_MODEL_PATH to point to the pinned local DeepDoc ONNX model');
      const length=request.headers['content-length'];
      if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBodyBytes))throw new HttpError(413,'image_too_large','Request body exceeds the configured limit');
      const body=await readBody(request,maxBodyBytes,controller.signal);
      const input=await imageInput(body,request.headers['content-type'],{extract:ocr.extraction==='needle'});
      let schema;
      if(ocr.extraction==='needle') {
        if(Buffer.byteLength(input.instruction,'utf8')>NEEDLE_MAX_INSTRUCTION_BYTES)throw new HttpError(422,'instruction_too_large','Instruction exceeds the 1 KiB limit');
        try{schema=parseNeedleSchema(input.schemaText);}
        catch(error){if(error instanceof ExtractionSchemaError)throw new HttpError(422,error.code,error.message);throw error;}
      }
      if(controller.signal.aborted)throw controller.signal.reason;
      const image=ocr.extraction==='needle'?input.image:input;
      const result=await engine.recognize(image,{...ocr,maxPixels,signal:controller.signal,deadlineAt});
      if(controller.signal.aborted)throw controller.signal.reason;
      if(performance.now()>=deadlineAt) {
        const error=new HttpError(504,'request_timeout','OCR request deadline exceeded');controller.abort(error);throw error;
      }
      const responseBody={...result,request_id:requestId};
      if(ocr.extraction==='needle') {
        const remainingMs=deadlineAt-performance.now();
        if(remainingMs<=0){const error=new HttpError(504,'request_timeout','OCR request deadline exceeded');controller.abort(error);throw error;}
        const extractionController=new AbortController();
        const extractionTimer=setTimeout(()=>{
          const error=new HttpError(504,'extraction_timeout','Needle extraction deadline exceeded');
          extractionController.abort(error);
        },Math.max(1,Math.min(extractionTimeoutMs,remainingMs)));
        extractionTimer.unref();
        try {
          if(typeof engine.extractJson==='function') {
            responseBody.extraction=await engine.extractJson(result.text,schema,{instruction:input.instruction,signal:AbortSignal.any([controller.signal,extractionController.signal]),maxNewTokens:NEEDLE_MAX_OUTPUT_TOKENS});
          } else {
            responseBody.extraction=extractionUnavailable('extractor_unavailable');
          }
        } catch(error) {
          if(controller.signal.aborted)throw controller.signal.reason??error;
          if(error instanceof ExtractionSchemaError)throw new HttpError(422,error.code,error.message);
          emit({event:'needle_extraction_error',request_id:requestId,name:error.name});
          responseBody.extraction=extractionUnavailable('runtime_unavailable');
        } finally {clearTimeout(extractionTimer);}
        if(controller.signal.aborted)throw controller.signal.reason;
        if(performance.now()>=deadlineAt){const error=new HttpError(504,'request_timeout','OCR request deadline exceeded');controller.abort(error);throw error;}
      }
      json(200,responseBody);
    } catch(error) {
      if(error instanceof HttpError){if(error.status===503)response.setHeader('retry-after','1');fail(error.status,error.code,error.message);}
      else if(error instanceof ExtractionSchemaError)fail(422,error.code,error.message);
      else if(error instanceof RangeError)fail(422,'invalid_image',error.message);
      else if(error.code==='request_timeout')fail(504,'request_timeout','OCR request deadline exceeded');
      else if(/unsupported image|corrupt|invalid image|image dimensions|input buffer|input file|heif|tiff|jpeg|png|vips|pixel limit/i.test(error.message))fail(400,'invalid_image','Unable to decode the supplied image');
      else {emit({event:'ocr_error',request_id:requestId,name:error.name});fail(500,'internal_error','OCR processing failed');}
      request.resume();
    } finally {
      clearTimeout(timeout);response.off('close',disconnect);active.delete(controller);pending--;if(extractionReserved)extractionPending--;
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

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const app=await serve();
    const stop=()=>{app.close().catch(error=>{console.error(JSON.stringify({event:'shutdown_failed',name:error.name}));process.exitCode=1;});};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  } catch(error){console.error(JSON.stringify({event:'startup_failed',message:error.message}));process.exitCode=1;}
}
