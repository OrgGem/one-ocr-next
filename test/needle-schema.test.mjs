import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNeedleSchema,parseNeedleSchema,validateNeedleValue} from '../src/needle-schema.mjs';

test('bounded Needle schema subset normalizes closed objects and validates nested values',()=>{
  const schema=normalizeNeedleSchema({
    type:'object',properties:{
      invoice_number:{type:'string'},
      total_amount:{type:'string'},
      currency:{type:'string',enum:['VND','USD']},
      items:{type:'array',items:{type:'object',properties:{name:{type:'string'},quantity:{type:'integer'}},required:['name','quantity']}}
    },required:['invoice_number','total_amount','currency']
  });
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.items.items.additionalProperties,false);
  const value={invoice_number:'INV-042',total_amount:'1.250.000',currency:'VND',items:[{name:'Cà phê',quantity:2}]};
  assert.equal(validateNeedleValue(schema,value),true);
  assert.equal(validateNeedleValue(schema,{...value,unexpected:'x'}),false);
  assert.equal(validateNeedleValue(schema,{...value,currency:'EUR'}),false);
  assert.equal(validateNeedleValue(schema,{...value,items:Array.from({length:65},()=>({name:'x',quantity:1}))}),false);
  assert.equal(validateNeedleValue(schema,{...value,items:[{name:'x',quantity:1.5}]}),false);
  assert.equal(validateNeedleValue(schema,{...value,items:[{name:'x'}]}),false);
});

test('schema parser rejects malformed, remote, dynamic and unknown constructs',()=>{
  assert.throws(()=>parseNeedleSchema('{bad json'),error=>error.code==='invalid_schema');
  assert.throws(()=>parseNeedleSchema(JSON.stringify({type:'object',properties:{id:{type:'string'}},$ref:'https://example.invalid/schema'})),error=>error.code==='unsupported_schema');
  assert.throws(()=>normalizeNeedleSchema({type:'object',properties:{id:{type:'string'}},additionalProperties:true}),error=>error.code==='unsupported_schema');
  assert.throws(()=>normalizeNeedleSchema({type:'object',properties:{id:{type:'string'}},allOf:[{type:'object'}]}),error=>error.code==='unsupported_schema');
  assert.throws(()=>normalizeNeedleSchema({type:['object','null'],properties:{}}),error=>error.code==='unsupported_schema');
  assert.throws(()=>normalizeNeedleSchema({type:'object',properties:{id:{type:'string'}},required:['missing']}),error=>error.code==='invalid_schema');
});

test('schema limits reject oversized JSON, excessive depth, fields and enums',()=>{
  assert.throws(()=>parseNeedleSchema(JSON.stringify({type:'object',properties:{x:{type:'string',description:'x'.repeat(9000)}}})),error=>error.code==='schema_too_large');
  let nested={type:'string'};for(let i=0;i<7;i++)nested={type:'array',items:nested};
  assert.throws(()=>normalizeNeedleSchema({type:'object',properties:{x:nested}}),error=>error.code==='schema_too_complex');
  const properties=Object.fromEntries(Array.from({length:33},(_,i)=>[`field_${i}`,{type:'string'}]));
  assert.throws(()=>normalizeNeedleSchema({type:'object',properties}),error=>error.code==='schema_too_complex');
  assert.throws(()=>normalizeNeedleSchema({type:'object',properties:{state:{type:'string',enum:Array.from({length:33},(_,i)=>`v${i}`)}}}),error=>error.code==='invalid_schema');
});
