import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

export const CAPTCHA_MODEL={
  name:'common_old.onnx',
  repository:'sml2h3/ddddocr',
  revision:'c40f56f95412e10bcb9bd0bd24411e92f896d238',
  file:'ddddocr/common_old.onnx',
  bytes:13_606_051,
  sha256:'b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68',
  license:'MIT',
};
export const CAPTCHA_CHARSET={
  name:'common_old-charset.json',
  bytes:57_249,
  entries:8_210,
  sha256:'342d871c34fd467420cd39b58a4624b505da53114e77a69b43b48b8a3ee1b24d',
  license:'MIT',
};
export const CAPTCHA_RUNTIME={package:'onnxruntime-node',version:'1.24.3',executionProvider:'cpu'};
export const CAPTCHA_MAX_INPUT_BYTES=8*1024*1024;
export const CAPTCHA_MAX_INPUT_PIXELS=4_000_000;
export const CAPTCHA_MAX_DIMENSION=4096;
export const CAPTCHA_MAX_NORMALIZED_WIDTH=512;
const CAPTCHA_HEIGHT=64;
const CAPTCHA_CLASSES=CAPTCHA_CHARSET.entries;
const CAPTCHA_MAX_STEPS=CAPTCHA_MAX_NORMALIZED_WIDTH/8;

export class CaptchaError extends Error {
  constructor(status,code,message){super(message);this.name='CaptchaError';this.status=status;this.code=code;}
}

export class DdddOcrExtractor {
  constructor({modelPath='models/common_old.onnx',charsetPath='models/common_old-charset.json',runtime=ort,imageProcessor=sharp}={}) {
    this.modelPath=modelPath;this.charsetPath=charsetPath;this.runtime=runtime;this.imageProcessor=imageProcessor;
    this.session=undefined;this.charset=undefined;this.sessionPromise=undefined;this.activePromise=undefined;this.closed=false;this.closePromise=undefined;
  }

  async extract(input,{signal,deadlineAt,maxPixels=CAPTCHA_MAX_INPUT_PIXELS}={}) {
    if(this.closed)throw new CaptchaError(503,'captcha_unavailable','CAPTCHA recognition is unavailable');
    if(this.activePromise)throw new CaptchaError(503,'captcha_busy','CAPTCHA recognition is busy; retry later');
    const work=this.#extract(input,{signal,deadlineAt,maxPixels});
    this.activePromise=work;
    try{return await work;}
    finally{if(this.activePromise===work)this.activePromise=undefined;}
  }

