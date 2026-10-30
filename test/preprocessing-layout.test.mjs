import test from 'node:test';
import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {OcrEngine} from '../src/index.mjs';
import {DeepDocLayoutProvider,DEEPDOC_LAYOUT_ARTIFACT,layoutRegionContains,orderLayoutOcrRegions} from '../src/layout.mjs';
import {decodeImage} from '../src/raster.mjs';
import {estimateDeskewDegrees,mapPoint,preprocessImage} from '../src/preprocess.mjs';
import {ocrOptions} from '../src/http.mjs';
import {serve} from '../src/server.mjs';
import sharp from 'sharp';

const root=resolve(import.meta.dirname,'..');
const layoutModelPath=process.env.ONEOCR_LAYOUT_MODEL_PATH??join(root,'models/deepdoc-layout.onnx');
const oneOcrModelPath=process.env.ONEOCR_MODEL_PATH??join(root,'models');
let layoutModelAvailable=false;
try{await stat(layoutModelPath);layoutModelAvailable=true;}catch{/* model is an optional local dependency */}

test('preprocessing composes resize, rotation and padding transforms and estimates small skew',async()=>{
  const image=await decodeImage(join(root,'test/corpus/fixtures/latin-skew7.png'));
  const degrees=await estimateDeskewDegrees(image);
  assert.ok(degrees>5&&degrees<8,`expected about +7 degrees, got ${degrees}`);
  const width=480,height=260,binary=Buffer.alloc(width*height*3,255),theta=4*Math.PI/180;
  for(const base of [35,75,115,155,195])for(let x=20;x<width-20;x++) {
    const y=Math.round(base+Math.tan(theta)*(x-width/2));
    for(let dy=-1;dy<=1;dy++)for(let channel=0;channel<3;channel++)binary[((y+dy)*width+x)*3+channel]=0;
  }
  assert.ok(Math.abs(await estimateDeskewDegrees({data:binary,width,height,channels:3})+4)<=.25,'binary scan deskew should retain zero-valued foreground pixels');
  const upright=await decodeImage(join(root,'test/corpus/fixtures/latin-rot90.png'));
  assert.equal(await estimateDeskewDegrees(upright),0,'deskew must leave sideways pages to OCR orientation handling');
  const processed=await preprocessImage(image,{maxDimension:300,rotationDegrees:90,padding:8});
  assert.equal(processed.image.width,Math.round(processed.source.height*300/Math.max(processed.source.width,processed.source.height))+16);
  assert.equal(processed.metadata.coordinate_space,'decoded_image_pixels_after_exif');
  assert.equal(processed.metadata.processed_coordinate_space,'processed_image_pixels');
  for(const point of [[0,0],[image.width,0],[image.width,image.height],[0,image.height],[image.width/2,image.height/2]]) {
    const roundTrip=mapPoint(processed.processedToSource,mapPoint(processed.sourceToProcessed,point));
    assert.ok(Math.hypot(roundTrip[0]-point[0],roundTrip[1]-point[1])<1e-7);
  }
});

