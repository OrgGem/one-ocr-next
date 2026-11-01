const WAVE_STATES=5;
const WAVE_MIN_SPAN_RATIO=0.8;
const YIELD_PIXEL_STEP=32_768;

export async function processCaptchaPixels(gray,width,height,config,checkActive) {
  const length=width*height;
  if(!(gray instanceof Uint8Array)||gray.length!==length||width<2||height<2||length>1_000_000)throw new Error('captcha_preprocess_raster_invalid');
  checkActive();
  const threshold=await chooseThreshold(gray,config.threshold,checkActive);
  let dark=0,light=0;
  for(let i=0;i<length;i++){
    if(gray[i]<=threshold.value)dark++;else light++;
    if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
  }
  const polarity=config.polarity&&config.polarity!=='auto'?config.polarity:(dark<=light?'dark':'light');
  const mask=new Uint8Array(length);
  let foregroundBefore=0;
  for(let i=0;i<length;i++){
    const foreground=polarity==='dark'?gray[i]<=threshold.value:gray[i]>threshold.value;
    if(foreground){mask[i]=1;foregroundBefore++;}
    if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
  }

  const appliedOrder=['grayscale','threshold','polarity'];
  let straight={axes:[],min_length_px:{horizontal:null,vertical:null},max_width_px:config.lineMaxWidthPx??1,
    candidate_runs:0,rejected_thick_components:0,pixels_removed:0,crossing_pixels_preserved:0};
  if(config.removeLines){
    appliedOrder.push('straight_lines');
    straight=await removeStraightLines(mask,width,height,config,checkActive);
  }
  let wavy={enabled:config.removeWavyLines===true,min_length_px:null,max_width_px:config.lineMaxWidthPx??1,
    candidate_paths:0,pixels_removed:0,branch_pixels_preserved:0,rejected_thick_columns:0};
  if(config.removeWavyLines===true){
    appliedOrder.push('wavy_lines');
    wavy=await removeWavyLine(mask,width,height,config,checkActive);
  }
  let dots={max_area_px:config.dotsMaxArea??null,connectivity:8,components_removed:0,pixels_removed:0};
  if(config.dotsMaxArea!==null&&config.dotsMaxArea!==undefined){
    appliedOrder.push('isolated_components');
    dots=await removeSmallComponents(mask,width,height,config.dotsMaxArea,checkActive);
  }
  const output=new Uint8Array(length);output.fill(255);
  let foregroundAfter=0;
  for(let i=0;i<length;i++){
    if(mask[i]){output[i]=0;foregroundAfter++;}
    if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
  }
  return {gray:output,stats:{enabled:true,configured:config.configured,applied_order:appliedOrder,
    working_raster:{width,height,scale_x:config.scaleX,scale_y:config.scaleY,created:true,pixels:length},
    threshold:{method:threshold.method,value:threshold.value,foreground_polarity:polarity,foreground_pixels_before:foregroundBefore,foreground_pixels_after:foregroundAfter},
    straight_lines:straight,wavy_lines:wavy,dots}};
}

async function chooseThreshold(gray,requested,checkActive) {
  if(typeof requested==='number')return {method:'fixed',value:requested};
  const histogram=new Uint32Array(256);let sum=0;
  for(let i=0;i<gray.length;i++){
    const value=gray[i];histogram[value]++;sum+=value;
    if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
  }
  const total=gray.length;let backgroundWeight=0,backgroundSum=0,best=-1,threshold=0;
  for(let value=0;value<256;value++){
    backgroundWeight+=histogram[value];backgroundSum+=value*histogram[value];
    const foregroundWeight=total-backgroundWeight;
    if(backgroundWeight===0||foregroundWeight===0)continue;
    const meanBackground=backgroundSum/backgroundWeight,meanForeground=(sum-backgroundSum)/foregroundWeight;
    const between=backgroundWeight*foregroundWeight*(meanBackground-meanForeground)**2;
    if(between>best){best=between;threshold=value;}
  }
  return {method:'otsu',value:threshold};
}

