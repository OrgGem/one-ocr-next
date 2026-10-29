const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
export function convexHull(points) {
  const sorted=points.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if(sorted.length<3)return sorted;
  const half=values=>{const h=[];for(const p of values){while(h.length>=2&&cross(h.at(-2),h.at(-1),p)<=0)h.pop();h.push(p);}return h;};
  return [...half(sorted).slice(0,-1),...half(sorted.slice().reverse()).slice(0,-1)];
}

export function fitRectangle(points,vertical=false) {
  const hull=convexHull(points);if(hull.length<3)return null;
  let best=null;
  for(let i=0;i<hull.length;i++) {
    const p=hull[i],n=hull[(i+1)%hull.length],angle=Math.atan2(n[1]-p[1],n[0]-p[0]);
    const c=Math.cos(angle),s=Math.sin(angle);let minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity;
    for(const [x,y] of hull){const u=x*c+y*s,v=-x*s+y*c;minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v);}
    const area=(maxU-minU)*(maxV-minV);
    if(!best||area<best.area){const world=(u,v)=>[u*c-v*s,u*s+v*c];best={area,q:[world(minU,minV),world(maxU,minV),world(maxU,maxV),world(minU,maxV)]};}
  }
  let q=best.q;
  // A rectified line's first edge follows its long axis. Text direction is
  // subsequently resolved by the script/orientation classifier.
  const d=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  if(d(q[0],q[1])<d(q[0],q[3]))q=[q[3],q[0],q[1],q[2]];
  const dx=q[1][0]-q[0][0],dy=q[1][1]-q[0][1];
  if(Math.abs(dx)>=Math.abs(dy)?dx<0:dy<0)q=[q[2],q[3],q[0],q[1]];
  // Robustly fit the top and bottom to the central segment population;
  // individual noisy regressions must not inflate an entire line's height.
  const dx2=q[1][0]-q[0][0],dy2=q[1][1]-q[0][1],length=Math.hypot(dx2,dy2);
  const u=[dx2/length,dy2/length],v=[-u[1],u[0]];
  const along=points.map(p=>p[0]*u[0]+p[1]*u[1]);
  const across=points.map(p=>p[0]*v[0]+p[1]*v[1]).sort((a,b)=>a-b);
  const lo=across[Math.floor((across.length-1)*.06)],hi=across[Math.ceil((across.length-1)*.94)];
  const left=Math.min(...along),right=Math.max(...along);
  const world=(a,b)=>[a*u[0]+b*v[0],a*u[1]+b*v[1]];
  return [world(left,lo),world(right,lo),world(right,hi),world(left,hi)];
}

export function extent(q) {const xs=q.map(p=>p[0]),ys=q.map(p=>p[1]);return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];}
export function boxIou(a,b) {
  const [ax,ay,ar,ab]=extent(a),[bx,by,br,bb]=extent(b);
  const intersection=Math.max(0,Math.min(ar,br)-Math.max(ax,bx))*Math.max(0,Math.min(ab,bb)-Math.max(ay,by));
  return intersection/Math.max(1e-9,(ar-ax)*(ab-ay)+(br-bx)*(bb-by)-intersection);
}

export function suppressOverlaps(regions,threshold=.2) {
  const keep=[];
  for(const r of regions.slice().sort((a,b)=>b.score-a.score))if(!keep.some(k=>boxIou(k.quad,r.quad)>threshold))keep.push(r);
  return keep.filter(r=>!keep.some(other=>{
    if(r===other)return false;
    const [x,y,right,bottom]=extent(r.quad),[ox,oy,oright,obottom]=extent(other.quad);
    const area=(right-x)*(bottom-y),otherArea=(oright-ox)*(obottom-oy);
    if(otherArea<=area*1.5)return false;
    const intersection=Math.max(0,Math.min(right,oright)-Math.max(x,ox))*Math.max(0,Math.min(bottom,obottom)-Math.max(y,oy));
    return intersection/area>.7;
  }));
}

export function readingOrder(lines,angle=0) {
  const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  const projected=lines.map(line=>{
    const q=line.quad;const p=q.map(([x,y])=>[x*c+y*s,-x*s+y*c]);
    return {line,x:Math.min(...p.map(t=>t[0])),y:Math.min(...p.map(t=>t[1])),height:Math.max(...p.map(t=>t[1]))-Math.min(...p.map(t=>t[1]))};
  });
  projected.sort((a,b)=>a.line.layout==='vertical-glyphs'&&b.line.layout==='vertical-glyphs'?a.x-b.x:Math.abs(a.y-b.y)<.4*Math.min(a.height,b.height)?a.x-b.x:a.y-b.y);
  return projected.map(x=>x.line);
}