test('containment uses processed geometry and only suppresses text after table OCR succeeds',async()=>{
  const parent={bbox:{x0:80,y0:80,x1:330,y1:330},processed_bbox:{x0:100,y0:100,x1:300,y1:300}};
  const child={bbox:{x0:90,y0:90,x1:120,y1:130},processed_bbox:{x0:310,y0:150,x1:330,y1:250}};
  assert.equal(layoutRegionContains(parent,child),false,'an axis-aligned source box after rotation must not imply containment');

  const width=2100,height=2100,image={data:Buffer.alloc(width*height*3,255),width,height,channels:3};
  const layoutProvider={metadata:{provider:'deepdoc-onnx'},detect:async()=>({
    provider:'deepdoc-onnx',model:{sha256:'test'},coordinate_space:'processed_image_pixels',
    regions:[
      {id:'title',label:'title',class_id:2,score:.95,bbox:{x0:20,y0:10,x1:250,y1:50}},
      {id:'table',label:'table',class_id:5,score:.9,bbox:{x0:0,y0:100,x1:2100,y1:2100}},
      {id:'child',label:'text',class_id:1,score:.8,bbox:{x0:10,y0:150,x1:210,y1:250}},
    ],
  })};
  const engine=new OcrEngine({sourceSha256:'test'},{layoutProvider}),calls=[];
  engine._recognizeRaster=async(_crop,options)=>{
    const text=options.layoutRegionId;calls.push(text);
    return {text,recognition_attempts:1,lines:[{text,confidence:1,layout:'horizontal-glyphs',bounding_rect:{x1:0,y1:0,x2:100,y2:0,x3:100,y3:20,x4:0,y4:20},words:[]}]};
  };
  const prep=await preprocessImage(image,{});
  const result=await engine._recognizeWithLayout(image,prep,{started:performance.now(),maxRegions:8,maxRegionPixels:4_000_000,maxLines:1000,decoder:'native'});
  assert.deepEqual(calls,['title','child'],'the over-budget table must not suppress its eligible child text region or jump ahead of an earlier title');
  assert.equal(result.layout.regions.find(region=>region.id==='table').ocr_status,'region_pixel_limit');
  assert.equal(result.layout.regions.find(region=>region.id==='child').ocr_status,'recognized');
  assert.equal(result.text,'title\nchild');

  calls.length=0;
  const capped=await engine._recognizeWithLayout(image,prep,{started:performance.now(),maxRegions:8,maxRegionPixels:4_000_000,maxLines:1,decoder:'native'});
  assert.deepEqual(calls,['title']);
  assert.equal(capped.text,'title','max_lines must allocate recognition work in reading order');
});

test('layout provider awaits asynchronous ONNX session release',async()=>{
  const provider=new DeepDocLayoutProvider('unused',{threads:1,digest:'test'});
  let released=false;
  provider.sessionPromise=Promise.resolve({release:()=>new Promise(resolve=>setTimeout(()=>{released=true;resolve();},25))});
  await provider.close();
  assert.equal(released,true);
});

test('HTTP options validate layout and opt-in preprocessing parameters',()=>{
  const options=ocrOptions(new URLSearchParams('layout=deepdoc&layout_threshold=0.2&max_regions=12&max_dimension=1000&rotation=90&deskew=true&padding=16'));
  assert.equal(options.layout,'deepdoc');assert.equal(options.layoutThreshold,.2);assert.equal(options.maxRegions,12);
  assert.deepEqual(options.preprocess,{maxDimension:1000,rotationDegrees:90,deskew:true,padding:16});
  for(const query of ['layout=bad','max_regions=65','max_regions=2&max_regions=3','rotation=181','deskew=yes','padding=-1']) {
    assert.throws(()=>ocrOptions(new URLSearchParams(query)),error=>error.status===422);
  }
});

test('semantic layout rejects an unpinned model artifact',async()=>{
  assert.equal(DEEPDOC_LAYOUT_ARTIFACT.sha256,'fd77f4f78cd8030aee14b0fc38446ee1585de55ad207c0005f69d170961364cb');
  await assert.rejects(DeepDocLayoutProvider.create(join(root,'models/oneocr.onemodel')),/Unsupported DeepDoc layout model size/);
});

