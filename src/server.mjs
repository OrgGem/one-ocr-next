import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {OcrEngine} from './index.mjs';
import {HttpError,authorized,imageInput,integer,ocrOptions,readBody,serviceConfig} from './http.mjs';

const ocrPaths=new Set(['/v1/ocr','/api/v1/ocr','/ocr','/']);
const readinessPaths=new Set(['/health','/api/health','/health/ready']);
const defaultLogger=record=>console.error(JSON.stringify(record));

export async function serve(options={}) {
  const config={...serviceConfig(),...options};
  for(const [name,min,max] of [['port',0,65535],['threads',1,16],['maxBodyBytes',1,100*1024*1024],['maxPending',1,64],['requestTimeoutMs',10,600000],['shutdownTimeoutMs',10,660000],['maxPixels',4,100_000_000]])config[name]=integer(config[name],name,min,max);
  if(typeof config.apiKey!=='string'||(config.apiKey.length>0&&config.apiKey.length<32))throw new RangeError('API key must contain at least 32 characters');
  const {modelPath,host,port,threads,maxBodyBytes,maxPending,requestTimeoutMs,shutdownTimeoutMs,maxPixels,apiKey}=config;
  const logger=config.logger??defaultLogger;
  const spec=JSON.parse(await readFile(new URL('../docs/openapi.json',import.meta.url),'utf8'));
  const providedEngine=config.engine,engine=providedEngine??await OcrEngine.create({modelPath,threads});
  let ready=true,pending=0,closing;
  const active=new Set();
  const emit=record=>{try{logger(record);}catch{/* logging must not interrupt request cleanup */}};
  const server=createServer(async(request,response)=>{
    request.on('error',()=>{});
    const requestId=randomUUID(),started=performance.now();
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
        model_sha256:engine.bundle.sourceSha256,pending,max_pending:maxPending,version:'0.2.0'});return;
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
    try {
      const ocr=ocrOptions(url.searchParams);
      const length=request.headers['content-length'];
      if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBodyBytes))throw new HttpError(413,'image_too_large','Request body exceeds the configured limit');
      const body=await readBody(request,maxBodyBytes,controller.signal);
      const input=await imageInput(body,request.headers['content-type']);
      if(controller.signal.aborted)throw controller.signal.reason;
      const result=await engine.recognize(input,{...ocr,maxPixels,signal:controller.signal});
      if(controller.signal.aborted)throw controller.signal.reason;
      json(200,{...result,request_id:requestId});
    } catch(error) {
      if(error instanceof HttpError)fail(error.status,error.code,error.message);
      else if(error instanceof RangeError)fail(422,'invalid_image',error.message);
      else if(/unsupported image|corrupt|invalid image|image dimensions|input buffer|input file|heif|tiff|jpeg|png|vips|pixel limit/i.test(error.message))fail(400,'invalid_image','Unable to decode the supplied image');
      else {emit({event:'ocr_error',request_id:requestId,name:error.name});fail(500,'internal_error','OCR processing failed');}
      request.resume();
    } finally {
      clearTimeout(timeout);response.off('close',disconnect);active.delete(controller);pending--;
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

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const app=await serve();
    const stop=()=>{app.close().catch(error=>{console.error(JSON.stringify({event:'shutdown_failed',name:error.name}));process.exitCode=1;});};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  } catch(error){console.error(JSON.stringify({event:'startup_failed',message:error.message}));process.exitCode=1;}
}
