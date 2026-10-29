import * as ort from 'onnxruntime-node';
import {resizeRaster,chw} from './raster.mjs';
import {fitRectangle,suppressOverlaps} from './geometry.mjs';

const NEIGHBORS=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

export function segmentsToRegions(scores,deltas,links,{stride,sx,sy,scoreThreshold=.5,linkThreshold=.8,minSegments=3,lineThreshold=.6}) {
  const [,,height,width]=scores.dims,plane=height*width;
  const parents=new Int32Array(plane);parents.fill(-1);const sizes=new Int32Array(plane);
  for(let i=0;i<plane;i++)if(scores.data[i]>=scoreThreshold){parents[i]=i;sizes[i]=1;}
  const find=x=>{while(parents[x]!==x){parents[x]=parents[parents[x]];x=parents[x];}return x;};
  const unite=(a,b)=>{a=find(a);b=find(b);if(a===b)return;if(sizes[a]<sizes[b])[a,b]=[b,a];parents[b]=a;sizes[a]+=sizes[b];};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=y*width+x;if(parents[i]<0)continue;
    for(let d=0;d<8;d++) {
      const [dy,dx]=NEIGHBORS[d],ny=y+dy,nx=x+dx;
      if(nx<0||ny<0||nx>=width||ny>=height)continue;
      const j=ny*width+nx;if(parents[j]<0)continue;
      if(links.data[d*plane+i]>=linkThreshold||links.data[(7-d)*plane+j]>=linkThreshold)unite(i,j);
    }
  }
  const groups=new Map();
  for(let i=0;i<plane;i++)if(parents[i]>=0){const k=find(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);}
  const regions=[];
  for(const group of groups.values()) {
    if(group.length<minSegments)continue;
    const score=group.reduce((a,i)=>a+scores.data[i],0)/group.length;if(score<lineThreshold)continue;
    const points=[];
    for(const i of group) {
      const centerX=(i%width)*stride+(stride-1)/2,centerY=Math.floor(i/width)*stride+(stride-1)/2,scale=8*stride-1;
      for(let k=0;k<4;k++)points.push([(centerX+deltas.data[(2*k)*plane+i]*scale)/sx,(centerY+deltas.data[(2*k+1)*plane+i]*scale)/sy]);
    }
    const quad=fitRectangle(points);if(!quad)continue;
    const length=Math.hypot(quad[1][0]-quad[0][0],quad[1][1]-quad[0][1]),heightPx=Math.hypot(quad[3][0]-quad[0][0],quad[3][1]-quad[0][1]);
    if(length<4||heightPx<3)continue;
    regions.push({quad,score,segments:group.length});
  }
  return regions;
}

export async function detect(session,image,options={}) {
  const long=options.resizeLong??1152,short=options.resizeShort??768;
  const scale=Math.min(long/Math.max(image.width,image.height),short/Math.min(image.width,image.height));
  const width=Math.max(32,Math.round(image.width*scale)),height=Math.max(32,Math.round(image.height*scale));
  const paddedWidth=Math.ceil(width/32)*32,paddedHeight=Math.ceil(height/32)*32;
  const resized=await resizeRaster(image,width,height);
  const outputs=await session.run({data:new ort.Tensor('float32',chw(resized,{padWidth:paddedWidth,padHeight:paddedHeight}),[1,3,paddedHeight,paddedWidth]),im_info:new ort.Tensor('float32',Float32Array.of(height,width,1),[1,3])});
  const regions=[];
  for(const level of [2,3,4])for(const direction of ['hori','vert']) {
    const suffix=`${direction}_fpn${level}`;
    const scores=outputs[`scores_${suffix}`],deltas=outputs[`bbox_deltas_${suffix}`],links=outputs[`link_scores_${suffix}`];
    if(!scores||!deltas||!links)throw new Error(`Detector output ${suffix} is missing`);
    const boxes=segmentsToRegions(scores,deltas,links,{stride:2**level,sx:width/image.width,sy:height/image.height,...options,lineThreshold:options.lineThreshold??options.lineThresholds?.[`P${level}`]??.6});
    regions.push(...boxes.map(b=>({...b,vertical:direction==='vert',level})));
  }
  return suppressOverlaps(regions,options.nmsThreshold??.2);
}