async function removeStraightLines(mask,width,height,config,checkActive) {
  const axes=config.removeLines==='grid'?['horizontal','vertical']:[config.removeLines];
  const pixelCount=width*height,union=new Uint8Array(pixelCount);
  const minLength={horizontal:axes.includes('horizontal')?(config.lineMinLengthPx??Math.max(8,Math.ceil(width*0.65))):null,
    vertical:axes.includes('vertical')?(config.lineMinLengthPx??Math.max(8,Math.ceil(height*0.9))):null};
  const maxWidth=config.lineMaxWidthPx??1;let candidateRuns=0,rejectedThickComponents=0;
  for(const axis of axes){
    const candidates=await scanLineCandidates(mask,width,height,axis,minLength[axis],maxWidth,checkActive);
    candidateRuns+=candidates.runs;
    rejectedThickComponents+=candidates.rejectedThick;
    for(let i=0;i<pixelCount;i++){
      if(candidates.mask[i])union[i]=1;
      if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
    }
  }
  const protectedPixels=new Uint8Array(pixelCount);let crossingPixelsPreserved=0,protectionWork=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;protectionWork++;if(protectionWork%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);if(!union[i])continue;
    let branch=false;
    for(let dy=-1;dy<=1&&!branch;dy++)for(let dx=-1;dx<=1;dx++){
      if(dx===0&&dy===0)continue;const nx=x+dx,ny=y+dy;
      if(nx>=0&&nx<width&&ny>=0&&ny<height){const n=ny*width+nx;if(mask[n]&&!union[n]){branch=true;break;}}
    }
    if(branch){protectedPixels[i]=1;crossingPixelsPreserved++;}
    if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
  }
  let pixelsRemoved=0;
  for(let i=0;i<pixelCount;i++){
    if(union[i]&&!protectedPixels[i]&&mask[i]){mask[i]=0;pixelsRemoved++;}
    if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
  }
  return {axes,min_length_px:minLength,max_width_px:maxWidth,candidate_runs:candidateRuns,rejected_thick_components:rejectedThickComponents,
    pixels_removed:pixelsRemoved,crossing_pixels_preserved:crossingPixelsPreserved};
}

async function scanLineCandidates(mask,width,height,axis,minLength,maxWidth,checkActive) {
  const count=mask.length,candidate=new Uint8Array(count),scanCount=axis==='horizontal'?height:width,scanLength=axis==='horizontal'?width:height;
  let runs=0,work=0;
  for(let scan=0;scan<scanCount;scan++){
    let pos=0;
    while(pos<scanLength){
      const index=(axis==='horizontal'?scan*width+pos:pos*width+scan);
      if(!mask[index]){pos++;work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);continue;}
      const start=pos;
      while(pos<scanLength&&mask[axis==='horizontal'?scan*width+pos:pos*width+scan])pos++;
      if(pos-start<minLength)continue;
      runs++;
      for(let at=start;at<pos;at++){candidate[axis==='horizontal'?scan*width+at:at*width+scan]=1;work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);}
    }
    if(scan%16===15)await checkpoint(checkActive);
  }
  const seen=new Uint8Array(count),accepted=new Uint8Array(count),queue=new Int32Array(count);let rejectedThick=0;
  for(let seed=0;seed<count;seed++){
    work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
    if(!candidate[seed]||seen[seed])continue;
    let head=0,tail=0,minX=width,maxX=-1,minY=height,maxY=-1;queue[tail++]=seed;seen[seed]=1;
    while(head<tail){
      const index=queue[head++],x=index%width,y=(index/width)|0;
      if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
      const left=x>0?index-1:-1,right=x+1<width?index+1:-1,up=y>0?index-width:-1,down=y+1<height?index+width:-1;
      if(left>=0&&candidate[left]&&!seen[left]){seen[left]=1;queue[tail++]=left;}
      if(right>=0&&candidate[right]&&!seen[right]){seen[right]=1;queue[tail++]=right;}
      if(up>=0&&candidate[up]&&!seen[up]){seen[up]=1;queue[tail++]=up;}
      if(down>=0&&candidate[down]&&!seen[down]){seen[down]=1;queue[tail++]=down;}
      work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
    }
    const thickness=axis==='horizontal'?maxY-minY+1:maxX-minX+1;
    if(thickness<=maxWidth)for(let i=0;i<tail;i++){accepted[queue[i]]=1;work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);}else rejectedThick++;
  }
  return {mask:accepted,runs,rejectedThick};
}

