// Recovered from the supplied DLL's RVA 0xcc410 and verified with native
// intermediate observations. Lattice candidates must be supplied by a decoder;
// this module does not invent their acoustic scores.
const f=Math.fround;
export function editDistance(left,right) {
  const a=Array.from(left),b=Array.from(right);
  let previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=0;i<a.length;i++) {
    const current=[i+1];
    for(let j=0;j<b.length;j++)current[j+1]=Math.min(current[j]+1,previous[j+1]+1,previous[j]+(a[i]===b[j]?0:1));
    previous=current;
  }
  return previous.at(-1);
}

function greedyWord(characters) {
  let result='',previous=null;
  for(const character of characters) {
    const raw=character.rawCharacter??character.character;
    const contiguous=previous&&previous.rawCharacter.physicalId===raw.physicalId&&previous.lastFrame+1===character.firstFrame;
    if(raw.type!==4&&!contiguous) {
      if(raw.type===5){if(result)result+=' ';}
      else result+=raw.text;
    }
    previous={rawCharacter:raw,lastFrame:character.lastFrame};
  }
  return result;
}

export function assembleWordFeatures({text,characters,alternatives}) {
  if(typeof text!=='string'||!characters?.length||!Array.isArray(alternatives))throw new RangeError('Word features require text, characters and lattice alternatives');
  for(const c of characters)for(const name of ['posterior','blank','space','competitor']) {
    const value=c[name];
    if(!Number.isFinite(value)||value<0||value>1.00001||(name==='posterior'&&value===0)||(name!=='posterior'&&value>=1))throw new RangeError(`Invalid character ${name}`);
  }
  if(alternatives.some(a=>typeof a.text!=='string'||!Number.isFinite(a.score)))throw new RangeError('Invalid lattice alternative');
  const n=characters.length,selected=alternatives.find(a=>a.text===text)??alternatives.at(-1),best=alternatives[0];
  const features=new Float32Array(21),histogram=new Uint32Array(10);
  features[0]=Math.log(n);features[1]=selected?selected.score/n:-10;
  features[2]=best?-editDistance(best.text,text)/n:1;
  features[3]=-editDistance(greedyWord(characters),text)/n;
  features[4]=best?f(selected.score-best.score)/n:-10;
  let posteriorSum=0,min=1;const sums=[0,0,0,0];
  for(const c of characters) {
    const posterior=Math.max(f(1e-6),c.posterior),log=f(Math.log(c.posterior));
    histogram[Math.min(9,Math.max(0,Math.trunc(posterior/.1)))]++;
    min=Math.min(min,posterior);posteriorSum=f(posteriorSum+f(posterior/n));
    sums[0]=f(sums[0]+log);
    sums[1]=f(sums[1]+f(log+f(Math.log(f(1-c.competitor)))));
    sums[2]=f(sums[2]+f(log+f(Math.log(f(1-c.blank)))));
    sums[3]=f(sums[3]+f(log+f(Math.log(f(1-c.space)))));
  }
  for(let i=0;i<4;i++)features[5+i]=sums[i]/n;
  features[9]=Math.log(min);features[10]=Math.log(posteriorSum);
  for(let i=0;i<10;i++)features[11+i]=-histogram[i]/n;
  return features;
}
