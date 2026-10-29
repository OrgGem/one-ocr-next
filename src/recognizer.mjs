import * as ort from 'onnxruntime-node';
import {chw,resizeRaster,warpQuad,wordQuad,toBoundingRect,reverseQuad} from './raster.mjs';
import {CLASSIFIER_SCRIPTS} from './models.mjs';
import bidiFactory from 'bidi-js';
import {buildLattice,wordFeatureInput} from './lattice.mjs';
import {assembleWordFeatures} from './features.mjs';
const bidi=bidiFactory();
const thaiWords=new Intl.Segmenter('th',{granularity:'word'});
const graphemes=new Intl.Segmenter('und',{granularity:'grapheme'});

export function logicalRtl(text,script) {
  return ['arabic','hebrew'].includes(script)?bidi.getReorderedString(text,bidi.getEmbeddingLevels(text,'rtl')):text;
}

export function segmentWords(runs,script) {
  const source=runs.map(r=>r.char).join('');let offset=0;
  const spans=runs.map(run=>{const start=offset;offset+=run.char.length;return {run,start,end:offset};});
  const pieces=[];
  if(script==='thai') {
    for(const item of thaiWords.segment(source))if(item.segment.trim())pieces.push({start:item.index,end:item.index+item.segment.length});
  } else if(script==='cjk') {
    let pending=null;
    const flush=()=>{if(pending)pieces.push(pending);pending=null;};
    for(const item of graphemes.segment(source)) {
      const start=item.index,end=start+item.segment.length;
      if(/\s/u.test(item.segment)){flush();continue;}
      // The observed native CJK output exposes each Han glyph as a word;
      // embedded Latin/numeric runs remain ordinary words.
      if(/\p{Script=Han}/u.test(item.segment)){flush();pieces.push({start,end});}
      else if(pending)pending.end=end;
      else pending={start,end};
    }
    flush();
  } else {
    for(const match of source.matchAll(/\S+/gu))pieces.push({start:match.index,end:match.index+match[0].length});
  }
  return pieces.map(piece=>({text:source.slice(piece.start,piece.end).normalize('NFC'),runs:spans.filter(span=>span.end>piece.start&&span.start<piece.end).map(span=>span.run)}));
}

export async function classify(bundle,image,quad) {
  const crop=warpQuad(image,quad);
  // Native Run traces show variable-width, aspect-preserving 60-pixel crops.
  // Stretching every line to 200 pixels changes the script decision.
  const fixed=crop.width<16?await resizeRaster(crop,16,60):crop;
  const session=await bundle.session(bundle.classifier);
  const out=await session.run({data:new ort.Tensor('float32',chw(fixed,{divisor:255}),[1,3,60,fixed.width])});
  const scores=Array.from(out.script_id_score.data);
  const index=scores.reduce((best,v,i)=>v>scores[best]?i:best,0);
  const handwriting=Number(out.hwpc_score.data[0]);
  return {script:CLASSIFIER_SCRIPTS[index]??'latin',scriptIndex:index,scores,flip:Number(out.flip_score.data[0]),handwriting,handwritingProbability:await bundle.handwritingProbability(handwriting)};
}

export function decodeCtc(logits,{alphabet,blank}) {
  const [time,batch,vocab]=logits.dims;
  if(batch!==1||vocab!==alphabet.length)throw new Error(`Recognizer/alphabet mismatch: ${vocab} versus ${alphabet.length}`);
  const runs=[];let previous=-1;
  for(let t=0;t<time;t++) {
    let best=0,value=-Infinity;
    for(let k=0;k<vocab;k++){const v=logits.data[t*vocab+k];if(v>value){value=v;best=k;}}
    if(!Number.isFinite(value))throw new Error('Non-finite recognizer logits');
    if(best!==blank) {
      if(best===previous){const run=runs.at(-1);run.end=t+1;run.logSum+=value;run.frames++;}
      else runs.push({id:best,char:alphabet[best],start:t,end:t+1,logSum:value,frames:1});
    }
    previous=best;
  }
  return {runs,time,text:runs.map(r=>r.char).join('').normalize('NFC')};
}

const logAdd=(a,b)=>a===-Infinity?b:b===-Infinity?a:Math.max(a,b)+Math.log1p(Math.exp(-Math.abs(a-b)));

