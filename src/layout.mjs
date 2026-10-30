import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import {chw} from './raster.mjs';
import {readingOrder} from './geometry.mjs';

// This is the immutable HF artifact whose tensor layout is implemented below.
// Its raw [1,15,8400] contract matches the legacy DeepDoc Recognizer path in
// RAGFlow v0.10.0. The HF artifact does not publish a code-revision manifest;
// compatibility is inferred from exact ONNX metadata and the matching source
// implementation, and is additionally pinned by the file SHA-256.
export const DEEPDOC_LAYOUT_ARTIFACT=Object.freeze({
  provider:'deepdoc-onnx',
  repository:'InfiniFlow/deepdoc',
  revision:'b47049894cf047c980987af8c8c90fc438217097',
  file:'layout.onnx',
  sha256:'fd77f4f78cd8030aee14b0fc38446ee1585de55ad207c0005f69d170961364cb',
  sizeBytes:12_246_147,
  license:'Apache-2.0',
  referenceImplementation:'RAGFlow v0.10.0 deepdoc/vision/recognizer.py',
  inputName:'images',
  inputShape:[1,3,640,640],
  outputName:'output0',
  outputShape:[1,15,8400],
  labels:['_background_','text','title','figure','figure caption','table','table caption','header','footer','reference','equation'],
});

const INPUT_SIZE=640,CHANNELS=15,PROPOSALS=8400,MAX_CANDIDATES=1024;

function assertActive({signal,deadlineAt}={}) {
  if(signal?.aborted)throw signal.reason??new Error('OCR request aborted');
  if(deadlineAt!==undefined&&performance.now()>=deadlineAt) {
    const error=new Error('OCR request deadline exceeded');error.code='request_timeout';throw error;
  }
}

function sha256File(path) {
  return new Promise((resolveHash,reject)=>{
    const hash=createHash('sha256'),stream=createReadStream(path);
    stream.on('error',reject);
    stream.on('data',chunk=>hash.update(chunk));
    stream.on('end',()=>resolveHash(hash.digest('hex')));
  });
}

const area=b=>Math.max(0,b.x1-b.x0)*Math.max(0,b.y1-b.y0);
function iou(a,b) {
  const intersection=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
  const union=area(a)+area(b)-intersection;
  return union>0?intersection/union:0;
}

function classNms(candidates,threshold=.2,limit=300) {
  const classes=new Map();
  for(const box of candidates) {
    if(!classes.has(box.classId))classes.set(box.classId,[]);
    classes.get(box.classId).push(box);
  }
  const kept=[];
  for(const boxes of classes.values()) {
    boxes.sort((a,b)=>b.score-a.score);
    const picked=[];
    for(const box of boxes) {
      if(picked.length>=limit)break;
      if(!picked.some(other=>iou(box,other)>threshold))picked.push(box);
    }
    kept.push(...picked);
  }
  return kept;
}

function readTensorShape(tensor) {
  const shape=tensor?.dims??tensor?.shape;
  return Array.isArray(shape)?shape.map(Number):null;
}

export class DeepDocLayoutProvider {
  static async create(modelPath,{threads=2}={}) {
    if(typeof modelPath!=='string'||!modelPath.trim())throw new TypeError('layoutModelPath must be a local model file path');
    if(!Number.isInteger(threads)||threads<1||threads>16)throw new RangeError('threads must be an integer from 1 to 16');
    const path=resolve(modelPath),info=await stat(path);
    if(!info.isFile())throw new Error('DeepDoc layoutModelPath must point to a local ONNX file');
    if(info.size!==DEEPDOC_LAYOUT_ARTIFACT.sizeBytes)throw new Error(`Unsupported DeepDoc layout model size ${info.size}; expected pinned ${DEEPDOC_LAYOUT_ARTIFACT.repository}@${DEEPDOC_LAYOUT_ARTIFACT.revision}/${DEEPDOC_LAYOUT_ARTIFACT.file} (${DEEPDOC_LAYOUT_ARTIFACT.sizeBytes} bytes)`);
    const digest=await sha256File(path);
    if(digest!==DEEPDOC_LAYOUT_ARTIFACT.sha256)throw new Error(`Unsupported DeepDoc layout model SHA-256 ${digest}; expected ${DEEPDOC_LAYOUT_ARTIFACT.sha256} for ${DEEPDOC_LAYOUT_ARTIFACT.repository}@${DEEPDOC_LAYOUT_ARTIFACT.revision}/${DEEPDOC_LAYOUT_ARTIFACT.file}`);
    return new DeepDocLayoutProvider(path,{threads,digest});
  }

