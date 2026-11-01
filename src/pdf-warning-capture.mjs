export function capturePdfWarningOutput(warnings) {
  const originalWarn=console.warn,originalLog=console.log;
  console.warn=(...args)=>warnings.push(args.map(String).join(' '));
  console.log=(...args)=>{
    const value=args.map(String).join(' ');
    if(value.startsWith('Warning:'))warnings.push(value);
  };
  return ()=>{console.warn=originalWarn;console.log=originalLog;};
}
