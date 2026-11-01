import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {PDF_DEFAULT_DPI} from './pdf-options.mjs';

export class PdfRenderer {
  constructor({signal,deadlineAt,memoryMb=512}={}) {
    this.signal=signal;this.deadlineAt=deadlineAt;this.pending=null;this.closed=false;this.failure=null;this.termination=null;
    if(signal?.aborted)throw signal.reason??new Error('PDF rendering aborted');
    const workerPath=fileURLToPath(new URL('./pdf-renderer-worker.mjs',import.meta.url));
    this.child=fork(workerPath,[],{cwd:process.cwd(),execArgv:[`--max-old-space-size=${memoryMb}`],serialization:'advanced',silent:true,env:workerEnvironment()});
    this.child.on('message',message=>this.#onMessage(message));
    this.child.on('error',error=>this.#fail(error));
    this.child.on('exit',(code,signalName)=>this.#fail(new Error(`PDF renderer exited (${code??signalName??'unknown'})`)));
    this.onAbort=()=>{this.#fail(signal.reason??new Error('PDF rendering aborted'));void this.#terminate();};
    signal?.addEventListener('abort',this.onAbort,{once:true});
    // Renderer diagnostics may include PDF supplied strings. Keep them private and discard them.
    this.child.stderr?.resume();this.child.stdout?.resume();
  }

  async open(data,{dpi=PDF_DEFAULT_DPI,pages=null}={}) {
    const message=await this.#request({type:'open',data:new Uint8Array(data),dpi,pages},'opened');
    return message;
  }

  async render(pageNumber) {
    const message=await this.#request({type:'render',pageNumber},'page');
    return {...message,png:Buffer.from(message.png)};
  }

  async close() {
    if(this.closed){await this.termination;return;}
    this.signal?.removeEventListener('abort',this.onAbort);
    if(this.failure){await this.#terminate();return;}
    try {
      await this.#request({type:'close'},'closed',1000);
      if(this.child.exitCode===null&&this.child.signalCode===null) {
        await Promise.race([once(this.child,'exit').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);
      }
      if(this.child.exitCode!==null||this.child.signalCode!==null){this.closed=true;this.termination=Promise.resolve();return;}
    } catch {/* the forced child termination below is the cleanup boundary */}
    await this.#terminate();
  }

  #request(message,expected,maximumWaitMs=undefined) {
    if(this.closed||this.failure)return Promise.reject(this.failure??new Error('PDF renderer is closed'));
    if(this.pending)return Promise.reject(new Error('PDF renderer protocol is busy'));
    if(this.signal?.aborted)return Promise.reject(this.signal.reason??new Error('PDF rendering aborted'));
    let timeoutMs=maximumWaitMs??60000;
    if(this.deadlineAt!==undefined)timeoutMs=Math.min(timeoutMs,Math.max(1,this.deadlineAt-performance.now()));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{const error=new Error('PDF renderer deadline exceeded');error.code='pdf_renderer_timeout';this.#fail(error);void this.#terminate();},timeoutMs);timer.unref();
      this.pending={expected,resolve,reject,timer};
      try {this.child.send(message,error=>{if(error)this.#fail(error);});}
      catch(error){this.#fail(error);}
    });
  }

  #onMessage(message) {
    const pending=this.pending;
    if(!pending)return;
    if(message?.type==='error') {
      const error=new Error(message.code??'pdf_render_failed');error.code=message.code??'pdf_render_failed';
      this.#fail(error);return;
    }
    if(message?.type!==pending.expected){this.#fail(new Error('PDF renderer protocol error'));return;}
    this.pending=null;clearTimeout(pending.timer);pending.resolve(message);
  }

  #fail(error) {
    if(!this.failure)this.failure=error;
    if(this.pending){clearTimeout(this.pending.timer);const pending=this.pending;this.pending=null;pending.reject(this.failure);}
  }

  async #terminate() {
    if(this.termination)return this.termination;
    this.closed=true;this.signal?.removeEventListener('abort',this.onAbort);
    const child=this.child;
    this.termination=(async()=>{
      if(child.exitCode!==null||child.signalCode!==null)return;
      child.kill('SIGTERM');
      await Promise.race([once(child,'exit').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,500))]);
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit').catch(()=>{});}
    })();
    return this.termination;
  }
}

function workerEnvironment() {
  const keys=process.platform==='win32'?['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE']:['PATH','LANG','LC_ALL','TMPDIR'];
  return Object.fromEntries(keys.filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
}
