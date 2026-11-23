import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("YOUR-PROJECT") && SUPABASE_ANON_KEY.length > 30 && !SUPABASE_ANON_KEY.includes("YOUR_");
const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat(undefined,{style:"currency",currency:"USD"}).format(Number(n||0));
let supabase=null, user=null, spaces=[], activeSpace=null, transactions=[], essentials=[], mode="login", channel=null;
const pendingKey = () => `mintly-pending-${user?.id||"guest"}`;
function message(text, type="") { $("toast").textContent=text; $("toast").className="small "+type; }
function sync(text, warn=false){$("syncState").textContent=text;$("syncState").style.color=warn?"#a36b22":"#718078";}
function localPending(){try{return JSON.parse(localStorage.getItem(pendingKey())||"[]")}catch{return []}}
function queue(op, table, payload){const q=localPending();q.push({op,table,payload,queued_at:new Date().toISOString()});localStorage.setItem(pendingKey(),JSON.stringify(q));sync("Offline · changes queued",true)}
async function write(table, payload, id=null){
  if(!navigator.onLine){queue(id?"update":"insert",table,{...payload,...(id?{id}:{})});return {offline:true};}
  let q=supabase.from(table);
  const result=id?await q.update(payload).eq("id",id):await q.insert(payload);
  if(result.error){if(!navigator.onLine){queue(id?"update":"insert",table,{...payload,...(id?{id}:{})});return {offline:true};}throw result.error;}
  sync("☁ Saved");return result;
}
async function flushQueue(){
  if(!user||!navigator.onLine)return;
  const q=localPending();if(!q.length){sync("☁ All changes synced");return}
  sync("Syncing offline changes…");
  const remaining=[];
  for(const x of q){try{
    let req=supabase.from(x.table);
    let r=x.op==="update"?await req.update(Object.fromEntries(Object.entries(x.payload).filter(([k])=>k!=="id"))).eq("id",x.payload.id):await req.insert(x.payload);
    if(r.error)throw r.error;
  }catch(e){remaining.push(x);}}
  localStorage.setItem(pendingKey(),JSON.stringify(remaining));
  sync(remaining.length?`Sync paused · ${remaining.length} pending`:"☁ All changes synced",!!remaining.length);
  await loadData();
}
function currentRole(){return spaces.find(s=>s.id===activeSpace)?.role||"owner"}
function canEdit(){return ["owner","admin","editor"].includes(currentRole())}
async function loadSpaces(){
  const {data,error}=await supabase.from("space_members").select("space_id,role,spaces(id,name,kind)").eq("user_id",user.id);
  if(error)throw error;
  spaces=(data||[]).map(x=>({...x.spaces,role:x.role})).filter(x=>x.id);
  if(!spaces.length){const {data:s,error:e}=await supabase.from("spaces").insert({name:"Personal",kind:"personal",created_by:user.id}).select().single();if(e)throw e;
    const {error:me}=await supabase.from("space_members").insert({space_id:s.id,user_id:user.id,role:"owner"});if(me)throw me;
    spaces=[{...s,role:"owner"}];}
  if(!activeSpace||!spaces.some(s=>s.id===activeSpace))activeSpace=spaces[0].id;
  $("spaceSelect").innerHTML=spaces.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}${s.kind==="personal"?" · Personal":" · Household"}</option>`).join("");
  $("spaceSelect").value=activeSpace;updateSpaceUI();
}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function updateSpaceUI(){const s=spaces.find(x=>x.id===activeSpace);$("spaceDescription").textContent=s?.kind==="personal"?"Private personal space":"Shared household space";
 $("privacyNote").textContent=s?.kind==="personal"?"Personal space: only you can access this information.":"Household space: records here are shared with authorised household members.";
 $("newHousehold").classList.toggle("hidden",s?.kind==="household");}
async function loadData(){
 if(!activeSpace)return;
 const [t,e]=await Promise.all([supabase.from("transactions").select("*").eq("space_id",activeSpace).order("created_at",{ascending:false}),supabase.from("essentials").select("*").eq("space_id",activeSpace).order("name")]);
 if(t.error)throw t.error;if(e.error)throw e.error;transactions=t.data||[];essentials=e.data||[];render();
}
function render(){
 const inc=transactions.filter(x=>x.type==="income").reduce((a,x)=>a+Number(x.amount),0), exp=transactions.filter(x=>x.type==="expense").reduce((a,x)=>a+Number(x.amount),0);
 $("totalIncome").textContent=money(inc);$("totalExpense").textContent=money(exp);$("balance").textContent=money(inc-exp);$("itemCount").textContent=essentials.length;
 $("recent").innerHTML=transactions.slice(0,5).map(x=>`<div class="item row"><span>${escapeHtml(x.description)}</span><b>${x.type==="income"?"+":"−"}${money(x.amount)}</b></div>`).join("")||"Nothing here yet.";
 $("transactions").innerHTML=transactions.map(x=>`<div class="item row"><div><b>${escapeHtml(x.description)}</b><div class="small">${escapeHtml(x.category||"General")} · ${x.type}</div></div><div style="text-align:right"><b>${money(x.amount)}</b>${canEdit()?`<div><button class="danger" data-del-tx="${x.id}">Delete</button></div>`:""}</div></div>`).join("")||"No transactions yet.";
 $("essentialsList").innerHTML=essentials.map(x=>`<div class="item row"><div><b>${escapeHtml(x.name)}</b><div class="small">${money(x.estimated_cost)} · every ${x.restock_days} days</div></div><div class="actions">${canEdit()?`<button class="secondary" data-edit-item="${x.id}">Edit</button><button class="danger" data-del-item="${x.id}">Delete</button>`:""}</div></div>`).join("")||"No essentials yet.";
 document.querySelectorAll("[data-del-tx]").forEach(b=>b.onclick=()=>deleteRecord("transactions",b.dataset.delTx));
 document.querySelectorAll("[data-del-item]").forEach(b=>b.onclick=()=>deleteRecord("essentials",b.dataset.delItem));
 document.querySelectorAll("[data-edit-item]").forEach(b=>b.onclick=()=>editItem(b.dataset.editItem));
}
async function deleteRecord(table,id){if(!canEdit()||!confirm("Delete this record?"))return;const {error}=await supabase.from(table).delete().eq("id",id);if(error)message(error.message,"err");else{message("Deleted");await loadData();}}
async function editItem(id){const x=essentials.find(y=>y.id===id);if(!x)return;const name=prompt("Item name",x.name);if(name===null)return;const cost=prompt("Estimated cost",x.estimated_cost);if(cost===null)return;const days=prompt("Restock interval in days",x.restock_days);if(days===null)return;try{const r=await write("essentials",{name,estimated_cost:Number(cost),restock_days:Number(days)},id);if(r?.error)throw r.error;await loadData();}catch(e){message(e.message,"err")}}
$("authForm").addEventListener("submit",async ev=>{ev.preventDefault();if(!configured){$("authMsg").textContent="First configure config.js with your Supabase project URL and publishable/anon key. See README.";return}
 const email=$("email").value,password=$("password").value;
 try{const r=mode==="login"?await supabase.auth.signInWithPassword({email,password}):await supabase.auth.signUp({email,password});if(r.error)throw r.error;$("authMsg").textContent=mode==="signup"?"Account created. Check your email if confirmation is enabled.":"Signed in.";if(r.data.session)await start(r.data.user);}catch(e){$("authMsg").textContent=e.message;}});
$("loginMode").onclick=()=>setMode("login");$("signupMode").onclick=()=>setMode("signup");
function setMode(m){mode=m;$("loginMode").classList.toggle("active",m==="login");$("signupMode").classList.toggle("active",m==="signup");$("authSubmit").textContent=m==="login"?"Sign in":"Create account";}
async function start(u){user=u;$("auth").classList.add("hidden");$("app").classList.remove("hidden");$("accountTop").classList.remove("hidden");try{await loadSpaces();await loadData();await loadMembers();await flushQueue();}catch(e){message(e.message,"err");}}
async function loadMembers(){if(!activeSpace)return;const {data,error}=await supabase.from("space_members").select("user_id,role,profiles(email)").eq("space_id",activeSpace);$("members").innerHTML=error?`<span class="small">${escapeHtml(error.message)}</span>`:(data||[]).map(m=>`<div class="item row"><span>${escapeHtml(m.profiles?.email||"Household member")}</span><span class="small">${escapeHtml(m.role)}</span></div>`).join("")||"No members found.";}
$("signOut").onclick=async()=>{await supabase.auth.signOut();location.reload()};
$("spaceSelect").onchange=async e=>{activeSpace=e.target.value;updateSpaceUI();await loadData();await loadMembers()};
$("newHousehold").onclick=async()=>{const name=prompt("Name your household","Our home");if(!name)return;try{const {data,error}=await supabase.from("spaces").insert({name,kind:"household",created_by:user.id}).select().single();if(error)throw error;const {error:me}=await supabase.from("space_members").insert({space_id:data.id,user_id:user.id,role:"owner"});if(me)throw me;await loadSpaces();await loadData();await loadMembers();document.querySelector('[data-tab="household"]').click();}catch(e){message(e.message,"err")}};
$("txForm").onsubmit=async ev=>{ev.preventDefault();if(!canEdit())return message("You have view-only access.","err");try{const r=await write("transactions",{space_id:activeSpace,user_id:user.id,type:$("txType").value,amount:Number($("txAmount").value),description:$("txDescription").value,category:$("txCategory").value||"General"});if(r?.error)throw r.error;ev.target.reset();await loadData();message(r?.offline?"Saved on this device; waiting to sync.":"Transaction added.");}catch(e){message(e.message,"err")}};
$("itemForm").onsubmit=async ev=>{ev.preventDefault();if(!canEdit())return message("You have view-only access.","err");try{const r=await write("essentials",{space_id:activeSpace,user_id:user.id,name:$("itemName").value,estimated_cost:Number($("itemCost").value||0),restock_days:Number($("itemDays").value||30),last_purchased:$("itemDate").value||null});if(r?.error)throw r.error;ev.target.reset();await loadData();message(r?.offline?"Saved on this device; waiting to sync.":"Essential added.");}catch(e){message(e.message,"err")}};
$("inviteForm").onsubmit=async ev=>{ev.preventDefault();try{const {data,error}=await supabase.functions.invoke("invite-member",{body:{space_id:activeSpace,email:$("inviteEmail").value,role:$("inviteRole").value}});if(error)throw error;$("inviteMsg").textContent=data?.message||"Invitation sent.";ev.target.reset();}catch(e){$("inviteMsg").textContent="Invitation failed: "+e.message;}};
document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x===b));document.querySelectorAll(".tabview").forEach(x=>x.classList.toggle("hidden",x.id!==b.dataset.tab));if(b.dataset.tab==="household")loadMembers();});
window.addEventListener("online",flushQueue);window.addEventListener("offline",()=>sync("Offline · changes will queue",true));
if(configured){supabase=createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});supabase.auth.getSession().then(({data})=>{if(data.session)start(data.session.user)});supabase.auth.onAuthStateChange((_event,session)=>{if(session&&!user)start(session.user);});}
else {$("authMsg").textContent="Cloud setup required: add your Supabase URL and publishable key to config.js. The setup guide is in README.md.";}
