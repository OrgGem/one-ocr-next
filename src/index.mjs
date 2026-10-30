import {ModelBundle,resolveScript} from './models.mjs';
import {decodeImage} from './raster.mjs';
import {detect} from './detector.mjs';
import {recognizeRegion} from './recognizer.mjs';
import {readingOrder} from './geometry.mjs';
import {DeepDocLayoutProvider,layoutRegionContains,orderLayoutOcrRegions,TEXT_BEARING_LAYOUT_LABELS} from './layout.mjs';
import {invertAffine,mapPoint,preprocessImage} from './preprocess.mjs';
import {toBoundingRect} from './raster.mjs';
import {NeedleJsonExtractor} from './needle-extractor.mjs';
import sharp from 'sharp';

export class OcrEngine {
  static async create({modelPath='models',layoutModelPath,threads=2,delayLoad=true,...options}={}) {
    if(!Number.isInteger(threads)||threads<1||threads>16)throw new RangeError('threads must be an integer from 1 to 16');
    const bundle=await ModelBundle.open(modelPath,{threads});let layoutProvider;
    try {
      if(layoutModelPath)layoutProvider=await DeepDocLayoutProvider.create(layoutModelPath,{threads});
      const engine=new OcrEngine(bundle,{...options,layoutProvider});
      await Promise.all([bundle.session(bundle.detector),bundle.session(bundle.classifier)]);
      if(!delayLoad)await Promise.all(bundle.resources.filter(r=>r.basename.endsWith('.onnx')).map(r=>bundle.session(r)));
      return engine;
    } catch(error){await layoutProvider?.close();await bundle.close();throw error;}
  }
  constructor(bundle,options) {this.bundle=bundle;this.layoutProvider=options.layoutProvider??null;this.needleExtractor=options.needleExtractor??new NeedleJsonExtractor({modelPath:options.needleModelPath});delete options.layoutProvider;delete options.needleExtractor;delete options.needleModelPath;this.options={maxLines:1000,resizeLong:1152,resizeShort:768,...options};this.closed=false;this.pending=Promise.resolve();}
  async recognize(input,options={}) {
    if(this.closed)throw new Error('OCR engine is closed');
    const work=this.pending.then(()=>this._recognize(input,{...this.options,...options}));
    this.pending=work.catch(()=>{});return work;
  }
  async extractJson(text,schema,options={}) {
    if(this.closed)throw new Error('OCR engine is closed');
    return this.needleExtractor.extract(text,schema,options);
  }
  async _recognize(input,options) {
    if(!Number.isInteger(options.maxLines)||options.maxLines<0||options.maxLines>1000)throw new RangeError('maxLines must be an integer from 0 to 1000');
    if(options.beamWidth!==undefined&&(!Number.isInteger(options.beamWidth)||options.beamWidth<1||options.beamWidth>32))throw new RangeError('beamWidth must be an integer from 1 to 32');
    if(options.minConfidence!==undefined&&(!Number.isFinite(options.minConfidence)||options.minConfidence<0||options.minConfidence>1))throw new RangeError('minConfidence must be from 0 to 1');
    if(options.rejectLowQuality!==undefined&&typeof options.rejectLowQuality!=='boolean')throw new RangeError('rejectLowQuality must be a boolean');
    const decoder=options.decoder??(options.beamWidth!==undefined?(options.beamWidth===1?'greedy':'beam'):'native');
    if(!['native','beam','greedy'].includes(decoder))throw new RangeError('decoder must be native, beam or greedy');
    if(!Number.isFinite(options.resizeLong)||options.resizeLong<32||options.resizeLong>1152||!Number.isFinite(options.resizeShort)||options.resizeShort<32||options.resizeShort>768)throw new RangeError('Resize resolution must be within 32..1152 and 32..768');
    if(options.layout!==undefined&&options.layout!=='deepdoc')throw new RangeError('layout must be deepdoc when specified');
    if(options.layout==='deepdoc'&&!this.layoutProvider)throw new RangeError('Semantic layout requires a local DeepDoc ONNX model configured when creating the engine');
    if(options.layoutThreshold!==undefined&&(!Number.isFinite(options.layoutThreshold)||options.layoutThreshold<0||options.layoutThreshold>1))throw new RangeError('layoutThreshold must be from 0 to 1');
    options.maxRegions??=32;
    if(!Number.isInteger(options.maxRegions)||options.maxRegions<1||options.maxRegions>64)throw new RangeError('maxRegions must be an integer from 1 to 64');
    options.maxRegionPixels??=4_000_000;
    if(!Number.isInteger(options.maxRegionPixels)||options.maxRegionPixels<4||options.maxRegionPixels>8_000_000)throw new RangeError('maxRegionPixels must be an integer from 4 to 8000000');
    const script=resolveScript(options.script??options.language);
    assertRequestActive(options);
    const decoded=await decodeImage(input,options),started=performance.now();
    assertRequestActive(options);
    const prep=options.preprocess===undefined?identityPreprocess(decoded):await preprocessImage(decoded,options.preprocess,{maxPixels:options.maxPixels??40_000_000,signal:options.signal,deadlineAt:options.deadlineAt});
    const image=prep.image;
    assertRequestActive(options);
    if(options.layout==='deepdoc')return this._recognizeWithLayout(image,prep,{...options,script,decoder,started});
    const result=await this._recognizeRaster(image,{...options,script,decoder},started);
    if(options.preprocess===undefined)return result;
    result.lines=result.lines.map(line=>mapLine(line,p=>mapPoint(prep.processedToSource,p)));
    result.text_angle=mapAngleToSource(result.text_angle,prep.sourceToProcessed);
    result.width=decoded.width;result.height=decoded.height;
    result.coordinate_space='decoded_image_pixels_after_exif';result.preprocessing=prep.metadata;
    return result;
  }

