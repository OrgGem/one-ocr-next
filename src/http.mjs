import {createHash,timingSafeEqual} from 'node:crypto';
import {resolveScript} from './models.mjs';

export class HttpError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}

export function integer(value,name,min,max) {
  if(typeof value==='string'&&!/^\d+$/.test(value))throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max)throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

export function authorized(header,key) {
  if(!key)return true;
  if(typeof header!=='string'||!header.startsWith('Bearer '))return false;
  const digest=value=>createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice(7)),digest(key));
}

export function ocrOptions(params) {
  const allowed=new Set(['language','script','max_lines','resize_long','resize_short','min_confidence','reject_low_quality']);
  for(const key of params.keys()) {
    if(!allowed.has(key))throw new HttpError(422,'invalid_options',`Unknown parameter: ${key}`);
    if(params.getAll(key).length!==1)throw new HttpError(422,'invalid_options',`Duplicate parameter: ${key}`);
  }
  if(params.has('language')&&params.has('script'))throw new HttpError(422,'invalid_options','Supply language or script, not both');
  const options={language:params.get('language')??params.get('script')??'auto'};
  try {
    resolveScript(options.language);
    for(const [query,key,min,max] of [['max_lines','maxLines',0,1000],['resize_long','resizeLong',32,1152],['resize_short','resizeShort',32,768]]) {
      if(params.has(query))options[key]=integer(params.get(query),query,min,max);
    }
    if(params.has('min_confidence')) {
      const value=params.get('min_confidence');
      if(!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value))throw new RangeError('min_confidence must be from 0 to 1');
      options.minConfidence=Number(value);
    }
    if(params.has('reject_low_quality')) {
      const value=params.get('reject_low_quality');
      if(!['true','false'].includes(value))throw new RangeError('reject_low_quality must be true or false');
      options.rejectLowQuality=value==='true';
    }
  } catch(error){throw new HttpError(422,'invalid_options',error.message);}
  return options;
}

export function readBody(request,limit,signal) {
  return new Promise((resolve,reject)=>{
    let length=0;const chunks=[];
    const cleanup=()=>{request.off('data',data);request.off('end',end);request.off('error',error);request.off('aborted',aborted);signal.removeEventListener('abort',aborted);};
    const error=cause=>{cleanup();reject(cause);};
    const aborted=()=>error(signal.reason??new HttpError(400,'request_aborted','Request aborted'));
    const end=()=>{cleanup();resolve(Buffer.concat(chunks,length));};
    const data=chunk=>{length+=chunk.length;if(length>limit){error(new HttpError(413,'image_too_large','Request body exceeds the configured limit'));request.resume();}else chunks.push(chunk);};
    if(signal.aborted){aborted();return;}
    request.on('data',data);request.once('end',end);request.once('error',error);request.once('aborted',aborted);
    signal.addEventListener('abort',aborted,{once:true});
  });
}

export async function imageInput(body,contentType) {
  if(!body.length)throw new HttpError(400,'empty_image','Supply a non-empty image');
  const mime=String(contentType??'').split(';')[0].trim().toLowerCase();
  if(mime==='multipart/form-data') {
    let form;
    try {form=await new Request('http://localhost',{method:'POST',headers:{'content-type':contentType},body}).formData();}
    catch {throw new HttpError(400,'invalid_multipart','Malformed multipart body or missing boundary');}
    const files=[];
    for(const [name,value] of form.entries()) {
      if(!['file','image'].includes(name)||typeof value.arrayBuffer!=='function')throw new HttpError(400,'invalid_multipart','Supply one image in the file or image field');
      files.push(value);
    }
    if(files.length!==1||files[0].size===0)throw new HttpError(400,'invalid_multipart','Supply exactly one non-empty image');
    return Buffer.from(await files[0].arrayBuffer());
  }
  if(!['image/png','image/jpeg','image/webp','image/tiff','image/bmp','image/gif','application/octet-stream'].includes(mime)) {
    throw new HttpError(415,'unsupported_media_type','Use a supported image MIME type, application/octet-stream or multipart/form-data');
  }
  return body;
}

export function serviceConfig(env=process.env) {
  return {
    modelPath:env.ONEOCR_MODEL_PATH??'models',host:env.ONEOCR_HOST??'127.0.0.1',
    port:integer(env.ONEOCR_PORT??8001,'port',0,65535),
    threads:integer(env.ONEOCR_THREADS??2,'threads',1,16),apiKey:env.ONEOCR_API_KEY??'',
    maxBodyBytes:integer(env.ONEOCR_MAX_BODY_BYTES??20*1024*1024,'maxBodyBytes',1,100*1024*1024),
    maxPending:integer(env.ONEOCR_MAX_PENDING??8,'maxPending',1,64),
    requestTimeoutMs:integer(env.ONEOCR_REQUEST_TIMEOUT_MS??60000,'requestTimeoutMs',10,600000),
    shutdownTimeoutMs:integer(env.ONEOCR_SHUTDOWN_TIMEOUT_MS??65000,'shutdownTimeoutMs',10,660000),
    maxPixels:integer(env.ONEOCR_MAX_PIXELS??40_000_000,'maxPixels',4,100_000_000)
  };
}
