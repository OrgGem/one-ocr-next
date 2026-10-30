const MAX_SCHEMA_BYTES=8192;
const MAX_SCHEMA_DEPTH=7;
const MAX_SCHEMA_NODES=96;
const MAX_PROPERTIES=32;
const MAX_ENUM_VALUES=32;
const MAX_ARRAY_ITEMS=64;
const MAX_DESCRIPTION_BYTES=2048;
const OBJECT_KEYS=new Set(['type','properties','required','additionalProperties','description','title','$schema']);
const ARRAY_KEYS=new Set(['type','items','description','title','$schema']);
const ENUM_KEYS=new Set(['type','enum','description','title','$schema']);
const SCALAR_KEYS=new Set(['type','description','title','$schema']);
const SUPPORTED_TYPES=new Set(['object','array','string','number','integer','boolean','null']);
const FORBIDDEN_NAMES=new Set(['__proto__','prototype','constructor']);

export class ExtractionSchemaError extends Error {
  constructor(code,message){super(message);this.name='ExtractionSchemaError';this.code=code;}
}

export function parseNeedleSchema(value) {
  if(typeof value!=='string')throw new ExtractionSchemaError('invalid_schema','Schema must be JSON text');
  if(Buffer.byteLength(value,'utf8')>MAX_SCHEMA_BYTES)throw new ExtractionSchemaError('schema_too_large','Schema exceeds the 8 KiB limit');
  let schema;
  try{schema=JSON.parse(value);}catch{throw new ExtractionSchemaError('invalid_schema','Schema is not valid JSON');}
  return normalizeNeedleSchema(schema);
}

export function normalizeNeedleSchema(schema) {
  let serialized;
  try{serialized=JSON.stringify(schema);}catch{throw new ExtractionSchemaError('invalid_schema','Schema must be finite JSON data');}
  if(typeof serialized!=='string')throw new ExtractionSchemaError('invalid_schema','Schema must be a JSON object');
  if(Buffer.byteLength(serialized,'utf8')>MAX_SCHEMA_BYTES)throw new ExtractionSchemaError('schema_too_large','Schema exceeds the 8 KiB limit');
  try{schema=JSON.parse(serialized);}catch{throw new ExtractionSchemaError('invalid_schema','Schema must be finite JSON data');}
  const state={nodes:0,properties:0,descriptionBytes:0};
  const normalized=normalizeNode(schema,state,1,'root');
  if(normalized.type!=='object')throw new ExtractionSchemaError('invalid_schema','Root schema type must be object');
  return normalized;
}