  async _recognizeRaster(image,options,started=performance.now()) {
    const {maxLines,script,decoder}=options;
    const recognitionLimit=options.recognitionLimit??1000;
    assertRequestActive(options);
    const detections=options.maxLines===0?[]:await detect(await this.bundle.session(this.bundle.detector),image,{...this.bundle.detectorOptions,...options});
    assertRequestActive(options);
    const lines=[];let recognitionAttempts=0;
    for(const region of detections.slice(0,Math.min(1000,recognitionLimit))) {
      assertRequestActive(options);
      recognitionAttempts++;
      const line=await recognizeRegion(this.bundle,image,region,{...options,script,decoder});if(line)lines.push(line);
    }
    assertRequestActive(options);
    let x=0,y=0;
    // Near-square crops (notably standalone table digits) can have their
    // rectangle's first edge on the vertical axis. They cannot reliably vote
    // for page orientation when longer text provides an unambiguous axis.
    const oriented=lines.filter(line=>{const q=line.quad;return Math.hypot(q[1][0]-q[0][0],q[1][1]-q[0][1])>=2*Math.hypot(q[3][0]-q[0][0],q[3][1]-q[0][1]);});
    for(const line of oriented.length?oriented:lines){const q=line.quad,theta=Math.atan2(q[1][1]-q[0][1],q[1][0]-q[0][0])-(line.layout==='vertical-glyphs'?Math.PI/2:0),weight=line.text.length*line.confidence;x+=Math.cos(theta)*weight;y+=Math.sin(theta)*weight;}
    const textAngle=lines.length?(Math.atan2(y,x)*180/Math.PI+360)%360:0;
    const sorted=readingOrder(lines,textAngle).slice(0,maxLines).map(({quad,classification,...line})=>line);
    const result={text:sorted.map(l=>l.text).join('\n'),text_angle:textAngle,lines:sorted,width:image.width,height:image.height,elapsed_ms:performance.now()-started,model_sha256:this.bundle.sourceSha256,provenance:{runtime:'native-nodejs',platform:process.platform,decoder:decoder==='native'?'reconstructed-native-lattice-20-best':decoder==='greedy'?'greedy-ctc':'prefix-beam-ctc',confidence:decoder==='native'?'original-model-reconstructed-features':'uncalibrated-token-geometric-mean',word_geometry:'ctc-frame-projection',word_segmentation:'whitespace-cjk-graphemes-icu-thai',icu:process.versions.icu}};
    if(options.includeWorkStats)result.recognition_attempts=recognitionAttempts;
    return result;
  }
  async _recognizeWithLayout(image,prep,options) {
    const {signal,started,maxRegions,maxRegionPixels}=options;
    assertRequestActive(options);
    const layout=await this.layoutProvider.detect(image,{threshold:options.layoutThreshold??.2,maxRegions,signal,deadlineAt:options.deadlineAt});
    assertRequestActive(options);
    const regions=layout.regions.map(region=>{
      const processedBbox={...region.bbox},sourceQuad=mapRect(processedBbox,p=>mapPoint(prep.processedToSource,p));
      return {...region,processed_bbox:processedBbox,
        bbox:{x0:Math.min(...sourceQuad.map(point=>point[0])),y0:Math.min(...sourceQuad.map(point=>point[1])),x1:Math.max(...sourceQuad.map(point=>point[0])),y1:Math.max(...sourceQuad.map(point=>point[1]))},
        bounding_rect:toBoundingRect(sourceQuad),coordinate_space:'decoded_image_pixels_after_exif',ocr:null,ocr_status:null};
    });
    const allLines=[];let usedRegionPixels=0,recognitionWorkUsed=0;const recognitionWorkLimit=256;
    const processingOrder=orderLayoutOcrRegions(regions);
    for(const region of processingOrder) {
      assertRequestActive(options);
      if(!TEXT_BEARING_LAYOUT_LABELS.has(region.label)){region.ocr_status='non_text_region';continue;}
      if(region.label!=='table'&&regions.some(parent=>parent.label==='table'&&parent.ocr_status==='recognized'&&parent.id!==region.id&&layoutRegionContains(parent,region))) {
        region.ocr_status='contained_by_table';continue;
      }
      const processedBbox=region.processed_bbox;
      const x0=Math.max(0,Math.floor(processedBbox.x0)),y0=Math.max(0,Math.floor(processedBbox.y0));
      const x1=Math.min(image.width,Math.ceil(processedBbox.x1)),y1=Math.min(image.height,Math.ceil(processedBbox.y1));
      const width=x1-x0,height=y1-y0,pixels=width*height;
      if(width<2||height<2){region.ocr_status='invalid_region_geometry';continue;}
      if(pixels>maxRegionPixels){region.ocr_status='region_pixel_limit';continue;}
      if(usedRegionPixels+pixels>16_000_000){region.ocr_status='total_region_pixel_limit';continue;}
      const remaining=Math.max(0,options.maxLines-allLines.length);
      if(remaining===0){region.ocr_status='line_limit';continue;}
      const recognitionRemaining=recognitionWorkLimit-recognitionWorkUsed;
      if(recognitionRemaining<=0){region.ocr_status='recognition_work_limit';continue;}
      usedRegionPixels+=pixels;
      const crop=await cropRaster(image,{left:x0,top:y0,width,height});
      // Detection confidence order is not reading order (notably in tables).
      // Recognize the bounded candidate set, sort it geometrically, then apply
      // the page line budget so a high-confidence later cell cannot win early.
      const result=await this._recognizeRaster(crop,{...options,layout:undefined,preprocess:undefined,layoutRegionId:region.id,maxLines:remaining,recognitionLimit:recognitionRemaining,includeWorkStats:true},started);
      recognitionWorkUsed+=result.recognition_attempts;
      assertRequestActive(options);
      const mapPointToSource=point=>mapPoint(prep.processedToSource,[point[0]+x0,point[1]+y0]);
      region.ocr={text:result.text,lines:result.lines.map(line=>mapLine(line,mapPointToSource)),recognition_attempts:result.recognition_attempts};
      region.ocr_status=result.text?'recognized':'no_text';
      allLines.push(...region.ocr.lines.map(line=>({...line,layout_region:{id:region.id,label:region.label,class_id:region.class_id,score:region.score},quad:rectQuad(line.bounding_rect)})));
    }
    assertRequestActive(options);
    const angle=textAngleFromLines(allLines),ordered=readingOrder(allLines,angle).slice(0,options.maxLines);
    const finalLines=ordered.map(({quad,...line})=>line);
    const provenance=layoutProvenance(options.decoder);
    return {
      text:finalLines.map(line=>line.text).join('\n'),text_angle:angle,lines:finalLines,width:prep.source.width,height:prep.source.height,
      elapsed_ms:performance.now()-started,model_sha256:this.bundle.sourceSha256,provenance,
      coordinate_space:'decoded_image_pixels_after_exif',preprocessing:prep.metadata,
      layout:{...layout,coordinate_space:'decoded_image_pixels_after_exif',regions:regions.map(({processed_bbox,...region})=>region),
        region_pixel_budget:{per_region:maxRegionPixels,total:16_000_000,used:usedRegionPixels},
        recognition_budget:{total:recognitionWorkLimit,used:recognitionWorkUsed,exhausted:recognitionWorkUsed>=recognitionWorkLimit}},
    };
  }