test('pinned DeepDoc layout model performs CPU inference, then OneOCR runs on semantic regions', {skip:!layoutModelAvailable&&'Set ONEOCR_LAYOUT_MODEL_PATH to the pinned local artifact'},async()=>{
  const blank=join(root,'test/corpus/fixtures/blank.png');
  const table=join(root,'test/vietnamese-tables/fixtures/vi-table-grid.png');
  const image=await decodeImage(table);
  const provider=await DeepDocLayoutProvider.create(layoutModelPath,{threads:2});
  try {
    const blankImage=await decodeImage(blank),blankLayout=await provider.detect(blankImage,{threshold:.2});
    assert.deepEqual(blankLayout.regions,[]);
    assert.equal(blankLayout.model.sha256,DEEPDOC_LAYOUT_ARTIFACT.sha256);
    const detected=await provider.detect(image,{threshold:.2,maxRegions:32});
    assert.ok(detected.regions.some(region=>region.label==='table'));
  } finally {await provider.close();}

  const engine=await OcrEngine.create({modelPath:oneOcrModelPath,layoutModelPath,threads:2});
  try {
    const tableLayout=await engine.layoutProvider.detect(image,{threshold:.2,maxRegions:24});
    const tableRegion=tableLayout.regions.find(region=>region.label==='table');
    assert.ok(tableRegion,'fixture should expose a semantic table region');
    const box=tableRegion.bbox,left=Math.floor(box.x0),top=Math.floor(box.y0),width=Math.ceil(box.x1)-left,height=Math.ceil(box.y1)-top;
    const cropResult=await sharp(image.data,{raw:{width:image.width,height:image.height,channels:3}})
      .extract({left,top,width,height}).raw().toBuffer({resolveWithObject:true});
    const firstTableLine=await engine._recognizeRaster({data:cropResult.data,width:cropResult.info.width,height:cropResult.info.height,channels:3},
      {maxLines:1,script:'latin',decoder:'native',recognitionLimit:256,includeWorkStats:true},performance.now());
    assert.equal(firstTableLine.text,'Mặt hàng','the line budget must select the reading-order header, not the highest-confidence later table cell');
    assert.ok(firstTableLine.recognition_attempts>1,'selecting the first line may require recognizing a bounded set of confidence-ordered detections');

    const empty=await engine.recognize(blank,{layout:'deepdoc'});
    assert.equal(empty.text,'');assert.deepEqual(empty.lines,[]);assert.deepEqual(empty.layout.regions,[]);
    const result=await engine.recognize(table,{layout:'deepdoc',layoutThreshold:.2,maxRegions:24,preprocess:{maxDimension:1024,padding:20}});
    assert.match(result.text,/Mặt hàng/);
    assert.equal(result.coordinate_space,'decoded_image_pixels_after_exif');
    assert.equal(result.width,image.width);assert.equal(result.height,image.height);
    assert.ok(result.layout.regions.some(region=>region.label==='table'&&region.ocr?.text.includes('Mặt hàng')));
    for(const line of result.lines)for(const point of [1,2,3,4]) {
      const x=line.bounding_rect[`x${point}`],y=line.bounding_rect[`y${point}`];
      assert.ok(Number.isFinite(x)&&Number.isFinite(y));
      assert.ok(x>=-2&&x<=image.width+2&&y>=-2&&y<=image.height+2);
    }
    assert.deepEqual(result.preprocessing.operations.map(operation=>operation.type),['resize','white_padding']);
  } finally {await engine.close();}
});

test('semantic OCR deadline includes model and region work',async()=>{
  const slowEngine={bundle:{sourceSha256:'test'},layoutProvider:{metadata:{provider:'deepdoc-onnx'}},recognize:async(_input,{signal})=>{
    await new Promise(resolve=>setTimeout(resolve,80));
    if(signal.aborted)throw signal.reason;
    return {text:'unexpected',lines:[]};
  }};
  const app=await serve({engine:slowEngine,host:'127.0.0.1',port:0,requestTimeoutMs:20,apiKey:'a'.repeat(32)});
  try {
    const bytes=await import('node:fs/promises').then(fs=>fs.readFile(join(root,'test/corpus/fixtures/blank.png')));
    const started=performance.now();
    const response=await fetch(`${app.url}/v1/ocr?layout=deepdoc`,{method:'POST',headers:{authorization:`Bearer ${'a'.repeat(32)}`,'content-type':'image/png'},body:bytes});
    assert.equal(response.status,504);assert.equal((await response.json()).error,'request_timeout');
    assert.ok(performance.now()-started<100,'HTTP deadline should be enforced before slow region work returns');
  } finally {await app.close();}
});

test('monotonic deadline interrupts CPU-heavy deskew before max_lines=0 can return success',async()=>{
  const width=512,height=512,data=Buffer.alloc(width*height*3,255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if((x*79+y*37)%100<45) {
    const offset=(y*width+x)*3;data[offset]=0;data[offset+1]=0;data[offset+2]=0;
  }
  const png=await sharp(data,{raw:{width,height,channels:3}}).png().toBuffer();
  const engine=await OcrEngine.create({modelPath:oneOcrModelPath,threads:2});
  const app=await serve({engine,host:'127.0.0.1',port:0,requestTimeoutMs:10,apiKey:'b'.repeat(32)});
  try {
    const response=await fetch(`${app.url}/v1/ocr?max_lines=0&deskew=true`,{method:'POST',headers:{authorization:`Bearer ${'b'.repeat(32)}`,'content-type':'image/png'},body:png});
    assert.equal(response.status,504);assert.equal((await response.json()).error,'request_timeout');
  } finally {await app.close();await engine.close();}
});