  constructor(path,{threads,digest}) {
    this.path=path;this.threads=threads;this.digest=digest;this.sessionPromise=null;this.closed=false;
    this.metadata={...DEEPDOC_LAYOUT_ARTIFACT};
  }

  async _session() {
    if(this.closed)throw new Error('DeepDoc layout provider is closed');
    if(!this.sessionPromise) {
      this.sessionPromise=ort.InferenceSession.create(this.path,{executionProviders:['cpu'],intraOpNumThreads:this.threads,interOpNumThreads:1,logSeverityLevel:3}).then(async session=>{
        const input=session.inputMetadata?.[0],output=session.outputMetadata?.[0];
        const valid=input?.name===DEEPDOC_LAYOUT_ARTIFACT.inputName&&JSON.stringify(readTensorShape(input))===JSON.stringify(DEEPDOC_LAYOUT_ARTIFACT.inputShape)&&
          output?.name===DEEPDOC_LAYOUT_ARTIFACT.outputName&&JSON.stringify(readTensorShape(output))===JSON.stringify(DEEPDOC_LAYOUT_ARTIFACT.outputShape);
        if(!valid) {
          await session.release();
          throw new Error(`Incompatible DeepDoc layout ONNX graph: expected ${DEEPDOC_LAYOUT_ARTIFACT.inputName}${JSON.stringify(DEEPDOC_LAYOUT_ARTIFACT.inputShape)} -> ${DEEPDOC_LAYOUT_ARTIFACT.outputName}${JSON.stringify(DEEPDOC_LAYOUT_ARTIFACT.outputShape)}`);
        }
        return session;
      }).catch(error=>{this.sessionPromise=null;throw error;});
    }
    return this.sessionPromise;
  }

