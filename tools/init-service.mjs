import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const destination=resolve(process.argv[2]??'.env');
const example=await readFile(new URL('../.env.example',import.meta.url),'utf8');
try {
  await writeFile(destination,example.replace(/^ONEOCR_API_KEY=$/m,'ONEOCR_API_KEY='+randomBytes(32).toString('hex')),{flag:'wx',mode:0o600});
  console.log(`Created ${destination}; API key stays in this file and is not printed.`);
} catch(error) {
  if(error.code==='EEXIST'){console.log(`${destination} already exists; kept existing configuration and key.`);}
  else throw error;
}