  async close() {if(this.closed)return;this.closed=true;await this.pending;await this.needleExtractor.close();await this.layoutProvider?.close();await this.bundle.close();}
  async [Symbol.asyncDispose]() {await this.close();}
}
export {resolveScript,ModelBundle};
export {assembleWordFeatures} from './features.mjs';

function identityPreprocess(image) {
  return {image,source:{width:image.width,height:image.height},sourceToProcessed:[1,0,0,0,1,0],processedToSource:[1,0,0,0,1,0],applied:false,
    metadata:{coordinate_space:'decoded_image_pixels_after_exif',processed_coordinate_space:'processed_image_pixels',source_dimensions:{width:image.width,height:image.height},processed_dimensions:{width:image.width,height:image.height},operations:[],source_to_processed:[[1,0,0],[0,1,0],[0,0,1]],processed_to_source:[[1,0,0],[0,1,0],[0,0,1]]}};
}

function rectQuad(rect) {return [[rect.x1,rect.y1],[rect.x2,rect.y2],[rect.x3,rect.y3],[rect.x4,rect.y4]];}
function mapRect(bbox,mapper) {return [mapper([bbox.x0,bbox.y0]),mapper([bbox.x1,bbox.y0]),mapper([bbox.x1,bbox.y1]),mapper([bbox.x0,bbox.y1])];}
function mapLine(line,mapper) {
  const mapped={...line,bounding_rect:toBoundingRect(mapRectFromBounding(line.bounding_rect,mapper))};
  if(line.words)mapped.words=line.words.map(word=>({...word,bounding_rect:toBoundingRect(mapRectFromBounding(word.bounding_rect,mapper))}));
  return mapped;
}
function mapRectFromBounding(rect,mapper) {return rectQuad(rect).map(mapper);}