  async #extract(input,{signal,deadlineAt,maxPixels}) {
    const started=performance.now(),request={signal,deadlineAt};
    assertActive(request);
    if(!(input instanceof Uint8Array)||input.byteLength===0)throw new CaptchaError(400,'invalid_image','Supply one non-empty image');
    if(input.byteLength>CAPTCHA_MAX_INPUT_BYTES)throw new CaptchaError(413,'captcha_image_too_large','CAPTCHA image exceeds the 8 MiB limit');
    const {width,height,normalizedWidth,tensor}=await this.#preprocess(input,{...request,maxPixels});
    assertActive(request);
    const {session,charset}=await this.#getSession(request);
    assertActive(request);
    let outputs;
    try {
      outputs=await session.run({[session.inputNames[0]]:new this.runtime.Tensor('float32',tensor,[1,1,CAPTCHA_HEIGHT,normalizedWidth])});
    } catch {throw new CaptchaError(502,'captcha_inference_failed','CAPTCHA inference failed');}
    // ONNX Runtime cannot interrupt a native run. Keep this request's slot until
    // run() settles, then discard the result if the shared HTTP deadline expired.
    assertActive(request);
    const output=outputs?.[session.outputNames[0]];
    const text=decodeOutput(output,charset,normalizedWidth);
    return {text,status:text?'success':'no_match',input:{width,height,normalized_width:normalizedWidth},elapsed_ms:performance.now()-started};
  }

  async #preprocess(input,{signal,deadlineAt,maxPixels}) {
    const inputLimit=Math.min(CAPTCHA_MAX_INPUT_PIXELS,maxPixels);
    let metadata;
    try{metadata=await this.imageProcessor(input,{failOn:'error'}).metadata();}
    catch {throw new CaptchaError(400,'invalid_image','Unable to decode the supplied image');}
    assertActive({signal,deadlineAt});
    const {width,height}=metadata;
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<2||height<2||width>CAPTCHA_MAX_DIMENSION||height>CAPTCHA_MAX_DIMENSION||width*height>inputLimit) {
      throw new CaptchaError(422,'captcha_image_dimensions','CAPTCHA image dimensions exceed the supported limit');
    }
    const normalizedWidth=Math.floor(width*CAPTCHA_HEIGHT/height);
    if(!Number.isSafeInteger(normalizedWidth)||normalizedWidth<8||normalizedWidth>CAPTCHA_MAX_NORMALIZED_WIDTH) {
      throw new CaptchaError(422,'captcha_image_dimensions','CAPTCHA aspect ratio produces an unsupported normalized width');
    }
    let pixels;
    try {
      pixels=await this.imageProcessor(input,{limitInputPixels:inputLimit,failOn:'error'})
        .resize(normalizedWidth,CAPTCHA_HEIGHT,{fit:'fill',kernel:'lanczos3',fastShrinkOnLoad:false})
        .removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
    } catch {throw new CaptchaError(400,'invalid_image','Unable to decode the supplied image');}
    assertActive({signal,deadlineAt});
    const {data,info}=pixels;
    if(info.width!==normalizedWidth||info.height!==CAPTCHA_HEIGHT||info.channels!==3||data.length!==normalizedWidth*CAPTCHA_HEIGHT*3) {
      throw new CaptchaError(502,'captcha_image_processing_failed','Unable to normalize the CAPTCHA image');
    }
    const tensor=new Float32Array(normalizedWidth*CAPTCHA_HEIGHT);
    for(let from=0,to=0;to<tensor.length;to++,from+=3) {
      const luminance=(19595*data[from]+38470*data[from+1]+7471*data[from+2]+32768)>>16;
      tensor[to]=luminance/255;
    }
    return {width,height,normalizedWidth,tensor};
  }

  async #getSession(request) {
    assertActive(request);
    if(this.closed)throw new CaptchaError(503,'captcha_unavailable','CAPTCHA recognition is unavailable');
    if(this.session)return {session:this.session,charset:this.charset};
    if(!this.sessionPromise) {
      this.sessionPromise=this.#createSession().then(({session,charset})=>{
        this.session=session;this.charset=charset;return {session,charset};
      }).catch(error=>{this.sessionPromise=undefined;throw error;});
    }
    const loaded=await this.sessionPromise;
    assertActive(request);
    if(this.closed)throw new CaptchaError(503,'captcha_unavailable','CAPTCHA recognition is unavailable');
    return loaded;
  }

  async #createSession() {
    let session;
    try {
      await verifyAsset(this.modelPath,CAPTCHA_MODEL.bytes,CAPTCHA_MODEL.sha256);
      await verifyAsset(this.charsetPath,CAPTCHA_CHARSET.bytes,CAPTCHA_CHARSET.sha256);
      const charset=JSON.parse(await readFile(this.charsetPath,'utf8'));
      if(!validCharset(charset))throw new Error('invalid_charset');
      // This pinned graph declares its logits as [1,seqlen], while the actual
      // runtime tensor is [T,1,8210]. Validate the runtime tensor in decodeOutput.
      // This private CAPTCHA session uses error-only logging to silence the
      // pinned graph's known output-metadata mismatch warning; the engine's
      // normal OneOCR session keeps its own logging configuration.
      session=await this.runtime.InferenceSession.create(this.modelPath,{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1,logSeverityLevel:3});
      if(!validInputMetadata(session)||!validKnownOutputMetadata(session))throw new Error('unsupported_model_contract');
      return {session,charset};
    } catch {
      await session?.release().catch(()=>{});
      throw new CaptchaError(503,'captcha_unavailable','Pinned CAPTCHA model or charset is unavailable');
    }
  }

  async close() {
    if(this.closePromise)return this.closePromise;
    if(this.closed)return;
    this.closed=true;
    this.closePromise=(async()=>{
      await this.activePromise?.catch(()=>{});
      await this.sessionPromise?.catch(()=>{});
      const session=this.session;this.session=undefined;this.charset=undefined;
      if(session)await session.release();
    })();
    return this.closePromise;
  }
}

