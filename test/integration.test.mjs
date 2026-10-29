import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {OcrEngine,ModelBundle} from '../src/index.mjs';
import {serve} from '../src/server.mjs';
import {decodeImage} from '../src/raster.mjs';

const root=resolve(import.meta.dirname,'..'),image=join(root,'test/corpus/fixtures/latin.png');
const modelPath=process.env.ONEOCR_MODEL_PATH??join(root,'models');

test('all 34 original models load through the portable graph lowering',async()=>{
  const b=await ModelBundle.open(modelPath);
  try {
    const models=b.resources.filter(r=>r.basename.endsWith('.onnx'));assert.equal(models.length,34);for(const model of models)assert.ok(await b.session(model));assert.equal(await b.handwritingProbability(-7.766138076782227),.0353);assert.equal(await b.handwritingProbability(-8.496471405029297),.0353);
    if(modelPath.endsWith('.onemodel')) {
      const directory=await ModelBundle.open(dirname(modelPath));
      try{assert.equal(directory.sourceSha256,b.sourceSha256);assert.equal(directory.resources.length,67);}
      finally{await directory.close();}
    }
  }
  finally {await b.close();}
});

test('native inference, Unicode, rotation, options, HTTP formats and close lifecycle',async()=>{
  const e=await OcrEngine.create({modelPath});
  try {
    const result=await e.recognize(image);assert.equal(result.text,'Native OCR 2026\nInvoice total 123.45');assert.equal(result.lines.length,2);assert.equal(result.provenance.platform,process.platform);
    const rgb=await decodeImage(image),stride=rgb.width*4+16,bgra=Buffer.alloc(stride*rgb.height);
    for(let y=0;y<rgb.height;y++)for(let x=0;x<rgb.width;x++){const source=(y*rgb.width+x)*3,target=y*stride+x*4;bgra[target]=rgb.data[source+2];bgra[target+1]=rgb.data[source+1];bgra[target+2]=rgb.data[source];bgra[target+3]=255;}
    assert.equal((await e.recognize({type:3,width:rgb.width,height:rgb.height,stride,data:bgra})).text,result.text);
    await assert.rejects(e.recognize({type:3,width:rgb.width,height:rgb.height,stride:1,data:bgra}),/stride/);
    assert.equal((await e.recognize(image,{maxLines:1})).text,'Native OCR 2026');
    assert.deepEqual((await e.recognize(image,{maxLines:0})).lines,[]);
    assert.equal((await e.recognize(join(root,'test/corpus/fixtures/vietnamese.png'))).text,'Tiếng Việt có dấu\nHóa đơn tổng cộng 123.45');
    const table=await e.recognize(join(root,'test/vietnamese-tables/fixtures/vi-table-grid.png'));
    assert.deepEqual(table.lines.map(line=>line.text),[
      'HÓA ĐƠN BÁN HÀNG','Mặt hàng','Số lượng','Đơn giá','Thành tiền',
      'Cà phê sữa','2','25.000','50.000','Bánh mì thịt','3','30.000','90.000',
      'Nước ép cam','1','45.000','45.000','Sữa chua','4','15.000','60.000','Tổng cộng','245.000'
    ],'standalone digits must not tilt page orientation and reorder table cells');
    assert.equal((await e.recognize(join(root,'test/corpus/fixtures/latin-rot90.png'))).text,result.text);
    const vertical=await e.recognize(join(root,'test/corpus/fixtures/vertical-cjk.png'));
    assert.equal(vertical.text,'日本語文字\n中文文字识别');assert.ok(vertical.lines.every(l=>l.layout==='vertical-glyphs'));
    assert.ok(Math.min(vertical.text_angle,360-vertical.text_angle)<1);
    const rotatedCjk=await e.recognize(join(root,'test/corpus/fixtures/cjk-rot90.png'));
    assert.equal(rotatedCjk.text,'中文文字识别\n日本語 OCR 2026');assert.ok(rotatedCjk.lines.every(l=>l.layout==='horizontal-glyphs'));
    const hand=await e.recognize(join(root,'test/corpus/fixtures/handwriting-font.png'));
    assert.equal(hand.lines.length,2);assert.equal(hand.text,'Native OCR sample\nInvoice total 123.45');
    for(const line of result.lines)for(const word of line.words){assert.ok(word.confidence>=0&&word.confidence<=1);assert.ok(Object.values(word.bounding_rect).every(Number.isFinite));}
    await assert.rejects(e.recognize(image,{language:'not-a-script'}),/Unsupported/);
    await assert.rejects(e.recognize(image,{maxLines:1001}),/maxLines/);
    await assert.rejects(e.recognize(image,{beamWidth:33}),/beamWidth/);
    await assert.rejects(e.recognize(image,{minConfidence:NaN}),/minConfidence/);
    const controller=new AbortController();controller.abort(new Error('cancel-test'));await assert.rejects(e.recognize(image,{signal:controller.signal}),/cancel-test/);
    const app=await serve({engine:e,host:'127.0.0.1',port:0,maxBodyBytes:2*1024*1024});
    try {
      assert.equal((await fetch(app.url+'/health')).status,200);
      const bytes=await readFile(image);
      const response=await fetch(app.url+'/',{method:'POST',headers:{'content-type':'image/png'},body:bytes});assert.equal(response.status,200);assert.equal((await response.json()).text,result.text);
      const form=new FormData();form.set('file',new Blob([bytes],{type:'image/png'}),'test.png');
      const multipart=await fetch(app.url+'/api/v1/ocr?max_lines=1',{method:'POST',body:form});assert.equal(multipart.status,200);assert.equal((await multipart.json()).lines.length,1);
      assert.equal((await fetch(app.url+'/',{method:'POST',headers:{'content-type':'image/png'},body:Buffer.from('not an image')})).status,400);
      assert.equal((await fetch(app.url+'/',{method:'POST',body:Buffer.alloc(2*1024*1024+1)})).status,413);
      const chunked=new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(1024*1024));controller.enqueue(Buffer.alloc(1024*1024+1));controller.close();}});
      assert.equal((await fetch(app.url+'/',{method:'POST',body:chunked,duplex:'half'})).status,413);
      assert.equal((await fetch(app.url+'/api/v1/ocr?language=bn',{method:'POST',body:bytes})).status,422);
    } finally {await app.close();}
  } finally {await e.close();}
  await assert.rejects(e.recognize(image),/closed/);
});