export function decodeBeam(logits,vocabulary,{beamWidth=5,candidates=8}={}) {
  if(beamWidth<=1)return decodeCtc(logits,vocabulary);
  const [time,,vocab]=logits.dims,{alphabet,blank}=vocabulary;
  if(vocab!==alphabet.length)throw new Error('Recognizer/alphabet mismatch');
  let beam=[{ids:[],key:'',blank:0,nonblank:-Infinity}];
  for(let t=0;t<time;t++) {
    const best=[];
    for(let k=0;k<vocab;k++) {
      const score=logits.data[t*vocab+k];
      if(best.length<candidates||score>best.at(-1).score){best.push({id:k,score});best.sort((a,b)=>b.score-a.score);if(best.length>candidates)best.pop();}
    }
    const next=new Map();
    const entry=(ids,key)=>{if(!next.has(key))next.set(key,{ids,key,blank:-Infinity,nonblank:-Infinity});return next.get(key);};
    for(const state of beam) {
      const same=entry(state.ids,state.key),total=logAdd(state.blank,state.nonblank);
      same.blank=logAdd(same.blank,total+logits.data[t*vocab+blank]);
      for(const {id,score}of best) {
        if(id===blank)continue;
        const repeated=id===state.ids.at(-1);
        if(repeated)same.nonblank=logAdd(same.nonblank,state.nonblank+score);
        const key=state.key+','+id,extended=entry([...state.ids,id],key);
        extended.nonblank=logAdd(extended.nonblank,(repeated?state.blank:total)+score);
      }
    }
    beam=[...next.values()].sort((a,b)=>logAdd(b.blank,b.nonblank)-logAdd(a.blank,a.nonblank)).slice(0,beamWidth);
  }
  const ids=beam[0].ids;
  if(!ids.length)return {runs:[],time,text:''};
  // Recover frame spans with a forced Viterbi alignment to the selected CTC
  // prefix. This keeps word geometry attached to the decoded sequence.
  const states=ids.length*2+1,back=new Int16Array(time*states);
  let previous=new Float64Array(states);previous.fill(-Infinity);previous[0]=logits.data[blank];previous[1]=logits.data[ids[0]];
  for(let t=1;t<time;t++) {
    const current=new Float64Array(states);current.fill(-Infinity);
    for(let s=0;s<states;s++) {
      const label=s%2?ids[(s-1)/2]:blank;
      let from=s,score=previous[s];
      if(s>0&&previous[s-1]>score){from=s-1;score=previous[from];}
      if(s>1&&s%2&&label!==ids[(s-3)/2]&&previous[s-2]>score){from=s-2;score=previous[from];}
      current[s]=score+logits.data[t*vocab+label];back[t*states+s]=from;
    }
    previous=current;
  }
  let state=previous[states-1]>previous[states-2]?states-1:states-2;
  const path=new Int16Array(time);
  for(let t=time-1;t>=0;t--){path[t]=state;if(t)state=back[t*states+state];}
  const runs=ids.map(id=>({id,char:alphabet[id],start:time,end:0,logSum:0,frames:0}));
  for(let t=0;t<time;t++)if(path[t]%2){const run=runs[(path[t]-1)/2];run.start=Math.min(run.start,t);run.end=t+1;run.logSum+=logits.data[t*vocab+run.id];run.frames++;}
  if(runs.some(r=>!r.frames))return decodeCtc(logits,vocabulary);
  return {runs,time,text:runs.map(r=>r.char).join('').normalize('NFC')};
}