  async detect(image,{threshold=.2,maxRegions=32,signal,deadlineAt}={}) {
    if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new RangeError('layoutThreshold must be from 0 to 1');
    if(!Number.isInteger(maxRegions)||maxRegions<1||maxRegions>64)throw new RangeError('maxRegions must be an integer from 1 to 64');
    assertActive({signal,deadlineAt});

    // The pinned legacy DeepDoc Recognizer contract stretches RGB directly to
    // its fixed 640x640 input, normalizing to 0..1.
    const resizedData=await sharp(image.data,{raw:{width:image.width,height:image.height,channels:3}})
      .resize(INPUT_SIZE,INPUT_SIZE,{fit:'fill',kernel:'linear'}).raw().toBuffer();
    assertActive({signal,deadlineAt});
    const resized={data:resizedData,width:INPUT_SIZE,height:INPUT_SIZE,channels:3};
    const tensor=new ort.Tensor('float32',chw(resized,{divisor:255}),[1,3,INPUT_SIZE,INPUT_SIZE]);
    const session=await this._session();
    assertActive({signal,deadlineAt});
    const outputs=await session.run({[DEEPDOC_LAYOUT_ARTIFACT.inputName]:tensor});
    assertActive({signal,deadlineAt});
    const output=outputs[DEEPDOC_LAYOUT_ARTIFACT.outputName];
    if(JSON.stringify(readTensorShape(output))!==JSON.stringify(DEEPDOC_LAYOUT_ARTIFACT.outputShape)||!(output.data instanceof Float32Array)||output.data.length!==CHANNELS*PROPOSALS) {
      throw new Error('DeepDoc layout inference returned an unexpected output tensor');
    }

    // The pinned HF graph is the raw YOLO output used by the old DeepDoc
    // Recognizer: [cx,cy,w,h, class_0..class_10] for each proposal. Its class
    // order is the 11-entry base label table, including background at index 0.
    const candidates=[],data=output.data,sx=image.width/INPUT_SIZE,sy=image.height/INPUT_SIZE;
    for(let i=0;i<PROPOSALS;i++) {
      let classId=0,score=-Infinity;
      for(let c=0;c<DEEPDOC_LAYOUT_ARTIFACT.labels.length;c++) {
        const value=data[(4+c)*PROPOSALS+i];
        if(value>score){score=value;classId=c;}
      }
      if(classId===0||score<=threshold||!Number.isFinite(score))continue;
      const cx=data[i]*sx,cy=data[PROPOSALS+i]*sy,w=data[2*PROPOSALS+i]*sx,h=data[3*PROPOSALS+i]*sy;
      if(![cx,cy,w,h].every(Number.isFinite)||w<=0||h<=0)continue;
      const x0=Math.max(0,Math.min(image.width,cx-w/2)),y0=Math.max(0,Math.min(image.height,cy-h/2));
      const x1=Math.max(0,Math.min(image.width,cx+w/2)),y1=Math.max(0,Math.min(image.height,cy+h/2));
      if(x1-x0<2||y1-y0<2)continue;
      candidates.push({x0,y0,x1,y1,score,classId,label:DEEPDOC_LAYOUT_ARTIFACT.labels[classId]});
    }
    candidates.sort((a,b)=>b.score-a.score);
    const candidateTruncated=candidates.length>MAX_CANDIDATES;
    const bounded=candidates.slice(0,MAX_CANDIDATES);
    const detected=classNms(bounded,.2,300);
    const selected=detected.slice().sort((a,b)=>b.score-a.score).slice(0,maxRegions);
    const ordered=readingOrder(selected.map(box=>({...box,quad:[[box.x0,box.y0],[box.x1,box.y0],[box.x1,box.y1],[box.x0,box.y1]],layout:'horizontal-glyphs'})),0);
    const regions=ordered.map((box,index)=>({
      id:`r${index+1}`,label:box.label,class_id:box.classId,score:box.score,
      bbox:{x0:box.x0,y0:box.y0,x1:box.x1,y1:box.y1},
    }));
    return {
      provider:DEEPDOC_LAYOUT_ARTIFACT.provider,
      model:{repository:DEEPDOC_LAYOUT_ARTIFACT.repository,revision:DEEPDOC_LAYOUT_ARTIFACT.revision,file:DEEPDOC_LAYOUT_ARTIFACT.file,sha256:this.digest,license:DEEPDOC_LAYOUT_ARTIFACT.license,reference_implementation:DEEPDOC_LAYOUT_ARTIFACT.referenceImplementation},
      coordinate_space:'processed_image_pixels',input_size:INPUT_SIZE,threshold,
      detected_region_count:detected.length,candidate_count:candidates.length,
      candidate_truncated:candidateTruncated,regions_truncated:detected.length>maxRegions,
      regions,
    };
  }

  async close() {
    if(this.closed)return;
    this.closed=true;
    if(this.sessionPromise) {
      try{await (await this.sessionPromise).release();}catch{/* failed initialization has no live session */}
      this.sessionPromise=null;
    }
  }
}

export function layoutRegionContains(parent,child,threshold=.8) {
  const a=parent.processed_bbox??parent.bbox,b=child.processed_bbox??child.bbox;
  const overlap=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*
    Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
  const childArea=(b.x1-b.x0)*(b.y1-b.y0);
  return childArea>0&&overlap/childArea>=threshold&&area(a)>childArea*1.15;
}

export function orderLayoutOcrRegions(regions) {
  const ordered=regions.slice();
  for(const table of regions.filter(region=>region.label==='table')) {
    const tableIndex=ordered.indexOf(table);
    const precedingChildren=regions.filter(region=>region!==table&&ordered.indexOf(region)<tableIndex&&layoutRegionContains(table,region));
    if(!precedingChildren.length)continue;
    for(const child of precedingChildren)ordered.splice(ordered.indexOf(child),1);
    ordered.splice(ordered.indexOf(table)+1,0,...precedingChildren);
  }
  return ordered;
}

export const TEXT_BEARING_LAYOUT_LABELS=new Set(['text','title','reference','figure caption','table','table caption','header','footer','equation']);
