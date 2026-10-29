import sharp from 'sharp';

export async function decodeImage(input, {maxPixels=40_000_000}={}) {
  if(input&&typeof input==='object'&&input.type===3&&input.data) {
    const {width,height,data}=input,stride=input.stride??width*4;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width>10000||height>10000||width*height>maxPixels)throw new RangeError('Invalid raw BGRA image dimensions');
    if(!Number.isSafeInteger(stride)||stride<width*4||!(data instanceof Uint8Array)||data.length<(height-1)*stride+width*4)throw new RangeError('Invalid raw BGRA stride or data length');
    const rgb=Buffer.alloc(width*height*3);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const source=y*stride+x*4,target=(y*width+x)*3;rgb[target]=data[source+2];rgb[target+1]=data[source+1];rgb[target+2]=data[source];}
    return {data:rgb,width,height,channels:3};
  }
  const image=sharp(input,{limitInputPixels:maxPixels,failOn:'error'}).rotate().flatten({background:'#ffffff'}).toColourspace('srgb').removeAlpha();
  const {data,info}=await image.raw().toBuffer({resolveWithObject:true});
  if(info.width<2||info.height<2||info.width>10000||info.height>10000) throw new RangeError('Image dimensions must be between 2 and 10000 pixels');
  return {data,width:info.width,height:info.height,channels:3};
}

export async function resizeRaster(image,width,height) {
  const data=await sharp(image.data,{raw:{width:image.width,height:image.height,channels:3}}).resize(width,height,{fit:'fill',kernel:'cubic'}).raw().toBuffer();
  return {data,width,height,channels:3};
}

export function chw(image, {divisor=1,padWidth=image.width,padHeight=image.height,offsetX=0,offsetY=0}={}) {
  const plane=padWidth*padHeight;
  const data=new Float32Array(3*plane);data.fill(255/divisor);
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++) {
    const from=(y*image.width+x)*3,to=(y+offsetY)*padWidth+x+offsetX;
    for(let c=0;c<3;c++)data[c*plane+to]=image.data[from+c]/divisor;
  }
  return data;
}

export const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);

export function rectifiedSize(quad) {
  return {width:Math.max(2,Math.round((distance(quad[0],quad[1])+distance(quad[2],quad[3]))/2)),height:Math.max(2,Math.round((distance(quad[0],quad[3])+distance(quad[1],quad[2]))/2))};
}

export function quadPoint(quad,u,v) {
  return [
    (1-u)*(1-v)*quad[0][0]+u*(1-v)*quad[1][0]+u*v*quad[2][0]+(1-u)*v*quad[3][0],
    (1-u)*(1-v)*quad[0][1]+u*(1-v)*quad[1][1]+u*v*quad[2][1]+(1-u)*v*quad[3][1],
  ];
}

export function warpQuad(image,quad,{height=60,flip=false,padding=0,maxWidth=8192}={}) {
  const size=rectifiedSize(quad);
  const width=Math.min(maxWidth,Math.max(4,Math.round(height*size.width/size.height)));
  const data=Buffer.alloc(width*height*3,255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    let u=(x+0.5)/width,v=(y+0.5)/height;
    if(flip){u=1-u;v=1-v;}
    const [px,py]=quadPoint(quad,u,v);
    const xx=px-.5,yy=py-.5,x0=Math.floor(xx),y0=Math.floor(yy),fx=xx-x0,fy=yy-y0;
    for(let channel=0;channel<3;channel++) {
      let value=0;
      for(let dy=0;dy<=1;dy++)for(let dx=0;dx<=1;dx++) {
        const sx=x0+dx,sy=y0+dy;
        const sample=(sx<0||sy<0||sx>=image.width||sy>=image.height)?255:image.data[(sy*image.width+sx)*3+channel];
        value+=sample*(dx?fx:1-fx)*(dy?fy:1-fy);
      }
      data[(y*width+x)*3+channel]=Math.max(0,Math.min(255,Math.round(value)));
    }
  }
  return {data,width,height,channels:3};
}

export function reverseQuad(quad) {return [quad[2],quad[3],quad[0],quad[1]];}
export function toBoundingRect(q) {return Object.fromEntries(q.flatMap((p,i)=>[[`x${i+1}`,p[0]],[`y${i+1}`,p[1]]]));}
export function wordQuad(q,left,right) {return [quadPoint(q,left,0),quadPoint(q,right,0),quadPoint(q,right,1),quadPoint(q,left,1)];}