export async function recognizeRegion(bundle,image,region,{script:forcedScript,minConfidence=0,beamWidth=5,decoder='native',rejectLowQuality=true}={}) {
  const classification=await classify(bundle,image,region.quad);
  const script=forcedScript??classification.script;
  let quad=region.quad;
  if(classification.flip<bundle.classifierOptions.flipThreshold)quad=reverseQuad(quad);
  const crop=warpQuad(image,quad,{height:60});
  let layout='horizontal-glyphs',layoutScore=null;
  if(script==='cjk'&&bundle.layout) {
    const session=await bundle.session(bundle.layout);
    const result=await session.run({data:new ort.Tensor('float32',chw(crop,{divisor:255}),[1,3,60,crop.width])});
    layoutScore=Number(result.line_layout_score.data[0]);
    if(layoutScore<0)layout='vertical-glyphs';
  }
  const stride=bundle.characters.get(script).pixelsPerFrame;
  // The supplied native engine stretches to the next frame-stride boundary;
  // captured input tensors have ink at x=2..5, with no 16-pixel side padding.
  const width=(Math.floor(crop.width/stride)+1)*stride;
  const normalized=await resizeRaster(crop,width,60);
  const session=await bundle.session(bundle.characters.get(script).model);
  const out=await session.run({data:new ort.Tensor('float32',chw(normalized,{divisor:255}),[1,3,60,width]),seq_lengths:new ort.Tensor('int32',Int32Array.of(width/stride),[1])});
  const encoding=decoder==='native'?await bundle.encoding(script):null;
  const decoded=encoding?buildLattice(out.logsoftmax,encoding):decodeBeam(out.logsoftmax,await bundle.alphabet(script),{beamWidth:decoder==='greedy'?1:beamWidth});
  const tokenConfidence=decoded.runs.length?Math.exp(decoded.runs.reduce((s,r)=>s+r.logSum/r.frames,0)/decoded.runs.length):0;
  const auxiliary=encoding?bundle.auxiliaryProfile(script,classification.handwriting):null;
  const spans=groups=>groups.map((group,index)=>({
    ...group,
    start:index===0?0:Math.floor((groups[index-1].runs.at(-1).end-1+group.runs[0].start)/2)+1,
    end:index===groups.length-1?decoded.time-1:Math.floor((group.runs.at(-1).end-1+groups[index+1].runs[0].start)/2),
  }));
  let rejection=null;
  if(encoding) {
    let weighted=0,total=0;
    const groups=spans(segmentWords(decoded.runs,'latin'));
    for(const group of groups) {
      const features=assembleWordFeatures(wordFeatureInput(group.runs,decoded,encoding,group.start,group.end));
      const result=await bundle.evaluateFeatures('Rejection',auxiliary.profile,features);
      const weight=group.runs.length>1&&group.runs.slice(0,2).every(r=>/^[\p{P}\p{S}]/u.test(r.char))?1:group.runs.length;
      weighted+=result.softmax.values[1]*weight;total+=weight;
    }
    const threshold=groups.length===1&&groups[0].runs.length===1?auxiliary.singleCharacterThreshold:auxiliary.threshold;
    rejection={acceptance_score:total?weighted/total:0,threshold,profile:auxiliary.profile};
    rejection.accepted=total>0&&rejection.acceptance_score>=threshold;
    if(rejectLowQuality&&!rejection.accepted)return null;
  }
  const words=[];
  for(const {text:wordText,runs:group,start:frameStart,end:frameEnd} of spans(segmentWords(decoded.runs,script))) {
    const start=Math.max(0,group[0].start/decoded.time),end=Math.min(1,group.at(-1).end/decoded.time);
    const q=wordQuad(quad,start,end);
    const token= Math.exp(group.reduce((s,r)=>s+r.logSum/r.frames,0)/group.length);
    let confidence=token;
    if(encoding) {
      const features=assembleWordFeatures(wordFeatureInput(group,decoded,encoding,frameStart,frameEnd));
      confidence=(await bundle.evaluateFeatures('Confidence',auxiliary.profile,features)).softmax.values[1];
    }
    words.push({text:logicalRtl(wordText,script),bounding_rect:toBoundingRect(q),confidence,token_confidence:token});
  }
  const text=logicalRtl(decoded.text.trim(),script);
  if(['arabic','hebrew'].includes(script))words.reverse();
  const confidence=words.length?words.reduce((sum,w)=>sum+w.confidence*w.text.length,0)/words.reduce((sum,w)=>sum+w.text.length,0):tokenConfidence;
  if(confidence<minConfidence||!text)return null;
  const category=classification.handwriting<bundle.classifierOptions.printedThreshold?'printed':classification.handwriting>bundle.classifierOptions.handwrittenThreshold?'handwritten':'unknown';
  return {text,quad,bounding_rect:toBoundingRect(quad),words,confidence,script,layout,layout_score:layoutScore,style:{category,handwritten:category==='handwritten',handwriting_score:classification.handwriting,handwriting_probability:classification.handwritingProbability},rejection,detection_score:region.score,vertical:region.vertical,classification};
}
