import sharp from 'sharp';
import {resizeRaster} from './raster.mjs';

const identity=()=>[1,0,0,0,1,0];
function assertActive({signal,deadlineAt}={}) {
  if(signal?.aborted)throw signal.reason??new Error('OCR request aborted');
  if(deadlineAt!==undefined&&performance.now()>=deadlineAt) {
    const error=new Error('OCR request deadline exceeded');error.code='request_timeout';throw error;
  }
}
const multiply=(after,before)=>[
  after[0]*before[0]+after[1]*before[3],after[0]*before[1]+after[1]*before[4],after[0]*before[2]+after[1]*before[5]+after[2],
  after[3]*before[0]+after[4]*before[3],after[3]*before[1]+after[4]*before[4],after[3]*before[2]+after[4]*before[5]+after[5],
];

export function invertAffine(m) {
  const determinant=m[0]*m[4]-m[1]*m[3];
  if(!Number.isFinite(determinant)||Math.abs(determinant)<1e-12)throw new RangeError('Invalid image transform');
  const a=m[4]/determinant,b=-m[1]/determinant,d=-m[3]/determinant,e=m[0]/determinant;
  return [a,b,-a*m[2]-b*m[5],d,e,-d*m[2]-e*m[5]];
}

export function mapPoint(matrix,[x,y]) {return [matrix[0]*x+matrix[1]*y+matrix[2],matrix[3]*x+matrix[4]*y+matrix[5]];}

function rotateMatrix(width,height,outWidth,outHeight,degrees) {
  const radians=degrees*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  return [c,-s,outWidth/2-c*width/2+s*height/2,s,c,outHeight/2-s*width/2-c*height/2];
}

function ensurePixelLimit(width,height,maxPixels) {
  if(width<2||height<2||width>10000||height>10000||width*height>maxPixels)throw new RangeError('Preprocessed image exceeds the configured pixel limit');
}

async function rotateRaster(image,degrees,maxPixels) {
  if(Math.abs(degrees)<.01)return {image,matrix:identity()};
  const radians=Math.abs(degrees)*Math.PI/180;
  const predictedWidth=Math.ceil(image.width*Math.abs(Math.cos(radians))+image.height*Math.sin(radians));
  const predictedHeight=Math.ceil(image.height*Math.abs(Math.cos(radians))+image.width*Math.sin(radians));
  ensurePixelLimit(predictedWidth,predictedHeight,maxPixels);
  const {data,info}=await sharp(image.data,{raw:{width:image.width,height:image.height,channels:3}})
    .rotate(degrees,{background:{r:255,g:255,b:255}}).raw().toBuffer({resolveWithObject:true});
  ensurePixelLimit(info.width,info.height,maxPixels);
  return {image:{data,width:info.width,height:info.height,channels:3},matrix:rotateMatrix(image.width,image.height,info.width,info.height,degrees)};
}

function otsuThreshold(gray) {
  const histogram=new Uint32Array(256);let total=0,sum=0;
  for(const value of gray){histogram[value]++;sum+=value;total++;}
  let backgroundWeight=0,backgroundSum=0,bestVariance=0,best=0;
  for(let threshold=0;threshold<255;threshold++) {
    backgroundWeight+=histogram[threshold];if(backgroundWeight===0)continue;
    const foregroundWeight=total-backgroundWeight;if(foregroundWeight===0)break;
    backgroundSum+=threshold*histogram[threshold];
    const meanBackground=backgroundSum/backgroundWeight,meanForeground=(sum-backgroundSum)/foregroundWeight;
    const variance=backgroundWeight*foregroundWeight*(meanBackground-meanForeground)**2;
    if(variance>bestVariance){bestVariance=variance;best=threshold;}
  }
  return best;
}

