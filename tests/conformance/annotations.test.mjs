import test from 'node:test';
import assert from 'node:assert/strict';
import {connect,toolContract} from './_client.mjs';
import {targetFor} from './_fixture.mjs';

// Independent expected values from SPEC-010 FR-3.1 in R, D, I, O order.
const rows = {
  '0101':['terminal_execute','browser_evaluate','browser_click','browser_type'],
  '1010':['file_read','file_list','file_stat','file_search','workspace_get_cwd'],
  '0100':['file_write','file_move'],
  '0110':['file_replace','file_delete'],
  '0010':['file_mkdir','workspace_set_cwd','browser_select_tab','browser_close'],
  '0001':['browser_open','browser_navigate','browser_new_tab','browser_connect'],
  '1011':['browser_get_content','browser_list_tabs'],
  '0011':['browser_screenshot'],
};
test('tools/list exposes exactly the four advisory hints specified for all 24 tools',async t=>{
  const srv=await targetFor(t), c=await connect(srv);
  let list; try{ list=await toolContract(c); }finally{ await c.close(); }
  const expected=new Map(Object.entries(rows).flatMap(([bits,names])=>names.map(n=>[n,bits])));
  assert.equal(expected.size,24); assert.deepEqual(list.map(x=>x.name),[...expected.keys()].sort());
  const keys=['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'];
  for(const {name,annotations} of list){
    const bits=expected.get(name);
    assert.deepEqual(annotations,Object.fromEntries(keys.map((key,i)=>[key,bits[i]==='1'])),`annotations: ${name}`);
  }
});
