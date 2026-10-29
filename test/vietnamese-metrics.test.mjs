import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,normalize,distance,contains} from './vietnamese-metrics.mjs';

const cell=(id,x,text,numeric=false)=>({id,row:0,column:x/100,text,numeric,polygon:[[x,0],[x+100,0],[x+100,100],[x,100]]});
const word=(text,x)=>({text,bounding_rect:{x1:x,y1:20,x2:x+40,y2:20,x3:x+40,y3:40,x4:x,y4:40}});
const sample={width:200,height:100,cells:[cell('label',0,'Tiếng'),cell('number',100,'1.000',true)],expectedText:'Tiếng\n1.000'};
const result=(...words)=>({text:words.map(w=>w.text).join(' '),lines:[{words}]});

test('Vietnamese scoring normalizes NFC/whitespace while preserving tone, case and numeric punctuation',()=>{
  assert.equal(normalize(' Tiếng\n Việt '),'Tiếng Việt');
  assert.equal(distance([...'ế'],[...'e']),1);
  const good=evaluate(sample,result(word('Tiếng'.normalize('NFD'),10),word('1.000',110)));
  assert.equal(good.passed,true);assert.equal(good.characterErrorRate,0);assert.equal(good.exactNumericCells,1);
  const bad=evaluate(sample,result(word('Tieng',10),word('1,000',110)));
  assert.equal(bad.passed,false);assert.equal(bad.exactCells,0);assert.equal(bad.exactNumericCells,0);assert.ok(bad.characterErrorRate>0);
  const inconsistent=result(word('Tiếng',10),word('1.000',110));inconsistent.text='wrong public text';
  assert.equal(evaluate(sample,inconsistent).passed,false);
});

test('table scoring catches wrong cells, missing/extra/duplicate words and reversed reading order',()=>{
  const swapped=evaluate(sample,result(word('Tiếng',110),word('1.000',10)));
  assert.equal(swapped.exactText,true);assert.equal(swapped.passed,false);assert.equal(swapped.exactCells,0);
  const reversed=evaluate(sample,result(word('1.000',110),word('Tiếng',10)));
  assert.equal(reversed.exactCells,2);assert.equal(reversed.readingOrderExact,false);assert.equal(reversed.passed,false);
  assert.equal(evaluate(sample,result(word('Tiếng',10))).passed,false);
  assert.equal(evaluate(sample,result(word('Tiếng',10),word('Tiếng',10),word('1.000',110))).passed,false);
  const extra=word('extra',10);for(const key of ['y1','y2','y3','y4'])extra.bounding_rect[key]+=60;
  const narrow={...sample,cells:sample.cells.map(c=>({...c,polygon:c.polygon.map(([x,y])=>[x,y/2])}))};
  assert.equal(evaluate(narrow,result(word('Tiếng',10),word('1.000',110),extra)).unassigned.length,1);
});

test('geometry scoring rejects NaN/out-of-bounds/zero-area boxes and handles rotated cells',()=>{
  const invalid=word('Tiếng',10);invalid.bounding_rect.x1=NaN;
  assert.equal(evaluate(sample,result(invalid,word('1.000',110))).geometryValid,false);
  assert.equal(evaluate(sample,result(word('Tiếng',-50),word('1.000',110))).geometryValid,false);
  const empty=word('Tiếng',10);for(const key of ['y1','y2','y3','y4'])empty.bounding_rect[key]=20;
  assert.equal(evaluate(sample,result(empty,word('1.000',110))).geometryValid,false);
  assert.equal(contains([[50,0],[100,50],[50,100],[0,50]],[50,50]),true);
  assert.equal(contains([[50,0],[100,50],[50,100],[0,50]],[5,5]),false);
});