// A bounded projection-profile deskew estimate. It examines a thumbnail only,
// never starts another inference session, and returns 0 when there is too
// little foreground ink or no clear peak.
export async function estimateDeskewDegrees(image,{signal,deadlineAt}={}) {
  assertActive({signal,deadlineAt});
  const scale=Math.min(1,512/Math.max(image.width,image.height));
  const width=Math.max(2,Math.round(image.width*scale)),height=Math.max(2,Math.round(image.height*scale));
  const sample=width===image.width&&height===image.height?image:await resizeRaster(image,width,height);
  assertActive({signal,deadlineAt});
  const gray=new Uint8Array(width*height),pixels=[];
  for(let i=0;i<gray.length;i++) {
    const from=i*3,value=Math.round(.299*sample.data[from]+.587*sample.data[from+1]+.114*sample.data[from+2]);
    gray[i]=value;
  }
  const threshold=otsuThreshold(gray);
  if(threshold>245)return 0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(gray[y*width+x]<=threshold)pixels.push([x,y]);
  if(pixels.length<80||pixels.length>width*height*.55)return 0;
  const rowCounts=new Uint32Array(height),columnCounts=new Uint32Array(width);
  for(const [x,y]of pixels){rowCounts[y]++;columnCounts[x]++;}
  let rowScore=0,columnScore=0;for(const value of rowCounts)rowScore+=value*value;for(const value of columnCounts)columnScore+=value*value;
  // Projection deskew assumes mostly horizontal text. Leave vertical writing
  // and sideways pages alone for OneOCR's own line-orientation path.
  if(columnScore>rowScore*1.2)return 0;
  const cx=width/2,cy=height/2,bins=new Uint32Array(Math.ceil(Math.hypot(width,height))+4);
  const scoreAt=degrees=>{
    bins.fill(0);const radians=degrees*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians),offset=bins.length/2;
    for(const [x,y]of pixels) {
      const row=Math.round(s*(x-cx)+c*(y-cy)+offset);
      if(row>=0&&row<bins.length)bins[row]++;
    }
    let score=0;for(const count of bins)score+=count*count;return score;
  };
  const baseline=scoreAt(0);let best=0,bestScore=baseline;
  for(let degrees=-10;degrees<=10.0001;degrees+=.25) {
    assertActive({signal,deadlineAt});
    const score=scoreAt(degrees);if(score>bestScore){best=degrees;bestScore=score;}
    if(signal||deadlineAt!==undefined)await new Promise(resolve=>setImmediate(resolve));
  }
  assertActive({signal,deadlineAt});
  return bestScore>baseline*1.015?Number(best.toFixed(2)):0;
}

export async function preprocessImage(image,options={}, {maxPixels=40_000_000,signal,deadlineAt}={}) {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new RangeError('preprocess must be an object');
  const {maxDimension,rotationDegrees=0,deskew=false,padding=0}=options;
  if(maxDimension!==undefined&&(!Number.isInteger(maxDimension)||maxDimension<32||maxDimension>4096))throw new RangeError('preprocess.maxDimension must be an integer from 32 to 4096');
  if(!Number.isFinite(rotationDegrees)||rotationDegrees< -180||rotationDegrees>180)throw new RangeError('preprocess.rotationDegrees must be from -180 to 180');
  if(typeof deskew!=='boolean')throw new RangeError('preprocess.deskew must be a boolean');
  if(!Number.isInteger(padding)||padding<0||padding>128)throw new RangeError('preprocess.padding must be an integer from 0 to 128');
  const source={width:image.width,height:image.height};let current=image,matrix=identity();const operations=[];
  assertActive({signal,deadlineAt});

  if(maxDimension&&Math.max(current.width,current.height)>maxDimension) {
    const scale=maxDimension/Math.max(current.width,current.height),width=Math.max(2,Math.round(current.width*scale)),height=Math.max(2,Math.round(current.height*scale));
    current=await resizeRaster(current,width,height);
    assertActive({signal,deadlineAt});
    matrix=multiply([width/source.width,0,0,0,height/source.height,0],matrix);
    operations.push({type:'resize',width,height});
  }
  assertActive({signal,deadlineAt});
  if(rotationDegrees!==0) {
    const rotated=await rotateRaster(current,rotationDegrees,maxPixels);current=rotated.image;matrix=multiply(rotated.matrix,matrix);
    assertActive({signal,deadlineAt});
    operations.push({type:'rotation',degrees:rotationDegrees,width:current.width,height:current.height});
  }
  assertActive({signal,deadlineAt});
  if(deskew) {
    const degrees=await estimateDeskewDegrees(current,{signal,deadlineAt});
    if(degrees!==0) {
      const rotated=await rotateRaster(current,degrees,maxPixels);current=rotated.image;matrix=multiply(rotated.matrix,matrix);
    }
    assertActive({signal,deadlineAt});
    operations.push({type:'deskew',degrees,width:current.width,height:current.height});
  }
  assertActive({signal,deadlineAt});
  if(padding>0) {
    ensurePixelLimit(current.width+2*padding,current.height+2*padding,maxPixels);
    const {data,info}=await sharp(current.data,{raw:{width:current.width,height:current.height,channels:3}})
      .extend({top:padding,bottom:padding,left:padding,right:padding,background:'#ffffff'}).raw().toBuffer({resolveWithObject:true});
    assertActive({signal,deadlineAt});
    current={data,width:info.width,height:info.height,channels:3};
    matrix=multiply([1,0,padding,0,1,padding],matrix);
    operations.push({type:'white_padding',pixels:padding,width:current.width,height:current.height});
  }
  ensurePixelLimit(current.width,current.height,maxPixels);
  assertActive({signal,deadlineAt});
  const inverse=invertAffine(matrix);
  return {image:current,source,operations,sourceToProcessed:matrix,processedToSource:inverse,applied:operations.length>0,
    metadata:{coordinate_space:'decoded_image_pixels_after_exif',processed_coordinate_space:'processed_image_pixels',source_dimensions:source,processed_dimensions:{width:current.width,height:current.height},operations,
      source_to_processed:[matrix.slice(0,3),matrix.slice(3,6),[0,0,1]],processed_to_source:[inverse.slice(0,3),inverse.slice(3,6),[0,0,1]]}};
}
