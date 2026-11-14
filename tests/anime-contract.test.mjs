import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Compile the actual client predicate, resolving only its portrait re-export.
const source=readFileSync(new URL('../app/lib/anime-contract.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const context={exports:{},require:()=>({})};vm.runInNewContext(code,context);
const {animeReady}=context.exports;

test('fresh enrollment continues polling through provider work before becoming ready',()=>{
  const id='owned-handle';
  for(const status of ['queued','processing','provider_started','publishing']){
    assert.equal(animeReady({enrollment_id:id,status,realtime_ready:false},id),false);
  }
  assert.equal(animeReady({enrollment_id:id,status:'ready',realtime_ready:true},id),true);
});

test('pending, failed, unknown, or foreign enrollments cannot start a session',()=>{
  for(const status of ['failed','manual_review','unknown','provider_started']){
    assert.throws(()=>animeReady({enrollment_id:'own',status,realtime_ready:true},'own'));
  }
  assert.throws(()=>animeReady({enrollment_id:'own',status:'ready',realtime_ready:false},'own'));
  assert.throws(()=>animeReady({enrollment_id:'foreign',status:'ready',realtime_ready:true},'own'));
});