function decodeOutput(output,charset,inputWidth) {
  const dims=Array.isArray(output?.dims)?output.dims:Array.from(output?.dims??[]);
  const [steps,batch,classes]=dims;
  if(output?.type!=='float32'||dims.length!==3||batch!==1||classes!==CAPTCHA_CLASSES||!Number.isSafeInteger(steps)||steps<1||steps>CAPTCHA_MAX_STEPS||steps!==Math.ceil(inputWidth/8)) {
    throw new CaptchaError(502,'captcha_model_output_invalid','CAPTCHA model returned an unsupported tensor shape');
  }
  const logits=output.data;
  if(!(logits instanceof Float32Array)||logits.length!==steps*batch*classes)throw new CaptchaError(502,'captcha_model_output_invalid','CAPTCHA model returned an invalid logits buffer');
  const chars=[];let previous=-1;
  for(let step=0;step<steps;step++) {
    let bestIndex=0,bestValue=-Infinity;const offset=step*classes;
    for(let classIndex=0;classIndex<classes;classIndex++) {
      const value=logits[offset+classIndex];
      if(!Number.isFinite(value))throw new CaptchaError(502,'captcha_model_output_invalid','CAPTCHA model returned non-finite logits');
      if(value>bestValue){bestValue=value;bestIndex=classIndex;}
    }
    if(bestIndex!==previous&&bestIndex!==0)chars.push(charset[bestIndex]);
    previous=bestIndex;
  }
  return chars.join('');
}

function validCharset(value) {
  return Array.isArray(value)&&value.length===CAPTCHA_CHARSET.entries&&value[0]===''&&value.every((item,index)=>index===0?item==='':typeof item==='string'&&Array.from(item).length===1)&&new Set(value).size===CAPTCHA_CHARSET.entries;
}

function validInputMetadata(session) {
  if(session.inputNames?.length!==1||session.outputNames?.length!==1)return false;
  const input=session.inputMetadata?.[0];
  return input?.type==='float32'&&Array.isArray(input.shape)&&input.shape.length===4&&input.shape[0]===1&&input.shape[1]===1&&input.shape[2]===CAPTCHA_HEIGHT&&typeof input.shape[3]==='string';
}

function validKnownOutputMetadata(session) {
  const output=session.outputMetadata?.[0];
  return output?.type==='float32'&&Array.isArray(output.shape)&&output.shape.length===2&&output.shape[0]===1&&typeof output.shape[1]==='string';
}

async function verifyAsset(file,expectedBytes,expectedSha256) {
  const info=await stat(file);
  if(!info.isFile()||info.size!==expectedBytes)throw new Error('asset_size_mismatch');
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  if(hash.digest('hex')!==expectedSha256)throw new Error('asset_hash_mismatch');
}

function assertActive({signal,deadlineAt}) {
  if(signal?.aborted)throw signal.reason??new CaptchaError(504,'request_timeout','OCR request deadline exceeded');
  if(deadlineAt!==undefined&&performance.now()>=deadlineAt)throw new CaptchaError(504,'request_timeout','OCR request deadline exceeded');
}
