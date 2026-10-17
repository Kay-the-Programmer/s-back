/**
 * The SMS sender identity, against a real database.
 *
 * tests/sms-branding.test.mjs covers the rules themselves; this one checks the
 * plumbing they ride on, because that is where this feature can fail quietly:
 * the store_settings upsert now carries five more parameters, a NULL in the
 * sender columns is a meaningful value rather than "leave it alone", and the
 * one thing that must never happen — a store writing its own APPROVED sender id
 * — is enforced by a controller, not by the type system.
 *
 * It caught a real bug: a store asking for a second sender id flipped the
 * status to 'pending' and quietly took its working, network-registered id out
 * of service.
 *
 * Usage:
 *   API_URL=http://localhost:5001/api  *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot  *   node tests/sms-sender-approval.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';
const API=(process.env.API_URL||'http://localhost:5001/api').replace(/\/+$/,'');
const DB=process.env.DATABASE_URL||'postgresql://postgres:password@localhost:5432/salepilot';
const RUN=`smsv-${Date.now()}`;
const STORE_NAME=`Kay Hardware Supplies ${Date.now()}`;
const STORE=`store-${RUN}`, ADMIN=`admin-${RUN}`, SUPER=`super-${RUN}`, PASSWORD='smsverify-pass-1';
const db=new pg.Client({connectionString:DB});
const out=[];
const check=(n,ok,d='')=>{out.push(ok);console.log(`${ok?'PASS':'FAIL'} | ${n}${d?' | '+d:''}`)};
const req=async(m,p,b,h={})=>{const r=await fetch(API+p,{method:m,headers:{'Content-Type':'application/json',...h},body:b?JSON.stringify(b):undefined});const t=await r.text();let d;try{d=JSON.parse(t)}catch{d=t}return{status:r.status,data:d}};
const bearer=t=>({Authorization:`Bearer ${t}`});

await db.connect();
await db.query('DELETE FROM store_settings WHERE store_id=$1',[STORE]).catch(()=>{});
await db.query('DELETE FROM users WHERE id=ANY($1)',[[ADMIN,SUPER]]).catch(()=>{});
await db.query('DELETE FROM stores WHERE id=$1',[STORE]).catch(()=>{});
await db.query('INSERT INTO stores (id,name,owner_id,status) VALUES ($1,$2,$3,$4)',[STORE,STORE_NAME,ADMIN,'active']);
for (const [id,role] of [[ADMIN,'admin'],[SUPER,'superadmin']])
  await db.query('INSERT INTO users (id,name,email,password_hash,role,current_store_id,is_verified) VALUES ($1,$2,$3,$4,$5,$6,TRUE)',
    [id,id,`${id}@test.local`,await bcrypt.hash(PASSWORD,10),role,STORE]);

const login=async id=>{const r=await req('POST','/auth/login',{email:`${id}@test.local`,password:PASSWORD});if(r.status!==200||!r.data?.token)throw new Error(`login ${id}: ${r.status} ${JSON.stringify(r.data)}`);return r.data.token};
const tA=await login(ADMIN), tS=await login(SUPER);

// 1. the default display name
const s0=await req('GET','/settings',null,bearer(tA));
check('a new store gets a display name from its trading name, capped at 20',
  s0.status===200 && s0.data?.smsDisplayName===STORE_NAME.slice(0,20), JSON.stringify(s0.data?.smsDisplayName));

// 2. saving the display name through the real upsert ($29-$33)
const s1=await req('PUT','/settings',{...s0.data,smsDisplayName:'Kay  Hardware\n'},bearer(tA));
check('the settings upsert saves a sanitized display name', s1.status===200 && s1.data?.smsDisplayName==='Kay Hardware', `${s1.status} ${JSON.stringify(s1.data?.smsDisplayName)}`);

// 3. a save that omits the field must not blank it
const {smsDisplayName:_omit, ...noName}=s1.data;
const s2=await req('PUT','/settings',noName,bearer(tA));
check('a settings screen that omits the field leaves the name alone', s2.data?.smsDisplayName==='Kay Hardware', JSON.stringify(s2.data?.smsDisplayName));

// 4. a store cannot approve its own sender id
const s3=await req('PUT','/settings',{...s2.data,smsSenderIdRequested:'BIGBANK'},bearer(tA));
const row=async()=>(await db.query('SELECT sms_sender_id,sms_sender_id_requested,sms_sender_id_status FROM store_settings WHERE store_id=$1',[STORE])).rows[0];
let r1=await row();
check('a store asking for a sender id only gets a pending request',
  s3.status===200 && r1.sms_sender_id===null && r1.sms_sender_id_requested==='BIGBANK' && r1.sms_sender_id_status==='pending', JSON.stringify(r1));

// 5. even sending the approved field directly
const s4=await req('PUT','/settings',{...s2.data,smsSenderIdRequested:'BIGBANK',smsSenderId:'BIGBANK'},bearer(tA));
r1=await row();
check('sending smsSenderId directly still cannot write the approved column',
  r1.sms_sender_id===null, JSON.stringify(r1));

// 6. the superadmin read + approval
const sa0=await req('GET',`/superadmin/stores/${STORE}/sms-sender`,null,bearer(tS));
check('superadmin sees the pending request', sa0.status===200 && sa0.data?.smsSenderIdRequested==='BIGBANK', JSON.stringify(sa0.data));
const rej=await req('PUT',`/superadmin/stores/${STORE}/sms-sender`,{action:'reject'},bearer(tS));
r1=await row();
check('reject clears the request and records it', rej.status===200 && r1.sms_sender_id_requested===null && r1.sms_sender_id_status==='rejected', JSON.stringify(r1));

await req('PUT','/settings',{...s2.data,smsSenderIdRequested:'KAYHW'},bearer(tA));
const app=await req('PUT',`/superadmin/stores/${STORE}/sms-sender`,{action:'approve'},bearer(tS));
r1=await row();
check('approve moves the value into the approved column',
  app.status===200 && r1.sms_sender_id==='KAYHW' && r1.sms_sender_id_requested===null && r1.sms_sender_id_status==='approved', JSON.stringify(r1));

// 7. a non-superadmin cannot reach the approval route
const forb=await req('PUT',`/superadmin/stores/${STORE}/sms-sender`,{action:'approve',senderId:'BIGBANK'},bearer(tA));
check('the approval route is superadmin-only', forb.status===401||forb.status===403, `status ${forb.status}`);

// 8. an approved store cannot be overwritten by its own save
const s5=await req('PUT','/settings',{...s2.data,smsSenderIdRequested:'BIGBANK'},bearer(tA));
r1=await row();
check('an approved sender id survives a store save asking for another',
  r1.sms_sender_id==='KAYHW' && r1.sms_sender_id_requested==='BIGBANK', JSON.stringify(r1));

// 9. /sms/config reflects it
const cfg=await req('GET','/sms/config',null,bearer(tA));
check('sms/config tells the composer an approved id means no prefix',
  cfg.status===200 && cfg.data?.storeSenderId==='KAYHW' && cfg.data?.prefixesBody===false, JSON.stringify(cfg.data));

// 10. revoke falls back to the prefix
await req('PUT',`/superadmin/stores/${STORE}/sms-sender`,{action:'revoke'},bearer(tS));
const cfg2=await req('GET','/sms/config',null,bearer(tA));
check('after a revoke the body is prefixed again',
  cfg2.data?.storeSenderId===null && cfg2.data?.prefixesBody===true && cfg2.data?.displayName==='Kay Hardware', JSON.stringify(cfg2.data));

// 11. the log columns exist and accept a write
await db.query(`INSERT INTO sms_messages (id,store_id,recipient,message,status,sender,prefix) VALUES ($1,$2,'+260977000111','Kay Hardware: hi','Success',NULL,'Kay Hardware: ')`,[`sms-${RUN}`,STORE]);
const log=(await db.query('SELECT sender,prefix,message FROM sms_messages WHERE id=$1',[`sms-${RUN}`])).rows[0];
check('sms_messages stores what was actually sent', log.prefix==='Kay Hardware: ' && log.message.startsWith('Kay Hardware: '), JSON.stringify(log));

await db.query('DELETE FROM sms_messages WHERE id=$1',[`sms-${RUN}`]);
await db.query('DELETE FROM store_settings WHERE store_id=$1',[STORE]);
await db.query("DELETE FROM audit_logs WHERE user_id=ANY($1)",[[ADMIN,SUPER]]).catch(()=>{});
await db.query("DELETE FROM users WHERE id=ANY($1)",[[ADMIN,SUPER]]);
await db.query('DELETE FROM stores WHERE id=$1',[STORE]);
await db.end();
const bad=out.filter(x=>!x).length;
console.log(`\n${out.length-bad}/${out.length} passed`);
process.exitCode = bad?1:0;
