import {readFile,stat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import * as ort from 'onnxruntime-node';
import {readOneModel,sha256} from './onemodel.mjs';
import {readFields} from './protobuf.mjs';
import {makePortableOnnx} from './onnx-portable.mjs';

export const CLASSIFIER_SCRIPTS=[null,'cjk','latin','cyrillic','arabic','devanagari','greek','thai','hebrew','tamil'];
const PREFIXES=['cjk','latin','cyrillic','arabic','devanagari','greek','thai','hebrew','tamil'];
const aliases={en:'latin',vi:'latin',fr:'latin',de:'latin',es:'latin',pt:'latin',it:'latin',vietnamese:'latin',english:'latin',zh:'cjk',ja:'cjk',ko:'cjk',ru:'cyrillic',uk:'cyrillic',ar:'arabic',fa:'arabic',ur:'arabic',hi:'devanagari',mr:'devanagari',el:'greek',th:'thai',he:'hebrew',ta:'tamil'};
export function resolveScript(value) {
  if(value==null||value==='auto')return null;
  const name=aliases[String(value).toLowerCase()]??String(value).toLowerCase();
  if(!PREFIXES.includes(name))throw new RangeError(`Unsupported script: ${value}. This model contains ${PREFIXES.join(', ')}.`);
  return name;
}

export function parseAlphabet(text,compositeText='') {
  const composites=new Map();
  for(const line of compositeText.split(/\r?\n/)) {
    if(!line||line.startsWith('//'))continue;
    const split=line.indexOf(' ');if(split>0)composites.set(line.slice(0,split),line.slice(split+1));
  }
  const alphabet=[];let blank=-1;
  for(const line of text.split(/\r?\n/)) {
    if(!line)continue;
    const match=/^(.*)\s+(\d+)$/.exec(line);if(!match)throw new Error('Malformed OneOCR alphabet row');
    const token=match[1],id=Number(match[2]);
    if(id>100000||alphabet[id]!==undefined)throw new Error('Invalid or duplicate alphabet index');
    if(token==='<blank>'){blank=id;alphabet[id]='';}
    else if(token==='<space>')alphabet[id]=' ';
    else alphabet[id]=(composites.get(token)??token).normalize('NFC');
  }
  if(blank<0)throw new Error('Incomplete OneOCR alphabet');
  for(let i=0;i<alphabet.length;i++)if(alphabet[i]===undefined)throw new Error('Incomplete OneOCR alphabet');
  return {alphabet,blank};
}

export class ModelBundle {
  static async open(path,{threads=2}={}) {
    path=resolve(path);let info=await stat(path);let resources,sourceSha256,config;
    if(info.isDirectory()) {
      try{await stat(join(path,'bundle.json'));}
      catch(error){if(error.code!=='ENOENT')throw error;path=join(path,'oneocr.onemodel');info=await stat(path);}
    }
    if(info.isFile()&&path.endsWith('.onemodel')) {
      const model=await readOneModel(path);sourceSha256=model.sha256;config=model.config;
      resources=model.resources.map(r=>({name:r.originalName,bytes:r.bytes,sha256:r.sha256}));
    } else {
      const directory=info.isDirectory()?path:resolve(path,'..');
      const manifest=JSON.parse(await readFile(info.isDirectory()?join(path,'bundle.json'):path,'utf8'));
      if(manifest.schema!=='oneocr.models.v1')throw new Error('Unsupported model bundle format');
      sourceSha256=manifest.sourceSha256;
      resources=manifest.resources.map(r=>{
        const filename=resolve(directory,r.file),rel=relative(directory,filename);
        if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Model resource escapes bundle directory');
        return {...r,filename,bytes:null};
      });
      config=await readFile(join(directory,'config.pb'));
      if(sha256(config)!==manifest.configSha256)throw new Error('Model config checksum mismatch');
    }
    return new ModelBundle(resources,sourceSha256,config,threads);
  }
  constructor(resources,sourceSha256,config,threads) {
    this.resources=resources;this.sourceSha256=sourceSha256;this.config=config;this.threads=threads;
    this.sessions=new Map();this.alphabets=new Map();this.characters=new Map();this.closed=false;
    this.encodings=new Map();
    for(const r of resources) {
      const parts=r.name.replaceAll('\\','/').split('/Model_Edge/').at(-1).split('/');
      r.role=parts[0];r.profile=parts[1];r.basename=parts.at(-1);
      if(r.role==='Detector'&&r.basename.endsWith('.onnx'))this.detector=r;
      if(r.role==='AuxMltCls'&&r.basename.endsWith('.onnx'))this.classifier=r;
      if(r.role==='Character') {
        const script=PREFIXES.find(s=>r.profile.toLowerCase().startsWith(s));
        if(!script)throw new Error(`Unknown recognizer profile ${r.profile}`);
        if(!this.characters.has(script))this.characters.set(script,{});
        const c=this.characters.get(script);c[r.basename.endsWith('.onnx')?'model':r.basename]=r;
      }
    }
    if(!this.detector||!this.classifier||this.characters.size!==9)throw new Error('Model bundle is missing required OCR resources');
    const configuration=readFields(config);
    const detector=readFields(configuration.get(1)[0]);
    const lineThresholds={};
    for(const record of detector.get(9)??[]) {
      const fields=readFields(record),level=fields.get(1)?.[0]?.toString('utf8');
      lineThresholds[level]=fields.get(2)?.[0];
    }
    this.detectorOptions={scoreThreshold:detector.get(8)?.[0],linkThreshold:detector.get(13)?.[0],nmsThreshold:detector.get(10)?.[0],minSegments:detector.get(19)?.[0],lineThresholds};
    this.layout=resources.find(r=>r.role==='LineLayout'&&r.basename.endsWith('.onnx'));
    this.handwritingCalibrationResource=resources.find(r=>r.role==='AuxMltCls'&&r.basename==='handwritten_calibration_map.txt');
    const classifier=readFields(configuration.get(20)[0]);
    this.classifierOptions={flipThreshold:classifier.get(4)?.[0]??0,printedThreshold:classifier.get(6)?.[0]??-5,handwrittenThreshold:classifier.get(7)?.[0]??5};
    this.rejectionOptions=new Map();
    for(const record of configuration.get(7)??[]) {
      const fields=readFields(record);this.rejectionOptions.set(fields.get(1)[0].toString('utf8'),{threshold:fields.get(3)?.[0]??.5,singleCharacterThreshold:fields.get(4)?.[0]??.5});
    }
    for(const bytes of configuration.get(3)??[]) {
      const fields=readFields(bytes),profile=fields.get(1)?.[0]?.toString('utf8');
      const entry=[...this.characters.values()].find(c=>c.model.profile===profile);
      if(entry){entry.pixelsPerFrame=fields.get(7)?.[0];entry.latticeOptions={rawThreshold:fields.get(13)?.[0],maxClasses:fields.get(14)?.[0],blankThreshold:fields.get(15)?.[0],arcThreshold:fields.get(16)?.[0]};}
    }
    for(const entry of this.characters.values())if(![4,8].includes(entry.pixelsPerFrame))throw new Error('Unsupported recognizer frame stride');
  }
  async bytes(resource) {
    if(!resource)throw new Error('A required model resource is absent');
    const bytes=resource.bytes??await readFile(resource.filename);
    if(sha256(bytes)!==resource.sha256)throw new Error(`Model resource checksum mismatch: ${resource.name}`);
    return bytes;
  }
  async session(resource) {
    if(this.closed)throw new Error('OCR engine is closed');
    if(!this.sessions.has(resource.name)) {
      const promise=this.bytes(resource).then(bytes=>ort.InferenceSession.create(makePortableOnnx(bytes).bytes,{executionProviders:['cpu'],intraOpNumThreads:this.threads,interOpNumThreads:1,logSeverityLevel:3}));
      this.sessions.set(resource.name,promise);
      promise.catch(()=>this.sessions.delete(resource.name));
    }
    return this.sessions.get(resource.name);
  }
  async alphabet(script) {
    if(!this.alphabets.has(script)) {
      const character=this.characters.get(script);
      if(!character)throw new Error(`No recognizer for ${script}`);
      const index=(await this.bytes(character['char2ind.txt'])).toString('utf8');
      const composite=character.composite_chars_map?(await this.bytes(character.composite_chars_map)).toString('utf8'):'';
      this.alphabets.set(script,parseAlphabet(index,composite));
    }
    return this.alphabets.get(script);
  }
  async encoding(script) {
    if(!this.encodings.has(script)) {
      const character=this.characters.get(script),vocabulary=await this.alphabet(script);
      const index=(await this.bytes(character['char2ind.txt'])).toString('utf8');
      const insensitive=(await this.bytes(character['char2inschar.txt'])).toString('utf8');
      const tokens=[],ids=new Map(),mapping=new Map();
      for(const line of index.split(/\r?\n/)) {
        if(!line)continue;const match=/^(.*)\s+(\d+)$/.exec(line);tokens[Number(match[2])]=match[1];ids.set(match[1],Number(match[2]));
      }
      for(const line of insensitive.split(/\r?\n/)){if(!line)continue;const split=line.indexOf(' ');if(split<0)throw new Error('Malformed insensitive character mapping');mapping.set(line.slice(0,split),line.slice(split+1));}
      const foldedIds=Int32Array.from(tokens,token=>{const id=ids.get(mapping.get(token)??token);if(id===undefined)throw new Error(`Unknown insensitive alphabet token ${token}`);return id;});
      const rawAlphabet=tokens.map((token,i)=>i===vocabulary.blank?'':token==='<space>'?' ':token);
      this.encodings.set(script,{...vocabulary,rawAlphabet,foldedIds,space:ids.get('<space>'),options:character.latticeOptions});
    }
    return this.encodings.get(script);
  }
  async evaluateFeatures(role,profile,features) {
    if(!['Confidence','Rejection'].includes(role))throw new RangeError('Feature model role must be Confidence or Rejection');
    if(!features||features.length!==21||!Array.from(features).every(Number.isFinite))throw new RangeError('A feature model requires exactly 21 finite float values');
    const resource=this.resources.find(r=>r.role===role&&r.profile===profile&&r.basename.endsWith('.onnx'));
    if(!resource)throw new RangeError(`No ${role} model for profile ${profile}`);
    const result=await (await this.session(resource)).run({data:new ort.Tensor('float32',Float32Array.from(features),[1,21,1,1])});
    return Object.fromEntries(Object.entries(result).map(([name,t])=>[name,{shape:t.dims,values:Array.from(t.data)}]));
  }
  auxiliaryProfile(script,handwritingLogit) {
    const printed=handwritingLogit<this.classifierOptions.printedThreshold;
    const name=script==='latin'?(printed?'LatinPrintedV2':'LatinMixedV2'):script==='cjk'?(printed?'CJKPrinted':'CJKMixed'):this.characters.get(script)?.model.profile;
    const profile=name+'Dummy';if(!this.rejectionOptions.has(profile))throw new Error(`No auxiliary profile for ${script}`);
    return {profile,...this.rejectionOptions.get(profile)};
  }
  async handwritingProbability(logit) {
    if(!Number.isFinite(logit))throw new RangeError('Handwriting logit must be finite');
    if(!this.handwritingCalibration) {
      const text=(await this.bytes(this.handwritingCalibrationResource)).toString('utf8');
      const rows=text.trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(Number));
      if(rows.some((r,i)=>r.length!==2||r.some(v=>!Number.isFinite(v)||v<0||v>1)||(i&&r[0]<=rows[i-1][0])))throw new Error('Invalid handwriting calibration map');
      this.handwritingCalibration=rows;
    }
    const probability=1/(1+Math.exp(-logit));
    return this.handwritingCalibration.find(([edge])=>edge>=probability)?.[1]??this.handwritingCalibration.at(-1)[1];
  }
  async close() {this.closed=true;await Promise.allSettled([...this.sessions.values()].map(async p=>(await p).release()));this.sessions.clear();}
}
