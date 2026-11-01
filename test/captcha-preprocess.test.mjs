import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {processCaptchaPixels} from '../src/captcha-preprocess.mjs';

function canvas(width,height,fill=255) {
  const pixels=new Uint8Array(width*height);pixels.fill(fill);return pixels;
}
function line(pixels,width,x1,y1,x2,y2,value=0) {
  const steps=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));
  for(let step=0;step<=steps;step++){
    const x=Math.round(x1+(x2-x1)*step/Math.max(1,steps)),y=Math.round(y1+(y2-y1)*step/Math.max(1,steps));
    pixels[y*width+x]=value;
  }
}
function config(overrides={}) {
  return {configured:{},threshold:127,polarity:'dark',dotsMaxArea:null,removeLines:null,lineMinLengthPx:null,lineMaxWidthPx:1,removeWavyLines:false,scaleX:1,scaleY:1,...overrides};
}
function foreground(pixels){let count=0;for(const value of pixels)if(value===0)count++;return count;}

test('dots filtering removes isolated 8-connected specks after preserving detached glyph dots',async()=>{
  const width=80,height=48,pixels=canvas(width,height);
  line(pixels,width,20,18,20,36);
  pixels[11*width+19]=0;pixels[11*width+20]=0;pixels[12*width+19]=0;pixels[12*width+20]=0;
  pixels[4*width+4]=0;pixels[40*width+70]=0;
  const result=await processCaptchaPixels(pixels,width,height,config({dotsMaxArea:1}),()=>{});
  assert.equal(result.stats.dots.connectivity,8);
  assert.equal(result.stats.dots.components_removed,2);
  assert.equal(result.stats.dots.pixels_removed,2);
  assert.equal(result.gray[11*width+19],0,'detached multi-pixel dot is retained');
  assert.equal(result.gray[18*width+20],0,'glyph stem is retained');
  assert.equal(result.gray[4*width+4],255,'single-pixel speck is removed');
  assert.equal(foreground(result.gray),23);
});

test('straight grid filtering removes thin full length rules and preserves a crossing glyph branch',async()=>{
  const width=320,height=120,pixels=canvas(width,height);
  line(pixels,width,0,60,width-1,60);
  line(pixels,width,30,0,30,height-1);
  line(pixels,width,160,39,160,81);
  const result=await processCaptchaPixels(pixels,width,height,config({removeLines:'grid'}),()=>{});
  assert.deepEqual(result.stats.straight_lines.axes,['horizontal','vertical']);
  assert.deepEqual(result.stats.straight_lines.min_length_px,{horizontal:208,vertical:108});
  assert.ok(result.stats.straight_lines.pixels_removed>300);
  assert.ok(result.stats.straight_lines.crossing_pixels_preserved>0);
  assert.equal(result.gray[60*width+160],0,'the glyph pixels at the crossing are preserved');
  assert.equal(result.gray[50*width+160],0,'the branch outside the rule is preserved');
  assert.equal(result.gray[10*width+30],255,'the vertical rule is removed');
});

test('wavy filtering removes one supported thin path while protecting connected text crossings',async()=>{
  const width=320,height=100,pixels=canvas(width,height);
  for(let x=0;x<width;x++){
    const y=Math.round(47+4*Math.sin(2*Math.PI*x/160));
    pixels[y*width+x]=0;
  }
  line(pixels,width,140,25,140,65);
  line(pixels,width,134,44,147,44);
  const result=await processCaptchaPixels(pixels,width,height,config({removeWavyLines:true}),()=>{});
  assert.equal(result.stats.wavy_lines.candidate_paths,1);
  assert.ok(result.stats.wavy_lines.pixels_removed>200);
  assert.ok(result.stats.wavy_lines.branch_pixels_preserved>0);
  assert.ok(result.gray[25*width+140]===0,'connected text stroke outside the candidate band remains');
  assert.ok(foreground(result.gray)>0);
});

test('wavy filter rejects a path that is too thick for the configured width',async()=>{
  const width=320,height=100,pixels=canvas(width,height);
  for(let x=0;x<width;x++){
    const y=Math.round(47+4*Math.sin(2*Math.PI*x/160));
    pixels[y*width+x]=0;pixels[(y+1)*width+x]=0;
  }
  const result=await processCaptchaPixels(pixels,width,height,config({removeWavyLines:true,lineMaxWidthPx:1}),()=>{});
  assert.equal(result.stats.wavy_lines.candidate_paths,0);
  assert.equal(result.stats.wavy_lines.pixels_removed,0);
  assert.ok(result.stats.wavy_lines.rejected_thick_columns>width*0.8);
});

test('preprocessing yields to the event loop and checks the shared abort during bounded 1MP work',async()=>{
  const width=1200,height=833,pixels=canvas(width,height),controller=new AbortController();
  const started=performance.now();let timerFiredAt;
  const healthTimer=delay(10).then(()=>{timerFiredAt=performance.now();});
  const abortTimer=delay(1).then(()=>controller.abort());
  await assert.rejects(processCaptchaPixels(pixels,width,height,config({removeWavyLines:true}),()=>{
    if(controller.signal.aborted)throw new Error('deadline reached');
  }),/deadline reached/);
  await Promise.all([healthTimer,abortTimer]);
  assert.ok(timerFiredAt-started<150,'the Node event loop remained responsive while the raster was processed');
});
