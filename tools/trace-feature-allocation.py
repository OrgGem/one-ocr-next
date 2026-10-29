"""Find native feature-vector allocation call sites without modifying artifacts."""
import argparse,hashlib,json,subprocess,sys
from pathlib import Path
import frida
p=argparse.ArgumentParser();p.add_argument('--artifacts',required=True);p.add_argument('--reference',required=True);p.add_argument('--image',required=True);p.add_argument('--output',required=True);a=p.parse_args()
tools=Path(__file__).resolve().parent
digest=hashlib.sha256((Path(a.artifacts)/'oneocr.dll').read_bytes()).hexdigest()
if digest!='1310e46ffa6971101da73191f7a30580f7f7d983ab02c5fca28b5f6fd4351242':raise SystemExit('Instrumentation addresses require the exact supplied DLL')
child=subprocess.Popen([sys.executable,str(tools/'native_probe_host.py'),'--artifacts',a.artifacts,'--reference',a.reference,'--image',a.image],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
session=None;script=None;messages=[]
try:
 ready=json.loads(child.stdout.readline());assert ready['ready'] and isinstance(ready['pid'],int)
 # Windows venv launchers may start a child Python process; the owned host
 # reports its actual PID through the private stdout pipe.
 session=frida.attach(ready['pid'])
 script=session.create_script((tools/'probe-feature-allocation.js').read_text('utf8'))
 def on_message(message,data):
  if data is not None:
   name=Path(a.output).stem+'-logits-'+str(sum(m.get('payload',{}).get('kind')=='recognizer-logits' for m in messages))+'.bin'
   (Path(a.output).parent/name).write_bytes(data)
   message['payload']['file']=name
  messages.append(message)
 script.on('message',on_message)
 script.load()
 child.stdin.write('run\n');child.stdin.flush()
 result=json.loads(child.stdout.readline())
 script.unload();script=None;session.detach();session=None
 child.stdin.write('exit\n');child.stdin.flush();child.stdin.close()
 exit_code=child.wait(timeout=20)
 if exit_code:raise RuntimeError(f'Owned native probe failed: {exit_code}: {child.stderr.read()}')
 report={'oneocr_sha256':digest,'frida':frida.__version__,'image':a.image,'native_text':result['text'],'messages':messages}
 Path(a.output).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
 print(json.dumps({'observations':len(messages),'output':a.output}))
finally:
 if script:script.unload()
 if session:session.detach()
 if child.poll() is None:child.kill();child.wait()