function normalizeNode(node,state,depth,path) {
  if(depth>MAX_SCHEMA_DEPTH)throw new ExtractionSchemaError('schema_too_complex','Schema nesting exceeds 7 levels');
  if(++state.nodes>MAX_SCHEMA_NODES)throw new ExtractionSchemaError('schema_too_complex','Schema has too many nested fields');
  if(!isRecord(node))throw new ExtractionSchemaError('invalid_schema',`Schema at ${path} must be an object`);
  const type=node.type;
  if(typeof type!=='string'||!SUPPORTED_TYPES.has(type))throw new ExtractionSchemaError('unsupported_schema',`Schema at ${path} must use one supported scalar type`);
  const accepted=type==='object'?OBJECT_KEYS:type==='array'?ARRAY_KEYS:Object.hasOwn(node,'enum')?ENUM_KEYS:SCALAR_KEYS;
  for(const key of Object.keys(node))if(!accepted.has(key))throw new ExtractionSchemaError('unsupported_schema',`Unsupported schema keyword at ${path}: ${key}`);
  const result={type};
  if(node.description!==undefined) {
    if(typeof node.description!=='string'||Buffer.byteLength(node.description,'utf8')>MAX_DESCRIPTION_BYTES)throw new ExtractionSchemaError('invalid_schema',`Description at ${path} must be text up to 2 KiB`);
    state.descriptionBytes+=Buffer.byteLength(node.description,'utf8');
    if(state.descriptionBytes>4096)throw new ExtractionSchemaError('schema_too_complex','Combined schema descriptions exceed 4 KiB');
    result.description=node.description;
  }
  if(node.title!==undefined&&typeof node.title!=='string')throw new ExtractionSchemaError('invalid_schema',`Title at ${path} must be text`);
  if(node.$schema!==undefined&&typeof node.$schema!=='string')throw new ExtractionSchemaError('invalid_schema',`$schema at ${path} must be text`);
  if(type==='object') {
    if(!isRecord(node.properties))throw new ExtractionSchemaError('invalid_schema',`Object properties are required at ${path}`);
    const names=Object.keys(node.properties);
    if(names.length>MAX_PROPERTIES)throw new ExtractionSchemaError('schema_too_complex',`Object at ${path} has more than ${MAX_PROPERTIES} properties`);
    state.properties+=names.length;
    if(state.properties>MAX_SCHEMA_NODES-1)throw new ExtractionSchemaError('schema_too_complex','Schema has too many properties');
    const properties={};
    for(const name of names) {
      if(!name||FORBIDDEN_NAMES.has(name))throw new ExtractionSchemaError('invalid_schema',`Invalid property name at ${path}`);
      properties[name]=normalizeNode(node.properties[name],state,depth+1,`${path}.${name}`);
    }
    const required=node.required??[];
    if(!Array.isArray(required)||required.some(name=>typeof name!=='string')||new Set(required).size!==required.length)throw new ExtractionSchemaError('invalid_schema',`Required fields at ${path} must be a unique string array`);
    if(required.some(name=>!Object.hasOwn(properties,name)))throw new ExtractionSchemaError('invalid_schema',`Required fields at ${path} must name declared properties`);
    if(node.additionalProperties!==undefined&&node.additionalProperties!==false)throw new ExtractionSchemaError('unsupported_schema','additionalProperties must be false when specified');
    result.properties=properties;
    if(required.length)result.required=[...required];
    result.additionalProperties=false;
  } else if(type==='array') {
    if(node.items===undefined)throw new ExtractionSchemaError('invalid_schema',`Array items are required at ${path}`);
    result.items=normalizeNode(node.items,state,depth+1,`${path}[]`);
  } else if(Object.hasOwn(node,'enum')) {
    if(!Array.isArray(node.enum)||node.enum.length<1||node.enum.length>MAX_ENUM_VALUES)throw new ExtractionSchemaError('invalid_schema',`Enum at ${path} must contain 1..${MAX_ENUM_VALUES} values`);
    for(const value of node.enum)if(!isEnumValue(value)||!enumMatchesType(value,type))throw new ExtractionSchemaError('invalid_schema',`Enum values at ${path} must match ${type} and use primitive values`);
    result.enum=dedupeJsonValues(node.enum);
  }
  return result;
}

export function validateNeedleValue(schema,value,{maxArrayItems=MAX_ARRAY_ITEMS}={}) {
  if(Object.hasOwn(schema,'enum')&&!schema.enum.some(item=>jsonEqual(item,value)))return false;
  switch(schema.type) {
    case 'object': {
      if(!isRecord(value))return false;
      const properties=schema.properties;
      if(Object.keys(value).some(key=>!Object.hasOwn(properties,key)))return false;
      if((schema.required??[]).some(key=>!Object.hasOwn(value,key)))return false;
      return Object.entries(value).every(([key,item])=>validateNeedleValue(properties[key],item,{maxArrayItems}));
    }
    case 'array': return Array.isArray(value)&&value.length<=maxArrayItems&&value.every(item=>validateNeedleValue(schema.items,item,{maxArrayItems}));
    case 'string': return typeof value==='string';
    case 'number': return typeof value==='number'&&Number.isFinite(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'boolean': return typeof value==='boolean';
    case 'null': return value===null;
    default: return false;
  }
}

function isRecord(value) {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function isEnumValue(value) {return value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value));}
function enumMatchesType(value,type) {return type==='null'?value===null:type==='number'?typeof value==='number':type==='integer'?Number.isSafeInteger(value):typeof value===type;}
function jsonEqual(a,b) {return JSON.stringify(a)===JSON.stringify(b);}
function dedupeJsonValues(values) {return values.filter((value,index)=>values.findIndex(candidate=>jsonEqual(candidate,value))===index);}