function mapAngleToSource(angle,matrix) {
  const inverse=invertAffine(matrix),radians=angle*Math.PI/180,x=inverse[0]*Math.cos(radians)+inverse[1]*Math.sin(radians),y=inverse[3]*Math.cos(radians)+inverse[4]*Math.sin(radians);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

function textAngleFromLines(lines) {
  let x=0,y=0;
  const oriented=lines.filter(line=>{const q=line.quad;return Math.hypot(q[1][0]-q[0][0],q[1][1]-q[0][1])>=2*Math.hypot(q[3][0]-q[0][0],q[3][1]-q[0][1]);});
  for(const line of oriented.length?oriented:lines){const q=line.quad,theta=Math.atan2(q[1][1]-q[0][1],q[1][0]-q[0][0])-(line.layout==='vertical-glyphs'?Math.PI/2:0),weight=line.text.length*line.confidence;x+=Math.cos(theta)*weight;y+=Math.sin(theta)*weight;}
  return lines.length?(Math.atan2(y,x)*180/Math.PI+360)%360:0;
}

function layoutProvenance(decoder='native') {
  return {runtime:'native-nodejs',platform:process.platform,decoder:decoder==='native'?'reconstructed-native-lattice-20-best':decoder==='greedy'?'greedy-ctc':'prefix-beam-ctc',
    confidence:decoder==='native'?'original-model-reconstructed-features':'uncalibrated-token-geometric-mean',word_geometry:'ctc-frame-projection',word_segmentation:'whitespace-cjk-graphemes-icu-thai',icu:process.versions.icu};
}

async function cropRaster(image,{left,top,width,height}) {
  const {data,info}=await sharp(image.data,{raw:{width:image.width,height:image.height,channels:3}}).extract({left,top,width,height}).raw().toBuffer({resolveWithObject:true});
  return {data,width:info.width,height:info.height,channels:3};
}

function assertRequestActive({signal,deadlineAt}={}) {
  if(signal?.aborted)throw signal.reason??new Error('OCR request aborted');
  if(deadlineAt!==undefined&&performance.now()>=deadlineAt) {
    const error=new Error('OCR request deadline exceeded');error.code='request_timeout';throw error;
  }
}