async function removeWavyLine(mask,width,height,config,checkActive) {
  const minLength=Math.max(8,Math.ceil(width*WAVE_MIN_SPAN_RATIO),config.lineMinLengthPx??0),maxWidth=config.lineMaxWidthPx??1;
  const stats={enabled:true,min_length_px:minLength,max_width_px:maxWidth,candidate_paths:0,pixels_removed:0,branch_pixels_preserved:0,rejected_thick_columns:0};
  if(minLength>width)return stats;
  const predecessors=new Uint8Array(width*height*WAVE_STATES);predecessors.fill(255);
  let previous=new Uint16Array(height*WAVE_STATES),current=new Uint16Array(height*WAVE_STATES);
  let bestLength=0,bestX=-1,bestY=-1,bestDirection=0,work=0;
  for(let x=0;x<width;x++){
    current.fill(0);
    for(let y=0;y<height;y++){
      work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
      if(!mask[y*width+x])continue;
      for(let direction=-2;direction<=2;direction++){
        work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
        let length=1,previousDirection=255;
        if(x>0){
          const previousY=y-direction;
          if(previousY>=0&&previousY<height){
            let longest=0;
            for(let slope=Math.max(-2,direction-1);slope<=Math.min(2,direction+1);slope++){
              const candidate=previous[previousY*WAVE_STATES+slope+2];
              if(candidate>longest){longest=candidate;previousDirection=slope+2;}
            }
            if(longest){length=longest+1;predecessors[(x*height+y)*WAVE_STATES+direction+2]=previousDirection;}
          }
        }
        current[y*WAVE_STATES+direction+2]=length;
        if(length>bestLength){bestLength=length;bestX=x;bestY=y;bestDirection=direction+2;}
      }
    }
    [previous,current]=[current,previous];
    if(x%8===7)await checkpoint(checkActive);
  }
  if(bestLength<minLength||bestX<Math.ceil(width*0.9)-1||bestX-bestLength+1>Math.floor(width*0.1))return stats;
  const yByX=new Int16Array(width);yByX.fill(-1);let x=bestX,y=bestY,direction=bestDirection;
  for(let n=0;n<bestLength;n++){
    yByX[x]=y;const pred=predecessors[(x*height+y)*WAVE_STATES+direction];
    if(pred===255)break;
    y-=direction-2;x--;direction=pred;
  }
  let minY=height,maxY=-1,previousSign=0,turns=0;
  for(let column=0;column<width;column++)if(yByX[column]>=0){if(yByX[column]<minY)minY=yByX[column];if(yByX[column]>maxY)maxY=yByX[column];
    if(column>0&&yByX[column-1]>=0){const delta=yByX[column]-yByX[column-1],sign=Math.sign(delta);if(sign&&previousSign&&sign!==previousSign)turns++;if(sign)previousSign=sign;}}
  if(maxY-minY<2||turns<2)return stats;
  const candidate=new Uint8Array(mask.length);let rejectedThickColumns=0,thinColumns=0;
  for(let column=0;column<width;column++){
    const center=yByX[column];if(center<0)continue;
    let low=center,high=center;
    while(low>0&&center-low+1<maxWidth&&mask[(low-1)*width+column])low--;
    while(high+1<height&&high-center+1<maxWidth&&mask[(high+1)*width+column])high++;
    let runLow=low,runHigh=high;
    while(runLow>0&&mask[(runLow-1)*width+column])runLow--;
    while(runHigh+1<height&&mask[(runHigh+1)*width+column])runHigh++;
    if(runHigh-runLow+1>maxWidth){rejectedThickColumns++;continue;}
    thinColumns++;
    for(let row=low;row<=high;row++)candidate[row*width+column]=1;
  }
  stats.rejected_thick_columns=rejectedThickColumns;
  if(thinColumns<Math.ceil(bestLength*0.8))return stats;
  stats.candidate_paths=1;
  const protectedPixels=new Uint8Array(mask.length);let branchPixels=0,protectionWork=0;
  for(let row=0;row<height;row++)for(let column=0;column<width;column++){
    const index=row*width+column;protectionWork++;if(protectionWork%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);if(!candidate[index])continue;let branch=false;
    for(let dy=-1;dy<=1&&!branch;dy++)for(let dx=-1;dx<=1;dx++){
      if(dx===0&&dy===0)continue;const nx=column+dx,ny=row+dy;
      if(nx>=0&&nx<width&&ny>=0&&ny<height){const neighbor=ny*width+nx;if(mask[neighbor]&&!candidate[neighbor]){branch=true;break;}}
    }
    if(branch){protectedPixels[index]=1;branchPixels++;}
  }
  for(let i=0;i<mask.length;i++){
    if(candidate[i]&&!protectedPixels[i]&&mask[i]){mask[i]=0;stats.pixels_removed++;}
    if(i>0&&i%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
  }
  stats.branch_pixels_preserved=branchPixels;stats.rejected_thick_columns=rejectedThickColumns;return stats;
}

async function removeSmallComponents(mask,width,height,maxArea,checkActive) {
  const count=mask.length,seen=new Uint8Array(count),queue=new Int32Array(count);let componentsRemoved=0,pixelsRemoved=0,work=0;
  for(let seed=0;seed<count;seed++){
    work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
    if(!mask[seed]||seen[seed])continue;
    let head=0,tail=0;queue[tail++]=seed;seen[seed]=1;
    while(head<tail){
      const index=queue[head++],x=index%width,y=(index/width)|0;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        if(dx===0&&dy===0)continue;const nx=x+dx,ny=y+dy;if(nx<0||nx>=width||ny<0||ny>=height)continue;
        const neighbor=ny*width+nx;if(mask[neighbor]&&!seen[neighbor]){seen[neighbor]=1;queue[tail++]=neighbor;}
        work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);
      }
    }
    if(tail<=maxArea){componentsRemoved++;pixelsRemoved+=tail;for(let i=0;i<tail;i++){mask[queue[i]]=0;work++;if(work%YIELD_PIXEL_STEP===0)await checkpoint(checkActive);}}
  }
  return {max_area_px:maxArea,connectivity:8,components_removed:componentsRemoved,pixels_removed:pixelsRemoved};
}

async function checkpoint(checkActive) {
  checkActive();await new Promise(resolve=>setImmediate(resolve));checkActive();
}
