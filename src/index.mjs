import {ModelBundle,resolveScript} from './models.mjs';
import {decodeImage} from './raster.mjs';
import {detect} from './detector.mjs';
import {recognizeRegion} from './recognizer.mjs';
import {readingOrder} from './geometry.mjs';

export class OcrEngine {
  static async create({modelPath='models',threads=2,delayLoad=true,...options}={}) {
    if(!Number.isInteger(threads)||threads<1||threads>16)throw new RangeError('threads must be an integer from 1 to 16');
    const bundle=await ModelBundle.open(modelPath,{threads});const engine=new OcrEngine(bundle,options);
    try {
      await Promise.all([bundle.session(bundle.detector),bundle.session(bundle.classifier)]);
      if(!delayLoad)await Promise.all(bundle.resources.filter(r=>r.basename.endsWith('.onnx')).map(r=>bundle.session(r)));
      return engine;
    } catch(error){await bundle.close();throw error;}
  }
  constructor(bundle,options) {this.bundle=bundle;this.options={maxLines:1000,resizeLong:1152,resizeShort:768,...options};this.closed=false;this.pending=Promise.resolve();}
  async recognize(input,options={}) {
    if(this.closed)throw new Error('OCR engine is closed');
    const work=this.pending.then(()=>this._recognize(input,{...this.options,...options}));
    this.pending=work.catch(()=>{});return work;
  }
  async _recognize(input,options) {
    if(!Number.isInteger(options.maxLines)||options.maxLines<0||options.maxLines>1000)throw new RangeError('maxLines must be an integer from 0 to 1000');
    if(options.beamWidth!==undefined&&(!Number.isInteger(options.beamWidth)||options.beamWidth<1||options.beamWidth>32))throw new RangeError('beamWidth must be an integer from 1 to 32');
    if(options.minConfidence!==undefined&&(!Number.isFinite(options.minConfidence)||options.minConfidence<0||options.minConfidence>1))throw new RangeError('minConfidence must be from 0 to 1');
    if(options.rejectLowQuality!==undefined&&typeof options.rejectLowQuality!=='boolean')throw new RangeError('rejectLowQuality must be a boolean');
    const decoder=options.decoder??(options.beamWidth!==undefined?(options.beamWidth===1?'greedy':'beam'):'native');
    if(!['native','beam','greedy'].includes(decoder))throw new RangeError('decoder must be native, beam or greedy');
    if(!Number.isFinite(options.resizeLong)||options.resizeLong<32||options.resizeLong>1152||!Number.isFinite(options.resizeShort)||options.resizeShort<32||options.resizeShort>768)throw new RangeError('Resize resolution must be within 32..1152 and 32..768');
    const script=resolveScript(options.script??options.language);
    if(options.signal?.aborted)throw options.signal.reason??new Error('OCR request aborted');
    const started=performance.now(),image=await decodeImage(input,options);
    const detections=options.maxLines===0?[]:await detect(await this.bundle.session(this.bundle.detector),image,{...this.bundle.detectorOptions,...options});
    const lines=[];
    for(const region of detections.slice(0,1000)) {
      if(options.signal?.aborted)throw options.signal.reason??new Error('OCR request aborted');
      const line=await recognizeRegion(this.bundle,image,region,{...options,script,decoder});if(line)lines.push(line);
    }
    let x=0,y=0;
    // Near-square crops (notably standalone table digits) can have their
    // rectangle's first edge on the vertical axis. They cannot reliably vote
    // for page orientation when longer text provides an unambiguous axis.
    const oriented=lines.filter(line=>{const q=line.quad;return Math.hypot(q[1][0]-q[0][0],q[1][1]-q[0][1])>=2*Math.hypot(q[3][0]-q[0][0],q[3][1]-q[0][1]);});
    for(const line of oriented.length?oriented:lines){const q=line.quad,theta=Math.atan2(q[1][1]-q[0][1],q[1][0]-q[0][0])-(line.layout==='vertical-glyphs'?Math.PI/2:0),weight=line.text.length*line.confidence;x+=Math.cos(theta)*weight;y+=Math.sin(theta)*weight;}
    const textAngle=lines.length?(Math.atan2(y,x)*180/Math.PI+360)%360:0;
    const sorted=readingOrder(lines,textAngle).slice(0,options.maxLines).map(({quad,classification,...line})=>line);
    return {text:sorted.map(l=>l.text).join('\n'),text_angle:textAngle,lines:sorted,width:image.width,height:image.height,elapsed_ms:performance.now()-started,model_sha256:this.bundle.sourceSha256,provenance:{runtime:'native-nodejs',platform:process.platform,decoder:decoder==='native'?'reconstructed-native-lattice-20-best':decoder==='greedy'?'greedy-ctc':'prefix-beam-ctc',confidence:decoder==='native'?'original-model-reconstructed-features':'uncalibrated-token-geometric-mean',word_geometry:'ctc-frame-projection',word_segmentation:'whitespace-cjk-graphemes-icu-thai',icu:process.versions.icu}};
  }
  async close() {if(this.closed)return;this.closed=true;await this.pending;await this.bundle.close();}
  async [Symbol.asyncDispose]() {await this.close();}
}
export {resolveScript,ModelBundle};
export {assembleWordFeatures} from './features.mjs';
